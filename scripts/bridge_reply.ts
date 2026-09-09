// LLMブリッジ応答の書き込みCLI (サブスク実行、docs/ROUTINES.md)。
// ルーチンのClaude Codeエージェントが req-<seq>.json に答えるときに使う。
// エージェントが応答JSONを手書きするとエスケープ事故 (本文中の引用符・改行) が起きるため、
// 「出力をファイルに書く → このCLIで包む」を必ず通す。
//
//   npx tsx scripts/bridge_reply.ts <seq> --text <file>   # {"text": <fileの中身>} を書く
//   npx tsx scripts/bridge_reply.ts <seq> --json <file>   # fileのJSONオブジェクトをそのまま応答にする
//                                                          # (researchの {text, sources} 用)
//   npx tsx scripts/bridge_reply.ts <seq> --error "理由"  # 失敗をパイプラインへ伝える
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [seqArg, mode, value] = process.argv.slice(2);
const seq = Number(seqArg);
if (!Number.isInteger(seq) || seq < 1 || !mode || !value) {
  console.error(
    "使い方: npx tsx scripts/bridge_reply.ts <seq> --text <file> | --json <file> | --error <理由>",
  );
  process.exit(1);
}

const dir = process.env.LLM_BRIDGE_DIR ?? join(process.cwd(), ".llm-bridge");

let response: Record<string, unknown>;
if (mode === "--text") {
  response = { text: readFileSync(value, "utf8") };
} else if (mode === "--json") {
  const parsed: unknown = JSON.parse(readFileSync(value, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error("--json のファイルはオブジェクト ({...}) である必要があります");
    process.exit(1);
  }
  response = parsed as Record<string, unknown>;
} else if (mode === "--error") {
  response = { error: value };
} else {
  console.error(`不明なモード: ${mode} (--text / --json / --error)`);
  process.exit(1);
}

// パイプライン側が書きかけを読まないよう、tmpに書いてからrenameする
const name = `res-${String(seq).padStart(4, "0")}.json`;
const path = join(dir, name);
writeFileSync(`${path}.tmp`, JSON.stringify(response), "utf8");
renameSync(`${path}.tmp`, path);
console.log(`応答を書き込みました: ${path}`);
