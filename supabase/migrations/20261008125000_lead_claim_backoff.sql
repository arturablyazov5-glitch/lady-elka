-- Fix (review item 5): a public replay of the same lead id must not bypass backoff.
-- Initial claim happens once (attempt_count = 0); every later claim only when next_attempt_at is due.
-- The attempt limit is enforced by the status: after max_attempts the lead is 'failed' and never claimed.
-- Additive: only replaces le_claim_lead; apply AFTER 20261008090000 and 20261008120000.
create or replace function public.le_claim_lead(p_id uuid, p_token uuid)
returns jsonb language sql security definer set search_path = public as $$
  update public.le_leads set lease_token=p_token, lease_until=now()+interval '2 minutes',
    attempt_count=attempt_count+1, last_attempt_at=now()
  where id=p_id and delivery_status='pending'
    and (lease_until is null or lease_until<now())
    and (attempt_count = 0 or next_attempt_at <= now())
    and attempt_count < (public.le_lead_retry_config()).max_attempts
  returning to_jsonb(le_leads.*);
$$;
revoke all on function public.le_claim_lead(uuid,uuid) from public,anon,authenticated;
grant execute on function public.le_claim_lead(uuid,uuid) to service_role;
