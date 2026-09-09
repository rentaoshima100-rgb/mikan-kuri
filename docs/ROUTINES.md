# サブスク実行 (Claude Code Routines) — LLM呼び出しのAPIキー廃止

パイプラインのLLM呼び出しを、従量課金のAPIキー (`ANTHROPIC_API_KEY`) から、
Claude Codeサブスクリプションの定期クラウドルーチン (https://claude.ai/code/routines) へ
移したときの手順書。nortiq-pipeline で確立した構成を、この案件へ移植したもの。

## 仕組み (LLMブリッジ)

「クラウド下書き」(`cloud_drafts`) で確立した **Claude Codeエージェント自身が書く** 構成を、
全LLMステップに拡張したもの。パイプラインのコードは一切APIを呼ばず、ルーチンのセッションで
動くエージェントがLLM役を務める。

```
routine_daily.ts (バックグラウンド実行)
  └─ BridgeLLMClient.call()
       ├─ .llm-bridge/req-0001.json を書く   {kind, seq, promptId, system, user, ...}
       │     ← エージェントが読み、指示に従って出力を作り、
       │        npx tsx scripts/bridge_reply.ts 1 --text out.txt で応答
       └─ .llm-bridge/res-0001.json を読む   {text: "..."}  (または {error: "..."})
```

- 実装: `packages/shared/src/llm_bridge.ts` (`FileBridge` / `BridgeLLMClient`)、
  リサーチは `BridgeResearchClient` (`research/research_topic.ts`)
- 有効化: `LLM_BACKEND=bridge` (`scripts/jobs/routine_daily.ts` は既定でbridge)。
  未設定なら従来のAPI経路 (`ANTHROPIC_API_KEY`) のまま動く = フォールバック
- 応答の書き込みは必ず `scripts/bridge_reply.ts` を使う (手書きJSONのエスケープ事故防止)
- **品質担保は変わらない**: 応答はzod (`callAndParse`) で検証され、品質ゲート (P-04)・
  合議 (P-05)・重複ゲート・表記機械チェック・**法令ゲート**・コレクション導線ゲート・
  承認/公開フローは従来どおり全部通る
- 応答タイムアウト: 既定20分/件 (`LLM_BRIDGE_TIMEOUT_MS`)。ブリッジディレクトリは
  `LLM_BRIDGE_DIR` (既定 `<cwd>/.llm-bridge`、gitignore済み)
- 使用量は `api_usage` に記録される (model=`claude-code-subscription`、cost_usd=0)。
  予算ガードはサブスク実行では事実上無効 (`llmBudgetUsd()`=Infinity)。
  1日あたりの上限 (発案4/リサーチ2/生成2) が引き続き量を抑える
- モデルルーティング (haiku/sonnet/opus の使い分け) はセッションのモデルに一本化される

## 実行の分担

| 実行主体 | 内容 | LLM |
|---|---|---|
| 日次ルーチン (JST 7:00) | 発案 → [自動キュー] → リサーチ → 生成 → [自動承認] → ゲート引き継ぎ → SEO監視 (`scripts/jobs/routine_daily.ts`) | ブリッジ (サブスク) |
| クラウド下書きルーチン (JST 4:30、任意) | queuedキーワードのリサーチ+執筆 → `cloud_drafts` | エージェント直書き |
| GitHub Actions `cron-daily` (JST 6:00) | GSC同期・順位監視・トリップワイヤ・デッドマン (`DAILY_LLM_STEPS=off`) | 不要 |
| GitHub Actions `cron-hourly` / `publish-now` | 公開ワーカ (Shopify `articleCreate` / `articleUpdate`) | 不要 |

- 実行順: 下書き (4:30) → 計測+安全装置 (6:00) → LLMループ (7:00)。
  発案が当日のGSC実績を使えるように計測の後にルーチンを置く
- **安全装置はルーチンと独立に動き続ける。** ルーチンを止めても、公開ワーカ・
  トリップワイヤ・デッドマンはActions側でそのまま動く

## ルーチン定義

- 名前: `くりとみかん 日次パイプライン (サブスク実行)`
- スケジュール: `0 22 * * *` (UTC) = JST 7:00
- ソース: `rentaoshima100-rgb/mikan-kuri`
- モデル: claude-sonnet-5
- 環境変数: `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (必須)、
  `SHOPIFY_SHOP` / `SHOPIFY_ADMIN_TOKEN` (任意。重複判定の相手に、店舗が
  `/blogs/news` へ手で投稿した記事を加えるために使う。読み取りのみ)

### ネットワーク許可リスト (環境設定のegress)

サンドボックスは許可したホストにしか出られない。**ここを忘れると最初の `getConfig` で
`Host not in allowlist` になり即失敗する。**

- **必須**: Supabaseのホスト (`<プロジェクトref>.supabase.co`)
- **重複判定を効かせるなら**: `<shop>.myshopify.com`
  (未許可なら警告つきでスキップされ、判定相手がDB追跡分だけに減る)
- 任意 (SEOウォッチャーのRSS取得。無ければ該当フィードがskipされるだけ):
  `feeds.feedburner.com` / `status.search.google.com` / `searchengineland.com` /
  `www.searchenginejournal.com` / `www.seroundtable.com` / `www.suzukikenichi.com` /
  `webtan.impress.co.jp` (`pipeline_config.rss_feeds` と同期して見直す)

### プロンプト (ルーチンを作り直すときはこれをそのまま使う)

```
mikan-kuri (株式会社くり房 / くりとみかん の記事パイプライン) の「日次パイプライン (サブスク実行)」ルーチンです。パイプラインの日次LLMループを、あなたがLLM役 (ブリッジ応答者) となって実行してください。手順の正本はリポジトリの docs/ROUTINES.md です。

## 前提チェック
- 環境変数 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が必要です。未設定なら「環境変数が未設定のため終了します」とだけ報告して終了 (値そのものは絶対に出力しない)。
- scripts/jobs/routine_daily.ts が存在しない場合は「サブスク実行変換が未マージのため終了します」と報告して終了。

## 手順
1. リポジトリ直下で npm ci を実行する。
2. ジョブをバックグラウンドで起動する:
   PIPELINE_ENV=production LLM_BACKEND=bridge npx tsx scripts/jobs/routine_daily.ts
   (ログは routine_daily.log 等にリダイレクトして後で読めるようにする)
3. ジョブのプロセスが終わるまで、ブリッジ監視ループを回す:
   - .llm-bridge/ に、対応する res-<seq>.json がまだ無い req-<seq>.json が現れたら読む。
   - kind が "llm" の要求: system と user の指示に従って出力を作る。要求された形式のみを出力し、前置き・後置きの説明文を一切付けない (JSONを要求するプロンプトにはJSONのみ。コードフェンスは付けてもよい)。出力をファイル (例: /tmp/out.txt) に書き、次で応答する:
       npx tsx scripts/bridge_reply.ts <seq> --text /tmp/out.txt
   - kind が "research" の要求: WebSearch で日本語の一次情報 (農林水産省の統計、県・JAの公表資料、品種登録情報、信頼できる業界調査を優先) を調べ、次の形のJSONをファイルに書いて応答する:
       {"text": "出典URL付き箇条書きのリサーチ結果", "sources": [{"url": "実際に参照したURL", "title": "ページ名"}]}
       npx tsx scripts/bridge_reply.ts <seq> --json /tmp/research.json
     出典が確認できない数値は text に含めない。効能効果 (免疫力・風邪予防・疲労回復など) に関する情報は集めない。食品では書けないため。
   - どうしても答えられない要求は npx tsx scripts/bridge_reply.ts <seq> --error "理由"
   - 待機は有限ループで行い (例: 2秒間隔で最大60回待って再確認)、ジョブプロセスの生存も確認する。ジョブが異常終了していたらループを抜けてログを読む。
4. ジョブ終了後、ログ末尾の {"job":"routine-daily","event":"done",...} の result を読み、ステップごと (propose_keywords / research / generate / gate_continue / seo_watcher など) の件数と失敗を短く報告する。event が failed のステップがあれば理由を1行ずつ添える。

## 制約
- 記事を公開しない。生成物は承認キューで止まり、公開はパイプラインの公開ワーカ (GitHub Actions) だけが行う。
- 法令に触れる表現を書かない。効能効果 (免疫力アップ・風邪予防・疲労回復・デトックス等)、根拠のない最上級 (日本一・最高級)、無農薬・減農薬・オーガニックの表記は、食品の販売サイトでは書けません。これらは機械チェック (quality/compliance_gate.ts) でも弾かれますが、そもそも生成しないこと。
- リポジトリのファイルを変更したり push したりしない (.llm-bridge/ と一時ファイルへの書き込みは可)。
- Supabase への書き込みはパイプラインのスクリプト経由のみ。ブリッジ応答以外で直接POST/PATCHしない (読み取りは可)。
- 執筆・判定の文体は各プロンプト (P-00等) の指示に従う。カタカナ語末尾の長音省略 (サーバ、ユーザ)、ダッシュ記号不使用、敬体、品種名は正式表記。
- 1回の実行の上限はスクリプト既定 (発案4 / リサーチ2 / 生成2) に任せ、勝手に増やさない。
```

## ゲート承認 (gate_pending) の引き継ぎ

品質ホールドの人間承認後は合議・仕上げでLLMが要る。管理画面 (Vercel) はブリッジを
使えないため:

- `ANTHROPIC_API_KEY` がVercelにある構成: 従来どおり管理画面が同期処理 (変更なし)
- 無い構成: 承認マーカ (`quality.gate_approved`) だけ記録し、次のルーチン実行の
  `gate_continue` ステップが残りを処理する (翌朝まで待てない場合はRun now)

## 「今すぐ記事化」

APIキーを廃止した構成では、https://claude.ai/code/routines で日次ルーチンを
**Run now** するのが正 (queuedのキーワードを拾って記事化する。発案も同時に走るが上限内)。

## 運用・デバッグ

- 実行履歴: https://claude.ai/code/routines → 該当ルーチン → Runs
- 失敗の典型:
  - 「環境変数が未設定」→ 環境に Supabase の2変数を設定
  - `Host not in allowlist` → egress許可リスト (上記) にホストを追加
  - `BridgeTimeoutError` → エージェントが要求に答えられていない。Runのログで
    どの req で止まったかを確認
  - 生成0件 → queuedキーワードが無い (管理画面 /keywords で承認する)
- 全部止めたい: ルーチンを無効化するだけでよい。翌日から生成が止まるだけで、
  公開ワーカ・安全装置 (Actions) はそのまま動く。APIキー経路に戻すには
  GitHub Secrets に `ANTHROPIC_API_KEY` を戻し、`cron-daily.yml` の
  `DAILY_LLM_STEPS: "off"` を外す (保護ファイルのため代表承認で)
- ローカルでブリッジ経路を試す: Claude Codeのセッションで
  `LLM_BACKEND=bridge PIPELINE_ENV=production npx tsx scripts/jobs/routine_daily.ts` を
  バックグラウンド実行し、エージェントに上のブリッジ監視ループを頼む
  (`refit_batch.ts` や `run_strategy.ts` も同じ方法でサブスク実行できる)
