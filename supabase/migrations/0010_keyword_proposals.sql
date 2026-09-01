-- 0010_keyword_proposals.sql
-- キーワード発案レイヤー (v3 Sprint 1: 戦略エージェントがネタを提案し、代表が承認するループ)。
-- 提案されたキーワードは 'proposed' で溜まり、代表の承認で 'queued' になって初めて記事化対象になる。
-- これが「システムがネタを持ってくる → 代表が承認する」の第1の承認点 (トピック段階)。
-- 記事の公開承認 (第2の承認点) は従来どおり別途必要で、自動公開は存在しない (v3絶対ルール)。

-- status に 'proposed' を追加 (proposed → queued → in_progress → done/parked)
alter table keywords drop constraint if exists keywords_status_check;
alter table keywords add constraint keywords_status_check
  check (status in ('proposed','queued','in_progress','done','parked'));

-- 提案理由 (代表がトピック承認を判断する材料。なぜ今このネタか)
alter table keywords add column if not exists rationale text;
