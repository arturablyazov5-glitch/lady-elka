create table if not exists public.le_catalog_settings (
 id integer primary key check(id=1), payload jsonb not null,
 revision integer not null default 1, updated_at timestamptz not null default now()
);
alter table public.le_catalog_settings enable row level security;
revoke all on public.le_catalog_settings from anon, authenticated;
grant all on public.le_catalog_settings to service_role;
notify pgrst, 'reload schema';
