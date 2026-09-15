-- Isolated from customer orders and Genvito billing. One subscription per Lady Elka store.
create table if not exists public.le_pro_billing (
 id integer primary key check (id = 1),
 payload jsonb not null default '{"payments":[]}'::jsonb,
 revision bigint not null default 1
);
alter table public.le_pro_billing enable row level security;
revoke all on public.le_pro_billing from anon, authenticated;
grant all on public.le_pro_billing to service_role;
insert into public.le_pro_billing(id) values (1) on conflict do nothing;
