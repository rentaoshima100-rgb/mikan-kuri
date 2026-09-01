// 順位監視の手動実行 (日次は cron-daily の計測ステップが実行する)。
//   npx tsx scripts/rank_watch.ts            # 取得して rank_snapshots に記録し、順位表を表示
//   npx tsx scripts/rank_watch.ts --show     # 取得せず、記録済みの順位表だけ表示 (課金なし)
//
// 要: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY。取得には DATAFORSEO_LOGIN/PASSWORD も必要。
// 同日の再実行は unique(keyword,date) のupsertで冪等 (二重記録にならない)。
// コスト: 1キーワード約$0.002 (SERP live regular)。上限は pipeline_config.rank_watch.max_keywords。
import { runRankWatch, summarizeRanks, SupabaseStore } from "@kurimikan/pipeline";

const SHOW_ONLY = process.argv.includes("--show");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です");
}
const store = new SupabaseStore();

function fmt(p: number | null): string {
  return p === null ? "圏外" : `${p}位`;
}

function delta(now: number | null, before: number | null): string {
  if (before === null || now === null) return "";
  const d = before - now; // 順位は小さいほど良いので、正=改善
  if (d === 0) return "→";
  return d > 0 ? `↑${d}` : `↓${-d}`;
}

async function main() {
  if (!SHOW_ONLY) {
    const result = await runRankWatch({ store });
    if (result.skipped) {
      console.log(`スキップ: ${result.skipped}`);
    } else {
      console.log(
        `取得完了: ${result.checked}キーワード (圏内${result.ranked} / 失敗${result.errors})`,
      );
    }
  }

  const since = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
  const summary = summarizeRanks(await store.listRankSnapshotsSince(since));
  if (summary.length === 0) {
    console.log("記録がまだありません。DATAFORSEO_LOGIN/PASSWORD を設定して再実行してください。");
    return;
  }

  console.log(`\n=== 順位表 (${summary[0]!.date} 時点 / 前回比 / 7日前比) ===`);
  for (const row of summary) {
    const marks = [delta(row.position, row.prevPosition), delta(row.position, row.weekAgoPosition)]
      .filter(Boolean)
      .join(" ");
    console.log(
      `${fmt(row.position).padStart(5)}  ${marks.padEnd(8)} ${row.keyword}` +
        (row.foundUrl ? `\n${" ".repeat(16)}${row.foundUrl}` : ""),
    );
  }
}

main().catch((e) => {
  console.error("[失敗]", e);
  process.exit(1);
});
