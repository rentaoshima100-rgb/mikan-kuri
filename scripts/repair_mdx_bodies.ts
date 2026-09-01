// 既存記事のMDX混入 (```mdxフェンス + YAMLフロントマター + import文) を一括で除去する。
//
// 2026-07-30までに生成・改修した記事は、P-02/P-13bの出力をそのまま body_mdx に
// 保存していたため、本文がフェンスに包まれている。この状態で公開すると
// サイト側のプレーンmarkdownビルドで記事全体が <pre><code> に落ちる
// (本番の article-blog-bot で発生)。生成側は sanitizeArticleBody で修正済みなので、
// ここでは既存データだけを同じ関数で揃える。
//
//   npx tsx scripts/repair_mdx_bodies.ts           # 確認のみ (既定)
//   npx tsx scripts/repair_mdx_bodies.ts --write   # 実際に更新する
//
// 文章そのものは一切変更しない。外側の包み (フェンス・フロントマター・import) だけ剥がす。
// JSXタグ (<FAQ items={...} /> 等) は種類も入れ子も一定しないため機械では消さない。
// 残存件数を報告するので、該当記事は refit_batch.ts --redo で作り直すこと。
import { checkNotation, sanitizeArticleBody, SupabaseStore } from "@kurimikan/pipeline";
import type { ArticleStatus } from "@kurimikan/pipeline";

const write = process.argv.includes("--write");

// 本文を持ちうる全ステータス (draft/numeric_check/consensus は途中状態だが念のため含める)
const STATUSES: ArticleStatus[] = [
  "draft",
  "numeric_check",
  "gate_pending",
  "consensus",
  "approval_pending",
  "approved",
  "scheduled",
  "published",
  "rejected",
  "needs_rewrite",
  "retired",
];

async function main(): Promise<void> {
  const store = new SupabaseStore();
  const articles = (await Promise.all(STATUSES.map((s) => store.listArticlesByStatus(s)))).flat();

  const targets = articles
    .map((a) => {
      const raw = a.body_mdx ?? "";
      if (!raw) return null;
      const clean = sanitizeArticleBody(raw);
      if (clean === raw) return null;
      const jsx = checkNotation(raw).issues.find((i) => i.code === "raw_jsx");
      return { article: a, clean, removed: raw.length - clean.length, jsx: jsx?.count ?? 0 };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  if (targets.length === 0) {
    console.log("MDX混入のある記事はありません。");
    return;
  }

  console.log(`MDX混入: ${targets.length}件 / 全${articles.length}件`);
  for (const t of targets) {
    const jsxNote = t.jsx > 0 ? `  ※JSX${t.jsx}件残存 (--redo推奨)` : "";
    console.log(
      `  ${t.article.status.padEnd(17)} ${String(t.article.slug ?? "(slug未定)").padEnd(34)} -${t.removed}字${jsxNote}`,
    );
  }

  if (!write) {
    console.log("\n確認のみ。実行するには --write を付けてください。");
    return;
  }

  for (const t of targets) {
    await store.updateArticle(t.article.id, {
      body_mdx: t.clean,
      word_count: t.clean.replace(/\s/g, "").length,
    });
  }
  const needRedo = targets.filter((t) => t.jsx > 0);
  console.log(`\n${targets.length}件を更新しました。`);
  if (needRedo.length > 0) {
    console.log(
      `JSXが残る${needRedo.length}件は本文の作り直しが必要です: ` +
        needRedo.map((t) => t.article.slug ?? t.article.id).join(", "),
    );
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
