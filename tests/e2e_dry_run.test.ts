// dry_run エンドツーエンド統合テスト。
// キーワード投入 → 生成 → 承認キュー → 承認 → 公開ワーカ → Shopifyへの articleCreate
// までを、実APIも実DBも使わずに通しで検証する。
//
// v3の絶対ルールをE2Eレベルで固定することが目的:
//   1. 承認なしにストアへ1リクエストも飛ばないこと
//   2. 承認が唯一の公開トリガであること
//   3. halt / デッドマン / judge不一致 が公開を止めること
// この案件で追加した歯止め:
//   4. 法令ゲート (薬機法・景表法) は全自動公開中でも公開を止めること
//   5. 記事にはコレクションへの導線が必ず入ること
//
// Shopifyは ShopifyAdminClient の fetch を差し替えた偽ストアで受ける。
// 公開器 (ShopifyPublisher)・markdown→HTML変換・metafieldの組み立ては本物が動く。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FixtureLLMClient, type FixtureResponses } from "@kurimikan/shared";
import {
  approveArticle,
  cancelQueued,
  deadmanSweep,
  fileManualAction,
  generateArticle,
  listRefitTargets,
  MemoryStore,
  refitBatch,
  runPublishWorker,
  sendBackArticle,
  ShopifyAdminClient,
  ShopifyPublisher,
  type ArticleRow,
} from "@kurimikan/pipeline";

const FIXTURES = join(__dirname, "..", "packages", "shared", "fixtures", "llm");
const SUITE = join(__dirname, "..", "kurimikan_prompt_suite_v1.md");
const T0 = new Date("2026-07-24T09:00:00.000Z");
const hours = (h: number) => new Date(T0.getTime() + h * 3600_000);

interface FakeArticle {
  id: string;
  handle: string;
  title: string;
  body: string;
  summary: string;
  metafields: { namespace: string; key: string; value: string }[];
  blogId: string;
}

// Shopify Admin GraphQL の偽ストア。
// 受け取ったmutationを記録するので「承認前に1度も書き込みが起きていない」ことを
// リクエストの並びで確認できる。
class FakeShopify {
  readonly articles: FakeArticle[] = [];
  readonly mutations: string[] = [];
  private seq = 0;

  readonly fetch: typeof fetch = async (_url, init) => {
    const { query, variables } = JSON.parse(String((init as RequestInit).body)) as {
      query: string;
      variables: {
        id?: string;
        article?: {
          blogId?: string;
          handle: string;
          title: string;
          body: string;
          summary: string;
          metafields?: { namespace: string; key: string; value: string }[];
        };
      };
    };

    if (query.includes("blogs(")) {
      return this.json({
        blogs: { nodes: [{ id: "gid://shopify/Blog/1", handle: "column", title: "コラム" }] },
      });
    }
    const input = variables.article;
    if (!input) throw new Error("article入力がありません");

    if (query.includes("articleCreate")) {
      this.mutations.push("articleCreate");
      const a: FakeArticle = {
        id: `gid://shopify/Article/${++this.seq}`,
        handle: input.handle,
        title: input.title,
        body: input.body,
        summary: input.summary,
        metafields: input.metafields ?? [],
        blogId: input.blogId ?? "",
      };
      this.articles.push(a);
      return this.json({ articleCreate: { article: a, userErrors: [] } });
    }
    if (query.includes("articleUpdate")) {
      this.mutations.push("articleUpdate");
      const a = this.articles.find((x) => x.id === variables.id);
      if (!a) {
        return this.json({
          articleUpdate: { article: null, userErrors: [{ message: "not found" }] },
        });
      }
      Object.assign(a, {
        handle: input.handle,
        title: input.title,
        body: input.body,
        summary: input.summary,
        metafields: input.metafields ?? a.metafields,
      });
      return this.json({ articleUpdate: { article: a, userErrors: [] } });
    }
    throw new Error(`偽ストアが知らないクエリです: ${query.slice(0, 80)}`);
  };

  private json(data: unknown): Response {
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  bySlug(slug: string): FakeArticle | undefined {
    return this.articles.find((a) => a.handle === slug);
  }
}

interface World {
  store: MemoryStore;
  llm: FixtureLLMClient;
  shopify: FakeShopify;
  publisher: ShopifyPublisher;
  indexNowCalls: string[][];
}

function makeWorld(responses?: FixtureResponses): World {
  const store = new MemoryStore();
  store.setConfig("weekly_publish_target", 2);
  store.setConfig("approval_deadman_hours", 72);
  store.setConfig("lane_b_allowed_types", ["howto", "comparison", "public_data", "market_report"]);
  store.setConfig("serp_check", { enabled: false });
  store.setConfig("shopify_blog_handle", "column");
  store.setConfig("site_base_url", "https://kuri-mikan.jp");
  store.setConfig("producer_origin", "愛媛・宇和島産");
  store.setConfig("supervision", {
    byline: "監修: 株式会社くり房",
    ai_disclosure: "本記事はAIを活用して制作しています",
  });
  store.setConfig("collections", {
    kanpei: { label: "甘平" },
    nankan20: { label: "南柑20号" },
  });
  const shopify = new FakeShopify();
  const client = new ShopifyAdminClient({
    shop: "kurifusa",
    accessToken: "test-token",
    fetchImpl: shopify.fetch,
  });
  return {
    store,
    llm: new FixtureLLMClient({ fixturesDir: FIXTURES, responses }),
    shopify,
    publisher: new ShopifyPublisher({ client, store }),
    indexNowCalls: [],
  };
}

function deps(w: World) {
  return { store: w.store, llm: w.llm, suitePath: SUITE, budgetUsd: 60 };
}

async function generate(w: World, keyword = "kanpei-guide", lane: "A" | "B" = "A") {
  const kw = w.store.addKeyword({
    keyword,
    cluster: "renewal",
    article_type: "howto",
    assigned_lane: lane,
    target_collection: "kanpei",
  });
  const article = await generateArticle(kw.id, deps(w));
  return { kw, article };
}

async function publish(w: World, at: Date) {
  return runPublishWorker({
    store: w.store,
    publisher: w.publisher,
    indexNow: async (urls) => void w.indexNowCalls.push(urls),
    now: () => at,
  });
}

let w: World;
beforeEach(() => {
  w = makeWorld();
});

describe("E2E: 承認 → 公開の通し (v3のハッピーパス)", () => {
  it("キーワード投入から公開までが完走し、Shopifyに記事とSEO metafieldが作られる", async () => {
    const { article } = await generate(w);

    // 生成直後は承認待ち。ストアには一切書かれていない
    expect(article.status).toBe("approval_pending");
    expect(w.shopify.mutations).toEqual([]);

    const { scheduledAt } = await approveArticle(article.id, "renta", {
      store: w.store,
      now: () => T0,
    });
    // 承認しただけではストアに書かれない (ワーカが動いて初めて反映される)
    expect(w.shopify.mutations).toEqual([]);
    expect((await publish(w, hours(-1))).published).toEqual([]); // 期日前

    // 期日到来 → 公開
    const result = await publish(w, new Date(new Date(scheduledAt).getTime() + 60_000));
    expect(result.published).toHaveLength(1);

    // 1. articleCreate が1回だけ飛ぶ
    expect(w.shopify.mutations).toEqual(["articleCreate"]);
    const created = w.shopify.bySlug(article.slug!)!;
    expect(created).toBeDefined();
    expect(created.title).toBe(article.title);

    // 2. 本文はHTMLに変換されて渡る (markdownのまま渡すと記事に「##」が出る)
    expect(created.body).toContain("<h2>");
    expect(created.body).not.toContain("## ");
    // 監修表記とAI利用の開示が末尾に付く
    expect(created.body).toContain("監修");

    // 3. SEOのtitle/descriptionは metafield で渡る (記事フィールドではない)
    const titleTag = created.metafields.find((m) => m.key === "title_tag")!;
    const descTag = created.metafields.find((m) => m.key === "description_tag")!;
    expect(titleTag.namespace).toBe("global");
    expect(titleTag.value).toBe(article.title);
    expect(descTag.value).toBe(article.meta_description);

    // 4. コレクション導線が本文に入っている (この案件で記事を書く目的そのもの)
    expect(article.body_mdx).toContain("(/collections/kanpei)");
    expect(created.body).toContain('href="/collections/kanpei"');

    // 5. DB状態とIndexNow
    const updated = (await w.store.getArticle(article.id))!;
    expect(updated.status).toBe("published");
    expect(updated.published_at).toBeTruthy();
    expect(updated.shopify_article_id).toBe(created.id);
    expect((await w.store.getQueueEntry(article.id))!.published).toBe(true);
    expect(w.indexNowCalls).toEqual([[`https://kuri-mikan.jp/blogs/column/${article.slug}`]]);

    // 6. 再実行しても二重公開しない
    await publish(w, hours(200));
    expect(w.shopify.mutations).toEqual(["articleCreate"]);
  });

  it("承認しなければストアには永久に書かれない (公開の唯一のトリガは承認)", async () => {
    const { article } = await generate(w);
    expect(article.status).toBe("approval_pending");

    // 1週間ワーカを回し続けても公開されない
    for (let h = 1; h <= 168; h += 24) {
      const r = await publish(w, hours(h));
      expect(r.published).toEqual([]);
    }
    expect(w.shopify.mutations).toEqual([]);
    expect(w.indexNowCalls).toEqual([]);
    expect((await w.store.getArticle(article.id))!.status).toBe("approval_pending");
  });

  it("差戻しは needs_rewrite になり、キューにも入らない", async () => {
    const { article } = await generate(w);
    await sendBackArticle(article.id, "renta", "独自性が弱い", { store: w.store, now: () => T0 });

    expect((await w.store.getArticle(article.id))!.status).toBe("needs_rewrite");
    expect(await w.store.getQueueEntry(article.id)).toBeNull();
    await publish(w, hours(100));
    expect(w.shopify.mutations).toEqual([]);
  });
});

describe("E2E: 安全装置が公開を止める", () => {
  async function approvedArticle(): Promise<{ article: ArticleRow; scheduledAt: string }> {
    const { article } = await generate(w);
    const { scheduledAt } = await approveArticle(article.id, "renta", {
      store: w.store,
      now: () => T0,
    });
    return { article, scheduledAt };
  }

  it("手動対策の受領 (halt) 中は公開されず、解除後に公開される", async () => {
    const { scheduledAt } = await approvedArticle();
    await fileManualAction(w.store, "GSCで手動対策の通知を受領");
    const due = new Date(new Date(scheduledAt).getTime() + 60_000);

    const halted = await publish(w, due);
    expect(halted.skipped[0]!.reason).toBe("tripwire_halt");
    expect(w.shopify.mutations).toEqual([]);

    // 解除は人間のみ
    const ev = w.store.tripwires.find((t) => t.event_type === "manual_action")!;
    await w.store.resolveTripwire(ev.id!);
    expect((await publish(w, due)).published).toHaveLength(1);
    expect(w.shopify.mutations).toEqual(["articleCreate"]);
  });

  it("デッドマン: 承認から72h超はストアに書かず承認待ちへ戻す (フェイルクローズド)", async () => {
    const { article } = await approvedArticle();
    const tooLate = hours(73); // 承認 (T0) から72h超

    const result = await publish(w, tooLate);

    expect(result.skipped[0]!.reason).toBe("approval_expired");
    expect(w.shopify.mutations).toEqual([]); // ストアは無傷
    const updated = (await w.store.getArticle(article.id))!;
    expect(updated.status).toBe("approval_pending");
    expect((await w.store.getQueueEntry(article.id))!.cancelled).toBe(true);

    // 再承認すれば公開できる
    await approveArticle(article.id, "renta", { store: w.store, now: () => tooLate });
    const reScheduled = (await w.store.getArticle(article.id))!.scheduled_at!;
    await publish(w, new Date(new Date(reScheduled).getTime() + 60_000));
    expect(w.shopify.mutations).toEqual(["articleCreate"]);
  });

  it("日次スイープでも同じ失効判定になる (ワーカとsweepの整合)", async () => {
    const { article, scheduledAt } = await approvedArticle();
    const inTime = new Date(new Date(scheduledAt).getTime() + 71 * 3600_000);
    expect(await deadmanSweep({ store: w.store, now: () => inTime })).toEqual([]);

    const tooLate = new Date(new Date(scheduledAt).getTime() + 73 * 3600_000);
    expect(await deadmanSweep({ store: w.store, now: () => tooLate })).toEqual([article.id]);
    expect((await w.store.getArticle(article.id))!.status).toBe("approval_pending");
  });

  it("管理画面からの取消でストアに書かれず承認待ちへ戻る", async () => {
    const { article, scheduledAt } = await approvedArticle();
    await cancelQueued(article.id, "内容を見直したい", { store: w.store });

    await publish(w, new Date(new Date(scheduledAt).getTime() + 60_000));
    expect(w.shopify.mutations).toEqual([]);
    expect((await w.store.getArticle(article.id))!.status).toBe("approval_pending");
  });

  it("承認レコードを消しても公開されない (DB直接操作への防御)", async () => {
    const { scheduledAt } = await approvedArticle();
    w.store.approvals.length = 0;

    const result = await publish(w, new Date(new Date(scheduledAt).getTime() + 60_000));
    expect(result.skipped[0]!.reason).toBe("no_approval_record");
    expect(w.shopify.mutations).toEqual([]);
  });
});

describe("E2E: 法令ゲートは全自動公開でも止める", () => {
  it("効能効果の標榜が残る記事は、full_auto_publish=true でも公開されない", async () => {
    // 全自動は「品質ゲートの結果に関わらず市場に出す」ための設定。
    // 順位が落ちるだけのGoogleと違い、薬機法・景表法は販売者に行政指導が来るので、
    // 速度優先の判断の対象外にしてある
    const violating = "## 甘平とは\n\n毎日食べると免疫力アップが期待できます。日本一甘い柑橘です。\n";
    w = makeWorld({ "P-02": violating });
    w.store.setConfig("full_auto_publish", true);

    const { article } = await generate(w);

    expect(article.status).toBe("rejected");
    const quality = article.quality as { rejected_reason?: string; compliance?: unknown };
    expect(quality.rejected_reason).toContain("法令ゲート");
    expect(quality.compliance).toBeTruthy();

    await publish(w, hours(100));
    expect(w.shopify.mutations).toEqual([]);
  });

  it("指摘のない記事は全自動でも承認キューを通る", async () => {
    w.store.setConfig("full_auto_publish", true);
    const { article } = await generate(w);
    expect(article.status).not.toBe("rejected");
  });
});

describe("E2E: judge不一致 (レーンB) の人間エスカレーション", () => {
  it("不一致フラグ付きは ack なしに承認できず、ack後は通常どおり公開できる", async () => {
    const disagree = JSON.stringify({
      verdicts: [{ id: 1, verdict: "false", reason: "確認できない" }],
    });
    w = makeWorld({ "P-05b-2": disagree });
    const { article } = await generate(w, "kanpei-llmo", "B");

    expect(article.status).toBe("approval_pending"); // 自動棄却されない
    expect(article.judge_disagreement).toBe(true);

    await expect(approveArticle(article.id, "renta", { store: w.store })).rejects.toThrow(
      /judge不一致/,
    );
    expect(w.shopify.mutations).toEqual([]);

    const { scheduledAt } = await approveArticle(
      article.id,
      "renta",
      { store: w.store, now: () => T0 },
      { judgeAck: true },
    );
    await publish(w, new Date(new Date(scheduledAt).getTime() + 60_000));
    expect(w.shopify.mutations).toEqual(["articleCreate"]);
    expect(w.store.approvals[0]!.judge_disagreement_ack).toBe(true);
  });
});

describe("E2E: 既存記事の改修 (refit)", () => {
  it("改修は承認後に articleUpdate だけを行い、新しい記事を作らない", async () => {
    // まず1本公開して、改修の対象を作る。
    // MemoryStoreは行オブジェクトを共有するので、公開の座が移った後に
    // article.slug を読むと null になる。先に控えておく
    const { article } = await generate(w);
    const slug = article.slug!;
    const first = await approveArticle(article.id, "renta", { store: w.store, now: () => T0 });
    await publish(w, new Date(new Date(first.scheduledAt).getTime() + 60_000));
    const shopifyId = (await w.store.getArticle(article.id))!.shopify_article_id!;
    expect(w.shopify.articles).toHaveLength(1);

    const targets = await listRefitTargets(w.store);
    expect(targets.map((t) => t.slug)).toEqual([slug]);

    const batch = await refitBatch(deps(w));
    expect(batch.processed).toEqual([{ slug, status: "approval_pending" }]);
    // 承認前はストア無傷 (articleCreateの1回だけ)
    expect(w.shopify.mutations).toEqual(["articleCreate"]);

    const revision = (await w.store.listArticlesByStatus("approval_pending"))[0]!;
    // 改修案はslugを持たない。公開中の記事がURLを握ったままにする
    expect(revision.slug).toBeFalsy();
    expect(revision.revision_of).toBe(article.id);

    const { scheduledAt } = await approveArticle(revision.id, "renta", {
      store: w.store,
      now: () => T0,
    });
    await publish(w, new Date(new Date(scheduledAt).getTime() + 60_000));

    // Shopify上の記事は1本のまま。中身だけが差し替わる
    expect(w.shopify.articles).toHaveLength(1);
    expect(w.shopify.mutations).toEqual(["articleCreate", "articleUpdate"]);
    expect(w.shopify.articles[0]!.body).toContain("改修後の本文");
    expect(w.shopify.articles[0]!.handle).toBe(slug);

    // 公開中の座 (slug と Shopify記事ID) が改修案へ移り、旧行はretiredになる
    const publishedRevision = (await w.store.getArticle(revision.id))!;
    expect(publishedRevision.status).toBe("published");
    expect(publishedRevision.slug).toBe(slug);
    expect(publishedRevision.shopify_article_id).toBe(shopifyId);
    const old = (await w.store.getArticle(article.id))!;
    expect(old.status).toBe("retired");
    expect(old.slug).toBeFalsy();
    expect(old.shopify_article_id).toBeFalsy();
  });
});

describe("E2E: dry_run保証", () => {
  it("通し実行でも実APIは1度も呼ばれない (fixtureのみ)", async () => {
    const { article } = await generate(w);
    const { scheduledAt } = await approveArticle(article.id, "renta", {
      store: w.store,
      now: () => T0,
    });
    await publish(w, new Date(new Date(scheduledAt).getTime() + 60_000));

    expect(w.llm.calls.length).toBeGreaterThan(0);
    // FixtureLLMClientのみを使用している = 実APIクライアントは構築すらされない
    expect(w.llm).toBeInstanceOf(FixtureLLMClient);
    // 生成に使われたプロンプトIDが配線図どおり
    const ids = new Set(w.llm.calls.map((c) => c.promptId));
    expect(ids.has("P-01")).toBe(true);
    expect(ids.has("P-02")).toBe(true);
    expect(ids.has("P-04")).toBe(true);
    expect(ids.has("P-12")).toBe(true);
    expect(ids.has("P-11")).toBe(true);
  });
});
