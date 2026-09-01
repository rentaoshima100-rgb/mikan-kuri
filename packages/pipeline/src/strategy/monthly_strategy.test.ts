import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { FixtureLLMClient } from "@kurimikan/shared";
import { MemoryStore } from "../db/memory.js";
import { gatherStrategyInputs, runMonthlyStrategy } from "./monthly_strategy.js";

const SUITE = join(__dirname, "..", "..", "..", "..", "kurimikan_prompt_suite_v1.md");
const NOW = new Date("2026-07-29T00:00:00.000Z");

const p16Output = JSON.stringify({
  summary_5min: ["立ち上げ期。データ不足のため断定は保留。"],
  what_worked: [],
  what_failed: [],
  decisions: [{ type: "priority", detail: "リニューアル系の優先度を上げる", rationale: "配分方針に沿う" }],
  proposals: [
    {
      type: "velocity",
      detail: "週2→3への増速",
      rationale: "インデックス率良好",
      gate_check: "3条件未充足 (データ不足)",
      risk_if_rejected: "なし",
    },
  ],
  next_month_targets: { publish_count: 8, lane_b_ratio: 0.3, rewrite_count: 2, focus_cluster: "renewal" },
  uncertainty_flags: ["GSCデータが1週間分のみ"],
});

function makeDeps() {
  const store = new MemoryStore();
  store.setConfig("cluster_allocation", { renewal: 52, production: 20, system_dev: 15, ai_llmo: 13 });
  store.setConfig("velocity_stage", 0);
  const llm = new FixtureLLMClient({
    fixturesDir: join(__dirname, "..", "..", "..", "shared", "fixtures", "llm"),
    responses: { "P-16": p16Output },
  });
  return { store, deps: { store, llm, suitePath: SUITE, now: () => NOW } };
}

describe("gatherStrategyInputs: 計測の月次集計", () => {
  it("GSC・公開実績・配分・トリップワイヤを集約し、薄いデータはdata_noteで明示", async () => {
    const { store } = makeDeps();
    await store.upsertGscMetrics([
      { article_id: "a1", date: "2026-07-26", impressions: 12, clicks: 1, position: 5.8 },
      { article_id: "a1", date: "2026-07-27", impressions: 8, clicks: 0, position: 6.2 },
    ]);
    const inp = await gatherStrategyInputs(store, NOW);

    expect(inp.gsc_monthly.articles[0]!.article_id).toBe("a1");
    expect(inp.gsc_monthly.articles[0]!.impressions).toBe(20);
    expect(inp.current_allocation.allocation.renewal).toBe(52);
    expect(inp.data_note).toContain("立ち上げ期"); // データ薄いので注意喚起
  });

  it("却下記事を分析し、低い評価軸と頻出修正テーマを出す (P-16のtier1/tier2判断材料)", async () => {
    const { store } = makeDeps();
    const kw = store.addKeyword({ keyword: "k" });
    for (let i = 0; i < 2; i++) {
      const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
      await store.updateArticle(a.id, {
        status: "rejected",
        commodity_score: 75,
        quality: {
          scores: { uniqueness: 10, coherence: 6, eeat: 8, intent: 18, notation: 7, structure: 11 },
          fix_instructions: ["【最優先・独自性強化】一次情報を足す", "【構造問題】重複を消す"],
        },
      });
    }
    const inp = await gatherStrategyInputs(store, NOW);
    const ra = inp.reject_analysis as {
      count: number;
      avg_scores_of_rejects: Record<string, number>;
      avg_commodity: number;
      top_fix_themes: { theme: string; count: number }[];
    };
    expect(ra.count).toBe(2);
    expect(ra.avg_scores_of_rejects.uniqueness).toBe(10); // 独自性が慢性的に低いと分かる
    expect(ra.avg_commodity).toBe(75);
    expect(ra.top_fix_themes.length).toBeGreaterThan(0);
  });
});

describe("runMonthlyStrategy: P-16実行とレポート保存", () => {
  it("レポートを保存し、proposalsは自動適用せず提示する (人間承認)", async () => {
    const { store, deps } = makeDeps();
    const r = await runMonthlyStrategy(deps);

    expect(r.report.summary_5min.length).toBeGreaterThan(0);
    expect(r.proposalsPending).toBe(1);
    // strategy_reportsに保存され、代表が見られる
    const saved = await store.getLatestStrategyReport();
    expect(saved).toBeTruthy();
    expect(saved!.proposals_pending).toBe(1);
    // 自律決定は初版では自動適用しない (velocity_stageもallocationも変わらない)
    expect(await store.getConfig("velocity_stage")).toBe(0);
    expect(saved!.decisions_applied).toBe(false);
  });
});
