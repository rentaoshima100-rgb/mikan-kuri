"use server";

// 承認/差戻し/取消/ゲート承認のサーバアクション。
// 全操作はservice role経由 (SPEC M12)。公開のトリガは承認のみ (v3)。
import { revalidatePath } from "next/cache";
import { join } from "node:path";
import {
  applyApprovedLinks,
  approveArticle,
  cancelQueued,
  continueFromGate,
  fileManualAction,
  makeLLMClient,
  makeShopifyPublisher,
  markGateApproved,
  recordReferrerLogCv,
  recordSelfReportCv,
  rejectLink,
  sendBackArticle,
} from "@kurimikan/pipeline";
import { getStore } from "./lib/data";

const DECIDER = process.env.ADMIN_DECIDER ?? "renta";
const SUITE_PATH = join(process.cwd(), "..", "..", "kurimikan_prompt_suite_v1.md");

function requiredId(formData: FormData): string {
  const id = formData.get("id");
  if (typeof id !== "string" || !id) throw new Error("記事IDがありません");
  return id;
}

export async function approveAction(formData: FormData): Promise<void> {
  const store = getStore();
  await approveArticle(
    requiredId(formData),
    DECIDER,
    { store },
    {
      judgeAck: formData.get("judgeAck") === "on",
      notes: String(formData.get("notes") ?? "") || undefined,
    },
  );
  revalidatePath("/");
  revalidatePath("/bulk");
}

export async function sendBackAction(formData: FormData): Promise<void> {
  const notes = String(formData.get("notes") ?? "");
  if (!notes) throw new Error("差戻し理由を入力してください");
  await sendBackArticle(requiredId(formData), DECIDER, notes, { store: getStore() });
  revalidatePath("/");
  revalidatePath("/bulk");
}

export async function cancelAction(formData: FormData): Promise<void> {
  const reason = String(formData.get("reason") ?? "管理画面から取消");
  await cancelQueued(requiredId(formData), reason, { store: getStore() });
  revalidatePath("/");
}

// gate_pending (品質ホールド) の人間承認 → 残りステップを再開して承認キューへ。
// サブスク実行 (APIキーなし) の構成では、残りステップ (合議→仕上げ) のLLMを
// Vercel上で呼べないため、承認マーカだけを記録して次のルーチン実行に引き継ぐ
// (routine_daily の gate_continue ステップ。docs/ROUTINES.md)。
export async function approveGateAction(formData: FormData): Promise<void> {
  const store = getStore();
  if (!process.env.ANTHROPIC_API_KEY) {
    await markGateApproved(requiredId(formData), DECIDER, { store });
    revalidatePath("/");
    return;
  }
  const llm = await makeLLMClient(store);
  await continueFromGate(requiredId(formData), {
    store,
    llm,
    suitePath: SUITE_PATH,
    budgetUsd: Number(process.env.MONTHLY_TOKEN_BUDGET_USD ?? 60),
  });
  revalidatePath("/");
}

// ---- 運用ページ (トリップワイヤ / AI経由CVカウンタ) ----

// GSCの手動対策はAPIで取得できないため、受領を人間がここで記録する (SPEC M11)
export async function fileManualActionAction(formData: FormData): Promise<void> {
  const note = String(formData.get("note") ?? "");
  if (!note) throw new Error("通知内容のメモを入力してください");
  await fileManualAction(getStore(), note);
  revalidatePath("/ops");
  revalidatePath("/");
}

// haltの解除は必ず人間 (v3)
export async function resolveTripwireAction(formData: FormData): Promise<void> {
  await getStore().resolveTripwire(requiredId(formData));
  revalidatePath("/ops");
  revalidatePath("/");
}

export async function recordSelfReportCvAction(formData: FormData): Promise<void> {
  const date = String(formData.get("date") ?? "");
  if (!date) throw new Error("日付を入力してください");
  await recordSelfReportCv(getStore(), date, String(formData.get("note") ?? "") || undefined);
  revalidatePath("/ops");
}

// ---- 内部リンク承認キュー ----
// 適用後の差分を全文表示したうえでの承認なので一括を許可する
// (本文を見ずに押せる記事承認とは性質が異なる)
export async function applyLinksAction(formData: FormData): Promise<void> {
  const ids = formData.getAll("linkIds").map(String).filter(Boolean);
  if (!ids.length) throw new Error("承認する提案を選択してください");
  const store = getStore();
  // 公開済み記事へのリンク適用は、本文の書き換えとShopifyへの再公開までが1操作
  const result = await applyApprovedLinks(ids, DECIDER, {
    store,
    publisher: makeShopifyPublisher(store),
  });
  if (result.skipped.length) {
    console.warn(`[links] 適用できなかった提案: ${JSON.stringify(result.skipped)}`);
  }
  revalidatePath("/links");
}

export async function rejectLinkAction(formData: FormData): Promise<void> {
  const notes = String(formData.get("notes") ?? "");
  if (!notes) throw new Error("却下理由を入力してください");
  await rejectLink(requiredId(formData), DECIDER, notes, { store: getStore() });
  revalidatePath("/links");
}

// ---- キーワード提案キュー (トピック承認点) ----
// 発案器が status='proposed' で積んだトピックを、代表が承認 (queued) / 却下 (parked) する。
// これが「システムがネタを持ってくる → 代表が承認する」の第1の承認点。記事化はこの後。
export async function approveKeywordAction(formData: FormData): Promise<void> {
  await getStore().updateKeywordStatus(requiredId(formData), "queued");
  revalidatePath("/keywords");
}

export async function rejectKeywordAction(formData: FormData): Promise<void> {
  await getStore().updateKeywordStatus(requiredId(formData), "parked");
  revalidatePath("/keywords");
}

// 承認を取り消して提案一覧へ戻す。承認は押し間違えるし、
// 承認した後で「これは既存記事と被る」と気づくこともある。
// 記事化される前なら戻せる状態にしておく (記事化後はキーワードが done になり対象外)。
export async function unqueueKeywordAction(formData: FormData): Promise<void> {
  await getStore().updateKeywordStatus(requiredId(formData), "proposed");
  revalidatePath("/keywords");
}

// 記事化待ちから直接却下する (提案に戻さず見送る)
export async function parkQueuedKeywordAction(formData: FormData): Promise<void> {
  await getStore().updateKeywordStatus(requiredId(formData), "parked");
  revalidatePath("/keywords");
}

// 承認済みトピックの記事化を起動する。
//
// 記事1本の生成に3〜6分かかり、サーバレス関数の実行時間内では完走できない。
// そこで GitHub Actions の generate ワークフローを起動し、結果だけDBに書かせる。
// 起動は即座に返るので、画面は待たされない。
//
// 生成物は全件 approval_pending で承認キューに入る。ここで記事は公開されない。
async function dispatchWorkflow(
  workflow: string,
  inputs: Record<string, string>,
  label: string,
): Promise<void> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.PIPELINE_REPO ?? "rentaoshima100-rgb/mikan-kuri";
  if (!token) {
    throw new Error(
      `GITHUB_DISPATCH_TOKEN が未設定です。${label}はGitHub Actionsで実行するため、` +
        "actions:write 権限のトークンが要ります (README参照)。",
    );
  }
  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${label}の起動に失敗しました (${res.status}): ${body.slice(0, 200)}`);
  }
}

export async function generateQueuedAction(formData: FormData): Promise<void> {
  const limitRaw = String(formData.get("limit") ?? "3");
  const limit = String(Math.max(1, Math.min(20, Number(limitRaw) || 3)));
  await dispatchWorkflow("generate.yml", { limit }, "記事化");
  revalidatePath("/keywords");
}

// 承認済み記事を今すぐ公開する。
//
// 公開は cron-hourly に任せる設計だが、GitHubのスケジュール実行は遅延が大きく、
// 実測で平均149分・最長265分の間隔だった。承認してから数時間サイトに出ないのは
// 運用として成立しないので、承認直後に押せる経路を用意する。
// 公開されるのは既に承認済みの記事だけで、このボタンが承認を代行することはない。
export async function publishNowAction(): Promise<void> {
  await dispatchWorkflow("publish-now.yml", {}, "公開");
  revalidatePath("/");
}

export async function recordReferrerCvAction(formData: FormData): Promise<void> {
  const date = String(formData.get("date") ?? "");
  const count = Number(formData.get("count") ?? 0);
  if (!date || !Number.isFinite(count) || count <= 0) {
    throw new Error("日付と1以上の件数を入力してください");
  }
  await recordReferrerLogCv(getStore(), date, count, { entered_by: DECIDER });
  revalidatePath("/ops");
}
