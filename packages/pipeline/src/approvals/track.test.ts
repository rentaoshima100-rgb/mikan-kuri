// 改修トラック (revision) と新規トラック (new) の分離を検証する。
//
// 週2本の制限は「新規URLの増加ペース」に対するスパムシグナル回避策であり、
// 既存URLの中身を直す改修は対象外。混ぜると改修完了に数ヶ月かかってしまう。
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../db/memory.js";
import type { ArticleRow, ArticleTrack, KeywordRow } from "../db/types.js";
import type { PublishResult, SitePublisher } from "../site_integration/publisher.js";
import { runPublishWorker } from "../publish/worker.js";
import { runTripwireSweep } from "../tripwire/tripwire.js";
import { approveArticle } from "./approvals.js";

const T0 = new Date("2026-07-24T09:00:00.000Z");
const later = (h: number) => new Date(T0.getTime() + h * 3600_000);

async function makeStore() {
  const store = new MemoryStore();
  store.setConfig("weekly_publish_target", 2);
  store.setConfig("revision_publish_per_day", 5);
  store.setConfig("approval_deadman_hours", 72);
  store.setConfig("approval_backlog_limit_days", 28);
  return store;
}

async function addArticle(store: MemoryStore, track: ArticleTrack, n: number) {
  const kw = store.addKeyword({ keyword: `kw-${track}-${n}` });
  const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
  await store.updateArticle(a.id, {
    status: "approval_pending",
    track,
    slug: `${track}-${n}`,
    title: `${track} ${n}`,
    body_mdx: "本文",
  });
  return a;
}

describe("トラック分離: 公開ペース", () => {
  it("改修は独立ペース (既定5本/日) で、新規の週2本に影響されない", async () => {
    const store = await makeStore();
    const slots: string[] = [];
    for (let i = 0; i < 5; i++) {
      const a = await addArticle(store, "revision", i);
      const { scheduledAt } = await approveArticle(a.id, "renta", { store, now: () => T0 });
      slots.push(scheduledAt);
    }

    // 5本目でも承認から1日以内に収まる (5本/日 = 間隔4.8時間)
    const lastOffsetHours = (new Date(slots[4]!).getTime() - T0.getTime()) / 3600_000;
    expect(lastOffsetHours).toBeLessThanOrEqual(24);
    // 29本でも約6日で終わる想定であることを間隔から確認
    expect(lastOffsetHours).toBeCloseTo(4.8 * 4, 1);
  });

  it("新規は週2本のまま (改修を挟んでもペースが変わらない)", async () => {
    const store = await makeStore();
    // 改修を先に5本承認しても、新規の予定は改修の予定に引きずられない
    for (let i = 0; i < 5; i++) {
      const r = await addArticle(store, "revision", i);
      await approveArticle(r.id, "renta", { store, now: () => T0 });
    }
    const n1 = await addArticle(store, "new", 1);
    const n2 = await addArticle(store, "new", 2);
    const r1 = await approveArticle(n1.id, "renta", { store, now: () => T0 });
    const r2 = await approveArticle(n2.id, "renta", { store, now: () => T0 });

    expect(r1.scheduledAt).toBe(T0.toISOString()); // 新規の公開待ちは無いので即時
    const gapDays =
      (new Date(r2.scheduledAt).getTime() - new Date(r1.scheduledAt).getTime()) / 86400_000;
    expect(gapDays).toBeCloseTo(3.5, 1); // 週2本 = 3.5日間隔
  });
});

describe("トラック分離: 安全装置の適用範囲", () => {
  const publisher: SitePublisher = {
    async publish(a: ArticleRow, _k: KeywordRow | null): Promise<PublishResult> {
      return { url: `https://kuri-mikan.jp/blogs/column/${a.slug}` };
    },
  };

  it("減速 (throttle) 中でも改修は公開できる (新規URLを増やさないため)", async () => {
    const store = await makeStore();
    store.tripwires.push({ event_type: "index_rate_drop", severity: "throttle" });
    // 今週すでに新規を1本公開済み
    const publishedNew = await addArticle(store, "new", 0);
    await store.updateArticle(publishedNew.id, {
      status: "published",
      published_at: T0.toISOString(),
    });

    const rev = await addArticle(store, "revision", 1);
    await approveArticle(rev.id, "renta", { store, now: () => T0 });

    const result = await runPublishWorker({ store, publisher, now: () => later(1) });
    expect(result.published).toHaveLength(1);
    expect(result.published[0]!.articleId).toBe(rev.id);
  });

  it("減速中は新規だけが週1本に制限される", async () => {
    const store = await makeStore();
    store.tripwires.push({ event_type: "index_rate_drop", severity: "throttle" });
    const publishedNew = await addArticle(store, "new", 0);
    await store.updateArticle(publishedNew.id, {
      status: "published",
      published_at: T0.toISOString(),
    });

    const next = await addArticle(store, "new", 1);
    await approveArticle(next.id, "renta", { store, now: () => T0 });

    const result = await runPublishWorker({ store, publisher, now: () => later(1) });
    expect(result.published).toEqual([]);
    expect(result.skipped[0]!.reason).toBe("tripwire_throttle_weekly_limit");
  });

  it("全停止 (halt) は改修も止める", async () => {
    const store = await makeStore();
    store.tripwires.push({ event_type: "manual_action", severity: "halt" });
    const rev = await addArticle(store, "revision", 1);
    await approveArticle(rev.id, "renta", { store, now: () => T0 });

    const result = await runPublishWorker({ store, publisher, now: () => later(1) });
    expect(result.published).toEqual([]);
    expect(result.skipped[0]!.reason).toBe("tripwire_halt");
  });
});

describe("トラック分離: 増速ゲートの母数", () => {
  it("インデックス率の判定に改修を含めない", async () => {
    const store = await makeStore();
    store.setConfig("velocity_stage", 2);
    // 改修を6本、すべて未インデックスにする。新規は0本
    for (let i = 0; i < 6; i++) {
      const a = await addArticle(store, "revision", i);
      await store.updateArticle(a.id, {
        status: "published",
        published_at: later(-10 * 24).toISOString(),
      });
      await store.upsertGscMetrics([
        { article_id: a.id, date: "2026-07-22", index_status: "crawled_not_indexed" },
      ]);
    }

    const result = await runTripwireSweep({ store, now: () => T0 });

    // 改修だけが未インデックスでも増速ゲートは発火しない (母数は新規のみ)
    expect(result.fired.find((f) => f.event_type === "index_rate_drop")).toBeUndefined();
    expect(await store.getConfig("velocity_stage")).toBe(2);
  });
});
