-- Blog only. Run explicitly; never through shared migration discovery.
begin;
create table if not exists public.le_blog_posts (
 id uuid primary key default gen_random_uuid(),
 slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug)<=160),
 status text not null check (status in ('draft','published','archived')),
 payload jsonb not null check (jsonb_typeof(payload)='object'),
 revision integer not null default 1 check (revision>0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 constraint le_blog_payload_identity check (payload->>'slug'=slug and payload->>'status'=status),
 constraint le_blog_payload_title check (length(payload->>'title') between 1 and 200)
);
alter table public.le_blog_posts enable row level security;
revoke all on public.le_blog_posts from anon,authenticated;
grant select on public.le_blog_posts to anon,authenticated;
grant all on public.le_blog_posts to service_role;
do $$ begin
 if not exists(select 1 from pg_policies where schemaname='public' and tablename='le_blog_posts' and policyname='le_blog_published_read') then
  create policy le_blog_published_read on public.le_blog_posts for select to anon,authenticated using (status='published');
 end if;
end $$;
commit;
