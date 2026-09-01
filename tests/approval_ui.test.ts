// 承認導線の不変条件を管理画面のソースに対して検証する。
//
// v3では「代表が実記事を読んで承認ボタンを押す」ことが公開の唯一のトリガであり、
// それが記事に付く監修表記の根拠でもある。本文を表示しない画面に承認ボタンがあると、
// 読まずに押せる=白紙承認になり、監修表記の裏付けが失われる。
// UIは壊れやすいので、この構造だけはCIで固定しておく。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ADMIN = join(__dirname, "..", "packages", "admin", "app");
const read = (...p: string[]) => readFileSync(join(ADMIN, ...p), "utf8");

describe("承認導線: 一括レビュー画面", () => {
  const bulk = read("bulk", "page.tsx");

  it("承認アクションを呼ばない (本文を表示しないため)", () => {
    expect(bulk).not.toContain("approveAction");
  });

  it("差し戻しは可能 (問題に気づいた時点で止められる)", () => {
    expect(bulk).toContain("sendBackAction");
  });

  it("本文を読むための個別画面への導線がある", () => {
    expect(bulk).toContain("/article/");
  });
});

describe("承認導線: トラックの区別", () => {
  // 改修 (revision) は既存URLの中身を直すだけなので週2本の対象外。
  // 代表が「今日は改修だけ捌く」と判断できるよう、キューで区別できる必要がある
  const home = read("page.tsx");
  const bulk = read("bulk", "page.tsx");

  it("承認キューをトラックで絞り込める", () => {
    expect(home).toContain("track=revision");
    expect(home).toContain("track=new");
  });

  it("一括レビュー画面もトラックで絞り込める", () => {
    expect(bulk).toContain("track=revision");
    expect(bulk).toContain("track=new");
  });

  it("一覧の各行にトラックが表示される", () => {
    expect(home).toContain("改修");
    expect(bulk).toContain("改修");
  });
});

describe("承認導線: 個別記事画面", () => {
  const page = read("article", "[id]", "page.tsx");
  const gate = read("article", "[id]", "ApproveGate.tsx");

  it("本文プレビューを表示する", () => {
    expect(page).toContain("article.body_mdx");
  });

  it("承認ボタンは読了ゲートの内側にある", () => {
    const gateStart = page.indexOf("<ApproveGate>");
    const gateEnd = page.indexOf("</ApproveGate>");
    const approveForm = page.indexOf("action={approveAction}");
    expect(gateStart).toBeGreaterThan(-1);
    expect(approveForm).toBeGreaterThan(gateStart);
    expect(approveForm).toBeLessThan(gateEnd);
  });

  it("承認ボタンは本文プレビューより後ろに置かれている", () => {
    expect(page.indexOf("action={approveAction}")).toBeGreaterThan(
      page.indexOf("article.body_mdx"),
    );
  });

  it("読了ゲートは本文末尾の可視化で解除される", () => {
    expect(gate).toContain("IntersectionObserver");
    // 観測できない環境では承認自体ができなくなるため、その場合はゲートを外す
    expect(gate).toContain('typeof IntersectionObserver === "undefined"');
  });

  it("公開予定URLを承認前に確認できる (公開後のslug変更はやり直せないため)", () => {
    expect(page).toContain("公開予定URL");
    // Shopifyの記事URLは /blogs/<blog>/<handle> で固定される
    expect(page).toContain("/blogs/column/");
    // 改修は既存URLの中身を差し替えるだけなので、新規URLの案内を出さない
    expect(page).toContain("article.revision_of");
  });
});
