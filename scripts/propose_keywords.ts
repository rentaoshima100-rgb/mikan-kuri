// キーワード発案CLI (v3 Sprint 1)。
//   npx tsx scripts/propose_keywords.ts [--cluster renewal] [--count 8]
// 発案器が既存記事の穴からトピック案を生成し、status='proposed' で積む。
// 代表は管理画面の「トピック提案」で承認 (queued) / 却下する。公開はされない。
// 必要: SUPABASE_URL/SERVICE_ROLE_KEY + ANTHROPIC_API_KEY (PIPELINE_ENV != dry_run)。
import { join } from "node:path";
import {
  dataForSeoCredsFromEnv,
  fetchSearchVolumes,
  makeLLMClient,
  proposeKeywords,
  SupabaseStore,
} from "@kurimikan/pipeline";

const args = process.argv.slice(2);
const argOf = (n: string) => {
  const i = args.indexOf(n);
  return i !== -1 ? args[i + 1] : undefined;
};
const SUITE_PATH = join(import.meta.dirname, "..", "kurimikan_prompt_suite_v1.md");

const CLUSTERS = ["renewal", "production", "system_dev", "ai_llmo"] as const;

async function main() {
  const clusterArg = argOf("--cluster");
  const cluster = CLUSTERS.includes(clusterArg as (typeof CLUSTERS)[number])
    ? (clusterArg as (typeof CLUSTERS)[number])
    : undefined;
  const count = argOf("--count") ? Number(argOf("--count")) : 8;

  const configured =
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.ANTHROPIC_API_KEY &&
    process.env.PIPELINE_ENV !== "dry_run";
  if (!configured) {
    console.log("[plan] キー未設定またはdry_runのため実行しません。");
    console.log(`  発案予定: ${cluster ?? "全クラスタ"} / ${count}件`);
    console.log("実行にはSUPABASE_URL/SERVICE_ROLE_KEY/ANTHROPIC_API_KEYとPIPELINE_ENV=productionが必要です");
    return;
  }

  const store = new SupabaseStore();
  const llm = await makeLLMClient(store);
  // DataForSEO認証があれば実検索ボリュームで裏付ける (無ければ従来動作)
  const creds = dataForSeoCredsFromEnv();
  const volumeLookup = creds
    ? (keywords: string[]) => fetchSearchVolumes(keywords, creds)
    : undefined;
  console.log(
    `トピックを発案します: ${cluster ?? "全クラスタ"} / ${count}件` +
      (volumeLookup ? " (DataForSEOで検索ボリューム裏付けあり)" : " (需要データなし)"),
  );
  const r = await proposeKeywords({ store, llm, suitePath: SUITE_PATH, volumeLookup }, { cluster, count });

  console.log(`\n提案: ${r.proposed.length}件 / スキップ: ${r.skipped.length}件`);
  // 重複判定の相手が実際の公開本数より少ないと、その差の分だけカニバリを見逃す。
  // articles テーブルが追跡しているのはパイプラインが作った記事だけ
  console.log(`重複判定の相手: 既存 ${r.comparedAgainst} 本`);
  for (const p of r.proposed) console.log(`  [${p.cluster}/優先${p.priority}] ${p.keyword}`);
  for (const s of r.skipped) console.log(`  [skip] ${s.keyword}: ${s.reason}`);
  console.log("\n管理画面の「トピック提案」で承認してください。承認したものだけが記事化されます。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
