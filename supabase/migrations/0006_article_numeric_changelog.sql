-- 0006_article_numeric_changelog.sql
-- レーンBの数値主張除去 (P-06) の変更ログを保存するカラム。
-- オーケストレータ (orchestrator/generate.ts の runNumericCheck) が書き込むが、
-- 0002_content.sql の articles 定義から漏れていた。
-- MemoryStore では素通りするためテストで検出できず、実DB接続時にのみ
-- PostgRESTが "column does not exist" で失敗する種類の不整合だった。
-- 再発防止として tests/schema_parity.test.ts で型とカラムの整合を機械チェックしている。
--
-- 0002を直接編集せず追加マイグレーションにしているのは、
-- 既に0001〜0005を適用済みの環境でも同じ手順で追従できるようにするため。

alter table articles add column if not exists numeric_changelog jsonb;
