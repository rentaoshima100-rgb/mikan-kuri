-- 0012_cloud_drafts.sql
-- クラウド下書き (代表指示 2026-08-20)。
-- リサーチと本文執筆をClaude Codeの定期クラウドエージェント (サブスクリプション側) が行い、
-- ここに置く。生成オーケストレータは queued キーワードの記事化時に未消費の下書きがあれば
-- P-01/P-02 (アウトライン生成と執筆 = APIコストの大半) を省略して下書きを使う。
-- 品質ゲート (P-04)・重複ゲート・仕上げ (P-12/P-11)・公開フローは従来どおり下書きにも適用される。
-- 下書きが無い・壊れている場合は従来のAPI経路に自動フォールバックする (運用形態は不変)。

create table cloud_drafts (
  id uuid primary key default gen_random_uuid(),
  keyword_id uuid not null references keywords(id),
  outline jsonb not null,              -- P01Outline互換 (zod検証は取り込み側で行う)
  body_mdx text not null,              -- 本文markdown (タイトルなし、H2始まり)
  sources jsonb,                       -- リサーチ出典 [{title,url,note}] (トレーサビリティ用)
  created_at timestamptz not null default now(),
  consumed_at timestamptz,             -- 取り込み済みの印 (検証失敗でも立てる。壊れた下書きの再利用防止)
  consumed_by_article_id uuid references articles(id)
);
create index on cloud_drafts (keyword_id, created_at desc);

-- RLS方針は0005と同じ: service roleのみ (anonには何も許可しない)
alter table cloud_drafts enable row level security;
