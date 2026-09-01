// キーワード発案器 (v3 Sprint 1: 「システムがネタを持ってくる」の核)。
//
// クラスタ配分と既存記事の穴から、新しいトピック案をクラスタ別に提案する。
// 提案は keywords テーブルに status='proposed' で入り、代表が管理画面で承認して
// 初めて 'queued' (記事化対象) になる。これがトピック段階の承認点。
// 記事の公開承認は別途必要で、自動公開は存在しない (v3絶対ルール)。
//
// 計測 (GSC/GA4) には依存しない。既存記事とクラスタ設計だけで穴を埋める提案をする。
// 計測を使った優先度調整・リライト指名は月次戦略エージェント (P-16) の役割で、別実装。
import { z } from "zod";
import {
  callAndParse,
  fillTemplate,
  getPrompt,
  registerExtraPrompt,
  type LLMClient,
} from "@kurimikan/shared";
import type { KeywordRow, PrimaryAssetRow, Store } from "../db/types.js";
import {
  checkIntentDuplicates,
  type ExistingTopic,
  type IntentVerdict,
} from "./intent_dedup.js";

export const KEYWORD_PROPOSAL_PROMPT_ID = "P-KW";

// DBに P-KW 行があればそちらが優先される (EXTRA_PROMPTSはフォールバック)。P-SERPと同じ扱い。
const KEYWORD_PROPOSAL_PROMPT = `あなたはノーティックラボのSEO編集長です。既存記事の「穴」を埋める新しい記事トピックを提案してください。

<既存記事>
{existing_articles}
</既存記事>

<いま手元にある一次情報 (これが独自性の源)>
{primary_info_inventory}
</いま手元にある一次情報>

<クラスタ配分と方針>
{allocation}
リニューアル系クラスタの設計例: 費用 / 補助金 / 進め方 / 失敗 / リダイレクト・URL移行 / タイミング / 業種別。
既存記事が既に押さえているトピックは提案しない (カニバリゼーション回避)。検索意図が既存と重複しないこと。
</クラスタ配分と方針>

<対象クラスタ>
{target_cluster}
</対象クラスタ>

提案の条件:
- 既存記事とタイトル・検索意図が重複しないトピックに限る (穴を埋める)
- 中小企業のWeb制作/リニューアル/AI活用の実務に直結する検索意図であること
- **上の一次情報の在庫から、少なくとも1件を本文の主役にできるトピックを優先すること**。
  実測では、主題に直結する自社データを持つ記事だけが独自性で高い評価を得ており、
  在庫に無い主題の記事は一般論の域を出ない。手持ちの数値が答えになる問いを探す
- rationale には、どの一次情報 (タイトル) を主役に据えるつもりかを必ず書くこと。
  在庫のどれも使えないトピックは、独自性を出せないので提案しない
- 誇張・煽りのタイトルにしない。表記規則: カタカナ語末尾の長音省略 (サーバ/ユーザ)、ダッシュ記号不使用、敬体

各提案について:
- keyword: 検索キーワード (例: ホームページ リニューアル 費用 相場)
- article_type: howto / comparison / pricing / case_study / subsidy / public_data のいずれか
- search_intent: 読者が何を知りたくて検索するか (1文)
- priority: 0-100。検索需要と当社の独自性の出しやすさで判断
- rationale: なぜ今このネタか。既存記事のどの穴を埋めるか (1文)

{count}件、JSONで出力してください。

<output_format>
{"proposals":[{"keyword":"","cluster":"","article_type":"","search_intent":"","priority":0,"rationale":""}]}
</output_format>`;

registerExtraPrompt(KEYWORD_PROPOSAL_PROMPT_ID, KEYWORD_PROPOSAL_PROMPT);

const CLUSTERS = ["renewal", "production", "system_dev", "ai_llmo"] as const;
const ARTICLE_TYPES = [
  "howto",
  "comparison",
  "pricing",
  "case_study",
  "subsidy",
  "public_data",
] as const;

export const KeywordProposal = z.object({
  proposals: z.array(
    z.object({
      keyword: z.string().min(1),
      cluster: z.enum(CLUSTERS),
      article_type: z.enum(ARTICLE_TYPES),
      search_intent: z.string(),
      priority: z.number().min(0).max(100),
      rationale: z.string(),
    }),
  ),
});

export interface ProposeKeywordsDeps {
  store: Store;
  llm: LLMClient;
  suitePath: string;
  // 任意: DataForSEO等で実検索ボリュームを引く。あれば優先度を実需要で裏付ける。
  volumeLookup?: (keywords: string[]) => Promise<Record<string, { volume: number }>>;
  // 任意: サイトに公開済みだがDBが追跡していない記事。重複判定の相手に加える。
  //
  // articles テーブルが持っているのはパイプラインが作った記事だけで、
  // 2026-08-02 時点でサイトの35本に対しDB追跡は14本。残り21本は
  // パイプライン以前に書かれたもので、重複判定から完全に見えていなかった。
  // カニバリを起こした「失敗しないホームページリニューアルの進め方」も
  // この21本の側にある。build.js の BLOG 配列から補って渡す。
  extraExistingTopics?: ExistingTopic[];
}

export interface ProposeResult {
  proposed: KeywordRow[];
  skipped: { keyword: string; reason: string }[];
  // 重複判定の相手にした既存記事の本数。サイトの公開本数より少ないなら、
  // その差の分だけカニバリを見逃しうる。呼び出し側で必ず出すこと
  comparedAgainst: number;
}

// 正規化して重複判定に使う (全角/半角・空白ゆれを吸収)
const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

// 近い意味のキーワードを弾くための類似度。
//
// 完全一致だけを見ていたため、語順や複合語の切れ目が違うだけの重複がすり抜けていた。
// 2026-07-31に実際に2組が承認キューまで届いた:
//   「iOS NFC FeliCa 読み取り 遅い 原因」 と 「iOS FeliCa 読み取り 遅い 原因」
//   「社内システム 外注 費用 相場 中小企業」 と 「社内 システム開発 外注 費用 中小企業」
// どちらも同じ検索意図で、両方書くと自分同士で順位を食い合う。
//
// 日本語は分かち書きしないので単語単位では比較できない。空白を潰した文字列の
// 2文字組 (bigram) の重なりで測る。これなら「社内システム」と「社内 システム開発」の
// ような複合語の切れ目の違いも拾える。
export function bigrams(s: string): Set<string> {
  const t = norm(s);
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

export function similarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / (A.size + B.size - hit); // Jaccard
}

// この値以上を「ほぼ同じ言い換え」とみなす。
//
// 重要: この指標は重複判定の決め手にはできない。実測値を並べると2つの階級が重なる:
//
//   重複している組              別物の組
//   0.750 iOS NFC FeliCa 系      0.550 リニューアル費用 / リニューアル進め方
//   0.579 社内システム外注 系     0.478 リニューアル費用 / リニューアル失敗事例
//   0.500 リニューアルの時期 系   0.000 リニューアル費用 / AIチャットボット
//   0.167 MEO / GEO 系           0.000 CMS比較 / FeliCa
//
// 別物の 0.550 が、重複の 0.500 と 0.167 より高い。どこにしきい値を置いても
// 取りこぼしと過検出が同時に起きる。字面の重なりでは分離できない問題であって、
// 調整の余地がないことを測って確かめた (再調整しないこと)。
//
// そのため役割を「同じ語を並べ替えただけの案を、LLM呼び出し前に安く落とす」に限定し、
// 判定の本体は intent_dedup.ts の意図照合に任せる。0.70 は観測された別物の最大値
// 0.550 より十分上、拾いたい 0.750 より下に置いた。
export const SIMILARITY_THRESHOLD = 0.7;

// 類似する既存キーワードを返す (無ければ null)。判定理由に出せるよう相手を返す。
export function findSimilar(keyword: string, existing: Iterable<string>): string | null {
  let best: { kw: string; score: number } | null = null;
  for (const e of existing) {
    if (!e) continue;
    const score = similarity(keyword, e);
    if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) best = { kw: e, score };
  }
  return best?.kw ?? null;
}

// 発案プロンプトに渡す一次情報の在庫。
// P-KWは「一次情報で独自性を出せるネタを」と指示しながら、どんな一次情報が実在するかを
// 一度も渡していなかったため、モデルは在庫を想像で補うしかなかった。
// 実測では、主題に直結する自社資産を持つ記事だけが uniqueness 17〜18 に届き、
// 資産の無い主題の記事は 8〜12 に留まっている。在庫を見せて、勝てる主題を選ばせる。
export function buildAssetInventory(assets: PrimaryAssetRow[]): string {
  if (assets.length === 0) return "(現在、使える一次情報がありません)";
  return assets
    .map((a) => {
      const claims = (Array.isArray(a.numeric_claims) ? a.numeric_claims : [])
        .map((c) => c as { claim?: string; value?: string; unit?: string })
        .filter((c) => c.claim)
        .map((c) => `${c.claim} ${c.value ?? ""}${c.unit ?? ""}`)
        .slice(0, 4)
        .join(" / ");
      const clusters = (a.applicable_clusters ?? []).join(",");
      return (
        `- 「${a.title}」[${clusters}]\n` +
        `  ${a.description ?? ""}\n` +
        (claims ? `  持っている数値: ${claims}` : "  持っている数値: なし (定性的な知見のみ)")
      );
    })
    .join("\n");
}

export async function proposeKeywords(
  deps: ProposeKeywordsDeps,
  opts: { cluster?: (typeof CLUSTERS)[number]; count?: number } = {},
): Promise<ProposeResult> {
  const { store, llm } = deps;
  const count = opts.count ?? 8;

  const summaries = await store.listArticleSummaries();
  const allocation =
    (await store.getConfig<Record<string, number>>("cluster_allocation")) ?? {};
  // 全クラスタの資産を集める (発案は主題を横断して探すため、クラスタで絞らない)
  const assetsByCluster = await Promise.all(
    CLUSTERS.map((c) => store.listActiveAssetsByCluster(c, 50)),
  );
  const inventory = buildAssetInventory(
    [...new Map(assetsByCluster.flat().map((a) => [a.id, a])).values()],
  );

  const prompt = await getPrompt(
    KEYWORD_PROPOSAL_PROMPT_ID,
    store.getPromptFromDb.bind(store),
    deps.suitePath,
  );
  const parsed = await callAndParse(
    llm,
    {
      promptId: KEYWORD_PROPOSAL_PROMPT_ID,
      user: fillTemplate(prompt, {
        existing_articles: JSON.stringify(summaries.map((s) => ({ title: s.title, kw: s.keyword }))),
        allocation: JSON.stringify(allocation),
        primary_info_inventory: inventory,
        target_cluster: opts.cluster ?? "全クラスタ (配分に応じてバランスよく)",
        count: String(count),
      }),
      job: "generation",
    },
    KeywordProposal,
  );

  // 実検索ボリュームで裏付ける (任意)。提案キーワードを一括で引く。
  let volumes: Record<string, { volume: number }> = {};
  if (deps.volumeLookup) {
    try {
      volumes = await deps.volumeLookup(parsed.proposals.map((p) => p.keyword));
    } catch {
      volumes = {}; // 需要データが取れなくても発案は続ける
    }
  }

  // 既存キーワード・既存記事タイトルと重複するものは弾く (カニバリ回避を機械側でも担保)
  const existingKw = new Set(summaries.map((s) => norm(s.keyword)).filter(Boolean));
  const existingTitle = new Set(summaries.map((s) => norm(s.title)).filter(Boolean));
  // 類似判定は正規化前の文字列で行う (bigramは内部で正規化する)。
  // 記事化待ち・実行中のキーワードも相手に含める。承認済みだが未着手のものと
  // 重複した提案が積み上がるのを防ぐ
  const pending = (
    await Promise.all(
      (["proposed", "queued", "in_progress"] as const).map((st) => store.listKeywordsByStatus(st)),
    )
  ).flat();
  const allKeywordTexts = [
    ...summaries.map((s) => s.keyword),
    ...summaries.map((s) => s.title),
    ...pending.map((k) => k.keyword),
  ].filter((t): t is string => Boolean(t) && !t.startsWith("refit:"));
  const seenThisRunText: string[] = [];
  const result: ProposeResult = { proposed: [], skipped: [], comparedAgainst: 0 };
  const seenThisRun = new Set<string>();
  // 字面のふるいを通った案。この後まとめて意図照合にかけてから登録する。
  // 1件ずつ登録していた頃は、照合のためのLLM呼び出しが提案数だけ走っていた。
  const survivors: typeof parsed.proposals = [];

  for (const p of parsed.proposals) {
    const key = norm(p.keyword);
    if (opts.cluster && p.cluster !== opts.cluster) {
      result.skipped.push({ keyword: p.keyword, reason: `対象クラスタ外 (${p.cluster})` });
      continue;
    }
    if (existingKw.has(key) || existingTitle.has(key) || seenThisRun.has(key)) {
      result.skipped.push({ keyword: p.keyword, reason: "既存/重複" });
      continue;
    }
    // 同じ語を並べ替えただけの案をここで落とす (意図照合のLLM呼び出しを節約する)。
    // 言い回しの違う重複はここでは捕まらない。それは下の意図照合の担当。
    const similar = findSimilar(p.keyword, [...allKeywordTexts, ...seenThisRunText]);
    if (similar) {
      result.skipped.push({ keyword: p.keyword, reason: `類似あり: 「${similar}」` });
      continue;
    }
    if (await store.findKeywordByName(p.keyword)) {
      result.skipped.push({ keyword: p.keyword, reason: "キーワード既登録" });
      continue;
    }
    seenThisRun.add(key);
    seenThisRunText.push(p.keyword);

    survivors.push(p);
  }

  // 字面では別物に見えるが検索意図が同じ案を、ここで落とす。
  //
  // similarity() は bigram の重なりしか見ないため、実測で
  //   0.500「リニューアル タイミング 見極め方」vs「リニューアル 進め方 失敗」
  //   0.167「Googleビジネスプロフィール MEO 最適化」vs「ローカルビジネス GEO MEO 集客」
  // のように、同じ意図でもしきい値 0.55 に届かない組が通ってしまう。
  // しきい値を下げると正常な案まで巻き込むので、意図そのものを突き合わせる。
  //
  // 相手はDB追跡分だけでは足りない。サイトに出ている記事を漏れなく渡すこと
  // (extraExistingTopics の項を参照)。
  const knownTitles = new Set(summaries.map((s) => norm(s.title)).filter(Boolean));
  // DB外の記事 (店舗が手で投稿したお知らせ等) は呼び出し側が渡す。
  // 渡されなければDB追跡分だけが相手になる
  const extra = deps.extraExistingTopics ?? [];
  const existingTopics: ExistingTopic[] = [
    ...summaries.map((s) => ({ title: s.title, keyword: s.keyword })),
    ...extra.filter((t) => t.title && !knownTitles.has(norm(t.title))),
  ];
  result.comparedAgainst = existingTopics.length;
  // 記事化待ちのキーワードも意図照合の相手に入れる。字面のふるい (findSimilar) には
  // 既に入っているが、意図照合に入っていなかったため「昨日queuedになったトピック」と
  // 言い回しだけ違う同意図の案が翌日すり抜けていた。記事になってからでは、
  // 全自動時はどちらも公開されてしまう。
  const pendingTopics: ExistingTopic[] = pending
    .filter((k) => !k.keyword.startsWith("refit:"))
    .map((k) => ({ title: k.keyword, keyword: k.keyword }));
  let verdicts = new Map<string, IntentVerdict>();
  // 「照合に失敗した」と「照合する相手がいなかった」は別物。
  // 前者だけ人の目視確認を促す。相手0本で印を付けると、意味のない警告が常時出る
  let dedupFailed = false;
  try {
    verdicts = await checkIntentDuplicates(
      deps,
      survivors.map((p) => ({ keyword: p.keyword, searchIntent: p.search_intent })),
      [...existingTopics, ...pendingTopics],
    );
  } catch {
    // 全自動公開中はフェイルクローズド (代表指示 2026-08-14)。印付きで登録しても
    // autoQueueTopics が無条件に記事化するため、印は誰にも読まれずそのまま公開される。
    // この回は登録せず、次回の発案でやり直す (発案は毎日走るので取りこぼしは翌日拾われる)。
    const fullAuto = (await store.getConfig<boolean>("full_auto_publish")) ?? false;
    if (fullAuto) {
      for (const p of survivors) {
        result.skipped.push({
          keyword: p.keyword,
          reason: "意図照合できず (全自動公開中はフェイルクローズドで登録しない)",
        });
      }
      return result;
    }
    // 承認制では発案を止めない。落とせなかった案は代表の承認点に残るので、
    // 最終的な歯止めはある。黙って通すのは避けたいので rationale に印を残す。
    verdicts = new Map();
    dedupFailed = true;
  }

  for (const p of survivors) {
    const v = verdicts.get(p.keyword);
    if (v?.duplicate) {
      const rel = v.conflictsWith ? `「${v.conflictsWith}」` : "既存記事";
      result.skipped.push({ keyword: p.keyword, reason: `検索意図が${rel}と重複: ${v.reason}` });
      continue;
    }

    // 検索ボリュームがあれば、LLMの優先度と需要スコアの平均を取り、理由に月間検索数を添える
    const vol = volumes[p.keyword]?.volume;
    let priority = p.priority;
    let rationale = p.rationale;
    if (vol != null) {
      const demandScore = vol <= 0 ? 0 : Math.min(100, Math.round((Math.log10(vol) / 5) * 100));
      priority = Math.round((p.priority + demandScore) / 2);
      rationale = `月間検索${vol}回。${p.rationale}`;
    }
    if (dedupFailed) rationale = `[意図照合できず: 既存との重複を目視で確認してください] ${rationale}`;

    const row = await store.createKeyword({
      keyword: p.keyword,
      cluster: p.cluster,
      article_type: p.article_type,
      search_intent: p.search_intent,
      priority,
      status: "proposed", // 代表の承認で 'queued' になる
      source: "strategy_agent",
      rationale,
    });
    result.proposed.push(row);
  }
  return result;
}
