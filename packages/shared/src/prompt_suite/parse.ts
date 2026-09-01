import { readFileSync } from "node:fs";

export interface ParsedPrompt {
  id: string;
  body: string;
}

// "## P-01 ..." / "### P-03a ..." のみをプロンプト見出しとして扱う。
// 本文中の表 (配線図) や箇条書きの "P-xx" は対象外。
const HEADING = /^#{2,3}\s+(P-\d{2}[a-z]?)\b/;

export function parseSuiteText(text: string): ParsedPrompt[] {
  const lines = text.split(/\r?\n/);
  const headings: { id: string; line: number }[] = [];
  lines.forEach((line, i) => {
    const m = HEADING.exec(line);
    if (m) headings.push({ id: m[1]!, line: i });
  });

  const prompts: ParsedPrompt[] = [];
  headings.forEach((h, idx) => {
    const end = idx + 1 < headings.length ? headings[idx + 1]!.line : lines.length;
    const body = firstFence(lines.slice(h.line + 1, end));
    // 親見出し (P-03, P-05, P-13, P-18) はフェンスを持たないため自然に除外される
    if (body !== null) prompts.push({ id: h.id, body });
  });
  return prompts;
}

function firstFence(sectionLines: string[]): string | null {
  const start = sectionLines.findIndex((l) => l.startsWith("```"));
  if (start === -1) return null;
  const rest = sectionLines.slice(start + 1);
  const endRel = rest.findIndex((l) => l.startsWith("```"));
  if (endRel === -1) return null;
  return rest.slice(0, endRel).join("\n");
}

export function parseSuiteFile(path: string): ParsedPrompt[] {
  return parseSuiteText(readFileSync(path, "utf8"));
}

// 期待される全プロンプトID (28本)。パース結果の完全性検証に使う。
export const EXPECTED_PROMPT_IDS = [
  "P-00",
  "P-01",
  "P-02",
  "P-03a",
  "P-03b",
  "P-03c",
  "P-03d",
  "P-03e",
  "P-03f",
  "P-03g",
  "P-04",
  "P-05a",
  "P-05b",
  "P-06",
  "P-07",
  "P-08",
  "P-09",
  "P-10",
  "P-11",
  "P-12",
  "P-13a",
  "P-13b",
  "P-14",
  "P-15",
  "P-16",
  "P-17",
  "P-18a",
  "P-18b",
] as const;
