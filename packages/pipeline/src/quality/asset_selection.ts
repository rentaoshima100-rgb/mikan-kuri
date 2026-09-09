// 記事のトピックに関連する一次情報だけを選ぶ。
//
// これまでは listActiveAssetsByCluster(cluster, 3) で「クラスタが一致する資産のうち
// usage_count が小さい順に3件」を取っていた。資産が3件しかない間はたまたま機能したが、
// 資産を増やすとトピックと無関係な資産が上位に来て、関連する資産を押し出す。
//
// 実測 (2026-07-30): ai_llmoクラスタの資産を3件から12件に増やしたところ、
// 「LLMO対策の基本」の改修に対して VetoNet(AIガードレール) と設計レビュー方法論が選ばれ、
// 本来関連する「自社ブログツールの制作実測」が4位で切られた。結果、注入した3件は
// 本文に1度も現れず、uniqueness 13→10 / eeat 10→8 と改修前より悪化した。
// 資産を足すほど品質が下がる状態だったため、選択をトピック関連度に変える。
//
// 判定は分類系の安いモデルで行い、失敗時は従来どおりの順序にフォールバックする
// (資産選択で記事生成全体を落とさない)。
import type { LLMClient } from "@kurimikan/shared";
import type { PrimaryAssetRow, Store } from "../db/types.js";

// 関連度判定にかける候補の上限。クラスタ内の資産が増えてもプロンプトが膨らみすぎないようにする
const CANDIDATE_POOL = 30;

export interface SelectAssetsInput {
  store: Store;
  llm: LLMClient;
  cluster: string;
  // 記事のトピック (キーワード or 既存記事タイトル)
  topic: string;
  limit: number;
  articleId?: string;
  // 有効期限の判定基準日 (省略時は現在)。期限切れの一次情報は候補に入らない
  asOf?: Date;
}

function parseIndexes(text: string, max: number): number[] {
  const m = /\[[\s\S]*?\]/.exec(text);
  if (!m) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return [
    ...new Set(
      parsed
        .map((n) => (typeof n === "number" ? n : Number(n)))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < max),
    ),
  ];
}

export async function selectRelevantAssets(input: SelectAssetsInput): Promise<PrimaryAssetRow[]> {
  const { store, llm, cluster, topic, limit, articleId, asOf } = input;
  const pool = await store.listActiveAssetsByCluster(cluster, CANDIDATE_POOL, asOf);
  // 候補が枠に収まるなら選ぶ余地がない。LLMを呼ばずそのまま返す
  if (pool.length <= limit) return pool;

  const catalog = pool
    .map((a, i) => `${i}. ${a.title}\n   ${a.description ?? ""}`)
    .join("\n");
  // 語の重なりで選ばせない。ai_llmoクラスタには「AI検索最適化(LLMO)」と
  // 「AIエージェントのガードレール」のように、同じ「AI」を含むが主題が別物の資産が同居する。
  // 実測 (2026-07-30) では、LLMO対策の記事にAIガードレールの資産が3件とも選ばれた。
  const user =
    `記事に一次情報として織り込める資産を選びます。\n\n` +
    `記事のトピック: ${topic}\n\n` +
    `資産一覧:\n${catalog}\n\n` +
    `判定の基準:\n` +
    `- この記事を読む読者が知りたいことに、その資産が直接答えるか\n` +
    `- 資産の数値や事実を、この記事の本文中で自然に引用できるか\n` +
    `- 単語が共通なだけでは関連とみなさない。` +
    `例: 「AI検索での見つかりやすさ」の記事に「AIエージェントの安全性」の資産は無関係。` +
    `どちらも「AI」を含むが読者の知りたいことが別\n` +
    `- 迷ったら選ばない。無関係な資産を渡すと本文に織り込めず、かえって記事が薄くなる\n\n` +
    `関連が強い順に最大${limit}件、番号のJSON配列だけを出力してください (例: [3,0])。` +
    `該当なしなら [] を出力してください。件数を埋める必要はありません。`;

  let picked: number[];
  try {
    const res = await llm.call({ promptId: "asset-selection", user, job: "classify", articleId });
    picked = parseIndexes(res.text, pool.length);
  } catch {
    // 判定そのものが落ちた場合は従来の順序に退避する (資産選択で記事生成を止めない)
    return pool.slice(0, limit);
  }
  // 「関連なし ([])」はLLMの正当な答えなので尊重する。無関係な資産で枠を埋めると
  // 本文に織り込めない資産が注入され、かえって独自性が下がる (今回の実測がそれ)
  return picked.slice(0, limit).map((i) => pool[i]!);
}
