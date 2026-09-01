import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXPECTED_PROMPT_IDS, parseSuiteFile } from "@kurimikan/shared";

const SUITE_PATH = join(__dirname, "..", "..", "kurimikan_prompt_suite_v1.md");
const prompts = parseSuiteFile(SUITE_PATH);
const byId = new Map(prompts.map((p) => [p.id, p.body]));

describe("parse_suite: プロンプト集v1のパース", () => {
  it("期待される28本のプロンプトを全て抽出する", () => {
    expect(prompts.map((p) => p.id).sort()).toEqual([...EXPECTED_PROMPT_IDS].sort());
  });

  it("親見出し (P-03, P-05, P-13, P-18) は本文を持たないため含まれない", () => {
    for (const parent of ["P-03", "P-05", "P-13", "P-18"]) {
      expect(byId.has(parent)).toBe(false);
    }
  });

  it("P-00 は会社情報と表記規則を含む", () => {
    const p00 = byId.get("P-00")!;
    expect(p00).toContain("<company>");
    expect(p00).toContain("カタカナ語末尾の長音は省略する");
    expect(p00).toContain("</notation>");
  });

  it("P-02 はセクション生成の入力変数を含む", () => {
    expect(byId.get("P-02")).toContain("{previous_sections_summary}");
  });

  it("P-17 はガードレール (不可侵ファイル) を含む", () => {
    expect(byId.get("P-17")).toContain("不可侵ファイル");
  });
});
