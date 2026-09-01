// キーワード提案キュー (v3 Sprint 1): 発案器が持ってきたトピック案を代表が承認/却下する。
// 承認 (queued) されたキーワードだけが記事化される。ここが「何を書くか」のトピック承認点。
import {
  approveKeywordAction,
  generateQueuedAction,
  parkQueuedKeywordAction,
  rejectKeywordAction,
  unqueueKeywordAction,
} from "../actions";
import { getStore, notConfiguredMessage, supabaseConfigured } from "../lib/data";

export const dynamic = "force-dynamic";

// 日次cronの生成上限 (cron-daily.yml の DAILY_GENERATE_LIMIT と揃える)
const DAILY_LIMIT = 2;

const CLUSTER_LABEL: Record<string, string> = {
  renewal: "リニューアル",
  production: "制作",
  system_dev: "開発",
  ai_llmo: "AI・LLMO",
};

export default async function KeywordsPage() {
  if (!supabaseConfigured()) return <p>{notConfiguredMessage()}</p>;
  const store = getStore();
  const [proposed, queued] = await Promise.all([
    store.listKeywordsByStatus("proposed"),
    store.listKeywordsByStatus("queued"),
  ]);

  return (
    <main>
      <h2>トピック提案 ({proposed.length})</h2>
      <p style={{ color: "#666", fontSize: 14 }}>
        発案器が既存記事の穴から持ってきたトピック案です。<strong>承認したものだけが記事化</strong>
        されます (記事はさらに承認キューで公開判断)。ここは「何を書くか」を選ぶ最初の承認点です。
      </p>
      {proposed.length === 0 && (
        <p>
          提案待ちのトピックはありません。<code>npm run propose:keywords</code> で発案できます。
        </p>
      )}
      <table style={{ borderCollapse: "collapse", width: "100%" }} border={1} cellPadding={6}>
        <tbody>
          {proposed.map((k) => (
            <tr key={k.id}>
              <td style={{ whiteSpace: "nowrap" }}>
                <span style={{ fontSize: 11, color: "#555" }}>
                  {CLUSTER_LABEL[k.cluster] ?? k.cluster} / {k.article_type} / 優先{k.priority}
                </span>
              </td>
              <td>
                <strong>{k.keyword}</strong>
                <div style={{ fontSize: 13, color: "#666" }}>{k.search_intent}</div>
                {k.rationale && (
                  <div style={{ fontSize: 12, color: "#888" }}>理由: {k.rationale}</div>
                )}
              </td>
              <td style={{ whiteSpace: "nowrap" }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <form action={approveKeywordAction}>
                    <input type="hidden" name="id" value={k.id} />
                    <button type="submit">承認してキューへ</button>
                  </form>
                  <form action={rejectKeywordAction}>
                    <input type="hidden" name="id" value={k.id} />
                    <button type="submit">却下</button>
                  </form>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 28 }}>記事化待ち (queued: {queued.length})</h2>
      <p style={{ color: "#666", fontSize: 14 }}>
        承認済みのトピックです。<strong>毎朝6時に自動で記事化</strong>されます (1日{DAILY_LIMIT}本まで)。
        すぐ書かせたいときは下のボタンを押してください。生成された記事は承認キューに積まれ、
        <strong>公開はされません</strong> (公開の引き金は記事の承認ボタンのみ)。
      </p>
      {queued.length > 0 && (
        <form action={generateQueuedAction} style={{ margin: "12px 0" }}>
          <label style={{ fontSize: 14 }}>
            今すぐ記事化する本数:{" "}
            <input
              type="number"
              name="limit"
              defaultValue={Math.min(3, queued.length)}
              min={1}
              max={Math.min(20, queued.length)}
              style={{ width: 64, padding: 4 }}
            />
          </label>
          <button type="submit" style={{ marginLeft: 12, padding: "6px 16px" }}>
            今すぐ記事化する
          </button>
          <div style={{ fontSize: 12, color: "#888", marginTop: 6 }}>
            1本あたり3〜6分かかるためバックグラウンドで実行します。押した直後は何も起きませんが、
            数分後に承認キューへ順次入ります。
          </div>
        </form>
      )}
      <ul>
        {queued.map((k) => (
          <li key={k.id} style={{ marginBottom: 8 }}>
            {k.keyword}{" "}
            <span style={{ color: "#888", fontSize: 12 }}>
              ({CLUSTER_LABEL[k.cluster] ?? k.cluster} / 優先{k.priority})
            </span>
            <span style={{ marginLeft: 10, display: "inline-flex", gap: 6 }}>
              <form action={unqueueKeywordAction} style={{ display: "inline" }}>
                <input type="hidden" name="id" value={k.id} />
                <button type="submit" style={{ fontSize: 12, padding: "2px 8px" }}>
                  提案に戻す
                </button>
              </form>
              <form action={parkQueuedKeywordAction} style={{ display: "inline" }}>
                <input type="hidden" name="id" value={k.id} />
                <button type="submit" style={{ fontSize: 12, padding: "2px 8px" }}>
                  却下
                </button>
              </form>
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}
