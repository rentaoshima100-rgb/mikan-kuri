# CLAUDE.md — mikan-kuri 作業規約

株式会社くり房 (ブランド: くりとみかん / kuri-mikan.jp) のAI記事生成パイプライン。
仕様は以下の2ファイル。矛盾時は仕様書が優先:

1. `kurimikan_pipeline_spec.md` — **確定仕様 (最優先)**
2. `kurimikan_prompt_suite_v1.md` — プロンプト集 (`prompts` テーブルの正本)

どちらにも書いていない事項は安全側 (より制限が強い方) で実装し、PRで報告する。

このリポジトリは nortiq-pipeline から分岐したものです。運転の骨格 (承認フロー、
デッドマン、トリップワイヤ、重複ゲート、コスト計上) はそのまま引き継ぎ、
公開先と記事の中身に関わる部分を作り替えています。差分は仕様書のセクション9。

## 絶対ルール (変更禁止)

- **自動公開は存在しない。** (既定 `full_auto_publish=false`) 公開トリガは「代表が実記事を
  読んで承認ボタンを押す」のみ。全記事 `status=approval_pending` で承認キューへ
- **フェイルクローズド。** 公開予定時刻から72時間超の未公開分は保留に戻す。
  代表不在時は新規公開ゼロが正しい
- **judge不一致は人間エスカレーション。** 自動棄却も自動通過もしない
- **法令ゲートは全自動公開でも止まる。** 順位が落ちるだけのGoogleと違い、薬機法・
  景表法は販売者に行政指導が来る。`full_auto_publish=true` の例外にしない
- **狙い先コレクションの無い記事を作らない。** 記事はコレクションを押し上げるために
  書く。成果を測る先が無い記事は仕様上あり得ない (`require_target_collection=true`)
- **SelfHealingCoder (P-17) は初期スコープ外。** `self_healing_enabled=false`
- **保護ファイル** (CODEOWNERS参照) はいかなる自己改修・リファクタリングでも変更しない。
  変更が必要なら実装せず理由を添えて確認を求める

## この案件の設計で外してはいけない点

記事の成果指標は「その記事が何個売ったか」ではなく
**「リンク先コレクションの順位とクリックが上がったか」** です。
記事単体のCVで判断すると全部失敗に見えて、正しい施策を捨てることになります。

- 1つのコレクションに4〜6本を集中させる。バラバラに1本ずつでは何も動かない
- アンカーテキストに品種名を入れる。「こちら」は評価の受け渡しが起きない
- 一次情報 (収穫日、糖度の実測、その年の天候、畑の様子) を1記事に必ず1個。
  ここが枯れたら記事を増やす前に一次情報を集める

## 配信方式

Shopify Admin GraphQL API (最新 2026-07) で `/blogs/column/<handle>` へ公開する。
SEOのtitle/descriptionは metafield (`global.title_tag` / `global.description_tag`)。
本文はHTML文字列なので markdown からの変換層を通す。

改修 (revision) は slug を持たず `revision_of` で対象を指す。公開成功時に
「公開中の座」(slug と shopify_article_id) を改修案へ移し、旧行を retired にする。

## 進め方

- 1タスク=1ブランチ=1PR。ブランチ名に目的を含める (例: `feat/collection-cta`)
- 各PRはAcceptance Criteriaをテストで証明してから出す。実APIを呼ばず
  `PIPELINE_ENV=dry_run` で全テストが回ること
- 外部APIキー未取得の箇所はモック+切替フラグで先へ進み、READMEのTODOに残す
- コミットする文章・コード・コメントに、お客さまの個人情報や取引先の実名を絶対に含めない
- 記事生成物の表記規則 (カタカナ語末尾の長音省略 / ダッシュ記号不使用 / 敬体 /
  品種名の正式表記) はP-00が担保するが、品質ゲートの機械チェックにも実装する

## コマンド

```
npm run typecheck                # tsc --noEmit
npm run lint                     # eslint
npm test                         # vitest run (dry_run前提、実API呼び出し禁止)
npm run shopify:bootstrap-blog   # /blogs/column を作成 (初回に1度だけ)
npm run seed:prompts             # プロンプト集をパース→promptsテーブルへ投入
npm run seed:config              # pipeline_config初期値 + authors投入
```

Supabaseマイグレーションは `supabase/migrations/` (0001〜)。
ローカル適用は Supabase CLI (`supabase db reset`)、なければREADMEの人間タスク参照。

## モデルルーティング (pipeline_config.model_routing)

| 用途 | モデルID |
|---|---|
| 分類系 (classify) | `claude-haiku-4-5` |
| 生成・判定 (generate/judge) | `claude-sonnet-4-6` |
| 第2系統judge (任意) | OpenAI (OPENAI_API_KEY があれば) |
| 戦略・改修 (strategy/coder) | `claude-opus-4-8` |

コスト基準は Sonnet 標準価格 $3/$15。
