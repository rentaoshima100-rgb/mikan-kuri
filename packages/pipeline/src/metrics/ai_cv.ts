// v3多重計測: ai_cv_counter。
// 3系統 (ga4_channel / self_report / referrer_log) の累計でAI経由CVを数え、
// 累計30〜50件が ai_llmo_expansion_frozen 解除提案の条件になる
// (解除の実行は常に人間承認 + エビデンス添付必須)。
import type { Store } from "../db/types.js";

// 自己申告 (問い合わせフォームの「AIチャット」選択を代表が管理画面から記録)
export async function recordSelfReportCv(
  store: Store,
  occurredOn: string,
  detail?: string,
): Promise<void> {
  await store.insertAiCvEvent({
    occurred_on: occurredOn,
    source: "self_report",
    count: 1,
    detail: detail ? { note: detail } : undefined,
  });
}

// リファラログ集計 (Vercelログ等から人間/スクリプトが集計値を投入)
export async function recordReferrerLogCv(
  store: Store,
  occurredOn: string,
  count: number,
  detail?: unknown,
): Promise<void> {
  if (count <= 0) return;
  await store.insertAiCvEvent({ occurred_on: occurredOn, source: "referrer_log", count, detail });
}

export interface AiCvStatus {
  total: number;
  unfreezeMin: number;
  unfreezeMax: number;
  proposable: boolean; // 凍結解除を提案できる水準か (実行は人間承認)
  bySource: Record<string, number>; // 系統別の内訳 (重複度の判断材料)
}

export async function aiCvStatus(store: Store): Promise<AiCvStatus> {
  const range =
    (await store.getConfig<{ min: number; max: number }>("ai_llmo_unfreeze_cv_range")) ?? {
      min: 30,
      max: 50,
    };
  const total = await store.sumAiCvEvents();
  return {
    total,
    unfreezeMin: range.min,
    unfreezeMax: range.max,
    proposable: total >= range.min,
    bySource: await store.sumAiCvEventsBySource(),
  };
}
