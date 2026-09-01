// SEO記事用のブログ (/blogs/column) を新設する。初回に1度だけ実行する。
//   npx tsx scripts/shopify/bootstrap_blog.ts [--handle column] [--title コラム] [--dry-run]
//
// お知らせ (/blogs/news) と分ける理由:
//   - blogごとに templateSuffix でテンプレートを変えられる。SEO記事側だけ
//     構造化データ・パンくず・末尾のコレクション誘導ブロックを持つ専用レイアウトにできる
//   - タグ絞り込みが blog 単位
//   - お知らせに読み物が混ざると、出荷情報のような「今すぐ知りたい情報」が埋もれる
import { makeShopifyClient, unwrapUserErrors } from "@kurimikan/pipeline";

const args = process.argv.slice(2);
const argOf = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const handle = argOf("--handle") ?? "column";
const title = argOf("--title") ?? "コラム";
const templateSuffix = argOf("--template-suffix") ?? undefined;

const BLOGS_QUERY = `
  query blogs($first: Int!) {
    blogs(first: $first) { nodes { id handle title } }
  }`;

const BLOG_CREATE = `
  mutation blogCreate($blog: BlogCreateInput!) {
    blogCreate(blog: $blog) {
      blog { id handle title }
      userErrors { field message code }
    }
  }`;

interface BlogNode {
  id: string;
  handle: string;
  title: string;
}

async function main() {
  const client = makeShopifyClient();

  // 冪等にする。既にあるなら作らない (二重に作ると /blogs/column-1 のような
  // handleが払い出され、以後の記事が全部そちらへ入る)
  const existing = await client.graphql<{ blogs: { nodes: BlogNode[] } }>(BLOGS_QUERY, {
    first: 50,
  });
  const found = existing.blogs.nodes.find((b) => b.handle === handle);
  if (found) {
    console.log(`既に存在します: /blogs/${found.handle} (${found.title})  ${found.id}`);
    console.log("何もせず終了します");
    return;
  }

  console.log(`作成する内容: handle=${handle} title=${title}`);
  console.log(`既存のブログ: ${existing.blogs.nodes.map((b) => b.handle).join(", ") || "(なし)"}`);
  if (args.includes("--dry-run")) {
    console.log("[dry-run] 作成せず終了します");
    return;
  }

  const res = await client.graphql<{
    blogCreate: { blog: BlogNode | null; userErrors: { message: string }[] };
  }>(BLOG_CREATE, {
    blog: { title, handle, ...(templateSuffix ? { templateSuffix } : {}) },
  });
  const created = unwrapUserErrors("blogCreate", res.blogCreate);
  console.log(`作成しました: /blogs/${created.blog?.handle}  ${created.blog?.id}`);
  console.log(
    `pipeline_config の shopify_blog_handle が "${handle}" になっていることを確認してください`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
