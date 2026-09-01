// 月次戦略エージェント P-16 実行CLI (v3 Sprint 2)。
//   npx tsx scripts/run_strategy.ts
// GSC/GA4/公開実績/トリップワイヤを集計してP-16に渡し、来月の方針レポートを生成・保存する。
// レポートは strategy_reports に保存され、管理画面の「戦略」で代表が確認 (自動適用しない)。
// 必要: SUPABASE_URL/SERVICE_ROLE_KEY + ANTHROPIC_API_KEY (PIPELINE_ENV != dry_run)。
import { join } from "node:path";
import { makeLLMClient, runMonthlyStrategy, SupabaseStore } from "@kurimikan/pipeline";

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
  console.log("月次戦略を分析中 (GSC/GA4/公開実績)...");
  const r = await runMonthlyStrategy({ store, llm, suitePath: SUITE_PATH });

  console.log(`\n=== 月次戦略レポート (${r.month}) ===`);
  console.log("[5分要約]");
  for (const s of r.report.summary_5min) console.log("  - " + s);
  if (r.report.decisions.length) {
    console.log("\n[自律決定 (代表確認のうえ反映)]");
    for (const d of r.report.decisions) console.log(`  - [${d.type}] ${d.detail}`);
  }
  if (r.report.proposals.length) {
    console.log("\n[提案 (人間承認が必要)]");
    for (const p of r.report.proposals) console.log(`  - [${p.type}] ${p.detail}`);
  }
  if (r.report.uncertainty_flags.length) {
    console.log("\n[判断保留 (データ不足等)]");
    for (const u of r.report.uncertainty_flags) console.log("  - " + u);
  }
  console.log("\n管理画面の「戦略」で全文を確認してください。自動適用はされません。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
