// プロンプト集をパース → promptsテーブルへupsert。
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未設定時はplanモード (投入内容の表示のみ) で終了する。
import { createClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { EXPECTED_PROMPT_IDS, parseSuiteFile } from "@kurimikan/shared";

const SUITE_PATH = join(import.meta.dirname, "..", "..", "kurimikan_prompt_suite_v1.md");

async function main() {
  const prompts = parseSuiteFile(SUITE_PATH);
  const ids = prompts.map((p) => p.id).sort();
  const expected = [...EXPECTED_PROMPT_IDS].sort();
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    throw new Error(
      `パース結果が期待と不一致。missing=${expected.filter((i) => !ids.includes(i))} extra=${ids.filter((i) => !expected.includes(i as never))}`,
    );
  }

  console.log(`パース: ${prompts.length}本`);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || process.argv.includes("--plan")) {
    console.log("[plan] SUPABASE_URL/SERVICE_ROLE_KEY未設定または--plan指定のため投入せず内容のみ表示:");
    for (const p of prompts) console.log(`  ${p.id}: ${p.body.length} chars`);
    return;
  }

  const supabase = createClient(url, key);
  for (const p of prompts) {
    const { error } = await supabase.from("prompts").upsert(
      { id: p.id, body: p.body, updated_by: "seed" },
      { onConflict: "id" },
    );
    if (error) throw new Error(`prompts upsert失敗 (${p.id}): ${error.message}`);
  }
  console.log(`promptsテーブルへ${prompts.length}本を投入しました`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
