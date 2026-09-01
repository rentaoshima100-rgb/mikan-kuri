// IndexNow送信 (Bing系。Googleはsitemapに委ねる — SPEC M3)。
// dry_run では送信せずログのみ。失敗しても公開自体は成功扱い (呼び出し側でbest-effort)。

export interface IndexNowOptions {
  key: string;
  host: string; // 'kuri-mikan.jp'
  fetchImpl?: typeof fetch;
}

export async function submitIndexNow(
  urls: string[],
  opts: IndexNowOptions,
): Promise<{ submitted: boolean; status?: number }> {
  if (!urls.length) return { submitted: false };
  if (process.env.PIPELINE_ENV === "dry_run") {
    console.log(`[dry_run] IndexNow送信をスキップ: ${urls.join(", ")}`);
    return { submitted: false };
  }
  if (!opts.key) {
    console.warn("[indexnow] INDEXNOW_KEY未設定のため送信スキップ");
    return { submitted: false };
  }
  const f = opts.fetchImpl ?? fetch;
  const res = await f("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: opts.host,
      key: opts.key,
      keyLocation: `https://${opts.host}/${opts.key}.txt`,
      urlList: urls,
    }),
  });
  return { submitted: res.ok, status: res.status };
}
