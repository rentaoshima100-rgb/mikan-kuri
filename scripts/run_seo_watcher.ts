// SEOウォッチャー P-14 実行CLI (v3 Sprint 2)。
//   npx tsx scripts/run_seo_watcher.ts
// RSSフィードを取得し新着をP-14で分類してseo_knowledgeに蓄積。P-16戦略の入力になる。
// 必要: SUPABASE_URL/SERVICE_ROLE_KEY + ANTHROPIC_API_KEY (PIPELINE_ENV != dry_run)。
import { join } from "node:path";
import { makeLLMClient, runSeoWatcher, SupabaseStore } from "@kurimikan/pipeline";

const SUITE_PATH = join(import.meta.dirname, "..", "kurimikan_prompt_suite_v1.md");

async function main() {
  const configured =
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.ANTHROPIC_API_KEY &&
    process.env.PIPELINE_ENV !== "dry_run";
  if (!configured) {
    console.log("[plan] キー未設定またはdry_runのため実行しません。");
    return;
  }

  const store = new SupabaseStore();
  const llm = await makeLLMClient(store);
  console.log("SEOニュースを取得・分類中...");
  const r = await runSeoWatcher({ store, llm, suitePath: SUITE_PATH });

  console.log(`\n取得: ${r.fetched}件 / 新規分類: ${r.classified}件 / スキップ: ${r.skipped.length}件`);
  for (const s of r.skipped) console.log(`  [skip] ${s.feed}: ${s.reason}`);
  console.log("\n重要度7以上のエントリは月次戦略(P-16)のseo_knowledge_digestに反映されます。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
