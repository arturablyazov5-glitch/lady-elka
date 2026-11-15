-- Prepared locally. Apply after order_idempotency, before deploying the updated pay handler.
begin;
alter table public.le_orders
  add column notification_checked_at timestamptz,
  add column notification_chat_ids jsonb;
alter table public.le_order_effects
  add column attempt_count integer not null default 1 check (attempt_count > 0),
  add column next_attempt_at timestamptz;
update public.le_order_effects set next_attempt_at = updated_at + interval '1 minute'
where state = 'failed' and effect_key like 'telegram:cash_on_delivery:%';
create index le_orders_cod_delivery_queue on public.le_orders
  (notification_checked_at asc nulls first, created_at)
  where payment_method = 'cash_on_delivery' and status = 'accepted' and not telegram_sent;
commit;
notify pgrst, 'reload schema';
