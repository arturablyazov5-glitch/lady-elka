-- Server-side COD deduplication across new browser-generated order IDs.
-- Apply the V2 variant before deploying pay-v2. No historical rows are removed.
begin;
create or replace function public.le_v2_cod_identity(p jsonb) returns jsonb
language sql immutable set search_path = public, pg_temp as $$
 select jsonb_build_object(
 'phone', right(regexp_replace(coalesce(p#>>'{customer,phone}', ''), '[^0-9]', '', 'g'),10),
 'customer', (select jsonb_object_agg(k, lower(regexp_replace(trim(coalesce(p#>>array['customer',k],'')), '\s+', ' ', 'g')))
   from unnest(array['name','email','contactPref','comment']) k),
 'address', lower(regexp_replace(trim(coalesce(p#>>'{delivery,address}','')), '\s+', ' ', 'g')),
 'items', (select jsonb_agg(x order by x::text) from jsonb_array_elements(p->'items') x),
 'amount', (p->>'amount')::numeric,
 'promo', upper(trim(coalesce(p#>>'{promo,code}', ''))));
$$;
create index if not exists le_v2_orders_cod_recent on public.le_v2_orders(created_at desc)
 where payment_method='cash_on_delivery';
create or replace function public.le_v2_reserve_cod_order(p_order_id text, p_payload jsonb, p_fingerprint text)
returns setof public.le_v2_orders language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_identity jsonb; v_order public.le_v2_orders%rowtype;
begin
 if p_payload->>'paymentMethod' is distinct from 'cash_on_delivery' or p_payload->>'orderId' is distinct from p_order_id
 then raise exception 'Invalid COD reservation'; end if;
 v_identity := public.le_v2_cod_identity(p_payload);
 -- Transaction-scoped lock serializes matching submissions across Edge instances.
 perform pg_advisory_xact_lock(hashtextextended(v_identity::text, 0));
 select * into v_order from public.le_v2_orders where order_id=p_order_id;
 if found then return next v_order; return; end if;
 select * into v_order from public.le_v2_orders
 where payment_method='cash_on_delivery' and created_at >= clock_timestamp()-interval '10 minutes'
   and public.le_v2_cod_identity(payload)=v_identity
 order by created_at,order_id limit 1;
 if found then return next v_order; return; end if;
 insert into public.le_v2_orders(order_id,fingerprint,payment_method,payload,total,status)
 values(p_order_id,p_fingerprint,'cash_on_delivery',p_payload,(p_payload->>'amount')::numeric,'received')
 on conflict(order_id) do nothing returning * into v_order;
 if not found then select * into v_order from public.le_v2_orders where order_id=p_order_id; end if;
 return next v_order;
end;
$$;
revoke all on function public.le_v2_cod_identity(jsonb) from public,anon,authenticated;
revoke all on function public.le_v2_reserve_cod_order(text,jsonb,text) from public,anon,authenticated;
grant execute on function public.le_v2_cod_identity(jsonb), public.le_v2_reserve_cod_order(text,jsonb,text) to service_role;
commit;
notify pgrst, 'reload schema';
