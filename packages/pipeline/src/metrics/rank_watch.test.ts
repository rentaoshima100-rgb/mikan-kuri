import { describe, expect, it } from "vitest";
import { MemoryStore } from "../db/memory.js";
import {
  extractOwnRank,
  isOwnUrl,
  jstDate,
  pickTrackedKeywords,
  runRankWatch,
  summarizeRanks,
} from "./rank_watch.js";

type FetchCall = { url: string; body: unknown };

function fakeFetch(handler: (url: string, body: unknown) => unknown): {
  impl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    // DataForSEOのボディは配列 ([{...}])
    const body = typeof raw === "string" ? JSON.parse(raw) : raw;
    calls.push({ url, body });
    return {
      ok: true,
      status: 200,
      json: async () => handler(url, body),
      text: async () => JSON.stringify(handler(url, body)),
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const CREDS = { login: "user", password: "pass" };

// DataForSEO SERP応答を組み立てる
const serpResponse = (items: { type: string; rank_group?: number; url?: string }[]) => ({
  tasks: [{ result: [{ items }] }],
});

async function publishArticle(store: MemoryStore, keyword: string): Promise<void> {
  const kw = store.addKeyword({ keyword, status: "done" });
  const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
  await store.updateArticle(a.id, { status: "published", title: keyword });
}

describe("isOwnUrl / extractOwnRank: 自社ドメイン判定", () => {
  it("完全一致・www・サブドメインを自社と判定し、他社や部分一致は弾く", () => {
    expect(isOwnUrl("https://kuri-mikan.jp/blogs/column/x", "kuri-mikan.jp")).toBe(true);
    expect(isOwnUrl("https://www.kuri-mikan.jp/", "kuri-mikan.jp")).toBe(true);
    expect(isOwnUrl("https://blog.kuri-mikan.jp/x", "kuri-mikan.jp")).toBe(true);
    expect(isOwnUrl("https://example.com/kuri-mikan.jp", "kuri-mikan.jp")).toBe(false);
    // 前方一致では notkuri-mikan.jp のような別ドメインを誤検出する
    expect(isOwnUrl("https://notkuri-mikan.jp/", "kuri-mikan.jp")).toBe(false);
    expect(isOwnUrl("壊れたURL", "kuri-mikan.jp")).toBe(false);
  });

  it("organic以外 (広告等) は順位に数えず、自社の最上位を返す", () => {
    const rank = extractOwnRank(
      [
        { type: "paid", rank_group: 1, url: "https://kuri-mikan.jp/ad" },
        { type: "organic", rank_group: 3, url: "https://example.com/" },
        { type: "organic", rank_group: 7, url: "https://kuri-mikan.jp/blogs/column/a" },
        { type: "organic", rank_group: 20, url: "https://kuri-mikan.jp/blogs/column/b" },
      ],
      "kuri-mikan.jp",
    );
    expect(rank).toEqual({ position: 7, url: "https://kuri-mikan.jp/blogs/column/a" });
  });

  it("自社が無ければnull (圏外)", () => {
    expect(
      extractOwnRank([{ type: "organic", rank_group: 1, url: "https://example.com/" }], "kuri-mikan.jp"),
    ).toBeNull();
  });
});

describe("jstDate: 測定日はJST基準", () => {
  it("cron-daily実行時刻 (前日21:00 UTC) がJSTの当日になる", () => {
    expect(jstDate(new Date("2026-08-14T21:00:00Z"))).toBe("2026-08-15");
    expect(jstDate(new Date("2026-08-15T01:00:00Z"))).toBe("2026-08-15");
  });
});

describe("pickTrackedKeywords: 追跡対象の選出", () => {
  it("手動指定を先頭に、公開済み記事のキーワードで埋める (重複は除く)", async () => {
    const store = new MemoryStore();
    await publishArticle(store, "ホームページ リニューアル 費用");
    await publishArticle(store, "手動でも指定したKW");
    const { keywords } = await pickTrackedKeywords(store, {
      keywords: ["手動でも指定したKW", "手動だけのKW"],
    });
    expect(keywords).toEqual([
      "手動でも指定したKW",
      "手動だけのKW",
      "ホームページ リニューアル 費用",
    ]);
  });

  it("refit: と未公開記事は追跡しない", async () => {
    const store = new MemoryStore();
    await publishArticle(store, "refit:existing-post");
    const kw = store.addKeyword({ keyword: "未公開のKW", status: "done" });
    await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
    const { keywords } = await pickTrackedKeywords(store, {});
    expect(keywords).toEqual([]);
  });

  it("上限で切り、切り捨て数を返す (静かに削らない)", async () => {
    const store = new MemoryStore();
    const { keywords, overflow } = await pickTrackedKeywords(store, {
      keywords: ["a", "b", "c"],
      max_keywords: 2,
    });
    expect(keywords).toEqual(["a", "b"]);
    expect(overflow).toBe(1);
  });
});

describe("runRankWatch: 日次の順位取得", () => {
  it("追跡キーワードごとにSERPを引き、順位と圏外をrank_snapshotsへ冪等記録する", async () => {
    const store = new MemoryStore();
    store.setConfig("rank_watch", { keywords: ["圏内のKW", "圏外のKW"] });
    const { impl, calls } = fakeFetch((_url, body) => {
      const kw = (body as { keyword: string }[])[0]!.keyword;
      return kw === "圏内のKW"
        ? serpResponse([
            { type: "organic", rank_group: 4, url: "https://example.com/" },
            { type: "organic", rank_group: 12, url: "https://kuri-mikan.jp/blogs/column/x" },
          ])
        : serpResponse([{ type: "organic", rank_group: 1, url: "https://example.com/" }]);
    });

    const now = () => new Date("2026-08-14T21:00:00Z");
    const result = await runRankWatch({ store, fetchImpl: impl, credentials: CREDS, now });

    expect(result).toEqual({ checked: 2, ranked: 1, errors: 0 });
    // depth=100 で日本のGoogleを引いている
    expect((calls[0]!.body as { depth: number; location_code: number }[])[0]).toMatchObject({
      depth: 100,
      location_code: 2392,
    });
    expect(store.rankSnapshots.get("圏内のKW|2026-08-15")).toMatchObject({
      position: 12,
      found_url: "https://kuri-mikan.jp/blogs/column/x",
    });
    expect(store.rankSnapshots.get("圏外のKW|2026-08-15")).toMatchObject({ position: null });

    // 同日の再実行は上書き (二重記録にならない)
    await runRankWatch({ store, fetchImpl: impl, credentials: CREDS, now });
    expect(store.rankSnapshots.size).toBe(2);
  });

  it("credsが無ければ実APIを呼ばずスキップ", async () => {
    const store = new MemoryStore();
    store.setConfig("rank_watch", { keywords: ["何か"] });
    const { impl, calls } = fakeFetch(() => ({}));
    const result = await runRankWatch({
      store,
      fetchImpl: impl,
      credentials: { login: "", password: "" },
    });
    expect(result.skipped).toContain("未設定");
    expect(calls).toHaveLength(0);
  });

  it("enabled=false ならスキップ (オフスイッチ)", async () => {
    const store = new MemoryStore();
    store.setConfig("rank_watch", { enabled: false, keywords: ["何か"] });
    const { impl, calls } = fakeFetch(() => ({}));
    const result = await runRankWatch({ store, fetchImpl: impl, credentials: CREDS });
    expect(result.skipped).toContain("enabled=false");
    expect(calls).toHaveLength(0);
  });

  it("1件の取得失敗で全体を止めない (失敗はerrorsに数えて続行)", async () => {
    const store = new MemoryStore();
    store.setConfig("rank_watch", { keywords: ["失敗するKW", "成功するKW"] });
    const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const kw = (JSON.parse(String(init?.body)) as { keyword: string }[])[0]!.keyword;
      if (kw === "失敗するKW") {
        return { ok: false, status: 429, text: async () => "rate limited" } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () =>
          serpResponse([{ type: "organic", rank_group: 2, url: "https://kuri-mikan.jp/" }]),
      } as Response;
    }) as typeof fetch;

    const result = await runRankWatch({ store, fetchImpl: impl, credentials: CREDS });
    expect(result).toMatchObject({ checked: 1, ranked: 1, errors: 1 });
    expect(store.rankSnapshots.size).toBe(1);
  });
});

describe("summarizeRanks: 管理画面向けの順位表", () => {
  it("最新順位・前回比・7日前比を出し、上位順に並べる (圏外は末尾)", () => {
    const rows = summarizeRanks([
      { keyword: "上がったKW", date: "2026-08-08", position: 20, found_url: null },
      { keyword: "上がったKW", date: "2026-08-14", position: 12, found_url: null },
      { keyword: "上がったKW", date: "2026-08-15", position: 8, found_url: "https://kuri-mikan.jp/a" },
      { keyword: "圏外のKW", date: "2026-08-15", position: null, found_url: null },
      { keyword: "1位のKW", date: "2026-08-15", position: 1, found_url: null },
    ]);
    expect(rows.map((r) => r.keyword)).toEqual(["1位のKW", "上がったKW", "圏外のKW"]);
    const up = rows[1]!;
    expect(up.position).toBe(8);
    expect(up.prevPosition).toBe(12);
    expect(up.weekAgoPosition).toBe(20); // 7日以上前で最も新しい測定
    expect(up.foundUrl).toBe("https://kuri-mikan.jp/a");
  });
});
