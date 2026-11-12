# Integrating sign-in (for the engine: the agent working in the project)

You are in a project with `effortless-rulebook/`, its own `server/` (Express, from the Loops
template: `server/src/server.js`, `server/src/generated-api.js`) and an app in `app/`. The seed is
in `server/magic-links/`. Do the steps in order; each ends with how to know it worked. Every
command runs from the project root.

**What to ask the person, and only this:** which table holds the people who sign in, when step 1
does not make it clear; and the first admin's email (and name), if you do not already know it.
Everything else you work out. Say what each rulebook change adds before you write it.

**On Effortless** the platform has already minted the project's magic-link tenant and gives every
stage `MAGICLINK_TENANT_ID`; there is nothing to create. The message that sent you here may carry
answers already (the admin's email, the table); use them.

## 1. Find where the people live

```bash
node server/magic-links/scripts/candidates.mjs
```

It ranks the tables that could hold the people (those with an email field), says why, and lists
its doubts. Decide:

- **One clear table** (the editor's `ERBUsers`, or one domain table like `Volunteers`): use its
  mapping line.
- **A close call** (two tables of people, a role on the row AND a grants table, two email fields):
  ask the person, in one sentence naming the choices. Do not guess.
- **No table with an email:** the seed adds `AppUsers` and `AppRoles` (step 2, the two `--add-...`
  flags). Say so first: it is two new tables in their rulebook.
- **A status text instead of an active flag** (`Status = "Active"`): ask whether to add a calculated
  boolean field (`IsActive = {{Status}} = "Active"`) and map `activeField` to it, or to leave
  `activeField` blank (every row can sign in). An inverted flag (`IsArchived`) maps as `!IsArchived`.
- **No role anywhere:** say that nobody will be admin, and ask before adding a role field.

Works when: you can name usersTable, emailField, and where the roles come from (a role field, a
grants table, or none), and the person agreed to anything ambiguous.

## 2. Write the mapping and the SQL into the rulebook

Dry run first, with the mapping from step 1 and the first admin:

```bash
node server/magic-links/scripts/install.mjs --set usersTable=Volunteers --set userKeyField=VolunteerId \
     --set nameField=FullName --set roleField=Role --set rolesTable= --set roleKeyField= \
     --person "olive@kitchen.test|Olive Owner|admin"
```

(or, with nothing to map: `--add-users-table --add-roles-table --person "you@x.com|You|admin"`.)
It prints every change, one line each. Tell the person what it adds to their rulebook (the two
`ERBCustomizations` rows are the database's sign-in rules; the person row is their first admin),
then run the same command with `--write`. A PROBLEM line names what is wrong and what the table
does have; fix the `--set` and run it again.

Works when: the dry run lists the changes with no PROBLEM line, and the `--write` run prints the
same list and exits 0. Running it again says "Nothing to change".

## 3. Put the seed in front of the project's server

In `server/package.json` add `pg` (`cd server && npm install pg`). In `server/src/server.js`,
ABOVE `app.use('/api', routes)`:

```js
import pg from 'pg';
import { magicLinks } from '../magic-links/server/index.js';

const signIn = magicLinks({ pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }) });
app.use(signIn.middleware);
```

Project routes that need the person read `req.signIn.claims` (`sub`, `email`, `roles`, your
claims). Code that writes the database itself uses `signIn.asCaller(token, sql, params)` (as the
person) or `signIn.asSystem(sql, params)` (a webhook, bookkeeping), never the pool bare: on a
published stage the bare connection is held to row-level security and sees nothing.

Works when: after a rebuild (step 5) `curl -s localhost:<server port>/api/auth/session` answers
`"mode":"dev"` and `/api/tables/<any table>` answers 401 `sign_in_required`.

## 4. Wrap the app in the gate

In `app/index.html`, load the UI and wrap the root:

```html
<script type="module" src="/api/magic-links/ui/magic-links-ui.js"></script>
...
<ml-gate><div id="root"></div></ml-gate>
```

The app's own calls need no change: they are same-origin, so the session cookie goes with them.
The persona picker becomes who is signed in: read `window.mlSession` (or listen for the
`ml-session` event on `document`) and show each persona's routes to the people whose `roles`
include it. Map each persona to a role of the roles table, and give each role at least one sample
person in the rulebook's data, so Dev's pick-your-user list shows one of each. Keep a way to the
setup screen for admins (`window.mlSession.admin`, link `/api/magic-links/setup`).

Works when: opening the preview shows "Pick who you are" with the people from the table; picking
one shows the app with their name in the corner, and the data is what their role may see.

## 5. Rebuild, then check

Rebuild (the editor's Rebuild, or `effortless build` and a restart of the backend) so the two rows
become SQL in the database. Then:

```bash
node server/magic-links/scripts/doctor.mjs
```

and, signed in as an admin, open `/api/magic-links/setup` (or `curl` `GET /api/auth/setup` with the
session cookie): every check there should be green, each red one says what to do. The `api` check
is red while the generated API does not yet run requests inside `auth.sign_in`; tell the person
plainly that rows are not filtered per person until it does.

Works when: the doctor prints "Everything is wired" and the setup screen says "Ready to publish".

## 6. Your own rules (optional)

Out of the box everyone signed in can read and write every table except the people (each sees
their own row; admins all). A rule of the project's own is a policy in the project's
`04b-customize-policies.sql` row, AHEAD of the seed's block (install.mjs keeps its block last):

```sql
CREATE POLICY own_shifts ON shifts FOR ALL
  USING (app.is_admin() OR volunteer = app.user_key())
  WITH CHECK (app.is_admin() OR volunteer = app.user_key());
```

The moment a table has a policy of the project's own, the seed's allow-all steps aside on it. The
restrictive "signed in" rule stays whatever you write. Helpers: `app.user_key()`, `app.jwt_email()`,
`app.has_role('x')`, `app.is_admin()`, `app.claim('company')`, `app.session()`.

Works when: signed in (Dev's picker) as a non-admin, the table shows only their rows; a write to
someone else's row is refused (`row-level security`).

## 7. Publishing

Nothing to switch. On a published stage `STAGE` is `beta` or `production`, so the seed runs real
sign-in: the database is marked live on first start, simulated sessions stop working there for
good, and the stage's people are the rulebook's data at the first publish (later, that stage's
admins manage them in the setup screen; Dev's rows reach it only by a data migration).

**The Sign in button in the code email** opens the tenant's sign-in link (`login_url`) with
`?ml=<token>&email=<address>`; `<ml-gate>` on any page of the app swaps it for a session. On
Effortless the platform sets that link to the Production address; with a tenant of your own, set it
in the setup screen ("Sign-in link"). The code in the same email works either way.

Works when: on the stage, `/api/auth/session` says `"mode":"live"`, `/api/auth/simulated/users` is a
404, a code arrives for an approved address and not for a stranger.

## What not to do

- Do not add `AppUsers` or `AppRoles` when the project already has people or roles. Map them.
- Do not edit the SQL between the seed's markers in the `ERBCustomizations` rows, or Dev's seeded
  `postgres/02b-*.sql` / `04b-*.sql` copies: change `magic-links.config.json` (install.mjs `--set`)
  and re-run install.mjs. It deletes Dev's stale copies itself.
- Do not query the database from the project's server with the bare pool inside a request.
- Do not put a tenant key, a session or a password anywhere in the repo. The config holds public
  values only.
