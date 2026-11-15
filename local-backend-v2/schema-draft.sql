-- LOCAL DRAFT ONLY: no deployment, grants, extensions or scheduler configuration.
CREATE SCHEMA le_checkout_v2;
CREATE TABLE le_checkout_v2.orders (
 id text PRIMARY KEY, owner text NOT NULL, fingerprint text NOT NULL,
 bank_number text NOT NULL UNIQUE CHECK (bank_number ~ '^LE2[0-9a-f]{28}$'),
 amount bigint NOT NULL CHECK(amount > 0), method text NOT NULL CHECK(method IN ('card','cash_on_delivery')),
 recipients jsonb NOT NULL CHECK(jsonb_array_length(recipients)>0),
 status text NOT NULL DEFAULT 'received', payment_id text UNIQUE, payment_url text, provider_result jsonb, paid_evidence jsonb
);
CREATE TABLE le_checkout_v2.bank_queue (
 order_id text PRIMARY KEY REFERENCES le_checkout_v2.orders(id), payment_id text NOT NULL UNIQUE
);
CREATE TABLE le_checkout_v2.effects (
 key text PRIMARY KEY CHECK(key LIKE 'v2:%'), order_id text NOT NULL REFERENCES le_checkout_v2.orders(id),
 state text NOT NULL CHECK(state IN ('running','succeeded','failed','unknown')), result jsonb
);
CREATE TABLE le_checkout_v2.budgets (key text PRIMARY KEY, capacity integer NOT NULL CHECK(capacity>=0), used integer NOT NULL DEFAULT 0);
-- Policy values are fixture/operator configuration; no production defaults.
ALTER TABLE le_checkout_v2.budgets ADD COLUMN window_ms bigint CHECK(window_ms>0), ADD COLUMN owner_capacity integer CHECK(owner_capacity>=0), ADD COLUMN window_start bigint;
CREATE TABLE le_checkout_v2.owner_budgets (budget text REFERENCES le_checkout_v2.budgets(key), owner text, window_start bigint NOT NULL, used integer NOT NULL, PRIMARY KEY(budget,owner));
CREATE FUNCTION le_checkout_v2.server_ms() RETURNS bigint LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$ SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint $$;
CREATE FUNCTION le_checkout_v2.consume_window(b text,o text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE policy le_checkout_v2.budgets; t bigint; w bigint; consumed integer;
BEGIN
 SELECT * INTO policy FROM le_checkout_v2.budgets WHERE key=b FOR UPDATE;
 IF NOT FOUND OR policy.window_ms IS NULL OR policy.owner_capacity IS NULL OR o IS NULL OR length(o)=0 OR length(o)>256 THEN RAISE EXCEPTION 'ADMISSION_UNAVAILABLE'; END IF;
 t:=le_checkout_v2.server_ms();
 IF t<0 THEN RAISE EXCEPTION 'ADMISSION_UNAVAILABLE'; END IF;
 w:=(t/policy.window_ms)*policy.window_ms;
 -- Backward clock movement fails closed, never reopens an old window.
 IF policy.window_start>w THEN RAISE EXCEPTION 'ADMISSION_UNAVAILABLE'; END IF;
 IF policy.window_start IS NULL OR policy.window_start<w THEN
  UPDATE le_checkout_v2.budgets SET window_start=w,used=0 WHERE key=b;
  policy.used:=0;
 END IF;
 SELECT used INTO consumed FROM le_checkout_v2.owner_budgets WHERE budget=b AND owner=o AND window_start=w;
 IF policy.used>=policy.capacity OR coalesce(consumed,0)>=policy.owner_capacity THEN
  RAISE EXCEPTION 'RATE_LIMITED' USING DETAIL=ceil((w+policy.window_ms-t)/1000.0)::text;
 END IF;
 UPDATE le_checkout_v2.budgets SET used=used+1 WHERE key=b;
 INSERT INTO le_checkout_v2.owner_budgets VALUES(b,o,w,1) ON CONFLICT(budget,owner) DO UPDATE SET window_start=w,used=CASE WHEN le_checkout_v2.owner_budgets.window_start=w THEN le_checkout_v2.owner_budgets.used+1 ELSE 1 END;
 -- Incremental bounded cleanup affects counters only, never orders/effects.
 DELETE FROM le_checkout_v2.owner_budgets WHERE (budget,owner) IN (SELECT budget,owner FROM le_checkout_v2.owner_budgets WHERE budget=b AND window_start<w ORDER BY owner LIMIT 100);
END $$;
CREATE FUNCTION le_checkout_v2.consume_admission(k text,b text,o text) RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 -- Lock budget first; all concurrent consumers serialize, including exact replay.
 PERFORM 1 FROM le_checkout_v2.budgets WHERE key=b FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ADMISSION_UNAVAILABLE'; END IF;
 PERFORM le_checkout_v2.consume_window(b,o);
 RETURN true;
END $$;
CREATE FUNCTION le_checkout_v2.reserve_order(i text,o text,f text,n text,a bigint,m text,r jsonb,b text,opened boolean)
RETURNS le_checkout_v2.orders LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE saved le_checkout_v2.orders;
BEGIN
 -- Budget lock is also reservation serialization; missing configuration fails closed.
 PERFORM 1 FROM le_checkout_v2.budgets WHERE key=b FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ADMISSION_UNAVAILABLE'; END IF;
 SELECT * INTO saved FROM le_checkout_v2.orders WHERE id=i;
 IF FOUND THEN
  IF saved.owner<>o THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF saved.fingerprint<>f THEN RAISE EXCEPTION 'CONFLICT'; END IF;
  RETURN saved;
 END IF;
 IF NOT opened THEN RAISE EXCEPTION 'CREATE_CLOSED'; END IF;
 IF NOT le_checkout_v2.consume_admission('order:'||i,b,o) THEN RAISE EXCEPTION 'RATE_LIMITED'; END IF;
 INSERT INTO le_checkout_v2.orders(id,owner,fingerprint,bank_number,amount,method,recipients) VALUES(i,o,f,n,a,m,r) RETURNING * INTO saved;
 RETURN saved;
END $$;
CREATE FUNCTION le_checkout_v2.claim_effect(k text,i text,b text) RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 PERFORM 1 FROM le_checkout_v2.budgets WHERE key=b FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ADMISSION_UNAVAILABLE'; END IF;
 PERFORM 1 FROM le_checkout_v2.orders WHERE id=i FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'OWNERSHIP'; END IF;
 IF EXISTS(SELECT 1 FROM le_checkout_v2.effects WHERE key=k AND order_id<>i) THEN RAISE EXCEPTION 'OWNERSHIP'; END IF;
 IF EXISTS(SELECT 1 FROM le_checkout_v2.effects WHERE key=k AND state IN ('running','unknown','succeeded')) THEN RETURN false; END IF;
 PERFORM le_checkout_v2.consume_window(b,(SELECT owner FROM le_checkout_v2.orders WHERE id=i));
 IF k NOT LIKE 'v2:%' THEN RAISE EXCEPTION 'OWNERSHIP'; END IF;
 INSERT INTO le_checkout_v2.effects VALUES(k,i,'running',NULL) ON CONFLICT DO NOTHING;
 IF FOUND THEN RETURN true; END IF;
 UPDATE le_checkout_v2.effects SET state='running' WHERE key=k AND order_id=i AND state='failed';
 RETURN FOUND;
END $$;
CREATE FUNCTION le_checkout_v2.recover_bank_order(i text,p text,n text,a bigint,e jsonb) RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 PERFORM 1 FROM le_checkout_v2.orders WHERE id=i AND payment_id=p AND bank_number=n AND amount=a AND method='card' FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE le_checkout_v2.orders SET status='paid',paid_evidence=e WHERE id=i;
 DELETE FROM le_checkout_v2.bank_queue WHERE order_id=i AND payment_id=p;
 RETURN true;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA le_checkout_v2 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA le_checkout_v2 FROM PUBLIC;
REVOKE ALL ON SCHEMA le_checkout_v2 FROM PUBLIC;
-- No server role is granted here. A future reviewed role/exposure policy is required.
