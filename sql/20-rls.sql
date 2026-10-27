-- 20-rls.sql  (effortless-magic-links)
--
-- Makes the database enforce. Re-run after every `effortless build`, which
-- drops and recreates views and tables: server/install.js runs it on every boot.
--
--   * ml_app: the role every request runs as (SET LOCAL ROLE ml_app). Not the
--     table owner and not a superuser, so row-level security applies to it.
--   * every vw_* view becomes security_invoker, otherwise a view runs as its
--     OWNER and walks straight past the row-level security on its tables.
--   * every table gets ml_require_approved, a RESTRICTIVE policy: whatever other
--     policies say, a person who is not an approved, active user sees and writes
--     nothing. A project's own policies (owner = app.jwt_email() and the like)
--     can therefore never let a deactivated user keep working on a long-lived token.
--   * a table with no policy of its own also gets ml_allow_all (permissive, true),
--     so out of the box any approved person can do anything. The moment you write
--     a policy for the table (any name not starting ml_) that default steps aside,
--     so it never ORs a stricter policy of yours away.
--   * the users table: you see yourself, an admin sees and edits everyone.

DO $do$
DECLARE r record;
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'effortless-magic-links needs Postgres 15+ (security_invoker views); found %', current_setting('server_version');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ml_app') THEN
    CREATE ROLE ml_app NOLOGIN;
  END IF;
  EXECUTE format('GRANT ml_app TO %I', current_user);
  GRANT USAGE ON SCHEMA public TO ml_app;
  GRANT USAGE ON SCHEMA app TO ml_app;

  FOR r IN SELECT c.relname, c.relkind
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v') LOOP
    IF r.relkind = 'v' THEN
      EXECUTE format('GRANT SELECT ON public.%I TO ml_app', r.relname);
      EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', r.relname);
      CONTINUE;
    END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO ml_app', r.relname);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('DROP POLICY IF EXISTS ml_allow_approved ON public.%I', r.relname);   -- an earlier name
    EXECUTE format('DROP POLICY IF EXISTS ml_allow_all ON public.%I', r.relname);
    EXECUTE format('DROP POLICY IF EXISTS ml_require_approved ON public.%I', r.relname);
    EXECUTE format($p$CREATE POLICY ml_require_approved ON public.%I AS RESTRICTIVE FOR ALL TO ml_app
      USING ((SELECT app.is_approved())) WITH CHECK ((SELECT app.is_approved()))$p$, r.relname);
    EXECUTE format('DROP POLICY IF EXISTS ml_users_read ON public.%I', r.relname);
    EXECUTE format('DROP POLICY IF EXISTS ml_users_write ON public.%I', r.relname);

    IF r.relname = '{{TABLE}}' THEN
      EXECUTE format($p$CREATE POLICY ml_users_read ON public.%I FOR SELECT TO ml_app
        USING ((SELECT app.has_role('{{ADMIN}}')) OR lower({{EMAIL}}) = app.jwt_email())$p$, r.relname);
      EXECUTE format($p$CREATE POLICY ml_users_write ON public.%I FOR ALL TO ml_app
        USING ((SELECT app.has_role('{{ADMIN}}'))) WITH CHECK ((SELECT app.has_role('{{ADMIN}}')))$p$, r.relname);
    ELSIF NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE schemaname = 'public' AND tablename = r.relname AND policyname NOT LIKE 'ml\_%') THEN
      EXECUTE format($p$CREATE POLICY ml_allow_all ON public.%I FOR ALL TO ml_app USING (true) WITH CHECK (true)$p$, r.relname);
    END IF;
  END LOOP;

  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ml_app;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ml_app;
END $do$;
