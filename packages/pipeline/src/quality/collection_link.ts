// コレクション導線ゲート。
//
// この案件で記事を書く目的は、記事自身が売ることではない。
// 購買クエリ (「甘平 通販」「甘平 訳あり 3kg」) で上位を取るべきなのはカートのある
// /collections/<品種> であって記事ではない。記事は関連する束としてコレクションへ
// 内部リンクを集中させ、そのページの重要度とトピックの網羅性を証明するために書く。
//
// つまり「コレクションへのリンクが無い記事」は、この設計では成立しない。
// 書き手 (LLM) の善意に任せず、機械的に:
//   1. 必ず末尾にコレクションへの導線ブロックを付ける (buildCollectionCta)
//   2. 付いていること・アンカーテキストが品種名を含むことを検査する (checkCollectionLink)
//
// アンカーテキストを見るのは、「こちら」ではリンク先が何のページかGoogleに伝わらず、
// 評価の受け渡しという目的を果たさないため。

export interface CollectionDef {
  // Shopifyのコレクションhandle (例: kanpei)
  handle: string;
  // 日本語の品種名 (例: 甘平)。アンカーテキストに必ず含める語
  label: string;
}

export type CollectionMap = Record<string, CollectionDef>;

// リンク先として本文に自動適用してよいパス。
// Shopifyのストア構造 (/collections /products /blogs /pages) と外部URLのみ許す。
// 実在しないパスを入れると404リンクがそのまま公開される
export function isAllowedInternalTarget(target: string): boolean {
  if (/^https?:\/\//.test(target)) return true;
  if (!target.startsWith("/")) return false;
  return /^\/(collections|products|pages)\/[a-z0-9-]+$/.test(target) ||
    /^\/blogs\/[a-z0-9-]+\/[a-z0-9-]+$/.test(target) ||
    /^\/blogs\/[a-z0-9-]+$/.test(target);
}

export function collectionPath(handle: string): string {
  return `/collections/${handle}`;
}

// リンク先が何のページか伝わらないアンカーテキスト。
// これしか無い場合は評価の受け渡しが起きないので不合格にする
const VAGUE_ANCHORS = ["こちら", "ここ", "リンク", "詳しくは", "詳細", "商品ページ", "ページ"];

export interface CollectionLinkResult {
  ok: boolean;
  hasLink: boolean;
  anchorHasLabel: boolean;
  // 実際に本文にあった、対象コレクションへのアンカーテキスト
  anchors: string[];
  reason?: string;
}

const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/**
 * 本文が対象コレクションへ、品種名を含むアンカーでリンクしているかを検査する。
 * 判定は決定論のみ。
 */
export function checkCollectionLink(
  body: string,
  collection: CollectionDef,
): CollectionLinkResult {
  const path = collectionPath(collection.handle);
  const anchors: string[] = [];
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(body)) !== null) {
    const href = m[2]!;
    // 絶対URLで書かれていても同じコレクションなら数える
    if (href === path || href.endsWith(path)) anchors.push(m[1]!.trim());
  }

  if (!anchors.length) {
    return {
      ok: false,
      hasLink: false,
      anchorHasLabel: false,
      anchors,
      reason: `対象コレクション ${path} へのリンクが本文にありません`,
    };
  }

  const anchorHasLabel = anchors.some(
    (a) => a.includes(collection.label) && !VAGUE_ANCHORS.includes(a),
  );
  if (!anchorHasLabel) {
    return {
      ok: false,
      hasLink: true,
      anchorHasLabel: false,
      anchors,
      reason:
        `${path} へのアンカーテキストに品種名「${collection.label}」が入っていません ` +
        `(現在: ${anchors.join(" / ")})。「こちら」ではリンク先が何のページか検索エンジンに伝わりません`,
    };
  }

  return { ok: true, hasLink: true, anchorHasLabel: true, anchors };
}

/**
 * 本文末尾に付けるコレクション導線ブロック (markdown)。
 *
 * 記事ごとに文言が同じだと、束ねた記事全体が定型文の集まりに見える。
 * 記事タイトルを差し込んで、少なくとも見出しは記事ごとに変える。
 */
export function buildCollectionCta(collection: CollectionDef, origin: string): string {
  const path = collectionPath(collection.handle);
  return [
    `## ${collection.label}のお取り寄せ`,
    "",
    `${origin}の${collection.label}は、収穫のたびに選別して当店から直接お届けしています。` +
      `[${origin}の${collection.label}はこちら](${path})からご覧いただけます。`,
  ].join("\n");
}

/** config の collections (handle → {label}) を CollectionDef に解決する。 */
export function resolveCollection(
  map: CollectionMap | null | undefined,
  handle: string | null | undefined,
): CollectionDef | null {
  if (!handle) return null;
  const def = map?.[handle];
  if (def) return { handle, label: def.label };
  // configに未登録でも、handleが分かっていればリンクは張れる。
  // ただし品種名が分からないのでアンカー検査は通らない (承認画面に理由が出る)
  return { handle, label: handle };
}
