import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARTICLE_TYPE_ADDON, fillTemplate, getPrompt, loadSuitePrompts } from "./prompts.js";

const SUITE = join(__dirname, "..", "..", "..", "kurimikan_prompt_suite_v1.md");

describe("prompts: ローダとフォールバック (SPEC M1)", () => {
  it("suiteフォールバックはv3パッチ適用済み", () => {
    const prompts = loadSuitePrompts(SUITE);
    expect(prompts.get("P-01")).toContain('"approval_required": true');
    expect(prompts.get("P-04")).not.toContain("lane_b_verdict");
  });

  it("DBにあればDB優先、なければsuiteへフォールバック", async () => {
    const dbGet = async (id: string) => (id === "P-12" ? "DB版プロンプト" : null);
    expect(await getPrompt("P-12", dbGet, SUITE)).toBe("DB版プロンプト");
    expect(await getPrompt("P-11", dbGet, SUITE)).toContain("内部リンクを設計");
  });

  it("未知のプロンプトIDは例外", async () => {
    await expect(getPrompt("P-99", null, SUITE)).rejects.toThrow(/見つかりません/);
  });
});

describe("prompts: fillTemplate", () => {
  it("指定した変数のみ置換し、JSON例の{...}は壊さない", () => {
    const body = '対象: {keyword}\n出力: {"lane_b_eligible": true, "x": "{keyword}"}';
    const filled = fillTemplate(body, { keyword: "サイトリニューアル" });
    expect(filled).toContain("対象: サイトリニューアル");
    expect(filled).toContain('"x": "サイトリニューアル"');
    expect(filled).toContain('"lane_b_eligible": true');
  });
});

describe("prompts: 記事タイプ→P-03アドオン", () => {
  it("7タイプ全てにアドオンが対応する", () => {
    expect(Object.keys(ARTICLE_TYPE_ADDON).sort()).toEqual([
      "comparison",
      "gift",
      "grower",
      "howto",
      "pricing",
      "recipe",
      "season",
    ]);
    expect(ARTICLE_TYPE_ADDON.gift).toBe("P-03e");
  });
});
