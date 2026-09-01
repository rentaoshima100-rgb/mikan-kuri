-- 0011_rank_snapshots.sql
-- 順位監視の内製 (代表指示 2026-08-14)。
-- 外部の順位チェックツールを契約する代わりに、DataForSEO SERP APIで追跡キーワードの
-- 自社順位を日次取得して記録する (metrics/rank_watch.ts)。
-- GSCのpositionは「表示されたクエリの平均掲載順位」で、表示されない日のデータが無い。
-- こちらは「狙ったキーワードの定点観測」で、圏外 (position=null) も毎日記録される。

create table rank_snapshots (
  id uuid primary key default gen_random_uuid(),
  keyword text not null,
  date date not null,                   -- JST基準の測定日
  position int,                         -- 100位以内の自社順位。null = 圏外
  found_url text,                       -- 順位が付いた自社ページのURL
  created_at timestamptz not null default now(),
  unique (keyword, date)                -- 同日再実行はupsertで冪等
);
create index on rank_snapshots (date);

-- RLS方針は0005と同じ: パイプラインはservice roleで接続 (バイパス)。anonには何も許可しない
alter table rank_snapshots enable row level security;
