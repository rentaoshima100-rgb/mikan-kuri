// 環境変数からShopifyクライアントと公開器を組み立てる。
//
// トークンはストア管理画面のカスタムアプリで発行する (必要スコープ write_content)。
// .env にのみ置き、リポジトリにはコミットしない。
import type { Store } from "../../db/types.js";
import { DEFAULT_API_VERSION, ShopifyAdminClient } from "./client.js";
import { ShopifyPublisher } from "./publisher.js";

export class ShopifyNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(
      `Shopifyの接続情報が足りません (${missing.join(", ")})。` +
        `.env.example を参照して設定してください`,
    );
    this.name = "ShopifyNotConfiguredError";
  }
}

export function shopifyEnv(): { shop: string; accessToken: string; apiVersion: string } | null {
  const shop = process.env.SHOPIFY_SHOP;
  const accessToken = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shop || !accessToken) return null;
  return { shop, accessToken, apiVersion: process.env.SHOPIFY_API_VERSION ?? DEFAULT_API_VERSION };
}

export function makeShopifyClient(): ShopifyAdminClient {
  const env = shopifyEnv();
  if (!env) {
    throw new ShopifyNotConfiguredError(
      [
        !process.env.SHOPIFY_SHOP ? "SHOPIFY_SHOP" : "",
        !process.env.SHOPIFY_ADMIN_TOKEN ? "SHOPIFY_ADMIN_TOKEN" : "",
      ].filter(Boolean),
    );
  }
  return new ShopifyAdminClient(env);
}

export function makeShopifyPublisher(store: Store): ShopifyPublisher {
  return new ShopifyPublisher({ client: makeShopifyClient(), store });
}
