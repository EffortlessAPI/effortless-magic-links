// The three pieces of a running project, for real, on local ports:
//   - a stand-in for the generated API that does what rulebook-to-node-postgres-api does with a
//     session (runs the request inside auth.sign_in; a bad one is 401),
//   - the project's server (server/ from the Loops template): the seed's middleware, then a
//     project route, then everything else passed on to that API unchanged,
//   - a stand-in for magiclink.effortlessapi.com that signs real RS256 tokens.
import http from 'node:http';
import express from 'express';
import pg from 'pg';
import { magicLinks } from '../server/index.js';
import { snake } from '../server/names.js';
import { newKeyPair, sign, nowS } from './helpers.mjs';
import { writeConfigDir } from './config-helper.mjs';

export const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

export async function stubMagicLink(tenantId = 'tenant-1') {
  const keys = newKeyPair(); const other = newKeyPair(); const sent = [];
  let issueFor = null; // force the next verify to prove another address / tenant
  const server = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const body = b ? JSON.parse(b) : {};
    const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'GET' && req.url === `/api/tenants/${tenantId}`) return out(200, { tenant_id: tenantId, public_key_pem: keys.publicPem, display_name: 'Kitchen', from_email: 'hi@kitchen.test' });
    if (req.url === `/api/tenants/${tenantId}/send-code`) { sent.push(body.email); return out(200, { ok: true }); }
    if (req.url === `/api/tenants/${tenantId}/verify-code`) {
      if (body.code !== '424242' || !sent.includes(body.email)) return out(400, { error: 'invalid_code' });
      const f = issueFor || {}; issueFor = null;
      const jwt = sign(f.key || keys.privatePem, { iss: `https://magiclink.test/${f.tenant || tenantId}`, tenant_id: f.tenant || tenantId, email: f.email || body.email, iat: nowS(), exp: nowS() + 300 });
      return out(200, { ok: true, jwt, expires_in: 300 });
    }
    out(404, { error: 'not_found' });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, tenantId, sent, close: () => server.close(),
    nextProof: (f) => { issueFor = f; }, otherKey: other.privatePem };
}

/** The generated API's behaviour with sessions, reduced to the table routes the tests need. */
export async function generatedApi(dbUrl) {
  const pool = new pg.Pool({ connectionString: dbUrl, max: 4 });
  const app = express(); app.use(express.json());
  const run = async (req, sql, params) => {
    const auth = req.headers.authorization || '';
    if (!/^Bearer /i.test(auth)) return pool.query(sql, params);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT auth.sign_in($1)', [auth.slice(7)]);
      const r = await c.query(sql, params);
      await c.query('COMMIT');
      return r;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  };
  app.get('/api/health', (_q, r) => r.json({ ok: true }));
  app.get('/api/tables/:t', async (req, res) => {
    try { res.json({ rows: (await run(req, `SELECT * FROM vw_${snake(req.params.t)}`)).rows }); }
    catch (e) { res.status(/invalid_session/.test(e.message) ? 401 : 500).json({ error: e.message }); }
  });
  app.post('/api/tables/:t/rows', async (req, res) => {
    try {
      const cols = Object.keys(req.body); const t = snake(req.params.t);
      const r = await run(req, `INSERT INTO ${t} (${cols.map(snake).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, Object.values(req.body));
      res.status(201).json({ ok: true, row: r.rows[0] });
    } catch (e) { res.status(/invalid_session/.test(e.message) ? 401 : /row-level/.test(e.message) ? 403 : 500).json({ error: e.message }); }
  });
  app.post('/api/tables', (_q, r) => r.status(201).json({ ok: true, created: 'a table' }));
  const server = http.createServer(app); const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, close: async () => { server.close(); await pool.end(); } };
}

/** The project's server, as the Loops template writes it, with the seed in front. */
export async function projectServer({ dbUrl, apiUrl, env = {}, config = {}, magic }) {
  const dir = writeConfigDir(config);
  // The seed reads its settings from its own folder; the tests point it at a scratch one with the
  // same effortless-seed.json (loadConfig reads the manifest from the seed, the answers from dir).
  const pool = new pg.Pool({ connectionString: dbUrl, max: 4 });
  const silent = { log() {}, error() {}, warn() {} };
  const signIn = magicLinks({ pool, dir, env: { EFFORTLESS_API_URL: apiUrl, ...(magic ? { MAGICLINK_BASE_URL: magic.url } : {}), ...env }, log: silent });
  const app = express();
  app.disable('x-powered-by');
  app.use(signIn.middleware);
  app.get('/api/server/health', (_q, r) => r.json({ ok: true }));
  app.get('/api/me-from-server', (req, r) => r.json({ email: req.signIn?.claims?.email }));
  app.use('/api', (req, res) => {
    const target = new URL(apiUrl);
    const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.originalUrl, headers: { ...req.headers, host: target.host } }, (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers); upRes.pipe(res);
    });
    up.on('error', (e) => res.status(502).json({ error: e.message }));
    req.pipe(up);
  });
  const server = http.createServer(app); const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  await signIn.ready;
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0];
    const text = await res.text();
    let parsed = text; try { parsed = JSON.parse(text); } catch { /* html or js */ }
    return { status: res.status, body: parsed, setCookie: set, type: res.headers.get('content-type') };
  };
  return { base, call, signIn, jar: () => cookie, setJar: (c) => { cookie = c; },
    close: async () => { server.close(); await pool.end(); } };
}
