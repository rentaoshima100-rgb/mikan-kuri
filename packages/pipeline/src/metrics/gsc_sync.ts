// M7 gsc_sync (cron-daily)。
// Search Analytics API: page×date の clicks/impressions/ctr/position と
// page×query 上位クエリを取得し gsc_metrics へ冪等upsert。
// URL Inspection API: 直近28日公開記事 + ランダム既存10件/日 をサンプリング取得 (クォータ配慮)。
// GSC_SERVICE_ACCOUNT_JSON 未設定時はスキップ (モック+切替フラグ方式)。
import type { GscMetricRow, Store } from "../db/types.js";
import { getGoogleAccessToken, parseServiceAccount } from "./google_auth.js";

const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

export interface GscSyncDeps {
  store: Store;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  serviceAccountJson?: string; // 既定: env GSC_SERVICE_ACCOUNT_JSON
  siteUrl?: string; // 既定: https://kuri-mikan.jp/
}

export interface GscSyncResult {
  skipped?: string;
  metricRows: number;
  inspected: number;
}

const day = (d: Date, offset: number) =>
  new Date(d.getTime() + offset * 86400_000).toISOString().slice(0, 10);

export const DEFAULT_SITE_URL = "https://kuri-mikan.jp/";

/**
 * GSCのpage URLから記事のslugを取り出す。
 * Shopifyの記事URLは /blogs/<blog>/<handle> で固定される。
 * コレクションや商品ページはここでnullになり、記事の指標として集計されない
 */
export function slugFromPageUrl(page: string): string | null {
  const m = /\/blogs\/[a-z0-9-]+\/([a-z0-9-]+)\/?$/.exec(page);
  return m ? m[1]! : null;
}

/** 記事の公開URLを組み立てる (URL検査に渡す)。 */
export function articleUrl(siteUrl: string, blogHandle: string, slug: string): string {
  return `${siteUrl.replace(/\/$/, "")}/blogs/${blogHandle}/${slug}`;
}

export function mapCoverageState(state: string | undefined): string {
  const s = (state ?? "").toLowerCase();
  if (s.includes("submitted and indexed") || s === "indexed") return "indexed";
  if (s.includes("crawled")) return "crawled_not_indexed";
  if (s.includes("discovered")) return "discovered";
  return "unknown";
}

export async function runGscSync(deps: GscSyncDeps): Promise<GscSyncResult> {
  const saJson = deps.serviceAccountJson ?? process.env.GSC_SERVICE_ACCOUNT_JSON;
  if (!saJson) return { skipped: "GSC_SERVICE_ACCOUNT_JSON未設定", metricRows: 0, inspected: 0 };

  const { store } = deps;
  const f = deps.fetchImpl ?? fetch;
  const now = deps.now?.() ?? new Date();
  // GSCのプロパティURLは末尾スラッシュ付きで登録されているのが普通なので、
  // site_base_url (末尾なし) をそのまま流用せず、正規化して使う
  const configured = await store.getConfig<string>("site_base_url");
  const siteUrl = deps.siteUrl ?? (configured ? `${configured.replace(/\/$/, "")}/` : DEFAULT_SITE_URL);
  const blogHandle = (await store.getConfig<string>("shopify_blog_handle")) ?? "column";
  const token = await getGoogleAccessToken(parseServiceAccount(saJson), [GSC_SCOPE], f);
  const api = async (path: string, body: unknown): Promise<unknown> => {
    const res = await f(path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GSC API失敗 (${path}): ${res.status} ${await res.text()}`);
    return res.json();
  };

  const queryUrl = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

  // 1. page×date (直近3日。GSC側の反映遅延があるため重ねて取得し、upsertで冪等)
  const byDate = (await api(queryUrl, {
    startDate: day(now, -4),
    endDate: day(now, -1),
    dimensions: ["page", "date"],
    rowLimit: 25000,
  })) as { rows?: { keys: [string, string]; clicks: number; impressions: number; ctr: number; position: number }[] };

  const metricRows: GscMetricRow[] = [];
  for (const row of byDate.rows ?? []) {
    const slug = slugFromPageUrl(row.keys[0]);
    if (!slug) continue;
    const article = await store.getArticleBySlug(slug);
    if (!article) continue;
    metricRows.push({
      article_id: article.id,
      date: row.keys[1],
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    });
  }

  // 2. page×query 上位クエリ (直近28日を当日行に添付)
  const byQuery = (await api(queryUrl, {
    startDate: day(now, -28),
    endDate: day(now, -1),
    dimensions: ["page", "query"],
    rowLimit: 5000,
  })) as { rows?: { keys: [string, string]; clicks: number; impressions: number; position: number }[] };

  const queriesByPage = new Map<string, { query: string; impressions: number; clicks: number; position: number }[]>();
  for (const row of byQuery.rows ?? []) {
    const slug = slugFromPageUrl(row.keys[0]);
    if (!slug) continue;
    const list = queriesByPage.get(slug) ?? [];
    list.push({ query: row.keys[1], impressions: row.impressions, clicks: row.clicks, position: row.position });
    queriesByPage.set(slug, list);
  }
  for (const [slug, queries] of queriesByPage) {
    const article = await store.getArticleBySlug(slug);
    if (!article) continue;
    metricRows.push({
      article_id: article.id,
      date: day(now, -1),
      top_queries: queries.sort((a, b) => b.impressions - a.impressions).slice(0, 20),
    });
  }
  await store.upsertGscMetrics(metricRows);

  // 3. URL Inspection サンプリング: 直近28日公開 + ランダム既存10件
  const published = await store.listPublishedArticles();
  const since = new Date(now.getTime() - 28 * 86400_000).toISOString();
  const recent = published.filter((a) => (a.published_at ?? "") >= since);
  const rest = published.filter((a) => !recent.includes(a));
  const sample = [...recent, ...shuffle(rest).slice(0, 10)];
  const inspectionRows: GscMetricRow[] = [];
  for (const article of sample) {
    if (!article.slug) continue;
    const inspection = (await api("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      inspectionUrl: articleUrl(siteUrl, blogHandle, article.slug),
      siteUrl,
    })) as { inspectionResult?: { indexStatusResult?: { coverageState?: string } } };
    inspectionRows.push({
      article_id: article.id,
      date: day(now, 0),
      index_status: mapCoverageState(inspection.inspectionResult?.indexStatusResult?.coverageState),
    });
  }
  await store.upsertGscMetrics(inspectionRows);

  return { metricRows: metricRows.length, inspected: inspectionRows.length };
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
