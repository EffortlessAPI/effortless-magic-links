-- The database enforces (effortless-magic-links). Becomes the seed's block in the project's
-- ERBCustomizations row "04b-customize-policies.sql": Dev runs it after every rebuild (the build
-- seeds postgres/04b-customize-policies.sql from the row) and every published stage runs it on
-- every publish (update-effortless-schema.sql, section 9, as the database owner), so policies a
-- rebuild drops come straight back. Idempotent.
--
--   * Policies apply to every role that is not the tables' owner or a superuser: on a published
--     stage that is the app's own connection (<database>_app); in Dev, where the API connects as a
--     superuser, auth.sign_in switches to ml_app, made here when this connection may make roles.
--   * every table gets ml_require_signed_in, RESTRICTIVE: whatever else a policy says, nobody who
--     is not signed in (or system code, auth.as_system) reads or writes a row.
--   * a table with no policy of the project's own also gets ml_allow_all, so out of the box any
--     signed-in person can do anything. The moment the project writes a policy for a table (any
--     name not starting ml_), that default steps aside and never ORs the stricter rule away.
--     (effortless_app_all, the platform's own default for the app role, is not the project's.)
--   * the people: you read your own row, an admin reads and changes everyone. The roles: anyone
--     signed in reads them, an admin changes them.
--   * every vw_* view runs as the caller (security_invoker), or it would walk past all of this.

DO $ml$
DECLARE r record; is_super boolean;
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'effortless-magic-links needs Postgres 15+ (security_invoker views); found %', current_setting('server_version');
  END IF;

  SELECT rolsuper INTO is_super FROM pg_roles WHERE rolname = current_user;
  IF is_super AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ml_app') THEN
    CREATE ROLE ml_app NOLOGIN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ml_app') AND is_super THEN
    GRANT USAGE ON SCHEMA public, app, auth TO ml_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ml_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ml_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ml_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ml_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ml_app;
  END IF;

  FOR r IN SELECT c.relname, c.relkind
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v') LOOP
    IF r.relkind = 'v' THEN
      EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', r.relname);
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('DROP POLICY IF EXISTS ml_require_signed_in ON public.%I', r.relname);
    EXECUTE format('DROP POLICY IF EXISTS ml_allow_all ON public.%I', r.relname);
    EXECUTE format('DROP POLICY IF EXISTS ml_people_read ON public.%I', r.relname);
    EXECUTE format('DROP POLICY IF EXISTS ml_people_write ON public.%I', r.relname);
    EXECUTE format('DROP POLICY IF EXISTS ml_roles_read ON public.%I', r.relname);
    EXECUTE format('DROP POLICY IF EXISTS ml_roles_write ON public.%I', r.relname);

    EXECUTE format($p$CREATE POLICY ml_require_signed_in ON public.%I AS RESTRICTIVE FOR ALL
      USING ((SELECT app.is_system() OR app.is_signed_in()))
      WITH CHECK ((SELECT app.is_system() OR app.is_signed_in()))$p$, r.relname);

    IF r.relname = {{USERS_TABLE_LITERAL}} THEN
      EXECUTE format($p$CREATE POLICY ml_people_read ON public.%I FOR SELECT
        USING ((SELECT app.is_system() OR app.is_admin()) OR ({{OWN_ROW_EXPR}}))$p$, r.relname);
      EXECUTE format($p$CREATE POLICY ml_people_write ON public.%I FOR ALL
        USING ((SELECT app.is_system() OR app.is_admin()))
        WITH CHECK ((SELECT app.is_system() OR app.is_admin()))$p$, r.relname);
    ELSIF r.relname = {{LINK_TABLE_LITERAL}} THEN
      EXECUTE format($p$CREATE POLICY ml_people_read ON public.%I FOR SELECT
        USING ((SELECT app.is_system() OR app.is_admin()) OR ({{OWN_LINK_EXPR}}))$p$, r.relname);
      EXECUTE format($p$CREATE POLICY ml_people_write ON public.%I FOR ALL
        USING ((SELECT app.is_system() OR app.is_admin()))
        WITH CHECK ((SELECT app.is_system() OR app.is_admin()))$p$, r.relname);
    ELSIF r.relname = {{ROLES_TABLE_LITERAL}} THEN
      EXECUTE format('CREATE POLICY ml_roles_read ON public.%I FOR SELECT USING (true)', r.relname);
      EXECUTE format($p$CREATE POLICY ml_roles_write ON public.%I FOR ALL
        USING ((SELECT app.is_system() OR app.is_admin()))
        WITH CHECK ((SELECT app.is_system() OR app.is_admin()))$p$, r.relname);
    ELSIF NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE schemaname = 'public' AND tablename = r.relname
                         AND policyname NOT LIKE 'ml\_%' AND policyname <> 'effortless_app_all') THEN
      EXECUTE format('CREATE POLICY ml_allow_all ON public.%I FOR ALL USING (true) WITH CHECK (true)', r.relname);
    END IF;
  END LOOP;
END $ml$;
