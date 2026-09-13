-- Separate from payment_orders. No anonymous reads or writes to the admin data.
create table if not exists public.le_catalog_products (
  id text primary key,
  payload jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint le_catalog_identity check (payload->>'id' = id)
);
alter table public.le_catalog_products enable row level security;
revoke all on public.le_catalog_products from anon, authenticated;
grant all on public.le_catalog_products to service_role;
