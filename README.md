# Magic Links Sign-in (`effortless-magic-links`)

An Effortless **add-in seed** (kind `child`), mounted at `magic-links/`. Requires the
`rulebook-backend` add-in. Drop it into a project and every generated route runs as the
signed-in person, with the **database** enforcing the rules.

| | Dev (default) | Beta / production |
|---|---|---|
| Who is signed in | A fake, trusted **global admin** token. The app pops over to **Pick your user**: choose any approved person and get the token a real sign-in would have given them | A real **magic link**: an emailed code from magiclink.effortlessapi.com |
| Who may sign in | Approved users only (`AppUsers`). No sign-up | Same |
| Row-level security | Enforced by Postgres on every request | Same, identically |
| The only difference | How the person is first identified | |

## What you get

- `AppUsers` rulebook table (`rulebook/`, merged with `scripts/merge-rulebook.mjs`): the approved people and their role.
- `sql/`: a **pure PL/pgSQL RS256 verifier** (`auth.set_jwt`, `app.jwt_email()`, `app.has_role()`, ...;
  no plpython, no extension), approved-user checks, and the RLS defaults.
- `server/`: `registerMagicLinks(app, { pool })` for the generated Express API. Zero runtime dependencies.
- `ui/`: `<ml-gate>`, `<ml-login>`, `<ml-pick-user>` and `<ml-admin>` (tenant, email branding, approved users). Plain custom elements.
- `INTEGRATE.md`: the ten-minute wiring, written for Claude to follow.

## Questions

| Key | Default | Used for |
|---|---|---|
| `magicLinkTenantId` | blank | `magic-links.config.json`. Blank in dev: the admin screen creates the tenant |
| `usersTable` | `app_users` | the table of approved people |
| `adminRole` | `admin` | the role that manages users and the tenant |

## How it is used

```bash
effortless cloneSeed effortlessapi/effortless-magic-links magic-links
rm -rf magic-links/.git
# then follow magic-links/INTEGRATE.md
```

## The rules it keeps

1. A verified email is a claim about an inbox, not an approval. Anyone can get one for their own address, so approval is a row in `AppUsers`, checked by the database on every request.
2. Roles come from `AppUsers`, never from token claims (a caller can ask magic-links to bake in any `additional_claims`).
3. Views run as their owner unless `security_invoker`: this seed sets it on every `vw_*` view, or RLS on the tables would be walked straight past.
4. A restrictive `ml_require_approved` policy on every table means a project's own policies can never keep a deactivated user working.
5. Dev keys are trusted only as a dev tenant: a live boot deletes them, and a database that has been live refuses them, and refuses dev mode, for good.
6. If live cannot start (no tenant), it does not start. It never falls back to dev.
