// inbound内部リンクの適用ロジック。
//
// inbound = 既存の公開済み記事から、新しい記事へリンクを張る提案。
// 適用は「公開済み記事の書き換え」にあたるため自動実行しない (v3: 公開は承認のみ)。
// 人間がリンク承認キューで差分を見て承認したものだけを適用する。
//
// 挿入規則: insert_hint が指す見出し (H2) の直後の段落末に一文を足す。
// 見出しが見つからない場合は本文末尾の「関連リンク」ブロックへ追加する。

export interface LinkProposal {
  id: string;
  source_article_id: string; // 挿入先 (既存記事)
  target_url: string;
  anchor: string;
  insert_hint?: string;
}

export interface LinkDiff {
  before: string;
  after: string;
  // 変更が起きた行 (前後の文脈つき)。管理画面で差分として表示する
  contextBefore: string[];
  changedLine: string;
  contextAfter: string[];
  inserted: boolean;
  reason?: string;
}

const RELATED_HEADING = "## 関連リンク";

export function linkSentence(anchor: string, target: string): string {
  return `[${anchor}](${target})もあわせてご覧ください。`;
}

function findHeadingIndex(lines: string[], hint: string | undefined): number {
  if (!hint) return -1;
  const normalized = hint.replace(/\s+/g, "");
  return lines.findIndex(
    (l) => l.startsWith("#") && l.replace(/\s+/g, "").includes(normalized.slice(0, 12)),
  );
}

// 見出し直後の「段落が終わる行」を返す (次の見出しか空行の直前)
function endOfFirstParagraph(lines: string[], headingIndex: number): number {
  let i = headingIndex + 1;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.startsWith("#")) i++;
  return i - 1;
}

export function applyLinkToBody(body: string, proposal: LinkProposal): LinkDiff {
  const sentence = linkSentence(proposal.anchor, proposal.target_url);

  // 既に同じリンクがあるなら二重に張らない
  if (body.includes(`](${proposal.target_url})`)) {
    return {
      before: body,
      after: body,
      contextBefore: [],
      changedLine: "",
      contextAfter: [],
      inserted: false,
      reason: "同じリンク先が既に本文にあります",
    };
  }

  const lines = body.split("\n");
  const headingIndex = findHeadingIndex(lines, proposal.insert_hint);

  let insertAt: number;
  if (headingIndex >= 0) {
    insertAt = endOfFirstParagraph(lines, headingIndex) + 1;
  } else {
    // 見出しが特定できない場合は関連リンクブロックへ
    const relatedIndex = lines.findIndex((l) => l.trim() === RELATED_HEADING);
    if (relatedIndex >= 0) {
      let i = relatedIndex + 1;
      while (i < lines.length && !lines[i]!.startsWith("#")) i++;
      const listLine = `- [${proposal.anchor}](${proposal.target_url})`;
      const next = [...lines];
      next.splice(i, 0, listLine);
      return {
        before: body,
        after: next.join("\n"),
        contextBefore: lines.slice(Math.max(0, i - 2), i),
        changedLine: listLine,
        contextAfter: lines.slice(i, i + 2),
        inserted: true,
      };
    }
    // 関連リンクブロックも無ければ末尾に作る
    const next = [...lines, "", RELATED_HEADING, "", `- [${proposal.anchor}](${proposal.target_url})`];
    return {
      before: body,
      after: next.join("\n"),
      contextBefore: lines.slice(-2),
      changedLine: `- [${proposal.anchor}](${proposal.target_url})`,
      contextAfter: [],
      inserted: true,
    };
  }

  const next = [...lines];
  next.splice(insertAt, 0, "", sentence);
  return {
    before: body,
    after: next.join("\n"),
    contextBefore: lines.slice(Math.max(0, insertAt - 2), insertAt),
    changedLine: sentence,
    contextAfter: lines.slice(insertAt, insertAt + 2),
    inserted: true,
  };
}
