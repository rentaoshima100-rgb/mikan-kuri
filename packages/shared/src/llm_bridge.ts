// サブスクリプション実行 (Claude Codeルーチン) 向けのLLMブリッジ (代表指示 2026-09-08)。
//
// APIキー (ANTHROPIC_API_KEY) を使わず、同じセッションで動いているClaude Code
// エージェント自身にLLM役をさせる。パイプラインはリクエストをファイルに書き、
// エージェントが応答ファイルを書くのを待つ (クラウド下書き=cloud_drafts と同じ
// 「Claude Codeがエージェントとして書く」構成の全面展開)。
//
// プロトコル (ディレクトリは LLM_BRIDGE_DIR、既定 <cwd>/.llm-bridge):
//   要求: req-<seq>.json  { kind: "llm"|"research", seq, ... }
//   応答: res-<seq>.json  { text: "..." } / research は { text, sources } / 失敗は { error }
// 応答の書き込みは npx tsx scripts/bridge_reply.ts が担う (JSONエスケープ事故の防止)。
// エージェント側の手順は docs/ROUTINES.md 参照。
//
// 品質担保はパイプライン側に残る: 応答は従来どおり callAndParse (zod) で検証され、
// 品質ゲート・重複ゲート・表記チェック・承認フローは一切変わらない。
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ApiUsageRow, LLMClient, LLMRequest, LLMResponse } from "./llm.js";

// 応答を待つ上限。P-02のセクション執筆でもエージェントの1ターンは数分で終わるが、
// クラウド環境の混雑やリトライを見込んで長めに取る (タイムアウト時はそのステップが
// 失敗扱いになり、ジョブのフェイルクローズド動作に乗る)
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_POLL_MS = 2_000;

export interface BridgeOptions {
  dir?: string;
  timeoutMs?: number;
  pollMs?: number;
}

export class BridgeTimeoutError extends Error {
  constructor(seq: number, timeoutMs: number) {
    super(
      `ブリッジ応答がありません (req-${pad(seq)}.json, ${Math.round(timeoutMs / 1000)}秒待機)。` +
        "エージェントがブリッジを監視しているか確認してください (docs/ROUTINES.md)",
    );
    this.name = "BridgeTimeoutError";
  }
}

function pad(seq: number): string {
  return String(seq).padStart(4, "0");
}

// 低レベルのファイル交換。BridgeLLMClient (本文系) と BridgeResearchClient (web検索) が共用する
export class FileBridge {
  readonly dir: string;
  private timeoutMs: number;
  private pollMs: number;
  private seq = 0;

  constructor(opts: BridgeOptions = {}) {
    this.dir = opts.dir ?? process.env.LLM_BRIDGE_DIR ?? join(process.cwd(), ".llm-bridge");
    this.timeoutMs =
      opts.timeoutMs ?? Number(process.env.LLM_BRIDGE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    mkdirSync(this.dir, { recursive: true });
    // 前回の異常終了で残った要求/応答をエージェントが拾わないよう掃除する
    // (実行は直列なので、開始時点の残骸はすべて過去のもの)
    for (const f of readdirSync(this.dir)) {
      if (/^(req|res)-\d+\.json(\.tmp)?$/.test(f)) rmSync(join(this.dir, f), { force: true });
    }
  }

  async exchange(
    kind: "llm" | "research",
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const seq = ++this.seq;
    const reqPath = join(this.dir, `req-${pad(seq)}.json`);
    const resPath = join(this.dir, `res-${pad(seq)}.json`);
    const body = JSON.stringify(
      {
        kind,
        seq,
        reply_with: `npx tsx scripts/bridge_reply.ts ${seq} --text <出力ファイル> (JSON応答は --json)`,
        ...payload,
      },
      null,
      2,
    );
    // 書きかけのファイルをエージェントが読まないよう、tmpに書いてからrenameする
    writeFileSync(`${reqPath}.tmp`, body, "utf8");
    renameSync(`${reqPath}.tmp`, reqPath);

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(resPath)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(resPath, "utf8"));
        } catch {
          // 書き込み途中の可能性があるので次のポーリングまで待つ
          await sleep(this.pollMs);
          continue;
        }
        if (typeof parsed !== "object" || parsed === null) {
          throw new Error(`ブリッジ応答がオブジェクトではありません (res-${pad(seq)}.json)`);
        }
        const res = parsed as Record<string, unknown>;
        if (typeof res.error === "string") {
          throw new Error(`ブリッジ応答がエラーを返しました (seq=${seq}): ${res.error}`);
        }
        return res;
      }
      await sleep(this.pollMs);
    }
    throw new BridgeTimeoutError(seq, this.timeoutMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface BridgeClientDeps {
  bridge?: FileBridge;
  // api_usageへの記録 (任意)。コストは$0だが、何をどれだけ呼んだかの観測は残す
  recordUsage?: (row: ApiUsageRow) => Promise<void>;
}

// LLMClient実装。AnthropicLLMClientと同じ差し込み口で、呼び出し先だけがエージェントになる。
// モデルルーティング (haiku/sonnet/opus) はセッションのモデルに一本化されるため使わない。
export class BridgeLLMClient implements LLMClient {
  readonly calls: LLMRequest[] = [];
  private bridge: FileBridge;

  constructor(private deps: BridgeClientDeps = {}) {
    if (process.env.PIPELINE_ENV === "dry_run") {
      // dry_runで実行系クライアントが構築されること自体を禁止する (AnthropicLLMClientと同じ)
      throw new Error("dry_runでBridgeLLMClientは使用できません。FixtureLLMClientを使ってください");
    }
    this.bridge = deps.bridge ?? new FileBridge();
  }

  async call(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const res = await this.bridge.exchange("llm", {
      promptId: req.promptId,
      system: req.system,
      user: req.user,
      thinking: req.thinking ?? false,
      job: req.job,
      articleId: req.articleId,
    });
    const text = res.text;
    if (typeof text !== "string" || text.length === 0) {
      throw new Error(`ブリッジ応答にtextがありません (promptId=${req.promptId})`);
    }
    // トークン数は概算 (文字数/4)。サブスク実行では課金に使わず観測のみ
    const usage = {
      inputTokens: Math.ceil(((req.system ?? "").length + req.user.length) / 4),
      outputTokens: Math.ceil(text.length / 4),
      cachedTokens: 0,
    };
    await this.deps.recordUsage?.({
      prompt_id: req.promptId,
      model: BRIDGE_MODEL,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cached_tokens: 0,
      cost_usd: 0,
      article_id: req.articleId,
      job: req.job,
    });
    return { text, ...usage, model: BRIDGE_MODEL };
  }
}

// api_usage.model に記録する識別子 (サブスク実行であることをコスト集計から区別できるように)
export const BRIDGE_MODEL = "claude-code-subscription";
