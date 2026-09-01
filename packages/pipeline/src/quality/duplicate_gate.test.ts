import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { FixtureLLMClient } from "@kurimikan/shared";
import { MemoryStore } from "../db/memory.js";
import {
  checkTopicDuplicate,
  DuplicateCheckUnavailableError,
  findTitleDuplicate,
  TITLE_DUP_THRESHOLD,
} from "./duplicate_gate.js";
import { similarity } from "../strategy/propose_keywords.js";

const SUITE = join(__dirname, "..", "..", "..", "..", "kurimikan_prompt_suite_v1.md");
const FIXTURES = join(__dirname, "..", "..", "..", "shared", "fixtures", "llm");

// 既存記事を1本持つ世界を作る (title/keywordは引数で指定)
async function makeWorld(existing: { title: string; keyword: string }[]) {
  const store = new MemoryStore();
  for (const e of existing) {
    const kw = store.addKeyword({ keyword: e.keyword, cluster: "renewal" });
    const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
    await store.updateArticle(a.id, { title: e.title, status: "published" });
  }
  return store;
}

const dupVerdict = (keyword: string, conflictsWith: string) =>
  JSON.stringify({
    verdicts: [
      { keyword, duplicate: true, conflicts_with: conflictsWith, reason: "同じ問いに答えている" },
    ],
  });

const passVerdict = (keyword: string) =>
  JSON.stringify({
    verdicts: [{ keyword, duplicate: false, conflicts_with: "", reason: "別の問い" }],
  });

describe("findTitleDuplicate: タイトルの近似一致 (決定論)", () => {
  const existing = [
    "ホームページリニューアルの費用相場と内訳を解説",
    "MEO対策の始め方｜Googleビジネスプロフィール最適化5ステップ",
  ];

  it("正規化して同一 (空白・大文字小文字ゆれ) なら重複", () => {
    expect(
      findTitleDuplicate("ホームページリニューアルの費用相場と内訳を解説 ", existing),
    ).toBe(existing[0]);
  });

  it("語尾だけ違うほぼ同一タイトルを拾う", () => {
    const candidate = "ホームページリニューアルの費用相場と内訳を紹介";
    expect(similarity(candidate, existing[0]!)).toBeGreaterThanOrEqual(TITLE_DUP_THRESHOLD);
    expect(findTitleDuplicate(candidate, existing)).toBe(existing[0]);
  });

  it("同じ主題の別切り口 (費用 vs 失敗事例) は拾わない", () => {
    const candidate = "ホームページリニューアルの失敗事例と回避策を解説";
    expect(similarity(candidate, existing[0]!)).toBeLessThan(TITLE_DUP_THRESHOLD);
    expect(findTitleDuplicate(candidate, existing)).toBeNull();
  });

  it("空文字は判定しない", () => {
    expect(findTitleDuplicate("", existing)).toBeNull();
    expect(findTitleDuplicate("何か", ["", ""])).toBeNull();
  });
});

describe("checkTopicDuplicate: 生成前のトピック判定", () => {
  it("キーワードが既存とほぼ同一なら LLM を呼ばずに hard 重複", async () => {
    // 実測0.750 (しきい値0.70超) の実例 (propose_keywords.tsの実測表を参照)
    const store = await makeWorld([
      { title: "FeliCa読み取りが遅い原因と対策", keyword: "iOS FeliCa 読み取り 遅い 原因" },
    ]);
    const llm = new FixtureLLMClient({ fixturesDir: FIXTURES }); // P-DUP fixtureなし=呼べば失敗する
    const verdict = await checkTopicDuplicate(
      { store, llm, suitePath: SUITE },
      { keyword: "iOS NFC FeliCa 読み取り 遅い 原因" },
    );
    expect(verdict).toMatchObject({ duplicate: true, hard: true });
    expect(llm.calls).toHaveLength(0); // 字面で決まる重複にLLMを使わない
  });

  it("字面が違っても意図照合 (P-DUP) が重複と言えば重複", async () => {
    const kw = "ホームページ リニューアル タイミング 見極め方";
    const store = await makeWorld([
      {
        title: "失敗しないホームページリニューアルの進め方",
        keyword: "ホームページ リニューアル 進め方 失敗",
      },
    ]);
    const llm = new FixtureLLMClient({
      fixturesDir: FIXTURES,
      responses: { "P-DUP": dupVerdict(kw, "失敗しないホームページリニューアルの進め方") },
    });
    const verdict = await checkTopicDuplicate(
      { store, llm, suitePath: SUITE },
      { keyword: kw, searchIntent: "リニューアルすべき時期を判断したい" },
    );
    expect(verdict).toMatchObject({ duplicate: true, hard: false });
    if (verdict.duplicate) {
      expect(verdict.reason).toContain("失敗しないホームページリニューアルの進め方");
    }
  });

  it("意図が別なら通す", async () => {
    const kw = "ホームページ リニューアル 費用 相場";
    const store = await makeWorld([
      {
        title: "失敗しないホームページリニューアルの進め方",
        keyword: "ホームページ リニューアル 進め方 失敗",
      },
    ]);
    const llm = new FixtureLLMClient({
      fixturesDir: FIXTURES,
      responses: { "P-DUP": passVerdict(kw) },
    });
    const verdict = await checkTopicDuplicate({ store, llm, suitePath: SUITE }, { keyword: kw });
    expect(verdict).toEqual({ duplicate: false, checked: true });
  });

  it("相手が0本なら判定しない (LLMも呼ばない)", async () => {
    const store = new MemoryStore();
    const llm = new FixtureLLMClient({ fixturesDir: FIXTURES });
    const verdict = await checkTopicDuplicate(
      { store, llm, suitePath: SUITE },
      { keyword: "何か新しい話" },
    );
    expect(verdict).toEqual({ duplicate: false, checked: false });
    expect(llm.calls).toHaveLength(0);
  });

  it("failClosed=true: 意図照合が失敗したら DuplicateCheckUnavailableError", async () => {
    const store = await makeWorld([{ title: "既存の何か", keyword: "既存 キーワード" }]);
    const llm = new FixtureLLMClient({ fixturesDir: FIXTURES }); // P-DUP fixtureなし=失敗
    await expect(
      checkTopicDuplicate(
        { store, llm, suitePath: SUITE },
        { keyword: "全然違う新しい話" },
        { failClosed: true },
      ),
    ).rejects.toThrow(DuplicateCheckUnavailableError);
  });

  it("failClosed=false: 意図照合が失敗しても通す (承認制では代表が歯止め)", async () => {
    const store = await makeWorld([{ title: "既存の何か", keyword: "既存 キーワード" }]);
    const llm = new FixtureLLMClient({ fixturesDir: FIXTURES });
    const verdict = await checkTopicDuplicate(
      { store, llm, suitePath: SUITE },
      { keyword: "全然違う新しい話" },
    );
    expect(verdict).toEqual({ duplicate: false, checked: false });
  });

  it("改修用キーワード (refit:) は判定相手に入らない", async () => {
    const store = new MemoryStore();
    const kw = store.addKeyword({ keyword: "refit:some-slug", cluster: "renewal" });
    const a = await store.createArticle({ keyword_id: kw.id, article_type: "howto", lane: "A" });
    await store.updateArticle(a.id, { title: "", status: "approval_pending", track: "revision" });
    const llm = new FixtureLLMClient({ fixturesDir: FIXTURES });
    // 相手がrefit行だけなら「相手0本」と同じ扱いになりLLMは呼ばれない
    const verdict = await checkTopicDuplicate(
      { store, llm, suitePath: SUITE },
      { keyword: "refit some slug" },
    );
    expect(verdict).toMatchObject({ duplicate: false });
    expect(llm.calls).toHaveLength(0);
  });
});
