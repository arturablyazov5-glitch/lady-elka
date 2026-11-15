-- PREPARED ONLY. Apply to production only with owner authorization, as one transaction, BEFORE deploying the catalog
-- edge version that calls these functions (it fails closed with 503 on /api/login when they are missing).
-- Brute-force limit for catalog /api/login, shared by all Edge instances (not instance memory):
--  * per source (sha256 of the gateway-supplied client address, never the raw IP): 5 attempts free,
--    then exponential backoff 30 s · 2^(n-5), max 1 h; counter resets after a quiet hour or a successful login;
--  * global endpoint budget: 100 attempts per 15 minutes from all sources together (defends spoofed/rotating sources).
-- An attempt is reserved atomically BEFORE the password check, so parallel requests cannot bypass the counters.
create table if not exists public.le_catalog_login_limits (
  key text primary key check (key = 'global' or key ~ '^src:[a-f0-9]{64}$'),
  attempts integer not null default 0 check (attempts >= 0),
  window_start timestamptz not null default now(),
  blocked_until timestamptz
);
create index if not exists le_catalog_login_limits_window on public.le_catalog_login_limits(window_start);
alter table public.le_catalog_login_limits enable row level security;
revoke all on public.le_catalog_login_limits from public, anon, authenticated;
grant all on public.le_catalog_login_limits to service_role;

create or replace function public.le_catalog_login_attempt(p_source text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  now_ts timestamptz := clock_timestamp();
  src public.le_catalog_login_limits; glob public.le_catalog_login_limits;
  src_key text; wait_s integer;
begin
  if p_source is null or p_source !~ '^[a-f0-9]{64}$' then raise exception 'invalid login source'; end if;
  src_key := 'src:' || p_source;
  insert into public.le_catalog_login_limits(key, window_start) values ('global', now_ts), (src_key, now_ts) on conflict (key) do nothing;
  -- Fixed lock order (global, then source): no deadlocks; the global row serializes login attempts (low volume endpoint).
  select * into glob from public.le_catalog_login_limits where key = 'global' for update;
  select * into src from public.le_catalog_login_limits where key = src_key for update;
  delete from public.le_catalog_login_limits
    where key <> 'global' and key <> src_key and window_start < now_ts - interval '1 day' and (blocked_until is null or blocked_until < now_ts);
  if glob.window_start <= now_ts - interval '15 minutes' then glob.attempts := 0; glob.window_start := now_ts; end if;
  if src.window_start <= now_ts - interval '1 hour' and (src.blocked_until is null or src.blocked_until <= now_ts) then
    src.attempts := 0; src.window_start := now_ts; src.blocked_until := null;
  end if;
  if src.blocked_until > now_ts then
    wait_s := ceil(extract(epoch from src.blocked_until - now_ts))::integer;
  elsif glob.attempts >= 100 then
    wait_s := greatest(1, ceil(extract(epoch from glob.window_start + interval '15 minutes' - now_ts))::integer);
  else
    src.attempts := src.attempts + 1; glob.attempts := glob.attempts + 1;
    if src.attempts >= 5 then src.blocked_until := now_ts + make_interval(secs => least(3600, 30 * power(2, src.attempts - 5))); end if;
  end if;
  update public.le_catalog_login_limits set attempts = glob.attempts, window_start = glob.window_start where key = 'global';
  update public.le_catalog_login_limits set attempts = src.attempts, window_start = src.window_start, blocked_until = src.blocked_until where key = src_key;
  if wait_s is not null then return jsonb_build_object('allowed', false, 'retry_after', greatest(1, wait_s)); end if;
  return jsonb_build_object('allowed', true);
end $$;

-- Successful login: forget this source's failures and return its reserved slot to the global budget.
create or replace function public.le_catalog_login_success(p_source text) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_source is null or p_source !~ '^[a-f0-9]{64}$' then raise exception 'invalid login source'; end if;
  update public.le_catalog_login_limits set attempts = greatest(attempts - 1, 0) where key = 'global';
  delete from public.le_catalog_login_limits where key = 'src:' || p_source;
end $$;

revoke all on function public.le_catalog_login_attempt(text) from public, anon, authenticated;
revoke all on function public.le_catalog_login_success(text) from public, anon, authenticated;
grant execute on function public.le_catalog_login_attempt(text) to service_role;
grant execute on function public.le_catalog_login_success(text) to service_role;
