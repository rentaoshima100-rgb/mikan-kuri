// 記事プレビュー + 承認/差戻し (v3: 承認者はhuman_review_notesとjudge不一致を確認して判断する)
import type { SerpGap } from "@kurimikan/pipeline";
import type { P04VerdictT } from "@kurimikan/shared";
import { approveAction, sendBackAction } from "../../actions";
import { ApproveGate } from "./ApproveGate";
import { getStore, notConfiguredMessage, supabaseConfigured } from "../../lib/data";

export const dynamic = "force-dynamic";
// 承認・差戻しのサーバアクションがこのルートから実行されるため、サーバレスの既定 (10秒) では途中で切れる。
// Vercelのプラン上限まで引き上げる (Hobby=60秒 / Pro=300秒)。
export const maxDuration = 60;


export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  if (!supabaseConfigured()) return <p>{notConfiguredMessage()}</p>;
  const { id } = await params;
  const store = getStore();
  const article = await store.getArticle(id);
  if (!article) return <p>記事が見つかりません: {id}</p>;

  const quality = article.quality as P04VerdictT | null;
  const notes = quality?.human_review_notes;
  const consensus = article.consensus_result as {
    claims?: Array<{ claim: string; system1: string; system2: string; resolution: string }>;
  } | null;
  const serp = article.serp_gap as SerpGap | null;
  const canDecide = article.status === "approval_pending";
  // 新規記事のタイトルは P-12 がゲート承認の後に生成する。それまでは title が無いので、
  // 構成案の見出し案とキーワードで「何の記事か」を示す (「(無題)」では判断できない)。
  const outlineDraft = (article.outline as { title_draft?: string } | null)?.title_draft;
  const keyword = article.title ? null : await getStore().getKeyword(article.keyword_id);

  return (
    <main>
      <p>
        <a href="/">← 承認キューへ戻る</a>
      </p>
      <h1 style={{ fontSize: 22 }}>{article.title ?? outlineDraft ?? "(タイトル未生成)"}</h1>
      {!article.title && (
        <p style={{ color: "#666", fontSize: 13, marginTop: -8 }}>
          {keyword?.keyword && <>対象キーワード: {keyword.keyword}　</>}
          公開URLと最終タイトルは、ゲート承認の後に生成されます
        </p>
      )}
      <p style={{ color: "#666" }}>
        {article.track === "revision" ? "改修 (既存URLの更新)" : "新規"} / status: {article.status}{" "}
        / 品質{article.quality_score ?? "-"}点 / commodity
        {article.commodity_score ?? "-"} / レーン{article.lane}
        {article.judge_disagreement && (
          <strong style={{ color: "#c0392b" }}> / judge不一致あり</strong>
        )}
      </p>
      {article.expired_reason && (
        <p
          style={{
            background: "#fff3cd",
            border: "1px solid #ffe08a",
            padding: 12,
            borderRadius: 6,
          }}
        >
          <strong>承認が失効しました。</strong> {article.expired_reason}
          <br />
          <span style={{ fontSize: 13, color: "#666" }}>
            内容を確認したうえで、問題なければ再度承認してください。
          </span>
        </p>
      )}
      <p style={{ color: "#666" }}>meta: {article.meta_description ?? "-"}</p>
      <p style={{ color: "#666" }}>
        公開予定URL:{" "}
        {article.revision_of ? (
          <code>(改修: 公開中の記事を書き換えます)</code>
        ) : article.slug ? (
          <code>https://kuri-mikan.jp/blogs/column/{article.slug}</code>
        ) : (
          "(未定)"
        )}
        {article.slug?.startsWith("post-") && (
          <strong style={{ color: "#e67e22", marginLeft: 8 }}>
            自動生成のslugです。内容が読み取れるURLに直す場合は、公開前に差し戻してください
            (公開後の変更はリダイレクトが必要になります)
          </strong>
        )}
      </p>

      {notes && (
        <section style={{ background: "#fff8e1", padding: 12, borderRadius: 6 }}>
          <h3 style={{ marginTop: 0 }}>承認者が確認すべき箇所 (human_review_notes)</h3>
          <p>
            <strong>事実主張:</strong>
          </p>
          <ul>
            {notes.fact_claims.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          <p>
            <strong>独自性の根拠:</strong> {notes.uniqueness_basis}
          </p>
          <p>
            <strong>リスク箇所:</strong>
          </p>
          <ul>
            {notes.risk_areas.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </section>
      )}

      {serp?.checked && serp.verdict ? (
        <section style={{ background: "#e8f4fd", padding: 12, borderRadius: 6, marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>
            SERP差分チェック (参考情報 — 公開判断は承認者が行います)
          </h3>
          <p>
            差別化: <strong>{serp.verdict.differentiation}</strong> / 上位が扱っていない論点を
            {serp.verdict.gaps_filled.length}件カバー
          </p>
          {serp.verdict.gaps_missed.length > 0 && (
            <p>未対応の論点: {serp.verdict.gaps_missed.join(" / ")}</p>
          )}
          <p style={{ color: "#555" }}>{serp.verdict.note_for_reviewer}</p>
          {serp.top_results?.length ? (
            <details>
              <summary style={{ cursor: "pointer" }}>
                検索上位 {serp.top_results.length} 件
              </summary>
              <ol style={{ fontSize: 13 }}>
                {serp.top_results.map((r) => (
                  <li key={r.url}>
                    <a href={r.url} target="_blank" rel="noreferrer">
                      {r.title}
                    </a>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </section>
      ) : null}

      {consensus?.claims?.length ? (
        <section style={{ background: "#fdecea", padding: 12, borderRadius: 6, marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>合議ファクトチェック結果</h3>
          <ul>
            {consensus.claims.map((c, i) => (
              <li key={i}>
                「{c.claim}」 → 系統1: {c.system1} / 系統2: {c.system2} /{" "}
                <strong>{c.resolution}</strong>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 差し戻しは読了前でも行える (問題に気づいた時点で止められるべきなので) */}
      {canDecide && (
        <section style={{ margin: "16px 0" }}>
          <form action={sendBackAction}>
            <input type="hidden" name="id" value={article.id} />
            <input
              type="text"
              name="notes"
              placeholder="差戻し理由 (必須)"
              required
              style={{ marginRight: 8 }}
            />
            <button type="submit" style={{ background: "#c62828", color: "white", padding: "6px 16px" }}>
              差戻し
            </button>
          </form>
        </section>
      )}

      <h3>本文プレビュー</h3>
      <pre
        style={{
          whiteSpace: "pre-wrap",
          background: "#f6f6f6",
          padding: 16,
          borderRadius: 6,
          fontFamily: "inherit",
        }}
      >
        {article.body_mdx ?? "(本文なし)"}
      </pre>

      {/* 承認は本文の下にのみ置き、本文末尾まで表示されて初めて有効になる。
          承認=全文レビューであることが、記事に付く監修表記の根拠であるため */}
      {canDecide && (
        <ApproveGate>
          <section
            style={{
              margin: "16px 0",
              padding: 12,
              border: "1px solid #ddd",
              borderRadius: 6,
            }}
          >
            <form action={approveAction}>
              <input type="hidden" name="id" value={article.id} />
              {article.judge_disagreement && (
                <label style={{ display: "block", marginBottom: 8 }}>
                  <input type="checkbox" name="judgeAck" /> judge不一致の内容を確認しました (必須)
                </label>
              )}
              <input type="text" name="notes" placeholder="メモ (任意)" style={{ marginRight: 8 }} />
              <button
                type="submit"
                style={{ background: "#2e7d32", color: "white", padding: "6px 16px" }}
              >
                承認して公開キューへ
              </button>
              <span style={{ marginLeft: 12, fontSize: 13, color: "#666" }}>
                承認すると監修表記が付き、公開キューへ入ります
              </span>
            </form>
          </section>
        </ApproveGate>
      )}
    </main>
  );
}
