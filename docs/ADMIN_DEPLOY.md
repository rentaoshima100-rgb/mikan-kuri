# 管理画面 (承認キュー) を外から使えるようにする

## なぜ必要か

いま承認できるのは、代表のPCで `npm run dev -w @kurimikan/admin` を起動して
http://localhost:3100 を開いたときだけです。

一方 cron は毎日 JST 6:00 に GitHub Actions 上で回り、承認待ちの記事を積み上げます。
公開の引き金は承認ボタンだけなので (絶対ルール)、**PCの前にいない間はいくら記事が
積まれても公開はゼロ**になります。承認予定時刻から72時間で保留に戻る仕様のため、
不在が続くと積んだ分は保留に落ちます。

デプロイすれば、スマホからでも承認だけは押せる状態になります。

## デプロイで動くもの・動かないもの

| 画面 | Vercel上 | 理由 |
|---|---|---|
| `/` 記事の承認 (approval_pending → 承認) | 動く | DBのステータス更新のみ。実際の公開は毎時cronが行う |
| `/` ゲート承認 (gate_pending → 続行) | 条件付き | サーバアクション内でLLMを呼ぶ。Vercelの実行時間上限に当たる可能性がある (下記) |
| `/keywords` トピック提案の承認 | 動く | DBのみ |
| `/strategy` 月次戦略の閲覧 | 動く | DBのみ |
| `/ops` 運用状況 | 動く | DBのみ |
| `/links` 内部リンクの承認 | 動く | 承認すると本文を書き換えてShopifyへ再公開する。ローカルのチェックアウトは要らない |

Shopify公開に切り替えたことで、内部リンクの承認もデプロイ先から行えるようになりました
(必要なのは `SHOPIFY_SHOP` と `SHOPIFY_ADMIN_TOKEN` だけ)。

## 手順

### 1. Vercelでプロジェクトを作る

Vercelダッシュボード → Add New → Project → GitHubの `rentaoshima100-rgb/mikan-kuri` を選ぶ。

ビルド設定 (npm workspacesのため、リポジトリのルートからビルドする):

| 項目 | 値 |
|---|---|
| Framework Preset | Next.js |
| Root Directory | `packages/admin` |
| Install Command | `npm ci` (ルートで実行される) |
| Build Command | (既定のまま) |

> Root Directory を `packages/admin` にしても、Vercelはワークスペースのルートで
> `npm ci` を実行するので `@kurimikan/pipeline` / `@kurimikan/shared` は解決されます。
> ローカルの `npm run build -w @kurimikan/admin` が通ることは確認済みです。

### 2. 環境変数を入れる

| 変数 | 値 |
|---|---|
| `SUPABASE_URL` | `.env` と同じ |
| `SUPABASE_SERVICE_ROLE_KEY` | `.env` と同じ |
| `ANTHROPIC_API_KEY` | `.env` と同じ (ゲート承認でLLMを呼ぶため) |
| `ADMIN_ACCESS_TOKEN` | **新しく長いランダム文字列を作る** (下記) |
| `ADMIN_DECIDER` | `代表` など、承認者として記録される名前 |
| `MONTHLY_TOKEN_BUDGET_USD` | `60` |
| `PIPELINE_ENV` | `production` |
| `SHOPIFY_SHOP` | `.env` と同じ (内部リンク承認で再公開するため) |
| `SHOPIFY_ADMIN_TOKEN` | `.env` と同じ |

Shopifyの2つは、内部リンク承認で公開済み記事を再公開するのに使います。
未設定でも画面は開き、差分の確認まではできますが、承認ボタンは出ません。

トークンの作り方 (どちらでも):

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 3. アクセス制限をかける (重要)

この画面は `SUPABASE_SERVICE_ROLE_KEY` を持ちます。このキーは行レベルセキュリティを
無視してDB全体を読み書きできるため、URLとトークンが漏れると全データが危険にさらされます。
`ADMIN_ACCESS_TOKEN` だけに頼らず、Vercel側の保護も併用してください。

- Vercel → Project → Settings → Deployment Protection
- **Vercel Authentication** を `All Deployments` で有効化するのが最も安全です
  (代表のVercelアカウントでログインしていないと開けなくなる)
- プランの都合でVercel Authenticationが使えない場合は **Password Protection** を使う

両方かけておけば、URLが漏れても即座に危険にはなりません。

### 4. 動作確認

```
https://<デプロイURL>/?token=<ADMIN_ACCESS_TOKEN>
```

一度開くとトークンはhttpOnly cookieに入るので、以後は素のURLで開けます。
スマホのホーム画面に追加しておくと承認が1タップになります。

## 残っている課題

- **認証が共有トークン方式**です。本来は Supabase Auth (代表1ユーザのメールリンク) に
  置き換えるべきで、トークン方式は暫定です。
- **ゲート承認のタイムアウト**: `gate_pending` の記事を続行するとサーバアクション内で
  LLMを呼びます。Vercelの関数実行時間上限 (Hobbyは10秒、Proは60秒〜) を超えると失敗します。
  当面は「ゲート承認だけはローカルで行う」か、この処理をcron側へ逃がす改修が要ります。
  なお `approval_pending` の記事を承認するだけならLLMを呼ばないので影響ありません。
