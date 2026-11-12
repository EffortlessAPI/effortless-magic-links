-- The database half of sign-in (effortless-magic-links). Becomes the seed's block in the
-- project's ERBCustomizations row "02b-customize-functions.sql", so it reaches Dev (the build
-- seeds postgres/02b-customize-functions.sql from it) and every published stage (the release
-- runs it inside update-effortless-schema.sql, as the database owner). Idempotent.
--
-- The chain: a person proves an email (magic-links, checked by the project's server), the
-- server asks auth.issue_session(email) for this app's own session, and every request runs
-- inside auth.sign_in(session), which checks it and keeps the claims for that transaction.
-- The policies (the 04b block) read app.session().
--
-- Sessions are HS256 tokens signed with a key that belongs to THIS database: made here on
-- first install, kept in auth.ml_key, which no request role can read. A Dev session is worth
-- nothing on Production, and there is no key to copy around.
--
-- Placeholders {{...}} are filled from magic-links.config.json by server/sql.js.

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA auth TO PUBLIC;
GRANT USAGE ON SCHEMA app TO PUBLIC;

CREATE TABLE IF NOT EXISTS auth.ml_key (
  id         integer     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  k_ipad     bytea       NOT NULL,
  k_opad     bytea       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- stage = 'live' once a published stage has started against this database. Never undone.
CREATE TABLE IF NOT EXISTS auth.ml_settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);
REVOKE ALL ON auth.ml_key, auth.ml_settings FROM PUBLIC;

-- ---------------------------------------------------------------- bytes

CREATE OR REPLACE FUNCTION auth.ml_xor(b bytea, pad integer) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE out bytea := b; i integer;
BEGIN
  FOR i IN 0 .. length(b) - 1 LOOP
    out := set_byte(out, i, get_byte(b, i) # pad);
  END LOOP;
  RETURN out;
END $f$;

CREATE OR REPLACE FUNCTION auth.ml_b64url(b bytea) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$ SELECT translate(encode(b, 'base64'), E'+/=\n', '-_') $f$;

CREATE OR REPLACE FUNCTION auth.ml_b64url_decode(p text) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $f$
  SELECT decode(translate(p, '-_', '+/') || repeat('=', (4 - length(p) % 4) % 4), 'base64')
$f$;

-- The key: 64 random bytes (the SHA-256 block size), stored as the two padded halves HMAC uses.
-- gen_random_uuid() is core since Postgres 13 and draws from the strong random source.
INSERT INTO auth.ml_key (id, k_ipad, k_opad)
SELECT 1, auth.ml_xor(k, 54), auth.ml_xor(k, 92)
  FROM (SELECT sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8'))
            || sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')) AS k) s
ON CONFLICT (id) DO NOTHING;

-- HMAC-SHA256(key, msg) = H(k_opad || H(k_ipad || msg)). Only the owner's own functions call it.
CREATE OR REPLACE FUNCTION auth.ml_hmac(msg text) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
  SELECT sha256(k.k_opad || sha256(k.k_ipad || convert_to(msg, 'UTF8'))) FROM auth.ml_key k WHERE k.id = 1
$f$;
REVOKE EXECUTE ON FUNCTION auth.ml_hmac(text) FROM PUBLIC;

-- ---------------------------------------------------------------- live or simulated

CREATE OR REPLACE FUNCTION auth.is_live() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
  SELECT coalesce((SELECT s.value = 'live' FROM auth.ml_settings s WHERE s.key = 'stage'), false)
$f$;

-- One way. The project's server calls it when it starts on a published stage.
CREATE OR REPLACE FUNCTION auth.go_live() RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$
  INSERT INTO auth.ml_settings (key, value) VALUES ('stage', 'live')
  ON CONFLICT (key) DO UPDATE SET value = 'live'
$f$;

-- ---------------------------------------------------------------- the people (the mapping)

-- One approved person, read through the users view as the owner (row security off, so it
-- works before anyone is signed in). Late-bound: a project whose users table has not been
-- built yet still installs, and finds nobody.
CREATE OR REPLACE FUNCTION auth.ml_user(p_email text, p_key text)
RETURNS TABLE (user_key text, email text, name text, active boolean, roles text[], extra jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public SET row_security = off AS $f$
BEGIN
  RETURN QUERY
  SELECT ({{KEY_EXPR}})::text, lower(({{EMAIL_EXPR}})::text), ({{NAME_EXPR}})::text,
         ({{ACTIVE_EXPR}}), ({{ROLES_EXPR}}), ({{CLAIMS_EXPR}})
    FROM public.{{USERS_VIEW}} u
   WHERE CASE WHEN p_key IS NOT NULL THEN ({{KEY_EXPR}})::text = p_key
              ELSE lower(({{EMAIL_EXPR}})::text) = lower(p_email) END
   ORDER BY ({{ACTIVE_EXPR}}) DESC
   LIMIT 1;
EXCEPTION WHEN undefined_table OR undefined_column THEN
  RETURN;
END $f$;
REVOKE EXECUTE ON FUNCTION auth.ml_user(text, text) FROM PUBLIC;

-- Before any code is sent: is this an approved, active person? Says nothing else.
CREATE OR REPLACE FUNCTION auth.email_is_approved(p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
  SELECT coalesce((SELECT u.active FROM auth.ml_user(p_email, NULL) u), false)
$f$;

-- ---------------------------------------------------------------- sessions

CREATE OR REPLACE FUNCTION auth.ml_sign(claims jsonb) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE input text;
BEGIN
  input := auth.ml_b64url(convert_to('{"alg":"HS256","typ":"JWT"}', 'UTF8'))
        || '.' || auth.ml_b64url(convert_to(claims::text, 'UTF8'));
  RETURN input || '.' || auth.ml_b64url(auth.ml_hmac(input));
END $f$;
REVOKE EXECUTE ON FUNCTION auth.ml_sign(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION auth.ml_issue(p_email text, p_simulated boolean) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE u record; now_s bigint := floor(extract(epoch FROM clock_timestamp()));
BEGIN
  IF p_simulated AND auth.is_live() THEN
    RAISE EXCEPTION 'magic_links: this database has run real sign-in; simulated users are refused for good';
  END IF;
  SELECT * INTO u FROM auth.ml_user(p_email, NULL);
  IF NOT FOUND OR NOT u.active THEN RETURN NULL; END IF;
  RETURN auth.ml_sign(
    u.extra
    || jsonb_build_object('iss', 'effortless-magic-links', 'sub', u.user_key, 'email', u.email,
                          'name', u.name, 'roles', to_jsonb(u.roles), 'role', u.roles[1],
                          'iat', now_s, 'exp', now_s + {{SESSION_SECONDS}})
    || CASE WHEN p_simulated THEN '{"simulated": true}'::jsonb ELSE '{}'::jsonb END);
END $f$;
REVOKE EXECUTE ON FUNCTION auth.ml_issue(text, boolean) FROM PUBLIC;

-- After the email is proven (the project's server checks the magic-links token). NULL when the
-- address is not an approved, active person.
CREATE OR REPLACE FUNCTION auth.issue_session(p_email text) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$ SELECT auth.ml_issue(p_email, false) $f$;

-- Dev's "pick your user": the same session, marked simulated. Refused on a live database.
CREATE OR REPLACE FUNCTION auth.issue_simulated_session(p_email text) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $f$ SELECT auth.ml_issue(p_email, true) $f$;

-- The claims of a good session, refreshed from the person's row (roles, name, extra claims), or
-- NULL: a bad signature, expired, simulated on a live database, or the person is gone or inactive.
CREATE OR REPLACE FUNCTION auth.read_session(token text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE parts text[]; claims jsonb; u record;
BEGIN
  IF token IS NULL OR token !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' THEN RETURN NULL; END IF;
  parts := string_to_array(token, '.');
  IF auth.ml_b64url(auth.ml_hmac(parts[1] || '.' || parts[2])) <> parts[3] THEN RETURN NULL; END IF;
  claims := convert_from(auth.ml_b64url_decode(parts[2]), 'UTF8')::jsonb;
  IF coalesce((claims ->> 'exp')::numeric, 0) <= extract(epoch FROM clock_timestamp()) THEN RETURN NULL; END IF;
  IF coalesce((claims ->> 'simulated')::boolean, false) AND auth.is_live() THEN RETURN NULL; END IF;
  SELECT * INTO u FROM auth.ml_user(NULL, claims ->> 'sub');
  IF NOT FOUND OR NOT u.active THEN RETURN NULL; END IF;
  RETURN claims || u.extra
      || jsonb_build_object('email', u.email, 'name', u.name, 'roles', to_jsonb(u.roles), 'role', u.roles[1]);
END $f$;

-- Every request: BEGIN; SELECT auth.sign_in($session); <the query>; COMMIT.
-- Keeps the claims for this transaction (app.jwt, which the editor's generated RBAC helpers read
-- too) and, on a connection that row-level security does not hold (a superuser, as in Dev, or the
-- tables' owner), switches to ml_app so it does. No SET clause on purpose: one would scope the
-- role change to the function.
CREATE OR REPLACE FUNCTION auth.sign_in(token text) RETURNS text
LANGUAGE plpgsql VOLATILE AS $f$
DECLARE c jsonb; unheld boolean;
BEGIN
  c := auth.read_session(token);
  IF c IS NULL THEN
    RAISE EXCEPTION 'invalid_session: sign in again' USING ERRCODE = '28000';
  END IF;
  PERFORM pg_catalog.set_config('app.jwt', c::text, true);
  SELECT r.rolsuper OR r.rolbypassrls INTO unheld FROM pg_catalog.pg_roles r WHERE r.rolname = current_user;
  IF NOT unheld THEN
    unheld := EXISTS (SELECT 1 FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                       WHERE n.nspname = 'public' AND t.relkind IN ('r', 'p') AND t.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user));
  END IF;
  IF unheld THEN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ml_app')
       OR NOT pg_catalog.pg_has_role(current_user, 'ml_app', 'MEMBER') THEN
      RAISE EXCEPTION 'magic_links: % is not held to row-level security, and there is no ml_app role it may run as', current_user;
    END IF;
    PERFORM pg_catalog.set_config('role', 'ml_app', true);
  END IF;
  RETURN c ->> 'email';
END $f$;

-- Code that must act for nobody in particular (a webhook, bookkeeping) on a published stage,
-- where the app's connection is held to row-level security: BEGIN; SELECT auth.as_system(); ...
CREATE OR REPLACE FUNCTION auth.as_system() RETURNS void
LANGUAGE sql VOLATILE AS $f$ SELECT pg_catalog.set_config('app.ml_system', 'on', true) $f$;

-- Dev's pick-your-user list. Refused on a live database.
CREATE OR REPLACE FUNCTION auth.simulated_users()
RETURNS TABLE (user_key text, email text, name text, roles text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public SET row_security = off AS $f$
BEGIN
  IF auth.is_live() THEN RAISE EXCEPTION 'magic_links: simulated users are refused on a live database'; END IF;
  RETURN QUERY
  SELECT ({{KEY_EXPR}})::text, lower(({{EMAIL_EXPR}})::text), ({{NAME_EXPR}})::text, ({{ROLES_EXPR}})
    FROM public.{{USERS_VIEW}} u
   WHERE ({{ACTIVE_EXPR}}) AND ({{EMAIL_EXPR}}) IS NOT NULL
   ORDER BY 4, 3, 2;
EXCEPTION WHEN undefined_table OR undefined_column THEN
  RETURN;
END $f$;

-- How many active people hold the admin role (the setup screen's "ready to publish").
CREATE OR REPLACE FUNCTION auth.admin_count() RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public SET row_security = off AS $f$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.{{USERS_VIEW}} u
   WHERE ({{ACTIVE_EXPR}}) AND EXISTS (SELECT 1 FROM unnest({{ROLES_EXPR}}) r WHERE lower(r) = lower({{ADMIN_ROLE}}));
  RETURN n;
EXCEPTION WHEN undefined_table OR undefined_column THEN
  RETURN 0;
END $f$;

-- ---------------------------------------------------------------- what policies read

CREATE OR REPLACE FUNCTION app.session() RETURNS jsonb
LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('app.jwt', true), '')::jsonb, '{}'::jsonb) $f$;

CREATE OR REPLACE FUNCTION app.is_signed_in() RETURNS boolean
LANGUAGE sql STABLE AS $f$ SELECT app.session() ? 'sub' $f$;

CREATE OR REPLACE FUNCTION app.user_key() RETURNS text
LANGUAGE sql STABLE AS $f$ SELECT nullif(app.session() ->> 'sub', '') $f$;

CREATE OR REPLACE FUNCTION app.jwt_email() RETURNS text
LANGUAGE sql STABLE AS $f$ SELECT nullif(app.session() ->> 'email', '') $f$;

CREATE OR REPLACE FUNCTION app.claim(p_name text) RETURNS text
LANGUAGE sql STABLE AS $f$ SELECT app.session() ->> p_name $f$;

CREATE OR REPLACE FUNCTION app.has_role(p_role text) RETURNS boolean
LANGUAGE sql STABLE AS $f$
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(app.session() -> 'roles', '[]'::jsonb)) r
                  WHERE lower(r) = lower(p_role))
$f$;

CREATE OR REPLACE FUNCTION app.is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $f$ SELECT app.has_role({{ADMIN_ROLE}}) $f$;

CREATE OR REPLACE FUNCTION app.is_system() RETURNS boolean
LANGUAGE sql STABLE AS $f$ SELECT coalesce(current_setting('app.ml_system', true), '') = 'on' $f$;
