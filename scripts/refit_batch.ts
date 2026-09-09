// 既存記事の改修バッチ実行CLI。対象は公開済み記事 (articles.body_mdx)。
//   npx tsx scripts/refit_batch.ts [--limit N] [--slug <slug>]... [--plan] [--redo]
// 必要条件: SUPABASE_URL/SERVICE_ROLE_KEY + LLM経路 (LLM_BACKEND=bridge または ANTHROPIC_API_KEY)。
// 未設定時はplanモードで対象一覧のみ表示する。全件は承認キューに積まれ、公開は人間承認後。
//
// --redo: 未公開の改修案を破棄して作り直す (プロンプトを直したあとの再生成用)。
// 承認済み・公開済みは破棄せずスキップする。作り直したい場合は管理画面で取消してから再実行する。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  listRefitTargets,
  llmBudgetUsd,
  llmConfigured,
  makeLLMClient,
  refitBatch,
  SupabaseStore,
} from "@kurimikan/pipeline";

const args = process.argv.slice(2);
const argOf = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const SUITE_PATH = join(import.meta.dirname, "..", "kurimikan_prompt_suite_v1.md");
const DIRECTIVES_PATH = join(import.meta.dirname, "..", "data", "editorial_directives.json");
const limitRaw = argOf("--limit");
const limit = limitRaw ? Number(limitRaw) : undefined;
// --slug は繰り返し指定できる。プロンプトや一次情報を変えた効果を1本で確かめる用途。
const slugs = process.argv.reduce<string[]>((acc, a, i) => {
  if (a === "--slug" && process.argv[i + 1]) acc.push(process.argv[i + 1]!);
  return acc;
}, []);

// 記事別の編集指示 (代表のファクトチェック由来)。無ければ従来どおり動く。
function loadDirectives(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(DIRECTIVES_PATH, "utf8")) as {
      directives?: Record<string, unknown>;
    };
    return parsed.directives ?? {};
  } catch {
    return {};
  }
}

async function main() {
  const configured =
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    llmConfigured() &&
    process.env.PIPELINE_ENV !== "dry_run";
  if (!configured) {
    console.log(
      "実行にはSUPABASE_URL/SERVICE_ROLE_KEYとLLM経路 (LLM_BACKEND=bridge または ANTHROPIC_API_KEY)、PIPELINE_ENV=productionが必要です",
    );
    return;
  }

  const store = new SupabaseStore();
  // 対象はDBの公開済み記事。ストアを読む必要はない
  const entries = await listRefitTargets(store);
  console.log(`対象記事: ${entries.length}本 (公開済み)`);
  if (args.includes("--plan")) {
    console.log("[plan] 実行せず対象のみ表示:");
    for (const e of entries) console.log(`  ${e.slug}: ${e.title}`);
    return;
  }

  const llm = await makeLLMClient(store);
  const redo = args.includes("--redo");
  if (redo) console.log("[redo] 未公開の改修案を破棄して作り直します (承認済み・公開済みは対象外)");
  const directives = loadDirectives();
  const dCount = Object.keys(directives).length;
  console.log(dCount ? `[directives] 編集指示を${dCount}記事分読み込みました` : "[directives] 編集指示ファイルなし (従来動作)");
  const result = await refitBatch({
    store,
    llm,
    suitePath: SUITE_PATH,
    budgetUsd: llmBudgetUsd(),
    directives: directives as Record<string, import("@kurimikan/pipeline").EditorialDirective>,
  }, { limit, redo, slugs });

  console.log(
    `処理: ${result.processed.length}本 / スキップ: ${result.skipped.length}本` +
      (result.discarded.length ? ` / 破棄した旧案: ${result.discarded.length}本` : "") +
      (result.failed.length ? ` / 失敗: ${result.failed.length}本` : ""),
  );
  for (const p of result.processed) console.log(`  ${p.slug} → ${p.status}`);
  for (const s of result.skipped) console.log(`  [skip] ${s.slug}: ${s.reason}`);
  for (const f of result.failed) console.log(`  [fail] ${f.slug}: ${f.error}`);
  if (result.failed.length) {
    console.log(
      `\n${result.failed.length}本が失敗しました (通信断など)。もう一度同じコマンドを実行すると、` +
        `完了済みはスキップして失敗分だけ処理し直します (--redoは不要)。`,
    );
  }
  console.log("承認キュー (管理画面) でレビューしてください。公開は承認後のみ行われます");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
