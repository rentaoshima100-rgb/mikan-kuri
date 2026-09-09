// ドメイン型とストアインターフェース。
// テストとdry_runはMemoryStore、本番はSupabaseStore (同一インターフェース)。
import type { ApiUsageRow } from "@kurimikan/shared";

export type Lane = "A" | "B";

export type ArticleStatus =
  | "draft"
  | "numeric_check"
  | "gate_pending"
  | "consensus"
  | "approval_pending"
  | "approved"
  | "scheduled"
  | "published"
  | "rejected"
  | "needs_rewrite"
  | "retired";

export type KeywordStatus = "proposed" | "queued" | "in_progress" | "done" | "parked";

export interface KeywordRow {
  id: string;
  keyword: string;
  cluster: string;
  article_type: string;
  search_intent?: string;
  priority: number;
  status: KeywordStatus;
  assigned_lane?: Lane;
  source?: string; // manual | chat_seed | strategy_agent | refit
  rationale?: string; // 発案器が付ける「なぜ今このネタか」。トピック承認の判断材料
  // 記事が押し上げる対象のコレクションhandle (例: kanpei)。
  // この案件の記事は必ずどれかのコレクションを狙って書く (quality/collection_link.ts)
  target_collection?: string | null;
  // 公開先のブログhandle。省略時は config の shopify_blog_handle (既定 column)
  blog_handle?: string | null;
}

export interface TripwireEvent {
  id?: string;
  event_type: string;
  severity: "info" | "throttle" | "halt";
  detail?: unknown;
  auto_action_taken?: string;
  resolved?: boolean;
  created_at?: string;
}

export interface GscMetricRow {
  article_id: string | null;
  date: string; // YYYY-MM-DD
  impressions?: number;
  clicks?: number;
  ctr?: number;
  position?: number;
  top_queries?: unknown;
  index_status?: string; // indexed | crawled_not_indexed | discovered | unknown
  ai_channel_sessions?: number;
}

export interface AiCvEvent {
  occurred_on: string; // YYYY-MM-DD
  source: "ga4_channel" | "self_report" | "referrer_log";
  detail?: unknown;
  count: number;
}

// クラウド下書き (サブスク側のClaude Codeルーチンが執筆した本文)。
// 生成オーケストレータが未消費の下書きを見つけるとP-01/P-02を省略して使う。
// outline は P01Outline 互換のJSON (zod検証は取り込み側)。検証に失敗しても
// consumed_at を立てて再利用を防ぎ、従来のAPI経路にフォールバックする
export interface CloudDraftRow {
  id: string;
  keyword_id: string;
  outline: unknown;
  body_mdx: string;
  sources?: unknown;
  created_at?: string;
  consumed_at?: string | null;
  consumed_by_article_id?: string | null;
}

// 順位監視 (metrics/rank_watch.ts)。DataForSEOで日次取得した自社順位の定点観測
export interface RankSnapshotRow {
  keyword: string;
  date: string; // YYYY-MM-DD (JST基準)
  position: number | null; // 100位以内の順位。null = 圏外
  found_url?: string | null;
}

export interface ArticleRow {
  id: string;
  keyword_id: string;
  slug?: string | null; // unique制約付き。改修の作り直し時にnullで解放する
  title?: string;
  meta_description?: string;
  outline?: unknown;
  body_mdx?: string;
  faq?: unknown;
  article_type: string;
  lane: Lane;
  status: ArticleStatus;
  quality?: unknown;
  quality_score?: number;
  hallucination_flags?: unknown;
  commodity_score?: number;
  consensus_result?: unknown;
  judge_disagreement: boolean;
  serp_gap?: unknown;
  numeric_changelog?: unknown;
  word_count?: number;
  scheduled_at?: string;
  published_at?: string;
  created_at?: string;
  // 承認が失効した理由 (デッドマン)。承認画面で「承認が失効しました」と表示する。
  // 再承認時にクリアされる
  expired_reason?: string | null;
  track?: ArticleTrack;
  // Shopifyの記事GID (gid://shopify/Article/...)。
  // 一度公開したらこれを持ち、次からは articleCreate ではなく articleUpdate になる
  shopify_article_id?: string | null;
  // 改修 (track='revision') のとき、書き換える対象の公開済み記事のID。
  // 改修案は slug を持たない (slugは公開済み記事の側が握ったまま)。公開時に
  // 対象のslugとShopify記事IDを引き継ぎ、本文を対象へ書き戻して自身はretireする
  revision_of?: string | null;
}

export interface ApprovalRow {
  id: string;
  article_id: string;
  decision: "approved" | "sent_back";
  decided_by: string;
  decided_at: string;
  review_notes?: string;
  judge_disagreement_ack: boolean;
}

export interface PublishQueueRow {
  id: string;
  article_id: string;
  scheduled_at: string;
  cancelled: boolean;
  cancelled_reason?: string;
  published: boolean;
  // 公開の試行結果。デッドマン失効時の原因切り分けに使う
  last_attempt_at?: string | null;
  last_error?: string | null;
}

// new: 新規記事 (週次目標と増速ゲートの対象) / revision: 既存記事の改稿 (独立ペース)
export type ArticleTrack = "new" | "revision";

export interface PrimaryAssetRow {
  id: string;
  asset_type: string;
  title: string;
  description: string;
  content: string;
  numeric_claims: unknown[];
  applicable_clusters: string[];
  usage_count: number;
  status: string;
  // 鮮度が切れる日 (YYYY-MM-DD)。nullは期限なし。
  // 柑橘は年ごとに出来が変わるので、その年の収穫に関する実測値には必ず入れる。
  // 期限を過ぎた資産は listActiveAssetsByCluster が返さない (記事に混入させない)
  valid_until?: string | null;
}

export interface PrimaryAssetInsert {
  asset_type: string;
  title: string;
  description: string;
  content: string;
  numeric_claims: unknown[];
  applicable_clusters: string[];
  sensitivity?: string;
  source_permission?: boolean;
  valid_until?: string | null;
}

export type InternalLinkStatus = "proposed" | "applied" | "skipped" | "rejected";

export interface InternalLinkInsert {
  source_article_id: string;
  target_url: string;
  anchor: string;
  direction: "outbound" | "inbound";
  insert_hint?: string;
  status: InternalLinkStatus;
}

export interface InternalLinkRow extends InternalLinkInsert {
  id: string;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  review_notes?: string | null;
  applied_commit?: string | null;
  created_at?: string;
}

export interface ArticleSummary {
  id: string;
  title: string;
  keyword: string;
}

export interface Store {
  getKeyword(id: string): Promise<KeywordRow | null>;
  updateKeywordStatus(id: string, status: KeywordStatus): Promise<void>;

  createArticle(
    partial: Pick<ArticleRow, "keyword_id" | "article_type" | "lane">,
  ): Promise<ArticleRow>;
  getArticle(id: string): Promise<ArticleRow | null>;
  updateArticle(id: string, patch: Partial<ArticleRow>): Promise<void>;
  listArticlesByStatus(status: ArticleStatus): Promise<ArticleRow[]>;
  // カニバリ判定 (P-01/P-04/P-11) に渡す既存記事。rejected/retired は公開されないので除く。
  // excludeId は判定中の記事自身 (自分の旧下書きと共食い判定されるのを防ぐ)
  listArticleSummaries(excludeId?: string): Promise<ArticleSummary[]>;
  listSlugs(): Promise<string[]>;

  // asOf 時点で有効な資産のみを返す (valid_until が null か asOf 以降)。
  // 全自動公開では人が本文を読まないため、期限切れをここで機械的に落とす
  listActiveAssetsByCluster(
    cluster: string,
    limit: number,
    asOf?: Date,
  ): Promise<PrimaryAssetRow[]>;
  insertPrimaryAsset(asset: PrimaryAssetInsert): Promise<PrimaryAssetRow>;
  // 使用回数の加算。選抜は usage_count 昇順なので、加算しないと同じ資産が使われ続ける
  incrementAssetUsage(assetIds: string[]): Promise<void>;
  // 記事が使った一次情報の記録。期限切れ素材から改修対象の記事を逆引きするために使う
  recordArticleAssets(articleId: string, assetIds: string[]): Promise<void>;
  // 期限切れの一次情報を使っている記事のID。改修バッチの対象を絞るのに使う
  listArticleIdsUsingExpiredAssets(asOf?: Date): Promise<string[]>;
  // 期限切れの一次情報に refresh_needed を立てる。返り値は件数。
  // 判定は決定論 (valid_until との比較) で、LLMは呼ばない
  markExpiredAssets(asOf?: Date): Promise<number>;
  insertInternalLinks(rows: InternalLinkInsert[]): Promise<void>;
  // 内部リンクの承認キュー (inboundは公開済み記事の書き換えになるため人間が承認する)
  listInternalLinksByStatus(status: InternalLinkStatus): Promise<InternalLinkRow[]>;
  updateInternalLink(id: string, patch: Partial<InternalLinkRow>): Promise<void>;

  insertApproval(row: Omit<ApprovalRow, "id">): Promise<ApprovalRow>;
  latestApproval(articleId: string): Promise<ApprovalRow | null>;

  insertPublishQueue(articleId: string, scheduledAt: string): Promise<void>;
  cancelPublishQueue(articleId: string, reason: string): Promise<void>;
  getQueueEntry(articleId: string): Promise<PublishQueueRow | null>;
  // 未取消・未公開のscheduled_at。トラック指定時はそのトラックのみ
  listScheduledDates(track?: ArticleTrack): Promise<string[]>;
  listDueQueue(now: Date): Promise<PublishQueueRow[]>; // scheduled_at<=now, 未取消, 未公開
  markPublished(articleId: string, at: Date): Promise<void>;
  recordPublishAttempt(articleId: string, at: Date, error: string | null): Promise<void>;
  countPublishedSince(sinceIso: string, track?: ArticleTrack): Promise<number>;
  listUnresolvedTripwires(): Promise<TripwireEvent[]>;
  createKeyword(
    partial: Pick<KeywordRow, "keyword" | "cluster" | "article_type"> & Partial<KeywordRow>,
  ): Promise<KeywordRow>;
  findKeywordByName(keyword: string): Promise<KeywordRow | null>;
  listKeywordsByStatus(status: KeywordStatus): Promise<KeywordRow[]>;

  getMonthSpendUsd(now: Date): Promise<number>;
  recordUsage(row: ApiUsageRow): Promise<void>;

  getPromptFromDb(id: string): Promise<string | null>;
  getConfig<T>(key: string): Promise<T | null>;
  updateConfig(key: string, value: unknown, updatedBy: string): Promise<void>;

  // 計測 (M7 + v3多重計測)
  upsertGscMetrics(rows: GscMetricRow[]): Promise<void>;
  listGscMetricsSince(sinceDate: string): Promise<GscMetricRow[]>;
  getArticleBySlug(slug: string): Promise<ArticleRow | null>;
  listPublishedArticles(): Promise<ArticleRow[]>;
  // 増速ゲートの母数は新規記事のみ (改修は新規URLを増やさないため対象外)
  latestIndexStatusForPublishedSince(
    sinceIso: string,
    track?: ArticleTrack,
  ): Promise<{ article_id: string; index_status: string | null }[]>;
  countCniInRange(fromDate: string, toDate: string): Promise<number>;
  listQualityScoresBetween(fromIso: string, toIso: string): Promise<number[]>;
  listRecentQualityScores(limit: number): Promise<number[]>; // created_at降順
  // 順位監視 (rank_watch)。unique(keyword,date)で冪等upsert
  upsertRankSnapshots(rows: RankSnapshotRow[]): Promise<void>;
  listRankSnapshotsSince(sinceDate: string): Promise<RankSnapshotRow[]>;
  // クラウド下書き。未消費 (consumed_at is null) の最新1件
  getLatestCloudDraft(keywordId: string): Promise<CloudDraftRow | null>;
  markCloudDraftConsumed(id: string, articleId: string | null): Promise<void>;
  insertAiCvEvent(ev: AiCvEvent): Promise<void>;
  sumAiCvEvents(): Promise<number>;
  sumAiCvEventsBySource(): Promise<Record<string, number>>; // 系統別内訳 (重複度の判断材料)
  // 月次ジョブの再実行で二重計上しないための置き換え用 (下記2つはga4_syncが使う)。
  // PostgreSQLではNULL同士が重複扱いされないため、article_id=null 行は
  // unique(article_id, date) では重複排除できない。明示的に消してから入れ直す
  deleteSiteWideGscMetric(date: string): Promise<void>;
  deleteAiCvEvents(occurredOn: string, source: AiCvEvent["source"]): Promise<void>;

  // トリップワイヤ (M11)
  insertTripwire(ev: Omit<TripwireEvent, "id" | "resolved" | "created_at">): Promise<void>;
  listAllTripwires(): Promise<TripwireEvent[]>;
  resolveTripwire(id: string): Promise<void>;

  // 月次戦略レポート (P-16)
  saveStrategyReport(month: string, report: unknown, proposalsPending: number): Promise<void>;
  getLatestStrategyReport(): Promise<StrategyReportRow | null>;

  // SEOウォッチャー (P-14/15)
  getSeoKnowledgeByUrl(url: string): Promise<SeoKnowledgeRow | null>;
  insertSeoKnowledge(row: SeoKnowledgeInsert): Promise<void>;
  listSeoKnowledgeSince(sinceIso: string, minImportance: number): Promise<SeoKnowledgeRow[]>;
}

export interface StrategyReportRow {
  id: string;
  month: string; // YYYY-MM-DD (月初)
  report: unknown; // P-16出力全体
  decisions_applied: boolean;
  proposals_pending: number;
  created_at: string;
}

export interface SeoKnowledgeRow {
  id: string;
  url: string;
  source: string;
  title?: string;
  source_type?: string;
  change_type?: string;
  confidence?: string;
  importance?: number;
  affected_area?: string[];
  summary_one_line?: string;
  corroboration_needed?: boolean;
  status: string;
  published_at?: string;
}

export interface SeoKnowledgeInsert {
  url: string;
  source: string;
  title?: string;
  source_type?: string;
  change_type?: string;
  confidence?: string;
  importance?: number;
  affected_area?: string[];
  summary_one_line?: string;
  corroboration_needed?: boolean;
  raw_excerpt?: string;
  published_at?: string;
}
