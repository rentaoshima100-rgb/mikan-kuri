// 重複判定の相手として、Shopify上に実在する記事を集める。
//
// パイプラインが書いた記事はDB (articles) が正だが、店舗側は /blogs/news に
// 出荷情報やお知らせを手で投稿する。DBだけを見ていると、そこで既に扱った話題
// (「今年の南柑20号の出荷が始まりました」等) と同じ記事を書いてしまう。
//
// 失敗しても生成は止めない (相手が減るだけで、DB側の判定は生きている)。
// 呼び出し側は空配列を受け取り、警告だけを出すこと。
import type { ShopifyAdminClient } from "./client.js";

export interface ShopifyTopic {
  title: string;
  handle: string;
  blogHandle: string;
}

const ARTICLES_QUERY = `
  query articlesForDedup($first: Int!, $after: String) {
    articles(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle title blog { handle } }
    }
  }`;

interface ArticlesPage {
  articles: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: { id: string; handle: string; title: string; blog: { handle: string } | null }[];
  };
}

/**
 * ストア上の全ブログ記事のタイトルを取得する。
 * maxPages で打ち切るのは、記事が増えたときに1回の重複判定でAPIを延々叩かないため。
 */
export async function listShopifyTopics(
  client: ShopifyAdminClient,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<ShopifyTopic[]> {
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 5;
  const out: ShopifyTopic[] = [];
  let after: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const data: ArticlesPage = await client.graphql<ArticlesPage>(ARTICLES_QUERY, {
      first: pageSize,
      after,
    });
    for (const n of data.articles.nodes) {
      out.push({ title: n.title, handle: n.handle, blogHandle: n.blog?.handle ?? "" });
    }
    if (!data.articles.pageInfo.hasNextPage) break;
    after = data.articles.pageInfo.endCursor;
    if (!after) break;
  }
  return out;
}

/**
 * 重複ゲート (quality/duplicate_gate.ts) の extraTopics に渡すプロバイダを作る。
 * keyword を空にしているのは、店舗が手で投稿した記事に狙いキーワードが無いため。
 * 判定はタイトルと検索意図で行われる。
 */
export function shopifyTopicsProvider(
  client: ShopifyAdminClient,
  opts: { pageSize?: number; maxPages?: number } = {},
): () => Promise<{ title: string; keyword: string }[]> {
  return async () =>
    (await listShopifyTopics(client, opts)).map((t) => ({ title: t.title, keyword: "" }));
}
