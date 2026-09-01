import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicLLMClient,
  callAndParse,
  FixtureLLMClient,
  PROMPT_MODEL_CATEGORY,
  stripCodeFence,
} from "./llm.js";
import { P01Outline } from "./schemas.js";

const FIXTURES = join(__dirname, "..", "fixtures", "llm");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("llm: dry_run保証 (SPEC M1 Acceptance)", () => {
  it("dry_runではAnthropicLLMClientを構築できない (実APIを一切呼ばない)", () => {
    vi.stubEnv("PIPELINE_ENV", "dry_run");
    expect(
      () =>
        new AnthropicLLMClient({
          routing: {},
          pricing: {},
          budgetUsd: 60,
          getMonthSpendUsd: async () => 0,
          recordUsage: async () => {},
        }),
    ).toThrow(/dry_run/);
  });

  it("FixtureLLMClientはfixtures/llmから応答を返す", async () => {
    const client = new FixtureLLMClient({ fixturesDir: FIXTURES });
    const res = await client.call({ promptId: "P-04", user: "test" });
    expect(JSON.parse(res.text).verdict).toBe("approve");
    expect(client.calls).toHaveLength(1);
  });

  it("fixtureが無いpromptIdは明示的に失敗する", async () => {
    const client = new FixtureLLMClient({ fixturesDir: FIXTURES });
    await expect(client.call({ promptId: "P-99", user: "x" })).rejects.toThrow(
      /fixtureが見つかりません/,
    );
  });
});

describe("llm: callAndParse (zodパース+最大2回リトライ)", () => {
  it("1回目で正常JSONならそのまま返す", async () => {
    const client = new FixtureLLMClient({ fixturesDir: FIXTURES });
    const outline = await callAndParse(client, { promptId: "P-01", user: "u" }, P01Outline);
    expect(outline.approval_required).toBe(true);
    expect(client.calls).toHaveLength(1);
  });

  it("壊れたJSONはエラーを添えてリトライし、2回目で成功する", async () => {
    let n = 0;
    const valid = new FixtureLLMClient({ fixturesDir: FIXTURES });
    const validText = (await valid.call({ promptId: "P-01", user: "u" })).text;
    const client = new FixtureLLMClient({
      responses: { "P-01": () => (++n === 1 ? "{broken" : validText) },
    });
    const outline = await callAndParse(client, { promptId: "P-01", user: "u" }, P01Outline);
    expect(outline.title_draft).toBeTruthy();
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]!.user).toContain("前回出力のパースエラー");
  });

  it("最大リトライ超過で例外", async () => {
    const client = new FixtureLLMClient({ responses: { "P-01": "not json" } });
    await expect(
      callAndParse(client, { promptId: "P-01", user: "u" }, P01Outline, 2),
    ).rejects.toThrow(/パースに失敗/);
    expect(client.calls).toHaveLength(3); // 初回+2リトライ
  });

  it("コードフェンス付きJSONも受け付ける", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });
});

describe("llm: モデルルーティング表", () => {
  it("配線図どおり: 分類系=classify、生成/判定=generate/judge、戦略=strategy、改修=coder", () => {
    expect(PROMPT_MODEL_CATEGORY["P-14"]).toBe("classify");
    expect(PROMPT_MODEL_CATEGORY["P-02"]).toBe("generate");
    expect(PROMPT_MODEL_CATEGORY["P-04"]).toBe("judge");
    expect(PROMPT_MODEL_CATEGORY["P-16"]).toBe("strategy");
    expect(PROMPT_MODEL_CATEGORY["P-17"]).toBe("coder");
    // P-05b検証者はHaiku (SPEC: 検証=Haiku+別系統)
    expect(PROMPT_MODEL_CATEGORY["P-05b"]).toBe("classify");
  });
});
