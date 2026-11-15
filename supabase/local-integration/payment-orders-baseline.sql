-- Local integration fixture only. Mirrors the existing payment_orders table
-- columns needed by the new recovery RPC without importing historical cron SQL.
create table public.payment_orders (
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
revoke all on public.payment_orders from public, anon, authenticated;
grant select, insert, update on public.payment_orders to service_role;

-- These tables exist only inside the disposable local project. They let the
-- mock bank and Telegram Edge Function persist call counts without storing
-- notification text, credentials, or buyer data.
create table public.local_provider_state (
  id integer primary key check (id = 1),
  config jsonb not null
);
insert into public.local_provider_state(id, config) values (1, '{
  "alfa_register": "success",
  "alfa_status": 0,
  "telegram": "success",
  "telegram_fail_chat": "mock-chat-2",
  "delay_ms": 0
}'::jsonb);

create table public.local_provider_calls (
  id bigint generated always as identity primary key,
  provider text not null check (provider in ('alfa', 'telegram')),
  operation text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.local_provider_payments (
  payment_id text primary key,
  order_number text not null,
  amount_kopecks bigint not null,
  order_status integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.local_provider_state enable row level security;
alter table public.local_provider_calls enable row level security;
alter table public.local_provider_payments enable row level security;
revoke all on public.local_provider_state, public.local_provider_calls, public.local_provider_payments
  from public, anon, authenticated;
grant select, insert, update, delete on public.local_provider_state, public.local_provider_calls,
  public.local_provider_payments to service_role;
grant usage, select on sequence public.local_provider_calls_id_seq to service_role;
notify pgrst, 'reload schema';
