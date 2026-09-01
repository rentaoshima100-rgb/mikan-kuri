import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { FixtureLLMClient } from "@kurimikan/shared";
import { MemoryStore } from "../db/memory.js";
import {
  proposeKeywords,
  buildAssetInventory,
  similarity,
  findSimilar,
  SIMILARITY_THRESHOLD,
} from "./propose_keywords.js";
import type { PrimaryAssetRow } from "../db/types.js";

const SUITE = join(__dirname, "..", "..", "..", "..", "kurimikan_prompt_suite_v1.md");

// verdicts を渡さない場合は「全件が重複なし」の判定を自動で作る。
// 意図照合ゲート (P-DUP) を通した上で、そこ以外の挙動を見るため。
function makeDeps(proposals: unknown[], verdicts?: unknown[]) {
  const store = new MemoryStore();
  store.setConfig("cluster_allocation", { renewal: 52, production: 20, system_dev: 15, ai_llmo: 13 });
  const pass = (proposals as { keyword: string }[]).map((p) => ({
    keyword: p.keyword,
    duplicate: false,
    conflicts_with: "",
    reason: "既存に同じ問いに答える記事がない",
  }));
  const llm = new FixtureLLMClient({
    fixturesDir: join(__dirname, "..", "..", "..", "shared", "fixtures", "llm"),
    responses: {
      "P-KW": JSON.stringify({ proposals }),
      "P-DUP": JSON.stringify({ verdicts: verdicts ?? pass }),
    },
  });
  return { store, deps: { store, llm, suitePath: SUITE } };
}

// 意図照合を必ず失敗させる (P-DUP の応答を用意しない)
function makeDepsWithoutDedup(proposals: unknown[]) {
  const store = new MemoryStore();
  store.setConfig("cluster_allocation", { renewal: 52, production: 20, system_dev: 15, ai_llmo: 13 });
  const llm = new FixtureLLMClient({
    fixturesDir: join(__dirname, "..", "..", "..", "shared", "fixtures", "llm"),
    responses: { "P-KW": JSON.stringify({ proposals }) },
  });
  return { store, deps: { store, llm, suitePath: SUITE } };
}

describe("keyword proposer: 発案とトピック承認点", () => {
  it("提案は status=proposed で入る (承認するまで記事化対象にならない)", async () => {
    const { store, deps } = makeDeps([
      { keyword: "ホームページ リニューアル 301リダイレクト", cluster: "renewal", article_type: "howto", search_intent: "URL移行の事故回避", priority: 80, rationale: "既存に無い空白" },
    ]);
    const r = await proposeKeywords(deps, { count: 1 });

    expect(r.proposed).toHaveLength(1);
    expect(r.proposed[0]!.status).toBe("proposed");
    expect(r.proposed[0]!.source).toBe("strategy_agent");
    expect(r.proposed[0]!.rationale).toBeTruthy();
    // proposed はキュー(queued)には入らない = まだ記事化されない
    expect(await store.listKeywordsByStatus("queued")).toHaveLength(0);
    expect(await store.listKeywordsByStatus("proposed")).toHaveLength(1);
  });

  it("既存記事とカニバるトピックは弾く", async () => {
    const { store, deps } = makeDeps([
      { keyword: "重複トピック", cluster: "renewal", article_type: "howto", search_intent: "x", priority: 50, rationale: "y" },
      { keyword: "新しいトピック", cluster: "renewal", article_type: "howto", search_intent: "z", priority: 60, rationale: "穴" },
    ]);
    // 既存記事に「重複トピック」がある状態を作る
    const kw = store.addKeyword({ keyword: "重複トピック", cluster: "renewal" });
    const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
    await store.updateArticle(a.id, { title: "重複トピック", status: "published" });

    const r = await proposeKeywords(deps, { count: 2 });

    expect(r.proposed.map((p) => p.keyword)).toEqual(["新しいトピック"]);
    expect(r.skipped.map((s) => s.keyword)).toContain("重複トピック");
  });

  it("cluster指定時はそのクラスタ以外の提案を弾く", async () => {
    const { deps } = makeDeps([
      { keyword: "A", cluster: "renewal", article_type: "howto", search_intent: "x", priority: 50, rationale: "y" },
      { keyword: "B", cluster: "ai_llmo", article_type: "howto", search_intent: "x", priority: 50, rationale: "y" },
    ]);
    const r = await proposeKeywords(deps, { cluster: "renewal", count: 2 });
    expect(r.proposed.map((p) => p.keyword)).toEqual(["A"]);
  });
});

describe("buildAssetInventory: 発案に渡す一次情報の在庫", () => {
  it("タイトル・クラスタ・説明・持っている数値を並べる", () => {
    const inv = buildAssetInventory([
      {
        id: "a1",
        title: "FeliCa検出時間のiOS別実測",
        description: "Info.plistの登録数と検出時間の関係を実機で測った",
        applicable_clusters: ["system_dev"],
        numeric_claims: [
          { claim: "iOS 17の登録上限", value: "148", unit: "個程度" },
          { claim: "iOS 18以降の検出時間", value: "0.054", unit: "秒" },
        ],
      },
    ] as unknown as PrimaryAssetRow[]);
    expect(inv).toContain("FeliCa検出時間のiOS別実測");
    expect(inv).toContain("[system_dev]");
    expect(inv).toContain("iOS 17の登録上限 148個程度");
    expect(inv).toContain("iOS 18以降の検出時間 0.054秒");
  });

  it("数値を持たない資産はその旨を書く", () => {
    const inv = buildAssetInventory([
      { id: "a2", title: "代表の専門背景", description: "d", applicable_clusters: ["ai_llmo"], numeric_claims: [] },
    ] as unknown as PrimaryAssetRow[]);
    expect(inv).toContain("なし (定性的な知見のみ)");
  });

  it("在庫が空でもプロンプトが壊れない", () => {
    expect(buildAssetInventory([])).toContain("使える一次情報がありません");
  });
});

describe("類似キーワードの検出 (語順・複合語の切れ目の違い)", () => {
  // この前段フィルタが担うのは「同じ語を並べ替えただけ」の案だけ。
  // 言い回しの違う重複は intent_dedup.ts の意図照合が担当する。
  it("語を並べ替えただけの案を検出する", () => {
    expect(similarity("iOS NFC FeliCa 読み取り 遅い 原因", "iOS FeliCa 読み取り 遅い 原因"))
      .toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
  });

  // しきい値の再調整で直せる問題ではないことを、実測値で固定しておく。
  // 別物の 0.550 が、重複の 0.500 / 0.167 より高い = 階級が重なっており分離不能。
  it("字面の重なりでは重複と別物を分離できない (しきい値を動かしても直らない)", () => {
    const dup = [
      similarity("ホームページ リニューアル タイミング 見極め方", "ホームページ リニューアル 進め方 失敗"),
      similarity("Googleビジネスプロフィール MEO 最適化", "ローカルビジネス GEO MEO 集客"),
    ];
    const notDup = similarity("ホームページ リニューアル 費用 相場", "ホームページ リニューアル 進め方 失敗");
    // 別物のほうが、重複より高いスコアになる組が実在する
    expect(notDup).toBeGreaterThan(Math.max(...dup));
    // したがってこの2組は前段では落ちない (落としてはいけない)
    for (const d of dup) expect(d).toBeLessThan(SIMILARITY_THRESHOLD);
    expect(notDup).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it("無関係なキーワードは検出しない (過検出しない)", () => {
    const pairs: [string, string][] = [
      ["ホームページ リニューアル 費用 相場", "AIチャットボット 業種別 活用 中小企業"],
      ["CMS 比較 WordPress 中小企業 選び方", "iOS NFC FeliCa 読み取り 遅い 原因"],
      ["生成AI SEO 記事作成 品質管理 方法", "ホームページ リニューアル タイミング 見極め方"],
    ];
    for (const [a, b] of pairs) {
      expect(similarity(a, b)).toBeLessThan(SIMILARITY_THRESHOLD);
    }
  });

  it("同じ主題でも切り口が違えば通す", () => {
    // どちらもリニューアルだが、費用の話と失敗事例の話は別記事にする価値がある
    expect(similarity("ホームページ リニューアル 費用 相場 中小企業", "ホームページ リニューアル 失敗 事例"))
      .toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it("findSimilar は一致した相手を返す (誤検出時に人が判断できる)", () => {
    const existing = ["ホームページ リニューアル 費用 相場", "iOS FeliCa 読み取り 遅い 原因"];
    // 0.750。前段で落とす対象
    expect(findSimilar("iOS NFC FeliCa 読み取り 遅い 原因", existing)).toBe(
      "iOS FeliCa 読み取り 遅い 原因",
    );
    expect(findSimilar("CMS 比較 WordPress 選び方", existing)).toBeNull();
  });

  it("空文字でも落ちない", () => {
    expect(similarity("", "何か")).toBe(0);
    expect(findSimilar("何か", ["", ""])).toBeNull();
  });
});

describe("検索意図による重複判定 (字面が違っても同じ意図なら弾く)", () => {
  // 2026-08-02 のSEO監査で見つかった実物。字面のふるい (bigram, しきい値0.55) では
  //   0.500「リニューアル タイミング 見極め方」vs「リニューアル 進め方 失敗」
  // で届かず、同じ意図の記事が2本公開された。
  const RENEWAL = {
    keyword: "ホームページ リニューアル タイミング 見極め方",
    cluster: "renewal",
    article_type: "howto",
    search_intent: "リニューアルすべき時期かどうかを判断したい",
    priority: 70,
    rationale: "既存に無い切り口",
  };

  it("字面のふるいを通っても、意図が既存と同じなら弾く", async () => {
    const { store, deps } = makeDeps(
      [RENEWAL],
      [
        {
          keyword: RENEWAL.keyword,
          duplicate: true,
          conflicts_with: "失敗しないホームページリニューアルの進め方 — タイミングの見極めと発注チェックリスト",
          reason: "既存記事が「タイミングの見極め」に正面から答えている",
        },
      ],
    );
    // 既存記事側。字面が違うので similarity では弾けない
    const kw = store.addKeyword({ keyword: "ホームページ リニューアル 進め方 失敗", cluster: "renewal" });
    const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
    await store.updateArticle(a.id, {
      title: "失敗しないホームページリニューアルの進め方 — タイミングの見極めと発注チェックリスト",
      status: "published",
    });
    // 前提: 字面のふるいでは通ってしまうこと
    expect(similarity(RENEWAL.keyword, "ホームページ リニューアル 進め方 失敗")).toBeLessThan(
      SIMILARITY_THRESHOLD,
    );

    const r = await proposeKeywords(deps, { count: 1 });

    expect(r.proposed).toHaveLength(0);
    expect(r.skipped[0]!.reason).toContain("検索意図が");
    // 誤検出だったときに人が判断し直せるよう、衝突相手と理由を残す
    expect(r.skipped[0]!.reason).toContain("失敗しないホームページリニューアルの進め方");
    expect(r.skipped[0]!.reason).toContain("正面から答えている");
  });

  it("同じ題材でも意図が違えば通す (過検出しない)", async () => {
    const { store, deps } = makeDeps(
      [{ ...RENEWAL, keyword: "ホームページ リニューアル 費用 相場", search_intent: "予算を決めたい" }],
      [
        {
          keyword: "ホームページ リニューアル 費用 相場",
          duplicate: false,
          conflicts_with: "",
          reason: "既存は進め方の記事で、予算を決める読者の問いには答えていない",
        },
      ],
    );
    const kw = store.addKeyword({ keyword: "ホームページ リニューアル 進め方 失敗", cluster: "renewal" });
    const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
    await store.updateArticle(a.id, { title: "失敗しないホームページリニューアルの進め方", status: "published" });

    const r = await proposeKeywords(deps, { count: 1 });
    expect(r.proposed).toHaveLength(1);
  });

  it("照合できなかったときは案を落とさず、目視確認の印を残す", async () => {
    const { store, deps } = makeDepsWithoutDedup([RENEWAL]);
    const kw = store.addKeyword({ keyword: "既存の何か", cluster: "renewal" });
    const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
    await store.updateArticle(a.id, { title: "既存の何か", status: "published" });

    const r = await proposeKeywords(deps, { count: 1 });

    // 発案を止めない (承認点が最後の歯止めとして残る)
    expect(r.proposed).toHaveLength(1);
    // ただし黙って通さない
    expect(r.proposed[0]!.rationale).toContain("意図照合できず");
  });
});

describe("ストアの公開記事を重複判定の相手に加える", () => {
  // articles テーブルが追跡しているのはパイプラインが作った記事だけ。
  // 店舗が /blogs/news に手で投稿したお知らせは見えないので、
  // 呼び出し側が extraExistingTopics で足す (Shopifyから引く実装は
  // site_integration/shopify/topics.ts の shopifyTopicsProvider)。
  const STORE_TOPICS = [
    { title: "南柑20号の出荷が始まりました", keyword: "" },
    { title: "甘平の旬はいつ？食べごろの見分け方", keyword: "" },
  ];

  it("DB未追跡の記事も判定相手に入り、重複と判定されれば弾く", async () => {
    const kw = "甘平 食べ頃 見分け方";
    const { deps } = makeDeps(
      [{ keyword: kw, cluster: "renewal", article_type: "howto", search_intent: "食べ頃を知りたい", priority: 70, rationale: "穴" }],
      [{ keyword: kw, duplicate: true, conflicts_with: "甘平の旬はいつ？食べごろの見分け方", reason: "同じ問いに答えている" }],
    );
    // DBには一切記事が無い。相手はストア側のみ
    const r = await proposeKeywords(
      { ...deps, extraExistingTopics: STORE_TOPICS },
      { count: 1 },
    );
    expect(r.comparedAgainst).toBe(2);
    expect(r.proposed).toHaveLength(0);
    expect(r.skipped[0]!.reason).toContain("甘平の旬はいつ？食べごろの見分け方");
  });

  it("相手が0本なら判定にかけない (空振りのLLM呼び出しをしない)", async () => {
    const { deps } = makeDepsWithoutDedup([
      { keyword: "何か新しい話", cluster: "renewal", article_type: "howto", search_intent: "x", priority: 50, rationale: "y" },
    ]);
    const r = await proposeKeywords({ ...deps, extraExistingTopics: [] }, { count: 1 });
    expect(r.comparedAgainst).toBe(0);
    // 相手がいないので照合は走らず、印も付かない
    expect(r.proposed).toHaveLength(1);
    expect(r.proposed[0]!.rationale).not.toContain("意図照合できず");
  });
});

describe("記事化待ちキーワードとの意図重複 (すれ違い防止)", () => {
  const PROPOSAL = {
    keyword: "ホームページ リニューアル タイミング 見極め方",
    cluster: "renewal",
    article_type: "howto",
    search_intent: "リニューアルすべき時期かどうかを判断したい",
    priority: 70,
    rationale: "既存に無い切り口",
  };

  it("queuedのキーワードも意図照合の相手に渡り、重複なら弾く", async () => {
    const store = new MemoryStore();
    store.setConfig("cluster_allocation", { renewal: 52 });
    // 昨日queuedになった同意図のトピック。記事はまだ無い (articlesは空)
    store.addKeyword({ keyword: "ホームページ リニューアル 進め方 失敗", status: "queued" });

    let dupPrompt = "";
    const llm = new FixtureLLMClient({
      fixturesDir: join(__dirname, "..", "..", "..", "shared", "fixtures", "llm"),
      responses: {
        "P-KW": JSON.stringify({ proposals: [PROPOSAL] }),
        "P-DUP": (req) => {
          dupPrompt = req.user;
          return JSON.stringify({
            verdicts: [
              {
                keyword: PROPOSAL.keyword,
                duplicate: true,
                conflicts_with: "ホームページ リニューアル 進め方 失敗",
                reason: "同じ検索意図のトピックが記事化待ち",
              },
            ],
          });
        },
      },
    });

    const r = await proposeKeywords({ store, llm, suitePath: SUITE }, { count: 1 });

    // 照合相手として記事化待ちキーワードがプロンプトに渡っている
    expect(dupPrompt).toContain("ホームページ リニューアル 進め方 失敗");
    expect(r.proposed).toHaveLength(0);
    expect(r.skipped[0]!.reason).toContain("進め方 失敗");
    // comparedAgainstは「既存記事」の本数のまま (キーワードは数えない)
    expect(r.comparedAgainst).toBe(0);
  });
});

describe("全自動公開中の意図照合失敗はフェイルクローズド", () => {
  const PROPOSAL = {
    keyword: "ホームページ リニューアル タイミング 見極め方",
    cluster: "renewal",
    article_type: "howto",
    search_intent: "時期を判断したい",
    priority: 70,
    rationale: "穴",
  };

  it("full_auto_publish=true では照合できなかった案を登録しない (翌日の発案でやり直す)", async () => {
    const { store, deps } = makeDepsWithoutDedup([PROPOSAL]);
    store.setConfig("full_auto_publish", true);
    const kw = store.addKeyword({ keyword: "既存の何か", cluster: "renewal", status: "done" });
    const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
    await store.updateArticle(a.id, { title: "既存の何か", status: "published" });

    const r = await proposeKeywords(deps, { count: 1 });

    // 印付きで登録するとautoQueueTopicsが無条件に記事化してしまうため、登録自体をしない
    expect(r.proposed).toHaveLength(0);
    expect(r.skipped[0]!.reason).toContain("フェイルクローズド");
    expect(await store.listKeywordsByStatus("proposed")).toHaveLength(0);
  });

  it("full_auto_publish=false (既定) では従来どおり印付きで登録する (回帰防止)", async () => {
    const { store, deps } = makeDepsWithoutDedup([PROPOSAL]);
    const kw = store.addKeyword({ keyword: "既存の何か", cluster: "renewal", status: "done" });
    const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
    await store.updateArticle(a.id, { title: "既存の何か", status: "published" });

    const r = await proposeKeywords(deps, { count: 1 });

    expect(r.proposed).toHaveLength(1);
    expect(r.proposed[0]!.rationale).toContain("意図照合できず");
  });
});
