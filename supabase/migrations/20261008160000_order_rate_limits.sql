-- Prepared locally. NOT applied to production: apply with the order migrations before deploying pay (see supabase/DEPLOY.md).
-- Fixed-window counters for order admission and the shared external-call budget.
-- A request takes all of its buckets atomically: either every counter is incremented or none is.
begin;
create table public.le_rate_limits (
  bucket text not null check (length(bucket) between 1 and 200),
  window_start timestamptz not null,
  hits integer not null default 0 check (hits >= 0),
  primary key (bucket, window_start)
);
alter table public.le_rate_limits enable row level security;
revoke all on public.le_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on public.le_rate_limits to service_role;

-- Returns 0 when admitted, otherwise the Retry-After value in seconds (nothing is counted then).
create or replace function public.le_rate_limit_take(p_buckets text[], p_limits integer[], p_windows integer[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_start timestamptz;
  v_hits integer;
  v_retry integer := 0;
  i integer;
begin
  if p_buckets is null or p_limits is null or p_windows is null
     or cardinality(p_buckets) = 0 or cardinality(p_buckets) > 16
     or cardinality(p_buckets) <> cardinality(p_limits) or cardinality(p_buckets) <> cardinality(p_windows) then
    raise exception 'Invalid rate limit request' using errcode = '22023';
  end if;
  for i in 1 .. cardinality(p_buckets) loop
    if p_buckets[i] is null or length(p_buckets[i]) not between 1 and 200
       or p_limits[i] is null or p_limits[i] < 1
       or p_windows[i] is null or p_windows[i] < 1 or p_windows[i] > 86400 then
      raise exception 'Invalid rate limit request' using errcode = '22023';
    end if;
  end loop;

  begin
    for i in 1 .. cardinality(p_buckets) loop
      v_start := to_timestamp(floor(extract(epoch from v_now) / p_windows[i]) * p_windows[i]);
      insert into public.le_rate_limits as l (bucket, window_start, hits)
      values (p_buckets[i], v_start, 1)
      on conflict (bucket, window_start) do update set hits = l.hits + 1
      returning l.hits into v_hits;
      if v_hits > p_limits[i] then
        v_retry := greatest(v_retry, 1,
          ceil(extract(epoch from (v_start + make_interval(secs => p_windows[i]) - v_now)))::integer);
      end if;
    end loop;
    if v_retry > 0 then
      raise exception 'le_rate_limited' using errcode = 'P0001';
    end if;
  exception when sqlstate 'P0001' then
    -- Subtransaction rollback: a refused request consumes no budget. Local variables keep their values.
    if sqlerrm = 'le_rate_limited' then return v_retry; end if;
    raise;
  end;

  delete from public.le_rate_limits
   where ctid in (select ctid from public.le_rate_limits where window_start < v_now - interval '2 days' limit 100);
  return 0;
end;
$function$;

revoke all on function public.le_rate_limit_take(text[], integer[], integer[]) from public, anon, authenticated;
grant execute on function public.le_rate_limit_take(text[], integer[], integer[]) to service_role;
commit;
notify pgrst, 'reload schema';
