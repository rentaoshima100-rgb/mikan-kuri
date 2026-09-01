// 順位監視の内製 (代表指示 2026-08-14)。
// 外部の順位チェックツール (GRC/Nobilista等) を契約する代わりに、既に使っている
// DataForSEO SERP APIで追跡キーワードの自社順位を日次取得して rank_snapshots へ記録する。
//
// GSCとの役割分担:
//   GSC     = 実際に表示されたクエリの平均掲載順位 (表示されなかった日はデータ自体が無い)
//   こちら  = 狙ったキーワードの定点観測。圏外 (position=null) も毎日記録される
//
// コスト: SERP live regular は1リクエスト約$0.002。既定の上限30KW×毎日で月$2弱、
// 既存のDataForSEO入金 ($50) の範囲に収まる。LLMは使わない。
//
// 追跡対象 = pipeline_config.rank_watch.keywords (手動指定、優先) + 公開済み記事の
// キーワード (自動)。改修 (refit:) は検索クエリではない内部IDなので対象外。
// 実行は cron-daily (計測ステップ) と scripts/rank_watch.ts (手動)。
import type { RankSnapshotRow, Store } from "../db/types.js";

export interface RankWatchConfig {
  enabled?: boolean; // 既定true (credsが無ければどのみちスキップ)
  target_domain?: string; // 既定 kuri-mikan.jp
  keywords?: string[]; // 手動指定の追跡キーワード (自動選出より優先)
  max_keywords?: number; // 1日に調べる上限 (コスト上限。既定30)
}

export interface RankWatchDeps {
  store: Store;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  credentials?: { login: string; password: string }; // 既定: env DATAFORSEO_LOGIN/PASSWORD
}

export interface RankWatchResult {
  skipped?: string;
  checked: number; // 調べたキーワード数
  ranked: number; // 100位以内に見つかった数
  errors: number; // 取得失敗 (続行した) 数
}

const DEFAULT_TARGET_DOMAIN = "kuri-mikan.jp";
const DEFAULT_MAX_KEYWORDS = 30;

// 測定日はJST基準。cron-dailyはJST 6:00 (=前日21:00 UTC) に走るため、
// UTC日付を使うと「JSTの今日」の測定が前日の行に入ってしまう
export function jstDate(now: Date): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

// SERPのURLが自社ドメインかどうか (サブドメイン・wwwも自社扱い)
export function isOwnUrl(url: string, targetDomain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const target = targetDomain.toLowerCase();
    return host === target || host.endsWith(`.${target}`);
  } catch {
    return false;
  }
}

interface SerpItem {
  type: string;
  rank_group?: number;
  url?: string;
}

// SERP上位100件から自社の最上位ヒットを探す。無ければnull (=圏外)
export function extractOwnRank(
  items: SerpItem[],
  targetDomain: string,
): { position: number; url: string } | null {
  for (const item of items) {
    if (item.type !== "organic" || !item.url) continue;
    if (isOwnUrl(item.url, targetDomain)) {
      return { position: item.rank_group ?? 0, url: item.url };
    }
  }
  return null;
}

// 追跡キーワードの選出。手動指定を先頭に、公開済み記事のキーワードで埋める。
// 上限はコスト上限を兼ねる (超過分は静かに切らずログで見えるよう戻り値に含める)
export async function pickTrackedKeywords(
  store: Store,
  config: RankWatchConfig,
): Promise<{ keywords: string[]; overflow: number }> {
  const max = config.max_keywords ?? DEFAULT_MAX_KEYWORDS;
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (kw: string) => {
    const key = kw.replace(/\s+/g, "").toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(kw);
  };

  for (const kw of config.keywords ?? []) add(kw);

  // 公開済み記事のキーワード (公開が新しい順ではなくID順だが、上限に収まる想定)。
  // refit: は検索クエリではない内部IDなので追跡しない (実クエリはGSCが拾う)
  for (const article of await store.listPublishedArticles()) {
    const kw = await store.getKeyword(article.keyword_id);
    if (kw && !kw.keyword.startsWith("refit:")) add(kw.keyword);
  }

  return { keywords: out.slice(0, max), overflow: Math.max(0, out.length - max) };
}

async function fetchSerpTop100(
  keyword: string,
  credentials: { login: string; password: string },
  fetchImpl: typeof fetch,
): Promise<SerpItem[]> {
  const auth = Buffer.from(`${credentials.login}:${credentials.password}`).toString("base64");
  const res = await fetchImpl("https://api.dataforseo.com/v3/serp/google/organic/live/regular", {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
    body: JSON.stringify([
      { keyword, language_code: "ja", location_code: 2392, depth: 100 }, // 2392 = Japan
    ]),
  });
  if (!res.ok) throw new Error(`DataForSEO SERP取得失敗: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    tasks?: { result?: { items?: SerpItem[] }[] }[];
  };
  return data.tasks?.[0]?.result?.[0]?.items ?? [];
}

export async function runRankWatch(deps: RankWatchDeps): Promise<RankWatchResult> {
  const { store } = deps;
  const config = (await store.getConfig<RankWatchConfig>("rank_watch")) ?? {};
  // 既定は有効。configが未投入でも、credsが無ければ下でスキップされるだけなので安全
  if (config.enabled === false) {
    return { skipped: "rank_watch.enabled=false", checked: 0, ranked: 0, errors: 0 };
  }
  const credentials = deps.credentials ?? {
    login: process.env.DATAFORSEO_LOGIN ?? "",
    password: process.env.DATAFORSEO_PASSWORD ?? "",
  };
  if (!credentials.login || !credentials.password) {
    return { skipped: "DATAFORSEO_LOGIN/PASSWORD未設定", checked: 0, ranked: 0, errors: 0 };
  }

  const { keywords, overflow } = await pickTrackedKeywords(store, config);
  if (keywords.length === 0) {
    return { skipped: "追跡キーワードなし (公開記事0本・手動指定なし)", checked: 0, ranked: 0, errors: 0 };
  }
  if (overflow > 0) {
    console.warn(
      `[rank_watch] 追跡候補が上限を超過: ${overflow}件を切り捨て (rank_watch.max_keywordsで調整可)`,
    );
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const target = config.target_domain ?? DEFAULT_TARGET_DOMAIN;
  const date = jstDate(deps.now?.() ?? new Date());
  const result: RankWatchResult = { checked: 0, ranked: 0, errors: 0 };
  const rows: RankSnapshotRow[] = [];

  for (const keyword of keywords) {
    // 1件の失敗 (レート制限・通信断) で全体を止めない
    try {
      const items = await fetchSerpTop100(keyword, credentials, fetchImpl);
      const own = extractOwnRank(items, target);
      rows.push({
        keyword,
        date,
        position: own?.position ?? null,
        found_url: own?.url ?? null,
      });
      result.checked++;
      if (own) result.ranked++;
    } catch (e) {
      result.errors++;
      console.warn(`[rank_watch] 取得失敗 (続行): ${keyword} — ${e}`);
    }
  }
  await store.upsertRankSnapshots(rows);
  return result;
}

// 管理画面 (/ops) 向けの集計: キーワードごとに最新順位と前回・7日前との差分を出す
export interface RankSummaryRow {
  keyword: string;
  position: number | null; // 最新 (null=圏外)
  date: string;
  prevPosition: number | null; // 1つ前の測定 (差分表示用)
  weekAgoPosition: number | null; // 7日以上前で最も新しい測定
  foundUrl: string | null;
}

export function summarizeRanks(snapshots: RankSnapshotRow[]): RankSummaryRow[] {
  const byKeyword = new Map<string, RankSnapshotRow[]>();
  for (const s of snapshots) {
    const rows = byKeyword.get(s.keyword);
    if (rows) rows.push(s);
    else byKeyword.set(s.keyword, [s]);
  }
  const out: RankSummaryRow[] = [];
  for (const [keyword, rows] of byKeyword) {
    rows.sort((a, b) => b.date.localeCompare(a.date)); // 新しい順
    const latest = rows[0]!;
    const weekAgoDate = new Date(new Date(`${latest.date}T00:00:00Z`).getTime() - 7 * 86400_000)
      .toISOString()
      .slice(0, 10);
    out.push({
      keyword,
      position: latest.position,
      date: latest.date,
      prevPosition: rows[1]?.position ?? null,
      weekAgoPosition: rows.find((r) => r.date <= weekAgoDate)?.position ?? null,
      foundUrl: latest.found_url ?? null,
    });
  }
  // 上位が上、圏外は下
  out.sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
  return out;
}
