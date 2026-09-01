-- 0008_internal_link_review.sql
-- 内部リンクの承認キュー。
--
-- inbound リンク (既存の公開済み記事から新記事へ張る) は、適用すると
-- 「公開済み記事を書き換える」ことになるため自動適用しない。
-- 一方でクラスタ設計 (ピラー+子記事を内部リンクで束ねる) は内部リンクが
-- 張られないと成立しないため、記事の承認とは別の承認キューで人間が判断する。
--
-- 記事の承認と違い、この画面では適用後の差分が全文表示されるため一括承認を許可する。

alter table internal_links add column if not exists reviewed_by text;
alter table internal_links add column if not exists reviewed_at timestamptz;
alter table internal_links add column if not exists review_notes text;
-- 適用時に対象記事へ書き込んだ結果 (差分の記録)。適用の証跡として残す
alter table internal_links add column if not exists applied_commit text;

-- status に 'rejected' (却下) を追加する。
-- 既存: proposed (提案中) / applied (適用済み) / skipped (自動除外)
alter table internal_links drop constraint if exists internal_links_status_check;
alter table internal_links
  add constraint internal_links_status_check
  check (status in ('proposed', 'applied', 'skipped', 'rejected'));

create index if not exists internal_links_status_idx on internal_links (status);
