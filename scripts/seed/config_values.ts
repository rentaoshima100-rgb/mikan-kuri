// pipeline_config と authors の初期値。
// seed_config.ts がこの値をDBへ投入する。運用中の変更は管理画面またはSQLから行い、
// 恒久的な変更はここへ書き戻す。

export const PIPELINE_CONFIG_SEED: Record<string, unknown> = {
  // 公開ペース: 週2本開始 (月8本相当)。
  // 新規ドメイン (2025-02公開) で編集体制と釣り合わない本数を出すと、
  // Googleの scaled content abuse の判定材料になる。増速は人間承認つき
  weekly_publish_target: 2,
  velocity_stage: 0,

  // 品質ゲート
  quality_thresholds: { approve: 85, hold: 70 },
  commodity_max: 60,

  // キーワード配分。品種そのもの (品種名クエリ) を主軸にする。
  // 栗は秋、柑橘は10月から3月がピークなので、配分は月次戦略 (P-16) で季節に合わせて動かす
  cluster_allocation: { citrus_variety: 45, eating: 20, gift: 15, growing: 12, chestnut: 8 },

  // 旧nortiq版の凍結フラグ。この案件では ai_llmo クラスタが存在しないため常にtrueのまま。
  // 参照箇所を消していないので、seedしないと getConfig が null を返して既定値に落ちる
  ai_llmo_expansion_frozen: true,
  ai_llmo_unfreeze_cv_range: { min: 30, max: 50 },

  // 注文データを集計した相場記事 (P-09) は、お客さまのデータを記事にしてよいかの
  // 判断が済むまで凍結する
  proposal_log_articles_enabled: false,

  // SelfHealingCoder は初期スコープ外
  self_healing_enabled: false,

  // 全自動公開。true のとき品質ゲートの結果に関わらず自動承認+即時公開する。
  // 法令ゲート (compliance_gate) だけはこの設定でも止まる。順位が落ちるだけの
  // Googleと違い、薬機法・景表法は販売者に行政指導が来るため速度優先の対象外
  full_auto_publish: false,

  // 全自動公開の対象範囲。自動化を段階的に上げるための刻み。
  //   "no_primary_info" — 一次情報を使っていない記事だけ自動承認する。保存方法・むき方・
  //     品種比較など、事実が公開情報で裏を取れる型が該当する。産地の実測 (収穫日・糖度・
  //     その年の天候) を含む記事は、それを検証できる人が読むまで承認キューに残る
  //   "all" — 承認待ちの全記事
  // full_auto_publish=false の間は参照されない
  auto_approve_scope: "no_primary_info",

  // API節約: 全自動時は生成/改稿を1パスで打ち切る。
  // ただし法令違反があるときは1パス短縮を適用せず、必ず書き直させる (generate.ts)
  full_auto_single_pass: true,

  // デッドマンスイッチ: 公開予定から72時間を過ぎた未公開分は保留に戻す
  approval_deadman_hours: 72,

  // 承認済みバックログの上限 (日)。超えると警告のみ。
  // 柑橘は季節商材で、承認から公開まで空くと時期の記述が実際とずれる
  approval_backlog_limit_days: 28,

  // 改修 (revision) トラックの公開ペース。1日あたりの本数。
  // 既存URLの中身を直すだけで新規URLが増えないため、週次目標と増速ゲートの対象外
  revision_publish_per_day: 5,

  // レーンB (下書きジェネレータ) が扱える記事タイプ
  lane_b_allowed_types: ["howto", "comparison", "season", "market_report"],

  // ---- この案件で追加した設定 ----

  // 公開先のブログhandle。キーワード側の blog_handle が優先される。
  // お知らせ (/blogs/news) と分けるのは、テンプレートを分けられることと、
  // 読み物が混ざると出荷情報が埋もれるため
  shopify_blog_handle: "column",
  site_base_url: "https://kuri-mikan.jp",

  // コレクション (handle → 表示名)。記事はこのどれかを押し上げるために書く。
  // label は内部リンクのアンカーテキスト検査に使う (アンカーに品種名が入っているか)。
  // handle は実際のストアの値に合わせて修正すること
  collections: {
    kanpei: { label: "甘平" },
    nankan20: { label: "南柑20号" },
    "beni-madonna": { label: "紅まどんな" },
    "kawachi-bankan": { label: "河内晩柑" },
    ponkan: { label: "ポンカン" },
    iyokan: { label: "伊予柑" },
    shiranui: { label: "不知火" },
    "unshu-mikan": { label: "温州みかん" },
    kuri: { label: "栗" },
    takenoko: { label: "たけのこ" },
  },

  // コレクション以外でリンクしてよい実在のパス。
  // ここに無いパスをP-11が返しても本文には入らない (404リンクの自動挿入を防ぐ)
  linkable_pages: ["/pages/about", "/pages/shipping"],

  // 狙い先コレクションの無い記事を生成しない。
  // 成果を測る先が無く、内部リンクの集中も起きないため仕様上あり得ない
  require_target_collection: true,

  // コレクション導線の文面に使う産地の呼び方
  producer_origin: "愛媛・宇和島産",

  // 法令チェックの例外。根拠を示せるので使ってよいと代表が判断した表現。
  // 検出箇所の前後30字にこの文字列が含まれていれば見逃す
  // (例: 受賞歴の出典を併記したうえでの最上級表現)
  compliance_allowlist: [],

  // ---- ここまで ----

  // モデルルーティング
  model_routing: {
    classify: "claude-haiku-4-5",
    generate: "claude-sonnet-4-6",
    judge: "claude-sonnet-4-6",
    // 合議の第2系統 (P-05b-2) は judge カテゴリを使う。
    // 第1系統 (P-05b) は classify なので、Haiku と Sonnet の異モデル2者になる
    strategy: "claude-opus-4-8",
    coder: "claude-opus-4-8",
  },

  // コスト基準: Sonnet標準価格 $3/$15
  model_pricing: {
    "claude-haiku-4-5": { input_usd_per_mtok: 1, output_usd_per_mtok: 5 },
    "claude-sonnet-4-6": { input_usd_per_mtok: 3, output_usd_per_mtok: 15 },
    "claude-opus-4-8": { input_usd_per_mtok: 5, output_usd_per_mtok: 25 },
  },

  // 記事に出してはいけない語のdeny-list (取引先名など)。
  // 実名はこのリポジトリにコミットしない。運用開始時に管理画面またはDBから投入する
  deny_list: [],

  // SEOウォッチャーのRSSフィード
  rss_feeds: [
    { name: "Google Search Central Blog", url: "https://feeds.feedburner.com/blogspot/amDG" },
    { name: "Google Search Status Dashboard", url: "https://status.search.google.com/en/feed.atom" },
    { name: "Search Engine Land", url: "https://searchengineland.com/feed" },
    { name: "Search Engine Journal", url: "https://www.searchenginejournal.com/feed/" },
    { name: "Search Engine Roundtable", url: "https://www.seroundtable.com/index.xml" },
    { name: "海外SEO情報ブログ", url: "https://www.suzukikenichi.com/blog/feed/" },
    { name: "Web担当者Forum", url: "https://webtan.impress.co.jp/rss.xml" },
  ],

  // e-Stat同期対象 (statsDataId)。柑橘の作付面積・出荷量など。
  // 運用開始時に投入する (農林水産省 特産果樹生産動態等調査ほか)
  estat_targets: [],

  // SERP差分チェック。DATAFORSEO_LOGIN/PASSWORD設定後に enabled=true へ
  serp_check: { enabled: false, provider: "dataforseo", top_n: 10 },

  // 順位監視。追跡対象 = keywords (手動指定、優先) + 公開済み記事のキーワード (自動)。
  // credsが無ければ自動スキップするため enabled は既定true
  rank_watch: { enabled: true, target_domain: "kuri-mikan.jp", keywords: [], max_keywords: 30 },

  // クラスタ → Shopifyの記事タグ。記事一覧の絞り込みに使う
  blog_category_map: {
    citrus_variety: "品種",
    growing: "畑と栽培",
    eating: "食べ方と保存",
    gift: "ギフト",
    chestnut: "栗",
  },

  // 監修表記。承認済み記事のみ本文末尾に付く (公開経路を通るのは承認済みのみ)。
  // TODO(人間): 実際に監修する人の氏名と肩書に差し替える
  supervision: {
    byline: "監修: 株式会社くり房",
    ai_disclosure: "本記事はAIを活用して制作しています",
  },

  // tier1で変更してよいconfigキーのホワイトリスト。
  // self_healing_enabled=false の間は参照されないが、将来の有効化に備えて保持。
  // compliance_allowlist と require_target_collection は入れない (法令と設計の根幹)
  tier1_allowed_keys: ["model_routing", "rss_feeds", "deny_list", "estat_targets"],
};

export const AUTHOR_SEED = {
  name: "株式会社くり房",
  byline: "愛媛県宇和島市吉田町の柑橘農家",
  profile:
    "愛媛県宇和島市吉田町で柑橘を栽培しています。宇和海に面した段々畑で、温州みかん、南柑20号、紅まどんな、甘平などを育て、収穫したものを直接お届けしています。",
  credentials: "生産者",
};
