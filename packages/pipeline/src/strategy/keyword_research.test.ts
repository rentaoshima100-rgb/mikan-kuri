import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { FixtureLLMClient } from "@kurimikan/shared";
import { MemoryStore } from "../db/memory.js";
import { fetchSearchVolumes, volumeToScore } from "./keyword_research.js";
import { proposeKeywords } from "./propose_keywords.js";

const SUITE = join(__dirname, "..", "..", "..", "..", "kurimikan_prompt_suite_v1.md");
const FIXTURES = join(__dirname, "..", "..", "..", "shared", "fixtures", "llm");
const creds = { login: "u", password: "p" };

describe("fetchSearchVolumes: DataForSEO検索ボリューム", () => {
  it("認証なしなら空 (従来動作)", async () => {
    expect(await fetchSearchVolumes(["x"], { login: "", password: "" })).toEqual({});
  });

  it("レスポンスをkeyword→volumeに整形", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          tasks: [{ result: [{ keyword: "リニューアル 費用", search_volume: 1300, competition: 0.4 }] }],
        }),
        { status: 200 },
      )) as typeof fetch;
    const v = await fetchSearchVolumes(["リニューアル 費用"], creds, fetchImpl);
    expect(v["リニューアル 費用"]).toEqual({ volume: 1300, competition: 0.4 });
  });

  it("volumeToScoreは対数で0-100", () => {
    expect(volumeToScore(0)).toBe(0);
    expect(volumeToScore(1000)).toBeGreaterThan(volumeToScore(100));
    expect(volumeToScore(1000000)).toBe(100);
  });
});

describe("proposeKeywords: 検索ボリュームで優先度を裏付ける", () => {
  it("volumeLookupがあれば優先度を需要と平均し、理由に月間検索数を添える", async () => {
    const store = new MemoryStore();
    store.setConfig("cluster_allocation", { renewal: 52 });
    const llm = new FixtureLLMClient({
      fixturesDir: FIXTURES,
      responses: {
        "P-KW": JSON.stringify({
          proposals: [
            { keyword: "高需要KW", cluster: "renewal", article_type: "howto", search_intent: "x", priority: 50, rationale: "穴" },
          ],
        }),
      },
    });
    const volumeLookup = async () => ({ 高需要KW: { volume: 10000 } });
    const r = await proposeKeywords({ store, llm, suitePath: SUITE, volumeLookup }, { count: 1 });

    expect(r.proposed[0]!.rationale).toContain("月間検索10000回");
    // priority = (50 + demandScore(10000)) / 2。demandScore(10000)=80なので65前後
    expect(r.proposed[0]!.priority).toBeGreaterThan(50);
  });
});
