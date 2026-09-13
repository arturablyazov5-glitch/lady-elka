create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

create table if not exists public.payment_orders (
  md_order text primary key,
  order_number text not null,
  amount numeric(12, 2) not null,
  description text not null default '',
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  last_checked_at timestamptz,
  notified_at timestamptz,
  last_error text
);

alter table public.payment_orders enable row level security;

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
