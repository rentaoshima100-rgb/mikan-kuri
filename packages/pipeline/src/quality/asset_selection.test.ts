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

describe("selectRelevantAssets: 一次情報の有効期限", () => {
  // 柑橘は年ごとに出来が変わる。去年の糖度を今年の記事に使うと事実と違う記述になる。
  // 人が本文を読んでいれば気づくが、全自動公開では気づけないのでここで機械的に落とす
  const asOf = new Date("2026-09-08T00:00:00Z");

  function storeWithExpiry() {
    const store = new MemoryStore();
    store.addAsset({ title: "期限なし (畑の場所)", applicable_clusters: ["kanpei"] });
    store.addAsset({
      title: "今季の糖度",
      applicable_clusters: ["kanpei"],
      valid_until: "2026-12-31",
    });
    store.addAsset({
      title: "昨季の糖度",
      applicable_clusters: ["kanpei"],
      valid_until: "2026-03-31",
    });
    return store;
  }

  it("期限を過ぎた資産は候補に入らない", async () => {
    const res = await selectRelevantAssets({
      store: storeWithExpiry(),
      llm: llmThrowing(),
      cluster: "kanpei",
      topic: "甘平の糖度",
      limit: 3,
      asOf,
    });
    expect(res.map((a) => a.title)).toEqual(["期限なし (畑の場所)", "今季の糖度"]);
  });

  it("期限当日はまだ有効 (境界)", async () => {
    const store = new MemoryStore();
    store.addAsset({
      title: "今日まで",
      applicable_clusters: ["kanpei"],
      valid_until: "2026-09-08",
    });
    const res = await selectRelevantAssets({
      store,
      llm: llmThrowing(),
      cluster: "kanpei",
      topic: "甘平",
      limit: 3,
      asOf,
    });
    expect(res.map((a) => a.title)).toEqual(["今日まで"]);
  });

  it("asOf を渡さなければ現在時刻で判定する", async () => {
    const store = new MemoryStore();
    store.addAsset({
      title: "遠い未来まで有効",
      applicable_clusters: ["kanpei"],
      valid_until: "2999-12-31",
    });
    store.addAsset({ title: "とうに期限切れ", applicable_clusters: ["kanpei"], valid_until: "2020-01-01" });
    const res = await selectRelevantAssets({
      store,
      llm: llmThrowing(),
      cluster: "kanpei",
      topic: "甘平",
      limit: 3,
    });
    expect(res.map((a) => a.title)).toEqual(["遠い未来まで有効"]);
  });
});
