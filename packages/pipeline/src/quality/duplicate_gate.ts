// 重複ハードゲート (代表指示 2026-08-14: 同じ内容の記事を二度公開しない)。
//
// 発案時の重複チェック (propose_keywords.ts) は「提案を登録するかどうか」のふるいで、
// 一度キューに入った重複トピックや、チェック自体が失敗してすり抜けた案を止める場所が
// 無かった。全自動公開 (full_auto_publish=true) では承認画面の警告を誰も見ないため、
// すり抜けた重複はそのままサイトに公開されていた。
//
// このモジュールは公開に至る最後の機械的な関門を2つ提供する:
//   1. checkTopicDuplicate  — 記事を生成する直前 (トークンを使う前) にキーワードを判定
//   2. findTitleDuplicate   — 仕上げでタイトルが確定した直後に、既存タイトルとの近似一致を判定
//
// 改修 (track='revision' / keywordが "refit:" 始まり) は既存URLの中身を直す仕事で、
// 「既存と同じ記事」であることが正しい。ゲートの対象外にすること (呼び出し側で除外する)。
import type { LLMClient } from "@kurimikan/shared";
import type { Store } from "../db/types.js";
import { checkIntentDuplicates, type ExistingTopic } from "../strategy/intent_dedup.js";
import { findSimilar, similarity } from "../strategy/propose_keywords.js";

export interface DuplicateGateDeps {
  store: Store;
  llm: LLMClient;
  suitePath: string;
  // DBが追跡していない記事 (店舗が /blogs/news に手で投稿したお知らせ等) を
  // 判定相手に加えるためのプロバイダ。省略すると相手はDBの記事だけになる。
  // Shopifyから引く実装は site_integration/shopify/topics.ts
  extraTopics?: () => Promise<ExistingTopic[]>;
}

export type DuplicateVerdict =
  | { duplicate: false; checked: boolean } // checked=false: LLM照合が走らなかった (相手なし/失敗)
  | { duplicate: true; hard: boolean; conflictsWith: string; reason: string };

// 意図照合 (LLM) が実行できなかったときに、フェイルクローズドを選んだ呼び出し側へ投げる。
// 全自動公開中は「判定できない=公開しない」が正しい (v3のフェイルクローズド原則と同じ)。
// キーワードは queued のまま残るので、次回の実行で自動的に再試行される。
export class DuplicateCheckUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `重複判定 (P-DUP) を実行できませんでした。全自動公開中はフェイルクローズドで生成を見送ります: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "DuplicateCheckUnavailableError";
  }
}

// タイトル同士の「ほぼ同一」判定のしきい値。
// キーワード空間の0.70 (propose_keywords.SIMILARITY_THRESHOLD) より高いのは、
// タイトルは長く定型句 (「〜を解説」「中小企業向け」等) を共有しやすく、
// 別記事同士でも重なりが大きく出るため。実測:
//   0.833 「…費用相場と内訳を解説」vs「…費用相場と内訳を紹介」 (語尾違いの同一タイトル)
//   0.45  「…費用相場と内訳を解説」vs「…失敗事例と回避策を解説」 (同じ主題の別切り口)
// 0.80は前者を拾い、後者に十分な余裕を残す位置。
export const TITLE_DUP_THRESHOLD = 0.8;

const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/**
 * タイトルの近似一致を探す (決定論のみ、LLM不使用)。
 * 正規化して同一、または bigram 類似度が TITLE_DUP_THRESHOLD 以上なら相手を返す。
 * 仕上げ (P-12でタイトル確定直後) と公開バックログの掃除に使う。
 */
export function findTitleDuplicate(title: string, existingTitles: string[]): string | null {
  const key = norm(title);
  if (!key) return null;
  let best: { title: string; score: number } | null = null;
  for (const t of existingTitles) {
    if (!t) continue;
    if (norm(t) === key) return t;
    const score = similarity(title, t);
    if (score >= TITLE_DUP_THRESHOLD && (!best || score > best.score)) best = { title: t, score };
  }
  return best?.title ?? null;
}

/** 判定相手 (DBの記事 + サイト公開済み記事) を集める。 */
export async function collectExistingTopics(
  deps: DuplicateGateDeps,
  excludeArticleId?: string,
): Promise<ExistingTopic[]> {
  const summaries = await deps.store.listArticleSummaries(excludeArticleId);
  const known = new Set(summaries.map((s) => norm(s.title)).filter(Boolean));
  // 取得に失敗しても判定は続ける (相手が減るだけで、DB側の判定は生きている)
  let external: ExistingTopic[] = [];
  try {
    external = (await deps.extraTopics?.()) ?? [];
  } catch (e) {
    console.warn(`[duplicate_gate] ストア側の記事一覧を取得できませんでした: ${e}`);
  }
  const site = external.filter((t) => t.title && !known.has(norm(t.title)));
  return [
    ...summaries
      .filter((s) => !s.keyword.startsWith("refit:")) // 改修用の内部キーワードは相手にしない
      .map((s) => ({ title: s.title, keyword: s.keyword })),
    ...site,
  ];
}

/**
 * 記事化直前のトピック重複判定。トークンを使う前に呼ぶこと。
 *
 * 判定は2段:
 *   1. 決定論 — キーワード/タイトルの正規化一致・bigram類似 (誤検出がほぼ無いので常にhard)
 *   2. LLM意図照合 (P-DUP) — 字面が違っても同じ検索意図なら重複
 *
 * LLM照合が失敗したとき:
 *   - opts.failClosed=true (全自動公開中): DuplicateCheckUnavailableError を投げる。
 *     生成せず、キーワードはqueuedのまま次回に再試行される。
 *   - false (承認制): 警告ログだけ残して checked=false で通す。重複だったとしても
 *     承認画面で代表が読むので、最終的な歯止めは残っている (v3の元設計)。
 *
 * 判定相手に「記事化待ちの他のキーワード」は含めない。同意図のキーワードが2本
 * queuedにある場合、両方が互いを理由に落ち合う (相互全滅) 事故を避けるため。
 * 先に記事化された方が articles に入り、後から来た方がこのゲートで落ちる。
 */
export async function checkTopicDuplicate(
  deps: DuplicateGateDeps,
  candidate: { keyword: string; searchIntent?: string },
  opts: { failClosed?: boolean } = {},
): Promise<DuplicateVerdict> {
  const existing = await collectExistingTopics(deps);
  if (existing.length === 0) return { duplicate: false, checked: false };

  // 1. 決定論: キーワードが既存のキーワード/タイトルとほぼ同一
  const texts = existing.flatMap((t) => [t.keyword, t.title]).filter(Boolean);
  const exact = texts.find((t) => norm(t) === norm(candidate.keyword));
  const similar = exact ?? findSimilar(candidate.keyword, texts);
  if (similar) {
    return {
      duplicate: true,
      hard: true,
      conflictsWith: similar,
      reason: `キーワードが既存「${similar}」とほぼ同一 (字面一致)`,
    };
  }

  // 2. LLM意図照合 (P-DUP)。発案時と同じ判定器を、1件だけで使う
  try {
    const verdicts = await checkIntentDuplicates(
      deps,
      [
        {
          keyword: candidate.keyword,
          searchIntent: candidate.searchIntent ?? "キーワードから推定",
        },
      ],
      existing,
    );
    const v = verdicts.get(candidate.keyword);
    if (v?.duplicate) {
      return {
        duplicate: true,
        hard: false,
        conflictsWith: v.conflictsWith,
        reason: v.conflictsWith
          ? `検索意図が「${v.conflictsWith}」と重複: ${v.reason}`
          : `検索意図が既存記事と重複: ${v.reason}`,
      };
    }
    return { duplicate: false, checked: v !== undefined };
  } catch (e) {
    if (opts.failClosed) throw new DuplicateCheckUnavailableError(e);
    console.warn(
      `[duplicate_gate] 意図照合できず (承認制のため生成は続行。承認画面で重複を目視確認してください): ${e}`,
    );
    return { duplicate: false, checked: false };
  }
}
