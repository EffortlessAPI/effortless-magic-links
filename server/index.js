// effortless-magic-links, the project's server half.
//
//   import pg from 'pg';
//   import { magicLinks } from '../magic-links/server/index.js';
//   const signIn = magicLinks({ pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }) });
//   app.use(signIn.middleware);            // before the project's routes and the generated API
//
// It answers /api/auth/* (session, sign-in, Dev's pick-your-user, the setup screen's data) and
// /api/magic-links/* (the UI files and the setup page), and refuses every protected path without a
// session. With one, it passes the session on to the generated API as `Authorization: Bearer`,
// which runs the request inside auth.sign_in, so the database decides what the person sees.
//
// Dev (STAGE unset or dev): simulated users. A published stage (any other STAGE): magic links.
// A published stage that cannot do real sign-in does not start; it never falls back.
import fs from 'node:fs';
import path from 'node:path';
import { SEED_DIR, loadConfig, resolveMode } from './config.js';
import { tenantClient } from './magiclink.js';
import { physical } from './names.js';
import { handleAuth } from './routes.js';

const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// The generated API's schema and editor routes. Through the project's server they need the admin
// role: a signed-in member reads and writes rows, never the rulebook, the build or the schema.
const ADMIN_ROUTES = [
  [/^\/api\/(admin|meta|save-changes|chat|uncommitted-status|activity-log|undo-last-change|discard-changes|source|state|integrity|rulebook)(\/|$)/, null],
  [/^\/api\/tables\/?$/, 'POST'],
  [/^\/api\/tables\/[^/]+\/(fields|column-order|csv-import)(\/|$)/, null],
];
export const isAdminRoute = (method, p) => ADMIN_ROUTES.some(([re, m]) => re.test(p) && (!m || m === method));

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* not ours */ }
    }
  }
  return out;
}

export function magicLinks({ pool, dir = SEED_DIR, env = process.env, fetchImpl = globalThis.fetch, log = console } = {}) {
  if (!pool) throw new Error('magicLinks needs { pool } (a pg Pool on DATABASE_URL)');
  const cfg = loadConfig(dir, env);
  const mode = resolveMode(env);
  if (mode === 'live' && !cfg.tenantId) {
    throw new Error(`magic-links: STAGE=${env.STAGE} is a published stage and needs a magic-link tenant `
      + '(MAGICLINK_TENANT_ID, set by the platform, or tenantId in magic-links.config.json). It never falls back to simulated users.');
  }
  const names = physical(cfg);
  const tenant = tenantClient(cfg, fetchImpl);
  const apiUrl = (env.EFFORTLESS_API_URL || 'http://127.0.0.1:5177').replace(/\/+$/, '');

  // Ready = the database has the seed's SQL (built from the rulebook's ERBCustomizations rows) and
  // agrees with the front door. Checked again on the next request after a failure, at most every
  // 5 s, because Dev's database is rebuilt under a running server.
  let readyState = null; let lastTry = 0; let pending = null;
  const check = async () => {
    const fn = await pool.query(`SELECT to_regprocedure('auth.sign_in(text)') IS NOT NULL AS ok`);
    if (!fn.rows[0].ok) {
      throw new Error('the database has no auth.sign_in yet: the seed\'s ERBCustomizations rows are not built into it. '
        + 'Run `node server/magic-links/scripts/install.mjs --write`, then rebuild.');
    }
    if (mode === 'live') await pool.query('SELECT auth.go_live()');
    else if ((await pool.query('SELECT auth.is_live() AS live')).rows[0].live) {
      throw new Error('this database has run real sign-in, so it refuses simulated users for good. Set STAGE to the stage\'s name.');
    }
  };
  const ensureReady = async () => {
    if (readyState === true) return null;
    if (pending) return pending;
    if (readyState && Date.now() - lastTry < 5000) return readyState;
    lastTry = Date.now();
    pending = check().then(() => { readyState = true; log.log?.(`magic-links: ${mode === 'dev' ? 'Dev (simulated users)' : `live (${env.STAGE})`} ready`); return null; },
      (e) => { readyState = e; log.error?.(`magic-links: not ready: ${e.message}`); return e; })
      .finally(() => { pending = null; });
    return pending;
  };
  const ready = ensureReady();

  // Sessions are checked by the database (auth.read_session). Cached for 15 s at most, never past exp.
  const cache = new Map();
  const readSession = async (token) => {
    if (!TOKEN_SHAPE.test(token || '')) return null;
    const hit = cache.get(token);
    if (hit && hit.until > Date.now()) return hit.claims;
    const claims = (await pool.query('SELECT auth.read_session($1) AS s', [token])).rows[0].s;
    if (cache.size > 1000) cache.clear();
    if (claims) cache.set(token, { claims, until: Math.min(Date.now() + 15000, claims.exp * 1000) });
    return claims;
  };
  const isAdmin = (claims) => !!claims && (claims.roles || []).some((r) => String(r).toLowerCase() === cfg.adminRole.toLowerCase());

  /** Run SQL as the caller: the same transaction the generated API uses. */
  const asCaller = async (token, sql, params) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT auth.sign_in($1)', [token]);
      const res = await client.query(sql, params);
      await client.query('COMMIT');
      return res;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* gone */ }
      throw e;
    } finally { client.release(); }
  };
  /** Run SQL as system code (webhooks, bookkeeping): row-level security lets it through. */
  const asSystem = async (sql, params) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT auth.as_system()');
      const res = await client.query(sql, params);
      await client.query('COMMIT');
      return res;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* gone */ }
      throw e;
    } finally { client.release(); }
  };

  const secure = mode === 'live';
  const cookie = (token, seconds) => `${cfg.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
  const ctx = {
    cfg, mode, names, tenant, pool, env, dir, apiUrl, readSession, isAdmin, asCaller, ensureReady,
    tenantManaged: !!env.MAGICLINK_TENANT_ID,
    setSession: (res, token) => res.setHeader('Set-Cookie', cookie(token, Math.round(cfg.sessionHours * 3600))),
    clearSession: (res) => res.setHeader('Set-Cookie', cookie('', 0)),
    forget: (token) => cache.delete(token),
  };

  const uiDir = path.join(SEED_DIR, 'ui');
  const TYPES = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const sendFile = (res, file) => {
    const full = path.join(uiDir, path.basename(file));
    if (!TYPES[path.extname(full)] || !fs.existsSync(full)) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', TYPES[path.extname(full)]);
    res.setHeader('Cache-Control', 'no-cache');
    res.end(fs.readFileSync(full));
  };
  const json = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  };
  const under = (p, prefix) => p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
  const tokenOf = (req) => {
    const auth = req.headers.authorization || '';
    if (/^Bearer /i.test(auth)) return { token: auth.slice(7).trim(), via: 'bearer' };
    const c = parseCookies(req.headers.cookie)[cfg.cookieName];
    return c ? { token: c, via: 'cookie' } : { token: null, via: null };
  };

  const middleware = async (req, res, next) => {
    try {
      const p = new URL(req.originalUrl || req.url, 'http://local').pathname;
      if (under(p, '/api/magic-links')) {
        if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
        if (p === '/api/magic-links/setup') return sendFile(res, 'setup.html');
        if (p.startsWith('/api/magic-links/ui/')) return sendFile(res, p.slice('/api/magic-links/ui/'.length));
        return json(res, 404, { error: 'not_found' });
      }
      const isAuth = under(p, '/api/auth');
      const gated = !isAuth && cfg.protect.some((x) => under(p, x)) && !cfg.publicPaths.some((x) => under(p, x));
      if (!isAuth && !gated) return next();

      const failure = await ensureReady();
      if (failure) return json(res, 503, { error: 'sign_in_not_ready', message: failure.message, mode });

      const { token, via } = tokenOf(req);
      const claims = token ? await readSession(token) : null;
      if (token && !claims && via === 'cookie') ctx.clearSession(res);
      req.signIn = { mode, claims, token: claims ? token : null };

      if (isAuth) return await handleAuth(ctx, req, res, p, json);
      if (!claims) return json(res, 401, { error: 'sign_in_required', mode });
      if (isAdminRoute(req.method, p) && !isAdmin(claims)) return json(res, 403, { error: 'admin_only' });
      req.headers.authorization = `Bearer ${token}`;
      return next();
    } catch (e) {
      log.error?.(`magic-links: ${e.stack || e.message}`);
      if (!res.headersSent) json(res, e.status && e.status < 600 ? e.status : 500, { error: e.code || e.message });
    }
  };

  return { middleware, ready, mode, config: cfg, asCaller, asSystem, readSession };
}
