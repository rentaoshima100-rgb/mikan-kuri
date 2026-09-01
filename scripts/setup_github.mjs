// GitHubリポジトリ作成 + push + Secrets/Variables 登録を一括で行う (v3 Sprint: cron自動化)。
//   前提: gh CLI導入済み + `gh auth login` 済み
//   実行: node --env-file=.env scripts/setup_github.mjs [--repo nortiq-pipeline]
//
// .env の値を GitHub Secrets に登録するので、値はコンソールに表示しない。
// 冪等: リモートが既にあればrepo作成をスキップし、Secretsは上書き更新する。
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const argOf = (n) => {
  const i = args.indexOf(n);
  return i !== -1 ? args[i + 1] : undefined;
};
const REPO = argOf("--repo") ?? "nortiq-pipeline";

function sh(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts });
}

function ghAvailable() {
  try {
    sh("gh", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function ghAuthed() {
  try {
    sh("gh", ["auth", "status"]);
    return true;
  } catch {
    return false;
  }
}

// workflowが参照するSecret (cron-daily/hourly/monthly)。ANTHROPIC_API_KEYは
// cron-dailyのSEOウォッチャー用に将来必要 (workflow側の1行追加は保護ファイルのため別途)。
const SECRETS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GSC_SERVICE_ACCOUNT_JSON",
  "GA4_SERVICE_ACCOUNT_JSON",
  "GA4_PROPERTY_ID",
  "SITE_REPO_TOKEN",
  "INDEXNOW_KEY",
  "ANTHROPIC_API_KEY",
];
const VARIABLES = ["MONTHLY_TOKEN_BUDGET_USD"];

function main() {
  if (!ghAvailable()) {
    console.error("gh CLI が見つかりません。先に `winget install --id GitHub.cli` を実行してください。");
    process.exit(1);
  }
  if (!ghAuthed()) {
    console.error("gh が未認証です。先に  ! gh auth login  を実行してブラウザ認証してください。");
    process.exit(1);
  }

  // 1. リポジトリ作成 + push (リモートが無ければ)
  let hasRemote = false;
  try {
    sh("git", ["remote", "get-url", "origin"]);
    hasRemote = true;
  } catch {
    hasRemote = false;
  }
  if (!hasRemote) {
    console.log(`リポジトリを作成してpushします: ${REPO} (private)...`);
    sh("gh", ["repo", "create", REPO, "--private", "--source=.", "--push"], { stdio: "inherit" });
  } else {
    console.log("originリモートは既にあります。pushします...");
    sh("git", ["push", "-u", "origin", "main"], { stdio: "inherit" });
  }

  // 2. Secrets / Variables 登録 (.env の値。未設定はスキップ)
  let setSecrets = 0;
  for (const name of SECRETS) {
    const val = process.env[name];
    if (!val) {
      console.log(`  [skip] ${name}: .envに値なし`);
      continue;
    }
    sh("gh", ["secret", "set", name, "--body", val]);
    console.log(`  secret set: ${name}`);
    setSecrets++;
  }
  for (const name of VARIABLES) {
    const val = process.env[name];
    if (!val) continue;
    sh("gh", ["variable", "set", name, "--body", val]);
    console.log(`  variable set: ${name}`);
  }

  console.log(`\n完了: Secrets ${setSecrets}件 + Variables を登録しました。`);
  console.log("次: GitHubの Settings → Branches で main のブランチ保護を設定 (CI必須・self-merge禁止)。");
  console.log("cron (hourly/daily/monthly) は次回のスケジュールで自動実行されます。");
  console.log("※ cron-dailyのSEOウォッチャーはANTHROPIC_API_KEYを使うが、workflow側の1行追加が保護ファイルのため別途対応が必要。");
}

main();
