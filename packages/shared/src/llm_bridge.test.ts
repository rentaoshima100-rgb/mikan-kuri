import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeLLMClient, BridgeTimeoutError, FileBridge } from "./llm_bridge.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-bridge-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

// エージェント役: 要求ファイルを読み、応答ファイルを書く (書き込みはtmp→renameでなくてよい。
// クライアント側がパース失敗を「書きかけ」として次のポーリングまで待つため)
function replyWhenAsked(response: unknown): void {
  const timer = setInterval(() => {
    try {
      const req = JSON.parse(readFileSync(join(dir, "req-0001.json"), "utf8"));
      const name = `res-${String(req.seq).padStart(4, "0")}.json`;
      writeFileSync(join(dir, name), JSON.stringify(response), "utf8");
      clearInterval(timer);
    } catch {
      // まだ要求が無い
    }
  }, 20);
}

describe("llm_bridge: dry_run保証", () => {
  it("dry_runではBridgeLLMClientを構築できない", () => {
    vi.stubEnv("PIPELINE_ENV", "dry_run");
    expect(() => new BridgeLLMClient()).toThrow(/dry_run/);
  });
});

describe("llm_bridge: ファイル交換", () => {
  it("要求を書き、エージェントの応答textを返す", async () => {
    vi.stubEnv("PIPELINE_ENV", "production");
    const recorded: unknown[] = [];
    const client = new BridgeLLMClient({
      bridge: new FileBridge({ dir, pollMs: 20, timeoutMs: 3000 }),
      recordUsage: async (row) => {
        recorded.push(row);
      },
    });
    replyWhenAsked({ text: "エージェントの応答" });
    const res = await client.call({ promptId: "P-04", system: "S", user: "U", job: "gate" });
    expect(res.text).toBe("エージェントの応答");
    expect(res.model).toBe("claude-code-subscription");
    // 要求ファイルにはプロンプトが素通しで入る (エージェントがそのまま読む)
    expect(recorded).toHaveLength(1);
    expect((recorded[0] as { cost_usd: number }).cost_usd).toBe(0);
    expect(client.calls).toHaveLength(1);
  });

  it("応答がerrorのときは例外にする", async () => {
    vi.stubEnv("PIPELINE_ENV", "production");
    const client = new BridgeLLMClient({
      bridge: new FileBridge({ dir, pollMs: 20, timeoutMs: 3000 }),
    });
    replyWhenAsked({ error: "答えられません" });
    await expect(client.call({ promptId: "P-04", user: "U" })).rejects.toThrow(/答えられません/);
  });

  it("応答が無ければタイムアウトで失敗する (フェイルクローズド)", async () => {
    vi.stubEnv("PIPELINE_ENV", "production");
    const client = new BridgeLLMClient({
      bridge: new FileBridge({ dir, pollMs: 20, timeoutMs: 200 }),
    });
    await expect(client.call({ promptId: "P-04", user: "U" })).rejects.toThrow(BridgeTimeoutError);
  });

  it("開始時に前回の残骸 (req/res) を掃除する", () => {
    vi.stubEnv("PIPELINE_ENV", "production");
    writeFileSync(join(dir, "req-0001.json"), "{}", "utf8");
    writeFileSync(join(dir, "res-0001.json"), "{}", "utf8");
    new FileBridge({ dir });
    expect(() => readFileSync(join(dir, "req-0001.json"))).toThrow();
    expect(() => readFileSync(join(dir, "res-0001.json"))).toThrow();
  });
});
