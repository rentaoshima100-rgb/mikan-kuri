import { describe, expect, it } from "vitest";
import { MemoryStore } from "../db/memory.js";
import { runPublishWorker } from "../publish/worker.js";
import { approveArticle } from "../approvals/approvals.js";
import type { ArticleRow, KeywordRow } from "../db/types.js";
import type { PublishResult, SitePublisher } from "../site_integration/publisher.js";
import { fileManualAction, runTripwireSweep } from "./tripwire.js";

const NOW = new Date("2026-07-24T09:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400_000).toISOString();

async function seedPublished(store: MemoryStore, n: number, indexStatus: (i: number) => string) {
  for (let i = 0; i < n; i++) {
    const kw = store.addKeyword({ keyword: `kw-${i}-${Math.random()}` });
    const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
    await store.updateArticle(a.id, {
      status: "published",
      slug: `post-${i}`,
      published_at: daysAgo(10),
    });
    await store.upsertGscMetrics([
      { article_id: a.id, date: daysAgo(2).slice(0, 10), index_status: indexStatus(i) },
    ]);
  }
}

describe("tripwire: (a) index_rate", () => {
  it("直近28日公開分のindexed率<80%でthrottle起票 + velocity_stageを1段階戻す", async () => {
    const store = new MemoryStore();
    store.setConfig("velocity_stage", 2);
    // 6本中3本のみindexed = 50%
    await seedPublished(store, 6, (i) => (i < 3 ? "indexed" : "crawled_not_indexed"));

    const result = await runTripwireSweep({ store, now: () => NOW });

    const fired = result.fired.find((f) => f.event_type === "index_rate_drop");
    expect(fired?.severity).toBe("throttle");
    expect(await store.getConfig("velocity_stage")).toBe(1);
  });

  it("サンプル5本未満では判定しない (立ち上げ直後の誤発火防止)", async () => {
    const store = new MemoryStore();
    await seedPublished(store, 3, () => "crawled_not_indexed");
    const result = await runTripwireSweep({ store, now: () => NOW });
    expect(result.fired.find((f) => f.event_type === "index_rate_drop")).toBeUndefined();
  });

  it("未解決の同種イベントがあれば再起票しない (dedupe)", async () => {
    const store = new MemoryStore();
    store.setConfig("velocity_stage", 2);
    await seedPublished(store, 6, () => "crawled_not_indexed");
    await runTripwireSweep({ store, now: () => NOW });
    const second = await runTripwireSweep({ store, now: () => NOW });
    expect(second.fired).toHaveLength(0);
    expect(store.tripwires.filter((t) => t.event_type === "index_rate_drop")).toHaveLength(1);
  });
});

describe("tripwire: (b) cni_spike", () => {
  it("CNIが前週比2倍超でthrottle", async () => {
    const store = new MemoryStore();
    // 前週2件、今週5件
    await store.upsertGscMetrics([
      { article_id: "a1", date: daysAgo(10).slice(0, 10), index_status: "crawled_not_indexed" },
      { article_id: "a2", date: daysAgo(9).slice(0, 10), index_status: "crawled_not_indexed" },
      { article_id: "a3", date: daysAgo(3).slice(0, 10), index_status: "crawled_not_indexed" },
      { article_id: "a4", date: daysAgo(2).slice(0, 10), index_status: "crawled_not_indexed" },
      { article_id: "a5", date: daysAgo(2).slice(0, 10), index_status: "crawled_not_indexed" },
      { article_id: "a6", date: daysAgo(1).slice(0, 10), index_status: "crawled_not_indexed" },
      { article_id: "a7", date: daysAgo(1).slice(0, 10), index_status: "crawled_not_indexed" },
    ]);
    const result = await runTripwireSweep({ store, now: () => NOW });
    const fired = result.fired.find((f) => f.event_type === "cni_spike");
    expect(fired?.severity).toBe("throttle");
    expect(fired?.detail).toMatchObject({ thisWeek: 5, prevWeek: 2 });
  });
});

describe("tripwire: (c) score_anomaly", () => {
  it("直近10本の平均が前月平均より10点超低下でhalt (v3: 新規公開の全停止)", async () => {
    const store = new MemoryStore();
    // 前月分: 平均88 (created_atを45日前に設定)
    for (let i = 0; i < 5; i++) {
      const kw = store.addKeyword({ keyword: `old-${i}` });
      const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
      store.articles.get(a.id)!.created_at = daysAgo(45);
      await store.updateArticle(a.id, { quality_score: 88 });
    }
    // 直近10本: 平均75
    for (let i = 0; i < 10; i++) {
      const kw = store.addKeyword({ keyword: `new-${i}` });
      const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
      store.articles.get(a.id)!.created_at = daysAgo(2);
      await store.updateArticle(a.id, { quality_score: 75 });
    }

    const result = await runTripwireSweep({ store, now: () => NOW });
    const fired = result.fired.find((f) => f.event_type === "score_anomaly");
    expect(fired?.severity).toBe("halt");
  });
});

describe("tripwire: (d) budget_80pct", () => {
  it("月間コストが予算の80%でinfo起票", async () => {
    const store = new MemoryStore();
    store.monthSpendUsd = 50;
    const result = await runTripwireSweep({ store, now: () => NOW, budgetUsd: 60 });
    const fired = result.fired.find((f) => f.event_type === "budget_80pct");
    expect(fired?.severity).toBe("info");
  });

  it("80%未満では起票しない", async () => {
    const store = new MemoryStore();
    store.monthSpendUsd = 40;
    const result = await runTripwireSweep({ store, now: () => NOW, budgetUsd: 60 });
    expect(result.fired).toHaveLength(0);
  });
});

describe("tripwire: 公開ワーカ連動 (統合)", () => {
  it("手動対策通知の受領 (halt) 後はワーカが公開しない。解除後は公開する", async () => {
    const store = new MemoryStore();
    store.setConfig("weekly_publish_target", 2);
    store.setConfig("approval_deadman_hours", 72);
    const kw = store.addKeyword({ keyword: "kw" });
    const article = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
    await store.updateArticle(article.id, {
      status: "approval_pending",
      slug: "post",
      title: "t",
      body_mdx: "b",
    });
    await approveArticle(article.id, "renta", { store, now: () => NOW });

    await fileManualAction(store, "GSCで手動対策の通知を受領");

    const publisher: SitePublisher = {
      async publish(a: ArticleRow, _k: KeywordRow | null): Promise<PublishResult> {
        return { url: `https://kuri-mikan.jp/blogs/column/${a.slug}` };
      },
    };
    // 承認直後に公開予定が入るため、失効期限 (承認から72h) 内で実行する
    const runAt = new Date(NOW.getTime() + 3600_000);
    const halted = await runPublishWorker({ store, publisher, now: () => runAt });
    expect(halted.published).toEqual([]);
    expect(halted.skipped[0]!.reason).toBe("tripwire_halt");

    // 解除は人間 (管理画面) のみ → 解除後は公開される
    const haltEvent = store.tripwires.find((t) => t.event_type === "manual_action")!;
    await store.resolveTripwire(haltEvent.id!);
    const resumed = await runPublishWorker({ store, publisher, now: () => runAt });
    expect(resumed.published).toHaveLength(1);
  });
});
