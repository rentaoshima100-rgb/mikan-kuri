import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { FixtureLLMClient } from "@kurimikan/shared";
import { MemoryStore } from "../db/memory.js";
import { parseFeed, runSeoWatcher } from "./seo_watcher.js";

const SUITE = join(__dirname, "..", "..", "..", "..", "kurimikan_prompt_suite_v1.md");
const FIXTURES = join(__dirname, "..", "..", "..", "shared", "fixtures", "llm");

const RSS = `<rss><channel>
<item><title>Google releases March 2026 core update</title><link>https://example.com/a</link>
<description><![CDATA[Google announced a broad core update...]]></description><pubDate>Tue, 28 Jul 2026 10:00:00 GMT</pubDate></item>
<item><title>Rumor: new ranking factor?</title><link>https://example.com/b</link>
<description>Some speculation about a possible change</description><pubDate>Mon, 27 Jul 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM = `<feed><entry><title>Atom item</title><link href="https://example.com/c"/><summary>summary text</summary><updated>2026-07-28T00:00:00Z</updated></entry></feed>`;

const p14 = (importance: number) =>
  JSON.stringify({
    source_type: "official",
    change_type: "algorithm",
    confidence: "high",
    importance,
    affected_area: ["gate", "publish_strategy"],
    summary_one_line: "コアアップデート",
    corroboration_needed: false,
  });

describe("parseFeed: RSS/Atomの軽量パース", () => {
  it("RSSの各item(title/link/excerpt/pubDate)を抽出", () => {
    const items = parseFeed(RSS);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "Google releases March 2026 core update", url: "https://example.com/a" });
    expect(items[0]!.excerpt).toContain("core update");
  });
  it("Atomの<link href>を拾う", () => {
    expect(parseFeed(ATOM)[0]!.url).toBe("https://example.com/c");
  });
  it("フィードでないHTMLは空配列", () => {
    expect(parseFeed("<html><body>not a feed</body></html>")).toEqual([]);
  });
});

describe("runSeoWatcher: RSS取得→P-14分類→seo_knowledge蓄積", () => {
  function makeDeps(importance = 9) {
    const store = new MemoryStore();
    store.setConfig("rss_feeds", [{ name: "Test Feed", url: "https://feed.example/rss" }]);
    const llm = new FixtureLLMClient({ fixturesDir: FIXTURES, responses: { "P-14": p14(importance) } });
    const fetchImpl = (async () => new Response(RSS, { status: 200 })) as typeof fetch;
    return { store, deps: { store, llm, suitePath: SUITE, fetchImpl } };
  }

  it("新着を分類してseo_knowledgeに入れ、P-16のdigest(重要度>=7)で読める", async () => {
    const { store, deps } = makeDeps(9);
    const r = await runSeoWatcher(deps);

    expect(r.classified).toBe(2);
    const digest = await store.listSeoKnowledgeSince("2000-01-01T00:00:00Z", 7);
    expect(digest.length).toBe(2);
    expect(digest[0]!.importance).toBe(9);
  });

  it("既知URLは再分類しない (冪等)", async () => {
    const { deps } = makeDeps(9);
    await runSeoWatcher(deps);
    const second = await runSeoWatcher(deps);
    expect(second.classified).toBe(0); // 2回目はすべて既知
  });

  it("フィード取得失敗やRSS非対応は記録してスキップ (全体は止めない)", async () => {
    const store = new MemoryStore();
    store.setConfig("rss_feeds", [{ name: "Bad", url: "https://bad.example" }]);
    const llm = new FixtureLLMClient({ fixturesDir: FIXTURES, responses: { "P-14": p14(9) } });
    const fetchImpl = (async () => new Response("<html>not feed</html>", { status: 200 })) as typeof fetch;
    const r = await runSeoWatcher({ store, llm, suitePath: SUITE, fetchImpl });
    expect(r.classified).toBe(0);
    expect(r.skipped[0]!.reason).toContain("RSS項目を抽出できず");
  });
});
