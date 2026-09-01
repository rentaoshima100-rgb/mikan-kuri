// 承認フロー (v3の中核)。
// 公開のトリガは「代表が実記事を読んで承認ボタンを押す」の1つだけ。
// - 承認時に scheduled_at を週次目標から均等分散で自動割当し publish_queue へ投入
// - 承認から approval_deadman_hours (既定72h) 超の未公開分は保留に戻す (フェイルクローズド)
// - judge不一致フラグ付き記事は確認 (judgeAck) なしに承認できない
import type { Store } from "../db/types.js";

export interface ApprovalDeps {
  store: Store;
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function approveArticle(
  articleId: string,
  decidedBy: string,
  deps: ApprovalDeps,
  opts: { notes?: string; judgeAck?: boolean; scheduleNow?: boolean } = {},
): Promise<{ scheduledAt: string; backlogWarning: BacklogWarning | null }> {
  const { store } = deps;
  const now = deps.now?.() ?? new Date();
  const article = await store.getArticle(articleId);
  if (!article) throw new Error(`article not found: ${articleId}`);
  if (article.status !== "approval_pending") {
    throw new Error(`承認待ちの記事ではありません (status=${article.status})`);
  }
  if (article.judge_disagreement && !opts.judgeAck) {
    throw new Error("judge不一致フラグ付きの記事です。不一致内容の確認 (judgeAck) が必要です");
  }

  // scheduleNow: 全自動公開で使う。均等分散を無視して「いま」を予定にし、次のワーカ実行で
  // すぐ公開する (speed重視)。通常 (人間承認) はトラックごとのペースで均等分散させる。
  //
  // 週2本の制限は「新規URLの増加ペース」に対する対策なので、既存URLの中身を直す
  // 改修 (revision) は対象外。同じキューに混ぜると改修完了に数ヶ月かかってしまう。
  const track = article.track ?? "new";
  let scheduledAt: string;
  if (opts.scheduleNow) {
    scheduledAt = now.toISOString();
  } else {
    const perDay =
      track === "revision"
        ? ((await store.getConfig<number>("revision_publish_per_day")) ?? 5)
        : ((await store.getConfig<number>("weekly_publish_target")) ?? 2) / 7;
    scheduledAt = nextSlot(await store.listScheduledDates(track), perDay, now, {
      allowSameDay: track === "revision", // 改修は1日複数本を前提とする
    });
  }

  // 承認から公開まで長く空くと内容が古くなる。上限超過は警告のみ (拒否はしない)
  const backlogLimitDays = (await store.getConfig<number>("approval_backlog_limit_days")) ?? 28;
  const warning = checkBacklog(scheduledAt, now, backlogLimitDays);
  if (warning) {
    console.warn(
      JSON.stringify({
        job: "approve",
        event: "backlog_exceeded",
        article_id: articleId,
        track,
        scheduled_at: warning.scheduledAt,
        days_ahead: warning.daysAhead,
        limit_days: warning.limitDays,
      }),
    );
  }

  await store.insertApproval({
    article_id: articleId,
    decision: "approved",
    decided_by: decidedBy,
    decided_at: now.toISOString(),
    review_notes: opts.notes,
    judge_disagreement_ack: opts.judgeAck ?? false,
  });
  await store.updateArticle(articleId, {
    status: "approved",
    scheduled_at: scheduledAt,
    expired_reason: null, // 再承認したら失効表示を消す
  });
  await store.insertPublishQueue(articleId, scheduledAt);
  return { scheduledAt, backlogWarning: warning };
}

// 全自動公開 (full_auto_publish=true)。承認待ちの全記事を代表の事前承認方針として
// 自動承認し、即時公開の予定を割り当てる。
//   - judgeAck=true: 全自動なのでjudge不一致も自動で承認する (v3の人間エスカレーションを上書き)
//   - scheduleNow=true: 均等分散せず「いま」を予定にして次のワーカ実行で公開
// デッドマンで承認待ちに戻された記事もここで再承認されるため、ワーカ復旧後に自己回復する。
// 1件失敗しても他は続行する (バッチ堅牢化)。
export async function autoApproveAllPending(deps: ApprovalDeps): Promise<string[]> {
  const { store } = deps;
  const approved: string[] = [];
  for (const article of await store.listArticlesByStatus("approval_pending")) {
    try {
      await approveArticle(article.id, "system:full_auto", deps, {
        judgeAck: true,
        scheduleNow: true,
        notes: "full_auto_publish: 代表の事前承認方針により自動承認・即時公開",
      });
      approved.push(article.id);
    } catch (e) {
      console.warn(
        JSON.stringify({
          job: "auto_approve",
          event: "auto_approve_failed",
          article_id: article.id,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }
  return approved;
}

export async function sendBackArticle(
  articleId: string,
  decidedBy: string,
  notes: string,
  deps: ApprovalDeps,
): Promise<void> {
  const { store } = deps;
  const article = await store.getArticle(articleId);
  if (!article) throw new Error(`article not found: ${articleId}`);
  if (article.status !== "approval_pending" && article.status !== "gate_pending") {
    throw new Error(`差戻し対象の記事ではありません (status=${article.status})`);
  }
  await store.insertApproval({
    article_id: articleId,
    decision: "sent_back",
    decided_by: decidedBy,
    decided_at: (deps.now?.() ?? new Date()).toISOString(),
    review_notes: notes,
    judge_disagreement_ack: false,
  });
  await store.updateArticle(articleId, { status: "needs_rewrite" });
}

// スケジューリング規則 (SPEC M2): 直近の公開予定から均等分散。
// perDay = 1日あたりの公開本数 (新規は週次目標/7、改修は revision_publish_per_day)。
//
// 公開待ちが無いときは「いま」を予定にする (次のワーカ実行で公開)。
// 予定が詰まっている場合のみ間隔を空けるので、まとめ承認しても
// 先頭から順に消化される。
//
// 同日2本以上の禁止は新規記事のみ (改修は1日複数本を前提とするため)。
export function nextSlot(
  existingIso: string[],
  perDay: number,
  now: Date,
  opts: { allowSameDay?: boolean } = {},
): string {
  const existing = existingIso.map((d) => new Date(d).getTime()).filter((t) => t >= now.getTime());
  if (existing.length === 0) return now.toISOString();

  const intervalMs = DAY_MS / Math.max(0.01, perDay);
  let candidate = new Date(Math.max(...existing) + intervalMs);
  if (!opts.allowSameDay) {
    const existingDays = new Set(existingIso.map((d) => d.slice(0, 10)));
    while (existingDays.has(candidate.toISOString().slice(0, 10))) {
      candidate = new Date(candidate.getTime() + DAY_MS);
    }
  }
  return candidate.toISOString();
}

// 承認済みバックログの上限 (既定4週間分)。
// 承認から公開まで長く空くと内容が古くなるため、超えたら警告する。
// 拒否ではなく警告なのは、承認ボタンを押してエラーが返るUXを避けるため。
export interface BacklogWarning {
  scheduledAt: string;
  daysAhead: number;
  limitDays: number;
}

export function checkBacklog(
  scheduledAt: string,
  now: Date,
  limitDays: number,
): BacklogWarning | null {
  const daysAhead = (new Date(scheduledAt).getTime() - now.getTime()) / DAY_MS;
  if (daysAhead <= limitDays) return null;
  return { scheduledAt, daysAhead: Math.round(daysAhead), limitDays };
}

// デッドマンスイッチ (v3 1-3)。
//
// 起点は「公開予定時刻」。v3は公開を均等分散させる仕様なので、承認から公開まで
// 数日空くのは正常動作であり、承認時刻を起点にすると正常な分散と必ず衝突する。
//
// 公開予定を過ぎても72時間publishされない場合だけ失効させる。
// 予定を過ぎても公開されないのは「何かが壊れている (ワーカ停止・トリップワイヤ発火・
// コミット失敗)」ことを意味するので、その状態で古い承認を執行せず人間に戻す。
//
// 公開予定が未設定の記事 (通常は起きない) は承認時刻を起点にする。
export function deadmanDeadlineMs(
  approvalDecidedAt: string,
  scheduledAt: string | undefined,
  hours: number,
): number {
  const base = scheduledAt ? new Date(scheduledAt).getTime() : new Date(approvalDecidedAt).getTime();
  return base + hours * 3600_000;
}

// 失効の理由 (ログと管理画面表示に使う)
export const DEADMAN_REASON = "approval_expired";

export type ExpiryCause = "worker_stopped" | "tripwire" | "commit_failed" | "unknown";

const CAUSE_TEXT: Record<ExpiryCause, string> = {
  worker_stopped: "公開ワーカが動いていない可能性があります (Actionsの実行履歴を確認してください)",
  tripwire: "トリップワイヤが発火して公開が止まっていました",
  commit_failed: "サイトへのコミットに失敗していました",
  unknown: "原因を特定できませんでした",
};

// 失効理由の切り分け。公開されなかった原因を承認者に伝える
export function classifyExpiry(input: {
  hasUnresolvedTripwire: boolean;
  lastError?: string | null;
  lastAttemptAt?: string | null;
}): ExpiryCause {
  if (input.hasUnresolvedTripwire) return "tripwire";
  if (input.lastError) return "commit_failed";
  // 一度も公開が試行されていない = ワーカが回っていない
  if (!input.lastAttemptAt) return "worker_stopped";
  return "unknown";
}

export function deadmanReasonText(hours: number, cause: ExpiryCause = "unknown"): string {
  return (
    `${DEADMAN_REASON}: 公開予定から${hours}時間を過ぎても公開されなかったため失効しました。` +
    CAUSE_TEXT[cause]
  );
}

export async function deadmanSweep(deps: ApprovalDeps): Promise<string[]> {
  const { store } = deps;
  const now = deps.now?.() ?? new Date();
  const hours = (await store.getConfig<number>("approval_deadman_hours")) ?? 72;
  const reverted: string[] = [];

  for (const status of ["approved", "scheduled"] as const) {
    for (const article of await store.listArticlesByStatus(status)) {
      const queue = await store.getQueueEntry(article.id);
      if (queue?.published) continue;
      const approval = await store.latestApproval(article.id);
      if (!approval || approval.decision !== "approved") continue;
      if (now.getTime() > deadmanDeadlineMs(approval.decided_at, article.scheduled_at, hours)) {
        const cause = classifyExpiry({
          hasUnresolvedTripwire: (await store.listUnresolvedTripwires()).length > 0,
          lastError: queue?.last_error,
          lastAttemptAt: queue?.last_attempt_at,
        });
        const reason = deadmanReasonText(hours, cause);
        await store.cancelPublishQueue(article.id, reason);
        // 管理画面で「承認が失効しました」と出せるよう、記事側にも理由を残す
        await store.updateArticle(article.id, {
          status: "approval_pending",
          expired_reason: reason,
        });
        console.warn(
          JSON.stringify({
            job: "deadman_sweep",
            event: "approval_expired",
            article_id: article.id,
            approved_at: approval.decided_at,
            hours,
          }),
        );
        reverted.push(article.id);
      }
    }
  }
  return reverted;
}

// 管理画面のキュー取消 (SPEC M12)。取消した記事は承認待ちに戻す
export async function cancelQueued(
  articleId: string,
  reason: string,
  deps: ApprovalDeps,
): Promise<void> {
  const { store } = deps;
  const queue = await store.getQueueEntry(articleId);
  if (!queue || queue.published) {
    throw new Error("取消可能なキューエントリがありません (未投入または公開済み)");
  }
  await store.cancelPublishQueue(articleId, reason);
  await store.updateArticle(articleId, { status: "approval_pending" });
}
