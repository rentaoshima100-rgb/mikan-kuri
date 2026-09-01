// M11 トリップワイヤ (cron-daily + 公開ワーカ連動)。
// v3差分: 対応は「新規公開の全停止 (halt) / 減速 (throttle)」に単純化 (レーン区別なし)。
// 発火条件はSPECのまま据え置き:
//   (a) index_rate: 直近28日公開分のindexed率<80% → throttle + velocity_stageを1段階戻す
//   (b) cni_spike: crawled_not_indexed件数が前週比2倍超 → throttle
//   (c) score_anomaly: 直近10本のP-04平均が前月平均-10点超の低下 → halt (解除は必ず人間)
//   (d) budget_80pct: 月間APIコストが予算の80% → info (100%時の生成停止はLLMクライアントが強制)
// 公開ワーカ側の連動 (halt=スキップ / throttle=週1本) は publish/worker.ts 済み。
import type { Store } from "../db/types.js";

export interface TripwireDeps {
  store: Store;
  now?: () => Date;
  budgetUsd?: number;
}

export interface TripwireSweepResult {
  fired: { event_type: string; severity: string; detail: unknown }[];
  evaluated: string[];
}

const DAY_MS = 86400_000;
const iso = (d: Date) => d.toISOString();
const dateStr = (d: Date) => d.toISOString().slice(0, 10);

export async function runTripwireSweep(deps: TripwireDeps): Promise<TripwireSweepResult> {
  const { store } = deps;
  const now = deps.now?.() ?? new Date();
  const result: TripwireSweepResult = { fired: [], evaluated: [] };
  const unresolved = new Set((await store.listAllTripwires()).filter((t) => !t.resolved).map((t) => t.event_type));

  const fire = async (
    event_type: string,
    severity: "info" | "throttle" | "halt",
    detail: unknown,
    autoAction?: string,
  ) => {
    if (unresolved.has(event_type)) return; // 未解決の同種イベントは再起票しない
    await store.insertTripwire({ event_type, severity, detail, auto_action_taken: autoAction });
    result.fired.push({ event_type, severity, detail });
  };

  // (a) index_rate (十分なサンプルがある場合のみ判定: 立ち上げ直後の誤発火防止)
  result.evaluated.push("index_rate");
  // 増速ゲートの母数は新規記事のみ。改修は新規URLを増やさないため含めない
  const statuses = await store.latestIndexStatusForPublishedSince(
    iso(new Date(now.getTime() - 28 * DAY_MS)),
    "new",
  );
  const known = statuses.filter((s) => s.index_status && s.index_status !== "unknown");
  if (known.length >= 5) {
    const indexed = known.filter((s) => s.index_status === "indexed").length;
    const rate = indexed / known.length;
    if (rate < 0.8) {
      const stage = (await store.getConfig<number>("velocity_stage")) ?? 0;
      const newStage = Math.max(0, stage - 1);
      await store.updateConfig("velocity_stage", newStage, "tripwire");
      await fire(
        "index_rate_drop",
        "throttle",
        { rate: Math.round(rate * 100) / 100, sample: known.length },
        `velocity_stage ${stage}→${newStage}`,
      );
    }
  }

  // (b) cni_spike (前週比2倍超。前週0件の場合は3件以上で発火)
  result.evaluated.push("cni_spike");
  const thisWeek = await store.countCniInRange(
    dateStr(new Date(now.getTime() - 7 * DAY_MS)),
    dateStr(now),
  );
  const prevWeek = await store.countCniInRange(
    dateStr(new Date(now.getTime() - 14 * DAY_MS)),
    dateStr(new Date(now.getTime() - 8 * DAY_MS)),
  );
  if ((prevWeek > 0 && thisWeek > prevWeek * 2) || (prevWeek === 0 && thisWeek >= 3)) {
    await fire("cni_spike", "throttle", { thisWeek, prevWeek });
  }

  // (c) score_anomaly (直近10本 vs 前月平均。v3: 新規公開の全停止に単純化)
  result.evaluated.push("score_anomaly");
  const recent = await store.listRecentQualityScores(10);
  const prevMonth = await store.listQualityScoresBetween(
    iso(new Date(now.getTime() - 60 * DAY_MS)),
    iso(new Date(now.getTime() - 30 * DAY_MS)),
  );
  if (recent.length >= 10 && prevMonth.length >= 3) {
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const recentAvg = avg(recent);
    const prevAvg = avg(prevMonth);
    if (prevAvg - recentAvg > 10) {
      await fire(
        "score_anomaly",
        "halt",
        { recentAvg: Math.round(recentAvg), prevAvg: Math.round(prevAvg) },
        "新規公開の全停止 (解除は人間のみ)",
      );
    }
  }

  // (d) budget_80pct
  result.evaluated.push("budget_80pct");
  const budget = deps.budgetUsd ?? Number(process.env.MONTHLY_TOKEN_BUDGET_USD ?? 60);
  if (budget > 0) {
    const spent = await store.getMonthSpendUsd(now);
    if (spent >= budget * 0.8) {
      await fire("budget_80pct", "info", {
        spent: Math.round(spent * 100) / 100,
        budget,
        generation_stopped: spent >= budget, // 100%時の停止はLLMクライアント側で強制済み
      });
    }
  }

  return result;
}

// 管理画面の「手動対策通知を受領」ボタン (SPEC M11): 全自動公開停止
export async function fileManualAction(store: Store, note: string): Promise<void> {
  await store.insertTripwire({
    event_type: "manual_action",
    severity: "halt",
    detail: { note },
    auto_action_taken: "新規公開の全停止 (解除は人間のみ)",
  });
}
