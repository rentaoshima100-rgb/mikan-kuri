// コスト計算と月次予算ガード (SPEC M13 / v3 1-10)。
// 基準は標準価格 (Sonnet $3/$15)。導入価格はコスト計算に使わない。

export interface ModelPricing {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}

// キャッシュ読み取りは入力単価の10%で概算する
const CACHE_READ_RATE = 0.1;

export function computeCostUsd(pricing: ModelPricing, usage: Usage): number {
  const cached = usage.cachedTokens ?? 0;
  const freshInput = Math.max(0, usage.inputTokens - cached);
  const cost =
    (freshInput * pricing.input_usd_per_mtok +
      cached * pricing.input_usd_per_mtok * CACHE_READ_RATE +
      usage.outputTokens * pricing.output_usd_per_mtok) /
    1_000_000;
  return Math.round(cost * 100000) / 100000;
}

export class BudgetExceededError extends Error {
  constructor(spent: number, budget: number) {
    super(
      `月次予算を超過しました (spent=$${spent.toFixed(2)} >= budget=$${budget.toFixed(2)})。生成系ジョブを停止します`,
    );
    this.name = "BudgetExceededError";
  }
}

export type BudgetStatus = "ok" | "warn";

// 80%で警告、100%で生成系停止 (フェイルクローズド)
export function checkBudget(spentUsd: number, budgetUsd: number): BudgetStatus {
  if (budgetUsd <= 0) return "ok";
  if (spentUsd >= budgetUsd) throw new BudgetExceededError(spentUsd, budgetUsd);
  return spentUsd >= budgetUsd * 0.8 ? "warn" : "ok";
}
