-- 0005_rls.sql
-- RLS方針 (SPEC): 全テーブルでRLS有効。パイプラインはservice roleで接続 (RLSバイパス)。
-- anon には articles (status='published' のみ) と authors の select だけを許可する。

alter table authors enable row level security;
alter table prompts enable row level security;
alter table prompt_history enable row level security;
alter table pipeline_config enable row level security;
alter table api_usage enable row level security;
alter table keywords enable row level security;
alter table articles enable row level security;
alter table approvals enable row level security;
alter table internal_links enable row level security;
alter table publish_queue enable row level security;
alter table primary_info_assets enable row level security;
alter table gsc_metrics enable row level security;
alter table ai_cv_events enable row level security;
alter table proposal_log enable row level security;
alter table chat_seeds enable row level security;
alter table anonymization_log enable row level security;
alter table tripwire_events enable row level security;
alter table seo_knowledge enable row level security;
alter table pipeline_versions enable row level security;
alter table strategy_reports enable row level security;

create policy anon_read_published_articles on articles
  for select to anon
  using (status = 'published');

create policy anon_read_authors on authors
  for select to anon
  using (true);
