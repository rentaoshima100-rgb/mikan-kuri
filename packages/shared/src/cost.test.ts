import { describe, expect, it } from "vitest";
import { BudgetExceededError, checkBudget, computeCostUsd } from "./cost.js";

describe("cost: コスト計算 (v3: 標準価格$3/$15基準)", () => {
  const sonnet = { input_usd_per_mtok: 3, output_usd_per_mtok: 15 };

  it("Sonnet: 100k入力+10k出力 = $0.45", () => {
    expect(computeCostUsd(sonnet, { inputTokens: 100_000, outputTokens: 10_000 })).toBe(0.45);
  });

  it("キャッシュ読み取り分は入力単価の10%で計算する", () => {
    // 100k入力のうち50kキャッシュ: 50k*3 + 50k*0.3 + 0 = 0.165
    expect(
      computeCostUsd(sonnet, { inputTokens: 100_000, outputTokens: 0, cachedTokens: 50_000 }),
    ).toBe(0.165);
  });

  it("Haiku/Opusの価格でも正しい", () => {
    const haiku = { input_usd_per_mtok: 1, output_usd_per_mtok: 5 };
    const opus = { input_usd_per_mtok: 5, output_usd_per_mtok: 25 };
    expect(computeCostUsd(haiku, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(6);
    expect(computeCostUsd(opus, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(30);
  });
});

describe("cost: 月次予算ガード (80%警告/100%停止)", () => {
  it("80%未満はok", () => {
    expect(checkBudget(40, 60)).toBe("ok");
  });

  it("80%以上はwarn", () => {
    expect(checkBudget(48, 60)).toBe("warn");
  });

  it("100%でBudgetExceededError (生成系停止、フェイルクローズド)", () => {
    expect(() => checkBudget(60, 60)).toThrow(BudgetExceededError);
    expect(() => checkBudget(75, 60)).toThrow(/生成系ジョブを停止/);
  });
});
