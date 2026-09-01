import { describe, expect, it } from "vitest";
import { MemoryStore } from "../db/memory.js";
import { approveArticle } from "../approvals/approvals.js";
import type { ArticleRow, KeywordRow } from "../db/types.js";
import type { PublishResult, SitePublisher } from "../site_integration/publisher.js";
import { runPublishWorker } from "./worker.js";

const T0 = new Date("2026-07-24T09:00:00.000Z");
const later = (h: number) => new Date(T0.getTime() + h * 3600_000);

const updatedExpiredReason = (a: ArticleRow | null) => a?.expired_reason ?? "";

class FakePublisher implements SitePublisher {
  published: string[] = [];
  async publish(article: ArticleRow, _kw: KeywordRow | null): Promise<PublishResult> {
    this.published.push(article.slug!);
    return { url: `https://kuri-mikan.jp/blogs/column/${article.slug}` };
  }
}

async function makeWorld() {
  const store = new MemoryStore();
  store.setConfig("weekly_publish_target", 2);
  store.setConfig("approval_deadman_hours", 72);
  const kw = store.addKeyword({ keyword: "kw", cluster: "renewal" });
  const article = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
  await store.updateArticle(article.id, {
    status: "approval_pending",
    slug: "test-article",
    title: "テスト記事",
    body_mdx: "本文",
  });
  await approveArticle(article.id, "renta", { store, now: () => T0 });
  const publisher = new FakePublisher();
  return { store, article, publisher };
}

describe("publish worker: 予算超過との関係", () => {
  it("月次予算を使い切っても承認済み記事の公開は続く", async () => {
    // SPEC: 予算100%で止めるのは「生成系」だけ。公開はLLMを呼ばないので止めない。
    // 代表が承認済みの記事が予算都合で公開されないと、承認が黙って失効してしまう
    const { store, article, publisher } = await makeWorld();
    store.monthSpendUsd = 9999;

    const result = await runPublishWorker({ store, publisher, now: () => later(1) });

    expect(result.published).toHaveLength(1);
    expect((await store.getArticle(article.id))!.status).toBe("published");
  });
});

describe("publish worker: 正常系", () => {
  it("期日到来+承認レコードありの記事を公開し、IndexNowを送信する", async () => {
    const { store, article, publisher } = await makeWorld();
    const pinged: string[][] = [];
    // 公開待ちが無い状態での承認なので scheduled_at は承認時刻。次の実行で公開される
    const result = await runPublishWorker({
      store,
      publisher,
      indexNow: async (urls) => void pinged.push(urls),
      now: () => later(1),
    });

    expect(result.published).toEqual([
      { articleId: article.id, url: "https://kuri-mikan.jp/blogs/column/test-article" },
    ]);
    const updated = (await store.getArticle(article.id))!;
    expect(updated.status).toBe("published");
    expect(updated.published_at).toBeTruthy();
    expect((await store.getQueueEntry(article.id))!.published).toBe(true);
    expect(pinged).toEqual([["https://kuri-mikan.jp/blogs/column/test-article"]]);
  });

  it("期日前は何もしない / 公開済みは二重公開しない", async () => {
    const { store, publisher } = await makeWorld();
    // 期日前 (承認時刻より前)
    expect(
      (await runPublishWorker({ store, publisher, now: () => later(-1) })).published,
    ).toEqual([]);
    // 公開
    await runPublishWorker({ store, publisher, now: () => later(1) });
    // 再実行しても対象なし (published=trueで排他)
    const again = await runPublishWorker({ store, publisher, now: () => later(2) });
    expect(again.published).toEqual([]);
    expect(publisher.published).toHaveLength(1);
  });

  it("IndexNow失敗でも公開は成立する (best-effort)", async () => {
    const { store, article, publisher } = await makeWorld();
    const result = await runPublishWorker({
      store,
      publisher,
      indexNow: async () => {
        throw new Error("network down");
      },
      now: () => later(1),
    });
    expect(result.published[0]!.articleId).toBe(article.id);
    expect((await store.getArticle(article.id))!.status).toBe("published");
  });
});

describe("publish worker: 失敗の隔離 (head-of-line blocking防止)", () => {
  it("先頭の記事が公開に失敗しても、後続の記事は公開される", async () => {
    const { store, article, publisher } = await makeWorld();
    // 2本目も承認する。1本目は即時 (T0)、2本目は間隔1日 (T0+24h)。
    // どちらも期日到来かつ失効前 (承認から72h以内) の時刻で実行する
    store.setConfig("weekly_publish_target", 7);
    const kw2 = store.addKeyword({ keyword: "kw2" });
    const a2 = await store.createArticle({ keyword_id: kw2.id, article_type: "howto", lane: "A" });
    await store.updateArticle(a2.id, {
      status: "approval_pending",
      slug: "second",
      title: "2本目",
      body_mdx: "本文",
    });
    await approveArticle(a2.id, "renta", { store, now: () => T0 });

    // 先頭 (article) の公開だけ失敗させる
    const failing: SitePublisher = {
      async publish(a: ArticleRow): Promise<PublishResult> {
        if (a.id === article.id) throw new Error("git push rejected");
        publisher.published.push(a.slug!);
        return { url: `https://kuri-mikan.jp/blogs/column/${a.slug}` };
      },
    };

    const result = await runPublishWorker({
      store,
      publisher: failing,
      now: () => later(30),
    });

    expect(result.skipped[0]!.reason).toContain("publish_failed");
    expect(result.published).toHaveLength(1);
    expect(result.published[0]!.articleId).toBe(a2.id); // 後続が公開された
    // 失敗した記事のキュー行は有効なまま (次回再試行される)
    const q = await store.getQueueEntry(article.id);
    expect(q!.published).toBe(false);
    expect(q!.cancelled).toBe(false);
  });
});

describe("publish worker: 安全装置 (v3)", () => {
  it("halt中は公開せずスキップする", async () => {
    const { store, publisher } = await makeWorld();
    store.tripwires.push({ event_type: "manual_action", severity: "halt" });
    const result = await runPublishWorker({ store, publisher, now: () => later(1) });

    expect(result.published).toEqual([]);
    expect(result.skipped[0]!.reason).toBe("tripwire_halt");
    expect(publisher.published).toEqual([]);
  });

  it("throttle中は週1本まで", async () => {
    const { store, article, publisher } = await makeWorld();
    store.tripwires.push({ event_type: "index_rate_drop", severity: "throttle" });
    // 今週すでに1本公開済みにする
    const kw2 = store.addKeyword({ keyword: "kw2" });
    const a2 = await store.createArticle({ keyword_id: kw2.id, article_type: "howto", lane: "A" });
    await store.updateArticle(a2.id, { published_at: later(0.5).toISOString() });

    const result = await runPublishWorker({ store, publisher, now: () => later(1) });
    expect(result.skipped[0]).toEqual({
      articleId: article.id,
      reason: "tripwire_throttle_weekly_limit",
    });
  });

  it("公開予定から72h超は公開せず保留に戻す (公開時のフェイルクローズド)", async () => {
    const { store, article, publisher } = await makeWorld();
    // 公開予定 (承認時刻=T0) を72h過ぎても公開されていない = 何かが壊れている状態
    const result = await runPublishWorker({ store, publisher, now: () => later(73) });

    expect(result.published).toEqual([]);
    expect(result.skipped[0]!.reason).toBe("approval_expired");
    expect(updatedExpiredReason(await store.getArticle(article.id))).toContain("公開予定から72時間");
    const updated = (await store.getArticle(article.id))!;
    expect(updated.status).toBe("approval_pending");
    expect((await store.getQueueEntry(article.id))!.cancelled).toBe(true);
    expect(publisher.published).toEqual([]);
  });

  it("承認レコードなし (直接DBを弄る等) では公開しない", async () => {
    const { store, publisher } = await makeWorld();
    store.approvals.length = 0; // 承認レコードを消す
    const result = await runPublishWorker({ store, publisher, now: () => later(1) });
    expect(result.skipped[0]!.reason).toBe("no_approval_record");
    expect(publisher.published).toEqual([]);
  });
});
