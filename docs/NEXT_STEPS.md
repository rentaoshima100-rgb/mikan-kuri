# 残タスク（立ち上げ手順）

最終更新: 2026年9月。コードで作れるものは実装済みです。
ここは外部設定・対話認証・判断が必要な作業に絞っています。

---

## 1. これをやらないと1本も公開できない

### 1-1. Shopifyカスタムアプリのトークン

ストア管理画面 → 設定 → アプリと販売チャネル → アプリを開発 → アプリを作成。
Admin API のスコープに **`write_content`** を付けてアクセストークンを発行します。

`.env` の `SHOPIFY_SHOP` と `SHOPIFY_ADMIN_TOKEN` に入れます。
GitHub Actions で動かすなら Secrets にも登録します。

### 1-2. Supabase

プロジェクトを作り、`supabase/migrations/*.sql` を番号順に実行します。
`SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` を `.env` へ。

### 1-3. 初期投入

```bash
npm run shopify:bootstrap-blog   # /blogs/column を作成
npm run seed:prompts
npm run seed:config
```

### 1-4. コレクションの handle 合わせ

`pipeline_config.collections` の handle が実際のストアと一致していないと、
記事から404リンクが張られます。Shopify管理画面のコレクション一覧と突き合わせて、
違っていれば更新してください。

```sql
select value from pipeline_config where key = 'collections';
```

---

## 2. 記事の質に直結するもの

### 2-1. 一次情報を入れる

**ここが最優先です。** 空のまま記事を作ると、P-04 が独自性で落とすか、
通っても中身が上位記事の言い換えになります。

手順は [PRIMARY_ASSETS.md](PRIMARY_ASSETS.md)。
まずは糖度の実測を1件、その年の天候を1件、選別基準を1件でも入れてください。

### 2-2. 監修表記

`pipeline_config.supervision.byline` が「監修: 株式会社くり房」のままです。
実際に記事をレビューする人の氏名と肩書に差し替えてください。

### 2-3. テーマ側の実装

- article テンプレートに構造化データ（Article / BreadcrumbList）を入れる
- `/blogs/column` 用の `templateSuffix` を作り、末尾にコレクション誘導ブロックを置く
- コレクションページ本文を足す。商品グリッドだけでは受け皿として弱いので、
  品種の特徴・時期・食べ方を数百字
- ブログ一覧をグローバルナビに置く

---

## 3. 計測（後からでよいが早いほど良い）

- Search Console のプロパティ登録とサービスアカウント発行（`GSC_SERVICE_ACCOUNT_JSON`）
- GA4 のプロパティIDとサービスアカウント（`GA4_PROPERTY_ID` / `GA4_SERVICE_ACCOUNT_JSON`）
- IndexNowキーを生成し、`https://kuri-mikan.jp/<キー>.txt` に同じ文字列を1行で置く
- DataForSEO の登録（順位監視とSERP差分。未登録なら自動スキップされます）
- `estat_targets` に農林水産省の統計ID（特産果樹生産動態等調査ほか）

---

## 4. 最初の記事をどう選ぶか

**1つのコレクションに4〜6本を集中させてください。** 30本をバラバラのコレクションに
1本ずつでは何も動きません。

甘平か南柑20号のどちらかに絞って、次のような束を作るのが最初の一手です。

| 記事 | 記事タイプ |
|---|---|
| 甘平とは（品種の特徴） | `comparison` または `howto` |
| 甘平と紅まどんなの違い | `comparison` |
| 甘平の旬はいつ | `season` |
| 甘平の保存方法 | `howto` |
| 甘平の値段と選び方 | `pricing` |

すべて `target_collection = "kanpei"` にします。反応（コレクションの順位とクリック）を
見てから次の品種へ広げてください。

季節性に注意してください。柑橘は10月から3月がピークで、SEOの立ち上がりは3〜6か月です。
ピークの2〜3か月前に記事が出て、インデックスされている必要があります。
