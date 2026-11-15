-- LOCAL REVIEW DRAFT ONLY. Run AFTER schema-draft.sql in a fresh isolated DB.
-- Never run against an existing Supabase project. No existing roles are altered.
CREATE ROLE le_v2_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE le_v2_create NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE le_v2_status NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE le_v2_callback NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE le_v2_internal NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

-- Capability provisioning/revocation is privileged gateway/operator work.
-- Synthetic test tokens are NOT production credentials. Use random >=256-bit tokens,
-- never owner/clientId/orderId as tokens; do not expose this table or a mint RPC.
CREATE TABLE le_checkout_v2.capabilities (
 token text PRIMARY KEY, owner text NOT NULL CHECK(length(owner) BETWEEN 1 AND 256),
 expires_ms bigint NOT NULL, can_create boolean NOT NULL DEFAULT false,
 can_status boolean NOT NULL DEFAULT false
);
CREATE TABLE le_checkout_v2.gateway_policy (singleton boolean PRIMARY KEY CHECK(singleton), create_open boolean NOT NULL DEFAULT false);
INSERT INTO le_checkout_v2.gateway_policy VALUES(true,false);
CREATE FUNCTION le_checkout_v2.cap_owner(c text, purpose text) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE o text;
BEGIN
 SELECT owner INTO o FROM le_checkout_v2.capabilities
 WHERE token=c AND expires_ms>le_checkout_v2.server_ms()
 AND CASE purpose WHEN 'create' THEN can_create WHEN 'status' THEN can_status ELSE false END;
 IF o IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 RETURN o;
END $$;

-- Pre-auth counters use the actual connection identity, never request input.
CREATE FUNCTION le_checkout_v2.api_gate() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF session_user NOT IN ('le_v2_create','le_v2_status','le_v2_callback','le_v2_internal') THEN RAISE EXCEPTION 'ROLE_INVALID'; END IF;
 PERFORM le_checkout_v2.consume_window('request','untrusted');
 IF session_user='le_v2_callback' THEN PERFORM le_checkout_v2.consume_window('callback','untrusted'); END IF;
 IF session_user='le_v2_internal' THEN PERFORM le_checkout_v2.consume_window('internal','untrusted'); END IF;
END $$;

CREATE FUNCTION le_checkout_v2.api_create(c text,i text,f text,n text,a bigint,m text,r jsonb)
RETURNS TABLE(id text,status text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE saved le_checkout_v2.orders; o text;
BEGIN
 o:=le_checkout_v2.cap_owner(c,'create');
 -- Fixed policies, never selected by an untrusted caller. Gateway also enforces
 -- pre-auth request limits before SQL; these counters protect authenticated calls.
 PERFORM le_checkout_v2.consume_window('ownerRequest',o);
 PERFORM le_checkout_v2.consume_window('replay',o);
 saved:=le_checkout_v2.reserve_order(i,o,f,n,a,m,r,'create',coalesce((SELECT create_open FROM le_checkout_v2.gateway_policy WHERE singleton),false));
 RETURN QUERY SELECT saved.id,saved.status;
END $$;

CREATE FUNCTION le_checkout_v2.api_status(c text,i text)
RETURNS TABLE(id text,status text,payment_url text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o text;
BEGIN
 o:=le_checkout_v2.cap_owner(c,'status');
 PERFORM le_checkout_v2.consume_window('ownerRequest',o);
 PERFORM le_checkout_v2.consume_window('status',o);
 RETURN QUERY SELECT x.id,x.status,CASE WHEN x.status='awaiting_payment' THEN x.payment_url ELSE NULL END
 FROM le_checkout_v2.orders x WHERE x.id=i AND x.owner=o;
END $$;

CREATE FUNCTION le_checkout_v2.api_callback_lookup(p text) RETURNS SETOF le_checkout_v2.orders
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT * FROM le_checkout_v2.orders WHERE payment_id=p AND method='card'
$$;
CREATE FUNCTION le_checkout_v2.api_callback_recover(i text,p text,n text,a bigint,e jsonb)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT le_checkout_v2.recover_bank_order(i,p,n,a,e)
$$;
-- This role is a TRUSTED worker, not a public caller. Provider evidence validation,
-- effect outcomes and cancellation belong to the adapter; no invented SQL auth.
CREATE FUNCTION le_checkout_v2.api_internal(op text,x jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
 CASE op
 WHEN 'get' THEN SELECT to_jsonb(o) INTO result FROM le_checkout_v2.orders o WHERE id=x->>'id';
 WHEN 'poll' THEN SELECT coalesce(jsonb_agg(to_jsonb(o)),'[]'::jsonb) INTO result FROM
  (SELECT a.* FROM le_checkout_v2.bank_queue q JOIN le_checkout_v2.orders a ON a.id=q.order_id AND a.payment_id=q.payment_id
   WHERE a.method='card' AND a.status='awaiting_payment' ORDER BY a.id LIMIT 20) o;
 WHEN 'pending' THEN SELECT coalesce(jsonb_agg(to_jsonb(o)),'[]'::jsonb) INTO result FROM
  (SELECT * FROM le_checkout_v2.orders WHERE status IN ('accepted','paid') ORDER BY id LIMIT 20) o;
 WHEN 'claim' THEN
  IF x->>'kind' NOT IN ('bank','telegram') OR x->>'kind' IS NULL THEN RAISE EXCEPTION 'INVALID_EFFECT'; END IF;
  result:=to_jsonb(le_checkout_v2.claim_effect(x->>'key',x->>'id',x->>'kind'));
 WHEN 'finish' THEN
  IF x->>'state' NOT IN ('failed','succeeded','unknown') OR x->>'state' IS NULL THEN RAISE EXCEPTION 'INVALID_EFFECT'; END IF;
  UPDATE le_checkout_v2.effects SET state=x->>'state',result=x->'result' WHERE key=x->>'key' AND state='running';
 WHEN 'bind' THEN
  UPDATE le_checkout_v2.orders SET payment_id=x->>'paymentId',status='awaiting_payment',
   payment_url=x->>'paymentURL',provider_result=x->'result' WHERE id=x->>'id' AND payment_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'BIND_CONFLICT'; END IF;
  INSERT INTO le_checkout_v2.bank_queue VALUES(x->>'id',x->>'paymentId');
 WHEN 'status' THEN
  IF x->>'status' NOT IN ('accepted','pending_review') OR x->>'status' IS NULL THEN RAISE EXCEPTION 'INVALID_STATUS'; END IF;
  UPDATE le_checkout_v2.orders SET status=x->>'status' WHERE id=x->>'id' AND status<>'paid'
   AND (x->>'status'<>'pending_review' OR payment_id IS NULL);
 ELSE RAISE EXCEPTION 'INVALID_OPERATION';
 END CASE;
 RETURN result;
END $$;

-- Transfer only this new schema's objects to the non-login definer owner.
DO $$
DECLARE obj record;
BEGIN
 FOR obj IN SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='le_checkout_v2' AND c.relkind='r'
 LOOP EXECUTE format('ALTER TABLE le_checkout_v2.%I OWNER TO le_v2_owner',obj.relname); END LOOP;
 FOR obj IN SELECT p.oid::regprocedure AS signature FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='le_checkout_v2'
 LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO le_v2_owner',obj.signature); END LOOP;
END $$;
ALTER SCHEMA le_checkout_v2 OWNER TO le_v2_owner;
REVOKE ALL ON SCHEMA le_checkout_v2 FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA le_checkout_v2 FROM PUBLIC,le_v2_create,le_v2_status,le_v2_callback,le_v2_internal;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA le_checkout_v2 FROM PUBLIC,le_v2_create,le_v2_status,le_v2_callback,le_v2_internal;
ALTER DEFAULT PRIVILEGES FOR ROLE le_v2_owner IN SCHEMA le_checkout_v2 REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA le_checkout_v2 TO le_v2_create,le_v2_status,le_v2_callback,le_v2_internal;
GRANT EXECUTE ON FUNCTION le_checkout_v2.api_create(text,text,text,text,bigint,text,jsonb) TO le_v2_create;
GRANT EXECUTE ON FUNCTION le_checkout_v2.api_status(text,text) TO le_v2_status;
GRANT EXECUTE ON FUNCTION le_checkout_v2.api_callback_lookup(text),le_checkout_v2.api_callback_recover(text,text,text,bigint,jsonb) TO le_v2_callback,le_v2_internal;
GRANT EXECUTE ON FUNCTION le_checkout_v2.api_internal(text,jsonb) TO le_v2_internal;
-- No login membership, public schema ACL changes, service_role grants or REST exposure.

GRANT EXECUTE ON FUNCTION le_checkout_v2.api_gate() TO le_v2_create,le_v2_status,le_v2_callback,le_v2_internal;
