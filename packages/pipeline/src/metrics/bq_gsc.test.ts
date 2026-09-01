import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BqNotConfiguredError,
  fetchQueryStats,
  runQuery,
  summarizeAnonymized,
  type QueryStat,
} from "./bq_gsc.js";

// JWT署名が実際に走るため、テスト用のRSA鍵をその場で生成する。
// 本物の資格情報はテストに一切持ち込まない。
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const SA = JSON.stringify({
  type: "service_account",
  project_id: "test-project",
  client_email: "t@test-project.iam.gserviceaccount.com",
  private_key: privateKey,
});

// getGoogleAccessToken と BigQuery の両方を差し替える fetch
function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    }
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe("summarizeAnonymized: API版で見えていない分を数字にする", () => {
  const stats: QueryStat[] = [
    { date: "2026-07-31", query: "ホームページ 制作 費用", impressions: 100, clicks: 3, position: 8, anonymized: false },
    { date: "2026-07-31", query: "", impressions: 300, clicks: 1, position: 40, anonymized: true },
    { date: "2026-07-31", query: "llmo とは", impressions: 100, clicks: 0, position: 12, anonymized: false },
  ];

  it("匿名化された割合を出す", () => {
    const s = summarizeAnonymized(stats, "2026-07-31");
    expect(s.totalImpressions).toBe(500);
    expect(s.anonymizedImpressions).toBe(300);
    expect(s.anonymizedRatio).toBe(0.6); // 6割が個票で見えていない
    expect(s.visibleQueries).toBe(2);
  });

  it("データが無くてもゼロ除算しない", () => {
    expect(summarizeAnonymized([], "2026-07-31")).toEqual({
      date: "2026-07-31",
      totalImpressions: 0,
      anonymizedImpressions: 0,
      anonymizedRatio: 0,
      visibleQueries: 0,
    });
  });
});

describe("runQuery", () => {
  it("パラメータ化クエリとして送る (SQLを組み立てない)", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = stubFetch((url, init) => {
      if (url.includes("/queries")) {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 200, body: { jobComplete: true, schema: { fields: [] }, rows: [] } };
      }
      return { status: 404, body: {} };
    });
    await runQuery({ serviceAccountJson: SA, fetchImpl }, "SELECT @d", { d: "2026-07-31" });
    expect(sent.parameterMode).toBe("NAMED");
    expect(sent.queryParameters).toEqual([
      { name: "d", parameterType: { type: "STRING" }, parameterValue: { value: "2026-07-31" } },
    ]);
    expect(sent.useLegacySql).toBe(false);
  });

  it("列名を付けた行に変換する", async () => {
    const fetchImpl = stubFetch(() => ({
      status: 200,
      body: {
        jobComplete: true,
        schema: { fields: [{ name: "query" }, { name: "impressions" }] },
        rows: [{ f: [{ v: "llmo" }, { v: "12" }] }],
      },
    }));
    const rows = await runQuery({ serviceAccountJson: SA, fetchImpl }, "SELECT 1");
    expect(rows).toEqual([{ query: "llmo", impressions: "12" }]);
  });

  it("データセット未作成は未設定エラーとして区別する (障害ではない)", async () => {
    const fetchImpl = stubFetch(() => ({
      status: 404,
      body: { error: { message: "Not found: Dataset test-project:searchconsole" } },
    }));
    await expect(runQuery({ serviceAccountJson: SA, fetchImpl }, "SELECT 1")).rejects.toBeInstanceOf(
      BqNotConfiguredError,
    );
  });

  it("それ以外の失敗は通常のエラーにする", async () => {
    const fetchImpl = stubFetch(() => ({ status: 500, body: { error: { message: "boom" } } }));
    await expect(runQuery({ serviceAccountJson: SA, fetchImpl }, "SELECT 1")).rejects.toThrow(
      /BigQueryクエリ失敗/,
    );
  });
});

describe("fetchQueryStats", () => {
  it("匿名化フラグを含めて取る", async () => {
    const fetchImpl = stubFetch(() => ({
      status: 200,
      body: {
        jobComplete: true,
        schema: {
          fields: [
            { name: "data_date" },
            { name: "query" },
            { name: "is_anonymized_query" },
            { name: "impressions" },
            { name: "clicks" },
            { name: "position" },
          ],
        },
        rows: [
          { f: [{ v: "2026-07-31" }, { v: "" }, { v: "true" }, { v: "300" }, { v: "1" }, { v: "40.2" }] },
          { f: [{ v: "2026-07-31" }, { v: "llmo とは" }, { v: "false" }, { v: "100" }, { v: "0" }, { v: "12.4" }] },
        ],
      },
    }));
    const stats = await fetchQueryStats({ serviceAccountJson: SA, fetchImpl }, "2026-07-31");
    expect(stats).toHaveLength(2);
    expect(stats[0]!.anonymized).toBe(true);
    expect(stats[1]!.query).toBe("llmo とは");
    expect(stats[1]!.impressions).toBe(100);
  });
});
