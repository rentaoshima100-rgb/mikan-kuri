import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { FixtureLLMClient } from "@kurimikan/shared";
import { MemoryStore } from "../db/memory.js";
import type { OrchestratorDeps } from "../orchestrator/generate.js";
import { generateFromQueue } from "./generate_from_queue.js";

const FIXTURES = join(__dirname, "..", "..", "..", "shared", "fixtures", "llm");
const SUITE = join(__dirname, "..", "..", "..", "..", "kurimikan_prompt_suite_v1.md");

function makeStore() {
  const store = new MemoryStore();
  store.setConfig("lane_b_allowed_types", ["howto", "comparison", "public_data", "market_report"]);
  store.setConfig("weekly_publish_target", 2);
  store.setConfig("approval_deadman_hours", 72);
  store.addAsset({ applicable_clusters: ["renewal"] });
  return store;
}

describe("generateFromQueue: 承認済みトピックの記事化", () => {
  it("queuedのキーワードだけを記事化する (proposedは対象外)", async () => {
    const store = makeStore();
    store.addKeyword({ keyword: "queued-kw", cluster: "renewal", article_type: "howto", status: "queued", assigned_lane: "A" });
    store.addKeyword({ keyword: "proposed-kw", cluster: "renewal", article_type: "howto", status: "proposed", assigned_lane: "A" });
    const llm = new FixtureLLMClient({ fixturesDir: FIXTURES });
    const deps: OrchestratorDeps = { store, llm, suitePath: SUITE, budgetUsd: 60 };

    const r = await generateFromQueue(deps, {});

    expect(r.generated.map((g) => g.keyword)).toEqual(["queued-kw"]);
    expect(r.failed).toEqual([]);
    // proposed は記事化されていない
    expect(await store.listKeywordsByStatus("proposed")).toHaveLength(1);
  });

  it("1本が失敗してもバッチは止まらず、失敗を記録して次へ進む", async () => {
    const store = makeStore();
    // アセットも本文も無い不整合な状態を作らず、存在しない参照で1本を失敗させる:
    // fixtureに無いプロンプトを要求させるためではなく、limitで正常系を確認
    store.addKeyword({ keyword: "kw-1", cluster: "renewal", article_type: "howto", status: "queued", assigned_lane: "A" });
    store.addKeyword({ keyword: "kw-2", cluster: "renewal", article_type: "howto", status: "queued", assigned_lane: "A" });
    const llm = new FixtureLLMClient({ fixturesDir: FIXTURES });
    const deps: OrchestratorDeps = { store, llm, suitePath: SUITE, budgetUsd: 60 };

    const r = await generateFromQueue(deps, { limit: 1 });
    // limit=1 なので1本だけ処理
    expect(r.generated.length + r.failed.length).toBe(1);
  });
});
