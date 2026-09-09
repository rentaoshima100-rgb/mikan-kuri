// 一次情報の自動リサーチCLI (v3 Sprint 1)。
//   npx tsx scripts/research_topic.ts --topic "社内 システム開発 外注 費用" --cluster system_dev
// web_searchで出典付きファクトを収集し、primary_info_assets に投入する。
// 必要: SUPABASE_URL/SERVICE_ROLE_KEY + LLM経路 (LLM_BACKEND=bridge または ANTHROPIC_API_KEY)。
import { join } from "node:path";
import {
  AnthropicResearchClient,
  llmConfigured,
  makeLLMClient,
  researchTopicToAsset,
  SupabaseStore,
} from "@kurimikan/pipeline";

const args = process.argv.slice(2);
const argOf = (n: string) => {
  const i = args.indexOf(n);
  return i !== -1 ? args[i + 1] : undefined;
};
const SUITE_PATH = join(import.meta.dirname, "..", "kurimikan_prompt_suite_v1.md");
const CLUSTERS = ["renewal", "production", "system_dev", "ai_llmo"];

async function main() {
  const topic = argOf("--topic");
  const cluster = argOf("--cluster");
  if (!topic || !cluster || !CLUSTERS.includes(cluster)) {
    console.error("使い方: --topic \"...\" --cluster (renewal|production|system_dev|ai_llmo)");
    process.exit(1);
  }

  const configured =
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    llmConfigured() &&
    process.env.PIPELINE_ENV !== "dry_run";
  if (!configured) {
    console.log("[plan] キー未設定またはdry_runのため実行しません。");
    console.log(`  リサーチ予定: ${topic} (${cluster})`);
    return;
  }

  const store = new SupabaseStore();
  const llm = await makeLLMClient(store);
  const research = new AnthropicResearchClient();
  console.log(`リサーチ中: ${topic} ...`);
  const r = await researchTopicToAsset({ store, llm, research, suitePath: SUITE_PATH }, { topic, cluster });

  if (!r.asset) {
    console.log("出典付きファクトが得られなかったため資産は作りませんでした。");
    return;
  }
  console.log(`\n資産を投入しました: [${cluster}] ${r.asset.title}`);
  console.log(`  参照した出典: ${r.sources.length}件`);
  for (const s of r.sources.slice(0, 6)) console.log(`    - ${s.title} (${s.url})`);
  console.log(`  numeric_claims: ${JSON.stringify(r.asset.numeric_claims)}`);
  console.log("\nこの資産は次回この記事を生成/改修する際に注入されます。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
