// 月次戦略エージェント P-16 (v3 Sprint 2)。
// GSC/GA4/公開実績/トリップワイヤを集計して P-16 に渡し、来月の方針を得る。
// 「何が効いたか / 何を書くべきか / 優先度」をデータから決める自律ループの頭脳。
//
// v3の権限境界: decisions(優先度・リライト指名・配分±5・tier1)は自律決定可、
// proposals(増速・新クラスタ・削除・tier2/3)は人間承認必須。
// ただし初版は安全側に倒し、自動適用は行わず全て管理画面で代表に提示する
// (キーワード優先度の自動反映は将来オプション)。公開判断は常に別途承認。
import { z } from "zod";
import { callAndParse, fillTemplate, getPrompt, type LLMClient } from "@kurimikan/shared";
import type { ArticleRow, Store } from "../db/types.js";

const DAY_MS = 86400_000;
const iso = (d: Date) => d.toISOString();
const dateStr = (d: Date) => d.toISOString().slice(0, 10);

export const P16Report = z.object({
  summary_5min: z.array(z.string()),
  what_worked: z.array(z.object({ finding: z.string(), evidence: z.string(), action: z.string() })),
  what_failed: z.array(z.object({ finding: z.string(), evidence: z.string(), action: z.string() })),
  decisions: z.array(z.object({ type: z.string(), detail: z.string(), rationale: z.string() })),
  proposals: z.array(
    z.object({
      type: z.string(),
      detail: z.string(),
      rationale: z.string(),
      gate_check: z.string().optional(),
      risk_if_rejected: z.string().optional(),
    }),
  ),
  next_month_targets: z.object({
    publish_count: z.number(),
    lane_b_ratio: z.number(),
    rewrite_count: z.number(),
    focus_cluster: z.string(),
  }),
  uncertainty_flags: z.array(z.string()),
});
export type P16ReportT = z.infer<typeof P16Report>;

// 却下記事のP-04判定を集計。どの軸が慢性的に低いか (commodity/uniqueness等) と、
// 頻出の修正指示テーマを出す。P-16が「プロンプト是正(tier1)か評価基準見直し(tier2)か」を判断する材料。
function analyzeRejects(rejected: ArticleRow[]): unknown {
  if (rejected.length === 0) return { count: 0 };
  const dims = ["eeat", "intent", "notation", "coherence", "structure", "uniqueness"] as const;
  const sums: Record<string, { total: number; n: number }> = {};
  let commoditySum = 0;
  let commodityN = 0;
  const fixCounts = new Map<string, number>();
  for (const a of rejected) {
    const q = (a.quality ?? {}) as {
      scores?: Record<string, number>;
      commodity_score?: number;
      fix_instructions?: string[];
    };
    for (const d of dims) {
      const v = q.scores?.[d];
      if (typeof v === "number") {
        sums[d] = sums[d] ?? { total: 0, n: 0 };
        sums[d]!.total += v;
        sums[d]!.n += 1;
      }
    }
    if (typeof a.commodity_score === "number") {
      commoditySum += a.commodity_score;
      commodityN += 1;
    }
    // 修正指示の冒頭カテゴリ (【...】) を集計
    for (const fx of q.fix_instructions ?? []) {
      const tag = /^【([^】]+)】/.exec(fx)?.[1]?.replace(/[・\s].*/, "") ?? fx.slice(0, 12);
      fixCounts.set(tag, (fixCounts.get(tag) ?? 0) + 1);
    }
  }
  const avgByDim = Object.fromEntries(
    Object.entries(sums).map(([k, v]) => [k, Math.round((v.total / v.n) * 10) / 10]),
  );
  const topFixes = [...fixCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([theme, n]) => ({ theme, count: n }));
  return {
    count: rejected.length,
    avg_scores_of_rejects: avgByDim,
    avg_commodity: commodityN ? Math.round((commoditySum / commodityN) * 10) / 10 : null,
    top_fix_themes: topFixes,
  };
}

export interface StrategyDeps {
  store: Store;
  llm: LLMClient;
  suitePath: string;
  now?: () => Date;
}

// P-16に渡す入力を集計する。計測が薄いうちは data_note で不足を明示する。
export async function gatherStrategyInputs(store: Store, now: Date) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const since = dateStr(monthStart);

  // GSC月次: 記事別に表示/クリック/順位を集計
  const gscRows = await store.listGscMetricsSince(since);
  const byArticle = new Map<string, { imp: number; clk: number; posSum: number; n: number }>();
  for (const r of gscRows) {
    const k = r.article_id ?? "site";
    const a = byArticle.get(k) ?? { imp: 0, clk: 0, posSum: 0, n: 0 };
    a.imp += r.impressions ?? 0;
    a.clk += r.clicks ?? 0;
    if (r.position != null) {
      a.posSum += r.position;
      a.n += 1;
    }
    byArticle.set(k, a);
  }
  const gsc_monthly = [...byArticle.entries()]
    .map(([article_id, a]) => ({
      article_id,
      impressions: a.imp,
      clicks: a.clk,
      ctr: a.imp ? Math.round((a.clk / a.imp) * 1000) / 10 : 0,
      avg_position: a.n ? Math.round((a.posSum / a.n) * 10) / 10 : null,
    }))
    .sort((x, y) => y.impressions - x.impressions);

  // インデックス率 (直近28日公開のnew記事)
  const idx = await store.latestIndexStatusForPublishedSince(
    iso(new Date(now.getTime() - 28 * DAY_MS)),
    "new",
  );
  const known = idx.filter((s) => s.index_status && s.index_status !== "unknown");
  const indexed = known.filter((s) => s.index_status === "indexed").length;

  // GA4 / AI経由CV
  const aiBySource = await store.sumAiCvEventsBySource();
  const aiTotal = await store.sumAiCvEvents();

  // 公開実績
  const publishedNew = await store.countPublishedSince(iso(monthStart), "new");
  const publishedRev = await store.countPublishedSince(iso(monthStart), "revision");
  const rejectedArticles = await store.listArticlesByStatus("rejected");
  const approvalPending = (await store.listArticlesByStatus("approval_pending")).length;

  // 却下の分析: どの評価軸が低いか + 頻出の修正指示。P-16がtier1/tier2の切り分けに使う。
  const rejectAnalysis = analyzeRejects(rejectedArticles);

  // SEOウォッチャー (P-14) が蓄積した重要度>=7の直近30日エントリ
  const seoDigest = await store.listSeoKnowledgeSince(
    iso(new Date(now.getTime() - 30 * DAY_MS)),
    7,
  );

  const allocation = (await store.getConfig<Record<string, number>>("cluster_allocation")) ?? {};
  const velocityStage = (await store.getConfig<number>("velocity_stage")) ?? 0;
  const tripwires = (await store.listAllTripwires()).filter(
    (t) => t.created_at && t.created_at >= iso(monthStart),
  );

  return {
    period: `${since}..${dateStr(now)}`,
    gsc_monthly: {
      articles: gsc_monthly.slice(0, 30),
      index_rate: known.length ? Math.round((indexed / known.length) * 100) / 100 : null,
      index_sample: known.length,
    },
    ga4_monthly: { ai_cv_total: aiTotal, by_source: aiBySource },
    seo_knowledge_digest: seoDigest.length
      ? JSON.stringify(
          seoDigest.map((k) => ({
            source_type: k.source_type,
            change_type: k.change_type,
            importance: k.importance,
            affected_area: k.affected_area,
            summary: k.summary_one_line,
          })),
        )
      : "(重要度7以上のSEO動向は直近なし)",
    current_allocation: { allocation, velocity_stage: velocityStage },
    publish_stats: {
      published_new: publishedNew,
      published_revision: publishedRev,
      rejected_total: rejectedArticles.length,
      approval_pending: approvalPending,
    },
    reject_analysis: rejectAnalysis,
    tripwire_log: tripwires.map((t) => ({ type: t.event_type, severity: t.severity })),
    data_note:
      gscRows.length < 30 || aiTotal < 5
        ? "計測データが少ない立ち上げ期。断定を避け、uncertainty_flagsを積極的に使うこと。"
        : "",
  };
}

export interface StrategyResult {
  month: string;
  report: P16ReportT;
  proposalsPending: number;
}

export async function runMonthlyStrategy(deps: StrategyDeps): Promise<StrategyResult> {
  const now = deps.now?.() ?? new Date();
  const inputs = await gatherStrategyInputs(deps.store, now);

  const prompt = await getPrompt("P-16", deps.store.getPromptFromDb.bind(deps.store), deps.suitePath);
  const report = await callAndParse(
    deps.llm,
    {
      promptId: "P-16",
      user: fillTemplate(prompt, {
        gsc_monthly: JSON.stringify(inputs.gsc_monthly),
        ga4_monthly: JSON.stringify(inputs.ga4_monthly),
        seo_knowledge_digest: inputs.seo_knowledge_digest,
        current_allocation: JSON.stringify(inputs.current_allocation),
        // reject_analysisはpublish_statsに同梱 (P-16の保護プロンプトにplaceholderを増やさない)。
        // これで「却下13本」の内訳 (どの軸が低い/頻出修正) をP-16が読み、tier1/tier2を切り分けられる。
        publish_stats: JSON.stringify({
          ...inputs.publish_stats,
          reject_analysis: inputs.reject_analysis,
        }),
        tripwire_log: JSON.stringify(inputs.tripwire_log),
      }),
      job: "strategy",
    },
    P16Report,
  );

  // 初版は自動適用しない。全てを管理画面で代表に提示する (公開判断と同じく人間が最終)。
  const month = dateStr(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  await deps.store.saveStrategyReport(month, report, report.proposals.length);
  return { month, report, proposalsPending: report.proposals.length };
}
