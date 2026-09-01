// M3 公開ワーカ (v3差分適用):
//   - approved かつ 代表の承認レコードが存在する記事のみ公開する
//   - 承認から72時間超の未公開分は公開せず保留に戻す (公開時にも再チェック。フェイルクローズド)
//   - 未解決の halt トリップワイヤがあれば公開せずスキップ (ログのみ)
//   - throttle 中はその週の公開を1本に制限 (v3: レーン区別なしの全体減速)
//   - 同時1件。二重公開は queue.published / cancelled の排他で防止
import {
  DEADMAN_REASON,
  deadmanDeadlineMs,
  deadmanReasonText,
} from "../approvals/approvals.js";
import type { Store } from "../db/types.js";
import type { SitePublisher } from "../site_integration/publisher.js";

export interface PublishWorkerDeps {
  store: Store;
  publisher: SitePublisher;
  indexNow?: (urls: string[]) => Promise<unknown>;
  now?: () => Date;
}

export interface PublishWorkerResult {
  published: { articleId: string; url: string }[];
  skipped: { articleId: string; reason: string }[];
}

function startOfWeekIso(now: Date): string {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7; // 月曜始まり
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function runPublishWorker(deps: PublishWorkerDeps): Promise<PublishWorkerResult> {
  const { store } = deps;
  const now = deps.now?.() ?? new Date();
  const result: PublishWorkerResult = { published: [], skipped: [] };

  const due = await store.listDueQueue(now);
  if (due.length === 0) return result;

  const tripwires = await store.listUnresolvedTripwires();
  if (tripwires.some((t) => t.severity === "halt")) {
    for (const q of due) result.skipped.push({ articleId: q.article_id, reason: "tripwire_halt" });
    console.warn("[publish] 未解決のhaltトリップワイヤのため公開をスキップ");
    return result;
  }
  // throttleは新規記事の公開ペースに対する減速。
  // 改修 (revision) は新規URLを増やさないため対象外にする
  const throttled = tripwires.some((t) => t.severity === "throttle");
  const throttleReached =
    throttled && (await store.countPublishedSince(startOfWeekIso(now), "new")) >= 1;

  // 公開は1回の実行につき1件まで (SPEC M3)。
  // ただし先頭が失敗し続けると後続が永久に公開されない (head-of-line blocking) ため、
  // 失敗はスキップとして記録し、次の候補へ進む。1件成功した時点で終了する。
  const deadmanHours = (await store.getConfig<number>("approval_deadman_hours")) ?? 72;

  for (const entry of due) {
    const article = await store.getArticle(entry.article_id);
    if (!article || (article.status !== "approved" && article.status !== "scheduled")) {
      result.skipped.push({ articleId: entry.article_id, reason: "not_approved_status" });
      continue;
    }

    // 減速中は新規記事のみ週1本に制限する (改修は新規URLを増やさないため対象外)
    if (throttleReached && (article.track ?? "new") === "new") {
      result.skipped.push({
        articleId: article.id,
        reason: "tripwire_throttle_weekly_limit",
      });
      continue;
    }

    // v3: 承認レコードの存在が公開条件
    const approval = await store.latestApproval(article.id);
    if (!approval || approval.decision !== "approved") {
      result.skipped.push({ articleId: article.id, reason: "no_approval_record" });
      continue;
    }

    // デッドマン再チェック (公開時、フェイルクローズド)。
    // 起点は承認時刻と公開予定時刻の遅い方 (approvals.deadmanDeadlineMs 参照)
    if (now.getTime() > deadmanDeadlineMs(approval.decided_at, article.scheduled_at, deadmanHours)) {
      const reason = deadmanReasonText(deadmanHours);
      await store.cancelPublishQueue(article.id, reason);
      await store.updateArticle(article.id, {
        status: "approval_pending",
        expired_reason: reason,
      });
      result.skipped.push({ articleId: article.id, reason: DEADMAN_REASON });
      continue;
    }

    const keyword = article.keyword_id ? await store.getKeyword(article.keyword_id) : null;
    let url: string;
    try {
      ({ url } = await deps.publisher.publish(article, keyword, now));
    } catch (e) {
      // サイトへの反映に失敗。キュー行は有効なまま残すので次回も再試行される。
      // ここで例外を投げると同じ記事が先頭に居座り、後続が一切公開できなくなる
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[publish] サイト反映に失敗 (次回再試行): ${article.id} ${message}`);
      // デッドマン失効時に原因を切り分けられるよう試行結果を残す
      await store.recordPublishAttempt(article.id, now, message);
      result.skipped.push({ articleId: article.id, reason: `publish_failed: ${message}` });
      continue;
    }
    await store.recordPublishAttempt(article.id, now, null);

    await store.markPublished(article.id, now);
    result.published.push({ articleId: article.id, url });

    // IndexNowはbest-effort (失敗しても公開は成立)
    if (deps.indexNow) {
      try {
        await deps.indexNow([url]);
      } catch (e) {
        console.warn(`[publish] IndexNow送信失敗 (公開は成立): ${e}`);
      }
    }
    break; // 1件公開したら終了
  }
  return result;
}
