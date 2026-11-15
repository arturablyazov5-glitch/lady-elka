-- Additive lead inbox/outbox. Only service_role can read personal data or call RPCs.
create table if not exists public.le_leads (
  id uuid primary key,
  fingerprint text not null,
  payload jsonb not null,
  ip_hash text not null,
  phone_hash text not null,
  created_at timestamptz not null default now(),
  recipients jsonb not null default '[]'::jsonb,
  delivered_to jsonb not null default '[]'::jsonb,
  delivery_status text not null default 'pending' check (delivery_status in ('pending','delivered')),
  attempt_count integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now()
);
create index if not exists le_leads_ip_created on public.le_leads(ip_hash, created_at);
create index if not exists le_leads_phone_created on public.le_leads(phone_hash, created_at);
create index if not exists le_leads_pending on public.le_leads(next_attempt_at) where delivery_status='pending';
alter table public.le_leads enable row level security;
revoke all on public.le_leads from anon, authenticated;
grant select, insert, update on public.le_leads to service_role;

create or replace function public.le_accept_lead(p_id uuid, p_fingerprint text, p_payload jsonb, p_ip_hash text, p_phone_hash text, p_recipients jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare item public.le_leads;
begin
  -- Stable lock order prevents deadlocks; limits hold across Edge instances.
  perform pg_advisory_xact_lock(hashtextextended('lead-id:' || p_id::text, 0));
  select * into item from public.le_leads where id=p_id;
  if found then
    if item.fingerprint <> p_fingerprint then return jsonb_build_object('error','conflict'); end if;
    return to_jsonb(item);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('lead-ip:' || p_ip_hash, 0));
  perform pg_advisory_xact_lock(hashtextextended('lead-phone:' || p_phone_hash, 0));
  if (select count(*) from public.le_leads where ip_hash=p_ip_hash and created_at>now()-interval '10 minutes') >= 5
     or (select count(*) from public.le_leads where phone_hash=p_phone_hash and created_at>now()-interval '1 hour') >= 3 then
    return jsonb_build_object('error','rate_limit');
  end if;
  insert into public.le_leads(id,fingerprint,payload,ip_hash,phone_hash,recipients)
    values(p_id,p_fingerprint,p_payload,p_ip_hash,p_phone_hash,p_recipients) returning * into item;
  return to_jsonb(item);
end $$;

create or replace function public.le_claim_lead(p_id uuid, p_token uuid)
returns jsonb language sql security definer set search_path = public as $$
  update public.le_leads set lease_token=p_token, lease_until=now()+interval '2 minutes', attempt_count=attempt_count+1
  where id=p_id and delivery_status='pending' and (lease_until is null or lease_until<now())
  returning to_jsonb(le_leads.*);
$$;

create or replace function public.le_finish_lead(p_id uuid, p_token uuid, p_delivered jsonb, p_complete boolean)
returns void language sql security definer set search_path = public as $$
  update public.le_leads set delivered_to=p_delivered,
    delivery_status=case when p_complete then 'delivered' else 'pending' end,
    lease_until=null, lease_token=null,
    next_attempt_at=now()+interval '5 minutes'
  where id=p_id and lease_token=p_token;
$$;
revoke all on function public.le_accept_lead(uuid,text,jsonb,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.le_claim_lead(uuid,uuid) from public,anon,authenticated;
revoke all on function public.le_finish_lead(uuid,uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.le_accept_lead(uuid,text,jsonb,text,text,jsonb) to service_role;
grant execute on function public.le_claim_lead(uuid,uuid) to service_role;
grant execute on function public.le_finish_lead(uuid,uuid,jsonb,boolean) to service_role;

create or replace function public.le_ack_lead(p_id uuid, p_token uuid, p_chat text)
returns void language sql security definer set search_path = public as $$
  update public.le_leads set delivered_to=delivered_to || jsonb_build_array(p_chat)
  where id=p_id and lease_token=p_token and not delivered_to @> jsonb_build_array(p_chat);
$$;
revoke all on function public.le_ack_lead(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.le_ack_lead(uuid,uuid,text) to service_role;
