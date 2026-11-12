# Sign-in with Magic Links (`effortless-magic-links`)

An Effortless **add-in seed**, free, mounted at `server/magic-links/` inside a project's own
server. Add it and only the people you approve get into the app, each as themselves, with the
**database** deciding what each one sees. Without it a published app is a public demo.

| | Dev (`STAGE` unset or `dev`) | A published stage (any other `STAGE`) |
|---|---|---|
| How a person gets in | **Pick your user**: any active person in the table of people, no code | Email, then the six-digit code (or the Sign in button) from magiclink.effortlessapi.com |
| What they get | The session a real sign-in gives that person, marked simulated | A session of this app's own |
| Who may get in | Active people in the project's table of people. No sign-up | Same |
| What they see | Row-level security, enforced by Postgres | Same, identically |

## How it works: proof, person, session, database

1. **Proof.** magiclink.effortlessapi.com answers one narrow question: did this email return the
   code within five minutes. Its token holds an email and nothing else (no users, no roles). The
   project's server checks it once (signature, tenant, expiry, address) and drops it.
2. **Person.** The server asks the database for that email in the project's own table of people
   (`auth.issue_session`). No row, or not active: no session. A code is never even sent to an
   address that has no row, and the answers never say who is approved.
3. **Session.** The database issues this app's own token: `sub` (the person's key), `email`,
   `name`, `roles`, and any claims you map from their row. It is signed (HS256) with a key that
   belongs to that one database and that no request can read, so a Dev session is worthless on
   Production. The browser holds it in an HttpOnly cookie on the app's own address.
4. **Database.** The server passes the session on to the generated API (`Authorization: Bearer`),
   which runs the request inside `BEGIN; SELECT auth.sign_in(session); ...; COMMIT`. `sign_in`
   checks the session, refuses someone deactivated since, keeps the claims for that transaction and
   makes sure row-level security holds the connection. The policies read `app.user_key()`,
   `app.has_role('x')`, `app.claim('company')`.

`auth.sign_in(token)` is the whole contract between the platform and a sign-in seed. Another way
to prove who someone is (Google, SSO, a passkey) is another seed with a different step 1.

## What you get

- `server/`: `magicLinks({ pool })`, one middleware for the project's Express server: `/api/auth/*`
  (session, sign-in, Dev's pick-your-user, the setup screen's data), `/api/magic-links/*` (the UI
  and the setup page), and a 401 for every protected path without a session. The generated API's
  schema and editor routes (`POST /api/tables`, `/api/admin/*`, `/api/save-changes`...) need the
  admin role. Zero dependencies (the project's server already has `pg`).
- `sql/`: the database half, which the install script writes into two rows of the rulebook's
  `ERBCustomizations` table, so it reaches Dev on every rebuild and every published stage on every
  publish: sessions (`auth.issue_session`, `auth.read_session`, `auth.sign_in`), the helpers policies
  read, and the policies (signed-in people only, everywhere; your own row of the people, admins all).
- `ui/`: `<ml-gate>` (wraps the app: pick-your-user in Dev, email and code on a stage, a corner badge
  once in) and `<ml-setup>` (the admin screen at `/api/magic-links/setup`: ready-to-publish checks
  with fixes, the people, the email tenant, the mapping). Plain custom elements.
- `scripts/`: `candidates.mjs` (which tables could hold the people), `install.mjs` (the rulebook
  change, dry run first), `doctor.mjs` (is it wired), `check-seed.mjs` (for the seed's author).
- `INTEGRATE.md`, `UPGRADE.md`, `REMOVE.md`: the engine's instructions, step by step, each step
  saying how to know it worked.

## It maps onto the project's own tables

The seed adds `AppUsers` and `AppRoles` **only when nothing in the project maps**. A project with
the editor's Users and roles module on maps to `ERBUsers` / `ERBRoles`; a kitchen maps to its
`Volunteers`; a SaaS to its `Members` with roles granted in their own table. The agent finds the
candidates (`candidates.mjs`), asks when two are close, and saves the answer in
`magic-links.config.json` (`install.mjs --set`).

## Settings

Every setting is declared once, in `effortless-seed.json`; this table is printed from it
(`node scripts/settings-table.mjs`). `magic-links.config.json` holds the project's answers.
Names are **rulebook** names (PascalCase); the seed works out what Postgres calls them.

| Setting | Default | Example | When | A change reaches | What it means |
|---|---|---|---|---|---|
| `usersTable` | `AppUsers` | `ERBUsers` | install | the SQL rows: re-run install.mjs, rebuild | The rulebook table that holds the people who may sign in. Mapped to one the project already has (ERBUsers when the editor's Users and roles module is on; Members, Staff, Volunteers...). AppUsers is added only when nothing maps. |
| `userKeyField` | `AppUserId` | `ERBUserId` | install | the SQL rows: re-run install.mjs, rebuild | The field that identifies a person (usually the table's first field). Becomes the session's sub, which policies read as app.user_key(). Blank: the email is the key. |
| `emailField` | `EmailAddress` | `WorkEmail` | install | the SQL rows: re-run install.mjs, rebuild | The field matched, case-blind, against the email a person proves. When two rows share an address, the active one wins. |
| `nameField` | `DisplayName` | `FullName` | any time | the SQL rows: re-run install.mjs, rebuild | Shown in the app and in Dev's pick-your-user list. Blank: the email. |
| `activeField` | `IsActive` | `!IsArchived` | any time | the SQL rows: re-run install.mjs, rebuild | A boolean: false keeps the row but stops the person at once, open sessions included. Start it with ! for a field that is true when the person is NOT allowed (!IsDisabled). Blank: every row is active. A status text field (Status = Active) is mapped through a calculated boolean field added to the rulebook, with the person's yes. |
| `roleField` | `AppRole` | `ERBRole` | install | the SQL rows: re-run install.mjs, rebuild | The field on the table of people holding the person's role: a link to the roles table, or text (comma-separate for several). Blank when roles come from a table that links people to roles (userRolesTable). |
| `rolesTable` | `AppRoles` | `ERBRoles` | install | the SQL rows: re-run install.mjs, rebuild | The table of roles, offered in the setup screen's pickers. AppRoles is added only when the project has none and the roles are not plain text. Blank: roles are plain text. |
| `roleKeyField` | `AppRoleId` | `ERBRoleId` | install | the server: restart it | The roles table's key: the value a person's role field holds, and the value the session's roles carry. |
| `userRolesTable` | (blank) | `UserRoles` | install | the SQL rows: re-run install.mjs, rebuild | Set when a person can hold several roles through a table of grants (the rulebook has no many-to-many). Blank: roleField. |
| `userRolesUserField` | (blank) | `EffortlessUser` | install | the SQL rows: re-run install.mjs, rebuild | On the people-to-roles table: the field pointing at the person (holds their key). |
| `userRolesRoleField` | (blank) | `Role` | install | the SQL rows: re-run install.mjs, rebuild | On the people-to-roles table: the field holding the role. |
| `adminRole` | `admin` | `owner` | install | the SQL rows: re-run install.mjs, rebuild | The role that may open the setup screen, manage people and use the generated API's schema routes. At least one active person must hold it before the first publish. |
| `sessionHours` | `8` | `720` | any time | the SQL rows: re-run install.mjs, rebuild | How long a session lasts before the person proves their email again. Deactivating someone stops their session at once whatever this says. |
| `claims` | (blank) | `company=CompanyName,region=Region` | any time | the SQL rows: re-run install.mjs, rebuild | More facts from the person's row carried in the session, claim=Field, comma-separated. Policies read them as app.claim('company'), the app from /api/auth/session. |
| `protect` | `/api` | `/api,/reports` | any time | the server: restart it | Path prefixes the project's server refuses (401) without a session, comma-separated. /api/auth and /api/magic-links are always open. |
| `publicPaths` | `/api/server/health` | `/api/server/health,/api/webhooks` | any time | the server: restart it | Path prefixes inside the protected ones that stay open (health checks, webhooks that sign their own requests), comma-separated. |
| `cookieName` | `ml_session` | `acme_session` | any time | the server: restart it | The HttpOnly cookie that holds the session on the app's own address. |
| `tenantId` | (blank) | `f3a1c2d4-...` | any time | the server: restart it | The project's tenant at magiclink.effortlessapi.com. Leave blank on Effortless: the platform mints one and sets MAGICLINK_TENANT_ID, which wins. Elsewhere, create one at magiclink.effortlessapi.com and put its id here. Public. |
| `magicLinkBaseUrl` | `https://magiclink.effortlessapi.com` | `https://magiclink.effortlessapi.com` | any time | the server: restart it | Where the tenant lives. MAGICLINK_BASE_URL in the environment wins. |

The environment wins for two: `MAGICLINK_TENANT_ID` (Effortless sets it on every published stage; on Dev it sets `MAGICLINK_MANAGED`, which says the tenant is the platform's) and
`MAGICLINK_BASE_URL`. `STAGE` picks the front door. `NODE_ENV` is not read: Dev's runner runs
with `NODE_ENV=production`.

## Using it

On Effortless: add it from the Publish tab's Access choice, or from the seed library; the platform
mints the tenant and hands the agent `INTEGRATE.md`. By hand:

```bash
cd <project root>                      # has server/ (the project's own server) and effortless-rulebook/
effortless cloneSeed effortlessapi/effortless-magic-links server/magic-links
rm -rf server/magic-links/.git
# then follow server/magic-links/INTEGRATE.md
```

## The rules it keeps

1. A proven email is a claim about an inbox, not an approval. Approval is an active row in the
   project's table of people, checked by the database on every request.
2. Roles come from the project's tables, never from a token someone else issued.
3. Every `vw_*` view runs as the caller (`security_invoker`), or it would walk past row-level security.
4. `ml_require_signed_in` is RESTRICTIVE on every table: whatever a project's policies say, nobody
   who is not signed in reads or writes a row. A table with no policy of the project's own is open
   to everyone signed in (`ml_allow_all`) until the project writes one; then the default steps aside.
5. A published stage never simulates. If it cannot do real sign-in (no tenant) it does not start,
   and a database that has once run live refuses simulated sessions for good.
6. Anything holding the database connection is trusted (the project's server, the generated API).
   The browser never holds it. System code that must act for nobody in particular runs inside
   `auth.as_system()`.

## Tests

`npm test` needs a Postgres 15+ it may create databases and roles in, at `ML_TEST_PG`
(default `postgres://postgres@localhost:54329/postgres`; a throwaway one:
`initdb -D /tmp/mlpg -U postgres -A trust && pg_ctl -D /tmp/mlpg -o "-p 54329" start`).
The database tests build a stage the way bases does (an owner that runs the release, an app role
held to row-level security) and a Dev database (a superuser), then run sessions, policies and the
mapping against three different projects. The server tests run the project's server with a
stand-in generated API and a stand-in magiclink that signs real RS256 tokens. The script tests run
the agent's tools against rulebooks that are ambiguous on purpose.
