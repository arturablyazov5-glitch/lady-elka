-- Only an admission counter; no tokens, pg_net, triggers, cron or catalog writes.
create table if not exists public.le_catalog_publish_limit (
  id integer primary key check (id = 1),
  last_started_at timestamptz,
  attempts bigint not null default 0
);
alter table public.le_catalog_publish_limit enable row level security;
revoke all on public.le_catalog_publish_limit from public, anon, authenticated;
insert into public.le_catalog_publish_limit(id) values (1) on conflict do nothing;

create or replace function public.le_catalog_publish_take()
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  previous timestamptz;
  current_time_value timestamptz;
begin
  select last_started_at into previous from public.le_catalog_publish_limit where id = 1 for update;
  if not found then raise exception 'publish limiter unavailable'; end if;
  -- Read clock AFTER obtaining the global row lock, including concurrent callers.
  current_time_value := clock_timestamp();
  if previous is not null and previous + interval '60 seconds' > current_time_value then
    return jsonb_build_object('allowed', false, 'retry_after',
      greatest(1, ceil(extract(epoch from previous + interval '60 seconds' - current_time_value))::integer));
  end if;
  update public.le_catalog_publish_limit set last_started_at = current_time_value, attempts = attempts + 1 where id = 1;
  return jsonb_build_object('allowed', true);
end;
$$;
revoke all on function public.le_catalog_publish_take() from public, anon, authenticated;
grant execute on function public.le_catalog_publish_take() to service_role;
