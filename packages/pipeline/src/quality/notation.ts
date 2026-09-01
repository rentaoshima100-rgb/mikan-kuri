// 表記・構造の機械チェック (CLAUDE.md「品質ゲートの機械チェックにも実装する」)。
//
// P-04のルーブリックのうち、5.表記・文体 (10点) と 6.内部整合 (10点)、
// 4.構造 (15点) の一部は、LLMの判断を待たずに決定論的に判定できる。
// 実測 (却下19本) では、以下が全記事で減点対象になっていた:
//   - ダッシュ記号 (—) が本文・タイトルに混入        … 5/6本で検出、最大10箇所
//   - 1文60字超                                    … 全記事で13〜25文
//   - 問い形式見出しが9本中0〜2本                    … 全記事で構造点を損失
//   - CTAが3箇所以上 (上限2)                        … 却下19本中14本の修正指示に登場
// プロンプトに書いてあるだけでは守られないため、dedupeH2Sections と同じく
// 決定論的な安全網として実装する。
//
// 方針: 意味を変えない修正のみ自動適用し、書き換え判断が要るものは
// issue として返して改稿の修正指示に載せる。本文を機械が意訳しない。

export interface NotationIssue {
  code: NotationIssueCode;
  // 改稿プロンプトにそのまま載せる日本語の修正指示
  message: string;
  count: number;
  // 該当箇所の抜粋 (最大3件。プロンプトを膨らませすぎない)
  samples: string[];
}

export type NotationIssueCode =
  | "long_sentence"
  | "question_heading"
  | "cta_excess"
  | "ai_cliche"
  | "assertive"
  | "faq_count"
  | "raw_jsx"
  | "future_date";

export interface NotationResult {
  body: string;
  // 自動修正した内容 (ログ用)
  autofixed: { code: string; count: number }[];
  issues: NotationIssue[];
}

const MAX_SENTENCE_CHARS = 60;
const MAX_CTA = 2;
const FAQ_MIN = 4;
const FAQ_MAX = 6;
const SAMPLE_LIMIT = 3;

// AIが定型的に差し込む言い回し。P-04のnotation「AI定型句なし」で減点される。
const AI_CLICHES = [
  "と言えるでしょう",
  "と言っても過言ではありません",
  "に他なりません",
  "にほかなりません",
  "鍵となります",
  "鍵を握ります",
  "重要なポイントです",
  "言うまでもありません",
  "ぜひ参考にしてください",
  "いかがでしたでしょうか",
  "まさに",
  "非常に重要です",
];

// 断定・最上級表現。P-04のcoherence「禁止表現なし」で減点される。
const ASSERTIVE = [
  "最も合理的",
  "最も効果的",
  "必ず成功",
  "絶対に",
  "間違いなく",
  "確実に成果",
  "唯一の方法",
  "誰でも簡単に",
];

// CTAとみなすリンク先・文言
const CTA_PATTERN = /\[[^\]]*(?:無料診断|お問い合わせ|ご相談|料金プラン|料金ページ|見積)[^\]]*\]\([^)]*\)/g;

// ダッシュ記号。EMダッシュ・ENダッシュ・水平バーのみを対象にする。
// ハイフン (U+2010/U+2011) は語中の連結に使われうるので触らない。
// 半角ハイフン2連は前後を空白で挟んだ場合だけ (CLIオプション --redo を壊さない)。
const DASH_CHARS = /\s*[—–―]\s*/g;
const DASH_ASCII = /(?<=\S)\s+--\s+(?=\S)/g;

// コードフェンス・表の区切り行・水平線を編集対象から外す。
// 表の `|---|---|` や `---` を壊すと記事が崩れるため、行単位で除外する。
function isProtectedLine(line: string): boolean {
  const t = line.trim();
  if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(t) && t.includes("-")) return true; // 表の区切り
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return true; // 水平線
  return false;
}

// 行を「コードフェンスの外か」で分類しつつ処理する共通ヘルパ
function mapOutsideCode(body: string, fn: (line: string) => string): string {
  let inFence = false;
  return body
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence || isProtectedLine(line)) return line;
      return fn(line);
    })
    .join("\n");
}

function linesOutsideCode(body: string): string[] {
  let inFence = false;
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out;
}

// LLMは本文を ```mdx フェンスで包み、YAMLフロントマターとMDXのimport文を付けて返すことがある。
// 配信先は build.js のプレーンなmarkdownビルドなので、これが素通りすると
// 記事全体が <pre><code> の中に落ちて本文が読めなくなる (2026-07-30に本番で発生)。
// タイトル・説明文はサイト側のBLOG配列が正なので、フロントマターは捨ててよい。
export function sanitizeArticleBody(raw: string): string {
  let body = raw.trim();
  // 1. 本文全体を包む外側のコードフェンスを外す (中の ``` は残す)
  const fenced = /^```[A-Za-z]*\r?\n([\s\S]*?)\r?\n```$/.exec(body);
  if (fenced) body = fenced[1]!.trim();
  // 2. 先頭のYAMLフロントマター。直後が --- で閉じる形のみを対象にし、
  //    本文中の水平線 (---) を誤って食べないよう先頭限定で1回だけ剥がす。
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(body);
  if (fm) body = body.slice(fm[0].length).trim();
  // 3. 本文先頭のH1。ページのH1は記事タイトル (BLOG配列) からサイト側が出すため、
  //    本文にH1があると1ページに2つのH1が並ぶ。しかも改稿AIは記事タイトルとは
  //    別の見出しを立てることがあり、<title>/JSON-LD headline と食い違って
  //    「このページは何の記事か」の信号が割れる (2026-07-31に公開2本で発生)。
  //    本文中のH1は全てH2へ落とす (見出しの内容は失わない)。
  body = demoteBodyH1(body);

  // 4. MDXのimport/export文 (プレーンmarkdownでは意味を持たず、そのまま表示される)。
  //    技術記事はコードブロック内に正当なimport文を載せるので、フェンス内は必ず残す。
  let inFence = false;
  body = body
    .split("\n")
    .filter((l) => {
      if (/^\s*(```|~~~)/.test(l)) {
        inFence = !inFence;
        return true;
      }
      return inFence || !/^\s*(import|export)\s+\S/.test(l);
    })
    .join("\n");
  return body.replace(/\n{3,}/g, "\n\n").trim();
}

// 本文中のH1をH2へ落とす。コードフェンス内 (markdownの例示など) は触らない。
export function demoteBodyH1(body: string): string {
  let inFence = false;
  return body
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(/^#\s+/, "## ");
    })
    .join("\n");
}

// 意味を変えないダッシュ除去。見出しでは全角コロン、本文では読点に置き換える。
// 「A — B」は日本語では読点で繋ぐのが自然で、見出しでは読点だと読みにくいため分ける。
export function stripDashes(body: string): { body: string; count: number } {
  let count = 0;
  const fixed = mapOutsideCode(body, (line) => {
    const isHeading = /^\s*#{1,6}\s/.test(line);
    const sep = isHeading ? "：" : "、";
    let out = line.replace(DASH_ASCII, () => {
      count += 1;
      return sep;
    });
    out = out.replace(DASH_CHARS, () => {
      count += 1;
      return sep;
    });
    if (out === line) return line;
    // 置換で「、、」「：：」や行頭・行末の宙に浮いた区切りが生じたら畳む
    return out
      .replace(/、{2,}/g, "、")
      .replace(/：{2,}/g, "：")
      .replace(/[、：]\s*$/, "")
      .replace(/^(\s*#{1,6})\s*[、：]\s*/, "$1 ")
      .replace(/^(\s*(?:[-*+]|\d+\.))\s*[、：]\s*/, "$1 ")
      .replace(/^[、：]\s*/, "");
  });
  return { body: fixed, count };
}

// 1文の長さ。句点で切り、見出し・表・箇条書き記号を除いた地の文だけを見る。
export function findLongSentences(body: string): string[] {
  const prose = linesOutsideCode(body).filter(
    (l) => !/^\s*#{1,6}\s/.test(l) && !/^\s*\|/.test(l) && l.trim() !== "",
  );
  const long: string[] = [];
  for (const line of prose) {
    const text = line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "");
    for (const s of text.split("。")) {
      // markdownの装飾・リンクは文字数に数えない (読者が読む字数で判定する)
      const plain = s
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`>]/g, "")
        .trim();
      if (plain.length > MAX_SENTENCE_CHARS) long.push(plain);
    }
  }
  return long;
}

// 問い形式のH2見出し (P-04 構造点)。FAQ見出しは別途カウントするので除く。
export function analyzeHeadings(body: string): { total: number; question: number } {
  const h2 = linesOutsideCode(body)
    .filter((l) => /^##\s+\S/.test(l) && !/^###/.test(l))
    .map((l) => l.replace(/^##\s+/, "").trim())
    .filter((h) => !/FAQ|よくある(ご)?質問/i.test(h));
  const question = h2.filter((h) => /(か|？|\?)\s*$/.test(h)).length;
  return { total: h2.length, question };
}

// FAQの設問数。実際の生成物は書き方が揺れる (`### 問い` / `**Q. 問い**` /
// 太字の問い / `<FAQ items={[{q: "..."}]} />`)。どれか1つしか数えないと
// 0問と誤検出して無意味な修正指示を出すため、いずれの形も1問として数える。
function faqQuestionCount(body: string): number | null {
  const lines = linesOutsideCode(body);
  const start = lines.findIndex((l) => /^##\s+.*(FAQ|よくある(ご)?質問)/i.test(l));
  if (start < 0) return null;
  let n = 0;
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+\S/.test(line)) break;
    const t = line.trim();
    if (/^###\s+\S/.test(t)) n += 1;
    else if (/^\*{0,2}Q\s*[.．:：]\s*\S/.test(t)) n += 1;
    else if (/^\*\*.+\*\*$/.test(t)) n += 1; // 太字だけの行 = 問い
    else if (/^(q|question)\s*:\s*["']/i.test(t)) n += 1; // JSXのFAQデータ
    else if (/^<summary\b/.test(t)) n += 1; // <details><summary>形式
  }
  return n;
}

function countMatches(body: string, needles: string[]): { count: number; samples: string[] } {
  const text = linesOutsideCode(body).join("\n");
  const samples: string[] = [];
  let count = 0;
  for (const n of needles) {
    const hits = text.split(n).length - 1;
    if (hits > 0) {
      count += hits;
      if (samples.length < SAMPLE_LIMIT) samples.push(n);
    }
  }
  return { count, samples };
}

// MDXのJSXコンポーネント (<FAQSchema ... />、<section>等)。
// 配信先はプレーンmarkdownなのでそのまま文字として表示される。
// 種類も入れ子も一定しないため機械では消さず、改稿で外させる。
// (v3訂正によりFAQPage構造化データは出力しない方針でもある)
// 公開日より未来の日付を、すでに起きたこととして断定していないか。
// 「2027年3月まで有効」のように未来を未来として書くのは正常なので、
// 同じ文に過去形や公表を表す語がある場合だけを違反とする。
// 未来の調査を「公表されました」と書く誤りは実際に発生しており、
// E-E-A-Tとcoherenceを同時に落としつつハルシネーションフラグにも載る。
// 日付の比較は完全に機械判定できるのに、これまでチェックが無かった。
const PAST_MARKERS = /(しました|されました|した|された|公表|発表|報告|判明|記録)/;

export function findFutureDatedClaims(body: string, now: Date): string[] {
  const y0 = now.getFullYear();
  const m0 = now.getMonth() + 1;
  const out: string[] = [];
  for (const sentence of linesOutsideCode(body).join("\n").split(/[。\n]/)) {
    if (!PAST_MARKERS.test(sentence)) continue;
    for (const m of sentence.matchAll(/(20[2-9][0-9])年(?:\s*([0-9]{1,2})月)?/g)) {
      const y = Number(m[1]);
      const mo = m[2] ? Number(m[2]) : 1;
      if (y > y0 || (y === y0 && mo > m0)) {
        out.push(sentence.trim().slice(0, 80));
        break;
      }
    }
  }
  return [...new Set(out)];
}

function findRawJsx(body: string): string[] {
  const hits = linesOutsideCode(body)
    .map((l) => l.trim())
    .filter(
      (l) =>
        // 大文字始まりのコンポーネント (<ArticleMeta ... や単独行の <FAQSchema)
        /^<\/?[A-Z][A-Za-z0-9]*(\s|\/?>|$)/.test(l) ||
        // JSX固有の属性を持つ小文字タグ (<div className="...">)
        /^<[a-z][A-Za-z0-9]*\s[^>]*\bclassName=/.test(l) ||
        /^<\/?(section|details|summary)\b/.test(l),
    );
  return [...new Set(hits)];
}

// 本文を機械チェックし、意味を変えない修正だけ適用して結果を返す。
export function checkNotation(rawBody: string, now: Date = new Date()): NotationResult {
  const autofixed: { code: string; count: number }[] = [];
  const body = sanitizeArticleBody(rawBody);
  if (body !== rawBody.trim()) autofixed.push({ code: "sanitize", count: 1 });
  const dash = stripDashes(body);
  if (dash.count > 0) autofixed.push({ code: "dash", count: dash.count });
  const fixedBody = dash.body;

  const issues: NotationIssue[] = [];

  const long = findLongSentences(fixedBody);
  if (long.length > 0) {
    issues.push({
      code: "long_sentence",
      message:
        `1文が${MAX_SENTENCE_CHARS}字を超える文が${long.length}件あります。` +
        `該当文を句点で分割し、1文${MAX_SENTENCE_CHARS}字以内に収めてください (意味は変えない)。`,
      count: long.length,
      samples: long.slice(0, SAMPLE_LIMIT),
    });
  }

  const heads = analyzeHeadings(fixedBody);
  if (heads.total > 0 && heads.question * 2 < heads.total) {
    issues.push({
      code: "question_heading",
      message:
        `H2見出し${heads.total}本のうち問い形式は${heads.question}本です。` +
        `半数以上を読者の疑問形 (「〜はどれくらいかかるのか」等) に書き換えてください。` +
        `見出しの指す内容は変えないこと。`,
      count: heads.total - heads.question,
      samples: [],
    });
  }

  const ctas = linesOutsideCode(fixedBody).join("\n").match(CTA_PATTERN) ?? [];
  if (ctas.length > MAX_CTA) {
    issues.push({
      code: "cta_excess",
      message:
        `CTAリンクが${ctas.length}箇所あります (上限${MAX_CTA})。` +
        `FAQセクション内および記事中盤のCTAを削除し、本文末尾の1〜2箇所に集約してください。`,
      count: ctas.length,
      samples: ctas.slice(0, SAMPLE_LIMIT),
    });
  }

  const cliche = countMatches(fixedBody, AI_CLICHES);
  if (cliche.count > 0) {
    issues.push({
      code: "ai_cliche",
      message:
        `AI定型句が${cliche.count}箇所あります。具体的な事実の記述に置き換えるか削除してください。`,
      count: cliche.count,
      samples: cliche.samples,
    });
  }

  const assertive = countMatches(fixedBody, ASSERTIVE);
  if (assertive.count > 0) {
    issues.push({
      code: "assertive",
      message:
        `断定・最上級の禁止表現が${assertive.count}箇所あります。` +
        `条件つきの表現 (「〜の場合は有効です」等) に改めてください。`,
      count: assertive.count,
      samples: assertive.samples,
    });
  }

  const jsx = findRawJsx(fixedBody);
  if (jsx.length > 0) {
    issues.push({
      code: "raw_jsx",
      message:
        `MDXのJSXタグが${jsx.length}種類残っています。配信先はプレーンなmarkdownのため、` +
        `該当タグを削除し、内容は通常の見出し・表・箇条書きで書き直してください。`,
      count: jsx.length,
      samples: jsx.slice(0, SAMPLE_LIMIT).map((s) => s.slice(0, 60)),
    });
  }

  const future = findFutureDatedClaims(fixedBody, now);
  if (future.length > 0) {
    issues.push({
      code: "future_date",
      message:
        `公開日より未来の日付を、すでに起きたこととして書いている箇所が${future.length}件あります。` +
        `日付の誤りか、未発表の情報を断定しています。日付を確認し、確定していないなら記述を削除してください。`,
      count: future.length,
      samples: future.slice(0, SAMPLE_LIMIT),
    });
  }

  const faq = faqQuestionCount(fixedBody);
  if (faq !== null && (faq < FAQ_MIN || faq > FAQ_MAX)) {
    issues.push({
      code: "faq_count",
      message: `FAQが${faq}問です。${FAQ_MIN}〜${FAQ_MAX}問に調整してください。`,
      count: faq,
      samples: [],
    });
  }

  return { body: fixedBody, autofixed, issues };
}

// 改稿プロンプトに載せる修正指示。P-04のfix_instructionsと同じ配列に混ぜる。
export function notationFixInstructions(issues: NotationIssue[]): string[] {
  return issues.map((i) => {
    const ex = i.samples.length ? `（例: ${i.samples.map((s) => `「${s}」`).join(" / ")}）` : "";
    return `【機械チェック】${i.message}${ex}`;
  });
}

// P-04に渡す機械計測値。表記(項目5)と内部整合(項目6)は、実測では判定者の勘で
// ほぼ固定値になっていた (notation 26/31本が8点、coherence 23/31本が7点)。
// 数えられるものは数えて渡し、印象採点をやめさせる。
export function mechanicalCheckReport(body: string): string {
  const result = checkNotation(body);
  const count = (code: NotationIssueCode) =>
    result.issues.find((i) => i.code === code)?.count ?? 0;
  const heads = analyzeHeadings(result.body);
  const lines = [
    "本文を機械計測した結果です。該当項目は印象ではなくこの件数で採点してください。",
    `- ダッシュ記号 (—、--) の違反: 0件 (生成時に自動除去済み)`,
    `- 1文60字超の文: ${count("long_sentence")}件`,
    `- AI定型句: ${count("ai_cliche")}件`,
    `- 断定・最上級の禁止表現: ${count("assertive")}件`,
    `- CTAリンク: ${count("cta_excess") || "2以下"}箇所 (上限2)`,
    `- 同一H2の重複: 0件 (生成時に自動除去済み)`,
    `- H2見出し ${heads.total}本のうち問い形式: ${heads.question}本`,
    `- MDXのJSXタグの残存: ${count("raw_jsx")}種類`,
    `- 公開日より未来の日付を過去形で断定: ${count("future_date")}件`,
  ];
  return lines.join("\n");
}

export function summarizeNotation(result: NotationResult): string {
  const fixed = result.autofixed.map((a) => `${a.code}×${a.count}`).join(", ") || "なし";
  const remaining = result.issues.map((i) => `${i.code}×${i.count}`).join(", ") || "なし";
  return `自動修正: ${fixed} / 要改稿: ${remaining}`;
}
