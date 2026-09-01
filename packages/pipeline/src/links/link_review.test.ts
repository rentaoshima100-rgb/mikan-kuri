import { describe, expect, it } from "vitest";
import { MemoryStore } from "../db/memory.js";
import type { ArticleRow, KeywordRow } from "../db/types.js";
import type { PublishResult, SitePublisher } from "../site_integration/publisher.js";
import { applyLinkToBody } from "./apply_link.js";
import { applyApprovedLinks, listLinkReviewQueue, rejectLink } from "./link_review.js";

const BODY = `## 甘平の値段はどれくらい？

大きさと時期で変わります。ここでは変動要因を整理します。

## 保存方法は？

風通しのよい冷暗所に置きます。

## 関連リンク

- [甘平の商品一覧](/collections/kanpei)
`;

// 公開器の偽実装。渡された本文をそのまま記録するので、
// 「DBを書き換えてから同じ本文で再公開したか」を検証できる
class FakePublisher implements SitePublisher {
  readonly published: { slug: string; body: string }[] = [];
  constructor(private failWith?: Error) {}
  async publish(article: ArticleRow, _keyword: KeywordRow | null): Promise<PublishResult> {
    if (this.failWith) throw this.failWith;
    this.published.push({ slug: article.slug!, body: article.body_mdx ?? "" });
    return { url: `https://kuri-mikan.jp/blogs/column/${article.slug}` };
  }
}

async function makeWorld(opts: { status?: ArticleRow["status"] } = {}) {
  const store = new MemoryStore();
  const kw = store.addKeyword({ keyword: "甘平 通販" });
  const existing = await store.createArticle({
    keyword_id: kw.id,
    article_type: "howto",
    lane: "A",
  });
  await store.updateArticle(existing.id, {
    slug: "kanpei-price",
    title: "甘平の値段",
    body_mdx: BODY,
    status: opts.status ?? "published",
  });
  await store.insertInternalLinks([
    {
      source_article_id: existing.id,
      target_url: "/blogs/column/kanpei-storage",
      anchor: "甘平の保存方法",
      direction: "inbound",
      insert_hint: "甘平の値段はどれくらい？",
      status: "proposed",
    },
  ]);
  return { store, existing };
}

describe("apply_link: 挿入位置の決定", () => {
  const proposal = {
    id: "l1",
    source_article_id: "a1",
    target_url: "/blogs/column/kanpei-storage",
    anchor: "保存方法",
  };

  it("insert_hintのH2直後の段落末に一文を足す", () => {
    const diff = applyLinkToBody(BODY, { ...proposal, insert_hint: "甘平の値段はどれくらい？" });
    expect(diff.inserted).toBe(true);
    expect(diff.changedLine).toContain("[保存方法](/blogs/column/kanpei-storage)");
    // 該当セクション内に入っていること (次のH2より前)
    const idx = diff.after.indexOf(diff.changedLine);
    expect(idx).toBeGreaterThan(diff.after.indexOf("## 甘平の値段はどれくらい？"));
    expect(idx).toBeLessThan(diff.after.indexOf("## 保存方法は？"));
  });

  it("見出しが特定できなければ関連リンクブロックへ追加する", () => {
    const diff = applyLinkToBody(BODY, { ...proposal, insert_hint: "存在しない見出し" });
    expect(diff.inserted).toBe(true);
    expect(diff.changedLine).toBe("- [保存方法](/blogs/column/kanpei-storage)");
    expect(diff.after.indexOf(diff.changedLine)).toBeGreaterThan(
      diff.after.indexOf("## 関連リンク"),
    );
  });

  it("同じリンク先が既にあれば二重に張らない", () => {
    const diff = applyLinkToBody(BODY, { ...proposal, target_url: "/collections/kanpei" });
    expect(diff.inserted).toBe(false);
    expect(diff.after).toBe(BODY);
    expect(diff.reason).toContain("既に");
  });
});

describe("link_review: 承認キュー", () => {
  it("inbound提案を差分つきで一覧化する", async () => {
    const { store } = await makeWorld();
    const items = await listLinkReviewQueue({ store });

    expect(items).toHaveLength(1);
    expect(items[0]!.diff?.inserted).toBe(true);
    expect(items[0]!.targetArticle?.slug).toBe("kanpei-price");
    expect(items[0]!.diff?.changedLine).toContain("甘平の保存方法");
  });

  it("outbound提案はキューに出さない (公開時に本文へ適用済みのため)", async () => {
    const { store, existing } = await makeWorld();
    await store.insertInternalLinks([
      {
        source_article_id: existing.id,
        target_url: "/collections/kanpei",
        anchor: "甘平の商品一覧",
        direction: "outbound",
        status: "proposed",
      },
    ]);
    const items = await listLinkReviewQueue({ store });
    expect(items).toHaveLength(1);
    expect(items[0]!.link.direction).toBe("inbound");
  });
});

describe("link_review: 承認して反映", () => {
  it("承認した分だけ本文を書き換え、公開済みならストアへ再公開する", async () => {
    const { store, existing } = await makeWorld();
    const publisher = new FakePublisher();
    const [item] = await listLinkReviewQueue({ store });

    const result = await applyApprovedLinks([item!.link.id], "renta", { store, publisher });

    expect(result.applied).toEqual([item!.link.id]);
    expect(result.republished).toEqual(["https://kuri-mikan.jp/blogs/column/kanpei-price"]);

    // DBの本文が正。ここが書き換わっていないと次回の公開で元に戻る
    const updated = await store.getArticle(existing.id);
    expect(updated!.body_mdx).toContain("[甘平の保存方法](/blogs/column/kanpei-storage)");
    // 再公開には書き換え後の本文が渡る
    expect(publisher.published[0]!.body).toBe(updated!.body_mdx);

    const applied = await store.listInternalLinksByStatus("applied");
    expect(applied).toHaveLength(1);
    expect(applied[0]!.reviewed_by).toBe("renta");
  });

  it("未公開の記事はストアを触らず本文だけ書き換える", async () => {
    const { store, existing } = await makeWorld({ status: "approval_pending" });
    const publisher = new FakePublisher();
    const [item] = await listLinkReviewQueue({ store });

    const result = await applyApprovedLinks([item!.link.id], "renta", { store, publisher });

    expect(result.applied).toEqual([item!.link.id]);
    expect(result.republished).toEqual([]);
    expect(publisher.published).toEqual([]);
    expect((await store.getArticle(existing.id))!.body_mdx).toContain("甘平の保存方法");
  });

  it("再公開に失敗しても本文の書き換えとappliedの記録は残す", async () => {
    // 巻き戻すと「DBとストアのどちらが正か」が実行のたびに変わる。
    // 追いつく手段 (再実行) がある側に倒す
    const { store, existing } = await makeWorld();
    const publisher = new FakePublisher(new Error("429 Too Many Requests"));
    const [item] = await listLinkReviewQueue({ store });

    const result = await applyApprovedLinks([item!.link.id], "renta", { store, publisher });

    expect(result.applied).toEqual([item!.link.id]);
    expect(result.republished).toEqual([]);
    expect((await store.getArticle(existing.id))!.body_mdx).toContain("甘平の保存方法");
    expect(await store.listInternalLinksByStatus("applied")).toHaveLength(1);
  });

  it("承認していない提案は本文に反映されない", async () => {
    const { store, existing } = await makeWorld();

    const result = await applyApprovedLinks([], "renta", { store });

    expect(result.applied).toEqual([]);
    expect((await store.getArticle(existing.id))!.body_mdx).toBe(BODY);
    expect(await store.listInternalLinksByStatus("proposed")).toHaveLength(1);
  });

  it("却下した提案は残り続けず、本文も変わらない", async () => {
    const { store, existing } = await makeWorld();
    const [item] = await listLinkReviewQueue({ store });

    await rejectLink(item!.link.id, "renta", "文脈に合わない", { store });

    expect(await store.listInternalLinksByStatus("proposed")).toHaveLength(0);
    const rejected = await store.listInternalLinksByStatus("rejected");
    expect(rejected[0]!.review_notes).toBe("文脈に合わない");
    expect((await store.getArticle(existing.id))!.body_mdx).toBe(BODY);
  });
});
