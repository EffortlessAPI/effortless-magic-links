// Boots a real Express app with the seed registered, against a throwaway database,
// plus a stand-in for magiclink.effortlessapi.com that issues real RS256 tokens.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import pg from 'pg';
import { registerMagicLinks } from '../server/index.js';
import { newKeyPair, sign, nowS, read } from './helpers.mjs';

export const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

export async function stubMagicLink(tenantId = 'live-tenant') {
  const keys = newKeyPair(); const sent = [];
  const server = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const body = b ? JSON.parse(b) : {};
    const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'GET' && req.url === `/api/tenants/${tenantId}`) return out(200, { tenant_id: tenantId, public_key_pem: keys.publicPem, display_name: 'Stub' });
    if (req.url === `/api/tenants/${tenantId}/send-code`) { sent.push(body.email); return out(200, { ok: true }); }
    if (req.url === `/api/tenants/${tenantId}/verify-code`) {
      if (body.code !== '424242') return out(400, { error: 'invalid_code' });
      const jwt = sign(keys.privatePem, { iss: `http://stub/${tenantId}`, tenant_id: tenantId, email: body.email, iat: nowS(), exp: nowS() + 600 });
      return out(200, { ok: true, jwt, expires_in: 600 });
    }
    out(404, { error: 'not_found' });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, keys, sent, tenantId, close: () => server.close(),
           mint: (email, over = {}) => sign(keys.privatePem, { iss: `http://stub/${tenantId}`, tenant_id: tenantId, email, iat: nowS(), exp: nowS() + 600, ...over }) };
}

export async function bootApp({ dbUrl, env = {}, config } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlseed-'));
  if (config) fs.writeFileSync(path.join(dir, 'magic-links.config.json'), JSON.stringify(config));
  const pool = new pg.Pool({ connectionString: dbUrl, max: 4 });
  const app = express(); app.use(express.json());
  const silent = { log() {}, error() {}, warn() {} };
  const handle = registerMagicLinks(app, { pool, dir, env: { PATH: '', ...env }, log: silent });
  app.get('/api/things', async (_req, res) => res.json((await pool.query('SELECT * FROM vw_things ORDER BY id')).rows));
  app.post('/api/things', async (req, res) => {
    try { await pool.query('INSERT INTO things VALUES ($1,$2,$3)', [req.body.id, req.body.title, req.body.owner_email]); res.json({ ok: true }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });
  app.get('/api/raw', async (_req, res) => res.json({ u: (await pool.__raw.query('SELECT current_user AS u')).rows[0].u, scoped: (await pool.query('SELECT current_user AS u')).rows[0].u }));
  app.get('/api/connect', async (_req, res) => { try { await pool.connect(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.get('/api/editor/ddl', async (_req, res) => res.json({ ok: true, as: (await pool.query('SELECT current_user AS u')).rows[0].u }));
  const server = http.createServer(app);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const failure = await handle.ready;
  // a tiny client that keeps cookies
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.startsWith(`${handle.config.cookieName}=;`) || /Max-Age=0/.test(set) ? '' : set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null), setCookie: set };
  };
  return { base, call, clear: () => { cookie = ''; }, failure, handle, pool, dir, jar: () => cookie,
    close: async () => { server.close(); await pool.end(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

export async function prepareDb(db) {
  await db.pool.query(read('test/fixture.sql'));
}
