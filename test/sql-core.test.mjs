import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pgAvailable, freshDb, newKeyPair, sign, nowS, read } from './helpers.mjs';

let db; let skip = false;
const keys = newKeyPair(); const other = newKeyPair();
const claims = (over = {}) => ({ iss: 'https://ml.example/t1', tenant_id: 't1', email: 'Ann@Example.com', iat: nowS(), exp: nowS() + 600, ...over });

before(async () => {
  if (!(await pgAvailable())) { skip = 'no Postgres at ML_TEST_PG'; return; }
  db = await freshDb('core');
  await db.pool.query(read('sql/00-auth-core.sql'));
  await db.pool.query('SELECT auth.register_tenant($1, $2)', ['t1', keys.publicPem]);
});
after(async () => { if (db) await db.drop(); });

async function verify(token) {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query('SELECT auth.set_jwt($1) AS email', [token]);
    const h = await c.query('SELECT app.jwt_email() AS e, app.jwt_tenant_id() AS t');
    await c.query('COMMIT');
    return { email: r.rows[0].email, ...h.rows[0] };
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

test('a valid RS256 token verifies in the database and yields the lower-cased email', { skip }, async () => {
  const r = await verify(sign(keys.privatePem, claims()));
  assert.equal(r.email, 'ann@example.com');
  assert.equal(r.e, 'ann@example.com');
  assert.equal(r.t, 't1');
});

test('identity does not outlive the transaction', { skip }, async () => {
  await verify(sign(keys.privatePem, claims()));
  const r = await db.pool.query('SELECT app.jwt_email() AS e');
  assert.equal(r.rows[0].e, null);
});

test('a token signed by another key is refused', { skip }, async () => {
  await assert.rejects(verify(sign(other.privatePem, claims())), /invalid_jwt: signature/);
});

test('a tampered payload is refused', { skip }, async () => {
  const [h, , s] = sign(keys.privatePem, claims()).split('.');
  const p = Buffer.from(JSON.stringify(claims({ email: 'evil@example.com' }))).toString('base64url');
  await assert.rejects(verify(`${h}.${p}.${s}`), /invalid_jwt: signature/);
});

test('expired, unknown-tenant, wrong-issuer and alg=none tokens are refused', { skip }, async () => {
  await assert.rejects(verify(sign(keys.privatePem, claims({ exp: nowS() - 5 }))), /expired/);
  await assert.rejects(verify(sign(keys.privatePem, claims({ tenant_id: 'nope', iss: 'x/nope' }))), /unknown tenant/);
  await assert.rejects(verify(sign(keys.privatePem, claims({ iss: 'https://ml.example/other' }))), /issuer/);
  await assert.rejects(verify(sign(keys.privatePem, claims(), { alg: 'none' })), /alg/);
  await assert.rejects(verify('not.a.token'), /invalid_jwt/);
  await assert.rejects(verify(sign(keys.privatePem, claims({ email: '' }))), /no email/);
});

test('a dev key cannot be registered once the database has gone live, and going live forgets dev keys', { skip }, async () => {
  const dev = newKeyPair();
  await db.pool.query('SELECT auth.register_tenant($1,$2,true)', ['dev-local', dev.publicPem]);
  assert.equal((await db.pool.query(`SELECT count(*)::int n FROM auth.trusted_tenants WHERE is_dev`)).rows[0].n, 1);
  await db.pool.query('SELECT auth.go_live()');
  assert.equal((await db.pool.query(`SELECT count(*)::int n FROM auth.trusted_tenants WHERE is_dev`)).rows[0].n, 0);
  await assert.rejects(db.pool.query('SELECT auth.register_tenant($1,$2,true)', ['dev-local', dev.publicPem]), /database is live/);
  // a live tenant still registers
  await db.pool.query('SELECT auth.register_tenant($1,$2,false)', ['t1', keys.publicPem]);
});
