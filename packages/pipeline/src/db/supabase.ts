// Supabase実装 (service role接続)。ユニットテストはMemoryStoreで行い、
// 本実装はDay 5のdry_run統合テスト+実弾スモークで検証する。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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

export class SupabaseStore implements Store {
  private sb: SupabaseClient;

  constructor(url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY) {
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です");
    this.sb = createClient(url, key);
  }

  private ok<T>(res: { data: T; error: { message: string } | null }, ctx: string): T {
    if (res.error) throw new Error(`${ctx}: ${res.error.message}`);
    return res.data;
  }

  async getKeyword(id: string): Promise<KeywordRow | null> {
    const res = await this.sb.from("keywords").select("*").eq("id", id).maybeSingle();
    return this.ok(res, "getKeyword") as KeywordRow | null;
  }
  async updateKeywordStatus(id: string, status: KeywordStatus) {
    this.ok(await this.sb.from("keywords").update({ status }).eq("id", id), "updateKeywordStatus");
  }

  async createArticle(partial: Pick<ArticleRow, "keyword_id" | "article_type" | "lane">) {
    const res = await this.sb.from("articles").insert(partial).select().single();
    return this.ok(res, "createArticle") as ArticleRow;
  }
  async getArticle(id: string): Promise<ArticleRow | null> {
    const res = await this.sb.from("articles").select("*").eq("id", id).maybeSingle();
    return this.ok(res, "getArticle") as ArticleRow | null;
  }
  async updateArticle(id: string, patch: Partial<ArticleRow>) {
    const rest = { ...patch };
    delete rest.id;
    this.ok(
      await this.sb
        .from("articles")
        .update({ ...rest, updated_at: new Date().toISOString() })
        .eq("id", id),
      "updateArticle",
    );
  }
  async listArticlesByStatus(status: ArticleStatus): Promise<ArticleRow[]> {
    const res = await this.sb.from("articles").select("*").eq("status", status);
    return (this.ok(res, "listArticlesByStatus") ?? []) as ArticleRow[];
  }
  async listArticleSummaries(excludeId?: string): Promise<ArticleSummary[]> {
    // rejected/retired は公開されることがないのでカニバリの相手にならない。
    // これを渡していたため、判定中の記事が「自分の過去の下書き」と共食いしていると
    // 誤指摘され、uniqueness を落とし fix_instructions の枠を無駄に使っていた。
    const res = await this.sb
      .from("articles")
      .select("id, title, keywords(keyword)")
      .not("status", "in", "(rejected,retired)");
    const rows = (this.ok(res, "listArticleSummaries") ?? []) as unknown as Array<{
      id: string;
      title: string | null;
      keywords: { keyword: string } | { keyword: string }[] | null;
    }>;
    return rows
      .filter((r) => r.id !== excludeId)
      .map((r) => {
        const kw = Array.isArray(r.keywords) ? r.keywords[0] : r.keywords;
        return { id: r.id, title: r.title ?? "", keyword: kw?.keyword ?? "" };
      });
  }
  async listSlugs(): Promise<string[]> {
    const res = await this.sb.from("articles").select("slug").not("slug", "is", null);
    return ((this.ok(res, "listSlugs") ?? []) as Array<{ slug: string }>).map((r) => r.slug);
  }

  async listActiveAssetsByCluster(cluster: string, limit: number): Promise<PrimaryAssetRow[]> {
    const res = await this.sb
      .from("primary_info_assets")
      .select("*")
      .eq("status", "active")
      .contains("applicable_clusters", [cluster])
      .order("usage_count", { ascending: true })
      .limit(limit);
    return (this.ok(res, "listActiveAssetsByCluster") ?? []) as PrimaryAssetRow[];
  }
  async insertPrimaryAsset(asset: PrimaryAssetInsert): Promise<PrimaryAssetRow> {
    const res = await this.sb
      .from("primary_info_assets")
      .insert({
        asset_type: asset.asset_type,
        title: asset.title,
        description: asset.description,
        content: asset.content,
        numeric_claims: asset.numeric_claims,
        applicable_clusters: asset.applicable_clusters,
        sensitivity: asset.sensitivity ?? "low",
        source_permission: asset.source_permission ?? true,
        valid_until: asset.valid_until ?? null,
        status: "active",
      })
      .select()
      .single();
    return this.ok(res, "insertPrimaryAsset") as PrimaryAssetRow;
  }
  async incrementAssetUsage(assetIds: string[]): Promise<void> {
    if (!assetIds.length) return;
    // 件数が少ないため read-modify-write で十分 (同時実行は生成オーケストレータ1本のみ)
    const res = await this.sb
      .from("primary_info_assets")
      .select("id, usage_count")
      .in("id", assetIds);
    const rows = (this.ok(res, "incrementAssetUsage(select)") ?? []) as {
      id: string;
      usage_count: number;
    }[];
    for (const row of rows) {
      this.ok(
        await this.sb
          .from("primary_info_assets")
          .update({ usage_count: Number(row.usage_count) + 1 })
          .eq("id", row.id),
        "incrementAssetUsage(update)",
      );
    }
  }
  async insertInternalLinks(rows: InternalLinkInsert[]) {
    if (!rows.length) return;
    this.ok(await this.sb.from("internal_links").insert(rows), "insertInternalLinks");
  }
  async listInternalLinksByStatus(status: InternalLinkStatus): Promise<InternalLinkRow[]> {
    const res = await this.sb
      .from("internal_links")
      .select("*")
      .eq("status", status)
      .order("created_at", { ascending: true });
    return (this.ok(res, "listInternalLinksByStatus") ?? []) as InternalLinkRow[];
  }
  async updateInternalLink(id: string, patch: Partial<InternalLinkRow>): Promise<void> {
    const rest = { ...patch };
    delete rest.id;
    this.ok(
      await this.sb.from("internal_links").update(rest).eq("id", id),
      "updateInternalLink",
    );
  }

  async insertApproval(row: Omit<ApprovalRow, "id">): Promise<ApprovalRow> {
    const res = await this.sb.from("approvals").insert(row).select().single();
    return this.ok(res, "insertApproval") as ApprovalRow;
  }
  async latestApproval(articleId: string): Promise<ApprovalRow | null> {
    const res = await this.sb
      .from("approvals")
      .select("*")
      .eq("article_id", articleId)
      .order("decided_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return this.ok(res, "latestApproval") as ApprovalRow | null;
  }

  // article_id は unique 制約付き。取消/デッドマン差戻しは行を残したまま cancelled=true に
  // するため、再承認時に insert すると必ず制約違反になる。upsertで有効な状態へ戻す。
  async insertPublishQueue(articleId: string, scheduledAt: string) {
    this.ok(
      await this.sb.from("publish_queue").upsert(
        {
          article_id: articleId,
          scheduled_at: scheduledAt,
          cancelled: false,
          cancelled_reason: null,
          published: false,
        },
        { onConflict: "article_id" },
      ),
      "insertPublishQueue",
    );
  }
  async cancelPublishQueue(articleId: string, reason: string) {
    this.ok(
      await this.sb
        .from("publish_queue")
        .update({ cancelled: true, cancelled_reason: reason })
        .eq("article_id", articleId)
        .eq("published", false),
      "cancelPublishQueue",
    );
  }
  async getQueueEntry(articleId: string): Promise<PublishQueueRow | null> {
    const res = await this.sb
      .from("publish_queue")
      .select("*")
      .eq("article_id", articleId)
      .maybeSingle();
    return this.ok(res, "getQueueEntry") as PublishQueueRow | null;
  }
  async listScheduledDates(track?: ArticleTrack): Promise<string[]> {
    const res = await this.sb
      .from("publish_queue")
      .select("scheduled_at, articles!inner(track)")
      .eq("cancelled", false)
      .eq("published", false);
    const rows = (this.ok(res, "listScheduledDates") ?? []) as unknown as Array<{
      scheduled_at: string;
      articles: { track: string } | { track: string }[] | null;
    }>;
    return rows
      .filter((r) => {
        if (!track) return true;
        const a = Array.isArray(r.articles) ? r.articles[0] : r.articles;
        return (a?.track ?? "new") === track;
      })
      .map((r) => r.scheduled_at);
  }
  async recordPublishAttempt(articleId: string, at: Date, error: string | null): Promise<void> {
    this.ok(
      await this.sb
        .from("publish_queue")
        .update({ last_attempt_at: at.toISOString(), last_error: error })
        .eq("article_id", articleId),
      "recordPublishAttempt",
    );
  }

  async listDueQueue(now: Date): Promise<PublishQueueRow[]> {
    const res = await this.sb
      .from("publish_queue")
      .select("*")
      .eq("cancelled", false)
      .eq("published", false)
      .lte("scheduled_at", now.toISOString())
      .order("scheduled_at", { ascending: true });
    return (this.ok(res, "listDueQueue") ?? []) as PublishQueueRow[];
  }
  async markPublished(articleId: string, at: Date): Promise<void> {
    this.ok(
      await this.sb.from("publish_queue").update({ published: true }).eq("article_id", articleId),
      "markPublished(queue)",
    );
    await this.updateArticle(articleId, { status: "published", published_at: at.toISOString() });
  }
  async countPublishedSince(sinceIso: string, track?: ArticleTrack): Promise<number> {
    let q = this.sb
      .from("articles")
      .select("id", { count: "exact", head: true })
      .gte("published_at", sinceIso);
    if (track) q = q.eq("track", track);
    const res = await q;
    if (res.error) throw new Error(`countPublishedSince: ${res.error.message}`);
    return res.count ?? 0;
  }
  async listUnresolvedTripwires(): Promise<TripwireEvent[]> {
    const res = await this.sb
      .from("tripwire_events")
      .select("event_type, severity")
      .eq("resolved", false);
    return (this.ok(res, "listUnresolvedTripwires") ?? []) as TripwireEvent[];
  }
  async createKeyword(
    partial: Pick<KeywordRow, "keyword" | "cluster" | "article_type"> & Partial<KeywordRow>,
  ): Promise<KeywordRow> {
    const res = await this.sb.from("keywords").insert(partial).select().single();
    return this.ok(res, "createKeyword") as KeywordRow;
  }
  async findKeywordByName(keyword: string): Promise<KeywordRow | null> {
    const res = await this.sb.from("keywords").select("*").eq("keyword", keyword).maybeSingle();
    return this.ok(res, "findKeywordByName") as KeywordRow | null;
  }
  async listKeywordsByStatus(status: KeywordStatus): Promise<KeywordRow[]> {
    const res = await this.sb
      .from("keywords")
      .select("*")
      .eq("status", status)
      .order("priority", { ascending: false });
    return (this.ok(res, "listKeywordsByStatus") ?? []) as KeywordRow[];
  }

  async getMonthSpendUsd(now: Date): Promise<number> {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const res = await this.sb.from("api_usage").select("cost_usd").gte("called_at", monthStart);
    const rows = (this.ok(res, "getMonthSpendUsd") ?? []) as Array<{ cost_usd: number }>;
    return rows.reduce((sum, r) => sum + Number(r.cost_usd), 0);
  }
  async recordUsage(row: ApiUsageRow) {
    this.ok(await this.sb.from("api_usage").insert(row), "recordUsage");
  }

  async updateConfig(key: string, value: unknown, updatedBy: string): Promise<void> {
    this.ok(
      await this.sb
        .from("pipeline_config")
        .upsert({ key, value, updated_by: updatedBy, updated_at: new Date().toISOString() }, { onConflict: "key" }),
      "updateConfig",
    );
  }

  async upsertGscMetrics(rows: GscMetricRow[]): Promise<void> {
    if (!rows.length) return;
    this.ok(
      await this.sb.from("gsc_metrics").upsert(rows, { onConflict: "article_id,date" }),
      "upsertGscMetrics",
    );
  }
  async listGscMetricsSince(sinceDate: string): Promise<GscMetricRow[]> {
    const res = await this.sb.from("gsc_metrics").select("*").gte("date", sinceDate);
    return (this.ok(res, "listGscMetricsSince") ?? []) as GscMetricRow[];
  }
  async upsertRankSnapshots(rows: RankSnapshotRow[]): Promise<void> {
    if (!rows.length) return;
    this.ok(
      await this.sb.from("rank_snapshots").upsert(rows, { onConflict: "keyword,date" }),
      "upsertRankSnapshots",
    );
  }
  async listRankSnapshotsSince(sinceDate: string): Promise<RankSnapshotRow[]> {
    const res = await this.sb.from("rank_snapshots").select("*").gte("date", sinceDate);
    return (this.ok(res, "listRankSnapshotsSince") ?? []) as RankSnapshotRow[];
  }
  async getLatestCloudDraft(keywordId: string): Promise<CloudDraftRow | null> {
    const res = await this.sb
      .from("cloud_drafts")
      .select("*")
      .eq("keyword_id", keywordId)
      .is("consumed_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (this.ok(res, "getLatestCloudDraft") ?? null) as CloudDraftRow | null;
  }
  async markCloudDraftConsumed(id: string, articleId: string | null): Promise<void> {
    this.ok(
      await this.sb
        .from("cloud_drafts")
        .update({ consumed_at: new Date().toISOString(), consumed_by_article_id: articleId })
        .eq("id", id),
      "markCloudDraftConsumed",
    );
  }
  async saveStrategyReport(month: string, report: unknown, proposalsPending: number): Promise<void> {
    this.ok(
      await this.sb
        .from("strategy_reports")
        .upsert(
          { month, report, proposals_pending: proposalsPending },
          { onConflict: "month" },
        ),
      "saveStrategyReport",
    );
  }
  async getLatestStrategyReport(): Promise<StrategyReportRow | null> {
    const res = await this.sb
      .from("strategy_reports")
      .select("*")
      .order("month", { ascending: false })
      .limit(1)
      .maybeSingle();
    return this.ok(res, "getLatestStrategyReport") as StrategyReportRow | null;
  }
  async getSeoKnowledgeByUrl(url: string): Promise<SeoKnowledgeRow | null> {
    const res = await this.sb.from("seo_knowledge").select("*").eq("url", url).maybeSingle();
    return this.ok(res, "getSeoKnowledgeByUrl") as SeoKnowledgeRow | null;
  }
  async insertSeoKnowledge(row: SeoKnowledgeInsert): Promise<void> {
    // url unique。既存はスキップ (再取得の冪等性)
    const res = await this.sb.from("seo_knowledge").upsert(row, { onConflict: "url" });
    this.ok(res, "insertSeoKnowledge");
  }
  async listSeoKnowledgeSince(sinceIso: string, minImportance: number): Promise<SeoKnowledgeRow[]> {
    const res = await this.sb
      .from("seo_knowledge")
      .select("*")
      .gte("importance", minImportance)
      .order("importance", { ascending: false });
    return (this.ok(res, "listSeoKnowledgeSince") ?? []) as SeoKnowledgeRow[];
  }
  async getArticleBySlug(slug: string): Promise<ArticleRow | null> {
    const res = await this.sb.from("articles").select("*").eq("slug", slug).maybeSingle();
    return this.ok(res, "getArticleBySlug") as ArticleRow | null;
  }
  async listPublishedArticles(): Promise<ArticleRow[]> {
    return this.listArticlesByStatus("published");
  }
  async latestIndexStatusForPublishedSince(
    sinceIso: string,
    track?: ArticleTrack,
  ): Promise<{ article_id: string; index_status: string | null }[]> {
    let aq = this.sb.from("articles").select("id").gte("published_at", sinceIso);
    if (track) aq = aq.eq("track", track);
    const articles = await aq;
    const ids = ((this.ok(articles, "latestIndexStatus(articles)") ?? []) as { id: string }[]).map(
      (r) => r.id,
    );
    if (!ids.length) return [];
    const res = await this.sb
      .from("gsc_metrics")
      .select("article_id, index_status, date")
      .in("article_id", ids)
      .not("index_status", "is", null)
      .order("date", { ascending: false });
    const rows = (this.ok(res, "latestIndexStatus(metrics)") ?? []) as {
      article_id: string;
      index_status: string;
    }[];
    const latest = new Map<string, string>();
    for (const r of rows) if (!latest.has(r.article_id)) latest.set(r.article_id, r.index_status);
    return ids.map((id) => ({ article_id: id, index_status: latest.get(id) ?? null }));
  }
  async countCniInRange(fromDate: string, toDate: string): Promise<number> {
    const res = await this.sb
      .from("gsc_metrics")
      .select("id", { count: "exact", head: true })
      .eq("index_status", "crawled_not_indexed")
      .gte("date", fromDate)
      .lte("date", toDate);
    if (res.error) throw new Error(`countCniInRange: ${res.error.message}`);
    return res.count ?? 0;
  }
  async listQualityScoresBetween(fromIso: string, toIso: string): Promise<number[]> {
    const res = await this.sb
      .from("articles")
      .select("quality_score")
      .not("quality_score", "is", null)
      .gte("created_at", fromIso)
      .lt("created_at", toIso);
    return ((this.ok(res, "listQualityScoresBetween") ?? []) as { quality_score: number }[]).map(
      (r) => r.quality_score,
    );
  }
  async listRecentQualityScores(limit: number): Promise<number[]> {
    const res = await this.sb
      .from("articles")
      .select("quality_score")
      .not("quality_score", "is", null)
      .order("created_at", { ascending: false })
      .limit(limit);
    return ((this.ok(res, "listRecentQualityScores") ?? []) as { quality_score: number }[]).map(
      (r) => r.quality_score,
    );
  }
  async insertAiCvEvent(ev: AiCvEvent): Promise<void> {
    this.ok(await this.sb.from("ai_cv_events").insert(ev), "insertAiCvEvent");
  }
  async deleteSiteWideGscMetric(date: string): Promise<void> {
    this.ok(
      await this.sb.from("gsc_metrics").delete().is("article_id", null).eq("date", date),
      "deleteSiteWideGscMetric",
    );
  }
  async deleteAiCvEvents(occurredOn: string, source: AiCvEvent["source"]): Promise<void> {
    this.ok(
      await this.sb.from("ai_cv_events").delete().eq("occurred_on", occurredOn).eq("source", source),
      "deleteAiCvEvents",
    );
  }
  async sumAiCvEvents(): Promise<number> {
    const res = await this.sb.from("ai_cv_events").select("count");
    const rows = (this.ok(res, "sumAiCvEvents") ?? []) as { count: number }[];
    return rows.reduce((sum, r) => sum + Number(r.count), 0);
  }
  async sumAiCvEventsBySource(): Promise<Record<string, number>> {
    const res = await this.sb.from("ai_cv_events").select("source, count");
    const rows = (this.ok(res, "sumAiCvEventsBySource") ?? []) as {
      source: string;
      count: number;
    }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.source] = (out[r.source] ?? 0) + Number(r.count);
    return out;
  }

  async insertTripwire(ev: Omit<TripwireEvent, "id" | "resolved" | "created_at">): Promise<void> {
    this.ok(await this.sb.from("tripwire_events").insert(ev), "insertTripwire");
  }
  async listAllTripwires(): Promise<TripwireEvent[]> {
    const res = await this.sb
      .from("tripwire_events")
      .select("*")
      .order("created_at", { ascending: false });
    return (this.ok(res, "listAllTripwires") ?? []) as TripwireEvent[];
  }
  async resolveTripwire(id: string): Promise<void> {
    this.ok(
      await this.sb.from("tripwire_events").update({ resolved: true }).eq("id", id),
      "resolveTripwire",
    );
  }

  async getPromptFromDb(id: string): Promise<string | null> {
    const res = await this.sb.from("prompts").select("body").eq("id", id).maybeSingle();
    return ((this.ok(res, "getPromptFromDb") as { body: string } | null)?.body ?? null);
  }
  async getConfig<T>(key: string): Promise<T | null> {
    const res = await this.sb.from("pipeline_config").select("value").eq("key", key).maybeSingle();
    return ((this.ok(res, "getConfig") as { value: T } | null)?.value ?? null);
  }
}
