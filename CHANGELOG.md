# Changelog

## 2.0.0 (2026-11-11)

A rebuild around one chain: the email is proven by magic links, the person is found in the
project's own table, the project issues its own session, and every request runs inside
`auth.sign_in` in the database.

- **Mounted in the project's own server** (`server/magic-links`), not the generated API's
  `custom.js`: `magicLinks({ pool }).middleware`. Routes moved under `/api/auth/*` and
  `/api/magic-links/*`, so the app's existing `/api` proxy carries them.
- **The app's own session** (HS256, signed by a key of that database) replaces passing the
  magic-links token through. Claims: `sub`, `email`, `name`, `roles`, plus mapped `claims`.
- **The SQL lives in the rulebook** (two `ERBCustomizations` rows written by `install.mjs`), so it
  reaches published stages, where the app's connection cannot run DDL. The server no longer
  installs SQL at boot.
- **Maps onto the project's tables**: `usersTable`, `userKeyField`, `emailField`, `nameField`,
  `activeField` (with `!` for an inverted flag), `roleField`, `rolesTable`, `roleKeyField`,
  `userRolesTable` and its two fields, `claims`. `AppUsers` / `AppRoles` are added only when
  nothing maps.
- **`STAGE` picks the mode**; `NODE_ENV` and `EFFORTLESS_STAGE` and `ML_MODE` are not read.
- **Dev has no fake global admin**: pick-your-user lists real people only.
- The RS256 verifier in SQL, the dev key pair, and creating a tenant from the admin screen are gone
  (the platform mints tenants; elsewhere create one at magiclink.effortlessapi.com).
- New: `candidates.mjs`, `doctor.mjs`, `check-seed.mjs`, `settings-table.mjs`, the setup screen
  (`/api/magic-links/setup`), `UPGRADE.md`, `REMOVE.md`.

A project on 1.x must: move the wiring from `backend/api/custom.js` to `server/src/server.js`
(INTEGRATE.md, step 3), rewrite `magic-links.config.json` in rulebook names (`usersTable: AppUsers`,
not `app_users`), run `install.mjs --write`, and rebuild.

## 0.1.0 (2026-10-26)

First version: approved-user sign-in for the generated API's `custom.js`.
