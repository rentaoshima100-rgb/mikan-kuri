import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../db/memory.js";
import { recordReferrerLogCv, recordSelfReportCv, aiCvStatus } from "./ai_cv.js";
import { buildJwt } from "./google_auth.js";
import { AI_REFERRER_REGEX, runGa4Sync } from "./ga4_sync.js";
import { mapCoverageState, runGscSync, slugFromPageUrl } from "./gsc_sync.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA_JSON = JSON.stringify({
  client_email: "svc@test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});

type FetchCall = { url: string; body: unknown };

function fakeFetch(handler: (url: string, body: unknown) => unknown): {
  impl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    const body =
      typeof raw === "string" && raw.startsWith("{") ? JSON.parse(raw) : raw;
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

describe("google_auth: JWT bearer", () => {
  it("RS256署名つきJWTを生成する (検証可能)", () => {
    const sa = JSON.parse(SA_JSON);
    const jwt = buildJwt(sa, ["scope-a", "scope-b"], 1_700_000_000_000);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(claims.iss).toBe("svc@test.iam.gserviceaccount.com");
    expect(claims.scope).toBe("scope-a scope-b");
    expect(claims.exp - claims.iat).toBe(3600);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });
});

describe("gsc_sync", () => {
  it("サービスアカウント未設定ならスキップ (実APIを呼ばない)", async () => {
    const { impl, calls } = fakeFetch(() => ({}));
    const result = await runGscSync({ store: new MemoryStore(), fetchImpl: impl, serviceAccountJson: "" });
    expect(result.skipped).toContain("未設定");
    expect(calls).toHaveLength(0);
  });

  it("page×dateをarticleへマップしてupsertし、URL Inspectionのindex_statusを保存する", async () => {
    const store = new MemoryStore();
    const kw = store.addKeyword({ keyword: "kw" });
    const article = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
    await store.updateArticle(article.id, {
      slug: "kanpei-price",
      status: "published",
      published_at: "2026-07-20T00:00:00.000Z",
    });

    const { impl } = fakeFetch((url, body) => {
      if (url.includes("oauth2")) return { access_token: "tok" };
      if (url.includes("searchAnalytics")) {
        const dims = (body as { dimensions: string[] }).dimensions;
        if (dims.includes("date")) {
          return {
            rows: [
              { keys: ["https://kuri-mikan.jp/blogs/column/kanpei-price", "2026-07-22"], clicks: 5, impressions: 100, ctr: 0.05, position: 12.3 },
              { keys: ["https://kuri-mikan.jp/collections/kanpei", "2026-07-22"], clicks: 9, impressions: 50, ctr: 0.18, position: 3 },
            ],
          };
        }
        return {
          rows: [
            { keys: ["https://kuri-mikan.jp/blogs/column/kanpei-price", "日本 dx 遅れ"], clicks: 3, impressions: 60, position: 11 },
          ],
        };
      }
      if (url.includes("urlInspection")) {
        return { inspectionResult: { indexStatusResult: { coverageState: "Submitted and indexed" } } };
      }
      return {};
    });

    const result = await runGscSync({
      store,
      fetchImpl: impl,
      serviceAccountJson: SA_JSON,
      now: () => new Date("2026-07-24T09:00:00Z"),
    });

    expect(result.skipped).toBeUndefined();
    const daily = store.gscMetrics.get(`${article.id}|2026-07-22`)!;
    expect(daily.clicks).toBe(5);
    expect(daily.position).toBe(12.3);
    // 記事以外のページ (コレクション) は記録されない
    expect([...store.gscMetrics.values()].every((r) => r.article_id === article.id)).toBe(true);
    // top_queriesは前日行へ
    const queryRow = store.gscMetrics.get(`${article.id}|2026-07-23`)!;
    expect(queryRow.top_queries).toHaveLength(1);
    // inspection結果は当日行へ
    expect(store.gscMetrics.get(`${article.id}|2026-07-24`)!.index_status).toBe("indexed");
    expect(result.inspected).toBe(1);
  });

  it("補助関数: URL→slug / coverageState→index_status", () => {
    expect(slugFromPageUrl("https://kuri-mikan.jp/blogs/column/abc-123")).toBe("abc-123");
    // コレクションと商品ページは記事ではないので集計対象にしない
    expect(slugFromPageUrl("https://kuri-mikan.jp/collections/kanpei")).toBeNull();
    expect(slugFromPageUrl("https://kuri-mikan.jp/products/kanpei-3kg")).toBeNull();
    expect(mapCoverageState("Submitted and indexed")).toBe("indexed");
    expect(mapCoverageState("Crawled - currently not indexed")).toBe("crawled_not_indexed");
    expect(mapCoverageState("Discovered - currently not indexed")).toBe("discovered");
    expect(mapCoverageState(undefined)).toBe("unknown");
  });
});

describe("ga4_sync", () => {
  it("未設定ならスキップ", async () => {
    const result = await runGa4Sync({ store: new MemoryStore(), propertyId: "", serviceAccountJson: "" });
    expect(result.skipped).toContain("未設定");
  });

  it("AIチャネルとカスタム正規表現の大きい方を月初日行へ保存し、CVをai_cv_eventsへ記録", async () => {
    const store = new MemoryStore();
    const { impl, calls } = fakeFetch((url, body) => {
      if (url.includes("oauth2")) return { access_token: "tok" };
      const b = body as { dimensions: { name: string }[] };
      if (b.dimensions[0]!.name === "sessionDefaultChannelGroup") {
        return {
          rows: [
            { dimensionValues: [{ value: "Organic Search" }], metricValues: [{ value: "500" }, { value: "8" }] },
            { dimensionValues: [{ value: "AI Assistants" }], metricValues: [{ value: "40" }, { value: "2" }] },
          ],
        };
      }
      return {
        rows: [
          { dimensionValues: [{ value: "chatgpt.com" }], metricValues: [{ value: "55" }, { value: "3" }] },
        ],
      };
    });

    const result = await runGa4Sync({
      store,
      fetchImpl: impl,
      propertyId: "123456",
      serviceAccountJson: SA_JSON,
      now: () => new Date("2026-07-24T09:00:00Z"),
    });

    expect(result.aiSessions).toBe(55); // max(40, 55)
    expect(result.aiConversions).toBe(3); // max(2, 3)
    expect(store.gscMetrics.get("null|2026-06-01")!.ai_channel_sessions).toBe(55);
    expect(store.aiCvEvents).toHaveLength(1);
    expect(store.aiCvEvents[0]).toMatchObject({ source: "ga4_channel", count: 3, occurred_on: "2026-06-01" });

    // 内訳: どちらの系統から何件かを残す (両系統が互いに素なら過少計上のため、後から重複度を検証する)
    const detail = store.aiCvEvents[0]!.detail as {
      adopted: string;
      channel: { sessions: number; conversions: number; rows: { source: string }[] };
      referrer_regex: { sessions: number; conversions: number; rows: { source: string }[] };
    };
    expect(detail.adopted).toBe("referrer_regex"); // regexのCV(3) > channelのCV(2)
    expect(detail.channel).toMatchObject({ sessions: 40, conversions: 2 });
    expect(detail.referrer_regex).toMatchObject({ sessions: 55, conversions: 3 });
    expect(detail.channel.rows[0]!.source).toBe("AI Assistants");
    expect(detail.referrer_regex.rows[0]!.source).toBe("chatgpt.com");
    expect(result.breakdown).toEqual(detail);
    // カスタム正規表現がリクエストに含まれる (v3指定のドメイン群)
    const regexCall = calls.find((c) => JSON.stringify(c.body).includes("PARTIAL_REGEXP"));
    expect(JSON.stringify(regexCall!.body)).toContain("chatgpt");
    expect(AI_REFERRER_REGEX).toContain("perplexity");
  });

  it("CVが0でも計測記録と内訳を残す (合計は不変)", async () => {
    const store = new MemoryStore();
    const { impl } = fakeFetch((url) => {
      if (url.includes("oauth2")) return { access_token: "tok" };
      return { rows: [] };
    });
    const result = await runGa4Sync({
      store,
      fetchImpl: impl,
      propertyId: "1",
      serviceAccountJson: SA_JSON,
      now: () => new Date("2026-07-24T09:00:00Z"),
    });

    expect(result.aiConversions).toBe(0);
    expect(store.aiCvEvents).toHaveLength(1); // 計測した事実は残る
    expect(store.aiCvEvents[0]!.count).toBe(0);
    expect(await store.sumAiCvEvents()).toBe(0); // 合計には影響しない
    expect(result.breakdown!.adopted).toBe("tie");
  });

  it("再実行しても二重計上しない (月次ジョブの冪等性)", async () => {
    const store = new MemoryStore();
    const { impl } = fakeFetch((url, body) => {
      if (url.includes("oauth2")) return { access_token: "tok" };
      const b = body as { dimensions: { name: string }[] };
      if (b.dimensions[0]!.name === "sessionDefaultChannelGroup") {
        return {
          rows: [
            { dimensionValues: [{ value: "AI Assistants" }], metricValues: [{ value: "40" }, { value: "5" }] },
          ],
        };
      }
      return { rows: [] };
    });
    const opts = {
      store,
      fetchImpl: impl,
      propertyId: "123456",
      serviceAccountJson: SA_JSON,
      now: () => new Date("2026-07-24T09:00:00Z"),
    };

    await runGa4Sync(opts);
    await runGa4Sync(opts); // 手動再実行を想定

    // AI経由CVの累計はAI・LLMO凍結解除の判定に使われるため、水増しは許されない
    expect(await store.sumAiCvEvents()).toBe(5);
    expect(store.aiCvEvents).toHaveLength(1);
    expect([...store.gscMetrics.values()].filter((r) => r.article_id === null)).toHaveLength(1);
  });
});

describe("ai_cv_counter (多重計測3系統)", () => {
  it("3系統の累計と凍結解除の提案可否を返す", async () => {
    const store = new MemoryStore();
    store.setConfig("ai_llmo_unfreeze_cv_range", { min: 30, max: 50 });
    await store.insertAiCvEvent({ occurred_on: "2026-06-01", source: "ga4_channel", count: 20 });
    await recordSelfReportCv(store, "2026-07-01", "問い合わせでAIチャットと回答");
    await recordReferrerLogCv(store, "2026-07-01", 8);

    const status = await aiCvStatus(store);
    expect(status.total).toBe(29);
    expect(status.proposable).toBe(false);
    // 系統別内訳: どの系統が何件かを見て重複度を判断できること
    expect(status.bySource).toEqual({ ga4_channel: 20, self_report: 1, referrer_log: 8 });

    await recordSelfReportCv(store, "2026-07-02");
    expect((await aiCvStatus(store)).proposable).toBe(true); // 30到達
  });
});
