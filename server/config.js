// Configuration: magic-links.config.json (written by the seed's questions and the admin UI,
// holds only PUBLIC values) overridden by environment variables. No secret lives here.
import fs from 'node:fs';
import path from 'node:path';

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ROLE = /^[A-Za-z0-9_-]+$/;
const LIVE_STAGES = new Set(['beta', 'production', 'prod', 'live']);

export const DEFAULTS = {
  tenantId: '',
  baseUrl: 'https://magiclink.effortlessapi.com',
  usersTable: 'app_users',
  usersView: 'vw_app_users',
  userKeyColumn: 'app_user_id',   // '' when the users table has no separate key column
  emailColumn: 'email_address',
  roleColumn: 'role',
  activeColumn: 'is_active',      // '' when every row counts as active
  adminRole: 'admin',
  cookieName: 'ml_token',
  protect: ['/api'],              // path prefixes that need a signed-in, approved person
  systemPaths: [],                // regexes (strings) of admin-only routes that run unscoped, e.g. the editor's DDL
  devTokenHours: 8,
  dbVerifier: 'builtin',          // 'canonical' when magiclink's own install-magic-links.sql is already on the database
};

// An unanswered seed question still reads "$tenantId$" before the CLI has replaced it.
const unanswered = (v) => typeof v === 'string' && /^\$[A-Za-z][A-Za-z0-9-]*\$$/.test(v);

export function configPath(dir) { return path.join(dir, 'magic-links.config.json'); }

export function loadConfig(dir, env = process.env) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(configPath(dir), 'utf8')); } catch { /* none yet */ }
  const cfg = { ...DEFAULTS };
  for (const [k, v] of Object.entries(file)) if (k in DEFAULTS && v !== undefined && !unanswered(v)) cfg[k] = v;
  if (env.MAGICLINK_TENANT_ID) cfg.tenantId = env.MAGICLINK_TENANT_ID;
  if (env.MAGICLINK_BASE_URL) cfg.baseUrl = env.MAGICLINK_BASE_URL;
  cfg.baseUrl = String(cfg.baseUrl).replace(/\/+$/, '');
  for (const k of ['usersTable', 'usersView', 'emailColumn', 'roleColumn']) {
    if (!IDENT.test(cfg[k])) throw new Error(`magic-links: ${k} must be a lower_snake identifier, got "${cfg[k]}"`);
  }
  for (const k of ['userKeyColumn', 'activeColumn']) {
    if (cfg[k] && !IDENT.test(cfg[k])) throw new Error(`magic-links: ${k} must be a lower_snake identifier, got "${cfg[k]}"`);
  }
  if (!ROLE.test(cfg.adminRole)) throw new Error(`magic-links: adminRole "${cfg.adminRole}" is not a plain role name`);
  return cfg;
}

export function saveConfig(dir, cfg) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = cfg[k];
  fs.writeFileSync(configPath(dir), JSON.stringify(out, null, 2) + '\n');
}

// dev unless something says this is a beta / production run. Fails closed: a live run
// can never be talked into dev, and dev is refused where the platform says production.
export function resolveMode(env = process.env) {
  const stage = String(env.EFFORTLESS_STAGE || env.STAGE || '').toLowerCase();
  const prodish = env.NODE_ENV === 'production' || LIVE_STAGES.has(stage);
  const forced = String(env.ML_MODE || '').toLowerCase();
  if (forced && forced !== 'dev' && forced !== 'live') throw new Error(`magic-links: ML_MODE must be dev or live, got "${forced}"`);
  if (forced === 'dev' && prodish) {
    throw new Error('magic-links: ML_MODE=dev refused: NODE_ENV/EFFORTLESS_STAGE says this is beta or production');
  }
  return forced || (prodish ? 'live' : 'dev');
}
