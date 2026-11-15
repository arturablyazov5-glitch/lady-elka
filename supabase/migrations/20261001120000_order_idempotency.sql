-- Prepared locally after read-only inspection of the linked public schema.
-- payment_orders remains the existing bank polling queue.
begin;
create table public.le_orders (
  order_id text primary key,
  fingerprint text not null,
  payment_method text not null check (payment_method in ('card', 'cash_on_delivery')),
  status text not null default 'received' check (status in ('received', 'accepted', 'awaiting_payment', 'paid')),
  payload jsonb not null,
  total numeric(12,2) not null check (total > 0),
  payment_id text unique,
  result jsonb,
  notification text,
  telegram_sent boolean not null default false,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.le_order_effects (
  effect_key text primary key,
  state text not null check (state in ('running', 'done', 'failed', 'unknown')),
  token uuid not null,
  result jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.le_orders enable row level security;
alter table public.le_order_effects enable row level security;
revoke all on public.le_orders, public.le_order_effects from public, anon, authenticated;
grant select, insert, update on public.le_orders, public.le_order_effects to service_role;

-- Called only after read-only Alfa checks prove that this payment already exists.
-- The unknown -> done transition, order link, result, and polling queue entry commit atomically.
create or replace function public.le_recover_bank_order(
  p_order_id text,
  p_payment_id text,
  p_bank_status integer,
  p_bank_amount_kopecks bigint,
  p_payment_url text,
  p_description text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_order public.le_orders%rowtype;
  v_effect public.le_order_effects%rowtype;
  v_queue_id text;
  v_result jsonb;
begin
  if coalesce(trim(p_order_id), '') = '' or coalesce(trim(p_payment_id), '') = '' or length(p_payment_id) > 36 then
    raise exception 'Invalid recovery identifiers' using errcode = '22023';
  end if;
  if p_bank_status is null or p_bank_status not in (0, 2) then
    raise exception 'Bank status requires manual review' using errcode = '22023';
  end if;
  if p_bank_amount_kopecks is null or p_bank_amount_kopecks < 0 then
    raise exception 'Invalid bank amount' using errcode = '22023';
  end if;

  select * into v_order from public.le_orders where order_id = p_order_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if v_order.payment_method <> 'card' then
    raise exception 'Only card orders can be recovered' using errcode = '22023';
  end if;
  if round(v_order.total * 100) <> p_bank_amount_kopecks then
    raise exception 'Bank amount does not match stored order' using errcode = '22023';
  end if;
  if v_order.payment_id is not null and v_order.payment_id <> p_payment_id then
    raise exception 'Order already has a different payment ID' using errcode = '23505';
  end if;
  if v_order.result ? 'paymentId' and v_order.result->>'paymentId' <> p_payment_id then
    raise exception 'Order result contains a different payment ID' using errcode = '23505';
  end if;
  if p_bank_status <> 2 and coalesce(trim(p_payment_url), '') = '' then
    raise exception 'Unpaid recovery requires a verified payment form URL' using errcode = '22023';
  end if;

  select * into v_effect
    from public.le_order_effects
   where effect_key = 'bank:' || p_order_id
   for update;
  if not found or v_effect.state <> 'unknown' then
    raise exception 'Bank effect must be unknown and inactive before recovery' using errcode = '55000';
  end if;

  v_result := jsonb_build_object(
    'url', coalesce(p_payment_url, ''),
    'paymentId', p_payment_id,
    'orderId', p_order_id,
    'amount', v_order.total,
    'description', coalesce(p_description, ''),
    'paid', p_bank_status = 2
  );

  insert into public.payment_orders(md_order, order_number, amount, description, status)
  values (p_payment_id, p_order_id, v_order.total, left(coalesce(p_description, ''), 512),
          case when p_bank_status = 2 then 'paid' else 'pending' end)
  on conflict (md_order) do update set
    order_number = excluded.order_number,
    amount = excluded.amount,
    description = coalesce(public.payment_orders.description, excluded.description),
    status = case when public.payment_orders.status = 'paid' or p_bank_status = 2 then 'paid' else 'pending' end,
    created_at = case when public.payment_orders.notified_at is null then now() else public.payment_orders.created_at end,
    last_checked_at = now(),
    last_error = null
  where public.payment_orders.order_number = excluded.order_number
    and public.payment_orders.amount = excluded.amount
  returning md_order into v_queue_id;
  if v_queue_id is null then
    raise exception 'Payment queue contains a conflicting bank order' using errcode = '23505';
  end if;

  update public.le_orders set
    payment_id = p_payment_id,
    result = v_result,
    status = case when status = 'paid' or p_bank_status = 2 then 'paid' else 'awaiting_payment' end,
    last_checked_at = now(),
    last_error = null,
    updated_at = now()
  where order_id = p_order_id;

  update public.le_order_effects set
    state = 'done',
    result = v_result,
    last_error = null,
    updated_at = now()
  where effect_key = 'bank:' || p_order_id and state = 'unknown';
  if not found then raise exception 'Bank effect changed during recovery' using errcode = '55000'; end if;

  return v_result;
end;
$function$;

revoke all on function public.le_recover_bank_order(text, text, integer, bigint, text, text) from public, anon, authenticated;
grant execute on function public.le_recover_bank_order(text, text, integer, bigint, text, text) to service_role;
commit;
notify pgrst, 'reload schema';
