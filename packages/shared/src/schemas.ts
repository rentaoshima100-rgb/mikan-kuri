// プロンプト出力のzodスキーマ (SPEC M1)。v3差分適用済み:
//   - P01Outline: approval_required は literal true (全記事承認制をスキーマで強制)
//   - P04Verdict: lane_b_verdict は存在しない。human_review_notes (承認者向けトップ3) を必須とする
import { z } from "zod";

const sensitivity = z.enum(["low", "mid", "high"]);

export const P01Outline = z.object({
  search_intent_analysis: z.object({
    type: z.enum(["Know", "Do", "Buy", "Go"]),
    reader_wants: z.array(z.string()).min(1),
    reader_level: z.string(),
  }),
  title_draft: z.string(),
  outline: z
    .array(
      z.object({
        h2: z.string(),
        answer_first: z.string(),
        h3: z.array(z.string()),
        uses_primary_info: z.boolean(),
      }),
    )
    .min(1),
  primary_info_plan: z.array(
    z.object({
      asset_id: z.string(),
      section_index: z.number(),
      usage: z.string(),
    }),
  ),
  faq_candidates: z.array(z.string()),
  cannibalization_risk: z.array(
    z.object({ article_id: z.string(), reason: z.string(), mitigation: z.string() }),
  ),
  lane_b_eligible: z.boolean(),
  lane_b_reason: z.string().optional(),
  approval_required: z.literal(true),
  estimated_word_count: z.number(),
});
export type P01OutlineT = z.infer<typeof P01Outline>;

export const P04Verdict = z.object({
  scores: z.object({
    intent: z.number(),
    uniqueness: z.number(),
    eeat: z.number(),
    structure: z.number(),
    notation: z.number(),
    coherence: z.number(),
    total: z.number(),
  }),
  score_rationale: z.object({
    intent: z.string(),
    uniqueness: z.string(),
    eeat: z.string(),
    structure: z.string(),
    notation: z.string(),
    coherence: z.string(),
  }),
  hallucination_flags: z.array(
    z.object({
      claim: z.string(),
      type: z.string(),
      source_found: z.boolean(),
      action: z.enum(["remove", "verify", "keep_with_source"]),
    }),
  ),
  commodity_score: z.number(),
  commodity_rationale: z.string(),
  cannibalization: z.array(z.object({ article_id: z.string(), reason: z.string() })),
  human_review_notes: z.object({
    fact_claims: z.array(z.string()),
    uniqueness_basis: z.string(),
    risk_areas: z.array(z.string()),
  }),
  verdict: z.enum(["approve", "hold", "reject"]),
  fix_instructions: z.array(z.string()),
});
export type P04VerdictT = z.infer<typeof P04Verdict>;

export const P05Claims = z.object({
  claims: z.array(
    z.object({
      id: z.number(),
      claim: z.string(),
      type: z.enum(["numeric", "factual", "institutional"]),
      context: z.string(),
      source_in_article: z.string().nullable(),
    }),
  ),
});
export type P05ClaimsT = z.infer<typeof P05Claims>;

export const P05Verdicts = z.object({
  verdicts: z.array(
    z.object({
      id: z.number(),
      verdict: z.enum(["true", "false", "unsure"]),
      reason: z.string(),
    }),
  ),
});
export type P05VerdictsT = z.infer<typeof P05Verdicts>;

export const P06Changelog = z.object({
  changes: z.array(
    z.object({
      original: z.string(),
      action: z.enum(["deleted", "rewritten", "kept_with_source"]),
      result: z.string().nullable(),
    }),
  ),
});
export type P06ChangelogT = z.infer<typeof P06Changelog>;

export const P07Sanitized = z.object({
  sanitized_text: z.string(),
  additional_redactions: z.array(
    z.object({ original: z.string(), generalized: z.string(), reason: z.string() }),
  ),
  risk_notes: z.array(
    z.object({ text: z.string(), level: sensitivity, recommendation: z.string() }),
  ),
  human_review_required: z.boolean(),
});
export type P07SanitizedT = z.infer<typeof P07Sanitized>;

export const P08Seeds = z.object({
  article_seeds: z.array(
    z.object({
      seed_title: z.string(),
      angle: z.string(),
      cluster: z.string(),
      target_keyword_hint: z.string(),
      source_excerpt: z.string(),
      sensitivity,
    }),
  ),
  primary_info_candidates: z.array(
    z.object({
      content: z.string(),
      info_type: z.string(),
      applicable_clusters: z.array(z.string()),
      sensitivity,
    }),
  ),
  queue_boosts: z.array(z.object({ keyword: z.string(), reason: z.string() })),
});
export type P08SeedsT = z.infer<typeof P08Seeds>;

export const P09MarketReport = z.object({
  period: z.string(),
  total_n: z.number(),
  aggregates: z.object({
    budget_distribution: z.array(
      z.object({ band: z.string(), count: z.number(), pct: z.number() }),
    ),
    budget_mean: z.number(),
    budget_median: z.number(),
    top_requirements: z.array(
      z.object({ tag: z.string(), count: z.number(), pct: z.number() }),
    ),
    loss_reasons: z.array(
      z.object({ tag: z.string(), count: z.number(), pct: z.number() }),
    ),
    // 用途の区分 (自家用 / 贈答 / 業務用)。n<5 のセルは P-09 側で除外される
    by_segment: z.array(
      z.object({ segment: z.string(), n: z.number(), budget_median: z.number() }),
    ),
  }),
  vs_previous: z.array(
    z.object({ metric: z.string(), change: z.string(), insight: z.string() }),
  ),
  numeric_claims: z.array(
    z.object({
      claim: z.string(),
      numerator: z.number(),
      denominator: z.number(),
      verified: z.boolean(),
    }),
  ),
  suggested_headlines: z.array(z.string()),
  excluded_cells: z.array(z.object({ cell: z.string(), reason: z.string() })),
});
export type P09MarketReportT = z.infer<typeof P09MarketReport>;

export const P10PublicData = z.object({
  angles: z.array(
    z.object({ title: z.string(), finding: z.string(), surprise_level: z.number() }),
  ),
  recommended: z.object({
    angle_title: z.string(),
    narrative_outline: z.array(z.string()),
    key_findings: z.array(z.string()),
    chart_specs: z.array(
      z.object({
        type: z.enum(["bar", "line", "pie"]),
        title: z.string(),
        x_axis: z.string(),
        series: z.array(z.object({ name: z.string(), values: z.array(z.number()) })),
        caption: z.string(),
      }),
    ),
  }),
  citation: z.string(),
  reference_date: z.string(),
  numeric_claims: z.array(
    z.object({ claim: z.string(), source_cell: z.string(), verified: z.boolean() }),
  ),
});
export type P10PublicDataT = z.infer<typeof P10PublicData>;

export const P11Links = z.object({
  outbound: z.array(
    z.object({ target: z.string(), anchor: z.string(), insert_hint: z.string() }),
  ),
  inbound: z.array(
    z.object({ from_article_id: z.string(), anchor: z.string(), insert_hint: z.string() }),
  ),
  warnings: z.array(
    z.object({ article_id: z.string(), issue: z.string(), recommendation: z.string() }),
  ),
});
export type P11LinksT = z.infer<typeof P11Links>;

// 公開URLに使うslug。英小文字・数字・ハイフンのみ、2語以上、60文字以内。
// 先頭末尾のハイフンと連続ハイフンは許可しない
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
export const SlugString = z.string().regex(SLUG_PATTERN).max(60);

export const P12TitleMeta = z.object({
  titles: z.array(z.object({ text: z.string(), length: z.number(), aim: z.string() })),
  meta_descriptions: z.array(
    z.object({ text: z.string(), length: z.number(), aim: z.string() }),
  ),
  // slugsはv3パッチで追加。旧形式の応答でも落とさないよう任意にし、
  // 欠落時はオーケストレータ側でフォールバックする
  slugs: z.array(z.object({ text: z.string(), aim: z.string() })).optional(),
  recommended: z.object({
    title_index: z.number(),
    meta_index: z.number(),
    slug_index: z.number().optional(),
    reason: z.string(),
  }),
});
export type P12TitleMetaT = z.infer<typeof P12TitleMeta>;

export const P13Plan = z.object({
  diagnosis: z.object({
    primary_issue: z.enum(["ctr", "ranking", "intent_mismatch"]),
    evidence: z.string(),
  }),
  add_sections: z.array(
    z.object({ position: z.string(), heading: z.string(), reason: z.string() }),
  ),
  add_faq: z.array(z.object({ q: z.string(), source_query: z.string() })),
  inject_primary_info: z.array(
    z.object({ asset_id: z.string(), section: z.string(), usage: z.string() }),
  ),
  remove: z.array(z.object({ target: z.string(), reason: z.string() })),
  title_meta_update: z.object({ needed: z.boolean(), direction: z.string() }),
  expected_impact: z.string(),
});
export type P13PlanT = z.infer<typeof P13Plan>;

export const P14Classify = z.object({
  source_type: z.string(),
  change_type: z.string(),
  confidence: z.enum(["low", "mid", "high"]),
  importance: z.number(),
  affected_area: z.array(z.string()),
  summary_one_line: z.string(),
  corroboration_needed: z.boolean(),
});
export type P14ClassifyT = z.infer<typeof P14Classify>;

export const P15Impact = z.object({
  impact: z.enum(["none", "minor", "major"]),
  proposed_changes: z.array(
    z.object({
      tier: z.number(),
      target: z.string(),
      change: z.string(),
      rationale: z.string(),
      urgency: z.enum(["urgent", "normal"]),
    }),
  ),
  monitoring_suggestion: z.string().optional(),
});
export type P15ImpactT = z.infer<typeof P15Impact>;

export const P16Report = z.object({
  summary_5min: z.array(z.string()),
  what_worked: z.array(
    z.object({ finding: z.string(), evidence: z.string(), action: z.string() }),
  ),
  what_failed: z.array(
    z.object({ finding: z.string(), evidence: z.string(), action: z.string() }),
  ),
  decisions: z.array(
    z.object({
      type: z.enum(["priority", "rewrite", "allocation", "tier1"]),
      detail: z.string(),
      rationale: z.string(),
    }),
  ),
  proposals: z.array(
    z.object({
      type: z.enum(["velocity", "new_cluster", "delete", "tier2", "tier3"]),
      detail: z.string(),
      rationale: z.string(),
      gate_check: z.string().optional(),
      risk_if_rejected: z.string(),
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

export const P17Tier1 = z.object({
  tier_confirmed: z.literal(1),
  patch: z.array(z.object({ target: z.string(), before: z.string(), after: z.string() })),
  canary_plan: z.string(),
  rollback_condition: z.string(),
});
export const P17Tier2 = z.object({
  tier_confirmed: z.literal(2),
  implementation_plan: z.array(z.string()),
  files_to_change: z.array(z.string()),
  tests: z.array(z.object({ name: z.string(), asserts: z.string() })),
  pr_title: z.string(),
  pr_body: z.string(),
  canary_plan: z.string(),
  rollback_condition: z.string(),
});
export const P17Reject = z.object({
  tier_confirmed: z.literal(0),
  rejected: z.literal(true),
  reason: z.string(),
});
export const P17Change = z.union([P17Tier1, P17Tier2, P17Reject]);
export type P17ChangeT = z.infer<typeof P17Change>;

export const P18Asset = z.object({
  asset_type: z.enum([
    "case_study",
    "benchmark",
    "original_survey",
    "public_data_analysis",
    "ops_data",
    "exec_opinion",
  ]),
  title: z.string(),
  description: z.string(),
  content: z.string(),
  numeric_claims: z.array(
    z.object({
      claim: z.string(),
      source: z.string(),
      verified: z.boolean(),
      verified_date: z.string(),
    }),
  ),
  applicable_clusters: z.array(z.string()),
  valid_until: z.string().nullable(),
  annual_review: z.boolean(),
  sensitivity,
});
export type P18AssetT = z.infer<typeof P18Asset>;

export const P18Reviews = z.object({
  reviews: z.array(
    z.object({
      asset_id: z.string(),
      action: z.enum(["refresh", "keep", "retire"]),
      instruction: z.string().optional(),
      reason: z.string(),
    }),
  ),
});
export type P18ReviewsT = z.infer<typeof P18Reviews>;

// promptId → JSON出力スキーマ (JSON出力を持つプロンプトのみ。P-02/P-03系はMDX/挙動定義)
export const PROMPT_SCHEMAS = {
  "P-01": P01Outline,
  "P-04": P04Verdict,
  "P-05a": P05Claims,
  "P-05b": P05Verdicts,
  "P-06": P06Changelog,
  "P-07": P07Sanitized,
  "P-08": P08Seeds,
  "P-09": P09MarketReport,
  "P-10": P10PublicData,
  "P-11": P11Links,
  "P-12": P12TitleMeta,
  "P-13a": P13Plan,
  "P-14": P14Classify,
  "P-15": P15Impact,
  "P-16": P16Report,
  "P-17": P17Change,
  "P-18a": P18Asset,
  "P-18b": P18Reviews,
} as const;
