// 月次戦略レポート (v3 Sprint 2): P-16が出した「何が効いたか/次の方針」を代表が読む画面。
// 自律決定(decisions)も提案(proposals)も自動適用せず、ここで確認する。反映は代表の判断。
import type { P16ReportT } from "@kurimikan/pipeline";
import { getStore, notConfiguredMessage, supabaseConfigured } from "../lib/data";

export const dynamic = "force-dynamic";

export default async function StrategyPage() {
  if (!supabaseConfigured()) return <p>{notConfiguredMessage()}</p>;
  const latest = await getStore().getLatestStrategyReport();
  if (!latest) {
    return (
      <main>
        <h2>月次戦略</h2>
        <p>
          まだ戦略レポートがありません。<code>npm run run:strategy</code> で生成できます
          (GSC/GA4のデータを分析してP-16が方針を出します)。
        </p>
      </main>
    );
  }
  const r = latest.report as P16ReportT;

  return (
    <main>
      <h2>月次戦略レポート ({latest.month})</h2>
      <p style={{ color: "#666", fontSize: 14 }}>
        P-16がGSC/GA4を分析した方針です。<strong>自動適用はしません</strong>。
        decisions(自律決定)も proposals(提案)も、代表が確認して反映を判断します。
      </p>

      <section style={{ background: "#eef6ff", padding: 14, borderRadius: 8, margin: "16px 0" }}>
        <h3 style={{ marginTop: 0 }}>5分要約</h3>
        <ul>
          {r.summary_5min.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </section>

      {r.what_worked.length > 0 && (
        <Findings title="効いていること" items={r.what_worked} color="#2f7d63" />
      )}
      {r.what_failed.length > 0 && (
        <Findings title="効いていないこと" items={r.what_failed} color="#c0392b" />
      )}

      {r.decisions.length > 0 && (
        <section style={{ margin: "16px 0" }}>
          <h3>自律決定（代表確認のうえ反映）</h3>
          <ul>
            {r.decisions.map((d, i) => (
              <li key={i} style={{ marginBottom: 6 }}>
                <strong>[{d.type}]</strong> {d.detail}
                <div style={{ fontSize: 12, color: "#888" }}>{d.rationale}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {r.proposals.length > 0 && (
        <section style={{ margin: "16px 0", background: "#fff8e1", padding: 14, borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>提案（人間承認が必要）</h3>
          <ul>
            {r.proposals.map((p, i) => (
              <li key={i} style={{ marginBottom: 8 }}>
                <strong>[{p.type}]</strong> {p.detail}
                <div style={{ fontSize: 12, color: "#666" }}>
                  {p.rationale}
                  {p.gate_check && <> ／ ゲート: {p.gate_check}</>}
                  {p.risk_if_rejected && <> ／ 却下リスク: {p.risk_if_rejected}</>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section style={{ margin: "16px 0" }}>
        <h3>来月の目標</h3>
        <p style={{ fontSize: 14 }}>
          公開 {r.next_month_targets.publish_count}本 ／ レーンB比率{" "}
          {Math.round(r.next_month_targets.lane_b_ratio * 100)}% ／ リライト{" "}
          {r.next_month_targets.rewrite_count}本 ／ 注力: {r.next_month_targets.focus_cluster}
        </p>
      </section>

      {r.uncertainty_flags.length > 0 && (
        <section style={{ margin: "16px 0", color: "#888", fontSize: 13 }}>
          <h4>判断保留（データ不足等）</h4>
          <ul>
            {r.uncertainty_flags.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function Findings({
  title,
  items,
  color,
}: {
  title: string;
  items: { finding: string; evidence: string; action: string }[];
  color: string;
}) {
  return (
    <section style={{ margin: "16px 0" }}>
      <h3 style={{ color }}>{title}</h3>
      <ul>
        {items.map((f, i) => (
          <li key={i} style={{ marginBottom: 6 }}>
            {f.finding}
            <div style={{ fontSize: 12, color: "#888" }}>
              根拠: {f.evidence} ／ 対応: {f.action}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
