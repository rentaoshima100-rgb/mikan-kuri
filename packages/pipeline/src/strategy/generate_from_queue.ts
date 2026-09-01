// キューから記事を生成する (v3 Sprint 1)。
// 代表が承認して status='queued' になったキーワードを優先度順に記事化し、承認キューへ積む。
// 公開はされない (記事は approval_pending / gate_pending で止まる)。自動公開は存在しない (v3)。
import { generateArticle, type OrchestratorDeps } from "../orchestrator/generate.js";

export interface GenerateFromQueueResult {
  generated: { keyword: string; articleId: string; status: string }[];
  failed: { keyword: string; error: string }[];
}

export async function generateFromQueue(
  deps: OrchestratorDeps,
  opts: { limit?: number } = {},
): Promise<GenerateFromQueueResult> {
  const queued = await deps.store.listKeywordsByStatus("queued");
  const targets = opts.limit !== undefined ? queued.slice(0, opts.limit) : queued;
  const result: GenerateFromQueueResult = { generated: [], failed: [] };

  for (const kw of targets) {
    // 1本の失敗 (通信断など) でバッチ全体を止めない。改修バッチと同じ堅牢性。
    try {
      const article = await generateArticle(kw.id, deps);
      result.generated.push({ keyword: kw.keyword, articleId: article.id, status: article.status });
    } catch (e) {
      result.failed.push({ keyword: kw.keyword, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
