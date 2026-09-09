// routine-daily (サブスク実行、代表指示 2026-09-08): 日次の自律ループのLLM系ステップ。
// Claude Codeの定期クラウドルーチン (claude.ai/code/routines) の中で実行される。
// LLM呼び出しはAPIキーではなく、同じセッションのエージェントが応答するブリッジ
// (LLM_BACKEND=bridge、docs/ROUTINES.md) を使う。エージェントはこのプロセスを
// バックグラウンドで走らせ、.llm-bridge/ の要求に bridge_reply.ts で答え続ける。
//
// 分担 (cron_daily.ts から分離):
//   GitHub Actions (cron-daily): 計測 (gsc_sync/rank_watch) と安全装置 (tripwire/deadman)。
//     LLM不要なので従来どおりActionsに残す。ルーチンが止まっても安全装置は独立に動く
//   このルーチン: 発案 → [自動キュー] → リサーチ → 生成 → [自動承認] → ゲート引き継ぎ → SEO監視
//
// 生成物の扱いはv3のまま: 既定 (full_auto_publish=false) では記事は承認キューで止まり、
// このジョブが公開することはない。品質ゲート・重複ゲート・表記チェックも従来どおり通る。
import { join } from "node:path";
import {
  autoApproveAllPending,
  continueApprovedGates,
  generateFromQueue,
  llmBudgetUsd,
  makeLLMClient,
  makeResearchClient,
  proposeKeywords,
  researchTopicToAsset,
  runSeoWatcher,
  makeShopifyClient,
  shopifyEnv,
  shopifyTopicsProvider,
  type Store,
} from "@kurimikan/pipeline";
import { runJob } from "./shared.js";

// ルーチン内では既定でブリッジ (サブスク実行)。APIキー経路で動かしたい場合だけ明示的に上書きする
process.env.LLM_BACKEND ??= "bridge";

const SUITE_PATH = join(import.meta.dirname, "..", "..", "kurimikan_prompt_suite_v1.md");
const BUDGET_USD = llmBudgetUsd();

// 1日あたりの上限。サブスク実行では課金は無いが、代表がレビューできる量と
// ルーチンの実行時間の両方を抑えるために従来の上限を維持する
const PROPOSE_PER_DAY = Number(process.env.DAILY_PROPOSE_COUNT ?? 4);
const GENERATE_PER_DAY = Number(process.env.DAILY_GENERATE_LIMIT ?? 2);
const RESEARCH_PER_DAY = Number(process.env.DAILY_RESEARCH_LIMIT ?? 2);

await runJob("routine-daily", async (store: Store) => {
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

  // 全自動時のみ: 発案されたトピック (proposed) を自動でqueuedに上げる (cron_daily.tsと同じ)
  const autoQueueTopics = async () => {
    if (!fullAuto) return { skipped: "full_auto_publish=false" };
    const proposed = await store.listKeywordsByStatus("proposed");
    for (const kw of proposed) await store.updateKeywordStatus(kw.id, "queued");
    return { queued: proposed.length };
  };

  // 全自動時のみ: 承認待ちの全記事を自動承認+即時公開の予定にする (実公開はcron-hourly)
  const autoApprove = async () => {
    if (!fullAuto) return { skipped: "full_auto_publish=false" };
    return { approved: await autoApproveAllPending({ store }) };
  };

  // 承認済み (queued) キーワードの一次情報リサーチ (cron_daily.tsと同じ)。
  // リサーチ自体もエージェントのWebSearchで行う (BridgeResearchClient)
  const researchQueued = async () => {
    const queued = await store.listKeywordsByStatus("queued");
    const research = makeResearchClient();
    const done: { topic: string; cluster: string; asset: string | null }[] = [];
    for (const kw of queued.slice(0, RESEARCH_PER_DAY)) {
      const { asset } = await researchTopicToAsset(
        { store, llm, research, suitePath: SUITE_PATH },
        { topic: kw.keyword, cluster: kw.cluster },
      );
      done.push({ topic: kw.keyword, cluster: kw.cluster, asset: asset?.id ?? null });
    }
    return done;
  };

  for (const [name, fn] of [
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
    ["auto_queue_topics", autoQueueTopics],
    ["research", researchQueued],
    // queued トピックを記事化。既定は approval_pending で承認キューへ
    ["generate", () => generateFromQueue(orchestratorDeps, { limit: GENERATE_PER_DAY })],
    ["auto_approve", autoApprove],
    // 管理画面でゲート承認された gate_pending 記事の残りステップ (合議→仕上げ) を再開する。
    // APIキーなし構成の管理画面はマーカを置くだけなので、ここが実処理の担い手になる
    ["gate_continue", () => continueApprovedGates(orchestratorDeps)],
    ["seo_watcher", () => runSeoWatcher({ store, llm, suitePath: SUITE_PATH })],
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
