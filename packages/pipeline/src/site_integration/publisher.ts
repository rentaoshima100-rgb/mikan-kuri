// 公開先の抽象。実装は site_integration/shopify/publisher.ts (Shopify Admin API)。
//
// 公開ワーカ (publish/worker.ts) は承認・デッドマン・トリップワイヤの判定だけを担い、
// 「どこへどう書き込むか」は知らない。テストは実APIを呼ばない偽実装を差し込む。
import type { ArticleRow, KeywordRow } from "../db/types.js";

export interface PublishResult {
  url: string;
}

export interface SitePublisher {
  publish(article: ArticleRow, keyword: KeywordRow | null, now: Date): Promise<PublishResult>;
}
