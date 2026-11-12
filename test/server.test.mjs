// The project's server with the seed in front, a generated API behind it, and a stand-in for
// magiclink: what a browser sees in Dev and on a published stage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pgAvailable } from './helpers.mjs';
import { stage, dev } from './db.mjs';
import { loadConfigFrom } from './config-helper.mjs';
import { generatedApi, projectServer, stubMagicLink } from './harness.mjs';
import { isAdminRoute } from '../server/index.js';
import * as S from './schemas.mjs';

const up = await pgAvailable();
const opts = { skip: up ? false : 'no Postgres at ML_TEST_PG' };

test('Dev: pick your user, see what they see, switch, sign out', opts, async () => {
  const db = await dev('srv_dev', S.appUsers.sql, loadConfigFrom({}));
  const api = await generatedApi(db.url);
  const srv = await projectServer({ dbUrl: db.url, apiUrl: api.url });
  try {
    let r = await srv.call('GET', '/api/auth/session');
    assert.equal(r.body.mode, 'dev'); assert.equal(r.body.signedIn, false);
    assert.equal((await srv.call('GET', '/api/tables/AppUsers')).status, 401, 'no session, no data, in Dev too');
    assert.equal((await srv.call('GET', '/api/server/health')).status, 200, 'an open path');

    r = await srv.call('GET', '/api/auth/simulated/users');
    assert.deepEqual(r.body.users.map((u) => u.key).sort(), ['ann', 'bob', 'cat', 'eve']);
    assert.equal((await srv.call('POST', '/api/auth/simulated/sign-in', { email: 'dan@example.com' })).status, 403, 'an inactive person cannot be picked');
    assert.equal((await srv.call('POST', '/api/auth/simulated/sign-in', { email: 'nobody@example.com' })).status, 403);

    r = await srv.call('POST', '/api/auth/simulated/sign-in', { email: 'bob@example.com' });
    assert.equal(r.status, 200); assert.match(r.setCookie, /^ml_session=.+HttpOnly; SameSite=Lax/); assert.doesNotMatch(r.setCookie, /Secure/);
    r = await srv.call('GET', '/api/auth/session');
    assert.equal(r.body.signedIn, true); assert.equal(r.body.simulated, true); assert.deepEqual(r.body.user.roles, ['member']); assert.equal(r.body.admin, false);
    assert.equal((await srv.call('GET', '/api/tables/AppUsers')).body.rows.length, 1, 'Bob sees Bob');
    assert.equal((await srv.call('GET', '/api/me-from-server')).body.email, 'bob@example.com', 'project routes see who it is');
    assert.equal((await srv.call('POST', '/api/tables', { name: 'X' })).status, 403, 'schema routes are admin only');
    assert.equal((await srv.call('GET', '/api/auth/setup')).status, 403);
    assert.equal((await srv.call('POST', '/api/tables/AppUsers/rows', { AppUserId: 'zed', EmailAddress: 'zed@x.test', AppRole: 'admin', IsActive: true })).status, 403, 'a member cannot add people');

    await srv.call('POST', '/api/auth/simulated/sign-in', { email: 'ann@example.com' });
    assert.equal((await srv.call('GET', '/api/tables/AppUsers')).body.rows.length, 6, 'Ann is admin');
    assert.equal((await srv.call('POST', '/api/tables', { name: 'X' })).status, 201);
    assert.equal((await srv.call('POST', '/api/tables/AppUsers/rows', { AppUserId: 'zed', EmailAddress: 'zed@x.test', AppRole: 'member', IsActive: true })).status, 201);
    assert.equal((await srv.call('POST', '/api/auth/request-code', { email: 'ann@example.com' })).status, 404, 'no codes in Dev');

    await srv.call('POST', '/api/auth/logout');
    assert.equal(srv.jar(), '');
    assert.equal((await srv.call('GET', '/api/tables/AppUsers')).status, 401);

    srv.setJar('ml_session=aaa.bbb.ccc');
    r = await srv.call('GET', '/api/tables/AppUsers');
    assert.equal(r.status, 401); assert.match(r.setCookie, /Max-Age=0/, 'a stale cookie is cleared');
  } finally { await srv.close(); await api.close(); await db.drop(); }
});

test('a published stage: email, code, session; strangers get no code and no clue', opts, async () => {
  const cfg = loadConfigFrom({});
  const db = await stage('srv_live', S.appUsers.sql, cfg);
  const api = await generatedApi(db.url);
  const magic = await stubMagicLink('tenant-1');
  const env = { STAGE: 'beta', MAGICLINK_TENANT_ID: 'tenant-1' };
  const srv = await projectServer({ dbUrl: db.url, apiUrl: api.url, env, magic });
  try {
    assert.equal((await db.appPool.query('SELECT auth.is_live() AS l')).rows[0].l, true, 'starting live marks the database');
    assert.equal((await srv.call('GET', '/api/auth/simulated/users')).status, 404);
    assert.equal((await srv.call('POST', '/api/auth/simulated/sign-in', { email: 'ann@example.com' })).status, 404);

    assert.deepEqual((await srv.call('POST', '/api/auth/request-code', { email: 'stranger@example.com' })).body, { ok: true });
    assert.deepEqual((await srv.call('POST', '/api/auth/request-code', { email: 'dan@example.com' })).body, { ok: true });
    assert.deepEqual(magic.sent, [], 'no code to a stranger or an inactive person');
    assert.equal((await srv.call('POST', '/api/auth/verify-code', { email: 'stranger@example.com', code: '424242' })).status, 401, 'same answer as a wrong code');

    await srv.call('POST', '/api/auth/request-code', { email: 'Bob@Example.com' });
    assert.deepEqual(magic.sent, ['bob@example.com']);
    assert.equal((await srv.call('POST', '/api/auth/verify-code', { email: 'bob@example.com', code: '111111' })).status, 401);
    let r = await srv.call('POST', '/api/auth/verify-code', { email: 'bob@example.com', code: '424242' });
    assert.equal(r.status, 200); assert.match(r.setCookie, /Secure/);
    r = await srv.call('GET', '/api/auth/session');
    assert.equal(r.body.simulated, false); assert.equal(r.body.user.key, 'bob');
    assert.equal((await srv.call('GET', '/api/tables/AppUsers')).body.rows.length, 1);
    assert.equal((await srv.call('GET', '/api/tables/Orders')).body.rows.length, 3);
  } finally { await srv.close(); await api.close(); magic.close(); await db.drop(); }
});

test('the Sign in button in the email: lands signed in once; a second click or a bad link does not', opts, async () => {
  const cfg = loadConfigFrom({});
  const db = await stage('srv_link', S.appUsers.sql, cfg);
  const api = await generatedApi(db.url);
  const magic = await stubMagicLink('tenant-1');
  const srv = await projectServer({ dbUrl: db.url, apiUrl: api.url, env: { STAGE: 'beta', MAGICLINK_TENANT_ID: 'tenant-1' }, magic });
  try {
    assert.equal((await srv.call('POST', '/api/auth/verify-link', { email: 'bob@example.com', token: 'forged' })).status, 401);
    assert.equal(srv.jar(), '');
    const r = await srv.call('POST', '/api/auth/verify-link', { email: 'bob@example.com', token: 'good-link' });
    assert.equal(r.status, 200);
    assert.equal((await srv.call('GET', '/api/auth/session')).body.user.key, 'bob');
    assert.equal((await srv.call('POST', '/api/auth/verify-link', { email: 'bob@example.com', token: 'good-link' })).status, 401, 'used once');
    assert.equal((await srv.call('GET', '/api/auth/session')).body.signedIn, true, 'a second click keeps the session');
    // A link for someone who is not approved proves the inbox and still gets no session.
    srv.setJar('');
    assert.equal((await srv.call('POST', '/api/auth/verify-link', { email: 'dan@example.com', token: 'good-link' })).status, 403);
    assert.equal((await srv.call('POST', '/api/auth/verify-link', { email: 'bob@example.com' })).status, 400);
  } finally { await srv.close(); await api.close(); magic.close(); await db.drop(); }
});

test('a tenant of your own (not on Effortless): sign in to magiclink, create it in Dev, change it; refused when the platform owns it', opts, async () => {
  const cfg = loadConfigFrom({});
  const db = await stage('srv_own', S.appUsers.sql, cfg);
  const api = await generatedApi(db.url);
  const magic = await stubMagicLink('tenant-new');
  const srv = await projectServer({ dbUrl: db.url, apiUrl: api.url, magic, config: { usersTable: 'AppUsers' } });
  try {
    await srv.call('POST', '/api/auth/simulated/sign-in', { email: 'ann@example.com' });
    assert.equal((await srv.call('POST', '/api/auth/setup/tenant', { display_name: 'Kitchen' })).body.error, 'sign_in_to_magiclink_first');
    assert.equal((await srv.call('POST', '/api/auth/setup/self/send', { email: 'dev@example.com' })).status, 200);
    assert.deepEqual(magic.selfSent, ['dev@example.com'], 'the puzzle was solved');
    assert.equal((await srv.call('POST', '/api/auth/setup/self/verify', { email: 'dev@example.com', code: '999999' })).status, 200);
    const r = await srv.call('POST', '/api/auth/setup/tenant', { display_name: 'Kitchen', login_url: 'https://kitchen.test/' });
    assert.equal(r.body.tenantId, 'tenant-new');
    const file = JSON.parse((await import('node:fs')).readFileSync(srv.configFile, 'utf8'));
    assert.deepEqual(file, { usersTable: 'AppUsers', tenantId: 'tenant-new' }, 'only the tenant id is added to the project\'s answers');
    assert.equal((await srv.call('POST', '/api/auth/setup/tenant', {})).status, 409, 'one tenant');
    await srv.call('PATCH', '/api/auth/setup/tenant', { display_name: 'Common Table', login_url: 'https://kitchen.test/in', smtp_password: 'nope' });
    assert.deepEqual(magic.patched.at(-1), { display_name: 'Common Table', login_url: 'https://kitchen.test/in' }, 'only branding fields pass');
  } finally { await srv.close(); }
  const managed = await projectServer({ dbUrl: db.url, apiUrl: api.url, magic, env: { MAGICLINK_TENANT_ID: 'tenant-new' } });
  try {
    await managed.call('POST', '/api/auth/simulated/sign-in', { email: 'ann@example.com' });
    assert.equal((await managed.call('POST', '/api/auth/setup/self/send', { email: 'dev@example.com' })).body.error, 'managed_by_platform');
    assert.equal((await managed.call('PATCH', '/api/auth/setup/tenant', { display_name: 'x' })).body.error, 'managed_by_platform');
  } finally { await managed.close(); await api.close(); magic.close(); await db.drop(); }
});

test('a proof for another address, another tenant or signed by another key is refused', opts, async () => {
  const cfg = loadConfigFrom({});
  const db = await stage('srv_proof', S.appUsers.sql, cfg);
  const api = await generatedApi(db.url);
  const magic = await stubMagicLink('tenant-1');
  const srv = await projectServer({ dbUrl: db.url, apiUrl: api.url, env: { STAGE: 'production', MAGICLINK_TENANT_ID: 'tenant-1' }, magic });
  try {
    await srv.call('POST', '/api/auth/request-code', { email: 'bob@example.com' });
    for (const [what, f] of [['address', { email: 'ann@example.com' }], ['tenant', { tenant: 'tenant-2' }], ['key', { key: magic.otherKey }]]) {
      magic.nextProof(f);
      const r = await srv.call('POST', '/api/auth/verify-code', { email: 'bob@example.com', code: '424242' });
      assert.equal(r.status, 401, `another ${what}`);
      assert.equal(srv.jar(), '');
    }
    // Approved when the code was sent, deactivated before it was typed: no session.
    await db.ownerPool.query(`UPDATE app_users SET is_active = false WHERE app_user_id = 'bob'`);
    assert.equal((await srv.call('POST', '/api/auth/verify-code', { email: 'bob@example.com', code: '424242' })).status, 403);
  } finally { await srv.close(); await api.close(); magic.close(); await db.drop(); }
});

test('a published stage without a tenant does not start; Dev on a live database refuses', opts, async () => {
  const cfg = loadConfigFrom({});
  const db = await stage('srv_refuse', S.appUsers.sql, cfg);
  const api = await generatedApi(db.url);
  try {
    await assert.rejects(projectServer({ dbUrl: db.url, apiUrl: api.url, env: { STAGE: 'beta' } }), /needs a magic-link tenant/);
    await db.appPool.query('SELECT auth.go_live()');
    const srv = await projectServer({ dbUrl: db.url, apiUrl: api.url, env: { STAGE: 'dev' } });
    try {
      const r = await srv.call('GET', '/api/auth/session');
      assert.equal(r.status, 503); assert.match(r.body.message, /refuses simulated users for good/);
      assert.equal((await srv.call('GET', '/api/server/health')).status, 200, 'open paths still answer');
    } finally { await srv.close(); }
  } finally { await api.close(); await db.drop(); }
});

test('a database without the seed\'s rows: every protected path says what to do', opts, async () => {
  const db = await dev('srv_norows', S.appUsers.sql, null);
  const api = await generatedApi(db.url);
  const srv = await projectServer({ dbUrl: db.url, apiUrl: api.url });
  try {
    const r = await srv.call('GET', '/api/tables/AppUsers');
    assert.equal(r.status, 503); assert.match(r.body.message, /install\.mjs --write/);
  } finally { await srv.close(); await api.close(); await db.drop(); }
});

test('the setup screen\'s data: checks with fixes, and the UI files', opts, async () => {
  const cfg = loadConfigFrom({});
  const db = await stage('srv_setup', S.appUsers.sql, cfg);
  const api = await generatedApi(db.url);
  const magic = await stubMagicLink('tenant-1');
  const srv = await projectServer({ dbUrl: db.url, apiUrl: api.url, env: { MAGICLINK_TENANT_ID: 'tenant-1' }, magic });
  try {
    // Dev on a stage-shaped database: the app role is held to RLS, no ml_app needed.
    await srv.call('POST', '/api/auth/simulated/sign-in', { email: 'ann@example.com' });
    const r = await srv.call('GET', '/api/auth/setup');
    assert.equal(r.status, 200);
    const by = Object.fromEntries(r.body.checks.map((c) => [c.id, c]));
    for (const id of ['people', 'sql', 'policies', 'held', 'admin', 'api', 'tenant']) assert.equal(by[id].ok, true, `${id}: ${by[id].says} ${by[id].fix || ''}`);
    assert.equal(r.body.readyToPublish, true);
    assert.equal(r.body.tenantManaged, true);
    assert.equal(r.body.people.table, 'AppUsers');

    await srv.call('POST', '/api/auth/setup/test-code');
    assert.deepEqual(magic.sent, ['ann@example.com']);
    const v = await srv.call('POST', '/api/auth/setup/test-verify', { code: '424242' });
    assert.equal(v.body.proven, 'ann@example.com');

    // Remove the admin: not ready, and it says what to do.
    await db.ownerPool.query(`UPDATE app_users SET app_role = 'member' WHERE app_user_id = 'ann'`);
    await db.ownerPool.query(`UPDATE app_users SET is_active = true, app_role = 'admin' WHERE app_user_id = 'dan'`);
    await srv.call('POST', '/api/auth/simulated/sign-in', { email: 'dan@example.com' });
    await db.ownerPool.query(`UPDATE app_users SET is_active = false WHERE app_user_id = 'dan'`);
    assert.equal((await srv.call('GET', '/api/auth/setup')).status, 401, 'deactivated mid-session');

    const js = await srv.call('GET', '/api/magic-links/ui/magic-links-ui.js');
    assert.equal(js.status, 200); assert.match(js.type, /javascript/);
    assert.equal((await srv.call('GET', '/api/magic-links/setup')).status, 200);
    assert.equal((await srv.call('GET', '/api/magic-links/ui/../server/index.js')).status, 404);
  } finally { await srv.close(); await api.close(); magic.close(); await db.drop(); }
});

test('the generated API\'s schema and editor routes need the admin role', () => {
  assert.equal(isAdminRoute('POST', '/api/tables'), true);
  assert.equal(isAdminRoute('GET', '/api/tables'), false);
  assert.equal(isAdminRoute('POST', '/api/tables/Orders/rows'), false);
  assert.equal(isAdminRoute('POST', '/api/tables/Orders/fields'), true);
  assert.equal(isAdminRoute('PATCH', '/api/tables/Orders/column-order'), true);
  assert.equal(isAdminRoute('GET', '/api/admin/build-status'), true);
  assert.equal(isAdminRoute('POST', '/api/save-changes'), true);
  assert.equal(isAdminRoute('GET', '/api/state'), true);
  assert.equal(isAdminRoute('GET', '/api/tables/Orders/csv'), false);
  assert.equal(isAdminRoute('GET', '/api/health'), false);
});
