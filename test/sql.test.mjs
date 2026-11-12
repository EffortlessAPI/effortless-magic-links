// The database half, against real Postgres shaped like a published stage and like Dev.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pgAvailable } from './helpers.mjs';
import { stage, dev, asPerson } from './db.mjs';
import { loadConfigFrom } from './config-helper.mjs';
import * as S from './schemas.mjs';

const up = await pgAvailable();
const opts = { skip: up ? false : 'no Postgres at ML_TEST_PG (see README, Tests)' };
const one = async (pool, sql, params) => (await pool.query(sql, params)).rows[0];
const issue = async (pool, email) => (await one(pool, 'SELECT auth.issue_session($1) AS t', [email])).t;
const sim = async (pool, email) => (await one(pool, 'SELECT auth.issue_simulated_session($1) AS t', [email])).t;
const claimsOf = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));

test('a published stage: the app connection sees nothing without a session, and each person their own', opts, async () => {
  const cfg = loadConfigFrom(S.appUsers.cfg);
  const db = await stage('stage1', S.appUsers.sql, cfg);
  try {
    const app = db.appPool;
    assert.equal((await app.query('SELECT * FROM vw_orders')).rowCount, 0, 'no session: no rows');
    assert.equal((await app.query('SELECT * FROM vw_app_users')).rowCount, 0);
    await assert.rejects(app.query(`INSERT INTO orders VALUES ('x', 'x', 'x', 1)`), /row-level security/);

    const ann = await issue(app, 'ann@example.com');
    const bob = await issue(app, 'BOB@EXAMPLE.COM');      // two rows share it: the active one wins
    assert.ok(ann && bob);
    assert.equal(claimsOf(bob).sub, 'bob');
    assert.deepEqual(claimsOf(bob).roles, ['member']);
    assert.equal(claimsOf(ann).email, 'ann@example.com', 'emails are lower-cased');
    assert.equal(claimsOf(ann).name, 'Ann Admin');

    // Every signed-in person: the project's tables with no rule of their own are open (ml_allow_all).
    assert.equal((await asPerson(app, bob, 'SELECT * FROM vw_orders')).rowCount, 3);
    assert.equal((await asPerson(app, bob, 'SELECT * FROM vw_settings')).rowCount, 1);
    // The people: yourself only, unless admin.
    assert.deepEqual((await asPerson(app, bob, 'SELECT app_user_id FROM vw_app_users')).rows.map((r) => r.app_user_id), ['bob']);
    assert.equal((await asPerson(app, ann, 'SELECT * FROM vw_app_users')).rowCount, 6);
    const tried = await asPerson(app, bob, `UPDATE app_users SET app_role = 'admin' WHERE app_user_id = 'bob'`);
    assert.equal(tried.rowCount, 0, 'a member cannot change people, himself included');
    assert.equal((await one(db.pool, `SELECT app_role FROM app_users WHERE app_user_id = 'bob'`)).app_role, 'member');
    await asPerson(app, ann, `UPDATE app_users SET display_name = 'Bobby' WHERE app_user_id = 'bob'`);
    // Roles are readable by anyone signed in, changed by an admin only.
    assert.equal((await asPerson(app, bob, 'SELECT * FROM vw_app_roles')).rowCount, 3);
    await assert.rejects(asPerson(app, bob, `INSERT INTO app_roles VALUES ('boss', 'Boss')`), /row-level security/);
  } finally { await db.drop(); }
});

test('who gets a session: active, approved people only, in the database', opts, async () => {
  const cfg = loadConfigFrom(S.appUsers.cfg);
  const db = await stage('stage2', S.appUsers.sql, cfg);
  try {
    const app = db.appPool;
    assert.equal(await issue(app, 'dan@example.com'), null, 'an inactive admin gets nothing');
    assert.equal(await issue(app, 'stranger@example.com'), null, 'a stranger gets nothing');
    assert.ok(await issue(app, 'cat@example.com'), 'active unknown (NULL) counts as active');
    const eve = await issue(app, 'eve@example.com');
    assert.deepEqual(claimsOf(eve).roles, [], 'no role: signed in, no roles');
    assert.equal((await one(app, 'SELECT auth.email_is_approved($1) AS ok', ['dan@example.com'])).ok, false);
    assert.equal((await one(app, 'SELECT auth.email_is_approved($1) AS ok', ['ANN@example.com'])).ok, true);
    assert.equal((await one(app, 'SELECT auth.admin_count() AS n')).n, 1, 'Ann only: Dan and Old Bob are inactive');

    // Deactivate Bob: his open session stops at once.
    const bob = await issue(app, 'bob@example.com');
    assert.ok((await one(app, 'SELECT auth.read_session($1) AS s', [bob])).s);
    await db.ownerPool.query(`UPDATE app_users SET is_active = false WHERE app_user_id = 'bob'`);
    assert.equal((await one(app, 'SELECT auth.read_session($1) AS s', [bob])).s, null);
    await assert.rejects(asPerson(app, bob, 'SELECT 1'), /invalid_session/);

    // A role change shows on the next request, without signing in again.
    const cat = await issue(app, 'cat@example.com');
    await db.ownerPool.query(`UPDATE app_users SET app_role = 'admin' WHERE app_user_id = 'cat'`);
    assert.deepEqual((await one(app, 'SELECT auth.read_session($1) AS s', [cat])).s.roles, ['admin']);
    assert.equal((await asPerson(app, cat, 'SELECT * FROM vw_app_users')).rowCount, 6);
  } finally { await db.drop(); }
});

test('forged, altered and expired sessions are refused; nobody can read the key', opts, async () => {
  const cfg = loadConfigFrom({ ...S.appUsers.cfg, sessionHours: 0.0003 }); // ~1 second
  const db = await stage('stage3', S.appUsers.sql, cfg);
  try {
    const app = db.appPool;
    const bob = await issue(app, 'bob@example.com');
    const [h, , s] = bob.split('.');
    const promoted = Buffer.from(JSON.stringify({ ...claimsOf(bob), roles: ['admin'] })).toString('base64url');
    assert.equal((await one(app, 'SELECT auth.read_session($1) AS s', [`${h}.${promoted}.${s}`])).s, null, 'altered claims');
    const forged = `${h}.${promoted}.${crypto.createHmac('sha256', 'guess').update(`${h}.${promoted}`).digest('base64url')}`;
    assert.equal((await one(app, 'SELECT auth.read_session($1) AS s', [forged])).s, null, 'signed with another key');
    assert.equal((await one(app, 'SELECT auth.read_session($1) AS s', ['not a token'])).s, null);
    await assert.rejects(app.query('SELECT * FROM auth.ml_key'), /permission denied/);
    await assert.rejects(app.query(`SELECT auth.ml_sign('{"sub":"ann","roles":["admin"]}'::jsonb)`), /permission denied/);
    await assert.rejects(app.query(`SELECT auth.ml_hmac('x')`), /permission denied/);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await one(app, 'SELECT auth.read_session($1) AS s', [bob])).s, null, 'expired');
  } finally { await db.drop(); }
});

test('the database signs exactly what HMAC-SHA256 signs (the key read as the owner, for the test)', opts, async () => {
  const cfg = loadConfigFrom(S.appUsers.cfg);
  const db = await stage('stage4', S.appUsers.sql, cfg);
  try {
    const t = await issue(db.appPool, 'ann@example.com');
    const { k_ipad: ipad } = await one(db.pool, 'SELECT k_ipad FROM auth.ml_key');
    const key = Buffer.from(ipad.map((b) => b ^ 54));
    const [h, p, s] = t.split('.');
    assert.equal(crypto.createHmac('sha256', key).update(`${h}.${p}`).digest('base64url'), s);
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  } finally { await db.drop(); }
});

test('simulated users: allowed until the database has run real sign-in, refused for good after', opts, async () => {
  const cfg = loadConfigFrom(S.appUsers.cfg);
  const db = await stage('stage5', S.appUsers.sql, cfg);
  try {
    const app = db.appPool;
    const users = (await app.query('SELECT * FROM auth.simulated_users()')).rows;
    assert.deepEqual(users.map((u) => u.user_key).sort(), ['ann', 'bob', 'cat', 'eve'], 'active people only');
    const simBob = await sim(app, 'bob@example.com');
    assert.equal(claimsOf(simBob).simulated, true);
    assert.equal((await asPerson(app, simBob, 'SELECT * FROM vw_app_users')).rowCount, 1);

    await app.query('SELECT auth.go_live()');
    assert.equal((await one(app, 'SELECT auth.read_session($1) AS s', [simBob])).s, null, 'an old simulated session dies');
    await assert.rejects(sim(app, 'bob@example.com'), /refused for good/);
    await assert.rejects(app.query('SELECT * FROM auth.simulated_users()'), /refused/);
    assert.ok(await issue(app, 'bob@example.com'), 'real sessions still work');
    // Re-running the seed's SQL (every publish) keeps it live and keeps the key.
    const before = (await one(db.pool, 'SELECT k_ipad FROM auth.ml_key')).k_ipad;
    const { block } = await import('../server/sql.js');
    await db.ownerPool.query(block('functions', cfg) + '\n' + block('policies', cfg));
    assert.equal((await one(app, 'SELECT auth.is_live() AS l')).l, true);
    assert.deepEqual((await one(db.pool, 'SELECT k_ipad FROM auth.ml_key')).k_ipad, before);
  } finally { await db.drop(); }
});

test('Dev: the superuser connection switches to ml_app, so Dev enforces what a stage enforces', opts, async () => {
  const cfg = loadConfigFrom(S.appUsers.cfg);
  const db = await dev('dev1', S.appUsers.sql, cfg);
  try {
    const su = db.pool;
    assert.equal((await su.query('SELECT * FROM vw_app_users')).rowCount, 6, 'no session: the editor sees everything');
    const bob = await sim(su, 'bob@example.com');
    const r = await asPerson(su, bob, 'SELECT current_user AS u, (SELECT count(*) FROM vw_app_users) AS n');
    assert.equal(r.rows[0].u, 'ml_app');
    assert.equal(Number(r.rows[0].n), 1);
    // The rebuild's step: the same SQL again is fine.
    const { block } = await import('../server/sql.js');
    await su.query(block('functions', cfg) + '\n' + block('policies', cfg));
    assert.equal((await asPerson(su, bob, 'SELECT * FROM vw_app_users')).rowCount, 1);
  } finally { await db.drop(); }
});

test('the editor\'s Users and roles module: mapped, nothing added', opts, async () => {
  const cfg = loadConfigFrom(S.erbUsers.cfg);
  const db = await stage('erb', S.erbUsers.sql, cfg);
  try {
    const app = db.appPool;
    const cora = await issue(app, 'cora@kitchen.org');
    assert.deepEqual(claimsOf(cora).roles, ['coordinator']);
    assert.equal(claimsOf(cora).sub, 'cora@kitchen.org');
    assert.equal(await issue(app, 'nomail'), null);
    assert.equal((await asPerson(app, cora, 'SELECT * FROM vw_erb_users')).rowCount, 1);
    const owner = await issue(app, 'OWNER@kitchen.org');
    assert.equal((await asPerson(app, owner, 'SELECT * FROM vw_erb_users')).rowCount, 4);
    assert.equal((await asPerson(app, cora, 'SELECT * FROM vw_shifts')).rowCount, 2);
    const sims = (await app.query('SELECT * FROM auth.simulated_users()')).rows;
    assert.equal(sims.length, 3, 'a person with no email cannot be picked');
  } finally { await db.drop(); }
});

test('members: an inverted active flag, roles granted in their own table, a company claim the project\'s own policy reads', opts, async () => {
  const cfg = loadConfigFrom(S.members.cfg);
  const db = await stage('members', S.members.sql, cfg, S.members.projectPolicies);
  try {
    const app = db.appPool;
    assert.equal(await issue(app, 'lee@beta.test'), null, 'archived');
    const sam = await issue(app, 'sam@acme.test');
    assert.deepEqual(claimsOf(sam).roles, ['editor', 'reviewer'], 'both grants, the empty one dropped');
    assert.equal(claimsOf(sam).company, 'Acme');
    assert.equal(claimsOf(sam).exp - claimsOf(sam).iat, 3600);
    const kim = await issue(app, 'kim@beta.test');
    assert.deepEqual(claimsOf(kim).roles, []);
    // The project's own rule took over projects: no ml_allow_all beside it.
    assert.deepEqual((await asPerson(app, sam, 'SELECT title FROM vw_projects')).rows, [{ title: 'Rocket' }]);
    assert.deepEqual((await asPerson(app, kim, 'SELECT title FROM vw_projects')).rows, [{ title: 'Boat' }]);
    const pols = (await db.pool.query(`SELECT policyname FROM pg_policies WHERE tablename = 'projects' ORDER BY 1`)).rows.map((r) => r.policyname);
    assert.deepEqual(pols, ['company_projects', 'ml_require_signed_in']);
    // Grants: yours only, unless owner (the admin role here).
    assert.equal((await asPerson(app, sam, 'SELECT * FROM vw_member_roles')).rowCount, 3);
    const pat = await issue(app, 'pat@acme.test');
    assert.equal((await asPerson(app, pat, 'SELECT * FROM vw_member_roles')).rowCount, 5);
    assert.equal((await asPerson(app, pat, 'SELECT * FROM vw_members')).rowCount, 4);
    assert.equal((await asPerson(app, sam, 'SELECT * FROM vw_members')).rowCount, 1);
  } finally { await db.drop(); }
});

test('system code passes row-level security on a stage; the platform\'s own default is not mistaken for a project rule', opts, async () => {
  const cfg = loadConfigFrom(S.appUsers.cfg);
  const db = await stage('system', S.appUsers.sql, cfg);
  try {
    const c = await db.appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT auth.as_system()');
      assert.equal((await c.query('SELECT * FROM vw_orders')).rowCount, 3);
      await c.query(`INSERT INTO orders VALUES ('o9', 'webhook', null, 1)`);
      await c.query('COMMIT');
    } finally { c.release(); }
    // A release adds effortless_app_all to tables with no policy; the seed's next run ignores it.
    await db.pool.query(`CREATE POLICY effortless_app_all ON settings FOR ALL TO ${db.app} USING (true) WITH CHECK (true)`);
    const { block } = await import('../server/sql.js');
    await db.ownerPool.query(block('policies', cfg));
    const pols = (await db.pool.query(`SELECT policyname FROM pg_policies WHERE tablename = 'settings' ORDER BY 1`)).rows.map((r) => r.policyname);
    assert.ok(pols.includes('ml_allow_all'), pols.join());
  } finally { await db.drop(); }
});
