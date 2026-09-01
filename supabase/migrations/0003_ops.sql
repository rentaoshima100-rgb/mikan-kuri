-- 0003_ops.sql (SPEC v1 + v3差分適用済み)
-- v3差分: ai_cv_events テーブル新設 (多重計測3系統の受け皿。GA4チャネル/自己申告フォーム/リファラログ)

create table gsc_metrics (
  id uuid primary key default gen_random_uuid(),
  article_id uuid references articles(id),
  date date not null,
  impressions int default 0,
  clicks int default 0,
  ctr numeric(6,4),
  position numeric(6,2),
  top_queries jsonb,                    -- [{query, impressions, clicks, position}]
  index_status text,                    -- indexed | crawled_not_indexed | discovered | unknown
  ai_channel_sessions int default 0,    -- GA4由来（月次で日割せずmonth初日行に集約可）
  unique (article_id, date)
);
create index on gsc_metrics (date);

-- v3: 多重計測。AI経由CVの累計30-50件で ai_llmo_expansion_frozen の解除提案が出る (エビデンス添付必須)
create table ai_cv_events (
  id uuid primary key default gen_random_uuid(),
  occurred_on date not null,
  source text not null check (source in ('ga4_channel','self_report','referrer_log')),
  detail jsonb,                         -- チャネル名 / フォーム選択値 / リファラ集計等 (個人情報は入れない)
  count int not null default 1,
  created_at timestamptz default now()
);
create index on ai_cv_events (occurred_on);

create table proposal_log (
  id uuid primary key default gen_random_uuid(),
  received_month date not null,         -- 月初日
  budget_band text not null check (budget_band in ('u30','30_50','50_100','100_300','o300','unknown')),
  industry text not null,               -- 粗カテゴリ（config管理の選択肢）
  region text not null,                 -- 粗カテゴリ
  requirement_tags text[] not null default '{}',
  outcome text not null check (outcome in ('won','lost','pending')),
  loss_reason text,                     -- タグ（config管理）
  note_sanitized text,                  -- 自由記述はLayer1/2通過後のみ格納可
  created_at timestamptz default now()
);
-- 注意: 記事化は proposal_log_articles_enabled=false の間は凍結 (データ蓄積のみ。Lancers書面照会完了まで)

create table chat_seeds (
  id uuid primary key default gen_random_uuid(),
  seed_title text not null,
  angle text,
  cluster text,
  target_keyword_hint text,
  source_excerpt text,                  -- プレースホルダ化済み
  sensitivity text not null default 'low',
  status text not null default 'new' check (status in ('new','queued','used','discarded')),
  created_at timestamptz default now()
);

create table anonymization_log (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null,            -- lane_a_input | chat_export | proposal_note
  layer text not null check (layer in ('regex','ner','claude','human')),
  detected_count int not null default 0,
  detected_kinds jsonb,                 -- 種別カウントのみ。実名は保存しない
  human_review_required boolean default false,
  reviewed boolean default false,
  created_at timestamptz default now()
);

-- v3: トリップワイヤは「新規公開の全停止/減速」に単純化 (レーン区別なし)。発火条件は据え置き
create table tripwire_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in
    ('manual_action','index_rate_drop','cni_spike','core_update_active','score_anomaly','budget_80pct')),
  severity text not null check (severity in ('info','throttle','halt')),
  detail jsonb,
  auto_action_taken text,
  resolved boolean default false,
  created_at timestamptz default now()
);
