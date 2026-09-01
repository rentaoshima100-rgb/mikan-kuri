// 保護ファイルの指定が「実在するコード」を指しているか、および
// CODEOWNERS と CI の検知パターンが同じ集合を守っているかを検証する。
//
// 背景: 当初のCODEOWNERSは packages/pipeline/src/guard/ を保護していたが、
// トリップワイヤは実際には tripwire/ に実装されたため、名指しした安全装置が
// 無防備なまま「保護しているつもり」になっていた。この種のドリフトをCIで止める。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const codeowners = readFileSync(join(ROOT, "CODEOWNERS"), "utf8");
const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

function codeownersPaths(): string[] {
  return codeowners
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("/"))
    .map((l) => l.split(/\s+/)[0]!.replace(/^\//, ""));
}

// 安全装置として名指しし、かつ現時点で実装済みのもの。
// 実装した瞬間から保護対象になっていなければならない。
const MUST_PROTECT_EXISTING = [
  ".github/workflows/ci.yml",
  ".github/workflows/cron-hourly.yml",
  ".github/workflows/cron-daily.yml",
  ".github/workflows/cron-monthly.yml",
  "scripts/jobs/",
  "packages/pipeline/src/tripwire/",
  "packages/pipeline/src/approvals/",
  "packages/pipeline/src/publish/",
  // 法令ゲート。緩めると販売者に行政指導が来るため、品質ゲートより上位の保護対象
  "packages/pipeline/src/quality/compliance_gate.ts",
  "CODEOWNERS",
  "kurimikan_pipeline_spec.md",
];

// 先行して保護指定だけ置いてあるもの (現時点では存在しない)
const FORWARD_LOOKING: string[] = [];

describe("保護パス: CODEOWNERS", () => {
  const listed = codeownersPaths();

  it("実装済みの安全装置がすべてCODEOWNERSに載っている", () => {
    const missing = MUST_PROTECT_EXISTING.filter(
      (p) => !listed.some((l) => l === p || (l.endsWith("/") && p.startsWith(l))),
    );
    expect(missing, `CODEOWNERSに無い保護対象: ${missing.join(", ")}`).toEqual([]);
  });

  it("保護対象として挙げたパスが実在する (先行保護分を除く)", () => {
    const dangling = listed
      .filter((p) => !FORWARD_LOOKING.includes(p))
      .filter((p) => !existsSync(join(ROOT, p)));
    expect(dangling, `存在しないパスを保護している: ${dangling.join(", ")}`).toEqual([]);
  });

  it("全エントリに所有者が指定されている", () => {
    const noOwner = codeowners
      .split("\n")
      .filter((l) => l.trim().startsWith("/"))
      .filter((l) => !l.includes("@"));
    expect(noOwner).toEqual([]);
  });
});

describe("保護パス: CIの検知パターン", () => {
  it("CODEOWNERSの保護対象がCIの正規表現でも検知される", () => {
    const m = /PROTECTED='\^\((.*?)\)'/.exec(ci);
    expect(m, "ci.yml から PROTECTED パターンを読み取れません").not.toBeNull();
    const alternatives = m![1]!.split("|").map((a) => a.replace(/\\/g, ""));

    for (const path of MUST_PROTECT_EXISTING) {
      const covered = alternatives.some((a) => path === a || path.startsWith(a));
      expect(covered, `CIの検知パターンに含まれていない: ${path}`).toBe(true);
    }
  });

  it("保護ファイル検知はPRのbase SHAを使う (origin/<base>は解決できないことがある)", () => {
    expect(ci).toContain("github.event.pull_request.base.sha");
    expect(ci).not.toMatch(/git diff --name-only "origin\//);
  });
});
