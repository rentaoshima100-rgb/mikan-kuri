// コードが読む pipeline_config のキーが、すべて seed に含まれているかを検証する。
//
// 未seedのキーは getConfig が null を返し、コード側の既定値へ黙ってフォールバックする。
// 「管理画面やSQLで設定を変えたのに効かない」「設定表に載っていない挙動がある」という
// 種類の事故につながるため、CIで固定する。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PIPELINE_CONFIG_SEED } from "../scripts/seed/config_values.js";

const SRC_DIRS = [
  join(__dirname, "..", "packages", "pipeline", "src"),
  join(__dirname, "..", "packages", "admin", "app"),
];

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts")) acc.push(full);
  }
  return acc;
}

// getConfig<...>("key") / getConfig("key") の呼び出しから "key" を拾う。
// ジェネリクスは入れ子になりうる (getConfig<Record<string, string>>) が、
// 括弧は含まないため [^()]* で吸収できる。
// 引数が文字列リテラルでないもの (Store実装側の getConfig(key: string) 定義) は一致しない。
function collectConfigKeys(): Set<string> {
  const keys = new Set<string>();
  for (const dir of SRC_DIRS) {
    for (const file of collectFiles(dir)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/getConfig(?:<[^()]*>)?\(\s*"([a-z_][a-z0-9_]*)"/g)) {
        keys.add(m[1]!);
      }
    }
  }
  return keys;
}

describe("config parity: getConfigで読むキーはseedに存在する", () => {
  const used = collectConfigKeys();

  it("キー抽出が空振りしていない (パーサ自体の健全性)", () => {
    expect(used.size).toBeGreaterThan(5);
    expect(used.has("weekly_publish_target")).toBe(true);
    expect(used.has("approval_deadman_hours")).toBe(true);
    expect(used.has("collections")).toBe(true); // 入れ子ジェネリクスの取りこぼし検知
  });

  it("読まれるキーがすべてseedされている", () => {
    const seeded = new Set(Object.keys(PIPELINE_CONFIG_SEED));
    const missing = [...used].filter((k) => !seeded.has(k)).sort();
    expect(missing, `seedに無いconfigキー: ${missing.join(", ")}`).toEqual([]);
  });

  it("v3の凍結フラグがseedされ、既定で安全側になっている", () => {
    const cfg = PIPELINE_CONFIG_SEED as Record<string, unknown>;
    expect(cfg.ai_llmo_expansion_frozen).toBe(true);
    expect(cfg.proposal_log_articles_enabled).toBe(false);
    expect(cfg.self_healing_enabled).toBe(false);
    expect((cfg.serp_check as { enabled: boolean }).enabled).toBe(false);
  });
});
