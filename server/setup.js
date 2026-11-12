// What the setup screen shows: the mapping, and every check that must pass before a publish, each
// with what to do when it does not. The offline half (rulebook, files) is scripts/doctor.mjs.
import { SETTINGS } from './config.js';

const check = (id, ok, says, fix) => ({ id, ok: !!ok, says, ...(ok ? {} : { fix }) });

export async function setupReport(ctx, req) {
  const { cfg, mode, names, pool, tenant, apiUrl, env } = ctx;
  const checks = [];

  const columns = async (relation) => new Set((await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [relation])).rows.map((r) => r.column_name));

  // The people view and the mapped columns, as Postgres holds them.
  const view = await columns(names.usersView);
  const wanted = [['userKeyField', names.key], ['emailField', names.email], ['nameField', names.name],
    ['activeField', names.active?.column], ['roleField', names.role]].filter(([, c]) => c);
  const missing = wanted.filter(([, c]) => !view.has(c));
  checks.push(check('people', view.size && !missing.length,
    view.size ? `${cfg.usersTable} (${names.usersView}) has every mapped field` : `${cfg.usersTable} is not in the database (${names.usersView})`,
    view.size ? `Missing in ${names.usersView}: ${missing.map(([k, c]) => `${k} -> ${c}`).join(', ')}. Fix the mapping in magic-links.config.json, run install.mjs --write, rebuild.`
      : `Map usersTable to the project's table of people (scripts/candidates.mjs lists them), or add AppUsers (install.mjs --add-users-table), then rebuild.`));
  if (names.linkView) {
    const link = await columns(names.linkView);
    checks.push(check('grants', link.has(names.linkUser) && link.has(names.linkRole), `${cfg.userRolesTable} links people to roles`,
      `${names.linkView} needs ${names.linkUser} and ${names.linkRole}. Fix userRolesUserField / userRolesRoleField.`));
  }

  // The database: the seed's SQL is built in, a session can be checked, the policies are there.
  const db = (await pool.query(`SELECT to_regprocedure('auth.sign_in(text)') IS NOT NULL AS fn,
      EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 AND policyname = 'ml_require_signed_in') AS pol,
      (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS unheld,
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ml_app') AS ml_app`, [names.usersTable])).rows[0];
  checks.push(check('sql', db.fn, 'The database has the seed\'s functions (auth.sign_in)', 'Run install.mjs --write and rebuild: the ERBCustomizations 02b row is not built in.'));
  checks.push(check('policies', db.pol, `Row-level security is on for ${cfg.usersTable}`, 'Run install.mjs --write and rebuild: the ERBCustomizations 04b row is not built in.'));
  checks.push(check('held', !db.unheld || db.ml_app,
    db.unheld ? 'Requests switch to ml_app, which row-level security holds' : 'This connection is held to row-level security',
    'This connection bypasses row-level security and there is no ml_app role: connect as the app role, or rebuild as a superuser so the 04b row can make ml_app.'));

  const admins = db.fn ? (await pool.query('SELECT auth.admin_count() AS n')).rows[0].n : 0;
  checks.push(check('admin', admins > 0, `${admins} active ${admins === 1 ? 'person holds' : 'people hold'} the ${cfg.adminRole} role`,
    `Give at least one active person the ${cfg.adminRole} role in ${cfg.usersTable}, in the rulebook's data, before publishing.`));

  // The generated API runs a request with a session inside auth.sign_in: then a forged session is
  // refused. An API from before that change ignores the header and answers 200.
  let api = { ok: false, says: 'The generated API did not answer' };
  try {
    const r = await fetch(`${apiUrl}/api/tables/${encodeURIComponent(cfg.usersTable)}?fields=${encodeURIComponent(cfg.userKeyField || cfg.emailField)}`,
      { headers: { authorization: 'Bearer aaaa.bbbb.cccc' } });
    api = r.status === 401 || r.status === 403
      ? { ok: true, says: 'The generated API runs every request as the signed-in person' }
      : { ok: false, says: `The generated API ignores sessions (a forged one got ${r.status}): rows are not filtered per person yet` };
  } catch (e) { api.says += ` (${e.message})`; }
  checks.push(check('api', api.ok, api.says, 'Rebuild with a rulebook-to-node-postgres-api that supports sessions (it runs Bearer requests in auth.sign_in).'));

  // The tenant: what a published stage needs.
  let tenantInfo = null;
  if (tenant.configured()) {
    try { const t = await tenant.info(); tenantInfo = { id: cfg.tenantId, name: t.display_name || null, fromEmail: t.from_email || null }; }
    catch (e) { tenantInfo = { id: cfg.tenantId, error: e.message }; }
  }
  checks.push(check('tenant', tenantInfo && !tenantInfo.error,
    tenantInfo ? (tenantInfo.error ? `Tenant ${cfg.tenantId} did not answer: ${tenantInfo.error}` : `Codes come from tenant ${cfg.tenantId}`) : 'No magic-link tenant yet',
    env.MAGICLINK_TENANT_ID ? 'The platform\'s tenant did not answer; try again shortly.'
      : 'On Effortless the platform mints one when the seed is added (MAGICLINK_TENANT_ID). Elsewhere create one at magiclink.effortlessapi.com and set tenantId.'));

  return {
    mode, stage: env.STAGE || 'dev',
    you: { email: req.signIn.claims.email, roles: req.signIn.claims.roles },
    readyToPublish: checks.filter((c) => ['people', 'sql', 'policies', 'admin', 'tenant'].includes(c.id)).every((c) => c.ok),
    checks,
    tenant: tenantInfo, tenantManaged: !!env.MAGICLINK_TENANT_ID,
    mapping: SETTINGS.filter((s) => s.affects === 'rulebook' || ['roleKeyField', 'adminRole'].includes(s.key)).map((s) => ({
      key: s.key, label: s.label, value: typeof cfg[s.key] === 'object' ? JSON.stringify(cfg[s.key]) : String(cfg[s.key]), description: s.description,
    })),
    people: {
      table: cfg.usersTable, key: cfg.userKeyField, email: cfg.emailField, name: cfg.nameField,
      active: cfg.activeField, role: cfg.roleField, rolesTable: cfg.rolesTable, roleKey: cfg.roleKeyField,
      grants: cfg.userRolesTable || null,
    },
  };
}
