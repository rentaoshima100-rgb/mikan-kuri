// プロンプトローダ (SPEC M1 prompts.ts)。
// promptsテーブル優先、なければリポジトリのsuiteファイルにフォールバック。
//
// nortiq版はv1のプロンプト集にv3の差分パッチを実行時に当てていたが、
// この案件のプロンプト集は最初から確定版を書いてあるのでパッチ層はない。
import { parseSuiteFile, type ParsedPrompt } from "./prompt_suite/parse.js";

export type DbPromptGetter = (id: string) => Promise<string | null>;

let suiteCache: Map<string, string> | null = null;
let suiteCachePath: string | null = null;

export function loadSuitePrompts(suitePath: string): Map<string, string> {
  if (suiteCache && suiteCachePath === suitePath) return suiteCache;
  const prompts: ParsedPrompt[] = parseSuiteFile(suitePath);
  suiteCache = new Map(prompts.map((p) => [p.id, p.body]));
  suiteCachePath = suitePath;
  return suiteCache;
}

// プロンプト集に無い、実装側が後から足したプロンプトの既定文 (P-DUP等)。
// SPECの絶対要件6「プロンプトはDB管理 (tier1自己改修の対象)」を満たすため、
// コードに直書きせずここに集約し、DBに同IDの行があればそちらが優先される。
// seedスクリプトがDBへ投入するので、運用開始後は管理画面/SQLから調整できる。
export const EXTRA_PROMPTS: Record<string, string> = {};

export function registerExtraPrompt(id: string, body: string): void {
  EXTRA_PROMPTS[id] = body;
}

export async function getPrompt(
  id: string,
  dbGet: DbPromptGetter | null,
  suitePath: string,
): Promise<string> {
  if (dbGet) {
    const fromDb = await dbGet(id);
    if (fromDb) return fromDb;
  }
  // suitePathが未指定の呼び出し (suite外プロンプトのみを使う経路) では読みに行かない
  const fromSuite = suitePath ? loadSuitePrompts(suitePath).get(id) : undefined;
  if (fromSuite) return fromSuite;
  const extra = EXTRA_PROMPTS[id];
  if (extra) return extra;
  throw new Error(`プロンプトが見つかりません: ${id}`);
}

// {var} プレースホルダの充填。渡されたキーのみ置換する (JSON例中の{...}は壊さない)
export function fillTemplate(body: string, vars: Record<string, string>): string {
  let out = body;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${key}}`, value);
  }
  return out;
}

// 記事タイプ → P-03アドオンID
export const ARTICLE_TYPE_ADDON: Record<string, string> = {
  howto: "P-03a", // 保存方法・むき方・選び方
  comparison: "P-03b", // 品種比較
  pricing: "P-03c", // 価格・相場・予算
  grower: "P-03d", // 生産者・畑・栽培 (一次情報が主役)
  gift: "P-03e", // ギフト・贈答マナー
  season: "P-03f", // 旬・収穫時期
  recipe: "P-03g", // レシピ・食べ方
};
