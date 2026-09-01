// 食品表示のコンプライアンスゲート (薬機法 / 健康増進法 / 景品表示法 / 特別栽培農産物ガイドライン)。
//
// なぜ機械チェックが要るか:
//   Googleの scaled content abuse は「順位が落ちる」で済むが、こちらは違う。
//   生鮮食品の通販で効能効果を書けば薬機法、根拠のない最上級表現を書けば景表法、
//   「無農薬」と書けば特別栽培農産物に係る表示ガイドラインに触れる。行政指導は
//   サイトではなく販売者 (株式会社くり房) に来る。プロンプトの自主規制だけに
//   任せてよい種類のリスクではない。
//
// 判定は決定論のみ (LLM不使用)。理由:
//   - LLMの判定は揺れる。同じ本文が日によって通ったり落ちたりする状態で
//     「法令チェック済み」と言えない
//   - 落とすべき表現はほぼ定型句なので、字面で十分に捕まる
//   - APIコストと実行時間がゼロなので、生成のどの段階でも何度でも呼べる
//
// severity:
//   block — 全自動公開中でも必ず止める (フェイルクローズド)。表現を直さない限り公開しない
//   warn  — 修正指示として書き手に返し、承認画面にも出す。公開自体は止めない

export type ComplianceCategory =
  | "yakkiho" // 薬機法: 医薬品的な効能効果の標榜
  | "kenko_zoshin" // 健康増進法: 健康保持増進効果の誇大表示
  | "keihyo_saijokyu" // 景品表示法: 根拠のない最上級・No.1表現 (優良誤認)
  | "keihyo_dangen" // 景品表示法: 断定的表現
  | "nouyaku_hyoji" // 特別栽培農産物に係る表示ガイドライン: 無農薬・減農薬等
  | "yuki_jas"; // 有機JAS: 認証なしの「有機」「オーガニック」

export interface ComplianceRule {
  category: ComplianceCategory;
  severity: "block" | "warn";
  // 検出パターン。日本語なので単語境界は使えない
  pattern: RegExp;
  // 承認者と書き手に返す説明。「なぜ駄目か」と「どう書けばよいか」をセットで持つ
  reason: string;
  suggestion: string;
}

export interface ComplianceViolation {
  category: ComplianceCategory;
  severity: "block" | "warn";
  matched: string;
  // 前後の文脈。承認画面で本文のどこかを探さずに判断できるようにする
  context: string;
  reason: string;
  suggestion: string;
}

export interface ComplianceReport {
  violations: ComplianceViolation[];
  blocked: boolean;
  // P-02 / P-13b へ渡す修正指示 (fix_instructions と同じ形)
  fixInstructions: string[];
}

// 医薬品的な効能効果。生鮮食品や加工食品でこれを書くと、
// 「医薬品でないものを医薬品のように売っている」ことになる (薬機法68条)
const YAKKIHO_EFFECTS = [
  "免疫力(?:を)?(?:アップ|向上|高め|上げ)",
  "免疫力強化",
  "風邪(?:を)?(?:予防|防ぐ|ひかない)",
  "インフルエンザ(?:を)?予防",
  "がん(?:を)?予防",
  "ガン(?:を)?予防",
  "生活習慣病(?:を)?(?:予防|防ぐ)",
  "動脈硬化(?:を)?(?:予防|防ぐ)",
  "血圧(?:を)?(?:下げ|下がる)",
  "血糖値(?:を)?(?:下げ|下がる)",
  "コレステロール(?:を)?(?:下げ|下がる)",
  "疲労(?:を)?回復",
  "疲労回復",
  "便秘(?:を)?(?:解消|改善|治)",
  "デトックス",
  "毒素(?:を)?(?:排出|出す)",
  "解毒",
  "老化(?:を)?(?:防止|防ぐ)",
  "アンチエイジング",
  "若返り",
  "美肌(?:効果|になる)",
  "シミ(?:を)?(?:防ぐ|消える|改善)",
  "二日酔い(?:に)?効",
  "花粉症(?:に)?効",
  "花粉症(?:が)?(?:治|改善|緩和)",
  "貧血(?:を)?(?:改善|治)",
  "冷え性(?:が|を)?(?:改善|治)",
  "不眠(?:が|を)?(?:改善|治)",
  "ストレス(?:を)?(?:解消|軽減)する効果",
  "脂肪(?:を)?(?:燃焼|落とす)",
  "痩せる",
  "ダイエット効果",
  "代謝(?:を)?(?:上げ|高め)",
  "整腸作用",
  "薬効",
  "治療",
  "症状(?:が)?(?:改善|和らぐ)",
];

// 健康増進法: 特定の保健効果があるかのような誇大な表現。
// 特定保健用食品・機能性表示食品の届出がない限り書けない
const KENKO_ZOSHIN = [
  "健康(?:に)?なれ(?:る|ます)",
  "病気(?:に)?ならない",
  "医者(?:いらず|要らず)",
  "薬(?:に)?頼らな(?:い|くて)",
  "毎日食べれば健康",
  "健康効果(?:が)?(?:高い|あります)",
  "体質(?:が)?改善",
];

// 景品表示法5条1号 (優良誤認)。合理的根拠 (第三者調査等) を示せない最上級表現。
// 客観的な受賞・認定がある場合は compliance_allowlist に登録して個別に許可する
const SAIJOKYU = [
  "日本一",
  "世界一",
  "日本初",
  "業界最安",
  "最高級",
  "最高品質",
  "最高の品質",
  "最上級",
  "No\\.?1",
  "ナンバーワン",
  "ナンバー1",
  "他社(?:を)?圧倒",
  "他(?:の)?産地(?:より|を)(?:上回|凌駕)",
  "比類のない",
  "唯一無二",
];

// 断定・保証にあたる表現。味覚は主観なので「必ず」「絶対」は保証にあたる
const DANGEN = [
  "絶対に(?:美味|おい)し",
  "誰(?:が|も)食べても(?:美味|おい)し",
  "必ず(?:満足|美味|おい)",
  "100%(?:満足|甘い)",
  "はずれ(?:が)?(?:ない|ありません)",
  "失敗しません",
];

// 特別栽培農産物に係る表示ガイドライン。
// 「無農薬」「減農薬」「無化学肥料」は消費者に誤認を与えるため表示できない。
// 正しくは「節減対象農薬:当地比◯割減」「節減対象農薬 不使用」等
const NOUYAKU = ["無農薬", "減農薬", "農薬(?:を)?(?:一切)?使(?:わ|用し)(?:ない|ていません)", "無化学肥料"];

// 有機JAS認証を受けていない農産物に「有機」「オーガニック」は使えない (JAS法)
const YUKI = ["有機栽培", "オーガニック", "有機みかん", "有機柑橘"];

function rulesFrom(
  patterns: string[],
  category: ComplianceCategory,
  severity: "block" | "warn",
  reason: string,
  suggestion: string,
): ComplianceRule[] {
  return patterns.map((p) => ({
    category,
    severity,
    pattern: new RegExp(p, "g"),
    reason,
    suggestion,
  }));
}

export const COMPLIANCE_RULES: ComplianceRule[] = [
  ...rulesFrom(
    YAKKIHO_EFFECTS,
    "yakkiho",
    "block",
    "医薬品的な効能効果の標榜にあたります (薬機法68条)。食品では書けません",
    "成分名と含有の事実までにとどめてください (例:「ビタミンCを多く含みます」)。" +
      "その成分が体にどう働くかは書かないでください",
  ),
  ...rulesFrom(
    KENKO_ZOSHIN,
    "kenko_zoshin",
    "block",
    "健康保持増進効果の誇大表示にあたります (健康増進法65条)",
    "健康への効果を語らず、味・産地・栽培・食べ方の話に置き換えてください",
  ),
  ...rulesFrom(
    SAIJOKYU,
    "keihyo_saijokyu",
    "block",
    "合理的根拠を示せない最上級表現は優良誤認のおそれがあります (景品表示法5条1号)",
    "客観的な事実に置き換えてください (例:「糖度13度以上のものを選別しています」)。" +
      "受賞歴など根拠がある場合は出典を併記し、compliance_allowlist に登録してください",
  ),
  ...rulesFrom(
    DANGEN,
    "keihyo_dangen",
    "warn",
    "味覚は主観であり、断定・保証にあたる表現は避けてください",
    "「〜と好評です」「当店では〜を基準に選別しています」のように事実で書いてください",
  ),
  ...rulesFrom(
    NOUYAKU,
    "nouyaku_hyoji",
    "block",
    "特別栽培農産物に係る表示ガイドラインにより「無農薬」「減農薬」等は表示できません",
    "「節減対象農薬:当地比◯割減」「節減対象農薬 不使用」等、" +
      "ガイドラインに沿った表記のみを使ってください。確認できない場合は栽培方法に触れないでください",
  ),
  ...rulesFrom(
    YUKI,
    "yuki_jas",
    "block",
    "有機JAS認証を受けていない農産物に「有機」「オーガニック」は使えません (JAS法)",
    "認証がない場合は使用しないでください。栽培のこだわりは具体的な作業内容で書いてください",
  ),
];

const CONTEXT_CHARS = 30;

/**
 * 本文・タイトル・メタディスクリプションをまとめて検査する。
 *
 * allowlist は「根拠を示せるので使ってよい」と代表が判断した表現。
 * 完全一致ではなく、検出箇所の文脈に allowlist の文字列が含まれていれば見逃す
 * (例: 「宇和島市推奨」を登録すると、その近くの最上級表現を許可する)。
 */
export function checkCompliance(
  text: string,
  opts: { allowlist?: string[]; extraRules?: ComplianceRule[] } = {},
): ComplianceReport {
  const allowlist = (opts.allowlist ?? []).filter(Boolean);
  const violations: ComplianceViolation[] = [];
  const seen = new Set<string>();

  for (const rule of [...COMPLIANCE_RULES, ...(opts.extraRules ?? [])]) {
    // gフラグ付きの正規表現は lastIndex を持ち回るので、毎回リセットしてから使う
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      const start = Math.max(0, m.index - CONTEXT_CHARS);
      const context = text.slice(start, m.index + m[0].length + CONTEXT_CHARS).replace(/\n/g, " ");
      if (allowlist.some((a) => context.includes(a))) continue;

      // 同じ表現が何度出ても指示は1本でよい (修正指示が同じ文で埋まるのを防ぐ)
      const key = `${rule.category}:${m[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);

      violations.push({
        category: rule.category,
        severity: rule.severity,
        matched: m[0],
        context,
        reason: rule.reason,
        suggestion: rule.suggestion,
      });
      // 空マッチで無限ループしないように進める
      if (m[0].length === 0) rule.pattern.lastIndex++;
    }
  }

  return {
    violations,
    blocked: violations.some((v) => v.severity === "block"),
    fixInstructions: violations.map(
      (v) => `【法令】「${v.matched}」を削除または書き換えてください。${v.reason}。${v.suggestion}`,
    ),
  };
}

/** 承認画面とログ向けの1行要約。 */
export function summarizeCompliance(report: ComplianceReport): string {
  if (!report.violations.length) return "法令チェック: 指摘なし";
  const blocks = report.violations.filter((v) => v.severity === "block").length;
  const warns = report.violations.length - blocks;
  return `法令チェック: 要修正${blocks}件 / 注意${warns}件 — ${report.violations
    .map((v) => v.matched)
    .join(", ")}`;
}
