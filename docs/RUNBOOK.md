# 運用手順書 (RUNBOOK)

くりとみかん 記事パイプラインの日常運用と障害対応の手順です。
設計上の前提は次の2文に集約されます。

> **記事は代表が承認しない限り、1本も公開されない。**
> **法令ゲートで止まった記事は、全自動公開を有効にしていても公開されない。**

---

## 1. 初期セットアップ

### 1-1. Shopifyのカスタムアプリ

ストア管理画面 → 設定 → アプリと販売チャネル → アプリを開発 → アプリを作成。

- Admin API のスコープ: **`write_content`**（記事とブログの読み書き）
- 発行されたアクセストークン（`shpat_...`）を `.env` の `SHOPIFY_ADMIN_TOKEN` へ
- `SHOPIFY_SHOP` はサブドメイン（`kurifusa`）でも FQDN（`kurifusa.myshopify.com`）でも可

トークンはこのリポジトリにコミットしないでください。
GitHub Actions で使う場合は Secrets に登録します。

### 1-2. DBとseed

```bash
supabase db reset            # または supabase/migrations/*.sql を番号順に実行
npm run seed:prompts
npm run seed:config
```

### 1-3. ブログの作成

```bash
npm run shopify:bootstrap-blog -- --dry-run   # 何が作られるか確認
npm run shopify:bootstrap-blog                # 実行
```

冪等です。既に `/blogs/column` があれば何もせず終了します。
二重に作ると `/blogs/column-1` のような handle が払い出され、
以後の記事が全部そちらへ入ってしまうので、必ずこのスクリプトから作ってください。

### 1-4. コレクションの handle 合わせ

`pipeline_config.collections` の handle が実際のストアと一致している必要があります。
ズレていると記事から404リンクが張られます。

```sql
select value from pipeline_config where key = 'collections';
```

Shopify管理画面のコレクション一覧と突き合わせて、違っていれば更新してください。

### 1-5. GitHub Secrets

| Secret | 用途 | 無いとどうなるか |
|---|---|---|
| `SHOPIFY_SHOP` / `SHOPIFY_ADMIN_TOKEN` | 公開ワーカ | 記事が公開されません |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | 全ジョブ | 全ジョブが失敗します |
| `ANTHROPIC_API_KEY` | 発案・生成・SEO監視 | 日次ジョブが毎日失敗します |
| `INDEXNOW_KEY` | 公開通知 | インデックスが遅くなります（公開自体は成立） |
| `GSC_SERVICE_ACCOUNT_JSON` | 計測 | 順位とクリックが取れません |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | 順位監視・SERP差分 | どちらも自動スキップされます |

---

## 2. 毎日

日次ジョブ（`cron-daily`、JST 6:00）が次の順で動きます。

```
GSC同期 → 順位監視 → 発案 → リサーチ → 生成 → SEO監視 → トリップワイヤ → デッドマン
```

生成物はすべて承認キューで止まります。このジョブは記事を公開しません。

### 代表がやること

1. 管理画面 `/` を開く
2. 承認待ちの記事を読む。特に見るのは次の3点
   - **法令チェックの結果**（`quality.compliance`）。指摘があれば表現を直すか記事ごと捨てる
   - **コレクション導線**（`quality.collection_link`）。品種名入りのアンカーで刺さっているか
   - **human_review_notes**（P-04が抽出した「確認すべき箇所トップ3」）
3. 問題なければ承認する。承認した記事は毎時の公開ワーカが Shopify へ出す
4. `/keywords` でトピック提案を承認する（どのコレクションを押し上げるかを決める）

### 承認しないとどうなるか

公開予定時刻から72時間で承認が失効し、記事は承認待ちに戻ります（デッドマンスイッチ）。
記事が消えるわけではないので、再度承認すれば公開できます。
不在が続くときは、新規公開がゼロになるのが正しい状態です。

---

## 3. 毎週

- 承認キューの滞留を確認する。積みすぎると読み切れず、デッドマンで戻るだけになります
- **一次情報の在庫を確認する。** 畑の写真、収穫日、糖度の実測、その年の天候。
  ここが枯れたら、記事を増やす前に一次情報を集めるのが正しい順番です

---

## 4. 毎月

月次戦略（`cron-monthly`、P-16）が来月の方針を出します。`/strategy` で読みます。

判断の順番は次のとおりです（P-16にもそう指示してあります）。

1. **コレクションページの順位とクリックが上がったか。** これが主指標です
2. **束ねる設計が守れているか。** 1つのコレクションに4〜6本が集中しているか。
   集中していなければ、新しい品種に手を広げる前に既存の束を厚くする
3. **季節性。** 柑橘は10月から3月、栗は秋がピーク。ピークの2〜3か月前に記事が出て、
   インデックスされ、順位が付いている必要があります
4. **公開ペース。** 月4〜8本が上限の目安。増速は根拠つきで

コレクションごとの記事本数はこう数えます。

```sql
select target_collection, count(*)
from keywords k
join articles a on a.keyword_id = k.id
where a.status = 'published'
group by target_collection
order by count(*) desc;
```

---

## 5. 障害対応

### 5-1. 法令ゲートで記事が却下された

`quality.rejected_reason` に「法令ゲート」と入っています。`quality.compliance.violations`
に、検出された表現・理由・書き換え案が入っています。

- **表現を直す**: プロンプト側の問題なら `prompts` テーブルの該当プロンプトを直す
- **根拠がある**: 受賞歴などで裏が取れる表現なら `compliance_allowlist` に登録する。
  検出箇所の前後30字にその文字列が含まれていれば見逃されます
- **記事ごと捨てる**: 効能効果に頼らないと成立しない切り口なら、トピックごと `parked` に

`compliance_allowlist` は自己改修（P-17）で変更できないようにしてあります
（`tier1_allowed_keys` に入れていない）。

### 5-2. 公開ワーカが失敗する

`publish_attempts` に試行結果が残ります。よくある原因:

| メッセージ | 原因 | 対処 |
|---|---|---|
| `ブログ /blogs/column が見つかりません` | ブログ未作成 | `npm run shopify:bootstrap-blog` |
| `Shopify APIがHTTP 401` | トークンが無効 | カスタムアプリでトークンを再発行 |
| `Shopify APIがHTTP 403` | スコープ不足 | `write_content` を付け直す |
| `articleCreate が userErrors` | handleの重複など | メッセージの `field` を見る |
| `改修対象がShopify記事IDを持っていません` | 改修対象が未公開 | 通常の公開経路で1度公開する |

公開ワーカは1件失敗しても次の候補へ進みます（先頭が居座って後続を止めない）。
キュー行は有効なまま残るので、原因を直せば次回の実行で公開されます。

### 5-3. haltトリップワイヤが立った

手動対策の受領などで `halt` が立つと、公開ワーカは全件をスキップします。
**解除は人間だけが行えます。**

```sql
select * from tripwire_events where resolved = false order by created_at desc;
```

原因を解消してから `/ops` で解除してください。

### 5-4. 承認が失効した（デッドマン）

`expired_reason` が入り、記事は `approval_pending` に戻っています。
内容を確認したうえで、問題なければ再度承認してください。

### 5-5. 公開した記事を取り消したい

Shopify管理画面で該当記事を非公開にするのが最短です。
DB側は `articles.status` を `retired` にして、公開キューの行を取り消します。

記事の中身を直したい場合は、取り消すより改修（`npm run refit:batch`）のほうが
既存の順位を保てます。改修はURLを変えません。

### 5-6. 予算超過

月間の消費が `MONTHLY_TOKEN_BUDGET_USD` の100%に達すると、生成系が停止します
（フェイルクローズド）。公開ワーカは止まりません（承認済みの記事は出ます）。

---

## 6. 改修（refit）

公開済み記事を P-13a診断 → P-13b改稿 → P-04ゲート で作り直し、承認キューに積みます。

```bash
npm run refit:batch -- --plan              # 対象一覧だけ表示
npm run refit:batch -- --limit 3           # 3本だけ
npm run refit:batch -- --slug kanpei-price # 1本だけ
npm run refit:batch -- --redo              # 未公開の改修案を破棄して作り直す
```

改修案は **slug を持ちません**。公開中の記事がURLを握ったままにするためです。
承認して公開に成功した時点で、slug と Shopify記事IDが改修案へ移り、旧行は `retired` に
なります。Shopify上の記事は1本のままで、中身だけが差し替わります。

`--redo` は承認済み・公開済みの改修案を破棄しません（代表の判断を勝手に捨てないため）。
作り直したい場合は管理画面で取り消してから再実行してください。

---

## 7. 内部リンクの承認

新しい記事から既存記事へのリンク（outbound）は公開時に自動で入ります。
既存の公開済み記事から新しい記事へのリンク（inbound）は、**公開済み記事の書き換え**に
あたるため、`/links` で人間が承認します。

承認すると、本文（`articles.body_mdx`）が書き換わり、公開済みの記事は Shopify へ
再公開されます（`articleUpdate`）。再公開に失敗しても本文の書き換えは残ります。
巻き戻すと「DBとストアのどちらが正か」が実行のたびに変わってしまうためで、
失敗はログに残り、次の公開機会か手動の再実行で追いつきます。

---

## 8. 設定を変える

```sql
select key, value from pipeline_config order by key;
update pipeline_config set value = '4'::jsonb where key = 'weekly_publish_target';
```

変更してはいけないもの:

- `require_target_collection` を `false` にする（狙い先の無い記事が作られる）
- `compliance_allowlist` に、根拠を示せない表現を入れる
- `tier1_allowed_keys` に上の2つを追加する

`full_auto_publish` を `true` にすると、品質ゲートの結果に関わらず自動承認・即時公開に
なります。法令ゲート、トリップワイヤ、デッドマン、重複ゲート、コレクション導線の必須化は
この設定でも効いたままです。`false` に戻せば元の挙動に完全復帰します。
