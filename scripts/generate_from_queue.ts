// キューから記事生成CLI (v3 Sprint 1)。
//   npx tsx scripts/generate_from_queue.ts [--limit 2]
// 承認済み (status='queued') のキーワードを優先度順に記事化し、承認キューへ積む。
// 公開はされない (記事は approval_pending / gate_pending で止まる)。自動公開は存在しない。
// 必要: SUPABASE_URL/SERVICE_ROLE_KEY + LLM経路 (LLM_BACKEND=bridge または ANTHROPIC_API_KEY)。
import { join } from "node:path";
import {
  generateFromQueue,
  llmBudgetUsd,
  llmConfigured,
  makeLLMClient,
  SupabaseStore,
} from "@kurimikan/pipeline";

const args = process.argv.slice(2);
const argOf = (n: string) => {
  const i = args.indexOf(n);
  return i !== -1 ? args[i + 1] : undefined;
};
const SUITE_PATH = join(import.meta.dirname, "..", "kurimikan_prompt_suite_v1.md");

async function main() {
  const limit = argOf("--limit") ? Number(argOf("--limit")) : undefined;

  const configured =
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    llmConfigured() &&
    process.env.PIPELINE_ENV !== "dry_run";
  if (!configured) {
    console.log("[plan] キー未設定またはdry_runのため実行しません。");
    console.log(
      "実行にはSUPABASE_URL/SERVICE_ROLE_KEYとLLM経路 (LLM_BACKEND=bridge または ANTHROPIC_API_KEY)、PIPELINE_ENV=productionが必要です",
    );
    return;
  }

  const store = new SupabaseStore();
  const queued = await store.listKeywordsByStatus("queued");
  console.log(`記事化待ち: ${queued.length}件` + (limit ? ` (今回は${limit}件まで)` : ""));
  if (queued.length === 0) {
    console.log("承認済みのトピックがありません。管理画面の「トピック提案」で承認してください。");
    return;
  }

  const llm = await makeLLMClient(store);
  const r = await generateFromQueue(
    { store, llm, suitePath: SUITE_PATH, budgetUsd: llmBudgetUsd() },
    { limit },
  );

  console.log(`\n生成: ${r.generated.length}件 / 失敗: ${r.failed.length}件`);
  for (const g of r.generated) console.log(`  ${g.keyword} → ${g.status}`);
  for (const f of r.failed) console.log(`  [fail] ${f.keyword}: ${f.error}`);
  console.log("\n承認キュー (管理画面) でレビューしてください。公開は承認後のみ行われます。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
