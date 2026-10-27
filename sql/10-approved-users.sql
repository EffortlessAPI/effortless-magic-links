-- 10-approved-users.sql  (effortless-magic-links)
--
-- "Approved users, no registration." A verified email is only a claim that the
-- holder reads that inbox: ANYONE can get one for their own address from a
-- magic-link tenant. What lets a person in is a row in the project's users
-- table, and the database checks it on every request.
--
-- Roles come from that table, never from a token claim: a client can ask the
-- tenant to bake any `additional_claims` it likes into its own token.
--
-- Placeholders ({{...}}) are filled by server/install.js from magic-links.config.json.

-- One row from the users view: role + whether the person is active. Late-bound,
-- so a project that has not built its users table yet still installs.
CREATE OR REPLACE FUNCTION app.ml_lookup(p_email text, OUT p_role text, OUT p_active boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public SET row_security = off AS $f$
BEGIN
  SELECT {{ROLE_EXPR}}, {{ACTIVE_EXPR}} INTO p_role, p_active
    FROM public.{{VIEW}} WHERE lower({{EMAIL}}) = lower(p_email) LIMIT 1;
  IF NOT FOUND THEN p_role := NULL; p_active := false; END IF;
EXCEPTION WHEN undefined_table OR undefined_column THEN
  p_role := NULL; p_active := false;
END $f$;

-- For the server's pre-check, before any token exists (never issue a code to a stranger).
CREATE OR REPLACE FUNCTION app.ml_is_email_approved(p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  SELECT coalesce((SELECT p_active FROM app.ml_lookup(p_email)), false)
$f$;

CREATE OR REPLACE FUNCTION app.ml_role_of(p_email text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  SELECT CASE WHEN p_active THEN p_role END FROM app.ml_lookup(p_email)
$f$;

CREATE OR REPLACE FUNCTION app.jwt_role() RETURNS text
LANGUAGE sql STABLE AS $f$
  SELECT CASE
    WHEN app.jwt_email() IS NULL THEN NULL
    WHEN app.jwt_is_dev_admin()  THEN '{{ADMIN}}'
    ELSE app.ml_role_of(app.jwt_email())
  END
$f$;

-- Roles may be a comma-separated list ("admin,reviewer").
CREATE OR REPLACE FUNCTION app.has_role(p_role text) RETURNS boolean
LANGUAGE sql STABLE AS $f$
  SELECT p_role IS NOT NULL AND lower(p_role) = ANY (
    string_to_array(replace(lower(coalesce(app.jwt_role(), '')), ' ', ''), ','))
$f$;

-- The one question the default policy asks: is this a signed-in, approved, active person?
CREATE OR REPLACE FUNCTION app.is_approved() RETURNS boolean
LANGUAGE sql STABLE AS $f$
  SELECT app.jwt_email() IS NOT NULL
     AND (app.jwt_is_dev_admin() OR app.ml_role_of(app.jwt_email()) IS NOT NULL)
$f$;
