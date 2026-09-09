import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "..", "supabase", "migrations");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const sql = Object.fromEntries(
  files.map((f) => [f, readFileSync(join(dir, f), "utf8")]),
);
const all = Object.values(sql).join("\n");
// DDL本体のみ (コメント行は差分の説明として廃止語を含んでよい)
const ddl = all
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .map((line) => line.split("--")[0])
  .join("\n");

describe("migrations: v3差分パッチの適用", () => {
  it("マイグレーションが番号順で、コア4本+RLSを含む", () => {
    expect(files.slice(0, 5)).toEqual([
      "0001_core.sql",
      "0002_content.sql",
      "0003_ops.sql",
      "0004_knowledge.sql",
      "0005_rls.sql",
    ]);
    // 0006以降の追加マイグレーションは番号順であればよい
    expect(files).toEqual([...files].sort());
  });

  it("automation_mode は廃止されている (自動公開の廃止)", () => {
    expect(ddl).not.toMatch(/automation_mode/);
  });

  it("hold_until は廃止されている (24時間ホールドの廃止)", () => {
    expect(ddl).not.toMatch(/hold_until/);
  });

  it("articles.status に approval_pending がある", () => {
    expect(sql["0002_content.sql"]).toMatch(/'approval_pending'/);
  });

  it("approvals テーブルがあり decision は approved|sent_back のみ", () => {
    const content = sql["0002_content.sql"]!;
    expect(content).toMatch(/create table approvals/);
    expect(content).toMatch(
      /decision text not null check \(decision in \('approved','sent_back'\)\)/,
    );
  });

  it("judge不一致フラグ (judge_disagreement) がある", () => {
    expect(sql["0002_content.sql"]).toMatch(
      /judge_disagreement boolean not null default false/,
    );
  });

  it("SERP差分チェック結果カラム (serp_gap) がある", () => {
    expect(sql["0002_content.sql"]).toMatch(/serp_gap jsonb/);
  });

  it("多重計測テーブル (ai_cv_events) が3系統のsourceを持つ", () => {
    expect(sql["0003_ops.sql"]).toMatch(
      /source in \('ga4_channel','self_report','referrer_log'\)/,
    );
  });

  it("全テーブルにRLSが有効化されている", () => {
    // "create table if not exists <name>" も拾う (これを見落とすと "if" をテーブル名として
    // 扱い、RLSの検査が空振りする)
    const tables = [...all.matchAll(/create table (?:if not exists )?(\w+)/g)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThanOrEqual(20);
    // 0005より後のマイグレーションで作られたテーブルは、0005に追記しても
    // 適用済み環境には効かないため、作成したマイグレーション自身でRLSを有効化する。
    // よって検査対象は0005単体ではなく全マイグレーション
    for (const t of tables) {
      expect(all, `RLS missing for table: ${t}`).toMatch(
        new RegExp(`alter table ${t} enable row level security`),
      );
    }
  });

  it("anonポリシは published記事 と authors のみ", () => {
    const rls = sql["0005_rls.sql"]!;
    const policies = [...rls.matchAll(/create policy (\w+)/g)].map((m) => m[1]);
    expect(policies).toEqual(["anon_read_published_articles", "anon_read_authors"]);
    expect(rls).toMatch(/using \(status = 'published'\)/);
  });

  it("SQLの基本サニティ: 括弧の対応が取れている", () => {
    for (const [name, content] of Object.entries(sql)) {
      // コメント (日本語の説明文) は数えない。検証対象はDDLの括弧
      const ddlOnly = content
        .split("\n")
        .map((line) => line.split("--")[0]!)
        .join("\n");
      const open = (ddlOnly.match(/\(/g) ?? []).length;
      const close = (ddlOnly.match(/\)/g) ?? []).length;
      expect(open, `unbalanced parens in ${name}`).toBe(close);
    }
  });
});
