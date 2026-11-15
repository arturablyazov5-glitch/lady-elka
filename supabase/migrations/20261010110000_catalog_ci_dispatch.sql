-- PREPARED ONLY; no production application authorized.
-- Apply AFTER 20261008110000_catalog_autosync.sql in the same transaction.
-- Direct pg_net -> GitHub is blocked: Supabase's shared queue exposes Authorization.
-- No extension, cron or credential is created/read by this migration.
alter table public.le_catalog_sync_state add column if not exists verify_revision bigint;
alter table public.le_catalog_sync_state add column if not exists verify_requests jsonb;
alter table public.le_catalog_sync_state add column if not exists verify_started_at timestamptz;
alter table public.le_catalog_sync_state add column if not exists ready_revision bigint;
alter table public.le_catalog_sync_state add column if not exists retry_at timestamptz;
alter table public.le_catalog_sync_state add column if not exists diagnostic text;
-- Applying/reapplying is fail-closed. Existing revisions and acknowledgements survive.
update public.le_catalog_sync_state set enabled=false,
 repository='arturablyazov5-glitch/lady-elka-cloud-preview' where id=1;
revoke all on public.le_catalog_sync_state from public, anon, authenticated, service_role;

-- Transport boundary. Deliberately contains NO Vault read and NO Authorization header.
-- Implement a reviewed safe transport only after the owner changes the conflicting contract.
create or replace function public.le_catalog_sync_send(p_revision bigint) returns bigint
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 raise exception using errcode='42501', message='Direct pg_net PAT transport blocked: credential would enter net.http_request_queue';
end $$;
revoke all on function public.le_catalog_sync_send(bigint) from public,anon,authenticated,service_role;

-- A response belongs to the exact revision observed before six public GETs.
-- Storage metadata alone is NOT a publication acknowledgement. Compare all CSV bytes
-- against the existing direct DB exporter; incomplete/stale/overlapping uploads fail closed.
create or replace function public.le_catalog_sync_dispatch() returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 s public.le_catalog_sync_state; t timestamptz:=clock_timestamp();
 status integer; a_status integer; b_status integer; a_body text; b_body text;
 ids jsonb:='{}'; a bigint; b bigint; request bigint; feed text;
 base constant text:='https://mgnotvaahftrbifqtahf.supabase.co';
begin
 select * into s from public.le_catalog_sync_state where id=1 for update skip locked;
 if not found or not s.enabled then return; end if;
 if s.request_id is not null then
  execute 'select status_code from net._http_response where id=$1' into status using s.request_id;
  if status=204 then
   update public.le_catalog_sync_state set sent_revision=greatest(sent_revision,s.request_revision),
    request_id=null,request_revision=null,requested_at=null,last_status=204,retry_at=null,diagnostic=null where id=1;
   s.sent_revision:=greatest(s.sent_revision,s.request_revision); s.request_id:=null;
  elsif status is not null or s.requested_at<=t-interval '2 minutes' then
   -- Wait two minutes after observing a failure (or timing out), not after sending.
   update public.le_catalog_sync_state set request_id=null,request_revision=null,requested_at=null,
    last_status=status,retry_at=t+interval '2 minutes',diagnostic='dispatch_failed' where id=1;
   return;
  else return;
  end if;
 end if;
 if s.revision<=s.sent_revision or s.changed_at>t-interval '60 seconds' or s.retry_at>t then return; end if;
 if s.verify_revision is distinct from s.revision then
  update public.le_catalog_sync_state set verify_requests=null,ready_revision=null where id=1;
  s.verify_requests:=null; s.ready_revision:=null;
 end if;
 if s.ready_revision is distinct from s.revision then
  if s.verify_requests is null then
   foreach feed in array array['trees','decor','promos'] loop
    execute 'select net.http_get(url := $1, headers := $2, timeout_milliseconds := 10000)' into a using
     base||'/functions/v1/catalog/feeds/'||feed||'.csv?autosync='||s.revision||'&t='||extract(epoch from t),
     jsonb_build_object('Accept','text/csv','Cache-Control','no-cache');
    execute 'select net.http_get(url := $1, headers := $2, timeout_milliseconds := 10000)' into b using
     base||'/storage/v1/object/public/le-catalog-feeds/'||feed||'.csv?autosync='||s.revision||'&t='||extract(epoch from t),
     jsonb_build_object('Accept','text/csv','Cache-Control','no-cache');
    ids:=ids||jsonb_build_object(feed,jsonb_build_array(a,b));
   end loop;
   update public.le_catalog_sync_state set verify_revision=s.revision,verify_requests=ids,
    verify_started_at=t,diagnostic='checking_feed_publication' where id=1;
   return;
  end if;
  foreach feed in array array['trees','decor','promos'] loop
   execute 'select status_code,content from net._http_response where id=$1' into a_status,a_body using (s.verify_requests->feed->>0)::bigint;
   execute 'select status_code,content from net._http_response where id=$1' into b_status,b_body using (s.verify_requests->feed->>1)::bigint;
   if (a_status is null or b_status is null) and s.verify_started_at>t-interval '2 minutes' then return; end if;
   if a_status is distinct from 200 or b_status is distinct from 200 or a_body is null or b_body is null
      or a_body<>b_body or octet_length(a_body)>2000000 then
    update public.le_catalog_sync_state set verify_requests=null,ready_revision=null,
     retry_at=t+interval '2 minutes',diagnostic='feeds_not_published' where id=1;
    return;
   end if;
  end loop;
  update public.le_catalog_sync_state set ready_revision=s.revision,verify_requests=null,diagnostic=null where id=1;
 end if;
 -- Fixed repository/event contract. Sender must return a pg_net response id.
 begin
  request:=public.le_catalog_sync_send(s.revision);
  if request is null then raise exception 'Missing request id'; end if;
 exception when others then
  -- Never persist/log SQLERRM: a transport error can include a secret.
  update public.le_catalog_sync_state set retry_at=t+interval '2 minutes',
   ready_revision=null,diagnostic='transport_blocked_or_failed' where id=1;
  return;
 end;
 update public.le_catalog_sync_state set request_id=request,request_revision=s.revision,requested_at=t,
  retry_at=null,ready_revision=null where id=1;
end $$;
revoke all on function public.le_catalog_sync_dispatch() from public,anon,authenticated,service_role;
revoke all on function public.le_catalog_sync_dirty() from public,anon,authenticated,service_role;
revoke all on function public.le_catalog_sync_storage_dirty() from public,anon,authenticated,service_role;

-- One-command rollback: disable processing and remove cron atomically; dirty triggers
-- become no-ops, so tables/storage need no unsupported owner/DDL changes.
create or replace function public.le_catalog_sync_disable() returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 update public.le_catalog_sync_state set enabled=false,verify_requests=null,ready_revision=null where id=1;
 if to_regclass('cron.job') is not null then
  execute 'select cron.unschedule(jobid) from cron.job where jobname=$1' using 'le-catalog-sync-debounce';
 end if;
end $$;
revoke all on function public.le_catalog_sync_disable() from public,anon,authenticated,service_role;
create or replace function public.le_catalog_sync_dirty() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 update public.le_catalog_sync_state set revision=revision+1,changed_at=clock_timestamp(),
  ready_revision=null where id=1 and enabled;
 return null;
end $$;
create or replace function public.le_catalog_sync_storage_dirty() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if (tg_op<>'DELETE' and new.bucket_id in ('le-catalog-images','le-catalog-feeds'))
 or (tg_op<>'INSERT' and old.bucket_id in ('le-catalog-images','le-catalog-feeds')) then
  update public.le_catalog_sync_state set revision=revision+1,changed_at=clock_timestamp(),
   ready_revision=null where id=1 and enabled;
 end if;
 return null;
end $$;
-- CREATE OR REPLACE retains existing ACLs; repeat explicitly for standalone audits.
revoke all on function public.le_catalog_sync_dirty() from public,anon,authenticated,service_role;
revoke all on function public.le_catalog_sync_storage_dirty() from public,anon,authenticated,service_role;
