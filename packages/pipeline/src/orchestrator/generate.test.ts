import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BudgetExceededError,
  FixtureLLMClient,
  PROMPT_MODEL_CATEGORY,
  type FixtureResponses,
} from "@kurimikan/shared";
import { MemoryStore } from "../db/memory.js";
import {
  allocateAssets,
  assetForJudge,
  buildAssetInjectionBlock,
  continueFromGate,
  dedupeH2Sections,
  generateArticle,
  type OrchestratorDeps,
} from "./generate.js";
import type { PrimaryAssetRow } from "../db/types.js";
import type { P01OutlineT } from "@kurimikan/shared";

const FIXTURES = join(__dirname, "..", "..", "..", "shared", "fixtures", "llm");
const SUITE = join(__dirname, "..", "..", "..", "..", "kurimikan_prompt_suite_v1.md");

const fx = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const p04With = (verdict: string, fixes: string[] = []) => {
  const data = JSON.parse(fx("P-04.json"));
  data.verdict = verdict;
  data.fix_instructions = fixes;
  return JSON.stringify(data);
};

function makeWorld(opts: {
  lane?: "A" | "B";
  articleType?: string;
  keyword?: string;
  responses?: FixtureResponses;
  monthSpend?: number;
}) {
  const store = new MemoryStore();
  store.setConfig("lane_b_allowed_types", ["howto", "comparison", "public_data", "market_report"]);
  store.setConfig("weekly_publish_target", 2);
  store.setConfig("approval_deadman_hours", 72);
  store.monthSpendUsd = opts.monthSpend ?? 0;
  const kw = store.addKeyword({
    keyword: opts.keyword ?? "homepage-renewal-guide",
    cluster: "renewal",
    article_type: opts.articleType ?? "howto",
    assigned_lane: opts.lane ?? "A",
  });
  store.addAsset({ applicable_clusters: ["renewal"] });
  const llm = new FixtureLLMClient({ fixturesDir: FIXTURES, responses: opts.responses });
  const deps: OrchestratorDeps = { store, llm, suitePath: SUITE, budgetUsd: 60 };
  return { store, llm, kw, deps };
}

const promptIds = (llm: FixtureLLMClient) => llm.calls.map((c) => c.promptId);

describe("orchestrator: 全自動時の数値チェック", () => {
  it("full_auto ではレーンAの記事にも合議 (P-05) を掛ける", async () => {
    // 全自動では人が本文を読まないので、収穫時期・糖度・価格のような
    // 「産地の人にしか検証できない数値」を誰も確かめないまま公開してしまう。
    // サブスク実行では呼び出しに課金が無いため、ここを厚くしても増えるのは時間だけ
    const { store, llm, kw, deps } = makeWorld({ lane: "A" });
    store.setConfig("full_auto_publish", true);

    await generateArticle(kw.id, deps);

    expect(promptIds(llm)).toContain("P-05a");
    expect(promptIds(llm)).toContain("P-05b");
  });

  it("既定 (承認制) のレーンAでは従来どおり合議を掛けない", async () => {
    const { llm, kw, deps } = makeWorld({ lane: "A" });

    await generateArticle(kw.id, deps);

    expect(promptIds(llm)).not.toContain("P-05a");
  });
});

describe("orchestrator: 記事と一次情報の紐付け", () => {
  it("執筆に渡した一次情報を article_assets に残す", async () => {
    // 素材が期限切れになったとき、それを使っている公開済み記事を逆引きして
    // 改修対象にするために要る。全自動公開では出した後の巡回が唯一の是正手段になる
    const { store, kw, deps } = makeWorld({ lane: "A" });
    const article = await generateArticle(kw.id, deps);

    const assetId = store.assets[0]!.id;
    expect(store.articleAssets).toContainEqual({
      article_id: article.id,
      asset_id: assetId,
    });
  });
});

describe("orchestrator: レーンA (人間ネタ投入)", () => {
  it("happy path: 承認キュー (approval_pending) に到達し、publish_queueには入らない (v3)", async () => {
    const { store, kw, deps } = makeWorld({ lane: "A" });
    const article = await generateArticle(kw.id, deps);

    expect(article.status).toBe("approval_pending");
    expect(article.title).toBeTruthy();
    expect(article.meta_description).toBeTruthy();
    // slugはP-12が生成した英語slug (キーワードのASCII化ではない)
    expect(article.slug).toBe("homepage-renewal-cost");
    expect(article.word_count).toBeGreaterThan(0);
    expect(article.body_mdx).toContain("## 関連リンク");
    expect(store.queue).toHaveLength(0); // 承認前にキュー投入されない
    expect(store.links.some((l) => l.direction === "outbound" && l.status === "applied")).toBe(true);
    expect((await store.getKeyword(kw.id))!.status).toBe("done");
  });

  it("レーンAではP-06/P-05 (レーンB専用) を呼ばない", async () => {
    const { llm, kw, deps } = makeWorld({ lane: "A" });
    await generateArticle(kw.id, deps);
    const ids = promptIds(llm);
    expect(ids).not.toContain("P-06");
    expect(ids).not.toContain("P-05a");
    expect(ids).toContain("P-01");
    expect(ids).toContain("P-04");
    expect(ids).toContain("P-12");
    expect(ids).toContain("P-11");
  });
});

describe("orchestrator: LLMのMDX混入をbody_mdxに持ち込まない", () => {
  // P-02/P-13bは本文を ```mdx フェンス + フロントマターで包んで返すことがある。
  // 素通りするとプレーンmarkdownのサイト側で記事全体が <pre><code> に落ちる
  // (2026-07-30に本番のarticle-blog-botで発生した)。生成時点で落とすことを保証する。
  const fenced = [
    "```mdx",
    "---",
    'title: "汚染されたタイトル"',
    'description: "汚染された説明"',
    "---",
    "",
    "import { Callout } from '@/components/callout'",
    "",
    "## ホームページリニューアルの費用相場は？",
    "",
    "費用は案件の規模と要件により変動します。",
    "```",
  ].join("\n");

  it("```mdxフェンス・フロントマター・import文がbody_mdxに残らない", async () => {
    const { kw, deps } = makeWorld({ lane: "A", responses: { "P-02": fenced } });
    const article = await generateArticle(kw.id, deps);
    const body = article.body_mdx!;
    expect(body).not.toContain("```mdx");
    expect(body).not.toContain("import {");
    expect(body).not.toContain("汚染されたタイトル");
    expect(body).toContain("## ホームページリニューアルの費用相場は？");
  });
});

describe("orchestrator: レーンB (下書きジェネレータ)", () => {
  it("happy path: P-06はP-04の前、P-05合議は2系統呼ばれ、承認キューに到達する", async () => {
    const { llm, kw, deps } = makeWorld({ lane: "B" });
    const article = await generateArticle(kw.id, deps);

    expect(article.status).toBe("approval_pending");
    const ids = promptIds(llm);
    expect(ids.indexOf("P-06")).toBeGreaterThan(-1);
    expect(ids.indexOf("P-06")).toBeLessThan(ids.indexOf("P-04")); // 生成直後、P-04の前
    expect(ids).toContain("P-05a");
    expect(ids).toContain("P-05b");
    expect(ids).toContain("P-05b-2"); // 2系統judge
  });

  it("lane_b_eligible=false なら rejected + キーワードparked + キュー投入なし", async () => {
    const p01 = JSON.parse(fx("P-01.json"));
    p01.lane_b_eligible = false;
    p01.lane_b_reason = "補助金の金額が構成上避けられない";
    const { store, kw, deps } = makeWorld({
      lane: "B",
      responses: { "P-01": JSON.stringify(p01) },
    });
    const article = await generateArticle(kw.id, deps);

    expect(article.status).toBe("rejected");
    expect((await store.getKeyword(kw.id))!.status).toBe("parked");
    expect(store.queue).toHaveLength(0);
  });

  it("提案ログ由来の相場記事 (market_report) は凍結中なら機械的にrejectされる (v3 1-8)", async () => {
    // 凍結中: proposal_log_articles_enabled 未設定 (=false相当)
    const frozen = makeWorld({ lane: "B", articleType: "market_report" });
    const rejected = await generateArticle(frozen.kw.id, frozen.deps);
    expect(rejected.status).toBe("rejected");
    expect(frozen.llm.calls).toHaveLength(0); // LLMを呼ぶ前に止める
    expect((await frozen.store.getKeyword(frozen.kw.id))!.status).toBe("parked");

    // 解除後は通常どおり生成できる (書面照会の回答後を想定)
    const allowed = makeWorld({ lane: "B", articleType: "market_report" });
    allowed.store.setConfig("proposal_log_articles_enabled", true);
    const article = await generateArticle(allowed.kw.id, allowed.deps);
    expect(article.status).toBe("approval_pending");
  });

  it("lane_b_allowed_types外の記事タイプはLLMを呼ぶ前にrejectする", async () => {
    const { llm, store, kw, deps } = makeWorld({ lane: "B", articleType: "subsidy" });
    const article = await generateArticle(kw.id, deps);

    expect(article.status).toBe("rejected");
    expect(llm.calls).toHaveLength(0);
    expect((await store.getKeyword(kw.id))!.status).toBe("parked");
  });

  it("合議の2系統は異なるモデルカテゴリを使い、OpenAI代替である旨が記録される (SPEC M1)", async () => {
    const { llm, kw, deps } = makeWorld({ lane: "B" });
    const article = await generateArticle(kw.id, deps);

    // 第1系統=classify(Haiku)、第2系統=judge(Sonnet)。既定フォールバック任せにしない
    expect(PROMPT_MODEL_CATEGORY["P-05b"]).toBe("classify");
    expect(PROMPT_MODEL_CATEGORY["P-05b-2"]).toBe("judge");
    expect(llm.calls.filter((c) => c.promptId.startsWith("P-05b"))).toHaveLength(2);

    const detail = article.consensus_result as {
      systems: { openai_used: boolean; primary: string; secondary: string; note: string };
    };
    expect(detail.systems.openai_used).toBe(false);
    expect(detail.systems.primary).not.toBe(detail.systems.secondary);
    expect(detail.systems.note).toContain("代替");
  });

  it("judge不一致フラグは再合議で下ろされない (人間エスカレーションの回避防止)", async () => {
    // 1回目の合議は不一致 → gate_pending で止める。2回目 (continueFromGate) は一致する
    let judgeCalls = 0;
    let gateCalls = 0;
    const { store, kw, deps } = makeWorld({
      lane: "B",
      responses: {
        "P-05b-2": () =>
          ++judgeCalls === 1
            ? JSON.stringify({ verdicts: [{ id: 1, verdict: "false", reason: "確認できない" }] })
            : JSON.stringify({ verdicts: [{ id: 1, verdict: "true", reason: "確認できた" }] }),
        // holdでも1回は再生成するようになったため、生成中の2回はholdを返す。
        // 3回目 (continueFromGate内の再ゲート) でapproveにして、この検証の主眼である
        // 「再合議で一致してもjudge不一致フラグは下ろされない」を確かめる
        "P-04": () => (++gateCalls <= 2 ? p04With("hold", ["独自性を足す"]) : p04With("approve")),
      },
    });
    const held = await generateArticle(kw.id, deps);
    expect(held.status).toBe("gate_pending");

    const resumed = await continueFromGate(held.id, deps);

    // 2回目が一致してもフラグは残る → 承認にはackが必要なまま
    expect(resumed.judge_disagreement).toBe(true);
    expect(resumed.status).toBe("approval_pending");
    void store;
  });

  it("judge不一致 (系統間で判定が割れる) はフラグを立てて承認キューへ (自動棄却しない)", async () => {
    const disagree = JSON.stringify({
      verdicts: [{ id: 1, verdict: "false", reason: "確認できない" }],
    });
    const { kw, deps } = makeWorld({ lane: "B", responses: { "P-05b-2": disagree } });
    const article = await generateArticle(kw.id, deps);

    expect(article.status).toBe("approval_pending"); // 自動棄却も自動通過もしない
    expect(article.judge_disagreement).toBe(true);
    const detail = article.consensus_result as { claims: Array<{ resolution: string }> };
    expect(detail.claims[0]!.resolution).toBe("judge_disagreement");
  });

  it("2系統一致NGの数値主張はP-06で除去しP-04を再ゲートする (最大1周)", async () => {
    const claimNoSource = JSON.stringify({
      claims: [
        {
          id: 1,
          claim: "約7割の企業が失敗しています",
          type: "numeric",
          context: "導入部",
          source_in_article: null,
        },
      ],
    });
    const bothFalse = JSON.stringify({
      verdicts: [{ id: 1, verdict: "false", reason: "根拠なし" }],
    });
    const { llm, kw, deps } = makeWorld({
      lane: "B",
      responses: { "P-05a": claimNoSource, "P-05b": bothFalse, "P-05b-2": bothFalse },
    });
    const article = await generateArticle(kw.id, deps);

    expect(article.status).toBe("approval_pending");
    const ids = promptIds(llm);
    expect(ids.filter((i) => i === "P-06")).toHaveLength(2); // 生成直後+除去
    expect(ids.filter((i) => i === "P-04")).toHaveLength(2); // ゲート+再ゲート
    expect(article.judge_disagreement).toBe(false); // 一致NGは不一致ではない
  });
});

describe("orchestrator: 品質ゲート分岐", () => {
  it("reject → fix_instructionsを添えて1回だけ再生成 → approveで続行", async () => {
    let gateCalls = 0;
    const { llm, kw, deps } = makeWorld({
      lane: "A",
      responses: {
        "P-04": () => (++gateCalls === 1 ? p04With("reject", ["結論ファーストに直す"]) : p04With("approve")),
      },
    });
    const article = await generateArticle(kw.id, deps);

    expect(article.status).toBe("approval_pending");
    // fixture P-01は2セクション + FAQセクション = 3。再生成で2巡=計6回
    expect(promptIds(llm).filter((i) => i === "P-02")).toHaveLength(6);
    const secondRound = llm.calls.filter((c) => c.promptId === "P-02").slice(3);
    expect(secondRound.every((c) => c.user.includes("結論ファーストに直す"))).toBe(true);
  });

  it("再rejectで終了: rejected + キーワードparked + キュー投入なし", async () => {
    const { store, kw, deps } = makeWorld({
      lane: "A",
      responses: { "P-04": p04With("reject", ["直す"]) },
    });
    const article = await generateArticle(kw.id, deps);

    expect(article.status).toBe("rejected");
    expect(store.queue).toHaveLength(0);
    expect((await store.getKeyword(kw.id))!.status).toBe("parked");
  });

  it("rejectでもP-04の判定 (スコア・理由) を残す (なぜ落ちたか追えるように)", async () => {
    const { kw, deps } = makeWorld({
      lane: "A",
      responses: { "P-04": p04With("reject", ["独自性が不足"]) },
    });
    const article = await generateArticle(kw.id, deps);

    expect(article.status).toBe("rejected");
    // 最終マーカーだけでなく、実スコアと理由が残っていること
    const q = article.quality as Record<string, unknown>;
    expect(q.rejected_reason).toBe("P-04再rejectで終了");
    expect(article.quality_score).toBe((q.scores as { total: number }).total);
    expect((q.fix_instructions as string[])).toContain("独自性が不足");
  });

  it("hold → gate_pending (管理画面へ)。ゲート承認後continueFromGateで承認キューへ", async () => {
    let gateCalls = 0;
    const { kw, deps } = makeWorld({
      lane: "A",
      // holdでも1回は再生成するので、生成中の2回はholdのまま。
      // 2周ともholdならgate_pendingで止まり、代表のゲート承認を待つ
      responses: {
        "P-04": () => (++gateCalls <= 2 ? p04With("hold", ["独自性を足す"]) : p04With("approve")),
      },
    });
    const held = await generateArticle(kw.id, deps);
    expect(held.status).toBe("gate_pending");
    expect(held.body_mdx).toBeTruthy();

    const resumed = await continueFromGate(held.id, deps);
    expect(resumed.status).toBe("approval_pending");
    expect(resumed.title).toBeTruthy();
  });

  it("full_auto: 再rejectでも承認キューに到達する (品質ゲートをバイパス)", async () => {
    const { store, kw, deps } = makeWorld({
      lane: "A",
      responses: { "P-04": p04With("reject", ["直す"]) },
    });
    store.setConfig("full_auto_publish", true);
    const article = await generateArticle(kw.id, deps);

    // rejectで止まらず仕上げ (slug付与) まで進み、承認キューへ
    expect(article.status).toBe("approval_pending");
    expect(article.slug).toBeTruthy();
    expect(article.body_mdx).toContain("## 関連リンク");
    expect((await store.getKeyword(kw.id))!.status).toBe("done");
    // 低品質でもスコアは記録する (後で追えるように)
    expect(article.quality).toBeTruthy();
    expect(store.queue).toHaveLength(0); // 公開予定は auto_approve 側の責務 (生成では積まない)
  });

  it("full_auto: holdでもgate_pendingで止まらず承認キューへ", async () => {
    const { store, kw, deps } = makeWorld({
      lane: "A",
      responses: { "P-04": p04With("hold", ["独自性を足す"]) },
    });
    store.setConfig("full_auto_publish", true);
    const article = await generateArticle(kw.id, deps);
    expect(article.status).toBe("approval_pending");
  });

  it("full_auto=false (既定) なら従来通りrejectで止まる (回帰防止)", async () => {
    const { kw, deps } = makeWorld({
      lane: "A",
      responses: { "P-04": p04With("reject", ["直す"]) },
    });
    const article = await generateArticle(kw.id, deps);
    expect(article.status).toBe("rejected");
  });

  it("full_auto単一パス (既定): rejectでも2周目を回さずAPI節約 (P-02は1巡)", async () => {
    const { llm, store, kw, deps } = makeWorld({
      lane: "A",
      responses: { "P-04": p04With("reject", ["直す"]) },
    });
    store.setConfig("full_auto_publish", true);
    // full_auto_single_pass は既定true (未設定でも1パス)
    const article = await generateArticle(kw.id, deps);
    expect(article.status).toBe("approval_pending");
    expect(promptIds(llm).filter((i) => i === "P-02")).toHaveLength(3); // 1巡のみ
    expect(promptIds(llm).filter((i) => i === "P-04")).toHaveLength(1);
  });

  it("full_auto_single_pass=false なら全自動でも2周する (品質優先に戻せる)", async () => {
    const { llm, store, kw, deps } = makeWorld({
      lane: "A",
      responses: { "P-04": p04With("reject", ["直す"]) },
    });
    store.setConfig("full_auto_publish", true);
    store.setConfig("full_auto_single_pass", false);
    const article = await generateArticle(kw.id, deps);
    expect(article.status).toBe("approval_pending");
    expect(promptIds(llm).filter((i) => i === "P-02")).toHaveLength(6); // 2巡
  });

  it("改修 (revision) のゲート承認はoutline無しでも承認待ちへ進む (タイトル/URL維持)", async () => {
    // 改修記事はP-01 outlineを持たない。continueFromGateがoutlineをparseして落ちない
    // こと、かつタイトル/slugを再生成せず維持することを固定する (管理画面のゲート承認)。
    const { store, kw } = makeWorld({ lane: "A" });
    const deps: OrchestratorDeps = { store, llm: new FixtureLLMClient({ fixturesDir: FIXTURES }), suitePath: SUITE, budgetUsd: 60 };
    const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
    await store.updateArticle(a.id, {
      status: "gate_pending",
      track: "revision",
      slug: "existing-slug",
      title: "既存タイトル",
      body_mdx: "改修後の本文",
      outline: null, // 改修はoutlineを持たない
    });

    const resumed = await continueFromGate(a.id, deps);

    expect(resumed.status).toBe("approval_pending");
    expect(resumed.slug).toBe("existing-slug"); // 変えない
    expect(resumed.title).toBe("既存タイトル"); // 変えない
  });
});

describe("buildAssetInjectionBlock: 一次情報を出典つきで強制注入", () => {
  const asset = (nc: unknown[]): PrimaryAssetRow => ({
    id: "a1",
    asset_type: "public_data_analysis",
    title: "t",
    description: "d",
    content: "c",
    numeric_claims: nc,
    applicable_clusters: ["system_dev"],
    usage_count: 0,
    status: "active",
  });

  it("検証済み数値と出典を明記し、織り込みを強制する文面を作る", () => {
    const b = buildAssetInjectionBlock([
      asset([{ claim: "クラウド利用率", value: "77.0", unit: "%", basis: "総務省 通信利用動向調査 令和6年 (https://soumu.go.jp/x)" }]),
    ]);
    expect(b).toContain("織り込み指示");
    expect(b).toContain("クラウド利用率: 77.0%");
    expect(b).toContain("総務省 通信利用動向調査 令和6年");
    expect(b).toContain("出典の明記は必須");
  });

  it("出典(basis)の無い数値や空assetは無視する", () => {
    expect(buildAssetInjectionBlock([asset([{ claim: "x", value: "1" }])])).toBe("");
    expect(buildAssetInjectionBlock([asset([])])).toBe("");
  });
});

describe("dedupeH2Sections: P-02の間欠的なセクション重複を潰す", () => {
  it("同一H2見出しの2回目以降を削除し、最初の1つを残す", () => {
    const body = [
      "## はじめに",
      "導入の文。",
      "## 費用の相場",
      "相場の説明。",
      "## はじめに",
      "導入の文（重複）。",
      "## まとめ",
      "結論。",
    ].join("\n");
    const out = dedupeH2Sections(body);
    expect((out.match(/^## はじめに$/gm) ?? []).length).toBe(1);
    expect(out).toContain("## 費用の相場");
    expect(out).toContain("## まとめ");
    expect(out).not.toContain("導入の文（重複）");
  });

  it("重複が無ければそのまま (見出し前の前文も保持)", () => {
    const body = "前文です。\n\n## A\n本文A\n\n## B\n本文B";
    const out = dedupeH2Sections(body);
    expect(out).toContain("前文です。");
    expect(out).toContain("## A");
    expect(out).toContain("## B");
  });

  it("全角空白や末尾空白の違いは同一見出しとして扱う", () => {
    const body = "## 費用 の 相場\nx\n## 費用の相場  \ny";
    const out = dedupeH2Sections(body);
    expect((out.match(/^## /gm) ?? []).length).toBe(1);
  });
});

describe("orchestrator: 仕様どおりの本文構成と設定の実効性", () => {
  it("FAQがH2として本文に含まれる (P-00の必須要件)", async () => {
    const { llm, kw, deps } = makeWorld({ lane: "A" });
    await generateArticle(kw.id, deps);

    // P-02はoutlineのH2数だけ呼ばれる。FAQ分が1つ増えていること
    const p02Calls = llm.calls.filter((c) => c.promptId === "P-02");
    const outline = JSON.parse(fx("P-01.json"));
    expect(p02Calls).toHaveLength(outline.outline.length + 1);
    const lastCall = p02Calls[p02Calls.length - 1]!;
    expect(lastCall.user).toContain("よくあるご質問");
    // FAQ候補が見出し候補として渡っている
    expect(lastCall.user).toContain(outline.faq_candidates[0]);
  });

  it("P-02のプレースホルダが残らず、記事タイトルがLLMに渡る", async () => {
    const { llm, kw, deps } = makeWorld({ lane: "A" });
    await generateArticle(kw.id, deps);

    const outline = JSON.parse(fx("P-01.json"));
    for (const call of llm.calls.filter((c) => c.promptId === "P-02")) {
      // 未置換のまま渡すと、タイトルを伝えずに本文を書かせることになる
      expect(call.user).not.toContain("{outline_jsonのtitle_draft}");
      expect(call.user).not.toContain("{current_h2_index}");
      expect(call.user).toContain(outline.title_draft);
    }
  });

  it("FAQ候補が無ければFAQセクションを足さない", async () => {
    const noFaq = JSON.parse(fx("P-01.json"));
    noFaq.faq_candidates = [];
    const { llm, kw, deps } = makeWorld({
      lane: "A",
      responses: { "P-01": JSON.stringify(noFaq) },
    });
    await generateArticle(kw.id, deps);
    expect(llm.calls.filter((c) => c.promptId === "P-02")).toHaveLength(noFaq.outline.length);
  });

  it("品質閾値の設定がP-04の判定より厳しければ設定が優先される", async () => {
    const lowScore = JSON.parse(fx("P-04.json"));
    lowScore.scores.total = 72; // approve(85)未満、hold(70)以上
    lowScore.verdict = "approve"; // LLMは通そうとする
    const { store, kw, deps } = makeWorld({
      lane: "A",
      responses: { "P-04": JSON.stringify(lowScore) },
    });
    store.setConfig("quality_thresholds", { approve: 85, hold: 70 });

    const article = await generateArticle(kw.id, deps);
    expect(article.status).toBe("gate_pending"); // approveではなくholdへ降格
  });

  it("閾値を緩めてもLLMのrejectは覆らない (厳しい方を採用)", async () => {
    const rejected = JSON.parse(fx("P-04.json"));
    rejected.verdict = "reject";
    const { store, kw, deps } = makeWorld({
      lane: "A",
      responses: { "P-04": JSON.stringify(rejected) },
    });
    store.setConfig("quality_thresholds", { approve: 0, hold: 0 });

    expect((await generateArticle(kw.id, deps)).status).toBe("rejected");
  });

  it("本文へ注入した一次情報の usage_count が加算される (ローテーションの前提)", async () => {
    // 資産IDはストア生成時に決まるため、IDを確定させてからP-01応答を組み立てる
    const { store, kw } = makeWorld({ lane: "A" });
    const asset = store.assets[0]!;
    expect(asset.usage_count).toBe(0);

    const outlineWithAsset = JSON.parse(fx("P-01.json"));
    outlineWithAsset.primary_info_plan = [
      { asset_id: asset.id, section_index: 0, usage: "冒頭で使う" },
    ];
    const llm = new FixtureLLMClient({
      fixturesDir: FIXTURES,
      responses: { "P-01": JSON.stringify(outlineWithAsset) },
    });

    await generateArticle(kw.id, { store, llm, suitePath: SUITE, budgetUsd: 60 });

    expect(store.assets[0]!.usage_count).toBe(1);
  });
});

describe("orchestrator: 公開URLのslug", () => {
  const p12With = (slugs: unknown, slugIndex = 0) => {
    const data = JSON.parse(fx("P-12.json"));
    data.slugs = slugs;
    data.recommended.slug_index = slugIndex;
    return JSON.stringify(data);
  };

  it("日本語キーワードでもP-12の英語slugが使われる (URLが意味を持つ)", async () => {
    const { kw, deps } = makeWorld({ lane: "A", keyword: "ホームページ リニューアル 費用" });
    const article = await generateArticle(kw.id, deps);
    expect(article.slug).toBe("homepage-renewal-cost");
  });

  it("recommended.slug_index の候補を優先する", async () => {
    const { kw, deps } = makeWorld({
      lane: "A",
      responses: {
        "P-12": p12With(
          [
            { text: "first-choice-slug", aim: "a" },
            { text: "second-choice-slug", aim: "b" },
          ],
          1,
        ),
      },
    });
    expect((await generateArticle(kw.id, deps)).slug).toBe("second-choice-slug");
  });

  it("不正なslug (日本語・大文字・空白) は捨てて次の候補を使う", async () => {
    const { kw, deps } = makeWorld({
      lane: "A",
      responses: {
        "P-12": p12With([
          { text: "ホームページ費用", aim: "日本語なので不可" },
          { text: "Homepage Cost", aim: "大文字と空白なので不可" },
          { text: "homepage-cost-guide", aim: "これが採用される" },
        ]),
      },
    });
    expect((await generateArticle(kw.id, deps)).slug).toBe("homepage-cost-guide");
  });

  it("有効な候補が無ければ post-<hex> にフォールバックする (article-の二重接頭辞にしない)", async () => {
    const { kw, deps } = makeWorld({
      lane: "A",
      keyword: "日本語のキーワード",
      responses: { "P-12": p12With([{ text: "だめなslug", aim: "x" }]) },
    });
    const article = await generateArticle(kw.id, deps);
    expect(article.slug).toMatch(/^post-[a-z0-9]+$/);
    expect(article.slug!.startsWith("article-")).toBe(false);
  });

  it("既存slugと衝突したら連番を付ける", async () => {
    const { store, kw, deps } = makeWorld({ lane: "A" });
    const other = store.addKeyword({ keyword: "other" });
    const existing = await store.createArticle({
      keyword_id: other.id,
      article_type: "howto",
      lane: "A",
    });
    await store.updateArticle(existing.id, { slug: "homepage-renewal-cost" });

    const article = await generateArticle(kw.id, deps);
    expect(article.slug).toBe("homepage-renewal-cost-2");
  });
});

describe("orchestrator: 予算ガード (フェイルクローズド)", () => {
  it("月次予算100%到達で生成前に停止し、LLMを一切呼ばない", async () => {
    const { llm, kw, deps } = makeWorld({ monthSpend: 60 });
    await expect(generateArticle(kw.id, deps)).rejects.toThrow(BudgetExceededError);
    expect(llm.calls).toHaveLength(0);
  });
});

describe("カニバリ判定に渡す既存記事", () => {
  // rejected/retired は公開されないのでカニバリの相手にならない。
  // 判定中の記事自身も渡すと「自分の過去の下書きと共食い」と誤指摘される。
  it("rejected/retired と自分自身を除外する", async () => {
    const { store } = makeWorld({ lane: "A" });
    const kw = store.addKeyword({ keyword: "生きている記事", cluster: "renewal", article_type: "howto" });
    const mk = async (title: string, status: "published" | "rejected" | "retired") => {
      const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
      await store.updateArticle(a.id, { title, status });
      return a.id;
    };
    const liveId = await mk("公開済み", "published");
    await mk("却下", "rejected");
    await mk("廃棄", "retired");

    const all = await store.listArticleSummaries();
    const titles = all.map((s) => s.title);
    expect(titles).toContain("公開済み");
    expect(titles).not.toContain("却下");
    expect(titles).not.toContain("廃棄");

    const excluded = await store.listArticleSummaries(liveId);
    expect(excluded.map((s) => s.id)).not.toContain(liveId);
  });
});

describe("assetForJudge: P-04に渡す一次情報", () => {
  it("id/titleだけでなく本文と数値の根拠まで渡す", () => {
    const out = assetForJudge({
      id: "a1",
      title: "自社実測",
      content: "当社の実測では平均5分でした。",
      numeric_claims: [{ claim: "作業時間", value: "5", unit: "分", basis: "当社実測 n=13" }],
    } as unknown as PrimaryAssetRow);
    expect(out.content).toContain("平均5分");
    expect(out.numeric_claims[0]).toEqual({
      claim: "作業時間",
      value: "5",
      unit: "分",
      basis: "当社実測 n=13",
    });
  });

  it("numeric_claimsが無くても落ちない", () => {
    const out = assetForJudge({ id: "a2", title: "t", content: "c", numeric_claims: null } as unknown as PrimaryAssetRow);
    expect(out.numeric_claims).toEqual([]);
  });
});

describe("allocateAssets: 一次情報をどのセクションに入れるか", () => {
  const asset = (id: string) => ({ id, content: `${id}の本文`, numeric_claims: [] }) as unknown as PrimaryAssetRow;
  const mkOutline = (sections: { h2: string; uses: boolean }[], plan: { asset_id: string; section_index: number }[] = []) =>
    ({
      outline: sections.map((s) => ({ h2: s.h2, answer_first: "", h3: [], uses_primary_info: s.uses })),
      primary_info_plan: plan.map((p) => ({ ...p, usage: "" })),
    }) as unknown as P01OutlineT;

  it("本文セクションの過半に一次情報が行き渡る", () => {
    const outline = mkOutline([
      { h2: "A", uses: false },
      { h2: "B", uses: false },
      { h2: "C", uses: false },
      { h2: "D", uses: true },
      { h2: "よくあるご質問", uses: false },
    ]);
    const alloc = allocateAssets(outline, [asset("a1"), asset("a2")]);
    const filled = Object.entries(alloc).filter(([, v]) => v.length);
    // 本文は4セクション → 過半の2以上
    expect(filled.length).toBeGreaterThanOrEqual(2);
    // FAQ章 (index 4) には入れない
    expect(alloc[4]).toBeUndefined();
  });

  it("P-01が立てた primary_info_plan の割当を尊重する", () => {
    const outline = mkOutline(
      [
        { h2: "A", uses: false },
        { h2: "B", uses: false },
        { h2: "C", uses: false },
      ],
      [{ asset_id: "a2", section_index: 2 }],
    );
    const alloc = allocateAssets(outline, [asset("a1"), asset("a2")]);
    expect(alloc[2]!.map((a) => a.id)).toContain("a2");
  });

  it("使われない資産が残らない", () => {
    const outline = mkOutline([
      { h2: "A", uses: false },
      { h2: "B", uses: false },
      { h2: "C", uses: false },
      { h2: "D", uses: false },
    ]);
    const assets = [asset("a1"), asset("a2"), asset("a3")];
    const alloc = allocateAssets(outline, assets);
    const used = new Set(Object.values(alloc).flat().map((a) => a.id));
    expect([...used].sort()).toEqual(["a1", "a2", "a3"]);
  });

  it("資産が無ければ何も割り当てない", () => {
    const outline = mkOutline([{ h2: "A", uses: true }]);
    expect(allocateAssets(outline, [])).toEqual({});
  });
});

describe("orchestrator: hold でも再生成し、良い方を採る", () => {
  it("1周目hold・2周目approveなら2周目を採り、承認キューへ進む", async () => {
    let gateCalls = 0;
    const { kw, deps } = makeWorld({
      lane: "A",
      responses: {
        "P-04": () => (++gateCalls === 1 ? p04With("hold", ["独自性を足す"]) : p04With("approve")),
      },
    });
    const article = await generateArticle(kw.id, deps);
    expect(article.status).toBe("approval_pending");
    expect(gateCalls).toBeGreaterThanOrEqual(2); // holdでも再試行している
  });

  it("2周目が悪化したら1周目を採る (approveを失わない)", async () => {
    let gateCalls = 0;
    const { kw, deps } = makeWorld({
      lane: "A",
      responses: {
        // 1周目approve → 再試行は走らない。approveなら再生成しないことを固定する
        "P-04": () => {
          gateCalls++;
          return p04With("approve");
        },
      },
    });
    const article = await generateArticle(kw.id, deps);
    expect(article.status).toBe("approval_pending");
    expect(gateCalls).toBe(1); // approveなら余計な再生成でコストを使わない
  });
});

describe("orchestrator: 重複ハードゲート (同じ内容の記事を二度作らない)", () => {
  // 既存記事を1本seedする (タイトル・キーワードは引数)
  async function seedArticle(
    store: MemoryStore,
    e: { title: string; keyword: string },
  ): Promise<void> {
    const kw = store.addKeyword({ keyword: e.keyword, cluster: "renewal", status: "done" });
    const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
    await store.updateArticle(a.id, { title: e.title, status: "published" });
  }

  const passDup = (keyword: string) =>
    JSON.stringify({
      verdicts: [{ keyword, duplicate: false, conflicts_with: "", reason: "別の問い" }],
    });

  it("生成前: キーワードが既存とほぼ同一なら、トークンを使わず却下しキーワードをparkedに", async () => {
    const { store, llm, kw, deps } = makeWorld({
      lane: "A",
      keyword: "iOS NFC FeliCa 読み取り 遅い 原因",
    });
    // 実測0.750 (しきい値0.70超) の実例。字面のふるいで決まるのでP-DUPは呼ばれない
    await seedArticle(store, {
      title: "FeliCa読み取りが遅い原因と対策",
      keyword: "iOS FeliCa 読み取り 遅い 原因",
    });

    const article = await generateArticle(kw.id, deps);

    expect(article.status).toBe("rejected");
    expect(JSON.stringify(article.quality)).toContain("重複ゲート");
    expect((await store.getKeyword(kw.id))!.status).toBe("parked");
    // 生成系プロンプトが一切呼ばれていない = トークンを浪費していない
    expect(promptIds(llm)).not.toContain("P-01");
    expect(promptIds(llm)).not.toContain("P-02");
  });

  it("生成前: 字面が違っても意図照合 (P-DUP) が重複と言えば却下する", async () => {
    const keyword = "ホームページ リニューアル タイミング 見極め方";
    const { store, kw, deps } = makeWorld({
      lane: "A",
      keyword,
      responses: {
        "P-DUP": JSON.stringify({
          verdicts: [
            {
              keyword,
              duplicate: true,
              conflicts_with: "失敗しないホームページリニューアルの進め方",
              reason: "既存記事が同じ問いに正面から答えている",
            },
          ],
        }),
      },
    });
    await seedArticle(store, {
      title: "失敗しないホームページリニューアルの進め方",
      keyword: "ホームページ リニューアル 進め方 失敗",
    });

    const article = await generateArticle(kw.id, deps);

    expect(article.status).toBe("rejected");
    expect(JSON.stringify(article.quality)).toContain("検索意図");
    expect((await store.getKeyword(kw.id))!.status).toBe("parked");
  });

  it("全自動中に意図照合が失敗したらフェイルクローズド (生成せず、キーワードはqueuedのまま)", async () => {
    const { store, kw, deps, llm } = makeWorld({ lane: "A", keyword: "全然新しい話" });
    store.setConfig("full_auto_publish", true);
    // 既存記事がいる (=照合が必要) がP-DUP応答を用意しない=照合失敗
    await seedArticle(store, { title: "既存の何か", keyword: "既存 キーワード" });

    await expect(generateArticle(kw.id, deps)).rejects.toThrow(/重複判定/);
    // キーワードは消費されない。次のcron実行で自動的に再試行される
    expect((await store.getKeyword(kw.id))!.status).toBe("queued");
    expect(promptIds(llm)).not.toContain("P-01");
  });

  it("承認制 (既定) では意図照合が失敗しても生成を続行する (v3: 代表の承認が歯止め)", async () => {
    const { store, kw, deps } = makeWorld({ lane: "A", keyword: "全然新しい話" });
    await seedArticle(store, { title: "既存の何か", keyword: "既存 キーワード" });

    const article = await generateArticle(kw.id, deps);
    expect(article.status).toBe("approval_pending");
  });

  it("仕上げ: P-12のタイトルが既存記事とほぼ同一なら承認キューに乗せず却下する", async () => {
    const keyword = "ホームページ 刷新 費用 考え方";
    const { store, kw, deps } = makeWorld({
      lane: "A",
      keyword,
      responses: { "P-DUP": passDup(keyword) }, // 入口の意図照合は通す
    });
    // P-12フィクスチャの推奨タイトルと同一のタイトルを既存記事に持たせる
    await seedArticle(store, {
      title: "ホームページリニューアル費用の考え方",
      keyword: "既存 別トピック",
    });

    const article = await generateArticle(kw.id, deps);

    expect(article.status).toBe("rejected");
    expect(JSON.stringify(article.quality)).toContain("タイトルが既存");
    expect((await store.getKeyword(kw.id))!.status).toBe("parked");
    expect(store.queue).toHaveLength(0);
  });

  it("改修 (refit:) は入口ゲートの対象外 (既存記事と同じで正しい)", async () => {
    const { store, kw, deps, llm } = makeWorld({ lane: "A", keyword: "refit:existing-post" });
    store.setConfig("full_auto_publish", true); // failClosed経路に入らないことも確認する
    await seedArticle(store, { title: "既存の何か", keyword: "既存 キーワード" });

    // P-DUP応答なしでも例外にならない = ゲート自体を通っていない
    const article = await generateArticle(kw.id, deps);
    expect(article.status).toBe("approval_pending");
    expect(promptIds(llm)).not.toContain("P-DUP");
  });
});

describe("orchestrator: クラウド下書き (サブスク側の執筆) の取り込み", () => {
  // フィクスチャのP-01出力は有効なP01Outline
  const validOutline = () => JSON.parse(fx("P-01.json"));
  const draftBody = [
    "## ホームページリニューアルの費用相場は？",
    "結論、費用は要件と規模で決まります。" + "詳細な解説です。".repeat(60),
    "## よくあるご質問",
    "質問と回答をまとめます。" + "回答の本文です。".repeat(30),
  ].join("\n\n");

  it("未消費の下書きがあればP-01/P-02を省略し、ゲートと仕上げは従来どおり通す", async () => {
    const { store, llm, kw, deps } = makeWorld({ lane: "A" });
    const draft = store.addCloudDraft({
      keyword_id: kw.id,
      outline: validOutline(),
      body_mdx: draftBody,
    });

    const article = await generateArticle(kw.id, deps);

    expect(article.status).toBe("approval_pending");
    expect(article.body_mdx).toContain("ホームページリニューアルの費用相場");
    // 執筆系は呼ばれない (=コスト削減の本体)
    expect(promptIds(llm)).not.toContain("P-01");
    expect(promptIds(llm)).not.toContain("P-02");
    // 品質ゲートと仕上げは従来どおり
    expect(promptIds(llm)).toContain("P-04");
    expect(promptIds(llm)).toContain("P-12");
    expect(promptIds(llm)).toContain("P-11");
    // 消費済みの印 + どの記事が使ったか
    expect(draft.consumed_at).toBeTruthy();
    expect(draft.consumed_by_article_id).toBe(article.id);
    expect((await store.getKeyword(kw.id))!.status).toBe("done");
  });

  it("outlineが壊れている下書きは消費だけしてAPI経路にフォールバック", async () => {
    const { store, llm, kw, deps } = makeWorld({ lane: "A" });
    const draft = store.addCloudDraft({
      keyword_id: kw.id,
      outline: { broken: true },
      body_mdx: draftBody,
    });

    const article = await generateArticle(kw.id, deps);

    expect(article.status).toBe("approval_pending");
    // フォールバックで従来のAPI執筆が走る
    expect(promptIds(llm)).toContain("P-01");
    expect(promptIds(llm)).toContain("P-02");
    // 壊れた下書きを翌日以降も拾い続けない
    expect(draft.consumed_at).toBeTruthy();
    expect(draft.consumed_by_article_id).toBeNull();
  });

  it("本文が短すぎる下書きもフォールバック (スカスカの下書きを公開系に乗せない)", async () => {
    const { store, llm, kw, deps } = makeWorld({ lane: "A" });
    store.addCloudDraft({
      keyword_id: kw.id,
      outline: validOutline(),
      body_mdx: "## 短い\n中身がない",
    });
    const article = await generateArticle(kw.id, deps);
    expect(article.status).toBe("approval_pending");
    expect(promptIds(llm)).toContain("P-02");
  });

  it("消費済みの下書きは使わない (ストアが未消費のみ返す)", async () => {
    const { store, kw } = makeWorld({ lane: "A" });
    const d = store.addCloudDraft({ keyword_id: kw.id, outline: validOutline(), body_mdx: draftBody });
    await store.markCloudDraftConsumed(d.id, null);
    expect(await store.getLatestCloudDraft(kw.id)).toBeNull();
  });

  it("下書きが無ければ完全に従来どおり (回帰防止)", async () => {
    const { llm, kw, deps } = makeWorld({ lane: "A" });
    const article = await generateArticle(kw.id, deps);
    expect(article.status).toBe("approval_pending");
    expect(promptIds(llm)).toContain("P-01");
    expect(promptIds(llm)).toContain("P-02");
  });
});
