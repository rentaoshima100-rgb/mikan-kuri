// キーワード需要データ (v3 Sprint 2, プラットフォーム①)。
// DataForSEO Keywords Data で実際の月間検索ボリューム/競合度を取得し、発案器の提案を
// 「勘」から「実需要」に裏付ける。DATAFORSEO_LOGIN/PASSWORD 未設定時はスキップ (従来動作)。
export interface KeywordVolume {
  volume: number; // 月間検索ボリューム
  competition: number | null; // 0-1 (低いほど狙いやすい)
}

// DataForSEOの検索ボリュームを一括取得。creds無しなら空を返す (呼び出し側で従来動作)。
export async function fetchSearchVolumes(
  keywords: string[],
  credentials: { login: string; password: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, KeywordVolume>> {
  if (keywords.length === 0 || !credentials.login || !credentials.password) return {};
  const auth = Buffer.from(`${credentials.login}:${credentials.password}`).toString("base64");
  const res = await fetchImpl(
    "https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live",
    {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
      body: JSON.stringify([{ keywords, language_code: "ja", location_code: 2392 }]), // 2392=Japan
    },
  );
  if (!res.ok) throw new Error(`DataForSEO Keywords Data失敗: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    tasks?: {
      result?: { keyword?: string; search_volume?: number | null; competition?: number | null }[];
    }[];
  };
  const rows = data.tasks?.[0]?.result ?? [];
  const out: Record<string, KeywordVolume> = {};
  for (const r of rows) {
    if (r.keyword) {
      out[r.keyword] = { volume: r.search_volume ?? 0, competition: r.competition ?? null };
    }
  }
  return out;
}

// 検索ボリュームを0-100の需要スコアに変換 (対数。10→~33, 100→~50, 1000→~66, 10000→~83)。
export function volumeToScore(volume: number): number {
  if (volume <= 0) return 0;
  return Math.min(100, Math.round((Math.log10(volume) / 5) * 100));
}

// env からDataForSEO認証を読む (無ければnull)。
export function dataForSeoCredsFromEnv(): { login: string; password: string } | null {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  return login && password ? { login, password } : null;
}
