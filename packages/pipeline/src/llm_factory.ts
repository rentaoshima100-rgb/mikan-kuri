// 実行環境に応じたLLMクライアント生成。
//   dry_run: FixtureLLMClient (実APIを呼ばない)
//   LLM_BACKEND=bridge: BridgeLLMClient (サブスク実行。Claude Codeルーチンのエージェントが
//     LLM役を務める。APIキー不要・課金なし。docs/ROUTINES.md)
//   それ以外: AnthropicLLMClient (従来のAPI経路、予算ガード付き)
import {
  AnthropicLLMClient,
  BridgeLLMClient,
  FixtureLLMClient,
  type LLMClient,
  type ModelPricing,
} from "@kurimikan/shared";
import type { Store } from "./db/types.js";

// LLMが使える構成か (スクリプトの実行前チェック用)。
// bridgeはAPIキー不要 (エージェントが応答する)。API経路はANTHROPIC_API_KEYが要る
export function llmConfigured(): boolean {
  return process.env.LLM_BACKEND === "bridge" || Boolean(process.env.ANTHROPIC_API_KEY);
}

// 予算ガードに渡す月次予算。サブスク実行 (bridge) は従量課金が無いので事実上無効化する
// (Infinityを渡すとcheckBudgetは常にok)。過去のAPI利用分が残る月の途中で変換しても、
// 予算ガードが生成を止めてしまわないようにするための措置でもある。
export function llmBudgetUsd(): number {
  if (process.env.LLM_BACKEND === "bridge") return Number.POSITIVE_INFINITY;
  return Number(process.env.MONTHLY_TOKEN_BUDGET_USD ?? 60);
}

export async function makeLLMClient(
  store: Store,
  opts: { fixturesDir?: string } = {},
): Promise<LLMClient> {
  if (process.env.PIPELINE_ENV === "dry_run") {
    return new FixtureLLMClient({ fixturesDir: opts.fixturesDir });
  }
  if (process.env.LLM_BACKEND === "bridge") {
    return new BridgeLLMClient({ recordUsage: (row) => store.recordUsage(row) });
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
