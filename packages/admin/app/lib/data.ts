import { SupabaseStore, shopifyEnv } from "@kurimikan/pipeline";

export function supabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getStore(): SupabaseStore {
  return new SupabaseStore();
}

// 内部リンクの適用は公開済み記事の再公開 (Shopify articleUpdate) を伴う。
// 公開先が静的サイトのgitリポジトリだった頃と違いローカルのチェックアウトは要らないので、
// デプロイ先の管理画面からも実行できる。必要なのはトークンだけ。
export function shopifyConfigured(): boolean {
  return shopifyEnv() !== null;
}

export function notConfiguredMessage() {
  return "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。.envを設定してください (README参照)。";
}
