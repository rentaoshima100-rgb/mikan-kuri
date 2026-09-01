// マイグレーション (SQL) と コード (db/types.ts) のカラム整合テスト。
//
// この不整合は MemoryStore では検出できない (何でも受け付けるため)。
// 実DBに繋いだ瞬間に PostgREST が "column does not exist" で落ちるので、
// ここで機械的に固定しておく。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");
const TYPES_PATH = join(__dirname, "..", "packages", "pipeline", "src", "db", "types.ts");

function loadTableColumns(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

    // create table <name> ( ... );
    for (const m of sql.matchAll(/create table (\w+)\s*\(([\s\S]*?)\n\);/g)) {
      const cols = new Set<string>();
      for (const rawLine of m[2]!.split("\n")) {
        const line = rawLine.split("--")[0]!;
        // カラム定義行は2スペースインデント。制約行 (unique/primary/check) は除外
        const col = /^ {2}([a-z_]+)\s+\S/.exec(line);
        if (col && !["unique", "primary", "check", "foreign", "constraint"].includes(col[1]!)) {
          cols.add(col[1]!);
        }
      }
      tables.set(m[1]!, cols);
    }

    // alter table <name> add column [if not exists] <col>
    for (const m of sql.matchAll(
      /alter table (\w+)\s+add column\s+(?:if not exists\s+)?([a-z_]+)/g,
    )) {
      const cols = tables.get(m[1]!) ?? new Set<string>();
      cols.add(m[2]!);
      tables.set(m[1]!, cols);
    }
  }
  return tables;
}

function loadInterfaceFields(name: string): string[] {
  const types = readFileSync(TYPES_PATH, "utf8");
  const start = types.indexOf(`export interface ${name} {`);
  if (start === -1) throw new Error(`インターフェースが見つかりません: ${name}`);
  const end = types.indexOf("\n}", start);
  const body = types.slice(start, end);
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!);
}

// オブジェクトリテラル本文から「深さ0のキー」だけを取り出す。
// ネストした値 (quality: { rejected_reason: ... }) のキーはカラムではないため除外する。
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let token = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (depth === 0) {
      if (/[a-z_]/i.test(ch)) {
        token += ch;
        continue;
      }
      if (ch === ":" && token) keys.push(token);
      token = "";
      continue;
    }
    token = "";
  }
  return keys;
}

const tables = loadTableColumns();

// コードの行型 → DBテーブル。左の全フィールドが右のカラムとして存在しなければならない
const PAIRS: [string, string][] = [
  ["KeywordRow", "keywords"],
  ["ArticleRow", "articles"],
  ["ApprovalRow", "approvals"],
  ["PublishQueueRow", "publish_queue"],
  ["PrimaryAssetRow", "primary_info_assets"],
  ["GscMetricRow", "gsc_metrics"],
  ["AiCvEvent", "ai_cv_events"],
  ["TripwireEvent", "tripwire_events"],
];

describe("schema parity: マイグレーションとdb/types.tsのカラム整合", () => {
  it("マイグレーションから主要テーブルを読み取れている (パーサ自体の健全性)", () => {
    for (const [, table] of PAIRS) {
      expect(tables.has(table), `テーブル未検出: ${table}`).toBe(true);
      expect(tables.get(table)!.size).toBeGreaterThan(3);
    }
    // 代表的なカラムが読めていること (パーサが空振りしていないことの確認)
    expect(tables.get("articles")!.has("judge_disagreement")).toBe(true);
    expect(tables.get("articles")!.has("serp_gap")).toBe(true);
    expect(tables.get("approvals")!.has("judge_disagreement_ack")).toBe(true);
  });

  for (const [iface, table] of PAIRS) {
    it(`${iface} の全フィールドが ${table} に存在する`, () => {
      const fields = loadInterfaceFields(iface);
      expect(fields.length).toBeGreaterThan(0);
      const cols = tables.get(table)!;
      const missing = fields.filter((f) => !cols.has(f));
      expect(missing, `${table} に存在しないカラム: ${missing.join(", ")}`).toEqual([]);
    });
  }
});

describe("schema parity: コードが書き込むカラムの実在", () => {
  // updateArticle({ ... }) / insert に現れるキーがarticlesに存在するか。
  // types.ts に載っていない直書きキーを拾うための二重チェック。
  it("orchestrator/refit が articles へ書くキーがすべて実在する", () => {
    const sources = [
      join(__dirname, "..", "packages", "pipeline", "src", "orchestrator", "generate.ts"),
      join(__dirname, "..", "packages", "pipeline", "src", "refit", "refit.ts"),
      join(__dirname, "..", "packages", "pipeline", "src", "approvals", "approvals.ts"),
      join(__dirname, "..", "packages", "pipeline", "src", "publish", "worker.ts"),
    ];
    const cols = tables.get("articles")!;
    const missing = new Set<string>();

    for (const path of sources) {
      const src = readFileSync(path, "utf8");
      for (const call of src.matchAll(/updateArticle\([^,]+,\s*\{([\s\S]*?)\}\)/g)) {
        for (const name of topLevelKeys(call[1]!)) {
          if (!cols.has(name)) missing.add(name);
        }
      }
    }
    expect([...missing], `articles に存在しないカラムへ書き込んでいます`).toEqual([]);
  });
});
