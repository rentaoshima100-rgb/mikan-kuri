import { describe, expect, it } from "vitest";
import { AUTHOR_SEED, PIPELINE_CONFIG_SEED } from "./config_values.js";

const cfg = PIPELINE_CONFIG_SEED as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("config_values: 初期値", () => {
  it("公開ペースは週2本開始 (月8本相当)", () => {
    // 新規ドメインで編集体制と釣り合わない本数を出すと、
    // scaled content abuse の判定材料になる。増速は人間承認つき
    expect(cfg.weekly_publish_target).toBe(2);
    expect(cfg.velocity_stage).toBe(0);
  });

  it("クラスタ配分は合計100で、品種クラスタが主軸", () => {
    const a = cfg.cluster_allocation as Record<string, number>;
    const total = Object.values(a).reduce((s, v) => s + v, 0);
    expect(total).toBe(100);
    // 購買クエリに近いのは品種名。ここが最大でないと、記事が増えても
    // 押し上げたいコレクションに評価が集まらない
    const max = Math.max(...Object.values(a));
    expect(a.citrus_variety).toBe(max);
  });

  it("凍結フラグ: 注文データの記事化は凍結、SelfHealingは無効", () => {
    // 注文データはお客さまのデータなので、記事にしてよいかの判断が済むまで出さない
    expect(cfg.proposal_log_articles_enabled).toBe(false);
    expect(cfg.self_healing_enabled).toBe(false);
  });

  it("デッドマンスイッチは72時間 (フェイルクローズド)", () => {
    expect(cfg.approval_deadman_hours).toBe(72);
  });

  it("全自動公開の対象は一次情報を使わない記事から始める", () => {
    // 弊社は法令も文章も内部リンクも検証できるが、産地の事実 (収穫日・糖度・天候) は
    // 検証できない。まずは公開情報で裏が取れる型だけを自動に乗せる
    expect(cfg.auto_approve_scope).toBe("no_primary_info");
  });

  it("全自動公開は既定オフ", () => {
    // trueにしても法令ゲートは止まる (generate.ts)。
    // 既定をオフにしておくのは、承認が唯一の公開トリガという元の設計に戻せる安全弁のため
    expect(cfg.full_auto_publish).toBe(false);
  });

  it("コスト基準はSonnet標準価格 $3/$15", () => {
    const sonnet = cfg.model_pricing["claude-sonnet-4-6"];
    expect(sonnet).toEqual({ input_usd_per_mtok: 3, output_usd_per_mtok: 15 });
    expect(cfg.model_pricing["claude-haiku-4-5"]).toEqual({
      input_usd_per_mtok: 1,
      output_usd_per_mtok: 5,
    });
    expect(cfg.model_pricing["claude-opus-4-8"]).toEqual({
      input_usd_per_mtok: 5,
      output_usd_per_mtok: 25,
    });
  });

  it("モデルルーティング: 分類=Haiku、生成/判定=Sonnet、戦略/改修=Opus", () => {
    const r = cfg.model_routing;
    expect(r.classify).toBe("claude-haiku-4-5");
    expect(r.generate).toBe("claude-sonnet-4-6");
    expect(r.judge).toBe("claude-sonnet-4-6");
    expect(r.strategy).toBe("claude-opus-4-8");
    expect(r.coder).toBe("claude-opus-4-8");
  });

  it("品質閾値とレーンB許可タイプ", () => {
    expect(cfg.quality_thresholds).toEqual({ approve: 85, hold: 70 });
    expect(cfg.commodity_max).toBe(60);
    expect(cfg.lane_b_allowed_types).toEqual(["howto", "comparison", "season", "market_report"]);
  });

  it("公開先: ShopifyのブログhandleとサイトのベースURL", () => {
    expect(cfg.shopify_blog_handle).toBe("column");
    expect(cfg.site_base_url).toBe("https://kuri-mikan.jp");
  });

  it("コレクションは handle → label を持つ (アンカーテキスト検査に使う)", () => {
    const c = cfg.collections as Record<string, { label: string }>;
    expect(Object.keys(c).length).toBeGreaterThan(0);
    // labelが無いとアンカーテキストに品種名が入っているかを判定できない
    for (const [handle, def] of Object.entries(c)) {
      expect(def.label, `collections.${handle} に label がありません`).toBeTruthy();
    }
    expect(c.kanpei!.label).toBe("甘平");
  });

  it("狙い先コレクションを必須にしている", () => {
    // 押し上げる先の無い記事は成果を測れず、内部リンクの集中も起きない
    expect(cfg.require_target_collection).toBe(true);
  });

  it("法令チェックの例外は空で始まる", () => {
    // 根拠を示せる表現だけを、代表が個別に追加する
    expect(cfg.compliance_allowlist).toEqual([]);
  });

  it("tier1で変更してよいキーに、法令と設計の根幹を入れていない", () => {
    const allowed = cfg.tier1_allowed_keys as string[];
    expect(allowed).not.toContain("compliance_allowlist");
    expect(allowed).not.toContain("require_target_collection");
    expect(allowed).not.toContain("full_auto_publish");
  });

  it("順位監視の対象ドメインは自社サイト", () => {
    expect(cfg.rank_watch.target_domain).toBe("kuri-mikan.jp");
  });

  it("deny_listは空で始まる (実名をリポジトリにコミットしない)", () => {
    expect(cfg.deny_list).toEqual([]);
  });

  it("authors seedと監修表記に効能効果や最上級の表現が入っていない", () => {
    expect(AUTHOR_SEED.name).toBe("株式会社くり房");
    expect(AUTHOR_SEED.profile).toContain("宇和島");
    const json = JSON.stringify(AUTHOR_SEED) + JSON.stringify(cfg.supervision);
    for (const ng of ["日本一", "最高級", "無農薬", "免疫", "オーガニック"]) {
      expect(json, `禁止表現が含まれています: ${ng}`).not.toContain(ng);
    }
  });
});
