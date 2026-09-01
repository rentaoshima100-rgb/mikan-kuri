// 本文に残ったMDXのJSXコンポーネントを、内容を保ったままmarkdownへ変換する。
//
// 生成側は P-13b のプロンプト修正と sanitizeArticleBody で塞いだが、それ以前に
// 生成された本文にはタグが残っている。プレーンmarkdownのサイトではタグが文字として
// 表示されるため、公開前に変換する必要がある。
//
//   npx tsx scripts/fix_jsx_bodies.ts                    # 承認待ち/ゲート待ちを確認
//   npx tsx scripts/fix_jsx_bodies.ts --write            # 実際に更新する
//   npx tsx scripts/fix_jsx_bodies.ts --slug <slug> ...  # 対象を絞る
//   npx tsx scripts/fix_jsx_bodies.ts --all              # 全ステータスを対象にする
//
// 変換規則を持たないコンポーネントは触らずに報告する。機械が勝手に解釈して
// 情報を落とすより、人が見て判断するほうが安全なため。
import { convertJsxToMarkdown, SupabaseStore } from "@kurimikan/pipeline";
import type { ArticleStatus } from "@kurimikan/pipeline";

const args = process.argv.slice(2);
const write = args.includes("--write");
const slugs = args.reduce<string[]>((acc, a, i) => {
  if (a === "--slug" && args[i + 1]) acc.push(args[i + 1]!);
  return acc;
}, []);

// 既定は「これから公開されうるもの」だけ。公開済み記事の本文はサイト側が正なので触らない
const DEFAULT_STATUSES: ArticleStatus[] = ["approval_pending", "gate_pending", "approved", "scheduled"];
const ALL_STATUSES: ArticleStatus[] = [
  ...DEFAULT_STATUSES,
  "draft",
  "numeric_check",
  "consensus",
  "rejected",
  "needs_rewrite",
];

async function main(): Promise<void> {
  const store = new SupabaseStore();
  const statuses = args.includes("--all") ? ALL_STATUSES : DEFAULT_STATUSES;
  const articles = (await Promise.all(statuses.map((s) => store.listArticlesByStatus(s)))).flat();

  const targets = articles
    .filter((a) => (slugs.length ? slugs.includes(a.slug ?? "") : true))
    .map((a) => ({ article: a, result: convertJsxToMarkdown(a.body_mdx ?? "") }))
    .filter((t) => t.result.converted.length > 0 || t.result.unhandled.length > 0);

  if (targets.length === 0) {
    console.log("JSXが残っている記事はありません。");
    return;
  }

  for (const t of targets) {
    const { article: a, result: r } = t;
    const conv = r.converted.map((c) => `${c.component}x${c.count}`).join(", ") || "なし";
    console.log(`  ${String(a.slug ?? a.id).padEnd(34)} 変換=${conv}`);
    if (r.unhandled.length) {
      console.log(`      ※変換規則なし (残ります): ${r.unhandled.join(", ")} → 内容を見て手で直すこと`);
    }
    const before = (a.body_mdx ?? "").length;
    console.log(`      文字数 ${before} → ${r.body.length}`);
  }

  if (!write) {
    console.log("\n確認のみ。実行するには --write を付けてください。");
    return;
  }

  let n = 0;
  for (const t of targets) {
    if (t.result.converted.length === 0) continue; // 変換できたものだけ書き戻す
    await store.updateArticle(t.article.id, {
      body_mdx: t.result.body,
      word_count: t.result.body.replace(/\s/g, "").length,
    });
    n++;
  }
  console.log(`\n${n}件を更新しました。`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
