-- 0009_track_and_publish_attempts.sql

-- 1) 改修トラックの分離
-- 週2本という制限は「新規URLの増加ペース」に対するスパムシグナル回避策であり、
-- 既存URLの中身を改善する改修 (新しいページが増えない) は対象外。
-- new      : 新規記事 (週次目標と増速ゲートの対象)
-- revision : 既存記事の改稿 (独立ペース。増速ゲートの母数にも入れない)
alter table articles add column if not exists track text not null default 'new';
alter table articles drop constraint if exists articles_track_check;
alter table articles add constraint articles_track_check check (track in ('new', 'revision'));
create index if not exists articles_track_status_idx on articles (track, status);

-- 2) 公開失敗の記録
-- デッドマン失効時に理由 (ワーカ停止 / トリップワイヤ / コミット失敗 / 原因不明) を
-- 切り分けるため、公開の試行結果を残す
alter table publish_queue add column if not exists last_attempt_at timestamptz;
alter table publish_queue add column if not exists last_error text;
