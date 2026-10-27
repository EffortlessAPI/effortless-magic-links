# Integrating this seed (for Claude, or anyone with ten minutes)

You are in `magic-links/` inside a project that already has the **Backend API** add-in
(`backend/api` with `custom.js`, `backend/postgres`). Do these in order. Each step says how
to know it worked. Nothing here needs a network call in dev.

## 0. Ask the person two things, then do the rest without asking

1. "Which email addresses are approved to start with?" (they become `admin` rows in `AppUsers`;
   at least one is needed before beta or production, because there is no sign-up)
2. Nothing else. Roles beyond `admin` are added later, in the admin screen.

## 1. The approved-users table (the rulebook)

```bash
node magic-links/scripts/merge-rulebook.mjs --rulebook effortless-rulebook/effortless-rulebook.json \
     --admin ann@example.com --admin bob@example.com          # dry run: shows what it adds
# editing the rulebook is a change to the project's source of truth: say what it adds, then --write
node magic-links/scripts/merge-rulebook.mjs ... --write
effortless build            # in the project root; regenerates app_users + vw_app_users
```

If the project already has a users table, skip this and set `usersTable`, `usersView`,
`emailColumn`, `roleColumn`, `activeColumn` (and `userKeyColumn: ""` if it has no separate key)
in `magic-links/magic-links.config.json`. Do **not** create `app.app_users` by hand.

Works when: `select * from vw_app_users` lists the admins.

## 2. The API (one edit, in the file rebuilds never overwrite)

In `backend/api/custom.js`, add the import at the top and the call as the first line of
`registerCustom(app)`:

```js
import { registerMagicLinks } from '../../magic-links/server/index.js';
import { pool } from './db.js';
// ...
export default function registerCustom(app) {
  registerMagicLinks(app, { pool });
  // ...whatever was already here
```

Restart the API. Works when the log says `magic-links: dev mode ready` and
`curl localhost:<port>/auth/session` returns `"mode":"dev","devAdmin":true`.

## 3. The app

- Dev proxy: forward `/auth` and `/magic-links` to the API next to `/api` (Vite `server.proxy`).
  Keep the app and the API on ONE origin: the session is an HttpOnly cookie, and the generated
  API's `Access-Control-Allow-Origin: *` cannot carry credentials across origins.
- Load `/magic-links/ui/magic-links-ui.js` and wrap the whole app in `<ml-gate>`.
  Dev shows **pick your user**; live shows the email-code sign-in. Nothing else in the app changes.
- Add `<ml-admin>` to the app's admin area, only for `session.admin` (the gate fires a
  `ml-session` event on `document`). It manages the tenant, the email branding and the approved users.
- Old Bearer-token callers keep working: the API accepts `Authorization: Bearer <jwt>` as well as the cookie.

Works when: opening the app shows "Pick your user"; choosing someone shows their email in the
corner badge and `GET /api/...` returns what THEY may see.

## 4. Your rules (row-level security)

Out of the box any approved person can do anything. Add real rules as ordinary policies,
**`TO ml_app`**, reading `app.jwt_email()` and `app.has_role('x')`:

```sql
CREATE POLICY orders_own ON orders FOR ALL TO ml_app
  USING (app.has_role('admin') OR customer_email = app.jwt_email())
  WITH CHECK (app.has_role('admin') OR customer_email = app.jwt_email());
```

Put them in the project's SQL customization (`ERBCustomizations` or a `*b-customize-*` file) so
a rebuild keeps them; the API re-applies this seed's defaults on every boot, and the allow-all
default steps aside on any table that has a policy of yours. `ml_require_approved` (restrictive) stays
on every table: whatever your policies say, a person who is not an approved, active user gets nothing.

Works when: pick a member, fetch a table you restricted, see only their rows; try a write to
someone else's row and get `violates row-level security policy`.

## 5. Publishing to beta or production

Nothing to switch in code. The stage's environment decides: `NODE_ENV=production` or
`EFFORTLESS_STAGE=beta|production` means **live**. Before the first publish:

1. In dev, open the admin screen, "Magic-link tenant": sign in with your developer email,
   **Create tenant**, set the branding. It writes `magic-links/magic-links.config.json`
   (public values only). **Commit that file.**
2. The published database needs its admin rows: `AppUsers` data travels with the rulebook, so
   the `--admin` rows from step 1 are already there. Check `select * from vw_app_users` on the new stage.
3. Publish. On boot the API fetches the tenant's PUBLIC key, trusts it, deletes every dev key from that
   database and marks it live forever. It refuses to start if there is no tenant: it never falls back to dev.

Works when: `/auth/session` says `"mode":"live"`, `/auth/dev/users` is a 404, a code arrives for
an approved address and does not for a stranger.

## What not to do

- Don't read roles from the token (`additional_claims` are whatever the caller asked magic-links to
  bake in). Roles come from `AppUsers`; `app.has_role()` already does that.
- Don't `GRANT` anything to `ml_app` yourself, and don't connect the browser to Postgres: the
  guarantee is "every request through this API runs as the person". It is not a defence against SQL
  injection in your own API (that code could `RESET ROLE`).
- Don't call `pool.connect()` inside a route: it would skip row-level security, so the seed throws.
  Use `pool.query`. Editor routes that must change the schema (DDL, Save) are listed in
  `systemPaths` in the config: admin-only, run unscoped.
- Don't edit `sql/` to add a table's policy. Add the policy to the project's own SQL.

## Tests

`npm install && npm test` in this folder (needs a Postgres 15+ it can create databases in:
`ML_TEST_PG=postgres://user@host:port/postgres`). 16 tests, including a mutation check
that the approval gate is what keeps a deactivated user out.
