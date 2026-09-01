// 既存記事の改修バッチ。
// 公開済み記事 (articles.body_mdx) を P-13a診断 → P-13b改稿 → P-04ゲート で改修し、
// 全件を承認キュー (approval_pending) に積む。公開判断は常に人間。
// 承認されるとpublish workerが ShopifyPublisher 経由で articleUpdate を投げる。
//
// LLM改修の対象は本文品質 (検索意図・一次情報・コレクション導線・表記規則・法令) に絞る。
// title/metaの変更は既存順位保護のため行わない (SPEC: title_meta_updateは常に人間承認扱い)。
import {
  callAndParse,
  checkBudget,
  fillTemplate,
  getPrompt,
  P04Verdict,
  P13Plan,
  type LLMClient,
} from "@kurimikan/shared";
import type { ArticleRow, ArticleStatus, Store } from "../db/types.js";
import {
  assetForJudge,
  buildAssetInjectionBlock,
  isBetterVerdict,
  reconcileVerdict,
} from "../orchestrator/generate.js";
import { selectRelevantAssets } from "../quality/asset_selection.js";
import {
  checkNotation,
  mechanicalCheckReport,
  notationFixInstructions,
  sanitizeArticleBody,
  summarizeNotation,
} from "../quality/notation.js";

// 記事別の編集指示 (代表提供のファクトチェックに基づく)。
// data/editorial_directives.json 由来。公開情報のみ。
export interface EditorialDirective {
  corrections?: { topic?: string; wrong: string; correct: string; source?: string; severity?: string }[];
  removals?: { claim: string; action: string; reason?: string }[];
  citations?: { fact: string; source: string; theme?: string }[];
}

export interface RefitDeps {
  store: Store;
  llm: LLMClient;
  suitePath: string;
  budgetUsd: number;
  now?: () => Date;
  // slug別の編集指示。P-13a/P-13bに渡して誤り訂正・出典付与・削除を確実に反映させる
  directives?: Record<string, EditorialDirective>;
}

// 編集指示をプロンプトに差し込むブロックにする。空なら空文字。
export function buildDirectiveBlock(d: EditorialDirective | undefined): string {
  if (!d) return "";
  const parts: string[] = [];
  if (d.corrections?.length) {
    parts.push(
      "【誤りの訂正 (必須・そのまま直す)】\n" +
        d.corrections
          .map((c) => `- 「${c.wrong}」→「${c.correct}」${c.source ? `（出典: ${c.source}）` : ""}`)
          .join("\n"),
    );
  }
  if (d.citations?.length) {
    parts.push(
      "【出典の付与 (本文に該当主張があれば出典を明記。無ければ新たに追加しない)】\n" +
        d.citations.map((c) => `- ${c.fact}（出典: ${c.source}）`).join("\n"),
    );
  }
  if (d.removals?.length) {
    parts.push(
      "【削除・一般化 (裏が取れないため)】\n" +
        d.removals.map((r) => `- 「${r.claim}」: ${r.action}`).join("\n"),
    );
  }
  if (!parts.length) return "";
  return (
    "\n\n<編集指示>\n代表によるファクトチェックの結果、この記事には以下の編集を必ず反映すること。\n" +
    parts.join("\n\n") +
    "\n</編集指示>"
  );
}

// 改修の対象記事。
//
// nortiq版は公開先サイトの build.js (BLOG配列) を読んで対象を列挙していた。
// この案件では公開先がShopifyで、記事の正は articles.body_mdx にあるため、
// 対象はDBの公開済み記事から取る。ストアを1回も読まずに改修バッチを回せる。
export interface RefitEntry {
  articleId: string;
  slug: string;
  title: string;
  cluster: string;
  body: string;
  targetCollection?: string | null;
}

/** 公開済み記事を改修対象として列挙する。 */
export async function listRefitTargets(store: Store): Promise<RefitEntry[]> {
  const published = await store.listArticlesByStatus("published");
  const entries: RefitEntry[] = [];
  for (const a of published) {
    if (!a.slug || !a.title || !a.body_mdx) continue;
    const keyword = await store.getKeyword(a.keyword_id);
    entries.push({
      articleId: a.id,
      slug: a.slug,
      title: a.title,
      cluster: keyword?.cluster ?? "misc",
      body: a.body_mdx,
      targetCollection: keyword?.target_collection ?? null,
    });
  }
  return entries;
}

export const REFIT_CHECKLIST = `<refit_checklist>
v3改修チェックリスト (診断と改稿方針はこのチェックリストに基づくこと):
1. 検索意図充足: タイトルが示す問いに結論ファーストで答えているか。見出し直下1〜2文で結論を置く
2. 一次情報注入: new_primary_infoに使える資産があれば帰属付きで本文へ織り込む (なければ実装者視点の具体性を高める)
3. 内部リンク: 狙い先のコレクション (/collections/<品種>) への導線が最低1箇所あるか。アンカーテキストには品種名を必ず入れる (「こちら」は不可)。これ以外のパスは実在しないため使わない
3b. 法令: 効能効果 (免疫力アップ・疲労回復等)、根拠のない最上級 (日本一・最高級)、無農薬・減農薬・オーガニックの表記が残っていれば必ず消す
4. 表記規則: カタカナ語末尾の長音省略 (サーバ、ユーザ)、ダッシュ記号 (—、--) 不使用、敬体、1文60字目安
5. 構成: 記事末にFAQがなければ4〜6問追加。各段落は単独で引用されても意味が通る自己完結型に
注意: 見出し (H2) の文言と記事タイトルは変更しない (既存順位の保護)。新たな数値主張を導入しない
</refit_checklist>`;

export interface RefitResult {
  article: ArticleRow;
  planIssue: string;
}

export async function refitArticle(entry: RefitEntry, deps: RefitDeps): Promise<RefitResult> {
  const { store } = deps;
  checkBudget(await store.getMonthSpendUsd(deps.now?.() ?? new Date()), deps.budgetUsd);

  // API節約: 全自動時は改稿を1パスで打ち切る (generate.tsと同じ方針)。
  const fullAuto = (await store.getConfig<boolean>("full_auto_publish")) ?? false;
  const singlePass = fullAuto && ((await store.getConfig<boolean>("full_auto_single_pass")) ?? true);

  const originalBody = entry.body;
  const cluster = entry.cluster;

  let keyword = await store.findKeywordByName(`refit:${entry.slug}`);
  if (!keyword) {
    keyword = await store.createKeyword({
      keyword: `refit:${entry.slug}`,
      cluster,
      article_type: "howto",
      status: "done",
      source: "refit",
      // 改修でも狙い先は引き継ぐ。コレクション導線の検査に使う
      target_collection: entry.targetCollection ?? null,
    });
  }
  const article = await store.createArticle({
    keyword_id: keyword.id,
    article_type: "howto",
    lane: "A",
  });
  // 改修は既存URLの中身を直すだけで新規URLを増やさないため、
  // 週次目標と増速ゲートの対象外 (revisionトラック) にする。
  //
  // slugは設定しない。公開済みの記事がそれを握ったままにする必要があるため
  // (slugはunique制約付きで、改修案が奪うと公開中の記事のURLが宙に浮く)。
  // 対象は revision_of で指し、公開時にそこからslugとShopify記事IDを引き継ぐ
  await store.updateArticle(article.id, {
    title: entry.title,
    track: "revision",
    revision_of: entry.articleId,
  });

  // 資産はクラスタ一致だけでなく記事のトピック関連度で絞る。
  // クラスタ内の資産が増えると、無関係な資産が usage_count 順で上位に来て
  // 関連する資産を押し出すため (2026-07-30に実測、独自性が下がった)
  const assets = await selectRelevantAssets({
    store,
    llm: deps.llm,
    cluster,
    topic: entry.title,
    limit: 3,
    articleId: article.id,
  });
  const directiveBlock = buildDirectiveBlock(deps.directives?.[entry.slug]);
  const p13a = await getPrompt("P-13a", store.getPromptFromDb.bind(store), deps.suitePath);
  const plan = await callAndParse(
    deps.llm,
    {
      promptId: "P-13a",
      user:
        fillTemplate(p13a, {
          article_body: originalBody,
          main_keyword: entry.title,
          gsc_data: "未取得 (初回改修バッチ。GSCデータではなく改修チェックリストに基づき診断する)",
          primary_assets_new: JSON.stringify(
            assets.map((a) => ({ asset_id: a.id, title: a.title, description: a.description })),
          ),
        }) + `\n\n${REFIT_CHECKLIST}` + directiveBlock,
      job: "generation",
      articleId: article.id,
    },
    P13Plan,
  );

  const [p00, p13b, p04] = await Promise.all([
    getPrompt("P-00", store.getPromptFromDb.bind(store), deps.suitePath),
    getPrompt("P-13b", store.getPromptFromDb.bind(store), deps.suitePath),
    getPrompt("P-04", store.getPromptFromDb.bind(store), deps.suitePath),
  ]);
  const thresholds = (await store.getConfig<{ approve: number; hold: number }>(
    "quality_thresholds",
  )) ?? { approve: 85, hold: 70 };

  // P-13b改稿 → P-04ゲート。rejectなら fix_instructions を添えて1回だけ再改稿する。
  // 新規生成 (generateArticle) と揃える。改稿AIが1箇所ハルシネーションしただけで
  // 改修案ごと捨てると、Sprint 0の「29本を承認キューに揃える」が達成できないため。
  // base は改稿の下敷き。2周目は「元記事」ではなく「1周目の改稿結果」を渡す。
  // 元記事から書き直すと1周目の改善が丸ごと捨てられ、同じ弱点を作り直していた。
  const rewrite = async (fixes: string[], base: string): Promise<string> => {
    const fixBlock = fixes.length
      ? `\n\n<修正指示>\n直前の改稿は品質ゲートで基準に届きませんでした。以下を必ず反映すること。` +
        `本文の良くなっている箇所は保持し、指摘された箇所だけを直すこと。` +
        `出典を確認できない数値や実在しない製品・サービスは削除すること:\n- ${fixes.join("\n- ")}\n</修正指示>`
      : "";
    // 資産を本文に渡すだけでは具体的な数値・出典が織り込まれない (新規生成と同じ弱点)。
    // 検証済み数値と出典を明示し「出典付きで必ず織り込め」と強制する (buildAssetInjectionBlock)。
    const assetBlock = buildAssetInjectionBlock(assets);
    const rewritten = await deps.llm.call({
      promptId: "P-13b",
      system: p00,
      user:
        fillTemplate(p13b, {
          article_body: base,
          "P-13a出力（承認済み）": JSON.stringify(plan),
          "注入対象の資産本文": assets.map((a) => a.content).join("\n"),
        }) + assetBlock + directiveBlock + fixBlock,
      job: "generation",
      articleId: article.id,
    });
    // P-13bも ```mdx フェンス + フロントマターを付けて返すことがある (新規生成と同じ)
    return sanitizeArticleBody(rewritten.text);
  };
  const gate = async (body: string) => {
    const verdict = await callAndParse(
      deps.llm,
      {
        promptId: "P-04",
        user: fillTemplate(p04, {
          article_body: body,
          keyword: entry.title,
          search_intent_analysis: JSON.stringify({ note: "既存記事の改修 (タイトル維持)" }),
          existing_articles: JSON.stringify(await store.listArticleSummaries(article.id)),
          lane: "A",
          primary_info_used: JSON.stringify(assets.map(assetForJudge)),
          mechanical_check: mechanicalCheckReport(body),
        }),
        job: "gate",
        articleId: article.id,
      },
      P04Verdict,
    );
    // 新規生成と同じく、P-04の判定を quality_thresholds と突き合わせ厳しい方を採る
    return { ...verdict, verdict: reconcileVerdict(verdict, thresholds) };
  };

  // 表記・構造の機械チェック。新規生成と同じく、P-04に出す前にダッシュ等を決定論的に潰し、
  // 書き換えが要る違反は再改稿の修正指示に足す。
  const polish = (body: string) => {
    const result = checkNotation(body);
    console.log(`[notation] ${article.id} ${summarizeNotation(result)}`);
    return { body: result.body, fixes: notationFixInstructions(result.issues) };
  };

  // P-04の採点は同一記事でも合計点が幅7〜11ばらつく (実測σ≈3.5〜4.6)。
  // そのため (a) reject だけでなく hold でも1回は改善を試みる価値があり、
  // (b) 2周目が1周目より悪くなることも普通に起きるので、点の高い方を採る。
  // 以前は reject のときだけ再試行し、最も見込みの薄い側にだけ再試行を使っていた。
  const checked = polish(await rewrite([], originalBody));
  let best = { body: checked.body, verdict: await gate(checked.body) };
  if (best.verdict.verdict !== "approve" && !singlePass) {
    const retry = polish(
      await rewrite([...best.verdict.fix_instructions, ...checked.fixes], best.body),
    );
    const retryVerdict = await gate(retry.body);
    if (isBetterVerdict(retryVerdict, best.verdict)) {
      best = { body: retry.body, verdict: retryVerdict };
    } else {
      console.log(
        `[refit] 再改稿が改善しなかったため1周目を採用 ` +
          `(${retryVerdict.verdict}/${retryVerdict.scores.total} <= ${best.verdict.verdict}/${best.verdict.scores.total})`,
      );
    }
  }
  const newBody = best.body;
  const verdict = best.verdict;

  await store.updateArticle(article.id, {
    quality: verdict,
    quality_score: verdict.scores.total,
    hallucination_flags: verdict.hallucination_flags,
    commodity_score: verdict.commodity_score,
    body_mdx: newBody,
    word_count: newBody.replace(/\s/g, "").length,
    status:
      verdict.verdict === "approve"
        ? "approval_pending"
        : verdict.verdict === "hold"
          ? "gate_pending"
          : "rejected", // rejectでも既存記事は無傷 (改修案が捨てられるだけ)
  });
  return { article: (await store.getArticle(article.id))!, planIssue: plan.diagnosis.primary_issue };
}

export interface RefitBatchResult {
  processed: { slug: string; status: string }[];
  skipped: { slug: string; reason: string }[];
  discarded: { slug: string; articleId: string }[];
  failed: { slug: string; error: string }[];
}

// 改修が「完了」した状態 (再実行でスキップしてよい)。draftは途中でクラッシュした未完なので含めない。
const COMPLETED_REFIT: ArticleStatus[] = [
  "approval_pending",
  "gate_pending",
  "rejected",
  "approved",
  "scheduled",
  "published",
];

async function hasCompletedRefit(store: Store, originalId: string): Promise<boolean> {
  for (const status of COMPLETED_REFIT) {
    const rows = await store.listArticlesByStatus(status);
    if (rows.some((a) => a.revision_of === originalId)) return true;
  }
  return false;
}

// --redo で作り直しをブロックする状態。代表の判断が既に入っている / ライブに出ているもの。
// approved / scheduled は代表が承認済み (取消は管理画面から)、published はライブ。
// retired は「既に破棄済み」なのでブロックしない (むしろ作り直しの対象)。
const REDO_BLOCKED: ArticleStatus[] = ["approved", "scheduled", "published"];

// 全ステータス。REDO_BLOCKED以外はすべて破棄の対象にする。
const ALL_STATUSES: ArticleStatus[] = [
  "draft",
  "numeric_check",
  "gate_pending",
  "consensus",
  "approval_pending",
  "approved",
  "scheduled",
  "published",
  "rejected",
  "needs_rewrite",
  "retired",
];

// 未公開の改修案を破棄して作り直せるようにする。
// プロンプト修正の前に生成した下書きを、公開前なら捨てて再生成できる状態を保つための口。
//
// 判定の軸は slug ではなく revision_of。改修案はslugを持たず、対象の公開済み記事を
// 指しているだけなので、「同じ記事に対する未処理の改修案」を探して片付ける。
async function discardExistingDrafts(
  store: Store,
  originalId: string,
): Promise<{ discarded: string[]; blockedBy: ArticleStatus | null }> {
  // 同じ記事への改修案が承認済み・公開済み・スケジュール済みなら作り直さない
  for (const status of REDO_BLOCKED) {
    const rows = await store.listArticlesByStatus(status);
    if (rows.some((a) => a.revision_of === originalId)) return { discarded: [], blockedBy: status };
  }
  // それ以外の改修案はすべてretireする (冪等。失敗した作り直しの後始末も兼ねる)。
  //
  // retire済みの行も走査対象に含む (失敗した作り直しの後始末) ため、
  // 同じ行がステータス変更の前後で二度ヒットしうる。idで重複を除く
  const discarded = new Set<string>();
  for (const status of ALL_STATUSES.filter((s) => !REDO_BLOCKED.includes(s))) {
    const rows = await store.listArticlesByStatus(status);
    for (const a of rows.filter((r) => r.revision_of === originalId)) {
      if (discarded.has(a.id)) continue;
      await store.updateArticle(a.id, { status: "retired" });
      discarded.add(a.id);
    }
  }
  return { discarded: [...discarded], blockedBy: null };
}

export async function refitBatch(
  deps: RefitDeps,
  opts: { limit?: number; redo?: boolean; slugs?: string[] } = {},
): Promise<RefitBatchResult> {
  const all = await listRefitTargets(deps.store);
  // slug指定は、プロンプトや一次情報を変えた効果を1本で確かめるための入口。
  // 公開順に依存せず、狙った記事だけを回せるようにする。
  const entries = opts.slugs?.length ? all.filter((e) => opts.slugs!.includes(e.slug)) : all;
  const result: RefitBatchResult = { processed: [], skipped: [], discarded: [], failed: [] };
  for (const s of opts.slugs ?? []) {
    if (!all.some((e) => e.slug === s)) {
      result.skipped.push({ slug: s, reason: "slug_not_found_in_published_articles" });
    }
  }

  for (const entry of entries) {
    if (opts.limit !== undefined && result.processed.length >= opts.limit) break;

    // 完了済み (gate_pending/approval_pending/rejected等) は、--redoでない限りスキップ。
    // これにより通信断で途中停止したバッチを、再実行で「残りだけ」処理できる (レジューム)。
    // 未完のdraftはスキップ対象にしないので、クラッシュした記事は作り直される。
    const completed = await hasCompletedRefit(deps.store, entry.articleId);
    if (completed && !opts.redo) {
      result.skipped.push({ slug: entry.slug, reason: "already_refitted" });
      continue;
    }

    // slugを握る旧行 (未完draft・retired・--redo時は完了案も) を解放。
    // 承認済み/公開済みが握っていればブロックしてスキップ。
    const { discarded, blockedBy } = await discardExistingDrafts(deps.store, entry.articleId);
    if (blockedBy) {
      result.skipped.push({ slug: entry.slug, reason: `redo_blocked_${blockedBy}` });
      continue;
    }
    for (const id of discarded) result.discarded.push({ slug: entry.slug, articleId: id });

    // 1本の失敗 (通信断など) でバッチ全体を落とさない。記録して次へ進む。
    try {
      const { article } = await refitArticle(entry, deps);
      result.processed.push({ slug: entry.slug, status: article.status });
    } catch (e) {
      result.failed.push({ slug: entry.slug, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
