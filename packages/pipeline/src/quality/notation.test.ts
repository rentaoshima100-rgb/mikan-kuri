import { describe, expect, it } from "vitest";
import {
  analyzeHeadings,
  checkNotation,
  demoteBodyH1,
  findFutureDatedClaims,
  findLongSentences,
  mechanicalCheckReport,
  notationFixInstructions,
  sanitizeArticleBody,
  stripDashes,
} from "./notation.js";

describe("sanitizeArticleBody", () => {
  it("本文全体を包む```mdxフェンスとフロントマターとimportを外す", () => {
    const raw = [
      "```mdx",
      "---",
      'title: "タイトル"',
      'description: "説明"',
      "---",
      "",
      "import { Callout } from '@/components/callout'",
      "",
      "## 見出し",
      "",
      "本文です。",
      "```",
    ].join("\n");
    expect(sanitizeArticleBody(raw)).toBe("## 見出し\n\n本文です。");
  });

  it("本文中のコードフェンスは残す", () => {
    const raw = ["```mdx", "## 手順", "", "```bash", "npm test", "```", "", "以上です。", "```"].join(
      "\n",
    );
    expect(sanitizeArticleBody(raw)).toBe("## 手順\n\n```bash\nnpm test\n```\n\n以上です。");
  });

  it("本文中の水平線をフロントマターと誤認しない", () => {
    const raw = ["## 見出し", "", "本文。", "", "---", "", "## 次の見出し"].join("\n");
    expect(sanitizeArticleBody(raw)).toBe(raw);
  });

  it("コードブロック内の正当なimport文は消さない", () => {
    const raw = [
      "```mdx",
      "import { Callout } from '@/components/callout'",
      "",
      "## 計測コード",
      "",
      "```javascript",
      "import { onLCP } from 'web-vitals/attribution';",
      "onLCP(console.log);",
      "```",
      "```",
    ].join("\n");
    const out = sanitizeArticleBody(raw);
    expect(out).not.toContain("@/components/callout");
    expect(out).toContain("import { onLCP } from 'web-vitals/attribution';");
  });

  it("汚染のない本文はそのまま返す", () => {
    const raw = "## 見出し\n\n本文です。";
    expect(sanitizeArticleBody(raw)).toBe(raw);
  });
});

describe("stripDashes", () => {
  it("本文の全角ダッシュを読点にする", () => {
    const r = stripDashes("SEOとGEOは別物です — 施策の起点が違います。");
    expect(r.body).toBe("SEOとGEOは別物です、施策の起点が違います。");
    expect(r.count).toBe(1);
  });

  it("見出しのダッシュは全角コロンにする", () => {
    const r = stripDashes("## SEOとGEO — 両睨みの型");
    expect(r.body).toBe("## SEOとGEO：両睨みの型");
  });

  it("表の区切り行と水平線は壊さない", () => {
    const src = ["| 項目 | 説明 |", "|---|---|", "| A | B |", "", "---"].join("\n");
    expect(stripDashes(src).body).toBe(src);
  });

  it("コードフェンス内は触らない", () => {
    const src = ["```", "npx tsx x.ts -- --redo — raw", "```"].join("\n");
    expect(stripDashes(src).body).toBe(src);
  });

  it("CLIオプションの半角ハイフン2連は残す", () => {
    const src = "`npx tsx scripts/refit_batch.ts --redo` を実行します。";
    expect(stripDashes(src).body).toBe(src);
  });

  it("空白で挟んだ半角ハイフン2連は置換する", () => {
    expect(stripDashes("結論は単純です -- 先に型を決めます。").body).toBe(
      "結論は単純です、先に型を決めます。",
    );
  });

  it("行頭のダッシュは宙に浮いた区切りを残さない", () => {
    expect(stripDashes("— 補足です。").body).toBe("補足です。");
    expect(stripDashes("- — 補足です。").body).toBe("- 補足です。");
  });

  it("ダッシュが無ければ完全に無変更", () => {
    const src = "## E-E-A-Tの考え方\n\n本文です。\n";
    const r = stripDashes(src);
    expect(r.body).toBe(src);
    expect(r.count).toBe(0);
  });
});

describe("findLongSentences", () => {
  it("60字超の地の文だけ拾う", () => {
    const long = "あ".repeat(61);
    const src = ["## " + "い".repeat(80), long + "。", "短い文です。"].join("\n");
    expect(findLongSentences(src)).toEqual([long]);
  });

  it("リンク記法は表示文字数で数える", () => {
    const label = "う".repeat(20);
    const src = `[${label}](https://example.com/very/long/path/that/should/not/count)です。`;
    expect(findLongSentences(src)).toEqual([]);
  });
});

describe("analyzeHeadings", () => {
  it("問い形式のH2を数え、FAQ見出しは除く", () => {
    const src = [
      "## 費用はどれくらいかかるのか",
      "## 進め方の全体像",
      "## よくあるご質問",
      "### Q1",
    ].join("\n");
    expect(analyzeHeadings(src)).toEqual({ total: 2, question: 1 });
  });
});

describe("checkNotation", () => {
  const clean = [
    "## 費用はどれくらいかかるのか",
    "初期費用は60万円からです。",
    "## どの順番で進めるのか",
    "先に要件を決めます。",
    "## よくあるご質問",
    "### 納期はどれくらいですか",
    "約2か月です。",
    "### 保守は含まれますか",
    "別契約です。",
    "### 途中で変更できますか",
    "できます。",
    "### 支払い方法は選べますか",
    "選べます。",
  ].join("\n");

  it("違反のない本文はissueを出さない", () => {
    const r = checkNotation(clean);
    expect(r.issues).toEqual([]);
    expect(r.autofixed).toEqual([]);
    expect(r.body).toBe(clean);
  });

  it("ダッシュは自動修正し、autofixedに記録する", () => {
    const r = checkNotation(clean.replace("初期費用は", "初期費用は — "));
    expect(r.body).not.toContain("—");
    expect(r.autofixed).toEqual([{ code: "dash", count: 1 }]);
  });

  it("CTAが上限を超えたら検出する", () => {
    const ctas = [
      "[無料診断はこちら](https://kuri-mikan.jp/diagnosis)",
      "[お問い合わせ](https://kuri-mikan.jp/contact)",
      "[料金プラン](https://kuri-mikan.jp/pricing)",
    ].join("\n");
    const issue = checkNotation(clean + "\n" + ctas).issues.find((i) => i.code === "cta_excess");
    expect(issue?.count).toBe(3);
  });

  it("問い形式見出しが半数未満なら検出する", () => {
    const src = ["## 進め方の全体像", "本文。", "## 費用の考え方", "本文。"].join("\n");
    expect(checkNotation(src).issues.map((i) => i.code)).toContain("question_heading");
  });

  it("AI定型句と断定表現を検出する", () => {
    const src = clean + "\nこれは最も合理的な選択と言えるでしょう。";
    const codes = checkNotation(src).issues.map((i) => i.code);
    expect(codes).toContain("ai_cliche");
    expect(codes).toContain("assertive");
  });

  it("FAQの問数が範囲外なら検出する", () => {
    const src = ["## よくあるご質問", "### Q1", "答え。"].join("\n");
    const issue = checkNotation(src).issues.find((i) => i.code === "faq_count");
    expect(issue?.count).toBe(1);
  });

  it("FAQ見出しが無ければFAQ数は検査しない", () => {
    const src = ["## 進め方はどうなるのか", "本文。"].join("\n");
    expect(checkNotation(src).issues.map((i) => i.code)).not.toContain("faq_count");
  });
});

describe("notationFixInstructions", () => {
  it("機械チェック印つきの指示文にする", () => {
    const issues = checkNotation("## 概要\n" + "あ".repeat(61) + "。").issues;
    const fixes = notationFixInstructions(issues);
    expect(fixes.every((f) => f.startsWith("【機械チェック】"))).toBe(true);
    expect(fixes.some((f) => f.includes("60字"))).toBe(true);
  });
});

describe("mechanicalCheckReport: P-04に渡す機械計測", () => {
  it("採点に使える件数を日本語で列挙する", () => {
    const body = [
      "## 進め方の全体像",
      "あ".repeat(61) + "。",
      "これは最も合理的な選択と言えるでしょう。",
      "[無料診断](https://x/a)",
      "[お問い合わせ](https://x/b)",
      "[料金プラン](https://x/c)",
    ].join("\n");
    const r = mechanicalCheckReport(body);
    expect(r).toContain("1文60字超の文: 1件");
    expect(r).toContain("AI定型句: 1件");
    expect(r).toContain("断定・最上級の禁止表現: 1件");
    expect(r).toContain("CTAリンク: 3箇所");
    expect(r).toContain("問い形式: 0本");
  });

  it("違反がなければCTAは上限内と示す", () => {
    const r = mechanicalCheckReport("## 費用はどれくらいかかるのか\n\n短い文です。");
    expect(r).toContain("CTAリンク: 2以下箇所");
    expect(r).toContain("1文60字超の文: 0件");
  });
});

describe("findFutureDatedClaims: 未来の日付を過去形で断定していないか", () => {
  const now = new Date("2026-07-31T00:00:00Z");

  it("未来の調査を公表済みとして書いていたら検出する", () => {
    const body = "サイバーエージェントの調査（2027年2月）では利用率が37.0%と公表されました。";
    expect(findFutureDatedClaims(body, now)).toHaveLength(1);
  });

  it("未来を未来として書くのは正常 (補助金の有効期限など)", () => {
    const body = "この補助金は2027年3月まで申請できます。";
    expect(findFutureDatedClaims(body, now)).toEqual([]);
  });

  it("過去の調査は検出しない", () => {
    const body = "2026年2月の調査で37.0%と公表されました。";
    expect(findFutureDatedClaims(body, now)).toEqual([]);
  });

  it("同じ年でも未来の月なら検出する", () => {
    const body = "2026年12月に発表された統計によると増加しました。";
    expect(findFutureDatedClaims(body, now)).toHaveLength(1);
  });

  it("checkNotationのissueとして出る", () => {
    const r = checkNotation("2028年5月に公表されました。", now);
    expect(r.issues.map((i) => i.code)).toContain("future_date");
  });
});

describe("demoteBodyH1: 本文のH1をH2へ落とす", () => {
  it("本文先頭のH1をH2にする (ページのH1は記事タイトル)", () => {
    const src = "# 別のタイトル\n\n本文です。";
    expect(demoteBodyH1(src)).toBe("## 別のタイトル\n\n本文です。");
  });

  it("H2以下はそのまま", () => {
    const src = "## 見出し\n\n### 小見出し";
    expect(demoteBodyH1(src)).toBe(src);
  });

  it("コードフェンス内のmarkdown例示は触らない", () => {
    const src = ["```markdown", "# 見出しの例", "```"].join("\n");
    expect(demoteBodyH1(src)).toBe(src);
  });

  it("sanitizeArticleBody から適用される", () => {
    const out = sanitizeArticleBody("# 記事タイトル\n\n本文です。");
    expect(out).toContain("## 記事タイトル");
    expect(out).not.toMatch(/^#\s/m);
  });
});
