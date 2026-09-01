// LLM呼び出しの共通クライアント (SPEC M1 anthropic.ts)。
// - 全LLM呼び出しはこのモジュール経由。直接SDKを叩かない
// - dry_run (PIPELINE_ENV=dry_run) ではフィクスチャ応答を返し、実APIを一切呼ばない
// - 実呼び出しはusageをapi_usageへ記録し、月次予算 (80%警告/100%停止) を確認する
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { checkBudget, computeCostUsd, type ModelPricing } from "./cost.js";

export interface LLMRequest {
  promptId: string;
  system?: string;
  user: string;
  model?: string;
  maxTokens?: number;
  thinking?: boolean; // P-16 (戦略) のみextended thinking有効
  job?: string;
  articleId?: string;
}

export interface LLMResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  model: string;
}

export interface LLMClient {
  call(req: LLMRequest): Promise<LLMResponse>;
  readonly calls: LLMRequest[]; // テスト/監査用の呼び出しログ
}

// promptId → model_routingカテゴリ (SPEC 配線図)
export const PROMPT_MODEL_CATEGORY: Record<string, "classify" | "generate" | "judge" | "strategy" | "coder"> = {
  "P-01": "generate",
  "P-02": "generate",
  "P-02-summary": "classify", // 各セクション後の100字要約はHaiku
  // 一次情報の関連度選択。タイトルと説明文を見て番号を返すだけなのでHaikuで足りる
  "asset-selection": "classify",
  "P-04": "judge",
  "P-05a": "judge",
  "P-05b": "classify",
  // 合議の第2系統。OpenAI未実装のため、第1系統 (classify=Haiku) とは別モデルになる
  // judge (Sonnet) を明示的に割り当てる。既定へのフォールバック任せにしない
  "P-05b-2": "judge",
  "P-06": "classify",
  "P-07": "generate",
  "P-08": "generate",
  "P-09": "generate",
  "P-10": "generate",
  "P-11": "classify",
  "P-12": "classify",
  "P-13a": "generate",
  "P-13b": "generate",
  "P-14": "classify",
  "P-15": "generate",
  "P-16": "strategy",
  "P-17": "coder",
  "P-18a": "classify",
  "P-18b": "classify",
};

export interface ApiUsageRow {
  prompt_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd: number;
  article_id?: string;
  job?: string;
}

export interface AnthropicClientDeps {
  routing: Record<string, string>; // pipeline_config.model_routing
  pricing: Record<string, ModelPricing>; // pipeline_config.model_pricing
  budgetUsd: number; // MONTHLY_TOKEN_BUDGET_USD
  getMonthSpendUsd: () => Promise<number>;
  recordUsage: (row: ApiUsageRow) => Promise<void>;
  onBudgetWarn?: (spent: number, budget: number) => void;
}

export class AnthropicLLMClient implements LLMClient {
  readonly calls: LLMRequest[] = [];
  private sdk: Anthropic;

  constructor(private deps: AnthropicClientDeps) {
    if (process.env.PIPELINE_ENV === "dry_run") {
      // dry_runで実APIクライアントが構築されること自体を禁止する (SPEC M1 Acceptance)
      throw new Error("dry_runでAnthropicLLMClientは使用できません。FixtureLLMClientを使ってください");
    }
    // 改修バッチ等の長時間実行では一時的な接続断 (other side closed 等) が起きうる。
    // 既定(2)より多くリトライして単発ブリップでバッチが落ちないようにする。
    this.sdk = new Anthropic({ maxRetries: 5 });
  }

  resolveModel(req: LLMRequest): string {
    if (req.model) return req.model;
    const category = PROMPT_MODEL_CATEGORY[req.promptId] ?? "generate";
    const model = this.deps.routing[category];
    if (!model) throw new Error(`model_routingに ${category} がありません`);
    return model;
  }

  async call(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const spent = await this.deps.getMonthSpendUsd();
    const status = checkBudget(spent, this.deps.budgetUsd); // 100%でthrow (生成系停止)
    if (status === "warn") this.deps.onBudgetWarn?.(spent, this.deps.budgetUsd);

    const model = this.resolveModel(req);
    const response = await this.sdk.messages.create({
      model,
      max_tokens: req.maxTokens ?? 8192,
      ...(req.thinking ? { thinking: { type: "adaptive" as const } } : {}),
      ...(req.system
        ? {
            system: [
              {
                type: "text" as const,
                text: req.system,
                // P-00はプロンプトキャッシュの固定部 (SPEC M1)
                cache_control: { type: "ephemeral" as const },
              },
            ],
          }
        : {}),
      messages: [{ role: "user", content: req.user }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cachedTokens: response.usage.cache_read_input_tokens ?? 0,
    };
    const pricing = this.deps.pricing[model];
    const cost = pricing ? computeCostUsd(pricing, usage) : 0;
    await this.deps.recordUsage({
      prompt_id: req.promptId,
      model,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cached_tokens: usage.cachedTokens,
      cost_usd: cost,
      article_id: req.articleId,
      job: req.job,
    });
    return { text, ...usage, model };
  }
}

export type FixtureResponses = Record<string, string | ((req: LLMRequest) => string)>;

// dry_run / テスト用クライアント。fixtures/llm/<promptId>.json|.txt または注入されたresponsesを返す。
export class FixtureLLMClient implements LLMClient {
  readonly calls: LLMRequest[] = [];

  constructor(
    private options: { fixturesDir?: string; responses?: FixtureResponses } = {},
  ) {}

  async call(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const injected = this.options.responses?.[req.promptId];
    let text: string;
    if (typeof injected === "function") text = injected(req);
    else if (typeof injected === "string") text = injected;
    else text = this.loadFixture(req.promptId);
    return {
      text,
      inputTokens: Math.ceil(req.user.length / 4),
      outputTokens: Math.ceil(text.length / 4),
      cachedTokens: 0,
      model: "fixture",
    };
  }

  private loadFixture(promptId: string): string {
    const dir = this.options.fixturesDir;
    if (!dir) throw new Error(`fixture未定義: ${promptId} (fixturesDir未設定)`);
    for (const ext of [".json", ".txt"]) {
      const path = join(dir, `${promptId}${ext}`);
      if (existsSync(path)) return readFileSync(path, "utf8");
    }
    throw new Error(`fixtureが見つかりません: ${promptId} (${dir})`);
  }
}

// JSON出力プロンプトのパース+リトライ (SPEC M1):
// zod.parse失敗時は「前回出力のパースエラー: {error}。JSONのみを再出力」を付けて最大2回リトライ。
export async function callAndParse<S extends z.ZodTypeAny>(
  client: LLMClient,
  req: LLMRequest,
  schema: S,
  maxRetries = 2,
): Promise<z.infer<S>> {
  let lastError = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const user =
      attempt === 0
        ? req.user
        : `${req.user}\n\n前回出力のパースエラー: ${lastError}。JSONのみを再出力`;
    const res = await client.call({ ...req, user });
    try {
      return schema.parse(JSON.parse(stripCodeFence(res.text)));
    } catch (e) {
      lastError = e instanceof Error ? e.message.slice(0, 500) : String(e);
    }
  }
  throw new Error(`LLM出力のパースに失敗 (${req.promptId}, retries=${maxRetries}): ${lastError}`);
}

export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const m = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return m ? m[1]! : trimmed;
}
