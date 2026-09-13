select cron.unschedule('lady-elka-payment-poll');

select cron.schedule(
  'lady-elka-payment-poll',
  '*/2 * * * *',
  $schedule$
  select net.http_post(
    url := 'https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/pay?action=poll-payments',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Poll-Token', 'n4a40fp6n57oco5s48jrm94qsh'
    ),
    body := '{}'::jsonb
  );
  $schedule$
);
