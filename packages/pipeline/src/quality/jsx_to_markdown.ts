// 本文に残ったMDXのJSXコンポーネントを、内容を保ったままプレーンmarkdownへ変換する。
//
// 配信先 (Shopify) はHTMLへ変換して渡すためJSXを解釈できず、
// タグがそのまま文字として画面に出る。生成側は P-13b のプロンプト修正と
// sanitizeArticleBody で塞いだが、それ以前に生成された本文には残っている。
//
// 単純に行を削除してはいけない。<FAQ items={[...]} /> のように、
// 本文がタグの中ではなく属性の中にあるものがあり、削ると内容ごと消える。
//
// 扱うのは実際に出現した3種類だけにする。未知のコンポーネントは変換せず報告する
// (機械が勝手に解釈して情報を落とすより、人が見て判断するほうが安全)。
export interface JsxConversion {
  body: string;
  converted: { component: string; count: number }[];
  // 変換規則を持たないコンポーネント。残るので人の判断が要る
  unhandled: string[];
}

// URLを持たないルート。リンクにすると404になる (問い合わせはモーダル)
const NON_LINKABLE = new Set(["/contact"]);

interface JsxBlock {
  name: string;
  start: number;
  end: number; // 終端行 (含む)
  text: string;
}

// 大文字始まりのコンポーネントを行単位で切り出す。
// 属性に {[ ... ]} を含むため、括弧の深さが0に戻り、かつ /> か </Name> で閉じた行を終端とする。
function findBlocks(lines: string[]): JsxBlock[] {
  const blocks: JsxBlock[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^\s*<([A-Z][A-Za-z0-9]*)/.exec(line);
    if (!m) continue;
    const name = m[1]!;
    let depth = 0;
    for (let j = i; j < lines.length; j++) {
      const l = lines[j]!;
      for (const ch of l) {
        if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") depth--;
      }
      const closed = depth <= 0 && (/\/>\s*$/.test(l) || new RegExp(`</${name}>\\s*$`).test(l));
      if (closed) {
        blocks.push({ name, start: i, end: j, text: lines.slice(i, j + 1).join("\n") });
        i = j;
        break;
      }
      if (j === lines.length - 1) return blocks; // 閉じていない: 以降は触らない
    }
  }
  return blocks;
}

// name="値" の属性を拾う。値に " を含む例は実データに無いので単純一致でよい
function attrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

function link(label: string | undefined, href: string | undefined): string | null {
  if (!label) return null;
  if (!href || NON_LINKABLE.has(href)) return label; // リンクにせず文言だけ残す
  return `[${label}](${href})`;
}

// <CTABlock heading= body=/description= label=+href= (primary/secondary) />
function convertCtaBlock(text: string): string {
  const a = attrs(text);
  const parts: string[] = [];
  if (a.heading) parts.push(`**${a.heading}**`);
  const desc = a.body ?? a.description;
  if (desc) parts.push(desc);
  const links = [
    link(a.label ?? a.primaryLabel, a.href ?? a.primaryHref),
    link(a.secondaryLabel, a.secondaryHref),
  ].filter((s): s is string => !!s);
  if (links.length) parts.push(links.join(" / "));
  return parts.join("\n\n");
}

// <FAQ items={[{ q: "...", a: "..." }]} /> → 太字の問い + 地の文の答え
function convertFaq(text: string): string {
  const out: string[] = [];
  // q/question と a/answer の両表記が実データにある
  const re = /(?:q|question)\s*:\s*"([^"]*)"\s*,\s*(?:a|answer)\s*:\s*"([^"]*)"/gs;
  for (const m of text.matchAll(re)) {
    out.push(`**${m[1]!.trim()}**`);
    out.push(m[2]!.trim());
  }
  return out.join("\n\n");
}

export function convertJsxToMarkdown(body: string): JsxConversion {
  const lines = body.split("\n");
  const blocks = findBlocks(lines);
  if (blocks.length === 0) return { body, converted: [], unhandled: [] };

  const counts = new Map<string, number>();
  const unhandled: string[] = [];
  const replaced = new Map<number, { end: number; text: string | null }>();

  for (const b of blocks) {
    let md: string | null = null;
    if (b.name === "CTABlock") md = convertCtaBlock(b.text);
    else if (b.name === "FAQ") md = convertFaq(b.text);
    else if (b.name === "ArticleMeta") md = ""; // 監修表記はサイト側が出すので捨てる
    else {
      unhandled.push(b.name);
      continue;
    }
    // 変換して中身が空になった場合、元に情報が残っていたなら消さない (取りこぼし防止)
    if (md !== "" && !md) {
      unhandled.push(b.name);
      continue;
    }
    if (b.name === "FAQ" && md === "") {
      unhandled.push(b.name); // 問答を1件も拾えなかった = 想定外の形
      continue;
    }
    counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
    replaced.set(b.start, { end: b.end, text: md === "" ? null : md });
  }

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const r = replaced.get(i);
    if (!r) {
      out.push(lines[i]!);
      continue;
    }
    if (r.text !== null) out.push(r.text);
    i = r.end;
  }

  return {
    body: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    converted: [...counts].map(([component, count]) => ({ component, count })),
    unhandled: [...new Set(unhandled)],
  };
}
