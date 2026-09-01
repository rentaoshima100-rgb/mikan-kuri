-- 0001_core.sql (SPEC v1 + v3差分適用済み)
create extension if not exists vector;
create extension if not exists pgcrypto;

create table authors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  byline text not null,                 -- 記事に出す肩書
  profile text not null,                -- E-E-A-T用経歴（本文挿入用）
  credentials text,
  avatar_url text,
  schema_jsonb jsonb,                   -- Person構造化データ
  created_at timestamptz default now()
);

create table prompts (
  id text primary key,                  -- 'P-00'〜'P-18b'
  body text not null,
  version int not null default 1,
  updated_by text not null default 'seed',  -- seed | tier1 | human
  updated_at timestamptz default now()
);

create table prompt_history (
  id uuid primary key default gen_random_uuid(),
  prompt_id text references prompts(id),
  old_body text not null,
  new_body text not null,
  changed_by text not null,             -- tier1:pipeline_versions.id | human
  changed_at timestamptz default now()
);

create table pipeline_config (
  key text primary key,
  value jsonb not null,
  updated_by text not null default 'seed',
  updated_at timestamptz default now()
);
-- 初期値はseedスクリプト (scripts/seed/config_values.ts) で投入。v3確定値:
-- weekly_publish_target: 2 (週2本開始。増速は3条件充足+人間承認) / velocity_stage: 0
-- quality_thresholds: {approve: 85, hold: 70} / commodity_max: 60
-- cluster_allocation: {renewal: 52, production: 20, system_dev: 15, ai_llmo: 13}
-- ai_llmo_expansion_frozen: true (AI経由CV累計30-50件まで凍結)
-- proposal_log_articles_enabled: false (Lancers書面照会完了まで凍結)
-- self_healing_enabled: false (SelfHealingCoderは初期スコープ外)
-- approval_deadman_hours: 72 (フェイルクローズド)
-- model_routing / model_pricing / deny_list / rss_feeds / lane_b_allowed_types / estat_targets

create table api_usage (
  id uuid primary key default gen_random_uuid(),
  called_at timestamptz default now(),
  prompt_id text,
  model text not null,
  input_tokens int not null,
  output_tokens int not null,
  cached_tokens int default 0,
  cost_usd numeric(10,5) not null,
  article_id uuid,
  job text                              -- generation | gate | watcher | strategy | coder | intake | serp_check
);
create index on api_usage (called_at);
