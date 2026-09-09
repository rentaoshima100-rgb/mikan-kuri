-- 記事がどの一次情報を使ったかの記録。
--
-- これまで使用の痕跡は primary_info_assets.usage_count (件数だけ) と、
-- articles.outline の primary_info_plan (JSONの中) にしかなかった。
-- どちらも「この素材が期限切れになったので、使っている記事を直す」には使えない。
--
-- 全自動公開では人が本文を読まないので、出した後の巡回が唯一の是正手段になる。
-- 柑橘は年ごとに出来が変わり、去年の糖度を載せたままの記事は事実と違う記述になるため、
-- 素材の期限切れから記事を逆引きできる必要がある。

create table if not exists article_assets (
  article_id uuid not null references articles (id) on delete cascade,
  asset_id uuid not null references primary_info_assets (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (article_id, asset_id)
);

comment on table article_assets is
  '記事が本文に注入した一次情報。期限切れ素材から改修対象の記事を逆引きするために使う';

-- 「この素材を使っている記事は？」を引くための索引 (主キーは article_id 始まりのため)
create index if not exists article_assets_asset_id_idx on article_assets (asset_id);

-- RLS方針は0005と同じ: service roleのみ (anonには何も許可しない)
alter table article_assets enable row level security;
