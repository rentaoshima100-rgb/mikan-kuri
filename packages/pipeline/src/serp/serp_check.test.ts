import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FixtureLLMClient } from "@kurimikan/shared";
import { MemoryStore } from "../db/memory.js";
import { generateArticle } from "../orchestrator/generate.js";
import { attachSerpToReviewNotes, fetchSerpTop10, runSerpCheck, type SerpGap } from "./serp_check.js";

const FIXTURES = join(__dirname, "..", "..", "..", "shared", "fixtures", "llm");
const SUITE = join(__dirname, "..", "..", "..", "..", "kurimikan_prompt_suite_v1.md");

const SERP_VERDICT = JSON.stringify({
  covered_by_top: ["費用相場の一般論"],
  gaps_filled: ["実装者視点の変動要因", "発注前チェックリスト"],
  gaps_missed: ["補助金との併用"],
  differentiation: "strong",
  note_for_reviewer: "上位10件が扱っていない実装者視点をカバーできています。",
});

const SERP_API_RESPONSE = {
  tasks: [
    {
      result: [
        {
          items: [
            { type: "organic", rank_group: 1, title: "リニューアル費用の相場", url: "https://a.example", description: "相場は…" },
            { type: "people_also_ask", title: "無視される", url: "", description: "" },
            { type: "organic", rank_group: 2, title: "制作会社の選び方", url: "https://b.example", description: "選び方…" },
          ],
        },
      ],
    },
  ],
};

function fakeSerpFetch(response: unknown = SERP_API_RESPONSE): {
  impl: typeof fetch;
  calls: { url: string; body: unknown; auth?: string }[];
} {
  const calls: { url: string; body: unknown; auth?: string }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      auth: headers.authorization,
    });
    return { ok: true, status: 200, json: async () => response, text: async () => "" } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

function makeStore(enabled: boolean): MemoryStore {
  const store = new MemoryStore();
  store.setConfig("serp_check", { enabled, provider: "dataforseo", top_n: 10 });
  store.setConfig("lane_b_allowed_types", ["howto", "comparison", "public_data", "market_report"]);
  return store;
}

const CREDS = { login: "user", password: "pass" };

describe("serp_check: DataForSEO取得", () => {
  it("organic上位のみを抽出し、Basic認証と日本ロケールを送る", async () => {
    const { impl, calls } = fakeSerpFetch();
    const top = await fetchSerpTop10("サイトリニューアル", CREDS, impl);

    expect(top).toHaveLength(2); // people_also_askは除外
    expect(top[0]).toMatchObject({ rank: 1, title: "リニューアル費用の相場" });
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
    expect(calls[0]!.body).toMatchObject([{ language_code: "ja", location_code: 2392, depth: 10 }]);
  });
});

describe("serp_check: 実行条件とスキップ", () => {
  it("serp_check.enabled=false ならAPIを呼ばずスキップ", async () => {
    const { impl, calls } = fakeSerpFetch();
    const llm = new FixtureLLMClient({ responses: { "P-SERP": SERP_VERDICT } });
    const gap = await runSerpCheck("kw", "要約", { store: makeStore(false), llm, fetchImpl: impl });

    expect(gap.checked).toBe(false);
    expect(gap.skipped_reason).toContain("enabled=false");
    expect(calls).toHaveLength(0);
    expect(llm.calls).toHaveLength(0);
  });

  it("認証情報未設定ならスキップ (キー取得は人間タスク)", async () => {
    const { impl } = fakeSerpFetch();
    const llm = new FixtureLLMClient({ responses: { "P-SERP": SERP_VERDICT } });
    const gap = await runSerpCheck("kw", "要約", {
      store: makeStore(true),
      llm,
      fetchImpl: impl,
      credentials: { login: "", password: "" },
    });
    expect(gap.skipped_reason).toContain("DATAFORSEO");
  });

  it("有効ならSERP取得→LLM仮判定を行い、advisory_onlyを立てる", async () => {
    const { impl } = fakeSerpFetch();
    const llm = new FixtureLLMClient({ responses: { "P-SERP": SERP_VERDICT } });
    const gap = await runSerpCheck("サイトリニューアル", "要約", {
      store: makeStore(true),
      llm,
      fetchImpl: impl,
      credentials: CREDS,
    });

    expect(gap.checked).toBe(true);
    expect(gap.advisory_only).toBe(true); // v3: 自動棄却には使わない
    expect(gap.verdict?.differentiation).toBe("strong");
    expect(gap.top_results).toHaveLength(2);
    // 上位結果がLLMに渡されている
    expect(llm.calls[0]!.user).toContain("リニューアル費用の相場");
  });
});

describe("serp_check: human_review_notesへの添付 (v3)", () => {
  const gap: SerpGap = {
    checked: true,
    advisory_only: true,
    verdict: {
      covered_by_top: ["一般論"],
      gaps_filled: ["実装者視点"],
      gaps_missed: ["補助金との併用"],
      differentiation: "strong",
      note_for_reviewer: "差別化できています。",
    },
  };

  it("承認者向けメモに差別化と未対応論点が追記される", () => {
    const quality = {
      human_review_notes: { risk_areas: ["既存のリスク"], uniqueness_basis: "実装者視点" },
    };
    const out = attachSerpToReviewNotes(quality, gap);

    expect(out.human_review_notes.uniqueness_basis).toContain("差別化=strong");
    expect(out.human_review_notes.risk_areas[0]).toBe("既存のリスク"); // 既存は残る
    expect(out.human_review_notes.risk_areas.join("\n")).toContain("補助金との併用");
    expect(out.human_review_notes.risk_areas.join("\n")).toContain("差別化できています");
  });

  it("未実行なら何も変更しない", () => {
    const quality = {
      human_review_notes: { risk_areas: ["r"], uniqueness_basis: "u" },
    };
    expect(attachSerpToReviewNotes(quality, { checked: false, advisory_only: true })).toBe(quality);
  });
});

describe("serp_check: オーケストレータ統合", () => {
  async function runWithSerp(enabled: boolean) {
    const store = makeStore(enabled);
    const kw = store.addKeyword({ keyword: "site-renewal", cluster: "renewal", assigned_lane: "A" });
    const llm = new FixtureLLMClient({
      fixturesDir: FIXTURES,
      responses: { "P-SERP": SERP_VERDICT },
    });
    const { impl } = fakeSerpFetch();
    process.env.DATAFORSEO_LOGIN = enabled ? "user" : "";
    process.env.DATAFORSEO_PASSWORD = enabled ? "pass" : "";
    const article = await generateArticle(kw.id, {
      store,
      llm,
      suitePath: SUITE,
      budgetUsd: 60,
      serpFetch: impl,
    });
    delete process.env.DATAFORSEO_LOGIN;
    delete process.env.DATAFORSEO_PASSWORD;
    return { store, article, llm };
  }

  it("有効時: serp_gapが保存され、human_review_notesに所見が入る", async () => {
    const { article } = await runWithSerp(true);
    const gap = article.serp_gap as SerpGap;
    expect(gap.checked).toBe(true);
    expect(gap.advisory_only).toBe(true);
    const quality = article.quality as {
      human_review_notes: { uniqueness_basis: string; risk_areas: string[] };
    };
    expect(quality.human_review_notes.uniqueness_basis).toContain("SERP差分");
    // 承認は自動化されない (v3)
    expect(article.status).toBe("approval_pending");
  });

  it("SERP差分の結果に関わらず記事は棄却されない (advisory only)", async () => {
    const store = makeStore(true);
    const kw = store.addKeyword({ keyword: "site-renewal", cluster: "renewal", assigned_lane: "A" });
    const weak = JSON.stringify({
      covered_by_top: ["全部"],
      gaps_filled: [],
      gaps_missed: ["独自性なし"],
      differentiation: "weak",
      note_for_reviewer: "上位と差分がありません。",
    });
    const llm = new FixtureLLMClient({ fixturesDir: FIXTURES, responses: { "P-SERP": weak } });
    const { impl } = fakeSerpFetch();
    process.env.DATAFORSEO_LOGIN = "user";
    process.env.DATAFORSEO_PASSWORD = "pass";
    const article = await generateArticle(kw.id, {
      store,
      llm,
      suitePath: SUITE,
      budgetUsd: 60,
      serpFetch: impl,
    });
    delete process.env.DATAFORSEO_LOGIN;
    delete process.env.DATAFORSEO_PASSWORD;

    expect(article.status).toBe("approval_pending"); // weakでも棄却されない
    expect((article.serp_gap as SerpGap).verdict?.differentiation).toBe("weak");
  });

  it("無効時: 生成は通常どおり完走し、serp_gapはスキップ理由を持つ", async () => {
    const { article, llm } = await runWithSerp(false);
    expect(article.status).toBe("approval_pending");
    expect((article.serp_gap as SerpGap).checked).toBe(false);
    expect(llm.calls.map((c) => c.promptId)).not.toContain("P-SERP");
  });

  it("SERP APIが落ちても生成は成功する (best-effort)", async () => {
    const store = makeStore(true);
    const kw = store.addKeyword({ keyword: "site-renewal", cluster: "renewal", assigned_lane: "A" });
    const llm = new FixtureLLMClient({ fixturesDir: FIXTURES });
    const failing = (async () => {
      throw new Error("DataForSEO down");
    }) as unknown as typeof fetch;
    process.env.DATAFORSEO_LOGIN = "user";
    process.env.DATAFORSEO_PASSWORD = "pass";
    const article = await generateArticle(kw.id, {
      store,
      llm,
      suitePath: SUITE,
      budgetUsd: 60,
      serpFetch: failing,
    });
    delete process.env.DATAFORSEO_LOGIN;
    delete process.env.DATAFORSEO_PASSWORD;

    expect(article.status).toBe("approval_pending");
    expect((article.serp_gap as SerpGap).checked).toBe(false);
  });
});

// P-04フィクスチャがhuman_review_notesを持つ前提を明示 (添付処理の依存)
it("P-04フィクスチャにhuman_review_notesがある", () => {
  const p04 = JSON.parse(readFileSync(join(FIXTURES, "P-04.json"), "utf8"));
  expect(p04.human_review_notes.risk_areas.length).toBeGreaterThan(0);
});
