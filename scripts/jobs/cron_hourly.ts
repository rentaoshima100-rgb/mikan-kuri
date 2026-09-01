// cron-hourly: M3公開ワーカ。
// 承認済み+期日到来の記事を1件公開する (halt中はスキップ / throttle中は週1本)。
// 公開先はShopify (/blogs/<blog>/<handle>)。articleCreate または articleUpdate を投げる。
import {
  makeShopifyPublisher,
  runPublishWorker,
  submitIndexNow,
  type Store,
} from "@kurimikan/pipeline";
import { runJob } from "./shared.js";

await runJob("cron-hourly:publish", async (store: Store) => {
  return runPublishWorker({
    store,
    publisher: makeShopifyPublisher(store),
    indexNow: (urls) =>
      submitIndexNow(urls, {
        key: process.env.INDEXNOW_KEY ?? "",
        host: process.env.SITE_HOST ?? "kuri-mikan.jp",
      }),
  });
});
