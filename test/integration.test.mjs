import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pgAvailable, freshDb } from './helpers.mjs';
import { bootApp, prepareDb, stubMagicLink } from './harness.mjs';
import { resolveMode } from '../server/config.js';

let db; let skip = false; let ml;
before(async () => {
  if (!(await pgAvailable())) { skip = 'no Postgres at ML_TEST_PG'; return; }
  db = await freshDb('integration'); await prepareDb(db);
  ml = await stubMagicLink();
});
after(async () => { ml?.close(); if (db) await db.drop(); });

const DEV = {};
const LIVE = () => ({ NODE_ENV: 'production', MAGICLINK_BASE_URL: ml.url, MAGICLINK_TENANT_ID: ml.tenantId });

test('mode: dev by default, live on production or beta, and a live run can never be forced into dev', () => {
  assert.equal(resolveMode({}), 'dev');
  assert.equal(resolveMode({ NODE_ENV: 'production' }), 'live');
  assert.equal(resolveMode({ EFFORTLESS_STAGE: 'beta' }), 'live');
  assert.equal(resolveMode({ EFFORTLESS_STAGE: 'Production' }), 'live');
  assert.equal(resolveMode({ ML_MODE: 'live' }), 'live');
  assert.throws(() => resolveMode({ ML_MODE: 'dev', NODE_ENV: 'production' }), /refused/);
  assert.throws(() => resolveMode({ ML_MODE: 'dev', EFFORTLESS_STAGE: 'beta' }), /refused/);
  assert.throws(() => resolveMode({ ML_MODE: 'prod' }), /dev or live/);
});

test('dev: no token means the global admin, and the session says to pick a user', { skip }, async () => {
  const app = await bootApp({ dbUrl: db.url, env: DEV });
  try {
    assert.equal(app.failure, null);
    const s = await app.call('GET', '/auth/session');
    assert.deepEqual([s.body.mode, s.body.authenticated, s.body.picked, s.body.devAdmin, s.body.role], ['dev', true, false, true, 'admin']);
    const things = await app.call('GET', '/api/things');
    assert.equal(things.body.length, 2);
    const users = await app.call('GET', '/auth/dev/users');
    assert.deepEqual(users.body.users.map((u) => u.email), ['dev-admin@local.invalid', 'ann@example.com', 'bob@example.com']); // cy is inactive
  } finally { await app.close(); }
});

test('dev: picking a user mints a real token for them; no registration, no inactive users', { skip }, async () => {
  const app = await bootApp({ dbUrl: db.url, env: DEV });
  try {
    assert.equal((await app.call('POST', '/auth/dev/login', { email: 'eve@example.com' })).status, 403);
    assert.equal((await app.call('POST', '/auth/dev/login', { email: 'cy@example.com' })).status, 403);
    const login = await app.call('POST', '/auth/dev/login', { email: 'Bob@Example.com' });
    assert.equal(login.status, 200);
    assert.match(login.setCookie, /HttpOnly/);
    assert.doesNotMatch(login.setCookie, /Secure/);
    const s = await app.call('GET', '/auth/session');
    assert.deepEqual([s.body.email, s.body.role, s.body.picked, s.body.admin], ['bob@example.com', 'member', true, false]);
    assert.equal((await app.call('GET', '/auth/admin/users')).status, 403);
    assert.equal((await app.call('POST', '/auth/request-code', { email: 'bob@example.com' })).status, 404);  // live-only
  } finally { await app.close(); }
});

test('rules apply identically after pick-your-user: views honour row-level security', { skip }, async () => {
  // a real policy on things: you see your own rows, admins see all. Written TO ml_app, not named ml_*.
  await db.pool.query(`CREATE POLICY things_owner ON things FOR ALL TO ml_app
    USING (app.has_role('admin') OR owner_email = app.jwt_email())
    WITH CHECK (app.has_role('admin') OR owner_email = app.jwt_email())`);
  const app = await bootApp({ dbUrl: db.url, env: DEV });   // boot re-runs 20-rls.sql
  try {
    const pol = await db.pool.query(`SELECT policyname FROM pg_policies WHERE tablename='things' ORDER BY 1`);
    assert.deepEqual(pol.rows.map((r) => r.policyname), ['ml_require_approved', 'things_owner'], 'the default allow-all steps aside for a real policy; the approval gate stays');
    const opt = await db.pool.query(`SELECT reloptions FROM pg_class WHERE relname='vw_things'`);
    assert.match(String(opt.rows[0].reloptions), /security_invoker=true/);

    assert.equal((await app.call('GET', '/api/things')).body.length, 2);                  // dev admin default
    await app.call('POST', '/auth/dev/login', { email: 'bob@example.com' });
    assert.deepEqual((await app.call('GET', '/api/things')).body.map((r) => r.id), [2]);  // bob: only his
    const w = await app.call('POST', '/api/things', { id: 3, title: 'x', owner_email: 'ann@example.com' });
    assert.equal(w.status, 400); assert.match(w.body.error, /row-level security/);
    assert.equal((await app.call('POST', '/api/things', { id: 4, title: 'mine', owner_email: 'bob@example.com' })).status, 200);
    await app.call('POST', '/auth/dev/login', { admin: true });
    assert.equal((await app.call('GET', '/api/things')).body.length, 3);
  } finally { await app.close(); }
});

test('admin screen API: add, change and remove approved users (and never yourself)', { skip }, async () => {
  const app = await bootApp({ dbUrl: db.url, env: DEV });
  try {
    await app.call('POST', '/auth/dev/login', { admin: true });
    const add = await app.call('POST', '/auth/admin/users', { email: 'Dee@Example.com', role: 'member' });
    assert.equal(add.status, 200);
    assert.equal((await app.call('POST', '/auth/admin/users', { email: 'dee@example.com' })).status, 409);
    assert.equal((await app.call('PATCH', '/auth/admin/users/dee@example.com', { is_active: false })).body.ok, true);
    assert.equal((await app.call('DELETE', '/auth/admin/users/dee@example.com')).body.ok, true);
    assert.equal((await app.call('DELETE', '/auth/admin/users/dev-admin@local.invalid')).status, 400);
  } finally { await app.close(); }
});

test('request-time guards: pool.connect and callback queries inside a request are refused, not silently unscoped', { skip }, async () => {
  const app = await bootApp({ dbUrl: db.url, env: DEV });
  try {
    const r = await app.call('GET', '/api/connect');
    assert.equal(r.status, 500); assert.match(r.body.error, /skip row-level security/);
  } finally { await app.close(); }
});

test('systemPaths: an admin-only route can run unscoped, a member cannot reach it', { skip }, async () => {
  const app = await bootApp({ dbUrl: db.url, env: DEV, config: { systemPaths: ['^/api/editor/'] } });
  try {
    await app.call('POST', '/auth/dev/login', { email: 'bob@example.com' });
    assert.equal((await app.call('GET', '/api/editor/ddl')).status, 403);
    await app.call('POST', '/auth/dev/login', { admin: true });
    const r = await app.call('GET', '/api/editor/ddl');
    assert.equal(r.status, 200); assert.notEqual(r.body.as, 'ml_app');
  } finally { await app.close(); }
});

test('live: refuses to start without a tenant, and says so instead of falling back to dev', { skip }, async () => {
  const app = await bootApp({ dbUrl: db.url, env: { NODE_ENV: 'production', MAGICLINK_BASE_URL: ml.url } });
  try {
    assert.match(app.failure.message, /needs a magic-link tenant/);
    const r = await app.call('GET', '/api/things');
    assert.equal(r.status, 503);
  } finally { await app.close(); }
});

test('live: real magic links; dev keys are gone from the database and their tokens are worthless', { skip }, async () => {
  // a token minted by the dev flow before going live
  const dev = await bootApp({ dbUrl: db.url, env: DEV });
  const devToken = (await dev.call('POST', '/auth/dev/login', { admin: true })).body.token;
  await dev.close();

  const app = await bootApp({ dbUrl: db.url, env: LIVE() });
  try {
    assert.equal(app.failure, null);
    const trusted = await db.pool.query('SELECT tenant_id, is_dev FROM auth.trusted_tenants');
    assert.deepEqual(trusted.rows, [{ tenant_id: 'live-tenant', is_dev: false }]);

    assert.equal((await app.call('GET', '/api/things')).status, 401);                                 // nobody is dev admin now
    assert.equal((await app.call('GET', '/api/things', null, { Authorization: `Bearer ${devToken}` })).status, 401);
    assert.equal((await app.call('POST', '/auth/dev/login', { admin: true })).status, 404);
    assert.equal((await app.call('GET', '/auth/dev/users')).status, 404);

    // never mail a code to a stranger, never reveal who is approved
    assert.deepEqual((await app.call('POST', '/auth/request-code', { email: 'eve@example.com' })).body, { ok: true });
    assert.deepEqual(ml.sent, []);
    await app.call('POST', '/auth/request-code', { email: 'Ann@Example.com' });
    assert.deepEqual(ml.sent, ['ann@example.com']);

    // a stranger with a genuinely valid code still gets nothing
    assert.equal((await app.call('POST', '/auth/verify-code', { email: 'eve@example.com', code: '424242' })).status, 403);
    assert.equal((await app.call('POST', '/auth/verify-code', { email: 'cy@example.com', code: '424242' })).status, 403); // inactive
    assert.equal((await app.call('POST', '/auth/verify-code', { email: 'ann@example.com', code: '000000' })).status, 400);

    const ok = await app.call('POST', '/auth/verify-code', { email: 'ann@example.com', code: '424242' });
    assert.equal(ok.status, 200); assert.match(ok.setCookie, /Secure/); assert.match(ok.setCookie, /HttpOnly/);
    const s = await app.call('GET', '/auth/session');
    assert.deepEqual([s.body.mode, s.body.email, s.body.role, s.body.admin], ['live', 'ann@example.com', 'admin', true]);
    assert.equal((await app.call('GET', '/api/things')).body.length, 3);

    // a validly signed token for a stranger is a claim about an inbox, not an approval
    const eve = await app.call('GET', '/api/things', null, { Authorization: `Bearer ${ml.mint('eve@example.com')}` });
    assert.equal(eve.status, 403); assert.equal(eve.body.error, 'not_approved');

    // revoking someone takes effect in the database at once
    app.clear();
    const bob = ml.mint('bob@example.com');
    assert.equal((await app.call('GET', '/api/things', null, { Authorization: `Bearer ${bob}` })).body.length, 2); // bob's rows: 2 and 4
    await db.pool.query(`UPDATE app_users SET is_active=false WHERE app_user_id='bob@example.com'`);
    const after = await app.call('GET', '/api/things', null, { Authorization: `Bearer ${bob}` });
    // the middleware may still remember bob for a few seconds; the DATABASE does not
    assert.ok(after.status === 403 || (after.status === 200 && after.body.length === 0), `got ${after.status}`);
    await db.pool.query(`UPDATE app_users SET is_active=true WHERE app_user_id='bob@example.com'`);
  } finally { await app.close(); }
});

test('live databases never go back to dev', { skip }, async () => {
  const app = await bootApp({ dbUrl: db.url, env: DEV });
  try {
    assert.match(app.failure.message, /has been live/);
    assert.equal((await app.call('GET', '/api/things')).status, 503);
  } finally { await app.close(); }
});
