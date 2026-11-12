// The settings: every one is declared in effortless-seed.json (`replacements`), with its default,
// description and example. magic-links.config.json holds the project's answers (PUBLIC values
// only); the environment overrides two of them. No secret lives in either file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'effortless-seed.json'), 'utf8'));
export const SETTINGS = MANIFEST.replacements;

const RULEBOOK_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ROLE = /^[A-Za-z0-9_.-]+$/;
const NAME_SETTINGS = ['usersTable', 'userKeyField', 'emailField', 'nameField', 'roleField', 'rolesTable', 'roleKeyField',
  'userRolesTable', 'userRolesUserField', 'userRolesRoleField'];

// A question the CLI has not answered still reads "$usersTable$".
export const unanswered = (v) => typeof v === 'string' && /\$[A-Za-z][A-Za-z0-9-]*\$/.test(v);

const coerce = (setting, v) => {
  if (setting.valueType === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`magic-links: ${setting.key} must be a positive number, got "${v}"`);
    return n;
  }
  if (setting.valueType === 'list') {
    return (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean);
  }
  if (setting.valueType === 'map') {
    if (v && typeof v === 'object' && !Array.isArray(v)) return { ...v };
    const out = {};
    for (const pair of String(v || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const [k, f] = pair.split('=').map((s) => (s || '').trim());
      if (!k || !f) throw new Error(`magic-links: ${setting.key} entries are claim=Field, got "${pair}"`);
      out[k] = f;
    }
    return out;
  }
  return String(v ?? '').trim();
};

export const configPath = (dir = SEED_DIR) => path.join(dir, 'magic-links.config.json');

/** The settings as the server and the scripts use them: defaults, then the file, then the environment. */
export function loadConfig(dir = SEED_DIR, env = process.env) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(configPath(dir), 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`magic-links: ${configPath(dir)} is not valid JSON (${e.message})`);
  }
  const unknown = Object.keys(file).filter((k) => !SETTINGS.some((s) => s.key === k));
  if (unknown.length) throw new Error(`magic-links: unknown setting(s) in magic-links.config.json: ${unknown.join(', ')} (every setting is declared in effortless-seed.json)`);

  const cfg = {};
  for (const s of SETTINGS) {
    const v = s.key in file && !unanswered(file[s.key]) ? file[s.key] : s.default;
    cfg[s.key] = coerce(s, v);
  }
  if (env.MAGICLINK_TENANT_ID) cfg.tenantId = String(env.MAGICLINK_TENANT_ID).trim();
  if (env.MAGICLINK_BASE_URL) cfg.magicLinkBaseUrl = String(env.MAGICLINK_BASE_URL).trim();
  cfg.magicLinkBaseUrl = cfg.magicLinkBaseUrl.replace(/\/+$/, '');
  validate(cfg);
  return cfg;
}

export function validate(cfg) {
  for (const k of NAME_SETTINGS) {
    if (cfg[k] && !RULEBOOK_NAME.test(cfg[k])) throw new Error(`magic-links: ${k} must be a rulebook name (letters, digits, _), got "${cfg[k]}"`);
  }
  const active = cfg.activeField.replace(/^!\s*/, '');
  if (active && !RULEBOOK_NAME.test(active)) throw new Error(`magic-links: activeField must be a rulebook field name, optionally starting with !, got "${cfg.activeField}"`);
  for (const f of Object.values(cfg.claims)) {
    if (!RULEBOOK_NAME.test(f)) throw new Error(`magic-links: claims must map to rulebook field names, got "${f}"`);
  }
  for (const k of Object.keys(cfg.claims)) {
    if (['sub', 'email', 'name', 'roles', 'role', 'iat', 'exp', 'iss', 'simulated'].includes(k)) {
      throw new Error(`magic-links: claim "${k}" is the seed's own; pick another name`);
    }
  }
  if (!cfg.usersTable) throw new Error('magic-links: usersTable is required');
  if (!cfg.emailField) throw new Error('magic-links: emailField is required');
  if (cfg.userRolesTable && !(cfg.userRolesUserField && cfg.userRolesRoleField)) {
    throw new Error('magic-links: userRolesTable needs userRolesUserField and userRolesRoleField');
  }
  if (cfg.userRolesTable && !cfg.userKeyField) throw new Error('magic-links: userRolesTable needs userKeyField (grants point at the person\'s key)');
  if (!ROLE.test(cfg.adminRole)) throw new Error(`magic-links: adminRole "${cfg.adminRole}" is not a plain role name`);
  if (!/^[A-Za-z0-9_-]+$/.test(cfg.cookieName)) throw new Error(`magic-links: cookieName "${cfg.cookieName}" is not a plain cookie name`);
  for (const p of [...cfg.protect, ...cfg.publicPaths]) {
    if (!p.startsWith('/')) throw new Error(`magic-links: paths start with /, got "${p}"`);
  }
}

/** Write the project's answers back (the install script, after the agent has mapped). */
export function saveConfig(dir, cfg) {
  const out = {};
  for (const s of SETTINGS) {
    const v = cfg[s.key];
    out[s.key] = s.valueType === 'list' ? v.join(',')
      : s.valueType === 'map' ? Object.entries(v).map(([k, f]) => `${k}=${f}`).join(',')
        : String(v);
  }
  fs.writeFileSync(configPath(dir), JSON.stringify(out, null, 2) + '\n');
}

// Which front door: the platform's STAGE. Unset or "dev" is Dev (simulated users); anything else
// is a published stage (real sign-in). NODE_ENV is NOT read: Dev's runner runs with
// NODE_ENV=production.
export function resolveMode(env = process.env) {
  const stage = String(env.STAGE || '').trim().toLowerCase();
  return !stage || stage === 'dev' ? 'dev' : 'live';
}
