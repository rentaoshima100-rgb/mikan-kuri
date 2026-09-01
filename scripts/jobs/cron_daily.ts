// cron-daily (JST 6:00): 計測 → 自律ループ (発案→リサーチ→生成) → 安全装置。
// 各ステップは独立に失敗しうるため、1つ落ちても後続は実行する (計測欠損で安全装置を止めない)。
// 2026-08-14 代表指示のうえ、順位監視 (rank_watch) を計測ステップに追加。
//
// 既定 (full_auto_publish=false / v3): このジョブは記事を公開しない。生成物はすべて
// 承認キュー (approval_pending) で止まり、公開の引き金は代表の承認ボタンだけ。
// キーワードも proposed で止まり、記事化されるのは代表が承認した (queued) ものだけ。
//
// 全自動 (full_auto_publish=true / 代表判断でv3を上書き。CLAUDE.md v3訂正表):
// 発案トピックを自動で queued にし (同日にリサーチ・生成が拾える)、生成記事を品質ゲート
// 結果に関わらず自動承認+即時公開の予定にする。実際の公開は cron-hourly の公開ワーカが行う。
// フラグを false に戻せばv3の元挙動に完全復帰する (安全弁)。
//
// 実行順の理由:
//   計測(gsc) → 発案(P-15) → [自動キュー] → リサーチ → 生成 → [自動承認] → 監視(SEO) → 安全装置
//   発案は当日のGSC実績を踏まえたいので計測の後。自動キューは発案直後 (同日リサーチのため)。
//   自動承認は生成の後。安全装置は生成の結果も見たいので最後。
import { join } from "node:path";
import {
  AnthropicResearchClient,
  autoApproveAllPending,
  deadmanSweep,
  generateFromQueue,
  makeLLMClient,
  proposeKeywords,
  researchTopicToAsset,
  runGscSync,
  runRankWatch,
  runSeoWatcher,
  runTripwireSweep,
  makeShopifyClient,
  shopifyEnv,
  shopifyTopicsProvider,
  type Store,
} from "@kurimikan/pipeline";
import { runJob } from "./shared.js";

const SUITE_PATH = join(import.meta.dirname, "..", "..", "kurimikan_prompt_suite_v1.md");
const BUDGET_USD = Number(process.env.MONTHLY_TOKEN_BUDGET_USD ?? 60);

// 1日あたりの上限。予算と、代表がレビューできる量の両方に効く。
// 承認キューに積みすぎると代表が読み切れず、デッドマンで保留に戻るだけになる。
const PROPOSE_PER_DAY = Number(process.env.DAILY_PROPOSE_COUNT ?? 4);
const GENERATE_PER_DAY = Number(process.env.DAILY_GENERATE_LIMIT ?? 2);
const RESEARCH_PER_DAY = Number(process.env.DAILY_RESEARCH_LIMIT ?? 2);

await runJob("cron-daily", async (store: Store) => {
  const results: Record<string, unknown> = {};
  const llm = await makeLLMClient(store);

  // 重複判定の相手に、DBが追跡していない記事 (店舗が /blogs/news に手で投稿した
  // お知らせなど) を加える。トークン未設定なら相手はDBの記事だけになる
  const extraTopics = shopifyEnv() ? shopifyTopicsProvider(makeShopifyClient()) : undefined;

  const orchestratorDeps = {
    store,
    llm,
    suitePath: SUITE_PATH,
    budgetUsd: BUDGET_USD,
    extraTopics,
  };

  // 全自動公開フラグ (代表判断でv3の全記事承認制を上書き)。offならv3の元挙動。
  const fullAuto = (await store.getConfig<boolean>("full_auto_publish")) ?? false;

  // 全自動時のみ: 発案されたトピック (proposed) を自動でqueuedに上げる。
  // 発案の直後に走らせることで、同じ実行内のリサーチ・生成が拾える。
  // offのときは何もしない (代表が /keywords で承認するまでproposedのまま)。
  const autoQueueTopics = async () => {
    if (!fullAuto) return { skipped: "full_auto_publish=false" };
    const proposed = await store.listKeywordsByStatus("proposed");
    for (const kw of proposed) await store.updateKeywordStatus(kw.id, "queued");
    return { queued: proposed.length };
  };

  // 全自動時のみ: 承認待ちの全記事を自動承認+即時公開の予定にする。
  // offのときは何もしない (代表の承認ボタンが唯一の公開トリガ)。
  const autoApprove = async () => {
    if (!fullAuto) return { skipped: "full_auto_publish=false" };
    return { approved: await autoApproveAllPending({ store }) };
  };

  // 承認済み (queued) キーワードのうち、そのクラスタに一次情報が乏しいものを
  // リサーチ対象にする。記事を書く前に材料を揃えるのが狙い。
  const researchQueued = async () => {
    const queued = await store.listKeywordsByStatus("queued");
    const done: { topic: string; cluster: string; asset: string | null }[] = [];
    for (const kw of queued.slice(0, RESEARCH_PER_DAY)) {
      const { asset } = await researchTopicToAsset(
        { store, llm, research: new AnthropicResearchClient(), suitePath: SUITE_PATH },
        { topic: kw.keyword, cluster: kw.cluster },
      );
      done.push({ topic: kw.keyword, cluster: kw.cluster, asset: asset?.id ?? null });
    }
    return done;
  };

  for (const [name, fn] of [
    ["gsc_sync", () => runGscSync({ store })],
    // 順位監視 (DataForSEO内製、代表指示 2026-08-14)。creds未設定なら自動スキップ
    ["rank_watch", () => runRankWatch({ store })],
    // 発案。既定では proposed で止まる (代表が承認するまで記事化されない)
    [
      "propose_keywords",
      async () =>
        proposeKeywords(
          {
            store,
            llm,
            suitePath: SUITE_PATH,
            extraExistingTopics: extraTopics ? await extraTopics() : undefined,
          },
          { count: PROPOSE_PER_DAY },
        ),
    ],
    // 全自動時のみ: proposed → queued (同日にリサーチ・生成が拾えるよう発案直後)
    ["auto_queue_topics", autoQueueTopics],
    // 承認済み (queued) トピックの一次情報を集める (出典が取れなければ資産を作らない)
    ["research", researchQueued],
    // queued トピックを記事化。既定は approval_pending で承認キューへ、
    // 全自動時は品質ゲート結果に関わらず承認キューへ (次のauto_approveで公開予定に乗る)
    ["generate", () => generateFromQueue(orchestratorDeps, { limit: GENERATE_PER_DAY })],
    // 全自動時のみ: 承認待ちを自動承認+即時公開の予定に (実公開はcron-hourly)
    ["auto_approve", autoApprove],
    ["seo_watcher", () => runSeoWatcher({ store, llm, suitePath: SUITE_PATH })],
    ["tripwire", () => runTripwireSweep({ store })],
    ["deadman", () => deadmanSweep({ store })],
  ] as const) {
    try {
      results[name] = await fn();
    } catch (e) {
      results[name] = { error: e instanceof Error ? e.message : String(e) };
      process.exitCode = 1;
    }
  }
  return results;
});
