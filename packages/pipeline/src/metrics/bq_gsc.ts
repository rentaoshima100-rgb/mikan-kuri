// GSC Bulk Data Export (BigQuery) からの取り込み。
//
// なぜ Search Analytics API と別に要るのか:
//   API 版には3つの欠損がある。
//     1. 16か月で消える
//     2. 1リクエスト25,000行・検索タイプごとの上限で切られる
//     3. **検索数の少ないクエリは匿名化され、個票が返らない**
//   月間インプレッションが1,000規模のサイトでは 3 の影響が最も大きく、
//   「何で検索されて表示されたか」の相当部分が API 版では最初から見えない。
//   Bulk Export は匿名化クエリも集計値として含むため、API 版との差分から
//   「自分に見えていない検索がどれだけあるか」を定量化できる。
//
// 重要: Bulk Export は**設定した日以降の分しか貯まらない**。過去は遡れない。
//
// 依存を増やさないため、BigQuery は REST の jobs.query を直接叩く。
import { getGoogleAccessToken, parseServiceAccount, type ServiceAccount } from "./google_auth.js";

// GSCが自動生成するデータセット名 (固定)
const DATASET = "searchconsole";
const BQ_SCOPE = "https://www.googleapis.com/auth/bigquery";

export interface BqDeps {
  serviceAccountJson: string;
  projectId?: string;
  fetchImpl?: typeof fetch;
}

interface QueryRow {
  f: { v: string | null }[];
}

interface QueryResponse {
  jobComplete?: boolean;
  rows?: QueryRow[];
  schema?: { fields: { name: string }[] };
  totalBytesProcessed?: string;
  error?: { message: string };
  errors?: { message: string }[];
}

function projectOf(deps: BqDeps): string {
  if (deps.projectId) return deps.projectId;
  const id = (JSON.parse(deps.serviceAccountJson) as { project_id?: string }).project_id;
  if (!id) throw new Error("サービスアカウントJSONに project_id がありません");
  return id;
}

// BigQuery の同期クエリ。パラメータ化クエリのみ使う (SQL組み立てをしない)。
export async function runQuery(
  deps: BqDeps,
  sql: string,
  params: Record<string, string | number> = {},
): Promise<Record<string, string | null>[]> {
  const sa: ServiceAccount = parseServiceAccount(deps.serviceAccountJson);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = await getGoogleAccessToken(sa, [BQ_SCOPE], fetchImpl);
  const project = projectOf(deps);

  const res = await fetchImpl(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: sql,
        useLegacySql: false,
        // 取り込みは日次バッチなので、待たせてでも同期で受け取る
        timeoutMs: 60_000,
        parameterMode: "NAMED",
        queryParameters: Object.entries(params).map(([name, value]) => ({
          name,
          parameterType: { type: typeof value === "number" ? "INT64" : "STRING" },
          parameterValue: { value: String(value) },
        })),
      }),
    },
  );

  const body = (await res.json().catch(() => ({}))) as QueryResponse;
  if (!res.ok) {
    const msg = body.error?.message ?? `HTTP ${res.status}`;
    // データセット未作成は「設定がまだ」であって障害ではない。呼び出し側で判別できるようにする
    if (res.status === 404 || /not found/i.test(msg)) {
      throw new BqNotConfiguredError(msg);
    }
    throw new Error(`BigQueryクエリ失敗: ${msg}`);
  }
  if (body.jobComplete === false) {
    throw new Error("BigQueryクエリがタイムアウトしました (60秒)");
  }

  const names = (body.schema?.fields ?? []).map((f) => f.name);
  return (body.rows ?? []).map((r) => {
    const out: Record<string, string | null> = {};
    names.forEach((n, i) => {
      out[n] = r.f[i]?.v ?? null;
    });
    return out;
  });
}

// エクスポート未設定 (データセットが無い) ことを、障害と区別するための型。
// 設定は人間がSearch Console画面で行うため、未設定の間はスキップして先へ進む。
export class BqNotConfiguredError extends Error {
  constructor(message: string) {
    super(`GSCの一括データエクスポートが未設定です: ${message}`);
    this.name = "BqNotConfiguredError";
  }
}

export interface QueryStat {
  date: string;
  query: string;
  impressions: number;
  clicks: number;
  position: number;
  // 匿名化されたクエリかどうか。GSCは検索数の少ないクエリを is_anonymized_query=true で
  // まとめて返し、query は空になる。API版ではこの行自体が見えない
  anonymized: boolean;
}

// 指定日のクエリ別実績。匿名化分も含めて取る。
export async function fetchQueryStats(deps: BqDeps, date: string): Promise<QueryStat[]> {
  const project = projectOf(deps);
  const rows = await runQuery(
    deps,
    `SELECT
       data_date,
       IFNULL(query, '') AS query,
       is_anonymized_query,
       SUM(impressions) AS impressions,
       SUM(clicks) AS clicks,
       SAFE_DIVIDE(SUM(sum_position), NULLIF(SUM(impressions), 0)) + 1 AS position
     FROM \`${project}.${DATASET}.searchdata_site_impression\`
     WHERE data_date = @d
     GROUP BY data_date, query, is_anonymized_query
     ORDER BY impressions DESC`,
    { d: date },
  );
  return rows.map((r) => ({
    date: r.data_date ?? date,
    query: r.query ?? "",
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
    position: Number(r.position ?? 0),
    anonymized: r.is_anonymized_query === "true",
  }));
}

export interface AnonymizedShare {
  date: string;
  totalImpressions: number;
  anonymizedImpressions: number;
  // 匿名化されて個票が見えない割合。API版だけを見ていると失っている情報量
  anonymizedRatio: number;
  visibleQueries: number;
}

// 「API版では見えていない検索がどれだけあるか」を数字にする。
// これが Bulk Export を入れる主目的なので、取り込みの成果として毎回記録する。
export function summarizeAnonymized(stats: QueryStat[], date: string): AnonymizedShare {
  const total = stats.reduce((n, s) => n + s.impressions, 0);
  const anon = stats.filter((s) => s.anonymized).reduce((n, s) => n + s.impressions, 0);
  return {
    date,
    totalImpressions: total,
    anonymizedImpressions: anon,
    anonymizedRatio: total === 0 ? 0 : Math.round((anon / total) * 1000) / 1000,
    visibleQueries: stats.filter((s) => !s.anonymized && s.query).length,
  };
}
