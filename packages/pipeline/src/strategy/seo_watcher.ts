// SEOウォッチャー P-14 (v3 Sprint 2)。
// RSSフィードを取得し、新着をP-14で分類 (公式/推測の弁別が主任務) して seo_knowledge に蓄積。
// P-16戦略エージェントが importance>=7 のエントリを seo_knowledge_digest として読む。
// P-15 (影響翻訳→パイプライン変更提案) は次段 (importance>=7の裏取り解消後に走らせる)。
import { z } from "zod";
import { callAndParse, fillTemplate, getPrompt, type LLMClient } from "@kurimikan/shared";
import type { SeoKnowledgeInsert, Store } from "../db/types.js";

export interface FeedItem {
  title: string;
  url: string;
  excerpt: string;
  published_at?: string;
}

// 依存を増やさないための軽量RSS/Atomパーサ。標準的な<item>/<entry>を拾う。
// 取得できない/フィードでないURL (verify:trueの要確認フィード等) は空配列で返し、上流でスキップ。
export function parseFeed(xml: string): FeedItem[] {
  const decode = (s: string) =>
    s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .trim();
  const pick = (block: string, tag: string) => {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
    return m ? decode(m[1]!) : "";
  };
  const items: FeedItem[] = [];
  const blocks = [...xml.matchAll(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi)].map((m) => m[0]);
  for (const b of blocks) {
    const title = pick(b, "title");
    // RSSは<link>テキスト、Atomは<link href="..."/>
    let url = pick(b, "link");
    if (!url) {
      const href = /<link[^>]*href=["']([^"']+)["']/i.exec(b);
      url = href ? href[1]! : "";
    }
    const excerpt = (pick(b, "description") || pick(b, "summary") || pick(b, "content")).slice(0, 2000);
    const published_at = pick(b, "pubDate") || pick(b, "published") || pick(b, "updated") || undefined;
    if (title && url) items.push({ title, url, excerpt, published_at });
  }
  return items;
}

const P14Classification = z.object({
  source_type: z.string(),
  change_type: z.string(),
  confidence: z.string(),
  importance: z.number().min(0).max(10),
  affected_area: z.array(z.string()),
  summary_one_line: z.string(),
  corroboration_needed: z.boolean(),
});

export interface SeoWatcherDeps {
  store: Store;
  llm: LLMClient;
  suitePath: string;
  fetchImpl?: typeof fetch;
}

export interface SeoWatcherResult {
  fetched: number;
  classified: number;
  skipped: { feed: string; reason: string }[];
}

// RSSフィードを回して新着を分類・蓄積する。1フィード/1記事の失敗で全体を止めない。
export async function runSeoWatcher(
  deps: SeoWatcherDeps,
  opts: { perFeedLimit?: number } = {},
): Promise<SeoWatcherResult> {
  const f = deps.fetchImpl ?? fetch;
  const feeds =
    (await deps.store.getConfig<{ name: string; url: string }[]>("rss_feeds")) ?? [];
  const p14 = await getPrompt("P-14", deps.store.getPromptFromDb.bind(deps.store), deps.suitePath);
  const result: SeoWatcherResult = { fetched: 0, classified: 0, skipped: [] };
  const perFeed = opts.perFeedLimit ?? 5;

  for (const feed of feeds) {
    let items: FeedItem[];
    try {
      const res = await f(feed.url, { headers: { "user-agent": "kurimikan-seo-watcher/1.0" } });
      if (!res.ok) {
        result.skipped.push({ feed: feed.name, reason: `HTTP ${res.status}` });
        continue;
      }
      items = parseFeed(await res.text());
    } catch (e) {
      result.skipped.push({ feed: feed.name, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (items.length === 0) {
      result.skipped.push({ feed: feed.name, reason: "RSS項目を抽出できず (要フィードURL確認)" });
      continue;
    }

    let done = 0;
    for (const item of items) {
      if (done >= perFeed) break;
      result.fetched++;
      if (await deps.store.getSeoKnowledgeByUrl(item.url)) continue; // 既知はスキップ
      try {
        const c = await callAndParse(
          deps.llm,
          {
            promptId: "P-14",
            user: fillTemplate(p14, {
              feed_source: `${feed.name} (${feed.url})`,
              article_title: item.title,
              article_text: item.excerpt,
              published_at: item.published_at ?? "",
            }),
            job: "classify",
          },
          P14Classification,
        );
        const row: SeoKnowledgeInsert = {
          url: item.url,
          source: feed.name,
          title: item.title,
          source_type: c.source_type,
          change_type: c.change_type,
          confidence: c.confidence,
          importance: c.importance,
          affected_area: c.affected_area,
          summary_one_line: c.summary_one_line,
          corroboration_needed: c.corroboration_needed,
          raw_excerpt: item.excerpt.slice(0, 500),
          published_at: item.published_at,
        };
        await deps.store.insertSeoKnowledge(row);
        result.classified++;
        done++;
      } catch (e) {
        result.skipped.push({ feed: feed.name, reason: `分類失敗: ${e instanceof Error ? e.message : e}` });
      }
    }
  }
  return result;
}
