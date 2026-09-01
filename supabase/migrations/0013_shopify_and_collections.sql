-- Shopify公開とコレクション導線のための列。
--
-- 0012までは公開先が静的サイトのgitリポジトリだったため、記事の同一性は slug だけで
-- 足りていた。Shopifyでは記事の実体がストア側にあり、2回目以降は articleCreate ではなく
-- articleUpdate を呼ぶ必要があるため、発行されたGIDを保持する。
--
-- target_collection は「その記事がどのコレクションを押し上げるために書かれたか」。
-- この案件では記事単体のCVではなくコレクションの順位が成果指標なので、
-- リンク先を持たない記事は仕様上あり得ない (quality/collection_link.ts が検査する)。

alter table articles
  add column if not exists shopify_article_id text;

comment on column articles.shopify_article_id is
  'Shopifyの記事GID (gid://shopify/Article/...)。公開済みならこれを使って更新する';

-- 同じShopify記事に2本のarticles行が紐づくと、更新がどちらの本文で上書きされるか
-- 決まらなくなる。slug と同じく一意にしておく (NULLは重複を許す)
create unique index if not exists articles_shopify_article_id_key
  on articles (shopify_article_id)
  where shopify_article_id is not null;

-- 改修 (track='revision') が書き換える対象の公開済み記事。
-- 改修案は slug を持たない: slugは公開中の記事が握ったままにして、公開に成功した時点で
-- 「公開中の座」(slug と shopify_article_id) を改修案へ移し、旧行を retired にする。
-- 先にslugを奪う設計にすると、改修が承認されないまま公開中の記事のURLが宙に浮く
alter table articles
  add column if not exists revision_of uuid references articles (id) on delete set null;

comment on column articles.revision_of is
  '改修対象の記事ID。公開成功時にslugとshopify_article_idをこの行から引き継ぐ';

create index if not exists articles_revision_of_idx
  on articles (revision_of)
  where revision_of is not null;

alter table keywords
  add column if not exists target_collection text;

alter table keywords
  add column if not exists blog_handle text;

comment on column keywords.target_collection is
  'この記事が押し上げるコレクションのhandle (例: kanpei)。内部リンクの集中先';
comment on column keywords.blog_handle is
  '公開先ブログのhandle。未設定なら pipeline_config.shopify_blog_handle (既定 column)';

-- コレクションごとに何本の記事が刺さっているかを数える運用クエリのため。
-- 「1コレクションに4〜6本を束ねる」という設計が守れているかの確認に使う
create index if not exists keywords_target_collection_idx
  on keywords (target_collection);
