// SitePublisher の Shopify 実装。
//
// 公開先は kuri-mikan.jp (Shopify)。記事URLは /blogs/<blog>/<handle> で固定される
// (Shopifyはフラットな /<handle> を許さない)。SEOのtitle/descriptionは記事フィールド
// ではなく metafield (global.title_tag / global.description_tag) で渡す。
//
// 冪等性: 一度作った記事のIDを articles.shopify_article_id に保存し、次からは
// articleUpdate に切り替える。保存に失敗した状態で再実行されると同じ記事が二重に
// 作られるため、公開キューの排他 (publish/worker.ts) と合わせて二重公開を防ぐ。
import type { ArticleRow, KeywordRow, Store } from "../../db/types.js";
import type { PublishResult, SitePublisher } from "../publisher.js";
import { markdownToHtml } from "./markdown_to_html.js";
import { ShopifyAdminClient, unwrapUserErrors } from "./client.js";

export const DEFAULT_BLOG_HANDLE = "column";
export const DEFAULT_SITE_BASE = "https://kuri-mikan.jp";

// SEOのtitle/descriptionを載せるmetafield。Shopifyのテーマが
// <title> / <meta name="description"> に使う標準の場所
export const SEO_METAFIELD_NAMESPACE = "global";
export const SEO_TITLE_KEY = "title_tag";
export const SEO_DESCRIPTION_KEY = "description_tag";

const BLOGS_QUERY = `
  query blogsForHandle($first: Int!) {
    blogs(first: $first) { nodes { id handle title } }
  }`;

const ARTICLE_CREATE = `
  mutation articleCreate($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article { id handle title }
      userErrors { field message code }
    }
  }`;

const ARTICLE_UPDATE = `
  mutation articleUpdate($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article { id handle title }
      userErrors { field message code }
    }
  }`;

export interface ShopifyPublisherOptions {
  client: ShopifyAdminClient;
  store: Store;
  // 記事URLの組み立てに使う。既定 https://kuri-mikan.jp
  siteBase?: string;
  // 既定のブログhandle。キーワード側の blog_handle が優先される
  blogHandle?: string;
}

interface BlogNode {
  id: string;
  handle: string;
  title: string;
}

export class ShopifyBlogNotFoundError extends Error {
  constructor(handle: string) {
    super(
      `ブログ /blogs/${handle} が見つかりません。` +
        `先に npm run shopify:bootstrap-blog で作成してください`,
    );
    this.name = "ShopifyBlogNotFoundError";
  }
}

export class ShopifyPublisher implements SitePublisher {
  // handle → gid。公開ごとに問い合わせると無駄なので実行中はキャッシュする
  private blogIds = new Map<string, string>();

  constructor(private options: ShopifyPublisherOptions) {}

  async resolveBlogId(handle: string): Promise<string> {
    const cached = this.blogIds.get(handle);
    if (cached) return cached;
    const data = await this.options.client.graphql<{ blogs: { nodes: BlogNode[] } }>(BLOGS_QUERY, {
      first: 50,
    });
    for (const b of data.blogs.nodes) this.blogIds.set(b.handle, b.id);
    const id = this.blogIds.get(handle);
    if (!id) throw new ShopifyBlogNotFoundError(handle);
    return id;
  }

  async publish(article: ArticleRow, keyword: KeywordRow | null, now: Date): Promise<PublishResult> {
    if (!article.title) throw new Error(`titleがありません: ${article.id}`);
    if (!article.body_mdx) throw new Error(`本文がありません: ${article.id}`);

    const { store } = this.options;

    // 改修 (revision) は、公開中の記事の中身を差し替える仕事。
    // 改修案そのものは slug も Shopify記事ID も持たない (公開中の記事が握ったまま)。
    // ここで対象から引き継ぎ、成功後に「公開中の座」を改修案へ移す
    const original = article.revision_of ? await store.getArticle(article.revision_of) : null;
    if (article.revision_of && !original) {
      throw new Error(`改修対象の記事が見つかりません: ${article.revision_of}`);
    }
    if (original && !original.slug) {
      throw new Error(`改修対象にslugがありません: ${original.id}`);
    }
    if (original && !original.shopify_article_id) {
      // Shopify上の実体が分からない状態で公開すると、更新ではなく2本目を作ってしまう
      throw new Error(
        `改修対象がShopify記事IDを持っていません: ${original.id}。` +
          `先に通常の公開経路で1度公開してください`,
      );
    }

    const slug = original?.slug ?? article.slug;
    if (!slug) throw new Error(`slugがありません: ${article.id}`);

    const blogHandle =
      keyword?.blog_handle ??
      (await store.getConfig<string>("shopify_blog_handle")) ??
      this.options.blogHandle ??
      DEFAULT_BLOG_HANDLE;
    const siteBase =
      (await store.getConfig<string>("site_base_url")) ??
      this.options.siteBase ??
      DEFAULT_SITE_BASE;

    const bodyHtml = markdownToHtml(await withSupervision(store, article.body_mdx));
    const metafields = seoMetafields(article);

    const existingId = original?.shopify_article_id ?? article.shopify_article_id;
    let handle: string;

    if (existingId) {
      // 既に公開済みの記事の更新 (改修、または内部リンク適用後の再公開)。
      // handleを変えるときは redirectNewHandle で旧URLから301を張らせる
      // (張らないと被リンクと既存の順位を捨てることになる)
      const payload = await this.options.client.graphql<{
        articleUpdate: { article: BlogNode | null; userErrors: { message: string }[] };
      }>(ARTICLE_UPDATE, {
        id: existingId,
        article: {
          title: article.title,
          handle: slug,
          body: bodyHtml,
          summary: article.meta_description ?? "",
          redirectNewHandle: true,
          isPublished: true,
          metafields,
        },
      });
      const updated = unwrapUserErrors("articleUpdate", payload.articleUpdate);
      handle = updated.article?.handle ?? slug;
    } else {
      const blogId = await this.resolveBlogId(blogHandle);
      const payload = await this.options.client.graphql<{
        articleCreate: { article: BlogNode | null; userErrors: { message: string }[] };
      }>(ARTICLE_CREATE, {
        article: {
          blogId,
          title: article.title,
          handle: slug,
          body: bodyHtml,
          summary: article.meta_description ?? "",
          tags: await articleTags(store, keyword),
          isPublished: true,
          publishDate: now.toISOString(),
          metafields,
        },
      });
      const created = unwrapUserErrors("articleCreate", payload.articleCreate);
      if (!created.article?.id) throw new Error("articleCreate が記事IDを返しませんでした");
      handle = created.article.handle;
      // 次回以降を articleUpdate に切り替えるため、必ずIDを残す。
      // ここで落ちると再実行時に同じ記事がもう1本作られる
      await store.updateArticle(article.id, { shopify_article_id: created.article.id });
    }

    // 改修が反映できたので「公開中の座」を移す。
    // slug と shopify_article_id はどちらも一意なので、先に旧行から外してから渡す。
    // 途中で落ちるとDB側だけ座が空く (Shopifyの記事は正しく更新済み) が、
    // 記事IDから復旧できる状態には残る
    if (original) {
      // 先に値を控える。ストアの実装によっては original が行そのものへの参照で、
      // 旧行を空にした時点で読めなくなる
      const inheritedId = original.shopify_article_id!;
      await store.updateArticle(original.id, {
        status: "retired",
        slug: null,
        shopify_article_id: null,
      });
      await store.updateArticle(article.id, { slug, shopify_article_id: inheritedId });
    }

    return { url: `${siteBase}/blogs/${blogHandle}/${handle}` };
  }
}

// クラスタをShopifyの記事タグに変換する。記事一覧の絞り込みに使う。
// 対応表に無いクラスタはそのまま出す (タグが消えるより、英語のまま出た方が気づける)
export async function articleTags(store: Store, keyword: KeywordRow | null): Promise<string[]> {
  if (!keyword) return [];
  const map = (await store.getConfig<Record<string, string>>("blog_category_map")) ?? {};
  return [map[keyword.cluster] ?? keyword.cluster];
}

export function seoMetafields(
  article: Pick<ArticleRow, "title" | "meta_description">,
): { namespace: string; key: string; type: string; value: string }[] {
  const fields: { namespace: string; key: string; type: string; value: string }[] = [];
  if (article.title) {
    fields.push({
      namespace: SEO_METAFIELD_NAMESPACE,
      key: SEO_TITLE_KEY,
      type: "single_line_text_field",
      value: article.title,
    });
  }
  if (article.meta_description) {
    fields.push({
      namespace: SEO_METAFIELD_NAMESPACE,
      key: SEO_DESCRIPTION_KEY,
      type: "single_line_text_field",
      value: article.meta_description,
    });
  }
  return fields;
}

// 監修表記とAI利用の開示。承認済み記事にのみ付く (公開経路を通るのは承認済みのみ)。
// 表示はテーマ側ではなく本文末尾に入れる。テーマ改修を待たずに開示を出せるようにするため
export async function withSupervision(store: Store, bodyMarkdown: string): Promise<string> {
  const sup = await store.getConfig<{ byline?: string; ai_disclosure?: string }>("supervision");
  const lines = [sup?.byline, sup?.ai_disclosure].filter(Boolean);
  if (!lines.length) return bodyMarkdown;
  return `${bodyMarkdown}\n\n---\n\n${lines.join("  \n")}`;
}
