-- Automatic retry of the le_leads Telegram outbox + owner alert. Additive and idempotent.
-- Safe by default: le_lead_retry_settings.enabled=false AND the pg_cron job is created INACTIVE.
-- Enabling is a separate owner-approved step (see supabase/DEPLOY.md, «Автоповтор»).

-- Statuses: pending (in queue) -> delivered | failed (max_attempts exhausted; kept for manual requeue).
alter table public.le_leads drop constraint if exists le_leads_delivery_status_check;
alter table public.le_leads add constraint le_leads_delivery_status_check
  check (delivery_status in ('pending','delivered','failed'));
alter table public.le_leads
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_error text,
  add column if not exists failed_at timestamptz,
  add column if not exists alert_attempts integer not null default 0,
  add column if not exists alert_lease_token uuid,
  add column if not exists alert_lease_until timestamptz,
  add column if not exists alert_next_at timestamptz,
  add column if not exists owner_alerted_at timestamptz;
create index if not exists le_leads_alert_pending on public.le_leads(created_at)
  where owner_alerted_at is null and delivery_status <> 'delivered';

-- Single-row switch and policy. Only service_role/postgres can read or change it.
create table if not exists public.le_lead_retry_settings (
  id integer primary key default 1 check (id = 1),
  enabled boolean not null default false,
  function_url text not null default 'https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/lead',
  base_delay_seconds integer not null default 120 check (base_delay_seconds between 10 and 86400),
  max_delay_seconds integer not null default 21600 check (max_delay_seconds between 60 and 604800),
  max_attempts integer not null default 8 check (max_attempts between 1 and 50),
  alert_after_attempts integer not null default 4 check (alert_after_attempts between 1 and 50),
  max_age_hours integer not null default 72 check (max_age_hours between 1 and 2160),
  updated_at timestamptz not null default now()
);
insert into public.le_lead_retry_settings(id) values (1) on conflict (id) do nothing;
alter table public.le_lead_retry_settings enable row level security;
revoke all on public.le_lead_retry_settings from anon, authenticated;
grant select on public.le_lead_retry_settings to service_role;

create or replace function public.le_lead_retry_config()
returns public.le_lead_retry_settings language plpgsql stable security definer set search_path = public as $$
declare s public.le_lead_retry_settings;
begin
  select * into s from public.le_lead_retry_settings where id = 1;
  if not found then
    -- Missing row behaves as the safe default: disabled.
    s := row(1, false, 'https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/lead', 120, 21600, 8, 4, 72, now())::public.le_lead_retry_settings;
  end if;
  return s;
end $$;

-- Intake claim (first attempt or a client replay of the same id). Lease prevents parallel sends.
create or replace function public.le_claim_lead(p_id uuid, p_token uuid)
returns jsonb language sql security definer set search_path = public as $$
  update public.le_leads set lease_token=p_token, lease_until=now()+interval '2 minutes',
    attempt_count=attempt_count+1, last_attempt_at=now()
  where id=p_id and delivery_status='pending' and (lease_until is null or lease_until<now())
  returning to_jsonb(le_leads.*);
$$;

-- Finish an attempt: exponential backoff with jitter, attempt limit -> failed.
create or replace function public.le_finish_lead_attempt(p_id uuid, p_token uuid, p_delivered jsonb, p_complete boolean, p_error text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.le_lead_retry_settings := public.le_lead_retry_config(); item public.le_leads;
begin
  update public.le_leads l set delivered_to=p_delivered,
    delivery_status = case when p_complete then 'delivered' when l.attempt_count >= s.max_attempts then 'failed' else 'pending' end,
    failed_at = case when not p_complete and l.attempt_count >= s.max_attempts then now() end,
    last_error = case when p_complete then null else left(coalesce(nullif(p_error,''),'unknown'), 120) end,
    lease_until=null, lease_token=null,
    next_attempt_at = now() + make_interval(secs => least(s.max_delay_seconds::double precision,
      s.base_delay_seconds * power(2, least(greatest(l.attempt_count-1, 0), 20))) * (0.85 + random()*0.3))
  where l.id=p_id and l.lease_token=p_token
  returning * into item;
  if not found then return null; end if;
  return jsonb_build_object('id', item.id, 'delivery_status', item.delivery_status, 'attempt_count', item.attempt_count);
end $$;

-- Backward compatible signature used by the previously deployed handler.
create or replace function public.le_finish_lead(p_id uuid, p_token uuid, p_delivered jsonb, p_complete boolean)
returns void language plpgsql security definer set search_path = public as $$
begin perform public.le_finish_lead_attempt(p_id, p_token, p_delivered, p_complete, null); end $$;

-- Queue claim: one due lead, atomically (SKIP LOCKED + lease), only when enabled (or manual).
-- Old leads (> max_age_hours) are never auto-retried; manual retry may still process them.
create or replace function public.le_claim_next_lead(p_token uuid, p_manual boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.le_lead_retry_settings := public.le_lead_retry_config(); item public.le_leads;
begin
  if not p_manual and not s.enabled then return jsonb_build_object('disabled', true); end if;
  update public.le_leads set lease_token=p_token, lease_until=now()+interval '2 minutes',
    attempt_count=attempt_count+1, last_attempt_at=now()
  where id = (select id from public.le_leads
              where delivery_status='pending' and next_attempt_at<=now()
                and (lease_until is null or lease_until<now())
                and (p_manual or created_at > now() - make_interval(hours => s.max_age_hours))
              order by next_attempt_at, created_at limit 1 for update skip locked)
  returning * into item;
  if not found then return null; end if;
  return to_jsonb(item);
end $$;

-- Owner alert claim: undelivered after alert_after_attempts (pending or failed), once per lead.
create or replace function public.le_claim_lead_alert(p_token uuid, p_manual boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.le_lead_retry_settings := public.le_lead_retry_config(); item public.le_leads;
begin
  if not p_manual and not s.enabled then return jsonb_build_object('disabled', true); end if;
  update public.le_leads set alert_lease_token=p_token, alert_lease_until=now()+interval '2 minutes',
    alert_attempts=alert_attempts+1
  where id = (select id from public.le_leads
              where owner_alerted_at is null and delivery_status <> 'delivered'
                and (delivery_status='failed' or attempt_count >= s.alert_after_attempts)
                and (alert_lease_until is null or alert_lease_until<now())
                and (alert_next_at is null or alert_next_at<=now())
                and (p_manual or created_at > now() - make_interval(hours => s.max_age_hours))
              order by created_at limit 1 for update skip locked)
  returning * into item;
  if not found then return null; end if;
  return to_jsonb(item);
end $$;

create or replace function public.le_finish_lead_alert(p_id uuid, p_token uuid, p_ok boolean)
returns void language sql security definer set search_path = public as $$
  update public.le_leads set owner_alerted_at = case when p_ok then now() end,
    alert_lease_token=null, alert_lease_until=null,
    alert_next_at = case when p_ok then null
      else now() + make_interval(secs => least(21600, 300 * power(2, least(greatest(alert_attempts-1,0), 10)))) end
  where id=p_id and alert_lease_token=p_token;
$$;

-- Aggregates only (no personal data) for monitoring.
create or replace function public.le_lead_retry_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'enabled', (public.le_lead_retry_config()).enabled,
    'pending', count(*) filter (where delivery_status='pending'),
    'pending_due', count(*) filter (where delivery_status='pending' and next_attempt_at<=now()),
    'failed', count(*) filter (where delivery_status='failed'),
    'delivered', count(*) filter (where delivery_status='delivered'),
    'awaiting_owner_alert', count(*) filter (where delivery_status<>'delivered' and owner_alerted_at is null
       and (delivery_status='failed' or attempt_count >= (public.le_lead_retry_config()).alert_after_attempts)),
    'oldest_pending', min(created_at) filter (where delivery_status='pending'))
  from public.le_leads;
$$;

-- pg_cron entry point. No HTTP at all when disabled or nothing is due.
-- The token lives in Vault (lady_elka_lead_retry_token) and must equal Edge secret LEAD_RETRY_TOKEN.
create or replace function public.le_lead_retry_tick()
returns bigint language plpgsql security definer set search_path = public as $$
declare s public.le_lead_retry_settings := public.le_lead_retry_config(); secret text; request_id bigint;
begin
  if not s.enabled then return null; end if;
  if not exists (select 1 from public.le_leads where delivery_status='pending' and next_attempt_at<=now()
                   and (lease_until is null or lease_until<now()) and created_at > now() - make_interval(hours => s.max_age_hours))
     and not exists (select 1 from public.le_leads where owner_alerted_at is null and delivery_status<>'delivered'
                   and (delivery_status='failed' or attempt_count >= s.alert_after_attempts)
                   and (alert_next_at is null or alert_next_at<=now())
                   and created_at > now() - make_interval(hours => s.max_age_hours)) then
    return null;
  end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name='lady_elka_lead_retry_token' limit 1;
  if coalesce(length(secret), 0) < 32 then
    raise warning 'lead retry: Vault secret lady_elka_lead_retry_token missing';
    return null;
  end if;
  select net.http_post(url := s.function_url || '?action=retry',
    headers := jsonb_build_object('Content-Type','application/json','x-lead-retry-token',secret),
    body := '{}'::jsonb, timeout_milliseconds := 120000) into request_id;
  return request_id;
end $$;

revoke all on function public.le_lead_retry_config() from public,anon,authenticated;
revoke all on function public.le_claim_lead(uuid,uuid) from public,anon,authenticated;
revoke all on function public.le_finish_lead_attempt(uuid,uuid,jsonb,boolean,text) from public,anon,authenticated;
revoke all on function public.le_finish_lead(uuid,uuid,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.le_claim_next_lead(uuid,boolean) from public,anon,authenticated;
revoke all on function public.le_claim_lead_alert(uuid,boolean) from public,anon,authenticated;
revoke all on function public.le_finish_lead_alert(uuid,uuid,boolean) from public,anon,authenticated;
revoke all on function public.le_lead_retry_status() from public,anon,authenticated;
revoke all on function public.le_lead_retry_tick() from public,anon,authenticated,service_role;
grant execute on function public.le_lead_retry_config() to service_role;
grant execute on function public.le_claim_lead(uuid,uuid) to service_role;
grant execute on function public.le_finish_lead_attempt(uuid,uuid,jsonb,boolean,text) to service_role;
grant execute on function public.le_finish_lead(uuid,uuid,jsonb,boolean) to service_role;
grant execute on function public.le_claim_next_lead(uuid,boolean) to service_role;
grant execute on function public.le_claim_lead_alert(uuid,boolean) to service_role;
grant execute on function public.le_finish_lead_alert(uuid,uuid,boolean) to service_role;
grant execute on function public.le_lead_retry_status() to service_role;

-- Cron job is created ONCE and INACTIVE. Re-applying this migration never re-activates it.
do $cron$
begin
  -- Nested IF: cron.job is only referenced when pg_cron exists (local test databases lack it).
  if to_regnamespace('cron') is not null then
    if not exists (select 1 from cron.job where jobname='lady-elka-lead-retry') then
      perform cron.schedule('lady-elka-lead-retry', '*/2 * * * *', 'select public.le_lead_retry_tick();');
      perform cron.alter_job(job_id := (select jobid from cron.job where jobname='lady-elka-lead-retry'), active := false);
    end if;
  end if;
end;
$cron$;
