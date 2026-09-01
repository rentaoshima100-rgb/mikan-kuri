-- 0004_knowledge.sql (SPEC v1 + v3差分適用済み)
-- v3差分: pipeline_versions は残すが、適用はすべて人間承認 (self_healing_enabled=false)。
--         SEOウォッチャーは「週次サマリ+人間承認」まで。

create table seo_knowledge (
  id uuid primary key default gen_random_uuid(),
  url text unique not null,
  source text not null,
  title text,
  source_type text,                     -- P-14出力
  change_type text,
  confidence text,
  importance int,
  affected_area text[],
  summary_one_line text,
  corroboration_needed boolean default false,
  corroborated_by uuid[],
  status text not null default 'new' check (status in ('new','corroborating','reviewed','actioned','noise')),
  raw_excerpt text,
  published_at timestamptz,
  fetched_at timestamptz default now()
);

create table pipeline_versions (
  id uuid primary key default gen_random_uuid(),
  tier int not null check (tier in (1,2,3)),
  description text not null,
  seo_knowledge_ref uuid references seo_knowledge(id),
  change_payload jsonb,                 -- tier1: patch / tier2: 実装計画+PR情報
  pr_url text,
  status text not null default 'proposed' check (status in
    ('proposed','canary','applied','pr_open','merged','rejected','rolled_back')),
  canary_result jsonb,
  applied_at timestamptz,
  reverted_at timestamptz,
  created_at timestamptz default now()
);

create table strategy_reports (
  id uuid primary key default gen_random_uuid(),
  month date not null unique,
  report jsonb not null,                -- P-16出力全体
  decisions_applied boolean default false,
  proposals_pending int default 0,
  created_at timestamptz default now()
);
