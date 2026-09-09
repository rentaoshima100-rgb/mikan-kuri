// 一次情報の自動リサーチ。
//
// トピックに関する「出典URL付きの検証済みファクト」を自動収集し、
// primary_info_assets (public_data型) に投入する。記事生成時に注入され、
// P-04のハルシネーションflag (出典なし) を解消し、公開ファクトの実質を足す。
//
// 重要: ここで採れるのは「出典付きの公開情報」であり、この案件で最強の独自性は
// 産地の実測 (収穫日・糖度・その年の天候)。自動リサーチは手間を減らすが、
// field_record / measurement / weather を完全には代替しない。
// 安全網: 生成された資産は記事に注入されるが、記事は品質ゲート・法令ゲート・承認を必ず通る。
import { z } from "zod";
import {
  callAndParse,
  FileBridge,
  fillTemplate,
  getPrompt,
  registerExtraPrompt,
  type LLMClient,
} from "@kurimikan/shared";
import type { PrimaryAssetRow, Store } from "../db/types.js";

// ---- リサーチ (web_search) ----

export interface ResearchSource {
  url: string;
  title: string;
}
export interface ResearchOutput {
  text: string; // モデルがまとめた本文 (検索結果に基づく)
  sources: ResearchSource[]; // web_searchが実際に参照したURL
}

// web_searchを使う実クライアント。dry_runでは構築を禁止 (実APIを叩くため)。
export interface ResearchClient {
  research(query: string): Promise<ResearchOutput>;
}

export class AnthropicResearchClient implements ResearchClient {
  private sdk: unknown;
  constructor(
    private opts: { model?: string; maxUses?: number } = {},
    // テスト用に注入可能にする。未指定なら実SDKを遅延生成
    sdk?: unknown,
  ) {
    if (!sdk && process.env.PIPELINE_ENV === "dry_run") {
      throw new Error("dry_runでAnthropicResearchClientは使用できません");
    }
    this.sdk = sdk;
  }

  private async client(): Promise<{
    messages: {
      create(args: unknown): Promise<{ content: { type: string; text?: string; content?: unknown }[] }>;
    };
  }> {
    if (!this.sdk) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this.sdk = new Anthropic();
    }
    return this.sdk as never;
  }

  async research(query: string): Promise<ResearchOutput> {
    const sdk = await this.client();
    const res = await sdk.messages.create({
      model: this.opts.model ?? "claude-opus-4-8",
      max_tokens: 3000,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: this.opts.maxUses ?? 4 }],
      messages: [{ role: "user", content: query }],
    });
    const text = res.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
    const sources: ResearchSource[] = [];
    for (const b of res.content) {
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const it of b.content as { url?: string; title?: string }[]) {
          if (it.url) sources.push({ url: it.url, title: it.title ?? "" });
        }
      }
    }
    return { text, sources };
  }
}

// サブスク実行 (LLM_BACKEND=bridge) 用。web_search APIの代わりに、ルーチンの
// Claude CodeエージェントにWebSearchツールでリサーチさせる (docs/ROUTINES.md)。
// 応答は {text, sources:[{url,title}]}。出典が返らなければ従来と同じく資産は作られない
// (researchTopicToAsset側の「出典なしは投入しない」ガードがそのまま効く)。
export class BridgeResearchClient implements ResearchClient {
  private bridge: FileBridge;
  constructor(bridge?: FileBridge) {
    if (!bridge && process.env.PIPELINE_ENV === "dry_run") {
      throw new Error("dry_runでBridgeResearchClientは使用できません");
    }
    this.bridge = bridge ?? new FileBridge();
  }

  async research(query: string): Promise<ResearchOutput> {
    const res = await this.bridge.exchange("research", {
      query,
      expected_response:
        '{"text":"リサーチ結果の本文 (出典URL付き箇条書き)","sources":[{"url":"実際に参照したURL","title":"ページ名"}]}',
    });
    if (typeof res.text !== "string" || res.text.length === 0) {
      throw new Error("ブリッジのリサーチ応答にtextがありません");
    }
    const sources: ResearchSource[] = [];
    if (Array.isArray(res.sources)) {
      for (const it of res.sources as { url?: unknown; title?: unknown }[]) {
        if (typeof it?.url === "string" && it.url) {
          sources.push({ url: it.url, title: typeof it.title === "string" ? it.title : "" });
        }
      }
    }
    return { text: res.text, sources };
  }
}

// 実行環境に応じたResearchClient生成 (makeLLMClientと対になる)
export function makeResearchClient(): ResearchClient {
  if (process.env.LLM_BACKEND === "bridge") return new BridgeResearchClient();
  return new AnthropicResearchClient();
}

const RESEARCH_QUERY = (topic: string) =>
  `あなたは柑橘の産地直送ECのオウンドメディアの編集リサーチャです。
次のトピックについて、記事に使える「出典が明確な検証済みファクト」をWeb検索で3〜6個集めてください。

トピック: ${topic}

条件:
- 政府統計 (農林水産省の特産果樹生産動態等調査、作物統計等)、県・JAの公表資料、
  品種登録情報、信頼できる業界調査を優先
- 各ファクトに、実在する出典URLと、数値があれば数値・単位を必ず添える
- 出典が確認できないものは含めない
- 効能効果 (免疫力・風邪予防等) に関する情報は集めない。食品では書けないため
- 産地・品種・時期・栽培・流通に直結するものを選ぶ

見つけたファクトを、出典URLとともに箇条書きでまとめてください。`;

// ---- 構造化 (research text → asset) ----

export const RESEARCH_STRUCTURE_PROMPT_ID = "P-RESEARCH";

const RESEARCH_STRUCTURE_PROMPT = `あなたは編集者です。リサーチ結果を、記事に注入できる一次情報アセット1件に構造化してください。

<リサーチ結果>
{research_text}
</リサーチ結果>

<検索が参照した出典URL>
{sources}
</検索が参照した出典URL>

<対象トピック / クラスタ>
{topic} / {cluster}
</対象トピック / クラスタ>

条件:
- content: 記事本文へ注入する文章。各ファクトを出典の帰属つきで自然な敬体で記述。★公開されるので誇張しない★
- numeric_claims: 検証済みの数値。basis に必ず出典 (調査名+URL) を書く。出典が曖昧なものは含めない
- 表記規則: カタカナ語末尾の長音省略 (サーバ/ユーザ)、ダッシュ記号不使用、敬体

<output_format>
{"title":"","description":"どんな一次情報か1文","content":"","numeric_claims":[{"claim":"","value":"","unit":"","basis":"調査名 (URL)","verified":true}]}
</output_format>`;

registerExtraPrompt(RESEARCH_STRUCTURE_PROMPT_ID, RESEARCH_STRUCTURE_PROMPT);

const StructuredAsset = z.object({
  title: z.string().min(1),
  description: z.string(),
  content: z.string().min(1),
  numeric_claims: z.array(
    z.object({
      claim: z.string(),
      value: z.string(),
      unit: z.string().optional(),
      basis: z.string().min(1),
      verified: z.boolean(),
    }),
  ),
});

export interface ResearchTopicDeps {
  store: Store;
  llm: LLMClient; // 構造化に使う (FixtureLLMClientでテスト可)
  research: ResearchClient; // web_search
  suitePath: string;
}

// トピックを自動リサーチして primary_info_assets に1件投入する。
// 出典URLが1つも取れなければ投入しない (裏の取れない資産を作らない)。
export async function researchTopicToAsset(
  deps: ResearchTopicDeps,
  opts: { topic: string; cluster: string },
): Promise<{ asset: PrimaryAssetRow | null; sources: ResearchSource[] }> {
  const research = await deps.research.research(RESEARCH_QUERY(opts.topic));
  if (research.sources.length === 0) {
    return { asset: null, sources: [] };
  }

  const prompt = await getPrompt(
    RESEARCH_STRUCTURE_PROMPT_ID,
    deps.store.getPromptFromDb.bind(deps.store),
    deps.suitePath,
  );
  const structured = await callAndParse(
    deps.llm,
    {
      promptId: RESEARCH_STRUCTURE_PROMPT_ID,
      user: fillTemplate(prompt, {
        research_text: research.text,
        sources: research.sources.map((s) => `- ${s.title} (${s.url})`).join("\n"),
        topic: opts.topic,
        cluster: opts.cluster,
      }),
      job: "generation",
    },
    StructuredAsset,
  );

  const asset = await deps.store.insertPrimaryAsset({
    asset_type: "public_data",
    title: structured.title,
    description: structured.description,
    content: structured.content,
    numeric_claims: structured.numeric_claims,
    applicable_clusters: [opts.cluster],
    sensitivity: "low",
    source_permission: true,
  });
  return { asset, sources: research.sources };
}
