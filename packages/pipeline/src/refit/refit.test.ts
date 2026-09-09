import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FixtureLLMClient, type FixtureResponses, type P04VerdictT } from "@kurimikan/shared";
import { MemoryStore } from "../db/memory.js";
import {
  buildDirectiveBlock,
  listRefitTargets,
  refitArticle,
  refitBatch,
  type EditorialDirective,
  type RefitDeps,
  type RefitEntry,
} from "./refit.js";
import { isBetterVerdict } from "../orchestrator/generate.js";

const FIXTURES = join(__dirname, "..", "..", "..", "shared", "fixtures", "llm");
const SUITE = join(__dirname, "..", "..", "..", "..", "kurimikan_prompt_suite_v1.md");

// 改修の対象は「公開済みの記事」。nortiq版はサイトのbuild.jsを読んでいたが、
// Shopify公開ではDBが本文の正なので、published の記事をそのまま対象にする
const SEED = [
  { slug: "kanpei-price", title: "甘平の値段はいくらか", cluster: "kanpei", collection: "kanpei" },
  { slug: "nankan-season", title: "南柑20号の旬はいつか", cluster: "nankan20", collection: "nankan20" },
];

async function seedPublished(store: MemoryStore) {
  for (const s of SEED) {
    const kw = store.addKeyword({
      keyword: s.slug,
      cluster: s.cluster,
      status: "done",
      target_collection: s.collection,
    });
    const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
    await store.updateArticle(a.id, {
      slug: s.slug,
      title: s.title,
      body_mdx: `## ${s.title}\n\n元の本文です。\n`,
      shopify_article_id: `gid://shopify/Article/${s.slug}`,
      status: "published",
    });
  }
}

async function makeWorld(responses?: FixtureResponses): Promise<{
  store: MemoryStore;
  llm: FixtureLLMClient;
  deps: RefitDeps;
  targets: RefitEntry[];
}> {
  const store = new MemoryStore();
  await seedPublished(store);
  const llm = new FixtureLLMClient({ fixturesDir: FIXTURES, responses });
  return {
    store,
    llm,
    deps: { store, llm, suitePath: SUITE, budgetUsd: 60 },
    targets: await listRefitTargets(store),
  };
}

const fx = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

describe("refit: 対象の列挙", () => {
  it("公開済みの記事を本文つきで返す", async () => {
    const { targets } = await makeWorld();
    expect(targets.map((t) => t.slug)).toEqual(["kanpei-price", "nankan-season"]);
    expect(targets[0]).toMatchObject({
      slug: "kanpei-price",
      title: "甘平の値段はいくらか",
      cluster: "kanpei",
      targetCollection: "kanpei",
    });
    expect(targets[0]!.body).toContain("元の本文です");
  });

  it("staleOnly: 期限切れの一次情報を使っている記事だけを返す", async () => {
    const { store, targets } = await makeWorld();
    const fresh = store.addAsset({
      title: "今季の糖度",
      applicable_clusters: ["kanpei"],
      valid_until: "2026-12-31",
    });
    const expired = store.addAsset({
      title: "昨季の糖度",
      applicable_clusters: ["nankan20"],
      valid_until: "2026-03-31",
    });
    await store.recordArticleAssets(targets[0]!.articleId, [fresh.id]);
    await store.recordArticleAssets(targets[1]!.articleId, [expired.id]);

    const stale = await listRefitTargets(store, {
      staleOnly: true,
      asOf: new Date("2026-09-08T00:00:00Z"),
    });
    expect(stale.map((t) => t.slug)).toEqual(["nankan-season"]);
  });

  it("markExpiredAssets: 期限切れに refresh_needed を立てる", async () => {
    const { store } = await makeWorld();
    store.addAsset({ title: "期限なし", applicable_clusters: ["kanpei"] });
    store.addAsset({ title: "切れた", applicable_clusters: ["kanpei"], valid_until: "2026-03-31" });

    const marked = await store.markExpiredAssets(new Date("2026-09-08T00:00:00Z"));

    expect(marked).toBe(1);
    expect(store.assets.find((a) => a.title === "切れた")!.status).toBe("refresh_needed");
    expect(store.assets.find((a) => a.title === "期限なし")!.status).toBe("active");
  });

  it("未公開の記事は対象にしない", async () => {
    const { store } = await makeWorld();
    const kw = store.addKeyword({ keyword: "下書き" });
    const draft = await store.createArticle({
      keyword_id: kw.id,
      article_type: "howto",
      lane: "A",
    });
    await store.updateArticle(draft.id, {
      slug: "draft-only",
      title: "下書き",
      body_mdx: "本文",
      status: "approval_pending",
    });
    expect((await listRefitTargets(store)).map((t) => t.slug)).toEqual([
      "kanpei-price",
      "nankan-season",
    ]);
  });
});

describe("refit: 1記事の改修", () => {
  it("P-13a診断→P-13b改稿→P-04で承認キューに積まれる (タイトルは維持)", async () => {
    const { store, llm, deps, targets } = await makeWorld();

    const { article } = await refitArticle(targets[0]!, deps);

    expect(article.status).toBe("approval_pending");
    expect(article.title).toBe("甘平の値段はいくらか"); // 既存順位保護
    expect(article.track).toBe("revision");
    // 改修案はslugを持たない。公開中の記事が握ったままにする
    expect(article.slug).toBeFalsy();
    expect(article.revision_of).toBe(targets[0]!.articleId);
    expect(article.body_mdx).toContain("改修後の本文");
    const kw = await store.findKeywordByName("refit:kanpei-price");
    expect(kw?.source).toBe("refit");
    expect(kw?.target_collection).toBe("kanpei");
    // P-13aのプロンプトに改修チェックリストが含まれる
    const p13aCall = llm.calls.find((c) => c.promptId === "P-13a")!;
    expect(p13aCall.user).toContain("refit_checklist");
    expect(p13aCall.user).toContain("長音省略");
    // 既存記事改修はレーンA相当: P-05/P-06は呼ばれない
    expect(llm.calls.map((c) => c.promptId)).not.toContain("P-06");
    expect(llm.calls.map((c) => c.promptId)).not.toContain("P-05a");
  });

  it("公開中の記事はrefitArticleでは変更されない (反映は承認後の公開ワーカ)", async () => {
    const { store, deps, targets } = await makeWorld();

    await refitArticle(targets[0]!, deps);

    const original = await store.getArticle(targets[0]!.articleId);
    expect(original!.status).toBe("published");
    expect(original!.slug).toBe("kanpei-price");
    expect(original!.body_mdx).toContain("元の本文です");
  });

  it("一次情報(数値+出典)を出典つきで織り込むようP-13bに強制注入する", async () => {
    const { store, llm, deps, targets } = await makeWorld();
    store.addAsset({
      applicable_clusters: ["kanpei"],
      content: "2026年1月の収穫分は糖度13.2度でした。",
      numeric_claims: [
        {
          claim: "甘平の糖度",
          value: "13.2",
          unit: "度",
          basis: "自社選果場の実測 2026-01-15 (n=40)",
        },
      ],
    });

    await refitArticle(targets[0]!, deps);

    const p13b = llm.calls.find((c) => c.promptId === "P-13b")!;
    expect(p13b.user).toContain("織り込み指示");
    expect(p13b.user).toContain("甘平の糖度: 13.2度");
    expect(p13b.user).toContain("自社選果場の実測 2026-01-15");
  });

  it("P-04 rejectなら改修案は棄却され、公開中の記事は無傷", async () => {
    const p04 = JSON.parse(fx("P-04.json"));
    p04.verdict = "reject";
    const { store, deps, targets } = await makeWorld({ "P-04": JSON.stringify(p04) });

    const { article } = await refitArticle(targets[0]!, deps);

    expect(article.status).toBe("rejected");
    const original = await store.getArticle(targets[0]!.articleId);
    expect(original!.status).toBe("published");
    expect(original!.body_mdx).toContain("元の本文です");
  });

  it("1回目rejectでも fix指示を添えて再改稿し、2回目approveなら承認キューへ", async () => {
    // 改稿AIが1箇所ハルシネーションしても、修正指示つきの再試行で復帰できること
    // (新規生成と同じ1回リトライ)。
    const approve = JSON.parse(fx("P-04.json"));
    const reject = { ...approve, verdict: "reject", fix_instructions: ["架空の製品を削除する"] };
    let gate = 0;
    const { store, llm, deps, targets } = await makeWorld({
      "P-04": () => JSON.stringify(++gate === 1 ? reject : approve),
    });

    const { article } = await refitArticle(targets[0]!, deps);

    expect(article.status).toBe("approval_pending");
    // P-13bは2回 (初回 + 修正再改稿)、P-04も2回呼ばれる
    expect(llm.calls.filter((c) => c.promptId === "P-13b")).toHaveLength(2);
    expect(llm.calls.filter((c) => c.promptId === "P-04")).toHaveLength(2);
    // 再改稿のプロンプトにはP-04のfix指示が渡る
    const secondRewrite = llm.calls.filter((c) => c.promptId === "P-13b")[1]!;
    expect(secondRewrite.user).toContain("架空の製品を削除する");
    expect(await store.findKeywordByName("refit:kanpei-price")).toBeTruthy();
  });

  it("quality_thresholds に照合し、approve判定でも total不足なら gate_pending に降格", async () => {
    // 改修も新規生成と同様に設定値を効かせる (P-04の生verdict任せにしない)
    const low = JSON.parse(fx("P-04.json"));
    low.verdict = "approve";
    low.scores.total = 72; // approve(85)未満 hold(70)以上 → hold相当
    const { deps, targets } = await makeWorld({ "P-04": JSON.stringify(low) });

    const { article } = await refitArticle(targets[0]!, deps);

    expect(article.status).toBe("gate_pending");
  });
});

describe("refit: バッチ", () => {
  it("全件を処理し、再実行では処理済みをスキップする (冪等)", async () => {
    const { deps } = await makeWorld();

    const first = await refitBatch(deps);
    expect(first.processed.map((p) => p.slug).sort()).toEqual(["kanpei-price", "nankan-season"]);
    expect(first.processed.every((p) => p.status === "approval_pending")).toBe(true);

    const second = await refitBatch(deps);
    expect(second.processed).toEqual([]);
    expect(second.skipped.map((s) => s.reason)).toEqual(["already_refitted", "already_refitted"]);
  });

  it("limit指定で件数を制限できる", async () => {
    const { deps } = await makeWorld();
    const result = await refitBatch(deps, { limit: 1 });
    expect(result.processed).toHaveLength(1);
  });

  it("1本が失敗してもバッチは止まらず残りを処理し、再実行で失敗分だけ処理する (レジューム)", async () => {
    // 1本目のP-13aを壊れた応答にして失敗させる (通信断などの模擬)。
    // callAndParse はパース失敗を2回まで再試行するので、回数ではなく
    // 「どの記事の診断か」で分岐しないと再試行で成功してしまう
    let failFirst = true;
    const { deps } = await makeWorld({
      "P-13a": (req) =>
        failFirst && req.user.includes("甘平の値段はいくらか") ? "壊れた応答" : fx("P-13a.json"),
    });

    const r = await refitBatch(deps);
    expect(r.failed.map((f) => f.slug)).toEqual(["kanpei-price"]);
    expect(r.processed.map((p) => p.slug)).toEqual(["nankan-season"]);

    // 再実行 → 完了済みはスキップ、失敗した方だけ処理
    failFirst = false;
    const resume = await refitBatch(deps);
    expect(resume.processed.map((p) => p.slug)).toEqual(["kanpei-price"]);
    expect(resume.skipped.map((s) => s.reason)).toEqual(["already_refitted"]);
    expect(resume.failed).toEqual([]);
  });
});

describe("refit: 編集指示 (代表のファクトチェック反映)", () => {
  const dir: EditorialDirective = {
    corrections: [{ wrong: "糖度15度", correct: "糖度13度前後", source: "自社選果場の実測" }],
    citations: [{ fact: "露地の収穫は1月下旬から", source: "JAえひめ南 出荷実績" }],
    removals: [{ claim: "日本一甘い", action: "削除", reason: "根拠を示せない最上級表現" }],
  };

  it("buildDirectiveBlockが訂正・出典・削除を含むブロックを作る", () => {
    const b = buildDirectiveBlock(dir);
    expect(b).toContain("誤りの訂正");
    expect(b).toContain("糖度13度前後");
    expect(b).toContain("JAえひめ南 出荷実績");
    expect(b).toContain("削除・一般化");
    expect(buildDirectiveBlock(undefined)).toBe("");
    expect(buildDirectiveBlock({})).toBe("");
  });

  it("編集指示がP-13a診断とP-13b改稿の両方のプロンプトに渡る", async () => {
    const { llm, deps, targets } = await makeWorld();
    deps.directives = { "kanpei-price": dir };

    await refitArticle(targets[0]!, deps);

    const p13a = llm.calls.find((c) => c.promptId === "P-13a")!;
    const p13b = llm.calls.find((c) => c.promptId === "P-13b")!;
    expect(p13a.user).toContain("糖度13度前後");
    expect(p13b.user).toContain("糖度13度前後");
    expect(p13b.user).toContain("JAえひめ南 出荷実績");
  });

  it("編集指示が無い記事には空ブロック (従来どおり)", async () => {
    const { llm, deps, targets } = await makeWorld();
    deps.directives = { "kanpei-price": dir }; // nankan-seasonには指示なし

    await refitArticle(targets[1]!, deps);
    const p13b = llm.calls.find((c) => c.promptId === "P-13b")!;
    expect(p13b.user).not.toContain("編集指示");
  });
});

describe("refit: --redo (未公開の改修案の作り直し)", () => {
  it("未公開の改修案は破棄して作り直す", async () => {
    const { store, deps, targets } = await makeWorld();
    const first = await refitBatch(deps);
    const oldIds = new Set(
      (await store.listArticlesByStatus("approval_pending")).map((a) => a.id),
    );
    expect(first.processed).toHaveLength(2);

    const redone = await refitBatch(deps, { redo: true });

    expect(redone.processed.map((p) => p.slug).sort()).toEqual(["kanpei-price", "nankan-season"]);
    expect(redone.discarded).toHaveLength(2);
    // 旧案は retired になり、承認キューには新しい案だけが残る
    const queue = await store.listArticlesByStatus("approval_pending");
    expect(queue).toHaveLength(2);
    expect(queue.some((a) => oldIds.has(a.id))).toBe(false);
    const retired = await store.listArticlesByStatus("retired");
    expect(retired.map((a) => a.id).sort()).toEqual([...oldIds].sort());
    // 改修案はslugを持たないので、公開中の記事のURLは動かない
    expect(queue.every((a) => a.slug == null)).toBe(true);
    expect(
      (await store.listArticlesByStatus("published")).map((a) => a.slug).sort(),
    ).toEqual(["kanpei-price", "nankan-season"]);
    // 対象の指し先は保たれている
    expect(queue.map((a) => a.revision_of).sort()).toEqual(
      targets.map((t) => t.articleId).sort(),
    );
  });

  it("承認済みの改修案は破棄しない (代表の判断を勝手に捨てないため)", async () => {
    const { store, deps, targets } = await makeWorld();
    await refitBatch(deps);
    const target = (await store.listArticlesByStatus("approval_pending")).find(
      (a) => a.revision_of === targets[0]!.articleId,
    )!;
    await store.updateArticle(target.id, { status: "approved" });

    const redone = await refitBatch(deps, { redo: true });

    expect(redone.skipped).toEqual([{ slug: "kanpei-price", reason: "redo_blocked_approved" }]);
    expect(redone.processed.map((p) => p.slug)).toEqual(["nankan-season"]);
    expect((await store.getArticle(target.id))!.status).toBe("approved");
  });

  it("公開済みの改修案は破棄しない", async () => {
    const { store, deps, targets } = await makeWorld();
    await refitBatch(deps);
    const target = (await store.listArticlesByStatus("approval_pending")).find(
      (a) => a.revision_of === targets[1]!.articleId,
    )!;
    await store.updateArticle(target.id, { status: "published" });

    const redone = await refitBatch(deps, { redo: true });

    expect(redone.skipped).toEqual([{ slug: "nankan-season", reason: "redo_blocked_published" }]);
    expect((await store.getArticle(target.id))!.status).toBe("published");
  });
});

describe("refitBatch: slug指定", () => {
  it("--slug で指定した記事だけを対象にする", async () => {
    const { deps } = await makeWorld();
    const res = await refitBatch(deps, { slugs: ["nankan-season"] });
    expect(res.processed.map((p) => p.slug)).toEqual(["nankan-season"]);
  });

  it("公開済み記事に無いslugはskipとして報告する", async () => {
    const { deps } = await makeWorld();
    const res = await refitBatch(deps, { slugs: ["does-not-exist"] });
    expect(res.processed).toHaveLength(0);
    expect(res.skipped).toContainEqual({
      slug: "does-not-exist",
      reason: "slug_not_found_in_published_articles",
    });
  });
});

describe("isBetterVerdict: 2周の改稿からどちらを採るか", () => {
  const v = (verdict: "approve" | "hold" | "reject", total: number) =>
    ({ verdict, scores: { total } }) as unknown as P04VerdictT;

  it("判定が上なら合計点が低くても採る (approveは無フラグも条件のため)", () => {
    expect(isBetterVerdict(v("approve", 80), v("hold", 84))).toBe(true);
    expect(isBetterVerdict(v("hold", 71), v("reject", 69))).toBe(true);
  });

  it("同じ判定なら合計点が高い方を採る", () => {
    expect(isBetterVerdict(v("hold", 78), v("hold", 72))).toBe(true);
    expect(isBetterVerdict(v("hold", 72), v("hold", 78))).toBe(false);
  });

  it("同点なら入れ替えない (1周目を残す)", () => {
    expect(isBetterVerdict(v("hold", 75), v("hold", 75))).toBe(false);
  });
});
