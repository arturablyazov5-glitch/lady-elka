-- PREPARED ONLY. Apply after 20261008110000_catalog_autosync.sql, by owner authorization, as a single transaction.
-- Blog edits (le_blog_posts: insert/update/delete) wake the same catalog autosync debounce → GitHub dispatch → scripts/catalog-sync.mjs,
-- which also rebuilds /blog from le-admin-blog/published (storefront/blog/sync.mjs). No new jobs, network or secrets here.
do $$ begin
  if to_regclass('public.le_blog_posts') is null then raise exception 'le_blog_posts missing'; end if;
  if to_regprocedure('public.le_catalog_sync_dirty()') is null then raise exception 'Apply 20261008110000_catalog_autosync.sql first'; end if;
end $$;
drop trigger if exists le_catalog_sync_blog on public.le_blog_posts;
create trigger le_catalog_sync_blog after insert or update or delete or truncate on public.le_blog_posts
for each statement execute function public.le_catalog_sync_dirty();
