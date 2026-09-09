// M2 生成オーケストレータ (SPEC M2 + v3差分)。
// v3差分:
//   - 手順10: publish_queueへは入れない。全記事 status=approval_pending で承認キューへ。
//     scheduled_atは承認時 (approvals.approveArticle) に自動割当
//   - P-05合議: 2系統judgeの不一致は自動棄却も自動通過もせず judge_disagreement フラグで
//     人間エスカレーション。自動除去は「2系統が一致して不可」と判定した数値主張のみ (P-06)
import {
  ARTICLE_TYPE_ADDON,
  callAndParse,
  checkBudget,
  fillTemplate,
  getPrompt,
  P01Outline,
  P04Verdict,
  P05Claims,
  P05Verdicts,
  P06Changelog,
  P11Links,
  P12TitleMeta,
  SLUG_PATTERN,
  stripCodeFence,
  type LLMClient,
  type P01OutlineT,
  type P04VerdictT,
  type P05ClaimsT,
  type P05VerdictsT,
  type P12TitleMetaT,
} from "@kurimikan/shared";
import type { ArticleRow, KeywordRow, PrimaryAssetRow, Store } from "../db/types.js";
import { attachSerpToReviewNotes, runSerpCheck } from "../serp/serp_check.js";
import { selectRelevantAssets } from "../quality/asset_selection.js";
import {
  checkTopicDuplicate,
  collectExistingTopics,
  findTitleDuplicate,
  type DuplicateGateDeps,
} from "../quality/duplicate_gate.js";
import {
  checkNotation,
  mechanicalCheckReport,
  notationFixInstructions,
  sanitizeArticleBody,
  summarizeNotation,
} from "../quality/notation.js";
import {
  checkCompliance,
  summarizeCompliance,
  type ComplianceReport,
} from "../quality/compliance_gate.js";
import {
  buildCollectionCta,
  checkCollectionLink,
  collectionPath,
  isAllowedInternalTarget,
  resolveCollection,
  type CollectionMap,
} from "../quality/collection_link.js";

export interface OrchestratorDeps {
  store: Store;
  llm: LLMClient;
  suitePath: string;
  budgetUsd: number;
  now?: () => Date;
  // SERP差分チェック (v3追加。自動棄却には使わず承認者への参考情報のみ)
  serpFetch?: typeof fetch;
  // 重複ゲートの判定相手に、DBが追跡していない記事 (店舗が手で投稿したお知らせ等) を加える。
  // Shopifyから引く実装は site_integration/shopify/topics.ts
  extraTopics?: DuplicateGateDeps["extraTopics"];
}

const CHANGELOG_SEP = "=====CHANGELOG=====";

// リンク先の許否は quality/collection_link.ts (Shopifyのストア構造) が持つ。
// ここから再輸出するのは、既存の呼び出し側とテストの参照先を変えないため
export { isAllowedInternalTarget };

// P-11に渡す「実在するリンク先」。コレクション一覧はconfigから組み立てる。
// 存在しないパスを渡すとP-11がそれを選び、本文に404リンクが自動挿入される
export async function linkableSitePages(store: Store): Promise<string[]> {
  const collections = (await store.getConfig<CollectionMap>("collections")) ?? {};
  const fixed = (await store.getConfig<string[]>("linkable_pages")) ?? [];
  return [...Object.keys(collections).map(collectionPath), ...fixed];
}

export async function generateArticle(
  keywordId: string,
  deps: OrchestratorDeps,
): Promise<ArticleRow> {
  const { store } = deps;

  // 全自動公開 (代表判断でv3の全記事承認制を上書き。CLAUDE.md v3訂正表)。
  // trueのとき、品質ゲート (P-04/合議) の reject/hold で停止せず仕上げまで進める。
  // これは「品質ゲート」のバイパスのみ。構造的な却下 (相場記事の凍結=法務ホールド、
  // レーンB非許可の記事タイプ、lane_b_eligible=false=本文が生成されない) は対象外。
  const fullAuto = (await store.getConfig<boolean>("full_auto_publish")) ?? false;

  // API節約: 全自動時は生成を1パスで打ち切る (approve未満の2周目フル再生成は、
  // 結果に関わらず公開する全自動ではほぼ無駄)。full_auto_single_pass=false で従来の2周に戻せる。
  const singlePass = fullAuto && ((await store.getConfig<boolean>("full_auto_single_pass")) ?? true);

  // 予算ガード: 100%でBudgetExceededError (生成系停止)
  checkBudget(await store.getMonthSpendUsd(deps.now?.() ?? new Date()), deps.budgetUsd);

  const keyword = await store.getKeyword(keywordId);
  if (!keyword) throw new Error(`keyword not found: ${keywordId}`);

  // 重複ハードゲート (代表指示 2026-08-14: 同じ内容の記事を二度公開しない)。
  // トークンを使う前に、既存記事 (DB + サイト公開済み) と同じ内容にならないかを判定する。
  // 改修 (refit:) は既存記事の更新なので対象外。
  // LLM照合が失敗したとき、全自動中はフェイルクローズド (例外→キーワードはqueuedのまま
  // 次回再試行)、承認制では警告のみで続行する (代表の承認が最後の歯止めに残るため)。
  if (!keyword.keyword.startsWith("refit:")) {
    const dup = await checkTopicDuplicate(
      { store, llm: deps.llm, suitePath: deps.suitePath, extraTopics: deps.extraTopics },
      { keyword: keyword.keyword, searchIntent: keyword.search_intent },
      { failClosed: fullAuto },
    );
    if (dup.duplicate) {
      await store.updateKeywordStatus(keywordId, "in_progress");
      const article = await store.createArticle({
        keyword_id: keyword.id,
        article_type: keyword.article_type,
        lane: keyword.assigned_lane ?? "A",
      });
      return reject(deps, article, keyword, `重複ゲート (生成前): ${dup.reason}`);
    }
  }

  await store.updateKeywordStatus(keywordId, "in_progress");

  const lane = keyword.assigned_lane ?? "A";
  const article = await store.createArticle({
    keyword_id: keyword.id,
    article_type: keyword.article_type,
    lane,
  });

  // 提案ログ由来の相場記事はプラットフォーム規約の書面照会が完了するまで凍結 (v3 1-8)。
  // レーンに関係なく機械的に止める (プロンプト側の自主規制だけに頼らない)
  if (keyword.article_type === "market_report") {
    const enabled = await store.getConfig<boolean>("proposal_log_articles_enabled");
    if (enabled !== true) {
      return reject(
        deps,
        article,
        keyword,
        "提案ログ由来の相場記事は凍結中 (proposal_log_articles_enabled=false)",
      );
    }
  }

  // この案件の記事は「どれかのコレクションを押し上げるため」に書く。
  // 狙い先の無い記事は成果を測る先が無く、内部リンクの集中も起きないので仕様上あり得ない。
  // 承認キューに乗せてから気づいても手遅れなので、トークンを使う前に落とす
  const requireCollection = (await store.getConfig<boolean>("require_target_collection")) ?? true;
  if (requireCollection && !keyword.target_collection) {
    return reject(
      deps,
      article,
      keyword,
      "target_collection が未設定です。押し上げるコレクションを決めてから記事化してください",
    );
  }

  // レーンBはlane_b_allowed_typesの記事タイプのみ (SPEC T2-1の制限を安全側で最初から適用)
  if (lane === "B") {
    const allowed = (await store.getConfig<string[]>("lane_b_allowed_types")) ?? [];
    if (!allowed.includes(keyword.article_type)) {
      return reject(deps, article, keyword, `レーンB非許可の記事タイプ: ${keyword.article_type}`);
    }
  }

  // P-01 構成生成。資産はクラスタ一致だけでなくトピック関連度で絞る
  // (無関係な資産を注入すると本文に織り込まれず独自性が下がる)
  const assets = await selectRelevantAssets({
    store,
    llm: deps.llm,
    cluster: keyword.cluster,
    topic: keyword.keyword,
    limit: 3,
    articleId: article.id,
    asOf: deps.now?.(),
  });

  // クラウド下書き (代表指示 2026-08-20): サブスク側のClaude Codeルーチンが
  // リサーチ+執筆済みの下書きを置いていれば、P-01/P-02 (APIコストの大半) を省略して使う。
  // 差し替わるのは「アウトラインと本文の出どころ」だけで、この先の品質ゲート・
  // 表記チェック・仕上げ・重複ゲート・公開フローは従来とまったく同じ経路を通る。
  // 下書きが無い/壊れている場合は従来のAPI経路 (下のrunOutline+writeSections) に落ちる。
  const draft = await loadCloudDraft(store, keyword.id, article.id);
  const outline = draft?.outline ?? (await runOutline(deps, keyword, lane, assets, article.id));
  await store.updateArticle(article.id, { outline });

  if (lane === "B" && !outline.lane_b_eligible) {
    return reject(deps, article, keyword, `lane_b_eligible=false: ${outline.lane_b_reason ?? ""}`);
  }

  // 1回目の生成 → (B: P-06) → P-04。rejectなら fix_instructions を添えて1回だけ再生成。
  // 機械チェックの検出分もP-04の指示に足す (LLMの講評だけだと表記違反が残り続けるため)
  // P-04の採点は同一記事でも幅7〜11ばらつく (実測σ≈3.5〜4.6)。refit と同じ扱いにする:
  // (a) reject だけでなく hold でも1回は改善を試みる。以前は最も見込みの薄い reject 側にだけ
  //     再試行を使い、hold は終端で1度も改善されなかった
  // (b) 2周目が1周目より悪くなることも普通に起きるので、良い方を採る
  let result = await writeAndGate(deps, article.id, keyword, lane, outline, assets, [], draft?.body);
  // 法令違反があるときは、API節約のための1パス短縮 (singlePass) を適用しない。
  // 「安く済ませる」より「行政指導を受けない」が優先される
  const needsComplianceRewrite = result.compliance.blocked;
  if (result.verdict.verdict !== "approve" && (!singlePass || needsComplianceRewrite)) {
    // 2周目はクラウド下書きを渡さない = 従来どおりAPIで書き直す
    // (下書きがゲートを通らなかった場合の改善手段はAPI再生成)
    const retry = await writeAndGate(
      deps,
      article.id,
      keyword,
      lane,
      outline,
      assets,
      [
        ...result.verdict.fix_instructions,
        ...result.notationFixes,
        ...result.compliance.fixInstructions,
      ],
    );
    // 法令ゲートは点数より優先する。片方だけがクリアしているなら必ずそちらを採る
    const complianceDecides = result.compliance.blocked !== retry.compliance.blocked;
    if (complianceDecides ? !retry.compliance.blocked : isBetterVerdict(retry.verdict, result.verdict)) {
      result = retry;
    } else {
      console.log(
        `[generate] 再生成が改善しなかったため1周目を採用 ` +
          `(${retry.verdict.verdict}/${retry.verdict.scores.total} <= ` +
          `${result.verdict.verdict}/${result.verdict.scores.total})`,
      );
    }
    if (result.verdict.verdict === "reject" && !fullAuto) {
      return reject(deps, article, keyword, "P-04再rejectで終了", result.verdict);
    }
  }
  let body = result.body;
  await saveQuality(store, article.id, result.verdict, result.compliance);

  // 法令ゲート (フェイルクローズド)。full_auto_publish=true でも例外なく止める。
  // Googleの順位下落と違い、こちらは販売者に行政指導が来る種類のリスクなので、
  // 「速度優先でまず市場に出る」という判断の対象外にする
  if (result.compliance.blocked) {
    return reject(
      deps,
      article,
      keyword,
      `法令ゲート: ${summarizeCompliance(result.compliance)}`,
      result.verdict,
      { compliance: result.compliance },
    );
  }
  if (result.verdict.verdict === "hold" && !fullAuto) {
    await store.updateArticle(article.id, { status: "gate_pending", body_mdx: body });
    return (await store.getArticle(article.id))!;
  }

  // レーンB: P-05合議ファクトチェック
  if (lane === "B") {
    const consensus = await runConsensus(deps, article.id, body, assets);
    await store.updateArticle(article.id, {
      consensus_result: consensus.detail,
      judge_disagreement: consensus.judgeDisagreement,
    });
    if (consensus.removeTargets.length > 0) {
      // 一致して不可と判定された数値主張のみP-06で除去し、P-04を再実行 (最大1周)
      body = await runNumericCheck(deps, article.id, body, assets, consensus.removeTargets);
      // P-06で本文が書き換わっているので法令チェックを掛け直す
      const recompliance = await runComplianceCheck(deps, body);
      const regate = await runGate(deps, article.id, keyword, lane, outline, body, assets);
      await saveQuality(store, article.id, regate, recompliance);
      if (recompliance.blocked) {
        return reject(
          deps,
          article,
          keyword,
          `法令ゲート (合議後): ${summarizeCompliance(recompliance)}`,
          regate,
          { compliance: recompliance },
        );
      }
      if (regate.verdict === "reject" && !fullAuto) {
        return reject(deps, article, keyword, "合議後のP-04再ゲートでreject", regate);
      }
      if (regate.verdict === "hold" && !fullAuto) {
        await store.updateArticle(article.id, { status: "gate_pending", body_mdx: body });
        return (await store.getArticle(article.id))!;
      }
    }
  }

  const finalized = await finalizeToApprovalQueue(deps, article.id, keyword, outline, body);
  // タイトル重複で却下された場合、キーワードは記事化済み (done) ではなく保留 (parked)。
  // doneにすると「書いた」ことになり、同じ穴を埋める提案が二度と出なくなる
  await store.updateKeywordStatus(keyword.id, finalized === "approval_pending" ? "done" : "parked");
  return (await store.getArticle(article.id))!;
}

// gate_pending記事を人間がゲート承認した後の再開 (レーンBは合議から、Aは仕上げから)
export async function continueFromGate(
  articleId: string,
  deps: OrchestratorDeps,
): Promise<ArticleRow> {
  const { store } = deps;
  const article = await store.getArticle(articleId);
  if (!article || article.status !== "gate_pending") {
    throw new Error(`gate_pendingの記事ではありません: ${articleId}`);
  }

  // 改修 (revision) はゲート時点で既にタイトル・URL・本文が確定している (refitArticleが設定済み)。
  // P-01 outlineを持たないので、outline経由の仕上げ (P-12でタイトル/URL再生成) は通さず、
  // そのまま承認待ちへ進める。「改修はタイトル/URLを変えない」という原則もこれで守られる。
  if (article.track === "revision") {
    await store.updateArticle(articleId, { status: "approval_pending" });
    await store.updateKeywordStatus(article.keyword_id, "done");
    return (await store.getArticle(articleId))!;
  }

  const keyword = (await store.getKeyword(article.keyword_id))!;
  const outline = P01Outline.parse(article.outline);
  let body = article.body_mdx ?? "";
  const assets = await selectRelevantAssets({
    store,
    llm: deps.llm,
    cluster: keyword.cluster,
    topic: keyword.keyword,
    limit: 3,
    articleId: article.id,
    asOf: deps.now?.(),
  });

  if (article.lane === "B") {
    const consensus = await runConsensus(deps, articleId, body, assets);
    await store.updateArticle(articleId, {
      consensus_result: consensus.detail,
      // judge不一致フラグは単調 (一度立ったら下ろさない)。再合議でたまたま一致しても、
      // 1回目の不一致を人間に提示しないまま承認できてしまうのを防ぐ (v3: 人間エスカレーション)
      judge_disagreement: article.judge_disagreement || consensus.judgeDisagreement,
    });
    if (consensus.removeTargets.length > 0) {
      body = await runNumericCheck(deps, articleId, body, assets, consensus.removeTargets);
    }
  }
  const finalized = await finalizeToApprovalQueue(deps, articleId, keyword, outline, body);
  await store.updateKeywordStatus(keyword.id, finalized === "approval_pending" ? "done" : "parked");
  return (await store.getArticle(articleId))!;
}

// ---- 内部ステップ ----

async function prompt(deps: OrchestratorDeps, id: string): Promise<string> {
  return getPrompt(id, deps.store.getPromptFromDb.bind(deps.store), deps.suitePath);
}

// クラウド下書き (サブスク側ルーチンが執筆) の取り込み。
//
// 見つけたら成否に関わらず consumed_at を立てる:
//   - 成功時: この記事が使ったことを記録する (再利用防止 + トレーサビリティ)
//   - 検証失敗時: 壊れた下書きを翌日も拾い続けてAPI経路を毎回失敗で汚さないため。
//     ルーチン側は「未消費の下書きが残っているキーワードには書かない」ので、
//     消費しておけば翌日の実行で新しい下書きが作り直される
// outline は外部入力なので必ずzodで検証する。失敗はnullを返して従来のAPI経路に落とす
// (フェイルオープンでよい: 落ちた先は従来運用そのものなので安全側)。
async function loadCloudDraft(
  store: Store,
  keywordId: string,
  articleId: string,
): Promise<{ outline: P01OutlineT; body: string } | null> {
  const draft = await store.getLatestCloudDraft(keywordId);
  if (!draft) return null;
  try {
    const outline = P01Outline.parse(draft.outline);
    const body = dedupeH2Sections(sanitizeArticleBody(draft.body_mdx));
    if (body.replace(/\s/g, "").length < 500) {
      throw new Error(`本文が短すぎます (${body.length}文字)`);
    }
    await store.markCloudDraftConsumed(draft.id, articleId);
    console.log(`[cloud_draft] 下書きを使用: keyword=${keywordId} draft=${draft.id}`);
    return { outline, body };
  } catch (e) {
    await store.markCloudDraftConsumed(draft.id, null);
    console.warn(
      `[cloud_draft] 下書きの検証に失敗したためAPI経路で生成します: draft=${draft.id} — ${e}`,
    );
    return null;
  }
}

async function runOutline(
  deps: OrchestratorDeps,
  keyword: KeywordRow,
  lane: string,
  assets: PrimaryAssetRow[],
  articleId: string,
): Promise<P01OutlineT> {
  const [p00, p01] = await Promise.all([prompt(deps, "P-00"), prompt(deps, "P-01")]);
  const addonId = ARTICLE_TYPE_ADDON[keyword.article_type];
  const addon = addonId ? await prompt(deps, addonId) : "";
  const existing = await deps.store.listArticleSummaries(articleId);
  const user =
    fillTemplate(p01, {
      keyword: keyword.keyword,
      cluster: keyword.cluster,
      article_type: keyword.article_type,
      lane,
      search_intent: keyword.search_intent ?? "キーワードから推定",
      primary_assets: JSON.stringify(
        assets.map((a) => ({ asset_id: a.id, title: a.title, description: a.description })),
      ),
      existing_articles: JSON.stringify(existing),
    }) + (addon ? `\n\n${addon}` : "");
  return callAndParse(
    deps.llm,
    { promptId: "P-01", system: p00, user, job: "generation", articleId },
    P01Outline,
  );
}

async function writeSections(
  deps: OrchestratorDeps,
  articleId: string,
  outline: P01OutlineT,
  keyword: KeywordRow,
  assets: PrimaryAssetRow[],
  fixInstructions: string[],
): Promise<string> {
  const [p00, p02] = await Promise.all([prompt(deps, "P-00"), prompt(deps, "P-02")]);
  const addonId = ARTICLE_TYPE_ADDON[keyword.article_type];
  const addon = addonId ? await prompt(deps, addonId) : "";
  const sections: string[] = [];
  const summaries: string[] = [];
  // FAQをH2として末尾に足してから書かせる (P-00の必須要件)
  outline = withFaqSection(outline);

  const allocation = allocateAssets(outline, assets);

  for (let i = 0; i < outline.outline.length; i++) {
    const forSection = allocation[i] ?? [];
    const assetContent = forSection.map((a) => a.content).join("\n");
    let user = fillTemplate(p02, {
      outline_json: JSON.stringify(outline),
      // P-02の冒頭は「記事「{outline_jsonのtitle_draft}」のセクション…」という
      // 独自のプレースホルダ名を使っている。ここで埋めないと未置換の文字列が
      // そのままLLMへ渡り、記事タイトルを伝えないまま本文を書かせることになる
      "outline_jsonのtitle_draft": outline.title_draft,
      current_h2_index: String(i),
      previous_sections_summary: summaries.join("\n"),
      primary_asset_content: assetContent,
      article_type_addon: addon,
    });
    // 資産を「参考」として渡すだけだと、P-02は具体的な数値・出典を織り込まない
    // (自動リサーチの効果が本文に乗らない)。改修(P-13b)で効いたのと同じく、
    // 検証済み数値と出典を明示し「出典付きで織り込め」と強制する。
    if (forSection.length) user += buildAssetInjectionBlock(forSection);
    if (fixInstructions.length) {
      user += `\n\n<fix_instructions>前回の品質ゲートの修正指示: ${fixInstructions.join(" / ")}</fix_instructions>`;
    }
    const res = await deps.llm.call({
      promptId: "P-02",
      system: p00,
      user,
      job: "generation",
      articleId,
    });
    // P-02は本文を ```mdx フェンス + フロントマターで包んで返すことがある。
    // 素通りするとプレーンmarkdownのサイトで記事全体がコードブロックになる
    sections.push(sanitizeArticleBody(res.text));

    // 各セクション生成後にHaikuで100字要約して蓄積 (SPEC M2手順4)
    const summary = await deps.llm.call({
      promptId: "P-02-summary",
      user: `次のセクションを100字で要約:\n${res.text}`,
      job: "generation",
      articleId,
    });
    summaries.push(`${i + 1}. ${summary.text.trim()}`);
  }
  return dedupeH2Sections(sections.join("\n\n"));
}

// 一次情報をどのセクションに入れるかの割当。
//
// これまでは P-01 が立てた uses_primary_info フラグをそのまま使っていたが、実測では
// 7セクション中2〜3本しか true にならず、しかもその多くが末尾の自社紹介章だった。
// 残り4〜5章には資産が一切渡らないため、記事の過半が定義上ただの一般論になり、
// P-04の独自性は「一次情報はあるが添え物 (15点)」より上に行けない構造だった。
//
// 方針: P-01の意図 (uses_primary_info と primary_info_plan) を尊重しつつ、
// 本文セクションの過半に少なくとも1件は行き渡るよう決定論的に補う。
// FAQ章は問答なので対象外。前方のセクションから埋める (末尾の自社紹介章に偏らせない)。
export function allocateAssets(
  outline: P01OutlineT,
  assets: PrimaryAssetRow[],
): Record<number, PrimaryAssetRow[]> {
  const out: Record<number, PrimaryAssetRow[]> = {};
  if (assets.length === 0) return out;

  const byId = new Map(assets.map((a) => [a.id, a]));
  const isFaq = (h2: string) => /FAQ|よくある(ご)?質問/i.test(h2);
  const bodyIdx = outline.outline
    .map((o, i) => ({ i, h2: o.h2 }))
    .filter((s) => !isFaq(s.h2))
    .map((s) => s.i);

  const add = (i: number, a: PrimaryAssetRow) => {
    const cur = (out[i] ??= []);
    if (!cur.some((x) => x.id === a.id)) cur.push(a);
  };

  // 1. P-01が明示した割当 (primary_info_plan) を最優先で反映する。
  //    これまでコードから一切参照されていなかった。
  for (const plan of outline.primary_info_plan ?? []) {
    const a = byId.get(plan.asset_id);
    const i = plan.section_index;
    if (a && typeof i === "number" && bodyIdx.includes(i)) add(i, a);
  }

  // 2. uses_primary_info=true のセクションで、まだ空のものを埋める
  for (const i of bodyIdx) {
    if (outline.outline[i]!.uses_primary_info && !out[i]?.length) {
      add(i, assets[0]!);
    }
  }

  // 3. 本文セクションの過半に行き渡るまで、前方から順に補う
  const target = Math.ceil(bodyIdx.length / 2);
  let cursor = 0;
  for (const i of bodyIdx) {
    if (Object.values(out).filter((v) => v.length).length >= target) break;
    if (!out[i]?.length) add(i, assets[cursor++ % assets.length]!);
  }

  // 4. 一度も使われていない資産があれば、資産の無いセクションへ入れる
  const used = new Set(Object.values(out).flat().map((a) => a.id));
  for (const a of assets) {
    if (used.has(a.id)) continue;
    const slot = bodyIdx.find((i) => !out[i]?.length) ?? bodyIdx[0];
    if (slot !== undefined) add(slot, a);
  }
  return out;
}

// 一次情報 (自社実データ・自動リサーチした公的統計) を、数値と出典つきで本文に
// 確実に織り込ませるための強制ブロック。P-02に「参考」として渡すだけでは使われないため。
export function buildAssetInjectionBlock(assets: PrimaryAssetRow[]): string {
  const facts = assets.flatMap((a) => {
    const claims = Array.isArray(a.numeric_claims) ? a.numeric_claims : [];
    return claims
      .map((c) => c as { claim?: string; value?: string; unit?: string; basis?: string })
      .filter((c) => c.claim && c.basis)
      .map((c) => `- ${c.claim}: ${c.value ?? ""}${c.unit ?? ""}（出典: ${c.basis}）`);
  });
  if (facts.length === 0) return "";
  return (
    "\n\n<一次情報の織り込み指示>\n" +
    "このセクションに関連する以下の検証済みファクトを、数値と出典（調査名）を本文に明記して" +
    "織り込むこと。出典の明記は必須。関連しないファクトは無理に使わない。捏造や数値の改変は禁止。\n" +
    facts.join("\n") +
    "\n</一次情報の織り込み指示>"
  );
}

// P-02 は稀に同じH2セクションを2回書く (coherenceを大きく落とす)。
// アウトラインのH2はユニークなので、本文中に同一H2見出しが複数回現れたら
// 最初の1つだけ残す。決定論的な安全網で、P-02の間欠的な重複を確実に潰す。
export function dedupeH2Sections(body: string): string {
  const lines = body.split("\n");
  const blocks: { key: string | null; text: string[] }[] = [{ key: null, text: [] }];
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      blocks.push({ key: m[1]!.replace(/\s+/g, "").toLowerCase(), text: [line] });
    } else {
      blocks[blocks.length - 1]!.text.push(line);
    }
  }
  const seen = new Set<string>();
  const kept = blocks.filter((b) => {
    if (b.key === null) return true; // 見出し前の前文
    if (seen.has(b.key)) return false; // 2回目以降の同一H2は捨てる
    seen.add(b.key);
    return true;
  });
  return kept
    .map((b) => b.text.join("\n"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function runNumericCheck(
  deps: OrchestratorDeps,
  articleId: string,
  body: string,
  assets: PrimaryAssetRow[],
  removeTargets: string[],
): Promise<string> {
  const p06 = await prompt(deps, "P-06");
  const allowed = assets.flatMap((a) => a.numeric_claims);
  const user = fillTemplate(p06, {
    article_body: body,
    allowed_claims: JSON.stringify(allowed),
    remove_targets: JSON.stringify(removeTargets),
  });
  const res = await deps.llm.call({
    promptId: "P-06",
    user,
    job: "generation",
    articleId,
  });
  const [cleaned, changelogRaw] = res.text.split(CHANGELOG_SEP);
  if (changelogRaw === undefined) {
    throw new Error("P-06出力にCHANGELOG区切りがありません");
  }
  const changelog = P06Changelog.parse(JSON.parse(stripCodeFence(changelogRaw)));
  await deps.store.updateArticle(articleId, { numeric_changelog: changelog });
  return cleaned!.trim();
}

// P-04の照合材料。id と title だけを渡していたため、本文に書かせた自社データ
// (「累計20社以上」等) をゲートが検証できず、同じ一文が実行ごとに source_found=true/false と
// ばらついていた (実測15回ずつ)。誤フラグはE-E-A-Tの減点とブロッキング扱いを同時に生む。
// 値・単位・根拠まで渡して、照合できる状態にする。
export function assetForJudge(a: PrimaryAssetRow) {
  const claims = Array.isArray(a.numeric_claims) ? a.numeric_claims : [];
  return {
    id: a.id,
    title: a.title,
    content: a.content,
    numeric_claims: claims.map((c) => {
      const n = c as { claim?: string; value?: string; unit?: string; basis?: string };
      return { claim: n.claim, value: n.value, unit: n.unit, basis: n.basis };
    }),
  };
}

// 2周の生成・改稿のうちどちらを採るか。判定 (approve > hold > reject) を合計点より優先する。
// approve は点数だけでなくハルシネーションフラグが空であることも条件なので、
// 合計点が同じか低くても approve のほうが良い結果である。
const VERDICT_RANK = { approve: 0, hold: 1, reject: 2 } as const;

export function isBetterVerdict(candidate: P04VerdictT, current: P04VerdictT): boolean {
  const rc = VERDICT_RANK[candidate.verdict];
  const rr = VERDICT_RANK[current.verdict];
  if (rc !== rr) return rc < rr;
  return candidate.scores.total > current.scores.total;
}

// P-04の判定を pipeline_config.quality_thresholds と突き合わせ、厳しい方を採用する。
// 設定値はプロンプト文言にも書かれているが、コード側で照合しないと
// 「設定を変えても効かない」うえ、LLMが閾値を無視した判定を返しても素通りしてしまう。
// 閾値の変更はtier2 (人間承認) 扱いなので、設定が実際に効くことが前提になる。
export function reconcileVerdict(
  verdict: P04VerdictT,
  thresholds: { approve: number; hold: number },
): P04VerdictT["verdict"] {
  const total = verdict.scores.total;
  const hasBlockingFlag = verdict.hallucination_flags.some((f) => f.action !== "keep_with_source");
  const byScore: P04VerdictT["verdict"] =
    total >= thresholds.approve && !hasBlockingFlag
      ? "approve"
      : total >= thresholds.hold
        ? "hold"
        : "reject";
  const rank = { approve: 0, hold: 1, reject: 2 } as const;
  // LLMの判定と閾値判定のうち、より厳しい方を採用する
  return rank[byScore] >= rank[verdict.verdict] ? byScore : verdict.verdict;
}

async function runGate(
  deps: OrchestratorDeps,
  articleId: string,
  keyword: KeywordRow,
  lane: string,
  outline: P01OutlineT,
  body: string,
  assets: PrimaryAssetRow[],
): Promise<P04VerdictT> {
  const p04 = await prompt(deps, "P-04");
  const existing = await deps.store.listArticleSummaries(articleId);
  const user = fillTemplate(p04, {
    article_body: body,
    keyword: keyword.keyword,
    search_intent_analysis: JSON.stringify(outline.search_intent_analysis),
    existing_articles: JSON.stringify(existing),
    lane,
    primary_info_used: JSON.stringify(assets.map(assetForJudge)),
    mechanical_check: mechanicalCheckReport(body),
  });
  const verdict = await callAndParse(
    deps.llm,
    { promptId: "P-04", user, job: "gate", articleId },
    P04Verdict,
  );
  const thresholds = (await deps.store.getConfig<{ approve: number; hold: number }>(
    "quality_thresholds",
  )) ?? { approve: 85, hold: 70 };
  const reconciled = reconcileVerdict(verdict, thresholds);
  if (reconciled !== verdict.verdict) {
    console.warn(
      `[gate] P-04の判定を設定値に合わせて厳格化: ${verdict.verdict} → ${reconciled} ` +
        `(total=${verdict.scores.total}, approve>=${thresholds.approve}, hold>=${thresholds.hold})`,
    );
  }
  return { ...verdict, verdict: reconciled };
}

interface WriteAndGateResult {
  body: string;
  verdict: P04VerdictT;
  // 機械チェックで検出した、書き換えが要る違反 (再生成時の修正指示に足す)
  notationFixes: string[];
  // 法令チェックの結果。blocked=true は全自動でも公開させない
  compliance: ComplianceReport;
}

async function writeAndGate(
  deps: OrchestratorDeps,
  articleId: string,
  keyword: KeywordRow,
  lane: "A" | "B",
  outline: P01OutlineT,
  assets: PrimaryAssetRow[],
  fixInstructions: string[],
  // クラウド下書きの本文。渡されたらP-02 (執筆) を省略してこれを使う。
  // 後続 (B: P-06数値チェック → 表記機械チェック → P-04ゲート) は通常どおり実行される
  preWritten?: string,
): Promise<WriteAndGateResult> {
  let body =
    preWritten ?? (await writeSections(deps, articleId, outline, keyword, assets, fixInstructions));
  // レーンBは生成直後 (P-04の前) にP-06数値チェック (SPEC M2手順5)
  if (lane === "B") {
    body = await runNumericCheck(deps, articleId, body, assets, []);
  }
  // 表記・構造の機械チェック。P-04に出す前にダッシュ等を決定論的に潰す
  const notation = checkNotation(body);
  body = notation.body;
  console.log(`[notation] ${articleId} ${summarizeNotation(notation)}`);

  // 法令チェック (薬機法・健康増進法・景表法・特別栽培ガイドライン)。
  // 決定論なのでAPIコストゼロ。本文が変わるたびに掛け直す
  const compliance = await runComplianceCheck(deps, body);
  if (compliance.violations.length) {
    console.warn(`[compliance] ${articleId} ${summarizeCompliance(compliance)}`);
  }

  const verdict = await runGate(deps, articleId, keyword, lane, outline, body, assets);
  return {
    body,
    verdict,
    compliance,
    notationFixes: notationFixInstructions(notation.issues),
  };
}

// configのallowlistを反映した法令チェック。
// allowlist は「根拠を示せるので使ってよい」と代表が判断した表現 (受賞歴など)
export async function runComplianceCheck(
  deps: Pick<OrchestratorDeps, "store">,
  text: string,
): Promise<ComplianceReport> {
  const allowlist = (await deps.store.getConfig<string[]>("compliance_allowlist")) ?? [];
  return checkCompliance(text, { allowlist });
}

interface ConsensusOutcome {
  judgeDisagreement: boolean;
  removeTargets: string[];
  detail: unknown;
}

// 合議に使った2系統の記録 (SPEC: OpenAIを使わない場合はその旨をverdictメタに残す)
// P-00は「記事末にFAQを4〜6問」を必須とし、P-04も構造点で採点する。
// しかしP-01のfaq_candidatesは質問文だけで、P-02はoutlineのH2しか書かないため、
// そのままでは本文にFAQが一切入らない (点を落としつつ網羅性も損なう)。
// FAQをH2としてoutlineの末尾に足し、通常のセクション生成でP-02に書かせる。
export function withFaqSection(outline: P01OutlineT): P01OutlineT {
  const questions = outline.faq_candidates.filter((q) => q.trim()).slice(0, 6);
  if (questions.length < 1) return outline;
  const alreadyHasFaq = outline.outline.some((o) => /FAQ|よくある(ご)?質問/i.test(o.h2));
  if (alreadyHasFaq) return outline;
  return {
    ...outline,
    outline: [
      ...outline.outline,
      {
        h2: "よくあるご質問",
        answer_first: "この記事に関して多い質問と回答をまとめます。",
        h3: questions,
        uses_primary_info: false,
      },
    ],
  };
}

export function consensusSystemsMeta() {
  return {
    primary: "claude:classify",
    secondary: "claude:judge",
    openai_used: false,
    note: "第2系統のOpenAIは未実装のため、Claude内の異モデル2者で代替している (SPEC M1の代替経路)",
  };
}

// P-05合議 (v3ルール):
//   両系統ok → 通過 / 両系統ng → 数値主張のみP-06除去対象 (非数値は人間エスカレーション) /
//   不一致 → judge_disagreementフラグ (自動棄却も自動通過もしない)
async function runConsensus(
  deps: OrchestratorDeps,
  articleId: string,
  body: string,
  assets: PrimaryAssetRow[],
): Promise<ConsensusOutcome> {
  const p05a = await prompt(deps, "P-05a");
  const claims: P05ClaimsT = await callAndParse(
    deps.llm,
    {
      promptId: "P-05a",
      user: fillTemplate(p05a, { article_body: body }),
      job: "gate",
      articleId,
    },
    P05Claims,
  );
  if (claims.claims.length === 0) {
    return { judgeDisagreement: false, removeTargets: [], detail: { claims: [], verdicts: [] } };
  }

  const p05b = await prompt(deps, "P-05b");
  const user = fillTemplate(p05b, {
    "P-05a出力のclaims": JSON.stringify(claims.claims),
    primary_info_used: JSON.stringify(assets.map((a) => a.numeric_claims).flat()),
  });
  // 合議の2系統 (SPEC M1 / v3 1-5):
  //   第1系統 P-05b   = classifyカテゴリ (Haiku)
  //   第2系統 P-05b-2 = judgeカテゴリ (Sonnet) ← Claude内の異モデルによる代替
  // OpenAIによる第2系統はSprint 1以降。代替である旨は consensus_result.systems に記録する
  // (SPEC: 「なければClaude内の異モデル2者で代替し、その旨をverdictメタに記録する」)。
  const v1: P05VerdictsT = await callAndParse(
    deps.llm,
    { promptId: "P-05b", user, job: "gate", articleId },
    P05Verdicts,
  );
  const v2: P05VerdictsT = await callAndParse(
    deps.llm,
    { promptId: "P-05b-2", user, job: "gate", articleId },
    P05Verdicts,
  );

  const byId = (vs: P05VerdictsT, id: number) => vs.verdicts.find((v) => v.id === id);
  let judgeDisagreement = false;
  const removeTargets: string[] = [];
  const perClaim: unknown[] = [];

  for (const claim of claims.claims) {
    const a = byId(v1, claim.id)?.verdict ?? "unsure";
    const b = byId(v2, claim.id)?.verdict ?? "unsure";
    const okOf = (v: string) =>
      v === "true" || (v === "unsure" && claim.source_in_article !== null);
    const badOf = (v: string) =>
      v === "false" || (v === "unsure" && claim.source_in_article === null);

    let resolution: string;
    if (okOf(a) && okOf(b)) {
      resolution = "pass";
    } else if (badOf(a) && badOf(b)) {
      if (claim.type === "numeric") {
        resolution = "remove_numeric";
        removeTargets.push(claim.claim);
      } else {
        // 非数値の一致NGは自動除去せず人間エスカレーション (v3: 自動除去は数値主張のみ)
        resolution = "human_review";
        judgeDisagreement = true;
      }
    } else {
      resolution = "judge_disagreement";
      judgeDisagreement = true;
    }
    perClaim.push({ claim: claim.claim, type: claim.type, system1: a, system2: b, resolution });
  }

  return {
    judgeDisagreement,
    removeTargets,
    detail: { claims: perClaim, systems: consensusSystemsMeta() },
  };
}

async function finalizeToApprovalQueue(
  deps: OrchestratorDeps,
  articleId: string,
  keyword: KeywordRow,
  outline: P01OutlineT,
  body: string,
): Promise<"approval_pending" | "duplicate_title" | "compliance_blocked"> {
  const { store } = deps;

  // P-12 title/meta
  const p12 = await prompt(deps, "P-12");
  const titleMeta = await callAndParse(
    deps.llm,
    {
      promptId: "P-12",
      user: fillTemplate(p12, {
        keyword: keyword.keyword,
        article_summary: JSON.stringify(outline.search_intent_analysis.reader_wants),
        article_type: keyword.article_type,
      }),
      job: "generation",
      articleId,
    },
    P12TitleMeta,
  );
  const title =
    titleMeta.titles[titleMeta.recommended.title_index]?.text ?? titleMeta.titles[0]?.text ?? "";
  const meta =
    titleMeta.meta_descriptions[titleMeta.recommended.meta_index]?.text ??
    titleMeta.meta_descriptions[0]?.text ??
    "";

  // 重複ハードゲート (仕上げ)。キーワードの字面が違っても、P-12で確定したタイトルが
  // 既存記事とほぼ同一なら同じ内容の記事になっている。承認キューに乗せず却下する
  // (乗せると全自動時にそのまま公開される)。slugを消費する前に判定する。
  const existingTitles = (
    await collectExistingTopics(
      { store, llm: deps.llm, suitePath: deps.suitePath, extraTopics: deps.extraTopics },
      articleId,
    )
  ).map((t) => t.title);
  const dupTitle = findTitleDuplicate(title, existingTitles);
  if (dupTitle) {
    const current = await store.getArticle(articleId);
    const quality =
      current?.quality && typeof current.quality === "object" ? current.quality : {};
    await store.updateArticle(articleId, {
      body_mdx: body,
      title,
      meta_description: meta,
      status: "rejected",
      quality: {
        ...quality,
        rejected_reason: `重複ゲート (仕上げ): タイトルが既存「${dupTitle}」とほぼ同一`,
      },
    });
    console.warn(
      `[duplicate_gate] タイトル重複のため却下: ${articleId} 「${title}」 ≈ 「${dupTitle}」`,
    );
    return "duplicate_title";
  }

  // 公開URLのslug。P-12が生成した英語slugを検証して採用する
  const slug = await makeSlug(store, keyword.keyword, articleId, titleMeta);

  // P-11 内部リンク: outboundは本文末尾の関連リンクブロックとして自動適用、inboundはproposed
  const p11 = await prompt(deps, "P-11");
  const links = await callAndParse(
    deps.llm,
    {
      promptId: "P-11",
      user: fillTemplate(p11, {
        new_article: JSON.stringify({
          id: articleId,
          title,
          keyword: keyword.keyword,
          cluster: keyword.cluster,
          h2: outline.outline.map((o) => o.h2),
        }),
        // 実在するルートのみを渡す (configのcollections + linkable_pages)。
        // 渡さないパスをP-11が選ぶと、本文に404リンクが自動挿入される
        site_pages: JSON.stringify(await linkableSitePages(store)),
        existing_articles: JSON.stringify(await store.listArticleSummaries(articleId)),
      }),
      job: "generation",
      articleId,
    },
    P11Links,
  );
  // LLMが許可外のパス (例: 存在しない /contact) を返しても本文に入れない。
  // 本文のリンクは自動適用されるため、ここを通さないと404リンクがそのまま公開される
  const applicable = links.outbound.filter((l) => isAllowedInternalTarget(l.target));
  const rejectedLinks = links.outbound.filter((l) => !isAllowedInternalTarget(l.target));
  if (rejectedLinks.length) {
    console.warn(
      `[links] 実在しないリンク先を除外: ${rejectedLinks.map((l) => l.target).join(", ")}`,
    );
  }
  await store.insertInternalLinks([
    ...applicable.map((l) => ({
      source_article_id: articleId,
      target_url: l.target,
      anchor: l.anchor,
      insert_hint: l.insert_hint,
      direction: "outbound" as const,
      status: "applied" as const,
    })),
    // 除外分も記録は残す (承認者と後の改善のため)
    ...rejectedLinks.map((l) => ({
      source_article_id: articleId,
      target_url: l.target,
      anchor: l.anchor,
      insert_hint: l.insert_hint,
      direction: "outbound" as const,
      status: "skipped" as const,
    })),
    ...links.inbound.map((l) => ({
      source_article_id: articleId,
      target_url: l.from_article_id,
      anchor: l.anchor,
      insert_hint: l.insert_hint,
      direction: "inbound" as const,
      status: "proposed" as const,
    })),
  ]);
  let finalBody = body;
  if (applicable.length) {
    finalBody += `\n\n## 関連リンク\n\n${applicable.map((l) => `- [${l.anchor}](${l.target})`).join("\n")}`;
  }

  // コレクション導線。P-11が張ってくれることを当てにせず、機械的に付ける。
  // 既に品種名入りのアンカーで刺さっていれば二重に置かない
  const collections = (await store.getConfig<CollectionMap>("collections")) ?? {};
  const collection = resolveCollection(collections, keyword.target_collection);
  let collectionLink: ReturnType<typeof checkCollectionLink> | null = null;
  if (collection) {
    const origin = (await store.getConfig<string>("producer_origin")) ?? "愛媛・宇和島産";
    if (!checkCollectionLink(finalBody, collection).ok) {
      finalBody += `\n\n${buildCollectionCta(collection, origin)}`;
    }
    collectionLink = checkCollectionLink(finalBody, collection);
    if (!collectionLink.ok) {
      // 自動付与しても通らないのは、configにその品種のlabelが無い等の設定漏れ。
      // 記事は止めず、承認画面に理由を出して人間に直させる
      console.warn(`[collection_link] ${articleId} ${collectionLink.reason}`);
    }
  }

  // 仕上げの法令チェック。P-12が生成したタイトルとメタディスクリプションは
  // 本文のチェックを一度も通っていない (「免疫力アップ」がタイトルだけに入る事故を防ぐ)
  const finalCompliance = await runComplianceCheck(deps, [title, meta, finalBody].join("\n"));
  if (finalCompliance.blocked) {
    const prev = await store.getArticle(articleId);
    const prevQuality = prev?.quality && typeof prev.quality === "object" ? prev.quality : {};
    await store.updateArticle(articleId, {
      body_mdx: finalBody,
      title,
      meta_description: meta,
      status: "rejected",
      quality: {
        ...prevQuality,
        compliance: finalCompliance,
        rejected_reason: `法令ゲート (仕上げ): ${summarizeCompliance(finalCompliance)}`,
      },
    });
    console.warn(`[compliance] 仕上げで却下: ${articleId} ${summarizeCompliance(finalCompliance)}`);
    return "compliance_blocked";
  }

  // SERP差分チェック (v3): 結果はhuman_review_notesへ添付するのみ。自動棄却しない。
  // 失敗しても生成は成功扱い (承認者は参考情報なしでレビューできる)
  let serpGap: unknown;
  try {
    const gap = await runSerpCheck(
      keyword.keyword,
      [title, meta, ...outline.outline.map((o) => o.h2)].join("\n"),
      { store, llm: deps.llm, fetchImpl: deps.serpFetch, suitePath: deps.suitePath },
      articleId,
    );
    serpGap = gap;
    const article = await store.getArticle(articleId);
    const quality = article?.quality as
      | { human_review_notes?: { risk_areas: string[]; uniqueness_basis: string } }
      | undefined;
    if (gap.checked && quality?.human_review_notes) {
      await store.updateArticle(articleId, {
        quality: attachSerpToReviewNotes(
          quality as { human_review_notes: { risk_areas: string[]; uniqueness_basis: string } },
          gap,
        ),
      });
    }
  } catch (e) {
    console.warn(`[serp] SERP差分チェック失敗 (生成は継続): ${e}`);
    serpGap = { checked: false, skipped_reason: String(e), advisory_only: true };
  }

  // 実際に本文へ注入した一次情報の使用回数を加算する。
  // 選抜は usage_count 昇順なので、加算しないと同じ資産が使われ続け、
  // 一次情報バンクのローテーションが機能しない
  const usedAssetIds = outline.primary_info_plan
    .map((p) => p.asset_id)
    .filter((id): id is string => Boolean(id));
  if (usedAssetIds.length) await store.incrementAssetUsage(usedAssetIds);

  // v3: 全記事は承認キューへ。publish_queue投入とscheduled_at割当は承認時に行う。
  // 法令チェックとコレクション導線の結果は quality に同梱して承認画面へ出す
  const gated = await store.getArticle(articleId);
  const gatedQuality = gated?.quality && typeof gated.quality === "object" ? gated.quality : {};
  await store.updateArticle(articleId, {
    quality: { ...gatedQuality, compliance: finalCompliance, collection_link: collectionLink },
    body_mdx: finalBody,
    title,
    meta_description: meta,
    slug,
    faq: outline.faq_candidates,
    serp_gap: serpGap,
    word_count: finalBody.replace(/\s/g, "").length,
    status: "approval_pending",
  });
  return "approval_pending";
}

// slugの決定順:
//   1. P-12が生成した英語slug候補 (推奨インデックス優先、順に検証)
//   2. キーワードがそのままASCIIで使える場合 (英語キーワードのみ)
//   3. post-<hex> フォールバック (LLM生成が失敗した場合の最終手段)
// 公開後のslug変更はリダイレクトが必要で事実上やり直せないため、
// 1が使えるかどうかがURL品質を決める。
export function pickSlugCandidate(titleMeta: P12TitleMetaT | undefined): string | null {
  if (!titleMeta?.slugs?.length) return null;
  const preferred = titleMeta.recommended.slug_index ?? 0;
  const ordered = [
    titleMeta.slugs[preferred],
    ...titleMeta.slugs.filter((_, i) => i !== preferred),
  ].filter((s): s is { text: string; aim: string } => Boolean(s));
  for (const candidate of ordered) {
    const text = candidate.text.trim().toLowerCase();
    if (SLUG_PATTERN.test(text) && text.length <= 60) return text;
  }
  return null;
}

async function makeSlug(
  store: Store,
  keyword: string,
  articleId: string,
  titleMeta?: P12TitleMetaT,
): Promise<string> {
  const fromLlm = pickSlugCandidate(titleMeta);
  let base: string;
  if (fromLlm) {
    base = fromLlm;
  } else {
    const ascii = keyword
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    // 公開URLは /article-<slug> になるため、フォールバックに article- は付けない
    // (付けると /article-article-xxxx と接頭辞が二重になる)
    base = SLUG_PATTERN.test(ascii)
      ? ascii
      : `post-${articleId.replace(/[^a-z0-9]/gi, "").slice(0, 8)}`;
    console.warn(
      `[slug] P-12から有効なslugを得られなかったためフォールバックします: ${base} (keyword=${keyword})`,
    );
  }

  const existing = new Set(await store.listSlugs());
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

async function saveQuality(
  store: Store,
  articleId: string,
  verdict: P04VerdictT,
  // 承認画面に法令チェックの結果を出すため quality に同梱する。
  // 専用の列を足さないのは、承認者が読むのは常に quality 1箇所だけで足りるようにするため
  compliance?: ComplianceReport,
): Promise<void> {
  await store.updateArticle(articleId, {
    quality: compliance ? { ...verdict, compliance } : verdict,
    quality_score: verdict.scores.total,
    hallucination_flags: verdict.hallucination_flags,
    commodity_score: verdict.commodity_score,
  });
}

async function reject(
  deps: OrchestratorDeps,
  article: ArticleRow,
  keyword: KeywordRow,
  reason: string,
  verdict?: P04VerdictT,
  extra?: Record<string, unknown>,
): Promise<ArticleRow> {
  // P-04で落ちた場合は判定を残す。理由を保存しないと「なぜ承認キューに乗らないのか」を
  // 後から追えず、閾値の問題か内容の問題かの切り分けができなくなる。
  // scores等はP-04を通った時だけ入る (lane_b_eligible=false等はverdictなし)。
  const patch: Partial<ArticleRow> = {
    status: "rejected",
    quality: verdict
      ? { ...verdict, ...extra, rejected_reason: reason }
      : { ...extra, rejected_reason: reason },
  };
  if (verdict) {
    patch.quality_score = verdict.scores.total;
    patch.commodity_score = verdict.commodity_score;
    patch.hallucination_flags = verdict.hallucination_flags;
  }
  await deps.store.updateArticle(article.id, patch);
  await deps.store.updateKeywordStatus(keyword.id, "parked");
  return (await deps.store.getArticle(article.id))!;
}
