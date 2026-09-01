-- クラスタと記事タイプを柑橘ECのものへ差し替える。
--
-- 0002 のCHECK制約はWeb制作会社のオウンドメディア (renewal / production / system_dev / ai_llmo,
-- howto / comparison / pricing / case_study / subsidy / public_data / market_report) を前提に
-- していた。この案件では意味を持たないので、入れた瞬間に落ちるように張り替える。
--
-- 記事タイプの対応は packages/shared/src/prompts.ts の ARTICLE_TYPE_ADDON と、
-- プロンプト集の P-03a〜g が正本。ここを変えたら両方を合わせること。

alter table keywords drop constraint if exists keywords_cluster_check;
alter table keywords
  add constraint keywords_cluster_check
  check (cluster in (
    'citrus_variety',  -- 品種そのもの (甘平とは、南柑20号の特徴)
    'growing',         -- 畑と栽培、産地
    'eating',          -- 食べ方、保存、むき方
    'gift',            -- 贈答、のし、予算
    'chestnut'         -- 栗
  ));

alter table keywords drop constraint if exists keywords_article_type_check;
alter table keywords
  add constraint keywords_article_type_check
  check (article_type in (
    'howto',         -- P-03a 保存・扱い方
    'comparison',    -- P-03b 品種比較
    'pricing',       -- P-03c 価格・相場
    'grower',        -- P-03d 生産者・畑・栽培
    'gift',          -- P-03e ギフト・贈答
    'season',        -- P-03f 旬・収穫時期
    'recipe',        -- P-03g レシピ・食べ方
    'market_report'  -- 注文データ由来の相場記事 (既定で凍結。P-03の追加指示は持たない)
  ));

-- 一次情報の種別も柑橘ECのものへ。
-- 0002 は Web制作会社向け (case_study / benchmark / ops_data / exec_opinion) だった。
-- この案件の一次情報は「産地にいなければ持てないもの」で、
-- 競合のAI記事が絶対に持てない唯一の武器。種別はその収集経路で切る。
alter table primary_info_assets drop constraint if exists primary_info_assets_asset_type_check;
alter table primary_info_assets
  add constraint primary_info_assets_asset_type_check
  check (asset_type in (
    'field_record',   -- 畑の記録 (作業、樹の状態、収穫の様子)
    'measurement',    -- 実測値 (糖度、重量、サイズ、収量)
    'weather',        -- その年の天候と生育への影響
    'customer_voice', -- お客さまの声 (個人が特定できない形に整えたもの)
    'public_data',    -- 公的統計の分析 (作付面積、出荷量)
    'process'         -- 選別・貯蔵・出荷の手順
  ));
