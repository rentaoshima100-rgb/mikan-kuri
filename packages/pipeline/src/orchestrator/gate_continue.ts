// ゲート承認のルーチン引き継ぎ (代表指示 2026-09-08 サブスク実行への変換)。
//
// gate_pending (品質ホールド) の人間承認後は合議・仕上げでLLMが要る。管理画面 (Vercel) は
// サブスク実行のブリッジを使えないため、APIキーが無い構成では「承認済みマーカ」だけを
// 記事に置き、実処理は次のルーチン実行 (routine_daily の gate_continue ステップ) が行う。
// ANTHROPIC_API_KEYがある構成では従来どおり管理画面が同期処理する (このファイルは使われない)。
import type { ArticleRow } from "../db/types.js";
import { continueFromGate, type OrchestratorDeps } from "./generate.js";

interface GateApprovedMarker {
  by: string;
  at: string;
}

function markerOf(article: ArticleRow): GateApprovedMarker | null {
  const quality = article.quality;
  if (!quality || typeof quality !== "object") return null;
  const m = (quality as { gate_approved?: unknown }).gate_approved;
  if (!m || typeof m !== "object") return null;
  const { by, at } = m as { by?: unknown; at?: unknown };
  return typeof by === "string" && typeof at === "string" ? { by, at } : null;
}

// 管理画面から呼ぶ: ゲート承認の意思決定を記録する (LLMは呼ばない)。
// status は gate_pending のまま。実処理はルーチンが continueApprovedGates で行う
export async function markGateApproved(
  articleId: string,
  decidedBy: string,
  deps: { store: OrchestratorDeps["store"]; now?: () => Date },
): Promise<void> {
  const article = await deps.store.getArticle(articleId);
  if (!article || article.status !== "gate_pending") {
    throw new Error(`gate_pendingの記事ではありません: ${articleId}`);
  }
  const quality = article.quality && typeof article.quality === "object" ? article.quality : {};
  await deps.store.updateArticle(articleId, {
    quality: {
      ...quality,
      gate_approved: { by: decidedBy, at: (deps.now?.() ?? new Date()).toISOString() },
    },
  });
}

// ルーチンから呼ぶ: マーカ付きの gate_pending 記事の残りステップ (合議→仕上げ) を再開する。
// 1件失敗しても他は続行する (日次バッチと同じ堅牢化方針)
export async function continueApprovedGates(
  deps: OrchestratorDeps,
): Promise<{ continued: string[]; failed: { id: string; error: string }[] }> {
  const continued: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const article of await deps.store.listArticlesByStatus("gate_pending")) {
    if (!markerOf(article)) continue;
    try {
      await continueFromGate(article.id, deps);
      continued.push(article.id);
    } catch (e) {
      failed.push({ id: article.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { continued, failed };
}
