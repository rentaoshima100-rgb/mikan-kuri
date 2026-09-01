// cronジョブ共通のブートストラップ。
// PIPELINE_ENV=dry_run では実API・実DBを触らず、意図した処理内容のログのみ出す。
import { SupabaseStore, type Store } from "@kurimikan/pipeline";

export function isDryRun(): boolean {
  return process.env.PIPELINE_ENV === "dry_run";
}

export function requireStore(): Store {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です");
  }
  return new SupabaseStore();
}

// ジョブ本体の共通ラッパ。dry_runならスキップし、失敗時は非ゼロ終了 (Actionsが失敗通知)
export async function runJob(name: string, fn: (store: Store) => Promise<unknown>): Promise<void> {
  const started = Date.now();
  console.log(JSON.stringify({ job: name, event: "start", dry_run: isDryRun() }));
  try {
    if (isDryRun()) {
      console.log(JSON.stringify({ job: name, event: "skipped", reason: "dry_run" }));
      return;
    }
    const result = await fn(requireStore());
    console.log(
      JSON.stringify({ job: name, event: "done", durationMs: Date.now() - started, result }),
    );
  } catch (e) {
    console.error(
      JSON.stringify({
        job: name,
        event: "failed",
        durationMs: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    process.exitCode = 1;
  }
}
