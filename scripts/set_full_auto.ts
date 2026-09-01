// 全自動公開フラグ (full_auto_publish) の切り替え。
//   有効化: npx tsx scripts/set_full_auto.ts on
//   無効化: npx tsx scripts/set_full_auto.ts off   (v3の元挙動=全記事承認制に戻る)
//   確認  : npx tsx scripts/set_full_auto.ts
//
// true にすると cron-daily が発案トピックを自動でqueuedにし、生成記事を品質ゲート結果に
// 関わらず自動承認+即時公開の予定にする (実公開はcron-hourly)。代表の承認ボタンを介さない。
// これはv3の絶対ルール (全記事承認制) を代表判断で上書きする設定 (CLAUDE.md v3訂正表参照)。
import { SupabaseStore } from "@kurimikan/pipeline";

const arg = process.argv[2]?.toLowerCase();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です");
}
const store = new SupabaseStore();

if (arg === undefined) {
  const current = (await store.getConfig<boolean>("full_auto_publish")) ?? false;
  console.log(`full_auto_publish = ${current} (${current ? "全自動公開ON" : "v3既定=承認制"})`);
} else if (arg === "on" || arg === "true") {
  await store.updateConfig("full_auto_publish", true, "system:cli");
  console.log("full_auto_publish = true にしました。次のcron-dailyから全自動公開が有効です。");
  console.log("戻すとき: npx tsx scripts/set_full_auto.ts off");
} else if (arg === "off" || arg === "false") {
  await store.updateConfig("full_auto_publish", false, "system:cli");
  console.log("full_auto_publish = false にしました。v3の元挙動 (全記事承認制) に戻りました。");
} else {
  throw new Error(`不明な引数: ${arg} (on | off | 省略=確認)`);
}
