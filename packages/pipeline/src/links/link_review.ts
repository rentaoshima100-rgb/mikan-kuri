// 内部リンク承認キューのサービス層。
//
// v3の原則: 公開済み記事を無承認で書き換えない。
// 一方でこの案件の設計はコレクションへの内部リンクの集中が前提なので、
// 記事の承認とは別に「リンク承認キュー」を設けて人間が判断する。
//
// 記事の承認と違い、この画面には適用後の差分が全文表示される。
// 本文を見ずに押せる記事承認とは性質が異なるため、一括承認を許可する。
//
// nortiq版との違い:
//   公開先が静的サイトのgitリポジトリだったnortiq版は、本文の正をサイト側の
//   content/blog/*.md に置いていた (パイプライン以前に手で書いた記事が多数あり、
//   DBが本文を持っていなかったため)。
//   この案件のブログ (/blogs/column) はパイプラインと同時に新設するので、
//   すべての記事は articles.body_mdx が正であり、Shopify上のHTMLはそこから
//   生成した派生物になる。したがって本文はDBから読み、DBを書き換えてから
//   同じ公開経路 (ShopifyPublisher) で再公開する。HTMLをmarkdownへ逆変換する
//   必要がないぶん、往復での劣化も起きない。
import type { ArticleRow, InternalLinkRow, Store } from "../db/types.js";
import type { SitePublisher } from "../site_integration/publisher.js";
import { applyLinkToBody, type LinkDiff } from "./apply_link.js";

export interface LinkReviewItem {
  link: InternalLinkRow;
  targetArticle: ArticleRow | null; // 挿入先 (既存記事)
  diff: LinkDiff | null;
  error?: string;
}

export interface LinkReviewDeps {
  store: Store;
  // 適用後にShopifyへ反映するための公開器。省略時はDBの本文だけを書き換える
  // (プレビューや、未公開の記事へのリンク適用ではストアを触る必要がない)
  publisher?: SitePublisher;
  now?: () => Date;
}

// 公開済み記事の本文はDB (articles.body_mdx) が正
function readBody(article: ArticleRow): string {
  const body = article.body_mdx;
  if (!body) throw new Error("本文 (body_mdx) が空です");
  return body;
}

// 承認キューに出す一覧。各提案について適用後の差分を計算して添える
export async function listLinkReviewQueue(deps: LinkReviewDeps): Promise<LinkReviewItem[]> {
  const proposals = await deps.store.listInternalLinksByStatus("proposed");
  const inbound = proposals.filter((p) => p.direction === "inbound");
  const items: LinkReviewItem[] = [];

  for (const link of inbound) {
    const targetArticle = await deps.store.getArticle(link.source_article_id);
    if (!targetArticle?.slug) {
      items.push({
        link,
        targetArticle,
        diff: null,
        error: "挿入先の記事が特定できません (slug未設定)",
      });
      continue;
    }
    try {
      items.push({ link, targetArticle, diff: applyLinkToBody(readBody(targetArticle), link) });
    } catch (e) {
      items.push({
        link,
        targetArticle,
        diff: null,
        error: `本文を読めません: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return items;
}

export interface ApplyLinksResult {
  applied: string[];
  skipped: { id: string; reason: string }[];
  // 再公開まで済んだ記事のURL
  republished: string[];
}

/**
 * 承認された提案を本文へ反映し、公開済みの記事はストアへ再公開する。
 *
 * 記事ごとにまとめて適用する (1記事につき articleUpdate は1回)。
 * 再公開に失敗しても本文の書き換えとリンクの applied 記録は残す:
 * ここで巻き戻すと「DBとストアのどちらが正か」が実行のたびに変わるため。
 * 失敗はログに残し、次の公開機会か手動の再実行で追いつける。
 */
export async function applyApprovedLinks(
  linkIds: string[],
  reviewedBy: string,
  deps: LinkReviewDeps,
): Promise<ApplyLinksResult> {
  const now = deps.now?.() ?? new Date();
  const result: ApplyLinksResult = { applied: [], skipped: [], republished: [] };
  if (!linkIds.length) return result;

  const proposals = await deps.store.listInternalLinksByStatus("proposed");
  const targets = proposals.filter((p) => linkIds.includes(p.id));

  // 同じ記事への複数リンクをまとめて適用する (記事ごとに1回の書き込み)
  const byArticle = new Map<string, { article: ArticleRow; links: InternalLinkRow[] }>();
  for (const link of targets) {
    const article = await deps.store.getArticle(link.source_article_id);
    if (!article?.slug || !article.title) {
      result.skipped.push({ id: link.id, reason: "挿入先の記事が特定できません" });
      continue;
    }
    const entry = byArticle.get(article.id) ?? { article, links: [] };
    entry.links.push(link);
    byArticle.set(article.id, entry);
  }

  for (const { article, links } of byArticle.values()) {
    let body: string;
    try {
      body = readBody(article);
    } catch (e) {
      for (const l of links) {
        result.skipped.push({
          id: l.id,
          reason: `本文を読めません: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      continue;
    }

    const appliedHere: string[] = [];
    for (const link of links) {
      const diff = applyLinkToBody(body, link);
      if (!diff.inserted) {
        result.skipped.push({ id: link.id, reason: diff.reason ?? "挿入位置を決められません" });
        continue;
      }
      body = diff.after;
      appliedHere.push(link.id);
    }
    if (!appliedHere.length) continue;

    await deps.store.updateArticle(article.id, {
      body_mdx: body,
      word_count: body.replace(/\s/g, "").length,
    });
    for (const id of appliedHere) {
      await deps.store.updateInternalLink(id, {
        status: "applied",
        reviewed_by: reviewedBy,
        reviewed_at: now.toISOString(),
      });
    }
    result.applied.push(...appliedHere);

    // 未公開の記事は通常の公開経路で出るので、ここでストアを触らない
    if (!deps.publisher || article.status !== "published") continue;
    try {
      const keyword = await deps.store.getKeyword(article.keyword_id);
      const { url } = await deps.publisher.publish({ ...article, body_mdx: body }, keyword, now);
      result.republished.push(url);
    } catch (e) {
      console.error(
        `[links] 再公開に失敗しました (本文はDBに反映済み。再実行で追いつけます): ` +
          `${article.slug} — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return result;
}

export async function rejectLink(
  linkId: string,
  reviewedBy: string,
  notes: string,
  deps: Pick<LinkReviewDeps, "store" | "now">,
): Promise<void> {
  await deps.store.updateInternalLink(linkId, {
    status: "rejected",
    reviewed_by: reviewedBy,
    reviewed_at: (deps.now?.() ?? new Date()).toISOString(),
    review_notes: notes,
  });
}
