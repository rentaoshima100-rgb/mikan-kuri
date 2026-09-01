// M7 ga4_sync (cron-monthly)。
// GA4 Data API: チャネル別セッション (AI Assistantsチャネル + カスタム正規表現の
// リファラ別集計) と主要CVイベント数を取得し、月初日行に集約保存。
// AI経由CVは ai_cv_events (source=ga4_channel) にも記録する (多重計測の1系統目)。
import type { Store } from "../db/types.js";
import { getGoogleAccessToken, parseServiceAccount } from "./google_auth.js";

const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

// v3指定のカスタム正規表現 (referrer別集計)
export const AI_REFERRER_REGEX =
  "chatgpt\\.com|perplexity\\.ai|claude\\.ai|gemini\\.google\\.com|copilot\\.microsoft\\.com";

export interface Ga4SyncDeps {
  store: Store;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  propertyId?: string; // 既定: env GA4_PROPERTY_ID
  serviceAccountJson?: string; // 既定: env GA4_SERVICE_ACCOUNT_JSON
}

export interface Ga4SourceRow {
  source: string;
  sessions: number;
  conversions: number;
}

// 2系統の内訳。採用値は max だが、両系統が互いに素な集合を拾っている場合は
// 過少計上になる。後から重複度を検証できるよう、系統ごとの内訳を残す。
export interface AiCvBreakdown {
  period: string;
  adopted: "channel" | "referrer_regex" | "tie";
  channel: { sessions: number; conversions: number; rows: Ga4SourceRow[] };
  referrer_regex: { sessions: number; conversions: number; rows: Ga4SourceRow[] };
  note: string;
}

export interface Ga4SyncResult {
  skipped?: string;
  aiSessions: number;
  aiConversions: number;
  breakdown?: AiCvBreakdown;
}

function previousMonthRange(now: Date): { start: string; end: string; monthFirst: string } {
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(first), end: iso(last), monthFirst: iso(first) };
}

export async function runGa4Sync(deps: Ga4SyncDeps): Promise<Ga4SyncResult> {
  const propertyId = deps.propertyId ?? process.env.GA4_PROPERTY_ID;
  const saJson = deps.serviceAccountJson ?? process.env.GA4_SERVICE_ACCOUNT_JSON;
  if (!propertyId || !saJson) {
    return { skipped: "GA4_PROPERTY_ID / GA4_SERVICE_ACCOUNT_JSON未設定", aiSessions: 0, aiConversions: 0 };
  }

  const { store } = deps;
  const f = deps.fetchImpl ?? fetch;
  const now = deps.now?.() ?? new Date();
  const { start, end, monthFirst } = previousMonthRange(now);
  const token = await getGoogleAccessToken(parseServiceAccount(saJson), [GA4_SCOPE], f);

  const runReport = async (body: unknown): Promise<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }> => {
    const res = await f(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GA4 API失敗: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>;
  };

  // 1. AI Assistantsチャネル (GA4標準チャネルグループ)
  const byChannel = await runReport({
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "sessions" }, { name: "keyEvents" }],
  });
  let aiSessions = 0;
  let aiConversions = 0;
  const channelRows: Ga4SourceRow[] = [];
  for (const row of byChannel.rows ?? []) {
    const channel = row.dimensionValues[0]?.value ?? "";
    if (/ai assistants|ai chat/i.test(channel)) {
      const s = Number(row.metricValues[0]?.value ?? 0);
      const c = Number(row.metricValues[1]?.value ?? 0);
      aiSessions += s;
      aiConversions += c;
      channelRows.push({ source: channel, sessions: s, conversions: c });
    }
  }

  // 2. カスタム正規表現によるリファラ別集計 (チャネル分類漏れの補完)
  const byReferrer = await runReport({
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: "sessionSource" }],
    metrics: [{ name: "sessions" }, { name: "keyEvents" }],
    dimensionFilter: {
      filter: {
        fieldName: "sessionSource",
        stringFilter: { matchType: "PARTIAL_REGEXP", value: AI_REFERRER_REGEX },
      },
    },
  });
  let regexSessions = 0;
  let regexConversions = 0;
  const referrerRows: Ga4SourceRow[] = [];
  for (const row of byReferrer.rows ?? []) {
    const s = Number(row.metricValues[0]?.value ?? 0);
    const c = Number(row.metricValues[1]?.value ?? 0);
    regexSessions += s;
    regexConversions += c;
    referrerRows.push({
      source: row.dimensionValues[0]?.value ?? "(unknown)",
      sessions: s,
      conversions: c,
    });
  }

  // 2系統の大きい方を採用 (二重計上を避けつつ分類漏れを補完)。
  // ただし両系統が互いに素な集合を拾っている場合は過少計上になるため、
  // 判断材料として内訳を必ず残す (カウンタの値自体は max のまま)。
  const sessions = Math.max(aiSessions, regexSessions);
  const conversions = Math.max(aiConversions, regexConversions);
  const breakdown: AiCvBreakdown = {
    period: `${start}..${end}`,
    adopted:
      regexConversions > aiConversions
        ? "referrer_regex"
        : aiConversions > regexConversions
          ? "channel"
          : "tie",
    channel: { sessions: aiSessions, conversions: aiConversions, rows: channelRows },
    referrer_regex: { sessions: regexSessions, conversions: regexConversions, rows: referrerRows },
    note:
      "採用値は2系統のmax。両系統が互いに素なら過少計上の可能性があるため、" +
      "rowsで重複度を後から検証すること (AI・LLMO凍結解除の判断材料)",
  };
  // 運用ログ (cron-monthlyのActions出力に残る)
  console.log(JSON.stringify({ job: "ga4_sync", event: "ai_cv_breakdown", ...breakdown }));

  // 月初日行に集約保存 (SPEC M7)。
  // 再実行での二重計上を防ぐため、当該月の行を消してから入れ直す。
  // (article_id=null の行は unique(article_id, date) では重複排除されない。
  //  AI経由CVの累計はAI・LLMO凍結解除の判定に使われるため、水増しは判断を誤らせる)
  await store.deleteSiteWideGscMetric(monthFirst);
  await store.upsertGscMetrics([
    { article_id: null, date: monthFirst, ai_channel_sessions: sessions },
  ]);
  await store.deleteAiCvEvents(monthFirst, "ga4_channel");
  // conversions=0 でも行を残す。この行が「その月のAI経由CV計測記録」であり、
  // detailの内訳が後の重複度検証と凍結解除判断のエビデンスになる (合計は0加算で不変)
  await store.insertAiCvEvent({
    occurred_on: monthFirst,
    source: "ga4_channel",
    count: conversions,
    detail: breakdown,
  });
  return { aiSessions: sessions, aiConversions: conversions, breakdown };
}
