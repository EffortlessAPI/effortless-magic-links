#!/usr/bin/env node
// Is the seed wired into this project? Prints what is done and what is missing, each with the fix.
// Offline: reads the files and the rulebook. The database's half is the setup screen
// (/api/magic-links/setup, GET /api/auth/setup), which the agent can also curl once signed in.
//
//   node server/magic-links/scripts/doctor.mjs [--rulebook <path>] [--json]
//
// Exit code 0 when every check passes, 1 otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_DIR, MANIFEST, loadConfig } from '../server/config.js';
import { plan } from './install.mjs';
import { args, rulebookPath, findProjectRoot, lower } from './lib.mjs';

const check = (id, ok, says, fix) => ({ id, ok: !!ok, says, ...(ok ? {} : { fix }) });

export function doctor({ rulebook: explicit, seedDir = SEED_DIR, cwd = process.cwd() } = {}) {
  const checks = [];
  let cfg = null;
  try { cfg = loadConfig(seedDir, {}); checks.push(check('config', true, 'magic-links.config.json reads, every setting known')); }
  catch (e) { checks.push(check('config', false, e.message, 'Fix magic-links.config.json: every key must be a setting declared in effortless-seed.json.')); }

  const file = rulebookPath(explicit, seedDir) || rulebookPath(explicit, cwd);
  const root = file ? (findProjectRoot(path.dirname(file)) || path.dirname(path.dirname(file))) : null;
  if (!file || !fs.existsSync(file)) {
    checks.push(check('rulebook', false, 'No rulebook found', 'Run inside the project, or pass --rulebook.'));
    return { ok: false, version: MANIFEST.seed.version, checks };
  }
  const rb = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (cfg) {
    const p = plan(rb, cfg);
    checks.push(check('mapping', !p.problems.length,
      p.problems.length ? `The mapping does not fit the rulebook: ${p.problems.join('; ')}` : `${cfg.usersTable} and every mapped field exist`,
      'Run candidates.mjs to see what the project has, then install.mjs --set ... (dry run, then --write).'));
    const rowsCurrent = !p.problems.length && !p.changes.some((c) => /ERBCustomizations/.test(c));
    checks.push(check('rows', rowsCurrent, rowsCurrent ? 'The seed\'s two ERBCustomizations rows are current with the config' : 'The seed\'s SQL rows are missing or out of date',
      'Run install.mjs --write, then rebuild.'));

    const users = rb[cfg.usersTable];
    if (users) {
      const isAdminRow = (r) => {
        const activeF = cfg.activeField.replace(/^!\s*/, '');
        const active = !activeF ? true : cfg.activeField.startsWith('!') ? r[activeF] !== true : r[activeF] !== false;
        if (!active || !r[cfg.emailField]) return false;
        if (cfg.roleField) return String(r[cfg.roleField] || '').split(',').map(lower).includes(lower(cfg.adminRole));
        if (cfg.userRolesTable && rb[cfg.userRolesTable]) {
          const key = r[cfg.userKeyField];
          return rb[cfg.userRolesTable].data.some((g) => lower(g[cfg.userRolesUserField]) === lower(key) && lower(g[cfg.userRolesRoleField]) === lower(cfg.adminRole));
        }
        return false;
      };
      const admins = users.data.filter(isAdminRow).map((r) => r[cfg.emailField]);
      checks.push(check('admin', admins.length, admins.length ? `Admin in the rulebook's data: ${admins.slice(0, 3).join(', ')}${admins.length > 3 ? '...' : ''}` : `Nobody active holds ${cfg.adminRole} in ${cfg.usersTable}'s data`,
        `Ask the person for the first admin's email, then install.mjs --person "email|Name|${cfg.adminRole}" --write. A published stage starts with the rulebook's people.`));
    }
  }

  // The project's server: the seed in front of everything else.
  const serverDir = path.resolve(seedDir, '..');
  const serverSrc = ['src/server.js', 'src/server.ts', 'server.js', 'index.js'].map((f) => path.join(serverDir, f)).find((f) => fs.existsSync(f));
  const src = serverSrc ? fs.readFileSync(serverSrc, 'utf8') : '';
  checks.push(check('server', /magicLinks\s*\(/.test(src) && /\.middleware/.test(src),
    serverSrc ? `${path.relative(root || cwd, serverSrc)} ${/magicLinks\s*\(/.test(src) ? 'calls magicLinks(...)' : 'does not call magicLinks(...) yet'}` : 'No server entry found next to the seed',
    'In server/src/server.js: import { magicLinks } from \'../magic-links/server/index.js\'; then app.use(magicLinks({ pool }).middleware) BEFORE the project\'s routes and toGeneratedApi (INTEGRATE.md, step 3).'));
  if (src) {
    const useAt = src.search(/app\.use\(\s*[\w.]*middleware/); const routesAt = src.search(/app\.use\(\s*['"]\/api['"]/);
    checks.push(check('order', useAt >= 0 && (routesAt < 0 || useAt < routesAt), 'The seed runs before the project\'s /api routes',
      'Move app.use(signIn.middleware) above app.use(\'/api\', ...): a route mounted first is answered without a session.'));
  }
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8')); } catch { /* none */ }
  checks.push(check('pg', !!(pkg.dependencies && pkg.dependencies.pg), 'server/package.json depends on pg', 'cd server && npm install pg (the seed itself has no dependencies).'));

  // The app: wrapped in the gate.
  const appIndex = root ? path.join(root, 'app', 'index.html') : null;
  const html = appIndex && fs.existsSync(appIndex) ? fs.readFileSync(appIndex, 'utf8') : '';
  const hasGate = /\/api\/magic-links\/ui\/magic-links-ui\.js/.test(html) && /<ml-gate/.test(html);
  checks.push(check('app', hasGate, appIndex ? (hasGate ? 'app/index.html loads the gate and wraps the app in <ml-gate>' : 'app/index.html does not load the gate yet') : 'No app/index.html (an app of its own: wire the gate by hand)',
    'In app/index.html: <script type="module" src="/api/magic-links/ui/magic-links-ui.js"></script> and wrap <div id="root"> in <ml-gate>...</ml-gate> (INTEGRATE.md, step 4).'));

  const tenant = cfg && cfg.tenantId;
  checks.push(check('tenant', true, tenant ? `tenantId ${tenant} in the config` : 'No tenantId in the config: on Effortless the platform sets MAGICLINK_TENANT_ID on every stage; elsewhere set tenantId before publishing'));
  return { ok: checks.every((c) => c.ok), version: MANIFEST.seed.version, checks };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = args();
  const out = doctor({ rulebook: a.value('--rulebook') });
  if (a.flag('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    for (const c of out.checks) console.log(`${c.ok ? 'ok  ' : 'FIX '} ${c.id}: ${c.says}${c.ok ? '' : `\n       -> ${c.fix}`}`);
    console.log(out.ok ? '\nEverything is wired. Open /api/magic-links/setup for the database\'s half.' : '\nNot done yet: fix the lines marked FIX, then run this again.');
  }
  process.exitCode = out.ok ? 0 : 1;
}
