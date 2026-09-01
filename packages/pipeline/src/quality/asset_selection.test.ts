import { describe, expect, it } from "vitest";
import type { LLMClient } from "@kurimikan/shared";
import { MemoryStore } from "../db/memory.js";
import { selectRelevantAssets } from "./asset_selection.js";

function makeStore(n: number) {
  const store = new MemoryStore();
  for (let i = 0; i < n; i++) {
    store.addAsset({
      title: `資産${i}`,
      description: `説明${i}`,
      applicable_clusters: ["ai_llmo"],
    });
  }
  return store;
}

const llmReturning = (text: string): LLMClient =>
  ({
    call: async () => ({ text, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 }),
  }) as unknown as LLMClient;

const llmThrowing = (): LLMClient =>
  ({
    call: async () => {
      throw new Error("LLM落ちた");
    },
  }) as unknown as LLMClient;

const base = { cluster: "ai_llmo", topic: "LLMO対策の基本", limit: 3 };

describe("selectRelevantAssets", () => {
  it("候補が枠に収まるならLLMを呼ばずそのまま返す", async () => {
    let called = false;
    const llm = {
      call: async () => {
        called = true;
        return { text: "[]", usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
      },
    } as unknown as LLMClient;
    const res = await selectRelevantAssets({ store: makeStore(2), llm, ...base });
    expect(res).toHaveLength(2);
    expect(called).toBe(false);
  });

  it("LLMが選んだ番号の資産だけを、関連が強い順に返す", async () => {
    const res = await selectRelevantAssets({
      store: makeStore(10),
      llm: llmReturning("[4,1]"),
      ...base,
    });
    expect(res.map((a) => a.title)).toEqual(["資産4", "資産1"]);
  });

  it("limitを超える件数を返されても切り詰める", async () => {
    const res = await selectRelevantAssets({
      store: makeStore(10),
      llm: llmReturning("[0,1,2,3,4,5]"),
      ...base,
    });
    expect(res).toHaveLength(3);
  });

  it("範囲外・重複の番号は捨てる", async () => {
    const res = await selectRelevantAssets({
      store: makeStore(5),
      llm: llmReturning("[1,1,99,-2]"),
      ...base,
    });
    expect(res.map((a) => a.title)).toEqual(["資産1"]);
  });

  it("関連なし([])は尊重し、無関係な資産で枠を埋めない", async () => {
    const res = await selectRelevantAssets({
      store: makeStore(10),
      llm: llmReturning("[]"),
      ...base,
    });
    expect(res).toEqual([]);
  });

  it("LLMが落ちたら従来の順序にフォールバックする (記事生成を止めない)", async () => {
    const res = await selectRelevantAssets({
      store: makeStore(10),
      llm: llmThrowing(),
      ...base,
    });
    expect(res).toHaveLength(3);
  });

  it("JSONとして壊れた応答は選択なしとして扱う", async () => {
    const res = await selectRelevantAssets({
      store: makeStore(10),
      llm: llmReturning("よくわかりません"),
      ...base,
    });
    expect(res).toEqual([]);
  });
});
