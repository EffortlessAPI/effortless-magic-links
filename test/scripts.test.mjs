// The agent's tools: candidates (what could map), install (the rulebook change), doctor (is it
// wired), check-seed (is the seed complete). No database needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { candidates } from '../scripts/candidates.mjs';
import { run as install } from '../scripts/install.mjs';
import { doctor } from '../scripts/doctor.mjs';
import { checkSeed } from '../scripts/check-seed.mjs';
import { toRulebookJson } from '../scripts/lib.mjs';
import { BLOCK_START, BLOCK_END } from '../server/sql.js';
import { ROOT } from './helpers.mjs';
import * as R from './rulebooks.mjs';

// A project on disk, the way a Loops project lays it out, with the seed at server/magic-links.
function project(rulebook, { config = {}, wired = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mlproj-'));
  const seed = path.join(root, 'server', 'magic-links');
  fs.mkdirSync(seed, { recursive: true });
  fs.mkdirSync(path.join(root, 'effortless-rulebook'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.mkdirSync(path.join(root, 'server', 'src'));
  fs.writeFileSync(path.join(seed, 'magic-links.config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(root, 'effortless-rulebook', 'effortless-rulebook.json'), toRulebookJson(rulebook));
  fs.writeFileSync(path.join(root, 'server', 'package.json'), JSON.stringify({ name: 'server', type: 'module', dependencies: { express: '^4', ...(wired ? { pg: '^8' } : {}) } }));
  fs.writeFileSync(path.join(root, 'server', 'src', 'server.js'), wired
    ? "import pg from 'pg';\nimport { magicLinks } from '../magic-links/server/index.js';\nconst signIn = magicLinks({ pool: new pg.Pool() });\napp.use(signIn.middleware);\napp.use('/api', routes);\napp.use('/api', toGeneratedApi);\n"
    : "app.use('/api', routes);\napp.use('/api', toGeneratedApi);\n");
  fs.writeFileSync(path.join(root, 'app', 'index.html'), wired
    ? '<script type="module" src="/api/magic-links/ui/magic-links-ui.js"></script><ml-gate><div id="root"></div></ml-gate>'
    : '<div id="root"></div>');
  const rbFile = path.join(root, 'effortless-rulebook', 'effortless-rulebook.json');
  return {
    root, seed, rbFile,
    rb: () => JSON.parse(fs.readFileSync(rbFile, 'utf8')),
    cfg: () => JSON.parse(fs.readFileSync(path.join(seed, 'magic-links.config.json'), 'utf8')),
    install: (...argv) => install(argv, { cwd: root, seedDir: seed, log: () => {} }),
    done: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('candidates: a starter with nobody in it', () => {
  const c = candidates(R.starter());
  assert.equal(c.people.length, 0);
  assert.match(c.verdict, /--add-users-table --add-roles-table/);
});

test('candidates: volunteers sign in, neighbours are served; awkward rows are named', () => {
  const c = candidates(R.kitchen());
  assert.equal(c.people[0].table, 'Volunteers');
  assert.deepEqual(c.people[0].mapping, { usersTable: 'Volunteers', userKeyField: 'VolunteerId', emailField: 'EmailAddress', nameField: 'FullName',
    activeField: 'IsActive', roleField: 'Role', rolesTable: '', roleKeyField: '', userRolesTable: '', userRolesUserField: '', userRolesRoleField: '' });
  assert.ok(c.people[0].reasons.some((r) => /several roles/.test(r)));
  assert.ok(c.people[0].doubts.some((d) => /more than one row \(cora@kitchen.test\)/.test(d)));
  assert.ok(c.people[0].doubts.some((d) => /1 of 5 rows have no EmailAddress/.test(d)));
  assert.ok(c.people.some((p) => p.table === 'Neighbors'), 'the other table is listed, ranked lower');
});

test('candidates: the editor\'s ERBUsers beats a domain table with emails', () => {
  const c = candidates(R.erbOn());
  assert.equal(c.people[0].table, 'ERBUsers');
  assert.equal(c.people[0].mapping.roleField, 'ERBRole');
  assert.equal(c.people[0].mapping.rolesTable, 'ERBRoles');
  assert.equal(c.people[0].mapping.roleKeyField, 'ERBRoleId');
  assert.ok(!c.roleTables.some((r) => r.table === 'ERBRoleTablePermissions'));
});

test('candidates: archived, grants in a table, two email fields, a status text', () => {
  const c = candidates(R.saas());
  const m = c.people.find((p) => p.table === 'Members');
  assert.equal(c.people[0].table, 'Members');
  assert.equal(m.mapping.activeField, '!IsArchived');
  assert.equal(m.mapping.emailField, 'WorkEmail');
  assert.equal(m.mapping.userRolesTable, 'MemberPermissions');
  assert.equal(m.mapping.userRolesRoleField, 'Permission');
  assert.equal(m.mapping.rolesTable, 'Permissions');
  assert.ok(m.doubts.some((d) => /more than one email field/.test(d)));
  assert.ok(c.people.some((p) => p.table === 'Companies'), 'a billing email is not a sign-in; listed, lower');
});

test('candidates: a role on the row AND a grants table, and a second plausible table: ask', () => {
  const c = candidates(R.shop());
  const cust = c.people.find((p) => p.table === 'Customers');
  assert.ok(cust.doubts.some((d) => /which is the truth\? Ask/.test(d)));
  assert.equal(cust.mapping.activeField, '!IsDisabled');
  const staff = c.people.find((p) => p.table === 'StaffAccounts');
  assert.equal(staff.mapping.activeField, 'Enabled');
  assert.ok(staff.doubts.some((d) => /no role anywhere/.test(d)));
  assert.match(c.verdict, /Close call|likely/);
});

test('install: nothing to map, so the seed\'s own tables, the first admin and the SQL rows; a dry run writes nothing', () => {
  const p = project(R.starter());
  try {
    const before = fs.readFileSync(p.rbFile, 'utf8');
    const dry = p.install('--add-users-table', '--add-roles-table', '--person', 'Ann@Example.com|Ann|admin');
    assert.deepEqual(dry.problems, []);
    assert.equal(fs.readFileSync(p.rbFile, 'utf8'), before, 'dry run');
    assert.deepEqual(dry.changes.map((c) => c.split(' (')[0]), ['add table AppUsers', 'add table AppRoles', 'add AppUsers row ann@example.com',
      'add table ERBCustomizations', "add ERBCustomizations row 02b-customize-functions.sql", "add ERBCustomizations row 04b-customize-policies.sql"]);

    p.install('--add-users-table', '--add-roles-table', '--person', 'Ann@Example.com|Ann|admin', '--write');
    const rb = p.rb();
    assert.deepEqual(rb.AppUsers.data, [{ AppUserId: 'ann@example.com', EmailAddress: 'ann@example.com', DisplayName: 'Ann', AppRole: 'admin', IsActive: true }]);
    assert.deepEqual(rb.AppRoles.data.map((r) => r.AppRoleId), ['admin', 'member']);
    assert.equal(rb.HelloWhos.data.length, 1, 'the project\'s own tables untouched');
    const rows = Object.fromEntries(rb.ERBCustomizations.data.map((r) => [r.Name, r.SQLCode]));
    assert.match(rows['02b-customize-functions.sql'], /CREATE OR REPLACE FUNCTION auth\.sign_in/);
    assert.match(rows['04b-customize-policies.sql'], /ml_require_signed_in/);
    // Single Line Leaves, the convention every Effortless tool writes.
    assert.ok(fs.readFileSync(p.rbFile, 'utf8').includes('      { "AppUserId": "ann@example.com", "EmailAddress": "ann@example.com"'));

    const again = p.install('--add-users-table', '--add-roles-table', '--person', 'ann@example.com|Ann|admin', '--write');
    assert.deepEqual(again.changes, [], 'idempotent');
    assert.match(again.next[0], /Nothing to change/);
  } finally { p.done(); }
});

test('install: an unmapped project is refused with what it does have, and nothing is added unasked', () => {
  const p = project(R.kitchen());
  try {
    const r = p.install('--write');
    assert.ok(r.problems.some((x) => /usersTable AppUsers is not in the rulebook/.test(x)));
    assert.equal(p.rb().AppUsers, undefined);
    const bad = p.install('--set', 'usersTable=Volunteers', '--set', 'emailField=Email');
    assert.ok(bad.problems.some((x) => /Volunteers has no field Email \(it has VolunteerId, FullName, EmailAddress/.test(x)));
    assert.throws(() => p.install('--set', 'colour=red'), /not a setting/);
  } finally { p.done(); }
});

test('install: mapped onto the kitchen\'s Volunteers (role as text), the mapping saved, nothing added but the rows', () => {
  const p = project(R.kitchen());
  try {
    const sets = ['--set', 'usersTable=Volunteers', '--set', 'userKeyField=VolunteerId', '--set', 'nameField=FullName', '--set', 'roleField=Role', '--set', 'rolesTable=', '--set', 'roleKeyField='];
    const r = p.install(...sets, '--person', 'new@kitchen.test|Newbie|coordinator', '--write');
    assert.deepEqual(r.problems, []);
    assert.equal(p.cfg().usersTable, 'Volunteers');
    assert.equal(p.cfg().rolesTable, '');
    const rb = p.rb();
    assert.equal(rb.AppUsers, undefined); assert.equal(rb.AppRoles, undefined);
    assert.deepEqual(rb.Volunteers.data.at(-1), { VolunteerId: 'new@kitchen.test', EmailAddress: 'new@kitchen.test', FullName: 'Newbie', Role: 'coordinator', IsActive: true });
    const funcs = rb.ERBCustomizations.data.find((x) => x.Name === '02b-customize-functions.sql').SQLCode;
    assert.match(funcs, /FROM public\."vw_volunteers" u/);
    assert.match(funcs, /u\."full_name"/);
    // An existing person keeps their role; it is said, not changed.
    const r2 = p.install('--person', 'cora@kitchen.test|Cora|admin');
    assert.ok(r2.notes.some((n) => /cora@kitchen.test is already in Volunteers with role coordinator,driver/.test(n)));
  } finally { p.done(); }
});

test('install: the SaaS project keeps its own SQL; the seed\'s functions go first, its policies last', () => {
  const p = project(R.saas());
  try {
    const sets = ['--set', 'usersTable=Members', '--set', 'userKeyField=MemberId', '--set', 'emailField=WorkEmail', '--set', 'nameField=FullName',
      '--set', 'activeField=!IsArchived', '--set', 'roleField=', '--set', 'rolesTable=Permissions', '--set', 'roleKeyField=PermissionId',
      '--set', 'userRolesTable=MemberPermissions', '--set', 'userRolesUserField=Member', '--set', 'userRolesRoleField=Permission',
      '--set', 'adminRole=owner', '--set', 'claims=company=Company'];
    const r = p.install(...sets, '--person', 'pat@acme.test|Pat|owner', '--write');
    assert.deepEqual(r.problems, []);
    assert.ok(r.changes.includes('add MemberPermissions row m1-owner'), r.changes.join('\n'));
    assert.ok(!r.changes.some((c) => /add Members row/.test(c)), 'Pat is already a member');
    const rows = Object.fromEntries(p.rb().ERBCustomizations.data.map((x) => [x.Name, x.SQLCode]));
    const f = rows['02b-customize-functions.sql']; const pol = rows['04b-customize-policies.sql'];
    assert.ok(f.startsWith(BLOCK_START), 'functions block first');
    assert.ok(f.includes('company_of_me'), 'the project\'s function kept');
    assert.ok(pol.trimEnd().endsWith(BLOCK_END), 'policies block last');
    assert.ok(pol.startsWith('CREATE POLICY own_company'), 'the project\'s policy kept, ahead');
    assert.match(f, /NOT coalesce\(u\."is_archived", false\)/);
    assert.match(f, /ARRAY\(SELECT lr\."permission"::text FROM public\."vw_member_permissions" lr/);
    assert.equal(p.rb().ERBCustomizations.data.find((x) => x.Name === 'calc_members_name').SQLCode, 'CREATE OR REPLACE FUNCTION calc_members_name() ...', 'overrides untouched');

    // A setting change rewrites the block in place; a second run is a no-op.
    const r2 = p.install('--set', 'sessionHours=720', '--write');
    assert.deepEqual(r2.changes, ["update the seed's functions block in ERBCustomizations row 02b-customize-functions.sql"]);
    assert.match(p.rb().ERBCustomizations.data.find((x) => x.Name === '02b-customize-functions.sql').SQLCode, /now_s \+ 2592000/);
    assert.deepEqual(p.install('--write').changes, []);
  } finally { p.done(); }
});

test('install: a role that is not a row is refused; two roles sources are refused; Dev\'s stale copy is removed', () => {
  const p = project(R.erbOn());
  try {
    const sets = ['--set', 'usersTable=ERBUsers', '--set', 'userKeyField=ERBUserId', '--set', 'roleField=ERBRole', '--set', 'rolesTable=ERBRoles', '--set', 'roleKeyField=ERBRoleId'];
    const r = p.install(...sets, '--person', 'x@guild.test|X|wizard');
    assert.ok(r.problems.some((x) => /role wizard is not a row of ERBRoles \(admin, artisan\)/.test(x)));
    const two = p.install(...sets, '--set', 'userRolesTable=ERBRoleTablePermissions', '--set', 'userRolesUserField=ERBRole', '--set', 'userRolesRoleField=CRUD');
    assert.ok(two.problems.some((x) => /pick one source of roles/.test(x)));

    fs.mkdirSync(path.join(p.root, 'postgres'));
    fs.writeFileSync(path.join(p.root, 'postgres', '04b-customize-policies.sql'), '-- >>> effortless-magic-links old copy');
    fs.writeFileSync(path.join(p.root, 'postgres', '02b-customize-functions.sql'), '-- the project\'s own legacy file');
    const w = p.install(...sets, '--person', 'x@guild.test|X|artisan', '--write');
    assert.deepEqual(w.problems, []);
    assert.equal(fs.existsSync(path.join(p.root, 'postgres', '04b-customize-policies.sql')), false);
    assert.equal(fs.existsSync(path.join(p.root, 'postgres', '02b-customize-functions.sql')), true, 'not ours: left alone');
    assert.equal(p.rb().ERBUsers.data.at(-1).ERBRole, 'artisan');
  } finally { p.done(); }
});

test('doctor: says what is missing, then passes once wired', () => {
  const p = project(R.starter());
  try {
    let d = doctor({ seedDir: p.seed });
    const by = (id) => d.checks.find((c) => c.id === id);
    assert.equal(d.ok, false);
    for (const id of ['mapping', 'rows', 'server', 'pg', 'app']) assert.equal(by(id).ok, false, id);
    assert.match(by('mapping').fix, /candidates\.mjs/);
    p.done();

    const q = project(R.starter(), { wired: true });
    q.install('--add-users-table', '--add-roles-table', '--person', 'ann@example.com|Ann|admin', '--write');
    d = doctor({ seedDir: q.seed });
    assert.deepEqual(d.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.says}`), []);
    assert.equal(d.ok, true);
    // Nobody admin: caught before a publish.
    const rb = q.rb(); rb.AppUsers.data[0].AppRole = 'member';
    fs.writeFileSync(q.rbFile, toRulebookJson(rb));
    d = doctor({ seedDir: q.seed });
    assert.equal(d.checks.find((c) => c.id === 'admin').ok, false);
    q.done();
  } finally { if (fs.existsSync(p.root)) p.done(); }
});

test('check-seed: this seed is complete', () => {
  assert.deepEqual(checkSeed(ROOT), []);
});
