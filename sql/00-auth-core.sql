-- 00-auth-core.sql  (effortless-magic-links)
--
-- The database half of sign-in: it verifies a magic-link JWT ITSELF and keeps
-- the verified email in transaction-local settings, so row-level security can
-- read it. Pure PL/pgSQL (RSA verification on `numeric`), so it needs no
-- plpython3u, no pgcrypto and no extension: it installs on any Postgres 14+.
--
-- Same contract surface as magiclink.effortlessapi.com's install-magic-links.sql
-- (auth.trusted_tenants, auth.set_jwt, app.jwt_email, app.jwt_claims,
-- app.jwt_tenant_id), so policies written against it work on either.
--
-- Idempotent: safe to run on every boot.

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO PUBLIC;

CREATE TABLE IF NOT EXISTS auth.trusted_tenants (
  tenant_id      text PRIMARY KEY,
  public_key_pem text NOT NULL,
  display_name   text,
  project_name   text,
  is_active      boolean     NOT NULL DEFAULT true,
  is_dev         boolean     NOT NULL DEFAULT false,
  added_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE auth.trusted_tenants ADD COLUMN IF NOT EXISTS is_dev boolean NOT NULL DEFAULT false;

-- ml_settings.stage is 'dev' until a live boot flips it to 'live'. A database that
-- has been live never trusts a dev key again (see auth.register_tenant).
CREATE TABLE IF NOT EXISTS auth.ml_settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- ---------------------------------------------------------------- bytes <-> numeric

CREATE OR REPLACE FUNCTION auth.b64url_decode(p text) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $f$
  SELECT decode(
    translate(p, '-_', '+/') || repeat('=', (4 - length(p) % 4) % 4),
    'base64')
$f$;

CREATE OR REPLACE FUNCTION auth.bytes_to_num(b bytea) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE acc numeric := 0; i int;
BEGIN
  FOR i IN 0 .. length(b) - 1 LOOP
    acc := acc * 256 + get_byte(b, i);
  END LOOP;
  RETURN acc;
END $f$;

CREATE OR REPLACE FUNCTION auth.num_to_bytes(n numeric, len int) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE out bytea := ''::bytea; rest numeric := n; i int;
BEGIN
  FOR i IN 1 .. len LOOP
    out := set_byte('\x00'::bytea, 0, mod(rest, 256)::int) || out;
    rest := div(rest, 256);        -- div, not trunc(rest / 256): numeric division loses digits on a 2048-bit number
  END LOOP;
  RETURN out;
END $f$;

CREATE OR REPLACE FUNCTION auth.modexp(base numeric, exp numeric, m numeric) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE result numeric := 1; b numeric := mod(base, m); e numeric := exp;
BEGIN
  WHILE e > 0 LOOP
    IF mod(e, 2) = 1 THEN result := mod(result * b, m); END IF;
    e := div(e, 2);
    IF e > 0 THEN b := mod(b * b, m); END IF;
  END LOOP;
  RETURN result;
END $f$;

-- ---------------------------------------------------------------- PEM -> (n, e)

-- Reads one DER element at byte offset `pos`: its tag, the offset where its
-- content starts and the content length.
CREATE OR REPLACE FUNCTION auth.der_read(b bytea, pos int,
  OUT tag int, OUT content_at int, OUT content_len int)
LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE l int; nbytes int; i int;
BEGIN
  tag := get_byte(b, pos);
  l := get_byte(b, pos + 1);
  IF l < 128 THEN
    content_len := l; content_at := pos + 2;
  ELSE
    nbytes := l - 128; content_len := 0;
    FOR i IN 1 .. nbytes LOOP
      content_len := content_len * 256 + get_byte(b, pos + 1 + i);
    END LOOP;
    content_at := pos + 2 + nbytes;
  END IF;
END $f$;

-- A SubjectPublicKeyInfo ("BEGIN PUBLIC KEY") RSA key: SEQ{ SEQ{OID,NULL}, BITSTRING{ 00, SEQ{ INT n, INT e } } }.
CREATE OR REPLACE FUNCTION auth.pem_to_rsa(pem text, OUT n numeric, OUT e numeric)
LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE
  der bytea; r record; pos int;
BEGIN
  der := decode(regexp_replace(pem, '-----[^-]+-----|\s', '', 'g'), 'base64');
  r := auth.der_read(der, 0);                       -- outer SEQUENCE
  IF r.tag <> 48 THEN RAISE EXCEPTION 'not a DER sequence'; END IF;
  pos := r.content_at;
  r := auth.der_read(der, pos);                     -- AlgorithmIdentifier
  IF r.tag <> 48 THEN RAISE EXCEPTION 'unexpected public key layout'; END IF;
  pos := r.content_at + r.content_len;
  r := auth.der_read(der, pos);                     -- BIT STRING
  IF r.tag <> 3 THEN RAISE EXCEPTION 'unexpected public key layout'; END IF;
  pos := r.content_at + 1;                          -- skip the unused-bits byte
  r := auth.der_read(der, pos);                     -- RSAPublicKey SEQUENCE
  IF r.tag <> 48 THEN RAISE EXCEPTION 'unexpected RSA key layout'; END IF;
  pos := r.content_at;
  r := auth.der_read(der, pos);                     -- modulus
  IF r.tag <> 2 THEN RAISE EXCEPTION 'unexpected RSA key layout'; END IF;
  n := auth.bytes_to_num(substring(der FROM r.content_at + 1 FOR r.content_len));
  pos := r.content_at + r.content_len;
  r := auth.der_read(der, pos);                     -- exponent
  IF r.tag <> 2 THEN RAISE EXCEPTION 'unexpected RSA key layout'; END IF;
  e := auth.bytes_to_num(substring(der FROM r.content_at + 1 FOR r.content_len));
END $f$;

-- ---------------------------------------------------------------- RS256

-- RSASSA-PKCS1-v1_5 with SHA-256, per RFC 8017 section 8.2.2: recompute the
-- encoded message from the signing input and compare it to sig^e mod n.
CREATE OR REPLACE FUNCTION auth.verify_rs256(signing_input text, sig bytea, pem text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE
  k int; key record; em bytea; expected bytea;
  -- DigestInfo prefix for SHA-256
  prefix bytea := '\x3031300d060960864801650304020105000420'::bytea;
BEGIN
  SELECT * INTO key FROM auth.pem_to_rsa(pem);
  k := 0;                                           -- byte length of the modulus
  WHILE key.n >= power(256::numeric, k) LOOP k := k + 1; END LOOP;
  IF length(sig) <> k THEN RETURN false; END IF;
  IF auth.bytes_to_num(sig) >= key.n THEN RETURN false; END IF;
  em := auth.num_to_bytes(auth.modexp(auth.bytes_to_num(sig), key.e, key.n), k);
  expected := '\x0001'::bytea
           || decode(repeat('ff', k - 3 - length(prefix) - 32), 'hex')
           || '\x00'::bytea || prefix
           || sha256(convert_to(signing_input, 'UTF8'));
  RETURN em = expected;
END $f$;

-- ---------------------------------------------------------------- tenants

-- Register (or refresh) a tenant whose tokens this database trusts.
-- A dev tenant is refused once the database has gone live.
CREATE OR REPLACE FUNCTION auth.register_tenant(
  p_tenant_id text, p_pem text, p_is_dev boolean DEFAULT false, p_display_name text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM auth.pem_to_rsa(p_pem);   -- refuse a key that cannot be read
  IF p_is_dev AND (SELECT value FROM auth.ml_settings WHERE key = 'stage') = 'live' THEN
    RAISE EXCEPTION 'this database is live: a dev key is never trusted here';
  END IF;
  INSERT INTO auth.trusted_tenants (tenant_id, public_key_pem, display_name, is_active, is_dev)
  VALUES (p_tenant_id, p_pem, p_display_name, true, p_is_dev)
  ON CONFLICT (tenant_id) DO UPDATE
    SET public_key_pem = EXCLUDED.public_key_pem,
        display_name   = COALESCE(EXCLUDED.display_name, auth.trusted_tenants.display_name),
        is_dev         = EXCLUDED.is_dev,
        is_active      = true;
END $f$;

-- Mark the database live: forget every dev key, and never take one again.
CREATE OR REPLACE FUNCTION auth.go_live() RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
  DELETE FROM auth.trusted_tenants WHERE is_dev;
  INSERT INTO auth.ml_settings (key, value) VALUES ('stage', 'live')
  ON CONFLICT (key) DO UPDATE SET value = 'live';
END $f$;

-- ---------------------------------------------------------------- set_jwt

-- Verify a bearer token and keep its claims for the rest of THIS transaction.
-- Raises invalid_jwt on a malformed, unsigned-by-a-trusted-tenant or expired token.
CREATE OR REPLACE FUNCTION auth.set_jwt(token text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
DECLARE
  parts text[]; header jsonb; claims jsonb; tenant record; email text;
  now_s numeric := extract(epoch FROM now());
BEGIN
  parts := string_to_array(token, '.');
  IF array_length(parts, 1) IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'invalid_jwt: malformed'; END IF;
  BEGIN
    header := convert_from(auth.b64url_decode(parts[1]), 'UTF8')::jsonb;
    claims := convert_from(auth.b64url_decode(parts[2]), 'UTF8')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid_jwt: malformed';
  END;
  IF header ->> 'alg' IS DISTINCT FROM 'RS256' THEN RAISE EXCEPTION 'invalid_jwt: alg'; END IF;

  SELECT * INTO tenant FROM auth.trusted_tenants
   WHERE tenant_id = claims ->> 'tenant_id' AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_jwt: unknown tenant'; END IF;

  -- iss is the FULL url form ".../<tenant_id>"; it must name the same tenant.
  IF coalesce(claims ->> 'iss', '') NOT LIKE '%' || tenant.tenant_id THEN
    RAISE EXCEPTION 'invalid_jwt: issuer';
  END IF;

  IF NOT auth.verify_rs256(parts[1] || '.' || parts[2], auth.b64url_decode(parts[3]), tenant.public_key_pem) THEN
    RAISE EXCEPTION 'invalid_jwt: signature';
  END IF;

  IF (claims ->> 'exp') IS NULL OR (claims ->> 'exp')::numeric <= now_s THEN
    RAISE EXCEPTION 'invalid_jwt: expired';
  END IF;
  IF (claims ->> 'nbf') IS NOT NULL AND (claims ->> 'nbf')::numeric > now_s + 60 THEN
    RAISE EXCEPTION 'invalid_jwt: not yet valid';
  END IF;

  email := lower(nullif(claims ->> 'email', ''));
  IF email IS NULL THEN RAISE EXCEPTION 'invalid_jwt: no email'; END IF;

  PERFORM set_config('app.jwt_email',     email,                 true);
  PERFORM set_config('app.jwt_claims',    claims::text,          true);
  PERFORM set_config('app.jwt_tenant_id', tenant.tenant_id,      true);
  PERFORM set_config('app.jwt_is_dev',    tenant.is_dev::text,   true);
  RETURN email;
END $f$;

-- ---------------------------------------------------------------- helpers policies read

CREATE OR REPLACE FUNCTION app.jwt_email() RETURNS text
LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('app.jwt_email', true), '') $f$;

CREATE OR REPLACE FUNCTION app.jwt_claims() RETURNS jsonb
LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('app.jwt_claims', true), '')::jsonb, '{}'::jsonb) $f$;

CREATE OR REPLACE FUNCTION app.jwt_tenant_id() RETURNS text
LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('app.jwt_tenant_id', true), '') $f$;

-- True only when the token was signed by a DEV tenant's key and carries dev_admin.
-- A database that never registers a dev tenant (every beta / production one)
-- can never return true here.
CREATE OR REPLACE FUNCTION app.jwt_is_dev_admin() RETURNS boolean
LANGUAGE sql STABLE AS $f$
  SELECT coalesce(current_setting('app.jwt_is_dev', true), 'false') = 'true'
     AND coalesce(app.jwt_claims() ->> 'dev_admin', 'false') = 'true'
$f$;
