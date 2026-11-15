-- PREPARED ONLY — НЕ применять на боевой БД без явного разрешения владельца (ЗАДАЧА 16, agent-context/secrets-audit.md).
-- Применять ТОЧЕЧНО (SQL Editor / Management API), НЕ через `supabase db push`.
--
-- Зачем: миграции 20260902000000_payment_polling.sql и 20260902000100_fix_payment_poll_auth.sql
-- зашили токен X-Poll-Token (= Edge-секрет ALFA_CALLBACK_TOKEN) открытым текстом в команду pg_cron
-- (cron.job.command) и в публичный git. Эта миграция переводит джобу 'lady-elka-payment-poll'
-- на функцию, которая читает токен из Supabase Vault. Сам токен в этом файле НЕ содержится.
--
-- Предусловие (делает владелец, значение вводит сам, в чат/логи/git не вставлять):
--   select vault.create_secret('<ТЕКУЩИЙ ALFA_CALLBACK_TOKEN>', 'lady_elka_payment_poll_token',
--                              'X-Poll-Token для pay?action=poll-payments; = Edge ALFA_CALLBACK_TOKEN');
--   На первом шаге кладём ТЕКУЩЕЕ значение → поведение не меняется, простоя нет.
--   Ротация на новое значение — отдельным шагом (план в agent-context/secrets-audit.md, раздел «Ротация»).
--
-- Свойства: идемпотентна; без секрета в Vault падает ДО любых изменений (джоба остаётся старой и рабочей);
-- расписание и флаг active джобы сохраняются (cron.alter_job меняет только command).

do $pre$
begin
  if to_regnamespace('cron') is null or to_regnamespace('net') is null or to_regclass('vault.decrypted_secrets') is null then
    raise exception 'payment_poll_vault: нужны pg_cron, pg_net и Vault';
  end if;
  if (select count(*) from vault.decrypted_secrets
        where name = 'lady_elka_payment_poll_token' and length(decrypted_secret) >= 20) <> 1 then
    raise exception 'payment_poll_vault: сначала создайте ровно один Vault-секрет lady_elka_payment_poll_token (= Edge ALFA_CALLBACK_TOKEN)';
  end if;
end;
$pre$;

create or replace function public.le_payment_poll_tick()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  secret text;
  request_id bigint;
begin
  select decrypted_secret into secret
    from vault.decrypted_secrets
   where name = 'lady_elka_payment_poll_token'
   limit 1;
  if coalesce(length(secret), 0) < 20 then
    raise warning 'payment poll: Vault secret lady_elka_payment_poll_token missing';
    return null;
  end if;
  select net.http_post(
    url := 'https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/pay?action=poll-payments',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Poll-Token', secret),
    body := '{}'::jsonb
  ) into request_id;
  return request_id;
end
$$;

comment on function public.le_payment_poll_tick() is
  'pg_cron lady-elka-payment-poll: POST pay?action=poll-payments, X-Poll-Token из Vault lady_elka_payment_poll_token';

-- Вызывать может только владелец (postgres, от него работает pg_cron). Ни anon, ни authenticated, ни service_role.
revoke all on function public.le_payment_poll_tick() from public, anon, authenticated, service_role;

do $cron$
declare
  jid bigint;
begin
  select jobid into jid from cron.job where jobname = 'lady-elka-payment-poll' limit 1;
  if jid is null then
    perform cron.schedule('lady-elka-payment-poll', '*/2 * * * *', 'select public.le_payment_poll_tick();');
  else
    perform cron.alter_job(job_id := jid, command := 'select public.le_payment_poll_tick();');
  end if;
end;
$cron$;

-- Проверка после применения (read-only, значения не выводит):
--   select jobid, jobname, schedule, active, command not ilike '%x-poll-token%' as no_literal_token from cron.job where jobname = 'lady-elka-payment-poll';
--   select status, return_message, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'lady-elka-payment-poll') order by start_time desc limit 3;
--   select status_code, created from net._http_response order by created desc limit 3;   -- ждём 200, не 401
--
-- Откат (без возврата литерала в git): вернуть старую команду можно только вручную в SQL Editor,
-- подставив значение из локального «Переменные окружения.ini». Предпочтительно не откатывать, а починить Vault-секрет:
--   select vault.update_secret((select id from vault.secrets where name = 'lady_elka_payment_poll_token'), '<ЗНАЧЕНИЕ = Edge ALFA_CALLBACK_TOKEN>');
