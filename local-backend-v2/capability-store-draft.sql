-- LOCAL ONLY: after schema-draft.sql and roles-draft.sql in a fresh isolated DB.
CREATE ROLE le_v2_cap_resolver NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE le_v2_cap_provisioner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE TABLE le_checkout_v2.session_capabilities (
 session_hash text PRIMARY KEY CHECK(session_hash ~ '^[a-f0-9]{64}$'),
 owner text NOT NULL CHECK(length(owner) BETWEEN 1 AND 256),
 token text UNIQUE REFERENCES le_checkout_v2.capabilities(token),
 revoked boolean NOT NULL DEFAULT false
);
ALTER TABLE le_checkout_v2.session_capabilities OWNER TO le_v2_owner;

CREATE FUNCTION le_checkout_v2.cap_resolve(h text,o text,s text)
RETURNS TABLE(token text,expires_ms bigint,can_create boolean,can_status boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF session_user <> 'le_v2_cap_resolver' THEN RAISE EXCEPTION 'ROLE_INVALID'; END IF;
 IF s NOT IN ('create','status') OR s IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 RETURN QUERY SELECT c.token,c.expires_ms,c.can_create,c.can_status
 FROM le_checkout_v2.session_capabilities m JOIN le_checkout_v2.capabilities c ON c.token=m.token
 WHERE m.session_hash=h AND m.owner=o AND c.owner=o AND NOT m.revoked
 AND c.expires_ms>le_checkout_v2.server_ms()
 AND CASE s WHEN 'create' THEN c.can_create ELSE c.can_status END;
END $$;

CREATE FUNCTION le_checkout_v2.cap_issue(h text,o text,t text,e bigint,c boolean,s boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE saved le_checkout_v2.session_capabilities;
BEGIN
 IF session_user <> 'le_v2_cap_provisioner' THEN RAISE EXCEPTION 'ROLE_INVALID'; END IF;
 IF h IS NULL OR h !~ '^[a-f0-9]{64}$' OR o IS NULL OR length(o) NOT BETWEEN 1 AND 256
 OR t IS NULL OR t !~ '^[a-f0-9]{64}$' OR e IS NULL OR e<=le_checkout_v2.server_ms()
 OR e>9007199254740991 OR c IS NULL OR s IS NULL OR NOT(c OR s) THEN RAISE EXCEPTION 'INVALID_CAPABILITY'; END IF;
 INSERT INTO le_checkout_v2.session_capabilities(session_hash,owner) VALUES(h,o) ON CONFLICT DO NOTHING;
 SELECT * INTO saved FROM le_checkout_v2.session_capabilities WHERE session_hash=h FOR UPDATE;
 IF saved.owner<>o THEN RAISE EXCEPTION 'OWNERSHIP'; END IF;
 IF saved.revoked THEN RAISE EXCEPTION 'SESSION_REVOKED'; END IF;
 -- All mutations share this RPC transaction; a token collision rolls everything back.
 UPDATE le_checkout_v2.session_capabilities SET token=NULL WHERE session_hash=h;
 DELETE FROM le_checkout_v2.capabilities WHERE token=saved.token;
 INSERT INTO le_checkout_v2.capabilities VALUES(t,o,e,c,s);
 UPDATE le_checkout_v2.session_capabilities SET token=t,revoked=false WHERE session_hash=h;
END $$;

CREATE FUNCTION le_checkout_v2.cap_revoke(h text,o text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE saved le_checkout_v2.session_capabilities;
BEGIN
 IF session_user <> 'le_v2_cap_provisioner' THEN RAISE EXCEPTION 'ROLE_INVALID'; END IF;
 IF h IS NULL OR h !~ '^[a-f0-9]{64}$' OR o IS NULL OR length(o) NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'INVALID_CAPABILITY'; END IF;
 -- Tombstone unknown sessions too, so racing issue/revoke lock the same persistent row.
 INSERT INTO le_checkout_v2.session_capabilities(session_hash,owner,revoked) VALUES(h,o,true) ON CONFLICT DO NOTHING;
 SELECT * INTO saved FROM le_checkout_v2.session_capabilities WHERE session_hash=h FOR UPDATE;
 IF saved.owner<>o THEN RAISE EXCEPTION 'OWNERSHIP'; END IF;
 UPDATE le_checkout_v2.session_capabilities SET token=NULL,revoked=true WHERE session_hash=h;
 DELETE FROM le_checkout_v2.capabilities WHERE token=saved.token;
END $$;
ALTER FUNCTION le_checkout_v2.cap_resolve(text,text,text) OWNER TO le_v2_owner;
ALTER FUNCTION le_checkout_v2.cap_issue(text,text,text,bigint,boolean,boolean) OWNER TO le_v2_owner;
ALTER FUNCTION le_checkout_v2.cap_revoke(text,text) OWNER TO le_v2_owner;
REVOKE ALL ON le_checkout_v2.session_capabilities FROM PUBLIC,le_v2_cap_resolver,le_v2_cap_provisioner;
REVOKE ALL ON FUNCTION le_checkout_v2.cap_resolve(text,text,text),le_checkout_v2.cap_issue(text,text,text,bigint,boolean,boolean),le_checkout_v2.cap_revoke(text,text) FROM PUBLIC,le_v2_cap_resolver,le_v2_cap_provisioner;
GRANT USAGE ON SCHEMA le_checkout_v2 TO le_v2_cap_resolver,le_v2_cap_provisioner;
GRANT EXECUTE ON FUNCTION le_checkout_v2.cap_resolve(text,text,text) TO le_v2_cap_resolver;
GRANT EXECUTE ON FUNCTION le_checkout_v2.cap_issue(text,text,text,bigint,boolean,boolean),le_checkout_v2.cap_revoke(text,text) TO le_v2_cap_provisioner;
