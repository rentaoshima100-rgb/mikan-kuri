// GSC 一括データエクスポート (BigQuery) の設定状況と、取れているデータを確認する。
//
//   npx tsx scripts/check_bq_export.ts            # 直近7日を確認
//   npx tsx scripts/check_bq_export.ts --days 30
//
// 設定は Search Console の画面で人間が行う (設定 → 一括データエクスポート)。
// 設定した日以降の分しか貯まらないため、未設定のうちは毎日データが失われ続ける。
import { BqNotConfiguredError, fetchQueryStats, summarizeAnonymized } from "@kurimikan/pipeline";

const args = process.argv.slice(2);
const daysArg = args.indexOf("--days");
const days = daysArg !== -1 && args[daysArg + 1] ? Number(args[daysArg + 1]) : 7;

const saJson = process.env.GSC_SERVICE_ACCOUNT_JSON;
if (!saJson) {
  console.error("GSC_SERVICE_ACCOUNT_JSON が未設定です");
  process.exit(1);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

async function main(): Promise<void> {
  const deps = { serviceAccountJson: saJson! };
  // BigQueryへの反映は2〜3日遅れるので、直近数日は空でも異常ではない
  const today = new Date();
  let found = 0;

  console.log(`GSC一括エクスポートの状況 (直近${days}日)`);
  for (let i = 1; i <= days; i++) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const date = iso(d);
    try {
      const stats = await fetchQueryStats(deps, date);
      if (stats.length === 0) continue;
      found++;
      const s = summarizeAnonymized(stats, date);
      const pct = Math.round(s.anonymizedRatio * 100);
      console.log(
        `  ${date}  表示${s.totalImpressions}回 / 見えるクエリ${s.visibleQueries}語 / ` +
          `匿名化${s.anonymizedImpressions}回 (${pct}%)`,
      );
    } catch (e) {
      if (e instanceof BqNotConfiguredError) {
        console.log("\n❌ まだ設定されていません。");
        console.log("   Search Console → 設定 → 一括データエクスポート で、");
        console.log("   Cloudプロジェクト avian-silo-483716-u8 を指定してください。");
        console.log("   設定した日以降の分しか貯まりません (過去は遡れません)。");
        return;
      }
      throw e;
    }
  }

  if (found === 0) {
    console.log("\n設定は済んでいますが、まだデータがありません。");
    console.log("BigQueryへの反映は2〜3日遅れます。明日以降にもう一度確認してください。");
    return;
  }
  console.log(`\n${found}日分のデータを確認しました。`);
  console.log("「匿名化」はSearch Console APIでは個票が返らない検索です。");
  console.log("この割合が大きいほど、API版だけでは見えていない検索が多いことを意味します。");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
