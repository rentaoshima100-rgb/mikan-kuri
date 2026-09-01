import { afterEach, describe, expect, it, vi } from "vitest";
import { FixtureLLMClient } from "@kurimikan/shared";
import { MemoryStore } from "./db/memory.js";
import { makeLLMClient } from "./llm_factory.js";

afterEach(() => vi.unstubAllEnvs());

describe("llm_factory", () => {
  it("dry_runではFixtureLLMClientを返す (実APIクライアントを構築しない)", async () => {
    vi.stubEnv("PIPELINE_ENV", "dry_run");
    const client = await makeLLMClient(new MemoryStore());
    expect(client).toBeInstanceOf(FixtureLLMClient);
  });
});
