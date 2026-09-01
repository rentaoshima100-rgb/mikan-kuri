# mikan-kuri

株式会社くり房（ブランド: くりとみかん / [kuri-mikan.jp](https://kuri-mikan.jp)）の
AI記事生成パイプライン。記事は Shopify の `/blogs/column` へ公開されます。

仕様: [`kurimikan_pipeline_spec.md`](kurimikan_pipeline_spec.md)（最優先） /
[`kurimikan_prompt_suite_v1.md`](kurimikan_prompt_suite_v1.md)（プロンプト集の正本）。

**公開のトリガは「代表が実記事を読んで承認ボタンを押す」の1つだけ。自動公開は存在しません。**
**法令ゲート（薬機法・景表法ほか）は、全自動公開を有効にしても止まります。**

---

## この案件で記事を書く目的

記事は売るために書くのではなく、**コレクションページを押し上げるために**書きます。

購買クエリ（「甘平 通販」「甘平 訳あり 3kg」）で上位を取るべきなのはカートのある
`/collections/kanpei` であって、記事ではありません。関連する記事を4〜6本束ねて
そのコレクションへ内部リンクを集中させ、ページの重要度とトピックの網羅性を証明します。

したがって記事のKPIは **「その記事が何個売ったか」ではなく「リンク先コレクションの
順位とクリックが上がったか」** です。記事単体のCVで判断すると全部失敗に見えて、
正しい施策を捨てることになります。

詳しくは仕様書のセクション1。

---

## 構成

```
packages/shared      zodスキーマ / LLMクライアント / プロンプトローダ / コストガード
packages/pipeline    生成オーケストレータ (承認制) / 承認フロー / 公開ワーカ /
                     Shopify統合 / 改修バッチ / 計測 / トリップワイヤ / SERP
packages/admin       管理画面: 承認キュー / 一括レビュー / 運用 (トリップワイヤ・AI CV)
scripts/shopify      ブログ (/blogs/column) の作成
scripts/seed         プロンプトseed / config初期値投入
scripts/jobs         cronエントリポイント (hourly / daily / monthly)
supabase/migrations  SQLマイグレーション
tests/               dry_runエンドツーエンド統合テスト
```

### 品質ゲート（LLMを使わない決定論の関門）

プロンプトの自主規制と二重にかけています。プロンプトだけに任せない理由は、
LLMの判定が揺れると「チェック済み」と言えないためです。

| モジュール | 検査する内容 |
|---|---|
| `quality/compliance_gate.ts` | 薬機法・健康増進法・景品表示法・特別栽培農産物ガイドライン |
| `quality/collection_link.ts` | 狙い先コレクションへの内部リンクとアンカーテキスト |
| `quality/notation.ts` | 表記規則（長音省略、ダッシュ不使用、1文60字目安） |
| `quality/duplicate_gate.ts` | 同じ内容の記事を二度公開しない |

---

## セットアップ

### 1. 依存関係

```bash
npm ci
```

### 2. 環境変数

`.env.example` をコピーして `.env` を作り、値を入れます。

最低限必要なもの: `ANTHROPIC_API_KEY` / `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` /
`SHOPIFY_SHOP` / `SHOPIFY_ADMIN_TOKEN`。

### 3. Shopifyのカスタムアプリ（人間タスク）

ストア管理画面 → 設定 → アプリと販売チャネル → アプリを開発 → アプリを作成。
Admin API のスコープに **`write_content`**（または `write_online_store_pages`）を付けて
アクセストークンを発行し、`SHOPIFY_ADMIN_TOKEN` に入れます。
トークンはこのリポジトリにコミットしないでください。

### 4. DBマイグレーション

Supabase CLI がある場合:

```bash
supabase db reset
```

無ければ `supabase/migrations/*.sql` を番号順に SQL エディタで実行します。

### 5. 初期投入

```bash
npm run shopify:bootstrap-blog
npm run seed:prompts
npm run seed:config
```

`shopify:bootstrap-blog` は冪等です。既に `/blogs/column` があれば何もしません。
`--dry-run` を付けると作成せずに内容だけ表示します。

### 6. configの実値合わせ（人間タスク）

`pipeline_config.collections` の handle が、実際のストアのコレクション handle と
一致している必要があります。ズレていると内部リンクが404になります。
Shopify管理画面のコレクション一覧で確認して、必要なら修正してください。

---

## 日常の運用

```bash
npm run propose:keywords   # トピック発案 (承認したものだけが記事化される)
npm run generate:queue     # 承認済みキーワードから記事生成
npm run refit:batch        # 公開済み記事の改修
npm run dedup:sweep        # 公開前バックログの重複掃除
```

管理画面:

```bash
npm run dev -w @kurimikan/admin
```

代表がやることは6つだけです。

1. 承認キューで記事を読んで承認する（公開の唯一のトリガ）
2. 一次情報を入れる（畑の写真、収穫日、糖度の実測、その年の天候）
3. トピック提案の承認（どのコレクションを押し上げるかを決める）
4. 内部リンク承認キュー（公開済み記事の書き換えになるため）
5. トリップワイヤ（halt / throttle）の解除
6. 法令ゲートで止まった記事の判断

運用手順の詳細は [docs/RUNBOOK.md](docs/RUNBOOK.md)。

---

## 開発

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest run (dry_run。実APIは呼ばない)
```

テストは実APIも実DBも使いません。Shopifyは `ShopifyAdminClient` の `fetch` を
差し替えた偽ストアで受けます（`tests/e2e_dry_run.test.ts`）。公開器・markdown→HTML変換・
metafieldの組み立ては本物が動きます。

作業規約は [`CLAUDE.md`](CLAUDE.md)。

### フィクスチャについて

`packages/shared/fixtures/llm/` の題材は分岐元（別サイト向けの同系パイプライン）のままです。
テストダブルであり、検証している内容（配線、リトライ、しきい値）は題材に依存しません。
差し替えると、実測値に基づくしきい値のテストを書き直すことになり、
そこに埋め込まれた回帰知識を失います。

---

## 人間タスク（未完了）

- [ ] Shopifyカスタムアプリのトークン発行（`write_content`）
- [ ] `pipeline_config.collections` の handle を実際のストアに合わせる
- [ ] `supervision.byline` を実際に監修する人の氏名と肩書に差し替える
- [ ] テーマの article テンプレートに構造化データ（Article / BreadcrumbList）を実装
- [ ] `/blogs/column` 用の `templateSuffix`（末尾のコレクション誘導ブロック）
- [ ] コレクションページ本文の追加（品種の特徴・時期・食べ方を数百字）
- [ ] IndexNowキーの生成と `https://kuri-mikan.jp/<キー>.txt` の配置
- [ ] GitHub Secrets の登録（`SHOPIFY_SHOP`, `SHOPIFY_ADMIN_TOKEN`, `SUPABASE_*` ほか）
- [ ] Search Console / GA4 のサービスアカウント発行
- [ ] `estat_targets` に農林水産省の統計ID（作付面積・出荷量）を投入
