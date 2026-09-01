import { describe, expect, it } from "vitest";
import { convertJsxToMarkdown } from "./jsx_to_markdown.js";

describe("convertJsxToMarkdown", () => {
  it("CTABlockを見出し・本文・リンクに開く", () => {
    const src = [
      "本文です。",
      "",
      "<CTABlock",
      '  heading="御社の状況を確認したい方へ"',
      '  body="無料診断では現状をヒアリングします。"',
      '  href="/diagnostic"',
      '  label="無料診断を受ける"',
      "/>",
    ].join("\n");
    const r = convertJsxToMarkdown(src);
    expect(r.body).toContain("**御社の状況を確認したい方へ**");
    expect(r.body).toContain("無料診断では現状をヒアリングします。");
    expect(r.body).toContain("[無料診断を受ける](/diagnostic)");
    expect(r.body).not.toContain("<CTABlock");
    expect(r.converted).toEqual([{ component: "CTABlock", count: 1 }]);
  });

  it("primary/secondaryの2つのCTAを両方残す", () => {
    const src = [
      "<CTABlock",
      '  description="説明文です。"',
      '  primaryLabel="無料相談"',
      '  primaryHref="/diagnostic"',
      '  secondaryLabel="資料ダウンロード"',
      '  secondaryHref="/guidebook"',
      "/>",
    ].join("\n");
    const r = convertJsxToMarkdown(src);
    expect(r.body).toContain("[無料相談](/diagnostic)");
    expect(r.body).toContain("[資料ダウンロード](/guidebook)");
  });

  it("/contact はURLを持たないのでリンクにせず文言だけ残す", () => {
    const src = ['<CTABlock primaryLabel="無料相談を申し込む" primaryHref="/contact" />'].join("\n");
    const r = convertJsxToMarkdown(src);
    expect(r.body).toContain("無料相談を申し込む");
    expect(r.body).not.toContain("](/contact)");
  });

  it("FAQの問答を1件も落とさずmarkdownにする", () => {
    const src = [
      "## よくある質問",
      "",
      "<FAQ items={[",
      "  {",
      '    q: "特別なツールが必要ですか？",',
      '    a: "不要です。ブラウザのタブを複数開くだけで始められます。"',
      "  },",
      "  {",
      '    q: "どう使い分けますか？",',
      '    a: "業務内容によって変わります。まず両方に投げて比較してください。"',
      "  }",
      "]} />",
    ].join("\n");
    const r = convertJsxToMarkdown(src);
    expect(r.body).toContain("**特別なツールが必要ですか？**");
    expect(r.body).toContain("不要です。ブラウザのタブを複数開くだけで始められます。");
    expect(r.body).toContain("**どう使い分けますか？**");
    expect(r.body).toContain("業務内容によって変わります。まず両方に投げて比較してください。");
    expect(r.body).not.toContain("<FAQ");
    expect(r.body).not.toContain("items={[");
  });

  it("question/answer 表記のFAQも拾う", () => {
    const src = ['<FAQ items={[{ question: "効果は？", answer: "3か月です。" }]} />'].join("\n");
    const r = convertJsxToMarkdown(src);
    expect(r.body).toContain("**効果は？**");
    expect(r.body).toContain("3か月です。");
  });

  it("ArticleMetaは削除する (監修表記はサイト側が出す)", () => {
    const src = [
      "<ArticleMeta",
      '  publishedAt="2025-07-01"',
      '  reviewedBy="大島蓮太"',
      "  aiAssisted={true}",
      "/>",
      "",
      "**この記事の要点**",
    ].join("\n");
    const r = convertJsxToMarkdown(src);
    expect(r.body).toBe("**この記事の要点**");
  });

  it("知らないコンポーネントは変換せず報告する", () => {
    const src = ['<MysteryBox foo="bar" />', "", "本文。"].join("\n");
    const r = convertJsxToMarkdown(src);
    expect(r.body).toContain("<MysteryBox");
    expect(r.unhandled).toEqual(["MysteryBox"]);
  });

  it("問答を1件も拾えないFAQは消さずに報告する (情報の取りこぼし防止)", () => {
    const src = ["<FAQ items={someVariable} />"].join("\n");
    const r = convertJsxToMarkdown(src);
    expect(r.body).toContain("<FAQ");
    expect(r.unhandled).toContain("FAQ");
  });

  it("コードフェンス内のJSXには触らない", () => {
    const src = ["```jsx", '<CTABlock heading="例" />', "```"].join("\n");
    expect(convertJsxToMarkdown(src).body).toBe(src);
  });

  it("JSXが無い本文はそのまま返す", () => {
    const src = "## 見出し\n\n本文です。";
    const r = convertJsxToMarkdown(src);
    expect(r.body).toBe(src);
    expect(r.converted).toEqual([]);
  });
});
