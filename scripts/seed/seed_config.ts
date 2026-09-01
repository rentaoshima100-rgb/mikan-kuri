// pipeline_config初期値 + authors (代表) を投入する。
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未設定時はplanモードで終了する。
import { createClient } from "@supabase/supabase-js";
import { AUTHOR_SEED, PIPELINE_CONFIG_SEED } from "./config_values.js";

async function main() {
  const entries = Object.entries(PIPELINE_CONFIG_SEED);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key || process.argv.includes("--plan")) {
    console.log("[plan] 投入予定のpipeline_config:");
    for (const [k, v] of entries) console.log(`  ${k} = ${JSON.stringify(v)}`);
    console.log(`[plan] authors: ${AUTHOR_SEED.name} (${AUTHOR_SEED.byline})`);
    return;
  }

  const supabase = createClient(url, key);
  for (const [k, v] of entries) {
    const { error } = await supabase.from("pipeline_config").upsert(
      { key: k, value: v, updated_by: "seed" },
      { onConflict: "key" },
    );
    if (error) throw new Error(`pipeline_config upsert失敗 (${k}): ${error.message}`);
  }

  const { data: existing, error: selErr } = await supabase
    .from("authors")
    .select("id")
    .eq("name", AUTHOR_SEED.name)
    .maybeSingle();
  if (selErr) throw new Error(`authors select失敗: ${selErr.message}`);
  if (!existing) {
    const { error } = await supabase.from("authors").insert(AUTHOR_SEED);
    if (error) throw new Error(`authors insert失敗: ${error.message}`);
  }

  console.log(`pipeline_config ${entries.length}件 + authors を投入しました`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
