import { describe, expect, it } from "vitest";
import { MemoryStore } from "../db/memory.js";
import {
  autoApproveAllPending,
  checkBacklog,
  approveArticle,
  cancelQueued,
  deadmanSweep,
  nextSlot,
  sendBackArticle,
} from "./approvals.js";

const T0 = new Date("2026-07-24T09:00:00.000Z");
const hoursLater = (h: number) => new Date(T0.getTime() + h * 3600_000);

async function makeWorld() {
  const store = new MemoryStore();
  store.setConfig("weekly_publish_target", 2);
  store.setConfig("approval_deadman_hours", 72);
  const kw = store.addKeyword({ keyword: "kw" });
  const article = await store.createArticle({
    keyword_id: kw.id,
    article_type: "howto",
    lane: "A",
  });
  await store.updateArticle(article.id, { status: "approval_pending" });
  return { store, article };
}

describe("approvals: 承認 (公開の唯一のトリガ)", () => {
  it("承認で approvals記録 + status=approved + scheduled_at割当 + publish_queue投入", async () => {
    const { store, article } = await makeWorld();
    const { scheduledAt } = await approveArticle(article.id, "renta@example.com", {
      store,
      now: () => T0,
    });

    const updated = (await store.getArticle(article.id))!;
    expect(updated.status).toBe("approved");
    expect(updated.scheduled_at).toBe(scheduledAt);
    expect(store.approvals[0]!.decision).toBe("approved");
    const queue = await store.getQueueEntry(article.id);
    expect(queue?.scheduled_at).toBe(scheduledAt);
    expect(queue?.cancelled).toBe(false);
    // 公開待ちが無ければ即時 (次のワーカ実行で公開される)。
    // ここで先送りすると承認が失効期限に先を越されて一本も公開できない
    expect(scheduledAt).toBe(T0.toISOString());
  });

  it("2本目は既存予定から均等分散され、同日にはならない", async () => {
    const { store, article } = await makeWorld();
    store.setConfig("weekly_publish_target", 7); // 1日1本
    const kw2 = store.addKeyword({ keyword: "kw2" });
    const article2 = await store.createArticle({
      keyword_id: kw2.id,
      article_type: "howto",
      lane: "A",
    });
    await store.updateArticle(article2.id, { status: "approval_pending" });

    const r1 = await approveArticle(article.id, "renta", { store, now: () => T0 });
    const r2 = await approveArticle(article2.id, "renta", { store, now: () => T0 });

    expect(new Date(r2.scheduledAt).getTime()).toBeGreaterThan(new Date(r1.scheduledAt).getTime());
    expect(r1.scheduledAt.slice(0, 10)).not.toBe(r2.scheduledAt.slice(0, 10));
  });

  it("公開予定が先でも承認できる (拒否せず、上限超過なら警告のみ)", async () => {
    const { store, article } = await makeWorld(); // weekly=2 → 2本目は3.5日後
    const kw2 = store.addKeyword({ keyword: "kw2" });
    const article2 = await store.createArticle({
      keyword_id: kw2.id,
      article_type: "howto",
      lane: "A",
    });
    await store.updateArticle(article2.id, { status: "approval_pending" });

    await approveArticle(article.id, "renta", { store, now: () => T0 }); // 1本目は即時
    const r2 = await approveArticle(article2.id, "renta", { store, now: () => T0 });

    // まとめ承認できる (承認ボタンでエラーが返らない)
    expect((await store.getArticle(article2.id))!.status).toBe("approved");
    expect(new Date(r2.scheduledAt).getTime()).toBeGreaterThan(T0.getTime());
    expect(r2.backlogWarning).toBeNull(); // 3.5日先は上限28日以内
  });

  it("バックログ上限を超える公開予定は警告を返す (拒否はしない)", async () => {
    expect(checkBacklog(new Date(T0.getTime() + 10 * 86400_000).toISOString(), T0, 28)).toBeNull();
    const warn = checkBacklog(new Date(T0.getTime() + 40 * 86400_000).toISOString(), T0, 28);
    expect(warn).toMatchObject({ daysAhead: 40, limitDays: 28 });
  });

  it("judge不一致フラグ付きはjudgeAckなしに承認できない", async () => {
    const { store, article } = await makeWorld();
    await store.updateArticle(article.id, { judge_disagreement: true });

    await expect(approveArticle(article.id, "renta", { store })).rejects.toThrow(/judge不一致/);
    await approveArticle(article.id, "renta", { store, now: () => T0 }, { judgeAck: true });
    expect((await store.getArticle(article.id))!.status).toBe("approved");
    expect(store.approvals[0]!.judge_disagreement_ack).toBe(true);
  });

  it("approval_pending以外は承認できない (draftや公開済みの誤承認防止)", async () => {
    const { store, article } = await makeWorld();
    await store.updateArticle(article.id, { status: "draft" });
    await expect(approveArticle(article.id, "renta", { store })).rejects.toThrow(/承認待ち/);
  });
});

describe("approvals: 全自動承認 (full_auto_publish)", () => {
  async function addPending(store: MemoryStore, keyword: string, patch = {}) {
    const kw = store.addKeyword({ keyword });
    const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
    await store.updateArticle(a.id, { status: "approval_pending", ...patch });
    return a;
  }

  it("承認待ちを全件、即時公開の予定で自動承認する (judge不一致も含む)", async () => {
    const store = new MemoryStore();
    store.setConfig("weekly_publish_target", 2);
    const a1 = await addPending(store, "kw1");
    const a2 = await addPending(store, "kw2", { judge_disagreement: true });

    const approved = await autoApproveAllPending({ store, now: () => T0 });

    expect(approved.sort()).toEqual([a1.id, a2.id].sort());
    for (const id of [a1.id, a2.id]) {
      const art = (await store.getArticle(id))!;
      expect(art.status).toBe("approved");
      // scheduleNow: 均等分散せず即時 (2本目も同日=T0)。次のワーカ実行で順次公開
      expect(art.scheduled_at).toBe(T0.toISOString());
      expect((await store.getQueueEntry(id))?.cancelled).toBe(false);
    }
    // judge不一致フラグ付きも judgeAck=true で自動承認されている
    const ackd = store.approvals.find((ap) => ap.article_id === a2.id);
    expect(ackd?.judge_disagreement_ack).toBe(true);
    expect(ackd?.decided_by).toBe("system:full_auto");
  });

  it("承認待ち以外 (draft等) は対象外", async () => {
    const store = new MemoryStore();
    const draft = await addPending(store, "kw", {});
    await store.updateArticle(draft.id, { status: "draft" });

    expect(await autoApproveAllPending({ store, now: () => T0 })).toEqual([]);
    expect((await store.getArticle(draft.id))!.status).toBe("draft");
  });

  it("1件が失敗しても他は承認される (バッチ堅牢化)", async () => {
    const store = new MemoryStore();
    const ok = await addPending(store, "kw-ok");
    // getArticle が壊れて例外を投げる記事を混ぜる
    const bad = await addPending(store, "kw-bad");
    const orig = store.getArticle.bind(store);
    store.getArticle = (id: string) => {
      if (id === bad.id) throw new Error("boom");
      return orig(id);
    };

    const approved = await autoApproveAllPending({ store, now: () => T0 });
    expect(approved).toEqual([ok.id]);
    store.getArticle = orig;
    expect((await store.getArticle(ok.id))!.status).toBe("approved");
  });
});

describe("approvals: 差戻し", () => {
  it("差戻しで approvals記録 (sent_back) + status=needs_rewrite", async () => {
    const { store, article } = await makeWorld();
    await sendBackArticle(article.id, "renta", "独自性が弱い", { store, now: () => T0 });

    expect((await store.getArticle(article.id))!.status).toBe("needs_rewrite");
    expect(store.approvals[0]!.decision).toBe("sent_back");
    expect(store.approvals[0]!.review_notes).toBe("独自性が弱い");
  });
});

describe("approvals: デッドマンスイッチ (公開予定から72時間で失効)", () => {
  // 起点は公開予定時刻。承認から公開まで数日空くのは均等分散の正常動作なので、
  // 「予定を過ぎても公開されない=壊れている」場合だけ失効させる。
  it("公開予定から72h超の未公開分は保留に戻り、失効理由が記録される", async () => {
    const { store, article } = await makeWorld();
    await approveArticle(article.id, "renta", { store, now: () => T0 });

    const reverted = await deadmanSweep({ store, now: () => hoursLater(73) });

    expect(reverted).toEqual([article.id]);
    const updated = (await store.getArticle(article.id))!;
    expect(updated.status).toBe("approval_pending");
    expect(updated.expired_reason).toContain("公開予定から72時間");
    expect(updated.expired_reason).toContain("公開ワーカが動いていない可能性");
    const queue = await store.getQueueEntry(article.id);
    expect(queue?.cancelled).toBe(true);
  });

  it("期限内なら何もしない / 公開済みは対象外", async () => {
    const { store, article } = await makeWorld();
    await approveArticle(article.id, "renta", { store, now: () => T0 });

    expect(await deadmanSweep({ store, now: () => hoursLater(71) })).toEqual([]);
    expect((await store.getArticle(article.id))!.status).toBe("approved");

    // 公開済みにするとsweep対象外
    store.queue[0]!.published = true;
    expect(await deadmanSweep({ store, now: () => hoursLater(200) })).toEqual([]);
  });

  it("再承認で失効表示がクリアされる", async () => {
    const { store, article } = await makeWorld();
    await approveArticle(article.id, "renta", { store, now: () => T0 });
    await deadmanSweep({ store, now: () => hoursLater(73) });
    expect((await store.getArticle(article.id))!.expired_reason).toBeTruthy();

    await approveArticle(article.id, "renta", { store, now: () => hoursLater(74) });
    expect((await store.getArticle(article.id))!.expired_reason).toBeNull();
  });
});

describe("approvals: キュー取消 (SPEC M12)", () => {
  it("取消でcancelled反映 + 記事は承認待ちに戻る", async () => {
    const { store, article } = await makeWorld();
    await approveArticle(article.id, "renta", { store, now: () => T0 });
    await cancelQueued(article.id, "内容を見直したい", { store });

    const queue = await store.getQueueEntry(article.id);
    expect(queue?.cancelled).toBe(true);
    expect(queue?.published).toBe(false);
    expect((await store.getArticle(article.id))!.status).toBe("approval_pending");
  });

  it("公開済みは取消できない", async () => {
    const { store, article } = await makeWorld();
    await approveArticle(article.id, "renta", { store, now: () => T0 });
    store.queue[0]!.published = true;
    await expect(cancelQueued(article.id, "x", { store })).rejects.toThrow(/取消可能な/);
  });
});

// publish_queue.article_id は DB側で unique。取消/デッドマン差戻し後の再承認で
// 制約違反にならないこと (= 差戻しからの復帰経路が存在すること) を固定する。
describe("approvals: 差戻しからの復帰 (再承認)", () => {
  it("取消 → 再承認で、キュー行は1本のまま有効化される", async () => {
    const { store, article } = await makeWorld();
    await approveArticle(article.id, "renta", { store, now: () => T0 });
    await cancelQueued(article.id, "見直したい", { store });

    const { scheduledAt } = await approveArticle(article.id, "renta", {
      store,
      now: () => hoursLater(1),
    });

    const rows = store.queue.filter((q) => q.article_id === article.id);
    expect(rows).toHaveLength(1); // unique制約と同じ前提
    expect(rows[0]).toMatchObject({ cancelled: false, published: false, scheduled_at: scheduledAt });
    expect(rows[0]!.cancelled_reason).toBeUndefined();
    expect((await store.getArticle(article.id))!.status).toBe("approved");
  });

  it("デッドマン失効 → 再承認でも同様に復帰できる", async () => {
    const { store, article } = await makeWorld();
    await approveArticle(article.id, "renta", { store, now: () => T0 });
    await deadmanSweep({ store, now: () => hoursLater(73) });
    expect((await store.getArticle(article.id))!.status).toBe("approval_pending");

    await approveArticle(article.id, "renta", { store, now: () => hoursLater(158) });

    const rows = store.queue.filter((q) => q.article_id === article.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cancelled).toBe(false);
  });

  it("MemoryStoreがDBのunique制約と同じ前提を持つ (テストと本番の乖離防止)", async () => {
    const { store, article } = await makeWorld();
    await store.insertPublishQueue(article.id, T0.toISOString());
    await store.insertPublishQueue(article.id, hoursLater(5).toISOString());
    expect(store.queue.filter((q) => q.article_id === article.id)).toHaveLength(1);
  });
});

describe("approvals: nextSlot (均等分散)", () => {
  it("予定なし: 即時 (次のワーカ実行で公開)", () => {
    expect(nextSlot([], 2, T0)).toBe(T0.toISOString());
  });

  it("予定あり: 直近の予定から均等分散", () => {
    const existing = [new Date(T0.getTime() + 3600_000).toISOString()];
    const slot = nextSlot(existing, 1, T0); // 1日1本 → 間隔1日
    expect(new Date(slot).getTime() - new Date(existing[0]!).getTime()).toBe(24 * 3600_000);
  });

  it("同日衝突は翌日以降へずらす (同日2本以上の公開禁止)", () => {
    const existing = [new Date(T0.getTime() + 3.5 * 24 * 3600_000).toISOString()];
    // 意図的に同日になる状況を作る: 既存予定と同じ日を基点に
    const slot = nextSlot(existing, 2, T0);
    expect(slot.slice(0, 10)).not.toBe(existing[0]!.slice(0, 10));
  });
});
