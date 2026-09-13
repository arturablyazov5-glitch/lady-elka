-- Промокоды: заменяют лист Google Таблицы (gid=301234033).
-- Сайт читает только действующие коды через публичный CSV сервиса.
create table if not exists public.le_promo_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  comment text not null default '',
  rub integer not null default 0 check (rub >= 0 and rub <= 1000000),
  pct numeric(5,2) not null default 0 check (pct >= 0 and pct < 100),
  gift boolean not null default false,
  active boolean not null default true,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint le_promo_code_shape check (code ~ '^[^\s,"]{1,40}$'),
  constraint le_promo_value check (rub > 0 or pct > 0 or gift),
  constraint le_promo_single_discount check (rub = 0 or pct = 0)
);
-- Регистр и «ё» не важны: сайт сравнивает коды нормализованными.
create unique index if not exists le_promo_code_unique
  on public.le_promo_codes (lower(translate(code, 'ёЁ', 'ее')));
alter table public.le_promo_codes enable row level security;
revoke all on public.le_promo_codes from anon, authenticated;
grant all on public.le_promo_codes to service_role;
notify pgrst, 'reload schema';
