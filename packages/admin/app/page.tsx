// 承認キュー (v3 Day 2最小版): approval_pending / gate_pending の一覧、
// judge不一致フラグ表示、スケジュール済みの取消。
import type { ArticleRow } from "@kurimikan/pipeline";
import { approveGateAction, cancelAction, publishNowAction } from "./actions";
import { getStore, notConfiguredMessage, supabaseConfigured } from "./lib/data";

export const dynamic = "force-dynamic";
// ゲート承認 (continueFromGate) がサーバアクション内でLLMを呼ぶため、サーバレスの既定 (10秒) では途中で切れる。
// Vercelのプラン上限まで引き上げる (Hobby=60秒 / Pro=300秒)。
export const maxDuration = 60;


function JudgeBadge({ article }: { article: ArticleRow }) {
  if (!article.judge_disagreement) return null;
  return (
    <span
      style={{
        background: "#c0392b",
        color: "white",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 12,
        marginLeft: 8,
      }}
    >
      judge不一致
    </span>
  );
}

function trackOf(a: ArticleRow) {
  return a.track ?? "new";
}

function TrackFilter({ current, counts }: { current?: string; counts: Record<string, number> }) {
  const link = (key: string, label: string, href: string) => (
    <a href={href} style={{ fontWeight: (current ?? "all") === key ? 700 : 400 }}>
      {label} ({counts[key] ?? 0})
    </a>
  );
  return (
    <p style={{ fontSize: 14 }}>
      絞り込み: {link("all", "すべて", "/")} / {link("new", "新規", "/?track=new")} /{" "}
      {link("revision", "改修", "/?track=revision")}
    </p>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ track?: string }>;
}) {
  if (!supabaseConfigured()) return <p>{notConfiguredMessage()}</p>;
  const { track } = await searchParams;
  const store = getStore();
  const [allPending, gate, approved, scheduled] = await Promise.all([
    store.listArticlesByStatus("approval_pending"),
    store.listArticlesByStatus("gate_pending"),
    store.listArticlesByStatus("approved"),
    store.listArticlesByStatus("scheduled"),
  ]);
  const queued = [...approved, ...scheduled];
  // 新規記事のタイトルは P-12 が生成するが、それはゲート承認の後に走る。
  // そのため gate_pending の新規記事はタイトルもslugも無く、一覧では
  // 「記事 da1ee6ec」としか出ず、中身が分からないまま承認を迫ることになる。
  // 承認前に何の記事か分かるよう、キーワードと構成案の見出し案を出す。
  const gateLabels = new Map<string, { keyword: string; draft: string }>();
  await Promise.all(
    gate
      .filter((a) => !a.title)
      .map(async (a) => {
        const kw = await store.getKeyword(a.keyword_id);
        const outline = a.outline as { title_draft?: string } | null;
        gateLabels.set(a.id, {
          keyword: kw?.keyword ?? "",
          draft: outline?.title_draft ?? "",
        });
      }),
  );
  const filter = track === "new" || track === "revision" ? track : undefined;
  const pending = filter ? allPending.filter((a) => trackOf(a) === filter) : allPending;
  const counts = {
    all: allPending.length,
    new: allPending.filter((a) => trackOf(a) === "new").length,
    revision: allPending.filter((a) => trackOf(a) === "revision").length,
  };

  return (
    <main>
      <h2>承認キュー ({pending.length})</h2>
      <p style={{ color: "#666", fontSize: 14 }}>
        公開のトリガは承認のみです。承認しない限り公開されません
        (公開予定を72時間過ぎても公開されない場合は保留へ戻ります)。
      </p>
      <TrackFilter current={filter} counts={counts} />
      {pending.length === 0 && <p>承認待ちの記事はありません。</p>}
      <ul>
        {pending.map((a) => (
          <li key={a.id} style={{ marginBottom: 8 }}>
            <span
              style={{
                background: trackOf(a) === "revision" ? "#2d6a4f" : "#34495e",
                color: "white",
                padding: "2px 6px",
                borderRadius: 4,
                fontSize: 12,
                marginRight: 8,
              }}
            >
              {trackOf(a) === "revision" ? "改修" : "新規"}
            </span>
            <a href={`/article/${a.id}`}>{a.title ?? "(無題)"}</a>
            <JudgeBadge article={a} />
            <span style={{ color: "#666", marginLeft: 8 }}>
              品質{a.quality_score ?? "-"}点 / {a.lane === "B" ? "レーンB下書き" : "レーンA"}
            </span>
          </li>
        ))}
      </ul>

      <h2>品質ホールド中 (gate_pending: {gate.length})</h2>
      {gate.length === 0 && <p>ホールド中の記事はありません。</p>}
      <ul>
        {gate.map((a) => (
          <li key={a.id} style={{ marginBottom: 12 }}>
            <a href={`/article/${a.id}`}>
              {a.title ?? gateLabels.get(a.id)?.draft ?? `記事 ${a.id.slice(0, 8)}`}
            </a>
            <span style={{ color: "#666", marginLeft: 8 }}>品質{a.quality_score ?? "-"}点</span>
            {!a.title && gateLabels.get(a.id)?.keyword && (
              <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
                対象キーワード: {gateLabels.get(a.id)!.keyword}
                <span style={{ marginLeft: 8 }}>
                  (公開URLとタイトルはゲート承認の後に確定します)
                </span>
              </div>
            )}
            <form action={approveGateAction} style={{ display: "inline", marginLeft: 12 }}>
              <input type="hidden" name="id" value={a.id} />
              <button type="submit">ゲート承認して続行</button>
            </form>
          </li>
        ))}
      </ul>

      <h2>公開スケジュール済み ({queued.length})</h2>
      <p style={{ color: "#666", fontSize: 13, margin: "4px 0 8px" }}>
        公開予定時刻が来た記事から順に、自動で1時間ごとに公開されます。待てないときは下のボタンで
        今すぐ回せます (押しても公開されるのは予定時刻を過ぎた記事1本だけで、予定を前倒しはしません)。
      </p>
      <form action={publishNowAction} style={{ marginBottom: 12 }}>
        <button type="submit">今すぐ公開を回す</button>
      </form>
      {queued.length === 0 && <p>スケジュール済みの記事はありません。</p>}
      <ul>
        {queued.map((a) => (
          <li key={a.id} style={{ marginBottom: 8 }}>
            <a href={`/article/${a.id}`}>{a.title ?? "(無題)"}</a>
            <span style={{ color: "#666", marginLeft: 8 }}>
              {trackOf(a) === "revision" ? "改修" : "新規"} / 公開予定:{" "}
              {a.scheduled_at ? new Date(a.scheduled_at).toLocaleString("ja-JP") : "-"}
            </span>
            <form action={cancelAction} style={{ display: "inline", marginLeft: 12 }}>
              <input type="hidden" name="id" value={a.id} />
              <button type="submit">取消して承認待ちに戻す</button>
            </form>
          </li>
        ))}
      </ul>
    </main>
  );
}
