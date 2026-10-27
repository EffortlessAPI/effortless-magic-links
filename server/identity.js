// Every request runs AS the signed-in person: BEGIN; auth.set_jwt(token); SET LOCAL ROLE ml_app;
// <your query>; COMMIT. The database verifies the token and the policies read it, so row-level
// security applies to every generated route without editing one.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export const currentIdentity = () => als.getStore();
export const runAs = (identity, fn) => als.run(identity, fn);   // { token } or { system: true }

export function wrapPool(pool) {
  if (pool.__mlWrapped) return pool;
  const rawQuery = pool.query.bind(pool);
  const rawConnect = pool.connect.bind(pool);

  const scoped = async (id, a, b) => {
    if (!TOKEN_SHAPE.test(id.token || '')) throw Object.assign(new Error('unauthenticated'), { status: 401 });
    const cfg = typeof a === 'string' ? { text: a, values: b } : { ...a, values: a.values ?? b };
    const client = await rawConnect();
    try {
      // the token shape is base64url + dots, so it is safe to inline in the simple-protocol batch
      await client.query(`BEGIN; SELECT auth.set_jwt('${id.token}'); SET LOCAL ROLE ml_app`);
      const res = await client.query(cfg);
      await client.query('COMMIT');
      return res;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
      if (/invalid_jwt/.test(e.message)) e.status = 401;
      throw e;
    } finally { client.release(); }
  };

  pool.query = function (a, b, c) {
    const id = als.getStore();
    if (!id || id.system) return rawQuery(a, b, c);
    if (typeof b === 'function' || typeof c === 'function') {
      throw new Error('magic-links: callback-style pool.query inside a request would skip row-level security; use await');
    }
    return scoped(id, a, b);
  };
  pool.connect = function (...args) {
    const id = als.getStore();
    if (id && !id.system) {
      throw new Error('magic-links: pool.connect() inside a request would skip row-level security; use pool.query, or runAs({ system: true }, ...)');
    }
    return rawConnect(...args);
  };
  Object.defineProperty(pool, '__mlWrapped', { value: true });
  Object.defineProperty(pool, '__raw', { value: { query: rawQuery, connect: rawConnect } });
  return pool;
}

// Verify a token in the database once and say who it is. Cached briefly, never past `exp`.
export function sessionReader(pool) {
  const rawConnect = (pool.__raw ? pool.__raw.connect : pool.connect.bind(pool));
  const cache = new Map();
  return async function read(token) {
    if (!TOKEN_SHAPE.test(token || '')) return null;
    const hit = cache.get(token);
    if (hit && hit.until > Date.now()) return hit.value;
    const client = await rawConnect();
    let value = null;
    try {
      await client.query('BEGIN');
      await client.query('SELECT auth.set_jwt($1)', [token]);
      const r = await client.query(`SELECT app.jwt_email() AS email, app.jwt_role() AS role,
                                           app.is_approved() AS approved, app.jwt_is_dev_admin() AS dev_admin`);
      await client.query('COMMIT');
      const row = r.rows[0];
      let exp = Date.now() + 15000;
      try { exp = Math.min(exp, JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp * 1000); } catch { /* keep default */ }
      value = { email: row.email, role: row.role, approved: !!row.approved, devAdmin: !!row.dev_admin };
      if (cache.size > 500) cache.clear();
      cache.set(token, { value, until: exp });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* gone */ }
      if (!/invalid_jwt/.test(e.message)) throw e;
    } finally { client.release(); }
    return value;
  };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function tokenFromRequest(req, cookieName) {
  const auth = req.headers.authorization || '';
  if (/^Bearer /i.test(auth)) return { token: auth.slice(7).trim(), via: 'bearer' };
  const c = parseCookies(req.headers.cookie)[cookieName];
  return c ? { token: c, via: 'cookie' } : { token: null, via: null };
}

export function cookieHeader(name, value, { maxAgeSeconds, secure }) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}
