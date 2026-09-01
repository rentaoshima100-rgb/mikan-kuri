// Markdown → HTML 変換。
//
// パイプラインは本文を markdown (articles.body_mdx) で持つが、Shopify の
// ArticleCreateInput.body はHTML文字列を受け取る。Shopifyは渡された文字列を
// そのままテーマに埋め込むだけで、markdownの解釈はしない。変換層を挟まないと
// 「## 見出し」や「[リンク](/collections/kanpei)」が生の文字として記事に出る。
//
// 依存を増やさずに済ませるため、パイプラインが実際に生成する範囲だけを実装する:
//   見出し / 段落 / 箇条書き / 番号付き / 表 / 引用 / 水平線 / コードブロック、
//   インラインは リンク・強調・コード。
// HTMLは書き手 (LLM) の出力を含むため、テキストは必ずエスケープしてから組み立てる。

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESCAPES[c]!);
}

// コードスパンの退避に使う目印。markdown本文に現れない字面にする
const CODE_SLOT = (i: number) => `@@CODE${i}@@`;

// インライン記法。エスケープ済みのテキストに対して適用する。
// コードスパンを先に取り出して退避し、その中では強調やリンクを解釈しない。
export function renderInline(text: string): string {
  const codes: string[] = [];
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(code);
    return CODE_SLOT(codes.length - 1);
  });

  // [表示テキスト](リンク先)。リンク先は属性値になるが escapeHtml 済みで " は通らない
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => {
    const external = /^https?:\/\//.test(href) && !href.includes("kuri-mikan.jp");
    const rel = external ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<a href="${href}"${rel}>${label}</a>`;
  });

  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // 単独の * による強調。**強調** は処理済みなので残りだけを見る
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");

  return out.replace(/@@CODE(\d+)@@/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`);
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const UL_ITEM = /^\s*[-*]\s+(.*)$/;
const OL_ITEM = /^\s*\d+[.)]\s+(.*)$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_ROW = /^\s*\|(.*)\|\s*$/;
const TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;

function splitRow(line: string): string[] {
  const m = TABLE_ROW.exec(line)!;
  return m[1]!.split("|").map((c) => c.trim());
}

export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;

  const paragraph: string[] = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInline(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`);
    paragraph.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      flushParagraph();
      i++;
      continue;
    }

    // コードブロック
    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) body.push(lines[i++]!);
      i++; // 閉じフェンス
      html.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (HR.test(line)) {
      flushParagraph();
      html.push("<hr>");
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      // 記事タイトルはShopifyのテーマがh1で描画するため、本文のh1はh2へ落とす
      const level = Math.max(2, heading[1]!.length);
      html.push(`<h${level}>${renderInline(heading[2]!.trim())}</h${level}>`);
      i++;
      continue;
    }

    if (line.trimStart().startsWith(">")) {
      flushParagraph();
      const quoted: string[] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith(">")) {
        quoted.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      }
      html.push(`<blockquote>${markdownToHtml(quoted.join("\n"))}</blockquote>`);
      continue;
    }

    // 表。区切り行 (|---|---|) がある場合のみ表として扱う
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      flushParagraph();
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i]!) && !TABLE_SEP.test(lines[i]!)) {
        rows.push(splitRow(lines[i++]!));
      }
      const th = head.map((c) => `<th>${renderInline(c)}</th>`).join("");
      const body = rows
        .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
        .join("");
      html.push(`<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    const ordered = OL_ITEM.test(line);
    if (ordered || UL_ITEM.test(line)) {
      flushParagraph();
      const pattern = ordered ? OL_ITEM : UL_ITEM;
      const items: string[] = [];
      while (i < lines.length && pattern.test(lines[i]!)) {
        items.push(pattern.exec(lines[i++]!)![1]!);
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</${tag}>`);
      continue;
    }

    paragraph.push(line.trim());
    i++;
  }
  flushParagraph();
  return html.join("\n");
}
