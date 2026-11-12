# Taking sign-in out of a project (for the engine)

Taking it out makes every published stage a public demo again at its next publish: anyone with the
address reads and writes every row. Say that to the person in those words and get a yes first.

## 1. The app and the server

Remove `<ml-gate>` and the `magic-links-ui.js` script from `app/index.html` (put the persona
picker back if the app had one), and the `magicLinks(...)` lines from `server/src/server.js`.

Works when: the preview opens the app without asking who you are.

## 2. The rulebook

Delete the seed's block (from `-- >>> effortless-magic-links` to `-- <<< effortless-magic-links`)
in the two `ERBCustomizations` rows `02b-customize-functions.sql` and `04b-customize-policies.sql`;
delete a row that is empty after that. Keep the table of people: it is the project's data. Delete
`AppUsers` / `AppRoles` only if the seed added them AND the person says so.

Works when: no `ERBCustomizations` row contains `effortless-magic-links`.

## 3. The database

A rebuild recreates Dev's tables without the seed's policies. On a published stage the policies stay
until removed, and they refuse every request that has no session, so the next publish must drop
them: add, once, to the project's `04b-customize-policies.sql` row:

```sql
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'ml\_%' LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;
```

Publish each stage, then take that statement out again.

Works when: on each stage, `SELECT count(*) FROM pg_policies WHERE policyname LIKE 'ml\_%'` is 0
and the app answers without a session.

## 4. The folder

`rm -rf server/magic-links`, remove `pg` from `server/package.json` if nothing else uses it.

Works when: the project builds and its server starts.
