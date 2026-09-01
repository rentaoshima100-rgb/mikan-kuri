// SERP差分チェック (v3追加実装)。
// DataForSEO SERP APIで対象KWの上位10件を取得し、生成記事が「上位が答えていない
// 検索意図ギャップを埋めているか」をLLMで仮判定する。
//
// v3の絶対条件: 結果は human_review_notes に添付するのみ。自動棄却には使わない。
// 最終判断は常に承認者 (人間)。
// DATAFORSEO_LOGIN/PASSWORD 未設定時、または serp_check.enabled=false の場合はスキップ。
import { z } from "zod";
import { callAndParse, fillTemplate, getPrompt, registerExtraPrompt, type LLMClient } from "@kurimikan/shared";
import type { Store } from "../db/types.js";

export interface SerpResultItem {
  rank: number;
  title: string;
  url: string;
  description: string;
}

export const SerpGapVerdict = z.object({
  covered_by_top: z.array(z.string()),
  gaps_filled: z.array(z.string()),
  gaps_missed: z.array(z.string()),
  differentiation: z.enum(["strong", "moderate", "weak"]),
  note_for_reviewer: z.string(),
});
export type SerpGapVerdictT = z.infer<typeof SerpGapVerdict>;

export interface SerpGap {
  checked: boolean;
  skipped_reason?: string;
  keyword?: string;
  top_results?: SerpResultItem[];
  verdict?: SerpGapVerdictT;
  // 自動棄却には使わないことをデータ上も明示する (v3)
  advisory_only: true;
}

export interface SerpCheckDeps {
  store: Store;
  llm: LLMClient;
  fetchImpl?: typeof fetch;
  credentials?: { login: string; password: string };
  suitePath?: string; // プロンプト解決用 (DB → suite → 既定文の順)
}

// SPECの絶対要件6「プロンプトはDB管理」に従い、コード直書きにせず
// EXTRA_PROMPTS へ登録する。DBに P-SERP 行があればそちらが優先される
export const SERP_PROMPT_ID = "P-SERP";

const SERP_GAP_PROMPT = `あなたはSEOの編集長です。対象キーワードの検索結果上位10件と、当社が生成した記事の要約を比較し、
「上位が答えていない検索意図のギャップを、この記事が埋めているか」を仮判定してください。
これは承認者 (人間) が公開判断する際の参考情報です。あなたの判定で記事が自動的に棄却されることはありません。

<keyword>{keyword}</keyword>

<top_results>
{top_results}
</top_results>

<our_article>
{article_summary}
</our_article>

<instructions>
1. 上位10件が共通して扱っている論点を covered_by_top に列挙する
2. 上位が扱っていない論点のうち、当社記事が扱えているものを gaps_filled に列挙する
3. 上位が扱っておらず、当社記事も扱えていない (機会損失の) 論点を gaps_missed に列挙する
4. differentiation: 差別化の強さを strong | moderate | weak で判定する
5. note_for_reviewer: 承認者が確認すべき点を1〜2文で書く
</instructions>

<output_format>
以下のJSONのみを出力すること。
{
  "covered_by_top": ["上位が共通して扱う論点"],
  "gaps_filled": ["上位が扱っておらず当社記事が扱えている論点"],
  "gaps_missed": ["上位も当社も扱っていない論点"],
  "differentiation": "strong|moderate|weak",
  "note_for_reviewer": "承認者向けの確認ポイント"
}
</output_format>`;

registerExtraPrompt(SERP_PROMPT_ID, SERP_GAP_PROMPT);

export async function fetchSerpTop10(
  keyword: string,
  credentials: { login: string; password: string },
  fetchImpl: typeof fetch = fetch,
): Promise<SerpResultItem[]> {
  const auth = Buffer.from(`${credentials.login}:${credentials.password}`).toString("base64");
  const res = await fetchImpl(
    "https://api.dataforseo.com/v3/serp/google/organic/live/regular",
    {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
      body: JSON.stringify([
        { keyword, language_code: "ja", location_code: 2392, depth: 10 }, // 2392 = Japan
      ]),
    },
  );
  if (!res.ok) throw new Error(`DataForSEO SERP取得失敗: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    tasks?: {
      result?: {
        items?: { type: string; rank_group?: number; title?: string; url?: string; description?: string }[];
      }[];
    }[];
  };
  const items = data.tasks?.[0]?.result?.[0]?.items ?? [];
  return items
    .filter((i) => i.type === "organic")
    .slice(0, 10)
    .map((i, idx) => ({
      rank: i.rank_group ?? idx + 1,
      title: i.title ?? "",
      url: i.url ?? "",
      description: i.description ?? "",
    }));
}

export async function runSerpCheck(
  keyword: string,
  articleSummary: string,
  deps: SerpCheckDeps,
  articleId?: string,
): Promise<SerpGap> {
  const config = await deps.store.getConfig<{ enabled?: boolean }>("serp_check");
  if (!config?.enabled) {
    return { checked: false, skipped_reason: "serp_check.enabled=false", advisory_only: true };
  }
  const credentials = deps.credentials ?? {
    login: process.env.DATAFORSEO_LOGIN ?? "",
    password: process.env.DATAFORSEO_PASSWORD ?? "",
  };
  if (!credentials.login || !credentials.password) {
    return {
      checked: false,
      skipped_reason: "DATAFORSEO_LOGIN/PASSWORD未設定",
      advisory_only: true,
    };
  }

  const top = await fetchSerpTop10(keyword, credentials, deps.fetchImpl);
  if (top.length === 0) {
    return { checked: false, skipped_reason: "SERP結果が空", keyword, advisory_only: true };
  }

  const template = await getPrompt(
    SERP_PROMPT_ID,
    deps.store.getPromptFromDb.bind(deps.store),
    deps.suitePath ?? "",
  );
  const user = fillTemplate(template, {
    keyword,
    top_results: top.map((t) => `${t.rank}. ${t.title}\n   ${t.description}`).join("\n"),
    article_summary: articleSummary,
  });

  const verdict = await callAndParse(
    deps.llm,
    { promptId: SERP_PROMPT_ID, user, job: "serp_check", articleId },
    SerpGapVerdict,
  );
  return { checked: true, keyword, top_results: top, verdict, advisory_only: true };
}

// P-04出力のhuman_review_notesへSERP所見を追記する (承認画面に出る形へ整形)
export function attachSerpToReviewNotes<
  T extends { human_review_notes: { risk_areas: string[]; uniqueness_basis: string } },
>(quality: T, gap: SerpGap): T {
  if (!gap.checked || !gap.verdict) return quality;
  const v = gap.verdict;
  const notes = { ...quality.human_review_notes };
  notes.uniqueness_basis = `${notes.uniqueness_basis} / SERP差分 (参考): 差別化=${v.differentiation}、上位が扱っていない論点を${v.gaps_filled.length}件カバー`;
  notes.risk_areas = [
    ...notes.risk_areas,
    ...(v.gaps_missed.length
      ? [`SERP差分 (参考): 上位も当社も未対応の論点 — ${v.gaps_missed.join(" / ")}`]
      : []),
    `SERP差分 (参考): ${v.note_for_reviewer}`,
  ];
  return { ...quality, human_review_notes: notes };
}
