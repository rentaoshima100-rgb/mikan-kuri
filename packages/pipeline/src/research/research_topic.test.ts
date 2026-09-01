import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { FixtureLLMClient } from "@kurimikan/shared";
import { MemoryStore } from "../db/memory.js";
import { researchTopicToAsset, type ResearchClient } from "./research_topic.js";

const FIXTURES = join(__dirname, "..", "..", "..", "shared", "fixtures", "llm");
const SUITE = join(__dirname, "..", "..", "..", "..", "kurimikan_prompt_suite_v1.md");

const structured = JSON.stringify({
  title: "中小企業のHP開設率 (総務省)",
  description: "総務省 通信利用動向調査によるHP開設率の公的データ",
  content: "総務省の通信利用動向調査 (令和6年) によると、企業のホームページ開設率は93.2%でした。",
  numeric_claims: [
    {
      claim: "企業のHP開設率",
      value: "93.2",
      unit: "%",
      basis: "総務省 通信利用動向調査 令和6年 (https://www.soumu.go.jp/...)",
      verified: true,
    },
  ],
});

function makeDeps(research: ResearchClient) {
  const store = new MemoryStore();
  const llm = new FixtureLLMClient({ fixturesDir: FIXTURES, responses: { "P-RESEARCH": structured } });
  return { store, deps: { store, llm, research, suitePath: SUITE } };
}

describe("research_topic: 出典付きファクトの自動リサーチ → 資産化", () => {
  it("出典ありなら資産を投入し、クラスタで引ける", async () => {
    const research: ResearchClient = {
      async research() {
        return {
          text: "総務省 通信利用動向調査 令和6年: 企業のHP開設率93.2%",
          sources: [{ url: "https://www.soumu.go.jp/x", title: "通信利用動向調査 令和6年" }],
        };
      },
    };
    const { store, deps } = makeDeps(research);
    const r = await researchTopicToAsset(deps, { topic: "中小企業 HP 開設率", cluster: "renewal" });

    expect(r.asset).toBeTruthy();
    expect(r.asset!.asset_type).toBe("public_data_analysis");
    expect(r.asset!.applicable_clusters).toContain("renewal");
    // 記事生成時にクラスタで注入される状態になっている
    const injectable = await store.listActiveAssetsByCluster("renewal", 3);
    expect(injectable.map((a) => a.id)).toContain(r.asset!.id);
    // numeric_claims に出典 (basis) が入っている
    expect(JSON.stringify(r.asset!.numeric_claims)).toContain("総務省");
  });

  it("出典が1つも取れなければ資産を作らない (裏の取れない資産を作らない)", async () => {
    const research: ResearchClient = {
      async research() {
        return { text: "確かな出典が見つかりませんでした", sources: [] };
      },
    };
    const { store, deps } = makeDeps(research);
    const r = await researchTopicToAsset(deps, { topic: "x", cluster: "renewal" });

    expect(r.asset).toBeNull();
    expect(await store.listActiveAssetsByCluster("renewal", 3)).toHaveLength(0);
  });
});
