// 内部リンク承認キュー。
//
// inboundリンクの適用は「公開済み記事の書き換え」なので自動実行しない。
// ただしこの案件の設計はコレクションへの内部リンクの集中が前提のため、
// ここで人間が判断する。
//
// この画面は適用後の差分を全文表示するので、記事承認と違い一括承認を許可する
// (本文を見ずに押せる承認ではないため)。
import { listLinkReviewQueue } from "@kurimikan/pipeline";
import { applyLinksAction, rejectLinkAction } from "../actions";
import {
  getStore,
  notConfiguredMessage,
  shopifyConfigured,
  supabaseConfigured,
} from "../lib/data";

export const dynamic = "force-dynamic";

export default async function LinksPage() {
  if (!supabaseConfigured()) return <p>{notConfiguredMessage()}</p>;

  // 承認するとShopify上の公開済み記事が書き換わる。トークンが無い環境では
  // 差分の確認まではできるが適用はできないので、そのことを先に伝える。
  const canApply = shopifyConfigured();

  const items = await listLinkReviewQueue({ store: getStore() });
  const actionable = items.filter((i) => i.diff?.inserted);
  const blocked = items.filter((i) => !i.diff?.inserted);

  return (
    <main>
      <h2>内部リンク承認キュー ({items.length}件)</h2>
      <p style={{ color: "#666", fontSize: 14 }}>
        新しい記事へのリンクを、既存の公開済み記事に差し込む提案です。
        適用すると<strong>公開済みの記事が書き換わる</strong>ため、自動では反映しません。
        下に適用後の差分が出るので、内容を確認して承認してください。
        差分が見えているため<strong>まとめて承認できます</strong>。
      </p>

      {!canApply && (
        <p style={{ color: "#a33", fontSize: 14 }}>
          SHOPIFY_SHOP / SHOPIFY_ADMIN_TOKEN が未設定のため、差分の確認のみ行えます。
          承認するとShopify上の記事が書き換わるため、設定済みの環境で操作してください。
        </p>
      )}

      {actionable.length > 0 && canApply && (
        <form action={applyLinksAction}>
          <div style={{ margin: "16px 0" }}>
            <button
              type="submit"
              style={{ background: "#2e7d32", color: "white", padding: "8px 20px" }}
            >
              チェックした提案をまとめて承認・反映
            </button>
            <span style={{ marginLeft: 12, fontSize: 13, color: "#666" }}>
              承認するとサイトへコミットされ、対象記事のprerenderスナップショットも破棄されます
            </span>
          </div>

          {actionable.map(({ link, targetArticle, diff }) => (
            <section
              key={link.id}
              style={{ border: "1px solid #ddd", borderRadius: 6, padding: 12, marginBottom: 16 }}
            >
              <label style={{ display: "block", marginBottom: 8 }}>
                <input type="checkbox" name="linkIds" value={link.id} defaultChecked />{" "}
                <strong>{targetArticle?.title ?? "(無題)"}</strong> に挿入
              </label>
              <p style={{ fontSize: 13, color: "#555", margin: "4px 0" }}>
                リンク先: <code>{link.target_url}</code> / アンカー: 「{link.anchor}」
                {link.insert_hint && <> / 挿入箇所: {link.insert_hint}</>}
              </p>
              <pre
                style={{
                  background: "#f6f6f6",
                  padding: 12,
                  borderRadius: 6,
                  fontSize: 13,
                  whiteSpace: "pre-wrap",
                  fontFamily: "inherit",
                }}
              >
                {diff!.contextBefore.map((l, i) => (
                  <span key={`b${i}`} style={{ color: "#888" }}>
                    {"  "}
                    {l}
                    {"\n"}
                  </span>
                ))}
                <span style={{ background: "#e6ffed", color: "#22863a", fontWeight: 600 }}>
                  {"+ "}
                  {diff!.changedLine}
                  {"\n"}
                </span>
                {diff!.contextAfter.map((l, i) => (
                  <span key={`a${i}`} style={{ color: "#888" }}>
                    {"  "}
                    {l}
                    {"\n"}
                  </span>
                ))}
              </pre>
              <details>
                <summary style={{ cursor: "pointer", fontSize: 13 }}>適用後の本文全体を見る</summary>
                <pre
                  style={{
                    background: "#fafafa",
                    padding: 12,
                    borderRadius: 6,
                    fontSize: 12,
                    whiteSpace: "pre-wrap",
                    maxHeight: 400,
                    overflow: "auto",
                    fontFamily: "inherit",
                  }}
                >
                  {diff!.after}
                </pre>
              </details>
            </section>
          ))}
        </form>
      )}

      {actionable.length === 0 && <p>承認できる提案はありません。</p>}

      {blocked.length > 0 && (
        <>
          <h3>適用できない提案 ({blocked.length}件)</h3>
          <ul>
            {blocked.map(({ link, diff, error }) => (
              <li key={link.id} style={{ marginBottom: 8 }}>
                <code>{link.target_url}</code> / 「{link.anchor}」
                <span style={{ color: "#c0392b", marginLeft: 8 }}>
                  {error ?? diff?.reason ?? "挿入位置を決められません"}
                </span>
                <form action={rejectLinkAction} style={{ display: "inline", marginLeft: 12 }}>
                  <input type="hidden" name="id" value={link.id} />
                  <input type="text" name="notes" placeholder="却下理由" required size={16} />
                  <button type="submit">却下</button>
                </form>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
