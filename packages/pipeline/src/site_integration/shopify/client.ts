// Shopify Admin GraphQL API クライアント。
//
// 公開先は Shopify ストア (kuri-mikan.jp) の /blogs/<blog>/<article> なので、
// 記事の作成・更新はすべてこのAPI経由で行う。
//
// 必要スコープ: write_content (または write_online_store_pages)。
// トークンはストア管理画面のカスタムアプリで発行し、SHOPIFY_ADMIN_TOKEN に入れる。
// このリポジトリにトークンをコミットしない。
export interface ShopifyClientOptions {
  // "kurifusa" のようなサブドメイン、または "kurifusa.myshopify.com" 形式のどちらでもよい
  shop: string;
  accessToken: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  // スロットル時の再試行回数 (既定3回)
  maxRetries?: number;
  // 再試行の待ち時間 (テストから短縮するため差し替え可能)
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_API_VERSION = "2026-07";

export class ShopifyUserError extends Error {
  constructor(
    readonly mutation: string,
    readonly userErrors: { field?: string[] | null; message: string; code?: string | null }[],
  ) {
    super(
      `${mutation} が userErrors を返しました: ` +
        userErrors.map((e) => `${(e.field ?? []).join(".")}: ${e.message}`).join(" / "),
    );
    this.name = "ShopifyUserError";
  }
}

export class ShopifyGraphQLError extends Error {
  constructor(readonly errors: unknown) {
    super(`Shopify GraphQLエラー: ${JSON.stringify(errors)}`);
    this.name = "ShopifyGraphQLError";
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ShopifyAdminClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ShopifyClientOptions) {
    const host = opts.shop.includes(".") ? opts.shop : `${opts.shop}.myshopify.com`;
    this.endpoint = `https://${host}/admin/api/${opts.apiVersion ?? DEFAULT_API_VERSION}/graphql.json`;
    this.token = opts.accessToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(500 * 2 ** (attempt - 1));
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": this.token,
        },
        body: JSON.stringify({ query, variables }),
      });

      // 429 と 5xx は再試行する。それ以外のHTTPエラーは即座に投げる
      // (401/403 はトークンかスコープの問題なので、待っても直らない)
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`Shopify APIがHTTP ${res.status} を返しました: ${text.slice(0, 500)}`);
        if (res.status === 429 || res.status >= 500) {
          lastError = err;
          continue;
        }
        throw err;
      }

      const json = (await res.json()) as GraphQLResponse<T>;
      if (json.errors?.length) {
        // コストリミット超過。待って再試行する
        if (json.errors.some((e) => e.extensions?.code === "THROTTLED")) {
          lastError = new ShopifyGraphQLError(json.errors);
          continue;
        }
        throw new ShopifyGraphQLError(json.errors);
      }
      if (!json.data) throw new ShopifyGraphQLError("dataが空です");
      return json.data;
    }
    throw lastError ?? new Error("Shopify APIの再試行に失敗しました");
  }
}

/** userErrors を持つmutation結果を検証して payload を返す。 */
export function unwrapUserErrors<T>(
  mutation: string,
  payload: { userErrors?: { field?: string[] | null; message: string; code?: string | null }[] } & T,
): T {
  if (payload?.userErrors?.length) throw new ShopifyUserError(mutation, payload.userErrors);
  return payload;
}
