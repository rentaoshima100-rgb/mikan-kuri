// cron-monthly (月初): GA4同期 (AIチャネル/リファラ集計 → ai_cv_events)。
// e-Stat同期・相場レポート・月次戦略エージェントはSprint 1以降 (v3スコープ)。
import { aiCvStatus, runGa4Sync, type Store } from "@kurimikan/pipeline";
import { runJob } from "./shared.js";

await runJob("cron-monthly", async (store: Store) => {
  const ga4 = await runGa4Sync({ store });
  const cv = await aiCvStatus(store);
  if (cv.proposable) {
    console.log(
      JSON.stringify({
        note: "AI経由CVが凍結解除ラインに到達。解除は月次レポートのproposals承認 (人間) で行う",
        total: cv.total,
      }),
    );
  }
  return { ga4, ai_cv: cv };
});
