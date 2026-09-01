import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROMPT_SCHEMAS } from "./schemas.js";

const FIXTURES = join(__dirname, "..", "fixtures", "llm");

// promptId → 欠損させると必ず失敗する必須キー (契約テスト)
const REQUIRED_KEY: Record<string, string> = {
  "P-01": "outline",
  "P-04": "human_review_notes",
  "P-05a": "claims",
  "P-05b": "verdicts",
  "P-06": "changes",
  "P-07": "sanitized_text",
  "P-08": "article_seeds",
  "P-09": "aggregates",
  "P-10": "recommended",
  "P-11": "outbound",
  "P-12": "recommended",
  "P-13a": "diagnosis",
  "P-14": "importance",
  "P-15": "impact",
  "P-16": "decisions",
  "P-17": "patch",
  "P-18a": "asset_type",
  "P-18b": "reviews",
};

describe("schemas: プロンプト契約テスト (SPEC M1)", () => {
  for (const [id, schema] of Object.entries(PROMPT_SCHEMAS)) {
    const fixtureName = id === "P-06" ? null : `${id}.json`;
    if (!fixtureName) continue; // P-06はMDX+CHANGELOG形式 (llm.test.tsで検証)

    it(`${id}: 正常系フィクスチャがパースできる`, () => {
      const data = JSON.parse(readFileSync(join(FIXTURES, fixtureName), "utf8"));
      expect(() => schema.parse(data)).not.toThrow();
    });

    it(`${id}: 必須フィールド欠損で失敗する`, () => {
      const data = JSON.parse(readFileSync(join(FIXTURES, fixtureName), "utf8"));
      delete data[REQUIRED_KEY[id]!];
      expect(() => schema.parse(data)).toThrow();
    });
  }

  it("P-01: approval_required=false はスキーマ違反 (v3: 全記事承認制)", () => {
    const data = JSON.parse(readFileSync(join(FIXTURES, "P-01.json"), "utf8"));
    data.approval_required = false;
    expect(() => PROMPT_SCHEMAS["P-01"].parse(data)).toThrow();
  });

  it("P-04: lane_b_verdict が来ても無視され human_review_notes が必須 (v3)", () => {
    const data = JSON.parse(readFileSync(join(FIXTURES, "P-04.json"), "utf8"));
    data.lane_b_verdict = { eligible: true, failed_conditions: [] };
    const parsed = PROMPT_SCHEMAS["P-04"].parse(data);
    expect(parsed.human_review_notes.fact_claims.length).toBeGreaterThan(0);
    expect("lane_b_verdict" in parsed).toBe(false);
  });

  it("P-17: tier2とreject形式もパースできる (union)", () => {
    const tier2 = {
      tier_confirmed: 2,
      implementation_plan: ["step1"],
      files_to_change: ["a.ts"],
      tests: [{ name: "t", asserts: "x" }],
      pr_title: "title",
      pr_body: "body",
      canary_plan: "plan",
      rollback_condition: "cond",
    };
    const reject = { tier_confirmed: 0, rejected: true, reason: "保護ファイル対象" };
    expect(() => PROMPT_SCHEMAS["P-17"].parse(tier2)).not.toThrow();
    expect(() => PROMPT_SCHEMAS["P-17"].parse(reject)).not.toThrow();
  });
});
