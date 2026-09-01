// 検索意図による重複判定 (カニバリゼーションの最後の関門)。
//
// なぜ文字列類似度では足りないか:
//   propose_keywords.ts の similarity() は bigram の Jaccard で、字面の重なりしか見ない。
//   2026-08-02 に実際にすり抜けた組み合わせを実測すると:
//     0.500  「リニューアル タイミング 見極め方」 と 「リニューアル 進め方 失敗」
//     0.167  「Googleビジネスプロフィール MEO 最適化」 と 「ローカルビジネス GEO MEO 集客」
//   しきい値は 0.55。前者は「タイミング」と「いつ」、「見極め」と「進め方」が
//   字面だけ違って意図が同じという典型で、原理的に届かない。しきい値を下げると
//   今度は無関係な記事まで弾き始める (0.5 付近には正常な提案も多く分布する)。
//
// そこで、字面のふるいを通ったものだけを対象に、意図そのものを突き合わせる。
// 判定はモデルに任せるが、判定理由と衝突相手を必ず返させ、承認画面に出す。
// 誤検出だったときに代表が判断し直せるようにするため (自動棄却はしない)。
import { z } from "zod";
import {
  callAndParse,
  fillTemplate,
  getPrompt,
  registerExtraPrompt,
  type LLMClient,
} from "@kurimikan/shared";
import type { Store } from "../db/types.js";

export const INTENT_DEDUP_PROMPT_ID = "P-DUP";

const INTENT_DEDUP_PROMPT = `あなたはノーティックラボのSEO編集長です。新しい記事トピックの案が、既に公開している記事と「同じ検索意図」を奪い合わないかを判定してください。

<既存記事 (公開済み・制作中)>
{existing_articles}
</既存記事>

<判定するトピック案>
{proposals}
</判定するトピック案>

判定の基準は「読者がこのキーワードで検索したとき、既存記事を読めば用が足りるか」の一点です。

重複と判定する例:
- 「ホームページ リニューアル タイミング 見極め方」に対し、既存に
  「失敗しないホームページリニューアルの進め方 — タイミングの見極めと発注チェックリスト」がある。
  → 重複。「タイミング」と「いつ」、「見極め」と「進め方」は言い回しが違うだけで、
     読者が知りたいことも、答えるべき内容も同じ。
- 「ローカルビジネス GEO MEO 集客」に対し、既存に
  「MEO対策の始め方｜Googleビジネスプロフィール最適化5ステップ」がある。
  → 重複。語の重なりは小さいが、やることも読者も同じ。

重複と判定しない例 (過検出しないこと):
- 同じクラスタ・同じ題材でも、読者の段階や問いが違えば別記事の価値がある。
  「リニューアルの費用相場」と「リニューアルの失敗事例」は、どちらも
  リニューアルだが、片方は予算を決める人、片方は失敗を避けたい人の検索。
- 既存記事が題材に触れているだけで、その問いに正面から答えていない場合は重複ではない。

各トピック案について次を返してください:
- keyword: 判定対象のキーワード (入力のまま)
- duplicate: true / false
- conflicts_with: 重複する既存記事のタイトル。duplicate=false なら空文字
- reason: そう判断した理由 (1文)。duplicate=true のときは、
  既存記事のどの部分が同じ問いに答えているかを書く

<output_format>
{"verdicts":[{"keyword":"","duplicate":false,"conflicts_with":"","reason":""}]}
</output_format>`;

registerExtraPrompt(INTENT_DEDUP_PROMPT_ID, INTENT_DEDUP_PROMPT);

export const IntentDedupResult = z.object({
  verdicts: z.array(
    z.object({
      keyword: z.string(),
      duplicate: z.boolean(),
      conflicts_with: z.string().default(""),
      reason: z.string().default(""),
    }),
  ),
});

export interface IntentDedupDeps {
  store: Store;
  llm: LLMClient;
  suitePath: string;
}

export interface IntentVerdict {
  duplicate: boolean;
  conflictsWith: string;
  reason: string;
}

/** 判定対象。keyword と、その案が狙う検索意図。 */
export interface DedupCandidate {
  keyword: string;
  searchIntent: string;
}

/** 突き合わせ相手の既存記事。 */
export interface ExistingTopic {
  title: string;
  keyword: string;
}

/**
 * 検索意図が既存記事と重複する案を洗い出す。
 *
 * キーワード文字列をキーにした Map を返す。判定できなかったキーワードは Map に
 * 入らない (呼び出し側は「判定なし」として扱い、案を落とさない)。
 *
 * 落とせなかった案は代表の承認点に残るので、ここで取りこぼしても最終的な歯止めはある。
 * 逆にモデルの誤検出で正常な案を黙って消すほうが害が大きいため、
 * 例外時は空の Map を返して字面のふるいの結果だけを使う。
 */
export async function checkIntentDuplicates(
  deps: IntentDedupDeps,
  candidates: DedupCandidate[],
  existing: ExistingTopic[],
): Promise<Map<string, IntentVerdict>> {
  const out = new Map<string, IntentVerdict>();
  if (candidates.length === 0 || existing.length === 0) return out;

  const prompt = await getPrompt(
    INTENT_DEDUP_PROMPT_ID,
    deps.store.getPromptFromDb.bind(deps.store),
    deps.suitePath,
  );
  const parsed = await callAndParse(
    deps.llm,
    {
      promptId: INTENT_DEDUP_PROMPT_ID,
      user: fillTemplate(prompt, {
        existing_articles: JSON.stringify(
          existing.map((e) => ({ title: e.title, kw: e.keyword })),
        ),
        proposals: JSON.stringify(
          candidates.map((c) => ({ keyword: c.keyword, intent: c.searchIntent })),
        ),
      }),
      job: "judge",
    },
    IntentDedupResult,
  );

  for (const v of parsed.verdicts) {
    out.set(v.keyword, {
      duplicate: v.duplicate,
      conflictsWith: v.conflicts_with,
      reason: v.reason,
    });
  }
  return out;
}
