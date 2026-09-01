// 実弾スモークテスト (Sprint 0 Day 5、SPEC §7)。
// 実APIで1記事だけ生成し、api_usageにコストが記録されることを確認する。
//
// 安全設計:
//   - --confirm を明示しない限り実行しない (課金が発生するため)
//   - PIPELINE_ENV=production が必要 (dry_runでは意味がないため明示的に拒否)
//   - 記事は approval_pending で止まる。このスクリプトは公開しない (v3: 公開は承認のみ)
//   - 予算ガードは通常どおり効く (100%超過なら生成前に停止)
//
// 使い方:
//   PIPELINE_ENV=production npx tsx scripts/smoke.ts --confirm
//   PIPELINE_ENV=production npx tsx scripts/smoke.ts --confirm --keyword "サイトリニューアル 費用"
import { join } from "node:path";
import { generateArticle, makeLLMClient, SupabaseStore } from "@kurimikan/pipeline";

const args = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const SUITE_PATH = join(import.meta.dirname, "..", "kurimikan_prompt_suite_v1.md");
const KEYWORD = argOf("--keyword") ?? "ホームページ リニューアル 進め方";
const CLUSTER = argOf("--cluster") ?? "renewal";
const ARTICLE_TYPE = argOf("--type") ?? "howto";

function fail(message: string): never {
  console.error(`\n[中止] ${message}`);
  process.exit(1);
}

async function main() {
  console.log("=== 実弾スモークテスト (1記事生成) ===\n");

  if (!args.includes("--confirm")) {
    console.log("このスクリプトは実APIを呼び、Anthropicの課金が発生します (目安: 1記事あたり数十円)。");
    console.log("記事は承認待ちで止まり、公開はされません。");
    console.log("\n実行するには --confirm を付けてください:");
    console.log("  PIPELINE_ENV=production npx tsx scripts/smoke.ts --confirm");
    return;
  }
  if (process.env.PIPELINE_ENV !== "production") {
    fail("PIPELINE_ENV=production が必要です (dry_runでは実弾スモークになりません)");
  }
  for (const key of ["ANTHROPIC_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!process.env[key]) fail(`${key} が未設定です`);
  }

  const store = new SupabaseStore();
  const before = await store.getMonthSpendUsd(new Date());
  console.log(`今月のAPI利用額 (実行前): $${before.toFixed(4)}`);

  // 既存キーワードがあれば再利用 (keywords.keyword は unique)
  let keyword = await store.findKeywordByName(KEYWORD);
  if (!keyword) {
    keyword = await store.createKeyword({
      keyword: KEYWORD,
      cluster: CLUSTER,
      article_type: ARTICLE_TYPE,
      assigned_lane: "A",
      source: "manual",
    });
    console.log(`キーワードを登録: ${KEYWORD} (${keyword.id})`);
  } else {
    console.log(`既存キーワードを再利用: ${KEYWORD} (${keyword.id})`);
  }

  console.log("\n生成を開始します (P-01 → P-02ループ → P-04 → P-12 → P-11)...");
  const started = Date.now();
  const article = await generateArticle(keyword.id, {
    store,
    llm: await makeLLMClient(store),
    suitePath: SUITE_PATH,
    budgetUsd: Number(process.env.MONTHLY_TOKEN_BUDGET_USD ?? 60),
  });
  const elapsed = Math.round((Date.now() - started) / 1000);

  const after = await store.getMonthSpendUsd(new Date());
  const cost = after - before;

  console.log("\n=== 結果 ===");
  console.log(`記事ID   : ${article.id}`);
  console.log(`ステータス: ${article.status}`);
  console.log(`タイトル : ${article.title ?? "(なし)"}`);
  console.log(`slug     : ${article.slug ?? "(なし)"}`);
  console.log(`品質スコア: ${article.quality_score ?? "-"} / commodity: ${article.commodity_score ?? "-"}`);
  console.log(`文字数   : ${article.word_count ?? "-"}`);
  console.log(`所要時間 : ${elapsed}秒`);
  console.log(`APIコスト: $${cost.toFixed(4)} (今月累計 $${after.toFixed(4)})`);

  console.log("\n=== 受け入れ確認 (SPEC §7) ===");
  const checks: [string, boolean][] = [
    ["api_usageにコストが記録された", cost > 0],
    ["記事が生成された (本文あり)", Boolean(article.body_mdx)],
    ["承認待ちで止まっている (自動公開されていない)", article.status === "approval_pending"],
    ["公開キューに入っていない", (await store.getQueueEntry(article.id)) === null],
  ];
  let ok = true;
  for (const [label, passed] of checks) {
    console.log(`  ${passed ? "OK  " : "NG  "} ${label}`);
    if (!passed) ok = false;
  }

  if (article.status === "gate_pending") {
    console.log("\n注記: 品質ゲートがholdでした。管理画面でゲート承認すると続行できます (異常ではありません)。");
  }
  if (article.status === "rejected") {
    console.log("\n注記: 品質ゲートがrejectでした。生成経路自体は動作しています。");
  }

  console.log("\n次の手順:");
  console.log("  1. 管理画面 (npm run dev -w @kurimikan/admin) で内容を確認する");
  console.log("  2. 承認すると公開キューへ入り、cron-hourlyがサイトへ反映する");
  console.log("  3. 公開したくない場合は差戻し (needs_rewrite) にする");

  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error("\n[失敗]", e);
  process.exit(1);
});
