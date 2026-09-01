-- 0002_content.sql (SPEC v1 + v3差分適用済み)
-- v3差分:
--   * articles.status に 'approval_pending' を追加。全記事は承認キュー経由でのみ公開される
--   * articles に judge_disagreement / serp_gap を追加 (judge不一致は人間エスカレーション、SERP差分は承認者の参考情報)
--   * publish_queue から automation_mode / hold_until を削除 (自動公開・24hホールドの廃止)
--   * approvals テーブル新設。公開条件 = 最新レコードが decision='approved' であること (フェイルクローズド)

create table keywords (
  id uuid primary key default gen_random_uuid(),
  keyword text not null unique,
  cluster text not null check (cluster in ('renewal','production','ai_llmo','system_dev')),
  article_type text not null check (article_type in ('howto','comparison','pricing','case_study','subsidy','public_data','market_report')),
  search_intent text,
  priority int not null default 50,     -- 0-100
  status text not null default 'queued' check (status in ('queued','in_progress','done','parked')),
  assigned_lane text check (assigned_lane in ('A','B')),
  source text default 'manual',         -- manual | chat_seed | strategy_agent
  created_at timestamptz default now()
);
create index on keywords (status, priority desc);

create table articles (
  id uuid primary key default gen_random_uuid(),
  keyword_id uuid references keywords(id),
  slug text unique,
  title text,
  meta_description text,
  outline jsonb,                        -- P-01出力 (approval_required=true固定)
  body_mdx text,
  faq jsonb,
  author_id uuid references authors(id),
  article_type text not null,
  lane text not null check (lane in ('A','B')),  -- Bは「下書きジェネレータ」。公開判断は常に人間
  status text not null default 'draft' check (status in
    ('draft','numeric_check','gate_pending','consensus','approval_pending','approved','scheduled','published','rejected','needs_rewrite','retired')),
  quality jsonb,                        -- P-04出力全体 (v3: human_review_notes を含む)
  quality_score int,
  hallucination_flags jsonb,
  commodity_score int,
  consensus_result jsonb,               -- P-05結果
  judge_disagreement boolean not null default false,  -- v3: judge不一致フラグ。自動棄却/通過せず承認キューへ
  serp_gap jsonb,                       -- v3: SERP差分チェック結果 (自動棄却には使わない)
  primary_info_refs uuid[] default '{}',
  internal_links_done boolean default false,
  word_count int,
  scheduled_at timestamptz,
  published_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index on articles (status);
create index on articles (published_at);

-- v3: 承認レコード。公開ワーカは「articles.status='approved' かつ 最新approvalsが'approved'」の記事のみ公開する。
-- 承認 (decided_at) から72時間 (pipeline_config.approval_deadman_hours) 超の未公開分は
-- approval_pending に戻す (デッドマンスイッチ、フェイルクローズド)。
create table approvals (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references articles(id),
  decision text not null check (decision in ('approved','sent_back')),
  decided_by text not null,             -- 承認者 (代表のメールアドレス等)
  decided_at timestamptz not null default now(),
  review_notes text,                    -- 差戻し理由 / 承認時メモ
  judge_disagreement_ack boolean not null default false,  -- judge不一致を確認済みで承認したか
  created_at timestamptz default now()
);
create index on approvals (article_id, decided_at desc);

create table internal_links (
  id uuid primary key default gen_random_uuid(),
  source_article_id uuid references articles(id),
  target_url text not null,             -- 記事URLまたは固定ページ
  anchor text not null,
  direction text not null check (direction in ('outbound','inbound')),
  insert_hint text,
  status text not null default 'proposed' check (status in ('proposed','applied','skipped')),
  created_at timestamptz default now()
);

-- v3: automation_mode / hold_until は存在しない。scheduled_at は承認時に週次目標から均等分散で自動割当。
create table publish_queue (
  id uuid primary key default gen_random_uuid(),
  article_id uuid references articles(id) unique,
  scheduled_at timestamptz not null,
  cancelled boolean default false,
  cancelled_reason text,
  published boolean default false,
  created_at timestamptz default now()
);

create table primary_info_assets (
  id uuid primary key default gen_random_uuid(),
  asset_type text not null check (asset_type in
    ('case_study','benchmark','original_survey','public_data_analysis','ops_data','exec_opinion')),
  title text not null,
  description text not null,
  content text not null,
  numeric_claims jsonb not null default '[]',
  applicable_clusters text[] not null default '{}',
  source_permission boolean default true,
  sensitivity text not null default 'low' check (sensitivity in ('low','mid','high')),
  valid_until date,
  annual_review boolean default false,
  usage_count int default 0,
  status text not null default 'active' check (status in ('active','refresh_needed','retired')),
  embedding vector(1024),
  created_at timestamptz default now()
);
create index on primary_info_assets (status);
