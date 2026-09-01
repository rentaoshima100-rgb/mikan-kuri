-- 0007_article_expired_reason.sql
-- 承認が失効した理由 (デッドマンスイッチ)。
-- 承認済みかつ未公開の状態が approval_deadman_hours (既定72時間) 続いた記事は
-- approval_pending に戻される。そのとき理由をここに残し、承認画面で
-- 「承認が失効しました」と表示して再承認を促す。再承認時にクリアされる。

alter table articles add column if not exists expired_reason text;
