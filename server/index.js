// effortless-magic-links: registerMagicLinks(app, { pool, dir })
//
// Drop-in for the generated Express API (call it from api/custom.js). It:
//   1. installs the auth SQL and the row-level-security defaults (idempotent, every boot),
//   2. wraps pool.query so every request runs as the signed-in person,
//   3. serves /auth/* (session, sign-in, dev "pick your user", admin).
// dev = a fake, trusted token (global admin) and a pick-your-user page. live = real magic links.
// Everything after "who is this" is identical, so row-level security is enforced cradle to grave.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveMode } from './config.js';
import { loadDevKeys, mintDevToken, DEV_TENANT, DEV_ADMIN_EMAIL } from './dev.js';
import { ensureSchema } from './install.js';
import { wrapPool, runAs, sessionReader, tokenFromRequest, cookieHeader } from './identity.js';
import { magicLinkClient } from './magiclink.js';
import { mountRoutes } from './routes.js';

export const SEED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function registerMagicLinks(app, { pool, dir = SEED_DIR, env = process.env, fetchImpl, log = console } = {}) {
  if (!pool) throw new Error('registerMagicLinks needs { pool }');
  const mode = resolveMode(env);
  const cfg = loadConfig(dir, env);
  const client = magicLinkClient(cfg.baseUrl, fetchImpl);
  const devKeys = mode === 'dev' ? loadDevKeys(dir) : null;

  wrapPool(pool);
  const read = sessionReader(pool);

  const ready = ensureSchema(pool, cfg, mode, {
    devPublicPem: devKeys?.publicPem, devTenant: DEV_TENANT,
    fetchTenantPem: async (id) => (await client.tenantInfo(id)).public_key_pem,
  }).then(() => { log.log?.(`  magic-links: ${mode} mode ready`); return null; })
    .catch((e) => { log.error?.(`  magic-links: NOT READY, refusing requests: ${e.message}`); return e; });

  const ctx = { app, pool, cfg, mode, dir, client, devKeys, read, ready, secure: mode === 'live',
    setCookie(res, token, seconds) {
      res.append ? res.append('Set-Cookie', cookieHeader(cfg.cookieName, token, { maxAgeSeconds: seconds, secure: mode === 'live' }))
                 : res.setHeader('Set-Cookie', cookieHeader(cfg.cookieName, token, { maxAgeSeconds: seconds, secure: mode === 'live' }));
    },
    clearCookie(res) { ctx.setCookie(res, '', 0); },
  };

  const systemRes = (cfg.systemPaths || []).map((s) => new RegExp(s));
  const needsIdentity = (p) => cfg.protect.some((x) => p === x || p.startsWith(x + '/'));

  app.use(async (req, res, next) => {
    try {
      const failure = await ready;
      if (failure) return res.status(503).json({ error: 'auth_not_ready', message: failure.message });
      const protectedPath = needsIdentity(req.path);
      if (!protectedPath && !req.path.startsWith('/auth/')) return next();

      let { token, via } = tokenFromRequest(req, cfg.cookieName);
      req.ml = { mode, picked: via === 'cookie' || via === 'bearer' };
      if (!token && mode === 'dev') {
        token = mintDevToken(devKeys, { email: DEV_ADMIN_EMAIL, devAdmin: true, hours: cfg.devTokenHours });
        req.ml.picked = false;
      }
      let who = token ? await read(token) : null;
      if (token && !who && via === 'cookie') {                        // a stale cookie (cookies ignore ports: another dev server's, or last week's key)
        ctx.clearCookie(res);
        if (mode === 'dev') {                                         // dev: start over as the default admin, to pick again
          token = mintDevToken(devKeys, { email: DEV_ADMIN_EMAIL, devAdmin: true, hours: cfg.devTokenHours });
          who = await read(token); req.ml.picked = false;
        }
      }
      req.ml.token = who ? token : null;
      req.ml.user = who;

      if (!protectedPath) return next();                              // /auth/*: handlers decide
      if (!who) return res.status(401).json({ error: 'unauthenticated' });
      if (!who.approved) return res.status(403).json({ error: 'not_approved', email: who.email });
      if (systemRes.some((r) => r.test(req.path))) {
        if (!(who.role || '').split(',').map((s) => s.trim().toLowerCase()).includes(cfg.adminRole.toLowerCase())) {
          return res.status(403).json({ error: 'admin_only' });
        }
        return runAs({ system: true }, () => next());
      }
      return runAs({ token }, () => next());
    } catch (e) { next(e); }
  });

  mountRoutes(ctx);

  // The UI files, so a page can load them without any build step: /magic-links/ui/magic-links-ui.js
  // and a demo page at /magic-links/demo.
  const uiDir = path.join(SEED_DIR, 'ui');
  const types = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };
  const send = (res, file) => {
    const full = path.join(uiDir, file);
    if (!types[path.extname(full)] || !fs.existsSync(full)) return res.status(404).end();
    res.setHeader('Content-Type', types[path.extname(full)]);
    res.end(fs.readFileSync(full));
  };
  app.get('/magic-links/demo', (_req, res) => send(res, 'demo.html'));
  app.get('/magic-links/ui/:file', (req, res) => send(res, path.basename(req.params.file)));

  return { mode, ready, config: cfg, mintDevToken: (o) => mintDevToken(devKeys, o) };
}
