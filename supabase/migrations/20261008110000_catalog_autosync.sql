-- PREPARED ONLY. Do not apply to production without owner authorization.
-- No extensions/jobs/network enabled by this migration. Defaults disabled.
create table if not exists public.le_catalog_sync_state (
  id integer primary key check (id = 1), enabled boolean not null default false,
  repository text, revision bigint not null default 0, sent_revision bigint not null default 0,
  changed_at timestamptz not null default now(), request_id bigint, request_revision bigint,
  requested_at timestamptz, last_status integer
);
insert into public.le_catalog_sync_state(id) values (1) on conflict do nothing;
alter table public.le_catalog_sync_state enable row level security;
revoke all on public.le_catalog_sync_state from public, anon, authenticated;

create or replace function public.le_catalog_sync_dirty() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update public.le_catalog_sync_state set revision = revision + 1, changed_at = clock_timestamp() where id = 1;
  return null;
end $$;
revoke all on function public.le_catalog_sync_dirty() from public, anon, authenticated;

do $$ begin
  if to_regclass('public.le_catalog_products') is null or to_regclass('public.le_catalog_settings') is null or to_regclass('public.le_promo_codes') is null then
    raise exception 'Catalog tables missing';
  end if;
end $$;
drop trigger if exists le_catalog_sync_products on public.le_catalog_products;
create trigger le_catalog_sync_products after insert or update or delete or truncate on public.le_catalog_products
for each statement execute function public.le_catalog_sync_dirty();
drop trigger if exists le_catalog_sync_settings on public.le_catalog_settings;
create trigger le_catalog_sync_settings after insert or update or delete or truncate on public.le_catalog_settings
for each statement execute function public.le_catalog_sync_dirty();

drop trigger if exists le_catalog_sync_promos on public.le_promo_codes;
create trigger le_catalog_sync_promos after insert or update or delete or truncate on public.le_promo_codes
for each statement execute function public.le_catalog_sync_dirty();

-- Replacing an image at the same URL must also wake sync. Storage metadata only; no object writes here.
create or replace function public.le_catalog_sync_storage_dirty() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if (tg_op <> 'DELETE' and new.bucket_id in ('le-catalog-images','le-catalog-feeds'))
     or (tg_op <> 'INSERT' and old.bucket_id in ('le-catalog-images','le-catalog-feeds')) then
    update public.le_catalog_sync_state set revision = revision + 1, changed_at = clock_timestamp() where id = 1;
  end if;
  return null;
end $$;
revoke all on function public.le_catalog_sync_storage_dirty() from public, anon, authenticated;
do $$ begin
  if to_regclass('storage.objects') is not null then
    execute 'drop trigger if exists le_catalog_sync_storage on storage.objects';
    execute 'create trigger le_catalog_sync_storage after insert or update or delete on storage.objects for each row execute function public.le_catalog_sync_storage_dirty()';
  end if;
end $$;

-- Called by pg_cron once enabled separately. Acknowledge only HTTP 204, retry failures, preserve concurrent revisions.
create or replace function public.le_catalog_sync_dispatch() returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare s public.le_catalog_sync_state; token text; response_status integer; request bigint;
begin
  select * into s from public.le_catalog_sync_state where id = 1 for update skip locked;
  if not found or not s.enabled then return; end if;
  if s.request_id is not null then
    execute 'select status_code from net._http_response where id = $1' into response_status using s.request_id;
    if response_status = 204 then
      update public.le_catalog_sync_state set sent_revision = greatest(sent_revision, s.request_revision), request_id = null, last_status = 204 where id = 1;
      s.sent_revision := greatest(s.sent_revision, s.request_revision); s.request_id := null;
    elsif s.requested_at > now() - interval '2 minutes' then return;
    else
      update public.le_catalog_sync_state set request_id = null, last_status = response_status where id = 1;
      s.request_id := null;
    end if;
  end if;
  if s.revision <= s.sent_revision or s.changed_at > now() - interval '60 seconds' then return; end if;
  if s.repository is null or s.repository !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' then raise exception 'Invalid catalog sync repository'; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into token using 'le_catalog_sync_github_token';
  if token is null then raise exception 'Catalog sync dispatch credential missing'; end if;
  execute 'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 10000)' into request using
    'https://api.github.com/repos/' || s.repository || '/dispatches',
    jsonb_build_object('Authorization','Bearer ' || token,'Accept','application/vnd.github+json','X-GitHub-Api-Version','2026-03-10','Content-Type','application/json'),
    jsonb_build_object('event_type','catalog_changed','client_payload',jsonb_build_object('revision',s.revision));
  update public.le_catalog_sync_state set request_id = request, request_revision = s.revision, requested_at = now() where id = 1;
end $$;
revoke all on function public.le_catalog_sync_dispatch() from public, anon, authenticated;
