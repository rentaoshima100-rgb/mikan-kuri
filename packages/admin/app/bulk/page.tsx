// 一括レビュー画面 (v3 Day 2): 承認待ちを表形式で素早く処理する。
// judge不一致付きは一括画面では承認できない (詳細画面でackが必要)。
import type { P04VerdictT } from "@kurimikan/shared";
import { sendBackAction } from "../actions";
import { getStore, notConfiguredMessage, supabaseConfigured } from "../lib/data";

export const dynamic = "force-dynamic";

export default async function BulkPage({
  searchParams,
}: {
  searchParams: Promise<{ track?: string }>;
}) {
  if (!supabaseConfigured()) return <p>{notConfiguredMessage()}</p>;
  const { track } = await searchParams;
  const all = await getStore().listArticlesByStatus("approval_pending");
  const pending =
    track === "new" || track === "revision"
      ? all.filter((a) => (a.track ?? "new") === track)
      : all;
  const counts = {
    all: all.length,
    new: all.filter((a) => (a.track ?? "new") === "new").length,
    revision: all.filter((a) => a.track === "revision").length,
  };

  return (
    <main>
      <h2>一括レビュー ({pending.length}件)</h2>
      <p style={{ color: "#666", fontSize: 14 }}>
        この画面からは<strong>差し戻しのみ</strong>行えます。承認は本文を表示する個別記事画面から
        実行してください。承認は「代表が実記事を読んだ」ことを意味し、それが記事に付く監修表記の
        根拠になるためです。
      </p>
      <p style={{ fontSize: 14 }}>
        絞り込み:{" "}
        <a href="/bulk" style={{ fontWeight: track ? 400 : 700 }}>
          すべて ({counts.all})
        </a>{" "}
        /{" "}
        <a href="/bulk?track=new" style={{ fontWeight: track === "new" ? 700 : 400 }}>
          新規 ({counts.new})
        </a>{" "}
        /{" "}
        <a href="/bulk?track=revision" style={{ fontWeight: track === "revision" ? 700 : 400 }}>
          改修 ({counts.revision})
        </a>
      </p>

      <table style={{ borderCollapse: "collapse", width: "100%" }} border={1} cellPadding={6}>
        <thead>
          <tr>
            <th>種別</th>
            <th>タイトル</th>
            <th>品質</th>
            <th>リスク箇所 (要確認)</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {pending.map((a) => {
            const notes = (a.quality as P04VerdictT | null)?.human_review_notes;
            return (
              <tr key={a.id}>
                <td style={{ whiteSpace: "nowrap" }}>
                  {a.track === "revision" ? "改修" : "新規"}
                </td>
                <td>
                  <a href={`/article/${a.id}`}>{a.title ?? "(無題)"}</a>
                  {a.judge_disagreement && (
                    <strong style={{ color: "#c0392b" }}> [judge不一致]</strong>
                  )}
                </td>
                <td>{a.quality_score ?? "-"}</td>
                <td style={{ fontSize: 13 }}>{notes?.risk_areas.join(" / ") ?? "-"}</td>
                <td>
                  {/* 承認ボタンはこの画面には置かない。
                      承認は「代表が実記事を読んで押す」ことが監修表記の根拠であり、
                      本文を表示しない画面から押せる承認ボタンは白紙承認にあたるため。
                      この画面でできるのは差戻しと、本文を読むための遷移だけ。 */}
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <a href={`/article/${a.id}`}>
                      <strong>本文を読んで承認する</strong>
                    </a>
                    <form action={sendBackAction}>
                      <input type="hidden" name="id" value={a.id} />
                      <input type="text" name="notes" placeholder="差戻し理由" required size={14} />
                      <button type="submit">差戻し</button>
                    </form>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
