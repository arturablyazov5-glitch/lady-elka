-- Isolated V2 worker only. Existing pay, bank/Telegram webhooks and legacy jobs remain unchanged.
begin;
create or replace function public.le_v2_worker_tick()
returns bigint[] language plpgsql security definer set search_path = pg_catalog
as $$
declare token text; ids bigint[]:=array[]::bigint[]; id bigint; action text; stamp text; nonce text; signature text;
begin
  select decrypted_secret into token from vault.decrypted_secrets where name='lady_elka_v2_worker_token' limit 1;
  if coalesce(length(token),0)<32 then raise exception 'V2 worker authorization missing'; end if;
  foreach action in array array['poll-payments','retry-cod-delivery'] loop
    stamp:=floor(extract(epoch from clock_timestamp()))::bigint::text;
    nonce:=gen_random_uuid()::text;
    signature:=encode(extensions.hmac(action||':'||stamp||':'||nonce,token,'sha256'),'hex');
    select net.http_post(
      url:='https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/pay-v2?action='||action,
      headers:=jsonb_build_object('Content-Type','application/json','X-Worker-Time',stamp,'X-Worker-Nonce',nonce,'X-Worker-Signature',signature),
      body:='{}'::jsonb,timeout_milliseconds:=55000
    ) into id; ids:=ids||id;
  end loop;
  return ids;
end $$;
revoke all on function public.le_v2_worker_tick() from public, anon, authenticated, service_role;
do $$ begin
  if not exists(select 1 from cron.job where jobname='lady-elka-v2-worker') then
    perform cron.schedule('lady-elka-v2-worker','*/2 * * * *','select public.le_v2_worker_tick();');
  end if;
end $$;
commit;
