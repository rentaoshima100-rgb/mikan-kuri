// 運用ページ: トリップワイヤ状態と解除 (M12⑦) + AI経由CVカウンタ (v3多重計測) + 順位監視。
// haltの解除は必ず人間 (このページのボタンのみ)。
import { aiCvStatus, summarizeRanks, type RankSummaryRow } from "@kurimikan/pipeline";
import {
  fileManualActionAction,
  recordReferrerCvAction,
  recordSelfReportCvAction,
  resolveTripwireAction,
} from "../actions";
import { getStore, notConfiguredMessage, supabaseConfigured } from "../lib/data";

export const dynamic = "force-dynamic";

// 順位は小さいほど良いので、差分は「前 - 今」で正=改善
function rankDelta(now: number | null, before: number | null): string {
  if (before === null || now === null) return "";
  const d = before - now;
  if (d === 0) return "→";
  return d > 0 ? `↑${d}` : `↓${-d}`;
}

function deltaColor(now: number | null, before: number | null): string {
  if (before === null || now === null) return "#999";
  return before - now > 0 ? "#2e7d32" : before - now < 0 ? "#c0392b" : "#999";
}

const SOURCE_LABEL: Record<string, string> = {
  ga4_channel: "GA4",
  self_report: "自己申告",
  referrer_log: "リファラログ",
};

const SEVERITY_COLOR: Record<string, string> = {
  halt: "#c0392b",
  throttle: "#e67e22",
  info: "#7f8c8d",
};

export default async function OpsPage() {
  if (!supabaseConfigured()) return <p>{notConfiguredMessage()}</p>;
  const store = getStore();
  const since = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
  const [tripwires, cv, rankRows] = await Promise.all([
    store.listAllTripwires(),
    aiCvStatus(store),
    store.listRankSnapshotsSince(since),
  ]);
  const unresolved = tripwires.filter((t) => !t.resolved);
  const ranks: RankSummaryRow[] = summarizeRanks(rankRows);

  return (
    <main>
      <h2>トリップワイヤ</h2>
      <form action={fileManualActionAction} style={{ marginBottom: 16 }}>
        <input type="text" name="note" placeholder="通知内容のメモ" required style={{ marginRight: 8 }} />
        <button type="submit" style={{ background: "#c0392b", color: "white", padding: "6px 16px" }}>
          手動対策通知を受領 (全公開停止)
        </button>
      </form>
      {unresolved.length === 0 && <p>未解決のトリップワイヤはありません。</p>}
      <ul>
        {unresolved.map((t) => (
          <li key={t.id} style={{ marginBottom: 8 }}>
            <strong style={{ color: SEVERITY_COLOR[t.severity] }}>[{t.severity}]</strong>{" "}
            {t.event_type}
            <span style={{ color: "#666", marginLeft: 8, fontSize: 13 }}>
              {JSON.stringify(t.detail ?? {})} {t.auto_action_taken ?? ""}
            </span>
            <form action={resolveTripwireAction} style={{ display: "inline", marginLeft: 12 }}>
              <input type="hidden" name="id" value={t.id} />
              <button type="submit">解除する (人間の判断)</button>
            </form>
          </li>
        ))}
      </ul>
      {tripwires.some((t) => t.resolved) && (
        <details>
          <summary style={{ color: "#666" }}>解決済み ({tripwires.filter((t) => t.resolved).length})</summary>
          <ul>
            {tripwires
              .filter((t) => t.resolved)
              .map((t) => (
                <li key={t.id} style={{ color: "#999" }}>
                  [{t.severity}] {t.event_type} ({t.created_at?.slice(0, 10)})
                </li>
              ))}
          </ul>
        </details>
      )}

      <h2 style={{ marginTop: 32 }}>AI経由CVカウンタ (多重計測)</h2>
      <p style={{ marginBottom: 4 }}>
        累計 <strong style={{ fontSize: 20 }}>{cv.total}</strong> 件 / 凍結解除ライン{" "}
        {cv.unfreezeMin}〜{cv.unfreezeMax}件
        {cv.proposable ? (
          <strong style={{ color: "#2e7d32", marginLeft: 8 }}>
            解除提案可能な水準です (実行は月次レポートのproposals承認で)
          </strong>
        ) : (
          <span style={{ color: "#666", marginLeft: 8 }}>AI・LLMO配分の増枠は凍結中</span>
        )}
      </p>
      <p style={{ fontSize: 13, color: "#555", marginTop: 0 }}>
        系統別の内訳:{" "}
        {Object.keys(cv.bySource).length === 0
          ? "まだ計測されていません"
          : Object.entries(cv.bySource)
              .map(([source, n]) => `${SOURCE_LABEL[source] ?? source} ${n}件`)
              .join(" / ")}
        <br />
        GA4分は「AI Assistantsチャネル」と「リファラ正規表現」の大きい方を採用しています。
        両系統が別々のセッションを拾っている場合は過少計上になるため、
        凍結解除を判断する前に cron-monthly のログ (ai_cv_breakdown) で重複度を確認してください。
      </p>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <form action={recordSelfReportCvAction} style={{ border: "1px solid #ddd", padding: 12, borderRadius: 6 }}>
          <strong>自己申告CVを記録</strong>
          <p style={{ fontSize: 13, color: "#666", margin: "4px 0" }}>
            問い合わせの「きっかけ: AIチャット」を受領したら1件記録
          </p>
          <input type="date" name="date" required style={{ marginRight: 8 }} />
          <input type="text" name="note" placeholder="メモ (任意)" style={{ marginRight: 8 }} />
          <button type="submit">+1件</button>
        </form>
        <form action={recordReferrerCvAction} style={{ border: "1px solid #ddd", padding: 12, borderRadius: 6 }}>
          <strong>リファラログ集計を記録</strong>
          <p style={{ fontSize: 13, color: "#666", margin: "4px 0" }}>
            VercelログのAIドメイン経由CV集計値を投入
          </p>
          <input type="date" name="date" required style={{ marginRight: 8 }} />
          <input type="number" name="count" min={1} required style={{ width: 60, marginRight: 8 }} />
          <button type="submit">記録</button>
        </form>
      </div>

      <h2 style={{ marginTop: 32 }}>順位監視 (DataForSEO内製)</h2>
      {ranks.length === 0 ? (
        <p style={{ color: "#666" }}>
          記録がまだありません。cron-daily の計測ステップ、または{" "}
          <code>npx tsx scripts/rank_watch.ts</code> が取得します
          (要 DATAFORSEO_LOGIN/PASSWORD)。
        </p>
      ) : (
        <>
          <p style={{ fontSize: 13, color: "#555", marginTop: 0 }}>
            {ranks[0]!.date} 時点。追跡対象は公開済み記事のキーワード (自動) +{" "}
            pipeline_config.rank_watch.keywords (手動指定)。圏外 = 100位以内に自社なし。
          </p>
          <table style={{ borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr>
                {["順位", "前回比", "7日前比", "キーワード", "ヒットしたページ"].map((h) => (
                  <th
                    key={h}
                    style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "4px 12px 4px 0" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ranks.map((r) => (
                <tr key={r.keyword}>
                  <td style={{ padding: "4px 12px 4px 0", fontWeight: "bold" }}>
                    {r.position === null ? "圏外" : `${r.position}位`}
                  </td>
                  <td style={{ padding: "4px 12px 4px 0", color: deltaColor(r.position, r.prevPosition) }}>
                    {rankDelta(r.position, r.prevPosition)}
                  </td>
                  <td style={{ padding: "4px 12px 4px 0", color: deltaColor(r.position, r.weekAgoPosition) }}>
                    {rankDelta(r.position, r.weekAgoPosition)}
                  </td>
                  <td style={{ padding: "4px 12px 4px 0" }}>{r.keyword}</td>
                  <td style={{ padding: "4px 12px 4px 0", fontSize: 12, color: "#666" }}>
                    {r.foundUrl ? new URL(r.foundUrl).pathname : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
