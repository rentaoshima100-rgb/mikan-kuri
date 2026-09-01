// 実行環境に応じたLLMクライアント生成。
// dry_run: FixtureLLMClient (実APIを呼ばない) / production: AnthropicLLMClient (予算ガード付き)
import {
  AnthropicLLMClient,
  FixtureLLMClient,
  type LLMClient,
  type ModelPricing,
} from "@kurimikan/shared";
import type { Store } from "./db/types.js";

export async function makeLLMClient(
  store: Store,
  opts: { fixturesDir?: string } = {},
): Promise<LLMClient> {
  if (process.env.PIPELINE_ENV === "dry_run") {
    return new FixtureLLMClient({ fixturesDir: opts.fixturesDir });
  }
  const routing = (await store.getConfig<Record<string, string>>("model_routing")) ?? {};
  const pricing = (await store.getConfig<Record<string, ModelPricing>>("model_pricing")) ?? {};
  return new AnthropicLLMClient({
    routing,
    pricing,
    budgetUsd: Number(process.env.MONTHLY_TOKEN_BUDGET_USD ?? 60),
    getMonthSpendUsd: () => store.getMonthSpendUsd(new Date()),
    recordUsage: (row) => store.recordUsage(row),
    onBudgetWarn: (spent, budget) =>
      console.warn(`[budget] 月次予算の80%を超過: $${spent.toFixed(2)} / $${budget.toFixed(2)}`),
  });
}
