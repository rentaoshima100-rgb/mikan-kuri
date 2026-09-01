// テスト/dry_run用のインメモリストア。SupabaseStoreと同一インターフェース。
import type { ApiUsageRow } from "@kurimikan/shared";
import type {
  AiCvEvent,
  ApprovalRow,
  ArticleRow,
  ArticleTrack,
  ArticleStatus,
  ArticleSummary,
  CloudDraftRow,
  GscMetricRow,
  InternalLinkInsert,
  InternalLinkRow,
  InternalLinkStatus,
  KeywordRow,
  KeywordStatus,
  PrimaryAssetInsert,
  PrimaryAssetRow,
  PublishQueueRow,
  RankSnapshotRow,
  Store,
  SeoKnowledgeInsert,
  SeoKnowledgeRow,
  StrategyReportRow,
  TripwireEvent,
} from "./types.js";

let seq = 0;
const nextId = () => `id-${String(++seq).padStart(6, "0")}`;

export class MemoryStore implements Store {
  keywords = new Map<string, KeywordRow>();
  articles = new Map<string, ArticleRow>();
  approvals: ApprovalRow[] = [];
  queue: PublishQueueRow[] = [];
  assets: PrimaryAssetRow[] = [];
  links: InternalLinkRow[] = [];
  usage: ApiUsageRow[] = [];
  prompts = new Map<string, string>();
  config = new Map<string, unknown>();
  monthSpendUsd = 0;
  tripwires: TripwireEvent[] = [];
  gscMetrics = new Map<string, GscMetricRow>(); // key: `${article_id}|${date}`
  aiCvEvents: AiCvEvent[] = [];

  // ---- seedヘルパ (テスト用) ----
  // テスト用のキーワード投入。既定値は「最小限の有効なキーワード」に揃える。
  // target_collection を既定で持たせているのは、この案件では狙い先コレクションの
  // 無いキーワードが仕様上あり得ず (generate.ts が生成前に落とす)、
  // 毎回テスト側で書くと本題が埋もれるため
  addKeyword(partial: Partial<KeywordRow> & Pick<KeywordRow, "keyword">): KeywordRow {
    const row: KeywordRow = {
      id: nextId(),
      cluster: "citrus_variety",
      article_type: "howto",
      priority: 50,
      status: "queued",
      target_collection: "kanpei",
      ...partial,
    };
    this.keywords.set(row.id, row);
    return row;
  }

  addAsset(partial: Partial<PrimaryAssetRow>): PrimaryAssetRow {
    const row: PrimaryAssetRow = {
      id: nextId(),
      asset_type: "public_data_analysis",
      title: "asset",
      description: "desc",
      content: "content",
      numeric_claims: [],
      applicable_clusters: ["renewal"],
      usage_count: 0,
      status: "active",
      ...partial,
    };
    this.assets.push(row);
    return row;
  }

  setConfig(key: string, value: unknown): void {
    this.config.set(key, value);
  }

  // ---- Store実装 ----
  async getKeyword(id: string) {
    return this.keywords.get(id) ?? null;
  }
  async updateKeywordStatus(id: string, status: KeywordStatus) {
    const row = this.keywords.get(id);
    if (row) row.status = status;
  }

  async createArticle(partial: Pick<ArticleRow, "keyword_id" | "article_type" | "lane">) {
    const row: ArticleRow = {
      id: nextId(),
      status: "draft",
      judge_disagreement: false,
      created_at: new Date().toISOString(),
      ...partial,
    };
    this.articles.set(row.id, row);
    return row;
  }
  async getArticle(id: string) {
    return this.articles.get(id) ?? null;
  }
  async updateArticle(id: string, patch: Partial<ArticleRow>) {
    const row = this.articles.get(id);
    if (!row) throw new Error(`article not found: ${id}`);
    // articles.slug は本番DBで unique 制約付き。MemoryStoreでも同じ一意性を強制しないと
    // 「retireして同じslugで作り直す」系の不具合を実DBでしか踏めず、テストを素通りする。
    if (patch.slug != null) {
      const clash = [...this.articles.values()].find(
        (a) => a.id !== id && a.slug === patch.slug,
      );
      if (clash) {
        throw new Error(
          `updateArticle: duplicate key value violates unique constraint "articles_slug_key"`,
        );
      }
    }
    Object.assign(row, patch);
  }
  async listArticlesByStatus(status: ArticleStatus) {
    return [...this.articles.values()].filter((a) => a.status === status);
  }
  async listArticleSummaries(excludeId?: string): Promise<ArticleSummary[]> {
    return [...this.articles.values()]
      .filter((a) => a.status !== "rejected" && a.status !== "retired" && a.id !== excludeId)
      .map((a) => ({
        id: a.id,
        title: a.title ?? "",
        keyword: this.keywords.get(a.keyword_id)?.keyword ?? "",
      }));
  }
  async listSlugs() {
    return [...this.articles.values()].map((a) => a.slug).filter((s): s is string => !!s);
  }

  async listActiveAssetsByCluster(cluster: string, limit: number) {
    return this.assets
      .filter((a) => a.status === "active" && a.applicable_clusters.includes(cluster))
      .sort((a, b) => a.usage_count - b.usage_count)
      .slice(0, limit);
  }
  async insertPrimaryAsset(asset: PrimaryAssetInsert) {
    return this.addAsset({
      asset_type: asset.asset_type,
      title: asset.title,
      description: asset.description,
      content: asset.content,
      numeric_claims: asset.numeric_claims,
      applicable_clusters: asset.applicable_clusters,
      status: "active",
    });
  }
  async incrementAssetUsage(assetIds: string[]) {
    for (const asset of this.assets) {
      if (assetIds.includes(asset.id)) asset.usage_count += 1;
    }
  }
  async insertInternalLinks(rows: InternalLinkInsert[]) {
    for (const row of rows) this.links.push({ id: nextId(), ...row });
  }
  async listInternalLinksByStatus(status: InternalLinkStatus) {
    return this.links.filter((l) => l.status === status);
  }
  async updateInternalLink(id: string, patch: Partial<InternalLinkRow>) {
    const row = this.links.find((l) => l.id === id);
    if (row) Object.assign(row, patch);
  }

  async insertApproval(row: Omit<ApprovalRow, "id">) {
    const full: ApprovalRow = { id: nextId(), ...row };
    this.approvals.push(full);
    return full;
  }
  async latestApproval(articleId: string) {
    const rows = this.approvals
      .filter((a) => a.article_id === articleId)
      .sort((a, b) => b.decided_at.localeCompare(a.decided_at));
    return rows[0] ?? null;
  }

  // publish_queue.article_id は DB側で unique。取消/デッドマン差戻し後の再承認でも
  // 制約違反にならないよう、既存行があれば有効な状態へ入れ直す (SupabaseStoreと同一semantics)。
  // MemoryStoreが重複を許すと、再承認経路のテストが本番と乖離して不具合を見逃す。
  async insertPublishQueue(articleId: string, scheduledAt: string) {
    const existing = this.queue.find((q) => q.article_id === articleId);
    if (existing) {
      existing.scheduled_at = scheduledAt;
      existing.cancelled = false;
      delete existing.cancelled_reason;
      existing.published = false;
      return;
    }
    this.queue.push({
      id: nextId(),
      article_id: articleId,
      scheduled_at: scheduledAt,
      cancelled: false,
      published: false,
    });
  }
  async cancelPublishQueue(articleId: string, reason: string) {
    const entry = this.queue.find((q) => q.article_id === articleId && !q.published);
    if (entry) {
      entry.cancelled = true;
      entry.cancelled_reason = reason;
    }
  }
  async getQueueEntry(articleId: string) {
    return this.queue.find((q) => q.article_id === articleId) ?? null;
  }
  async listScheduledDates(track?: ArticleTrack) {
    return this.queue
      .filter((q) => !q.cancelled && !q.published)
      .filter((q) => !track || (this.articles.get(q.article_id)?.track ?? "new") === track)
      .map((q) => q.scheduled_at);
  }
  async recordPublishAttempt(articleId: string, at: Date, error: string | null) {
    const entry = this.queue.find((q) => q.article_id === articleId);
    if (entry) {
      entry.last_attempt_at = at.toISOString();
      entry.last_error = error;
    }
  }

  async listDueQueue(now: Date) {
    return this.queue
      .filter((q) => !q.cancelled && !q.published && new Date(q.scheduled_at) <= now)
      .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  }
  async markPublished(articleId: string, at: Date) {
    const entry = this.queue.find((q) => q.article_id === articleId);
    if (entry) entry.published = true;
    await this.updateArticle(articleId, {
      status: "published",
      published_at: at.toISOString(),
    });
  }
  async countPublishedSince(sinceIso: string, track?: ArticleTrack) {
    return [...this.articles.values()].filter(
      (a) =>
        a.published_at &&
        a.published_at >= sinceIso &&
        (!track || (a.track ?? "new") === track),
    ).length;
  }
  async listUnresolvedTripwires() {
    return this.tripwires.filter((t) => !t.resolved);
  }
  async insertTripwire(ev: Omit<TripwireEvent, "id" | "resolved" | "created_at">) {
    this.tripwires.push({
      id: nextId(),
      resolved: false,
      created_at: new Date().toISOString(),
      ...ev,
    });
  }
  async listAllTripwires() {
    return this.tripwires;
  }
  async resolveTripwire(id: string) {
    const t = this.tripwires.find((x) => x.id === id);
    if (t) t.resolved = true;
  }

  async updateConfig(key: string, value: unknown) {
    this.config.set(key, value);
  }

  async upsertGscMetrics(rows: GscMetricRow[]) {
    for (const row of rows) {
      const key = `${row.article_id}|${row.date}`;
      const existing = this.gscMetrics.get(key);
      this.gscMetrics.set(key, { ...existing, ...row });
    }
  }
  rankSnapshots = new Map<string, RankSnapshotRow>();
  async upsertRankSnapshots(rows: RankSnapshotRow[]) {
    for (const row of rows) this.rankSnapshots.set(`${row.keyword}|${row.date}`, row);
  }
  async listRankSnapshotsSince(sinceDate: string) {
    return [...this.rankSnapshots.values()].filter((r) => r.date >= sinceDate);
  }

  cloudDrafts: CloudDraftRow[] = [];
  addCloudDraft(partial: Partial<CloudDraftRow> & Pick<CloudDraftRow, "keyword_id">): CloudDraftRow {
    const row: CloudDraftRow = {
      id: nextId(),
      outline: {},
      body_mdx: "",
      created_at: new Date().toISOString(),
      consumed_at: null,
      consumed_by_article_id: null,
      ...partial,
    };
    this.cloudDrafts.push(row);
    return row;
  }
  async getLatestCloudDraft(keywordId: string) {
    return (
      this.cloudDrafts
        .filter((d) => d.keyword_id === keywordId && !d.consumed_at)
        .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0] ?? null
    );
  }
  async markCloudDraftConsumed(id: string, articleId: string | null) {
    const row = this.cloudDrafts.find((d) => d.id === id);
    if (row) {
      row.consumed_at = new Date().toISOString();
      row.consumed_by_article_id = articleId;
    }
  }
  async listGscMetricsSince(sinceDate: string) {
    return [...this.gscMetrics.values()].filter((r) => r.date >= sinceDate);
  }

  strategyReports: StrategyReportRow[] = [];
  async saveStrategyReport(month: string, report: unknown, proposalsPending: number) {
    const existing = this.strategyReports.find((r) => r.month === month);
    if (existing) {
      existing.report = report;
      existing.proposals_pending = proposalsPending;
      return;
    }
    this.strategyReports.push({
      id: nextId(),
      month,
      report,
      decisions_applied: false,
      proposals_pending: proposalsPending,
      created_at: new Date(0).toISOString(),
    });
  }
  async getLatestStrategyReport() {
    return [...this.strategyReports].sort((a, b) => b.month.localeCompare(a.month))[0] ?? null;
  }

  seoKnowledge: SeoKnowledgeRow[] = [];
  async getSeoKnowledgeByUrl(url: string) {
    return this.seoKnowledge.find((r) => r.url === url) ?? null;
  }
  async insertSeoKnowledge(row: SeoKnowledgeInsert) {
    if (this.seoKnowledge.some((r) => r.url === row.url)) return; // url unique
    this.seoKnowledge.push({ id: nextId(), status: "new", ...row });
  }
  async listSeoKnowledgeSince(sinceIso: string, minImportance: number) {
    const since = sinceIso.slice(0, 10);
    return this.seoKnowledge
      .filter((r) => (r.importance ?? 0) >= minImportance)
      .filter((r) => !r.published_at || r.published_at.slice(0, 10) >= since)
      .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
  }
  async getArticleBySlug(slug: string) {
    return [...this.articles.values()].find((a) => a.slug === slug) ?? null;
  }
  async listPublishedArticles() {
    return [...this.articles.values()].filter((a) => a.status === "published");
  }
  async latestIndexStatusForPublishedSince(sinceIso: string, track?: ArticleTrack) {
    const targets = [...this.articles.values()].filter(
      (a) =>
        a.published_at && a.published_at >= sinceIso && (!track || (a.track ?? "new") === track),
    );
    return targets.map((a) => {
      const rows = [...this.gscMetrics.values()]
        .filter((r) => r.article_id === a.id && r.index_status)
        .sort((x, y) => y.date.localeCompare(x.date));
      return { article_id: a.id, index_status: rows[0]?.index_status ?? null };
    });
  }
  async countCniInRange(fromDate: string, toDate: string) {
    return [...this.gscMetrics.values()].filter(
      (r) =>
        r.index_status === "crawled_not_indexed" && r.date >= fromDate && r.date <= toDate,
    ).length;
  }
  async listQualityScoresBetween(fromIso: string, toIso: string) {
    return [...this.articles.values()]
      .filter(
        (a) =>
          a.quality_score !== undefined &&
          a.created_at &&
          a.created_at >= fromIso &&
          a.created_at < toIso,
      )
      .map((a) => a.quality_score!);
  }
  async listRecentQualityScores(limit: number) {
    return [...this.articles.values()]
      .filter((a) => a.quality_score !== undefined && a.created_at)
      .sort((x, y) => y.created_at!.localeCompare(x.created_at!))
      .slice(0, limit)
      .map((a) => a.quality_score!);
  }
  async insertAiCvEvent(ev: AiCvEvent) {
    this.aiCvEvents.push(ev);
  }
  async deleteSiteWideGscMetric(date: string) {
    for (const [key, row] of this.gscMetrics) {
      if (row.article_id === null && row.date === date) this.gscMetrics.delete(key);
    }
  }
  async deleteAiCvEvents(occurredOn: string, source: AiCvEvent["source"]) {
    this.aiCvEvents = this.aiCvEvents.filter(
      (e) => !(e.occurred_on === occurredOn && e.source === source),
    );
  }
  async sumAiCvEvents() {
    return this.aiCvEvents.reduce((sum, e) => sum + e.count, 0);
  }
  async sumAiCvEventsBySource() {
    const out: Record<string, number> = {};
    for (const e of this.aiCvEvents) out[e.source] = (out[e.source] ?? 0) + e.count;
    return out;
  }
  async createKeyword(
    partial: Pick<KeywordRow, "keyword" | "cluster" | "article_type"> & Partial<KeywordRow>,
  ) {
    return this.addKeyword(partial);
  }
  async findKeywordByName(keyword: string) {
    return [...this.keywords.values()].find((k) => k.keyword === keyword) ?? null;
  }
  async listKeywordsByStatus(status: KeywordStatus) {
    return [...this.keywords.values()]
      .filter((k) => k.status === status)
      .sort((a, b) => b.priority - a.priority);
  }

  async getMonthSpendUsd() {
    return this.monthSpendUsd;
  }
  async recordUsage(row: ApiUsageRow) {
    this.usage.push(row);
  }

  async getPromptFromDb(id: string) {
    return this.prompts.get(id) ?? null;
  }
  async getConfig<T>(key: string): Promise<T | null> {
    return (this.config.get(key) as T) ?? null;
  }
}
