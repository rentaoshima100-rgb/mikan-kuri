// 公開前バックログの重複掃除 (代表指示 2026-08-14: 同じ内容の記事を上げない)。
//
// 重複ハードゲート (quality/duplicate_gate.ts) は「これから生成・仕上げる記事」を止めるが、
// 導入前にキューへ入った重複はそのまま残っている。このスクリプトはそれを一掃する:
//   - 未公開の記事 (approval_pending / approved / scheduled / gate_pending、新規トラックのみ)
//     のタイトルを、公開済み記事 (DB + Shopify上の記事) と互いに突き合わせる
//   - 記事化待ちのキーワード (proposed / queued) の字面重複も検出する
//
// 判定は決定論のみ (正規化一致 + bigram類似)。LLMは呼ばないので課金は発生しない。
// 意図レベルの重複は、以後の生成時に入口ゲート (P-DUP) が毎回判定する。
//
// 使い方:
//   npx tsx scripts/dedup_sweep.ts             # 検出のみ (何も変更しない)
//   npx tsx scripts/dedup_sweep.ts --confirm   # 検出した重複を却下/保留にする
//
// --confirm時の処置 (先に作られた方を残し、後から来た方を落とす):
//   記事     → status=rejected + 理由。公開キューにあれば取消。キーワードはparked
//   キーワード → status=parked
import {
  findTitleDuplicate,
  listShopifyTopics,
  shopifyEnv,
  makeShopifyClient,
  SupabaseStore,
  TITLE_DUP_THRESHOLD,
  findSimilar,
  type ArticleRow,
} from "@kurimikan/pipeline";

const CONFIRM = process.argv.includes("--confirm");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です");
}
const store = new SupabaseStore();

async function main() {
  console.log(`=== 重複掃除 (${CONFIRM ? "適用モード" : "検出のみ"}) ===`);
  console.log(`タイトル類似のしきい値: ${TITLE_DUP_THRESHOLD} (正規化一致は常に重複扱い)\n`);

  // 1. 動かせない正 (公開済み) を集める。Shopify上の記事も読む
  // (店舗が /blogs/news に手で投稿したお知らせはDBが追跡していないため)
  const published = await store.listArticlesByStatus("published");
  let siteTitles: string[] = [];
  if (shopifyEnv()) {
    try {
      siteTitles = (await listShopifyTopics(makeShopifyClient())).map((t) => t.title);
    } catch (e) {
      console.warn(`注意: Shopifyの記事一覧を取得できませんでした: ${e}`);
    }
  } else {
    console.warn(
      "注意: SHOPIFY_SHOP / SHOPIFY_ADMIN_TOKEN が未設定です。" +
        "DB追跡分としか突き合わせないため、検出漏れがありえます。",
    );
  }
  const canonicalTitles = [
    ...published.map((a) => a.title ?? "").filter(Boolean),
    ...siteTitles,
  ];

  // 2. 未公開の新規トラック記事を作成順に見る。重複なら「後から来た方」が落ちる
  const unpublished: ArticleRow[] = [];
  for (const status of ["approval_pending", "approved", "scheduled", "gate_pending"] as const) {
    unpublished.push(...(await store.listArticlesByStatus(status)));
  }
  const targets = unpublished
    .filter((a) => (a.track ?? "new") === "new" && a.title)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));

  const keptTitles: string[] = [];
  let articleDupes = 0;
  for (const article of targets) {
    const dup = findTitleDuplicate(article.title!, [...canonicalTitles, ...keptTitles]);
    if (!dup) {
      keptTitles.push(article.title!);
      continue;
    }
    articleDupes++;
    console.log(`[記事] ${article.id} (${article.status})`);
    console.log(`    「${article.title}」`);
    console.log(`  ≈ 「${dup}」`);
    if (CONFIRM) {
      const reason = `重複掃除 (dedup_sweep): タイトルが既存「${dup}」とほぼ同一`;
      const queue = await store.getQueueEntry(article.id);
      if (queue && !queue.published && !queue.cancelled) {
        await store.cancelPublishQueue(article.id, reason);
        console.log("  → 公開キューを取消");
      }
      const quality =
        article.quality && typeof article.quality === "object" ? article.quality : {};
      await store.updateArticle(article.id, {
        status: "rejected",
        quality: { ...quality, rejected_reason: reason },
      });
      await store.updateKeywordStatus(article.keyword_id, "parked");
      console.log("  → status=rejected / キーワードをparked");
    }
  }

  // 3. 記事化待ちのキーワードの字面重複 (残った記事タイトル・キーワード・先行キーワードと比較)
  const keywordTargets = [
    ...(await store.listKeywordsByStatus("queued")),
    ...(await store.listKeywordsByStatus("proposed")),
  ].filter((k) => !k.keyword.startsWith("refit:"));
  const articleTexts = [...canonicalTitles, ...keptTitles];
  const keptKeywords: string[] = [];
  let keywordDupes = 0;
  for (const kw of keywordTargets) {
    const similar = findSimilar(kw.keyword, [...articleTexts, ...keptKeywords]);
    if (!similar) {
      keptKeywords.push(kw.keyword);
      continue;
    }
    keywordDupes++;
    console.log(`[キーワード] ${kw.id} (${kw.status}) 「${kw.keyword}」 ≈ 「${similar}」`);
    if (CONFIRM) {
      await store.updateKeywordStatus(kw.id, "parked");
      console.log("  → status=parked");
    }
  }

  console.log(
    `\n未公開記事 ${targets.length}本中 重複${articleDupes}本 / ` +
      `記事化待ちキーワード ${keywordTargets.length}件中 重複${keywordDupes}件`,
  );
  if (!CONFIRM && articleDupes + keywordDupes > 0) {
    console.log("適用するには --confirm を付けて再実行してください。");
  }
  if (CONFIRM && articleDupes + keywordDupes > 0) {
    console.log("適用しました。誤検出だった場合は管理画面から個別に再承認できます。");
  }
}

main().catch((e) => {
  console.error("[失敗]", e);
  process.exit(1);
});
