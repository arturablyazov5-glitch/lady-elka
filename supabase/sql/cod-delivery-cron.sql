-- OPTIONAL rollout step, NOT an automatically applied migration. Not run in this local stage.
-- Requires pg_cron, pg_net, Vault, and a deployed compatible pay handler.
-- Provision Vault secrets lady_elka_project_url and lady_elka_cod_retry_token securely.
-- Set the same random token (at least 32 characters) as Edge secret COD_DELIVERY_RETRY_TOKEN.
-- This schedules real delivery: run only after separate deployment authorization.
do $checks$
begin
  if to_regclass('cron.job') is null or to_regnamespace('net') is null or to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Enable Supabase Cron, pg_net and Vault first';
  end if;
  if (select count(*) from vault.decrypted_secrets where name = 'lady_elka_project_url') <> 1
    or (select count(*) from vault.decrypted_secrets where name = 'lady_elka_cod_retry_token' and length(decrypted_secret) >= 32) <> 1 then
    raise exception 'Provision the two unique Vault secrets first';
  end if;
end;
$checks$;
select cron.schedule('lady-elka-cod-delivery', '*/5 * * * *', $job$
  select net.http_post(
    url := (select rtrim(decrypted_secret, '/') from vault.decrypted_secrets where name = 'lady_elka_project_url')
      || '/functions/v1/pay?action=retry-cod-delivery',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cod-Retry-Token',
      (select decrypted_secret from vault.decrypted_secrets where name = 'lady_elka_cod_retry_token')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$job$);
-- To stop automatic delivery: select cron.unschedule('lady-elka-cod-delivery');
