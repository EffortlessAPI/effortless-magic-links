#!/usr/bin/env node
// Puts the seed into the project's rulebook, from magic-links.config.json. A dry run unless --write.
//
//   node server/magic-links/scripts/install.mjs [--rulebook <path>] [--write] [--json]
//        [--set key=value ...]                 change a setting (the mapping) in magic-links.config.json
//        [--add-users-table] [--add-roles-table]   only when nothing in the project maps (candidates.mjs)
//        [--person "email|Name|role" ...]       approved people to add (the first admin, at least)
//
// What it changes, and nothing else:
//   1. magic-links.config.json: the --set values.
//   2. The rulebook: AppUsers / AppRoles only when asked; the --person rows; and the seed's block in
//      two ERBCustomizations rows (02b-customize-functions.sql, 04b-customize-policies.sql), the
//      SQL that makes the database check sessions and enforce row-level security. The rest of each
//      row is the project's own and is kept.
//   3. Dev's seeded copies of those two rows (postgres/02b-*.sql, 04b-*.sql) when they carry the
//      seed's block, so the next build writes them again from the rows.
// It prints every change, one line each: that list IS the diff.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS, SEED_DIR, loadConfig, saveConfig, validate } from '../server/config.js';
import { ROWS, block, withBlock, currentBlock } from '../server/sql.js';
import { args, rulebookPath, findProjectRoot, toRulebookJson, pkOf, field, lower } from './lib.mjs';

const FRAGMENTS = path.join(SEED_DIR, 'rulebook');
const fragment = (file) => JSON.parse(fs.readFileSync(path.join(FRAGMENTS, file), 'utf8'));
const CUSTOMIZATIONS = {
  Description: 'SQL the rulebook\'s field model cannot express, carried with the rulebook to Dev and to every published stage (update-effortless-schema.sql). A row named for a lettered file is that file\'s SQL.',
  schema: [
    { name: 'ERBCustomizationId', datatype: 'string', type: 'raw', nullable: false, Description: 'Stable id of the customization.' },
    { name: 'Name', datatype: 'string', type: 'raw', nullable: false, Description: 'The file it becomes (02b-customize-functions.sql, 04b-customize-policies.sql, ...) or the object an override replaces.' },
    { name: 'CustomizationType', datatype: 'string', type: 'raw', nullable: true, Description: 'FunctionOverride or SchemaOverride for an override; anything for a named file.' },
    { name: 'SQLCode', datatype: 'string', type: 'raw', nullable: true, Description: 'The SQL.' },
    { name: 'SQLTarget', datatype: 'string', type: 'raw', nullable: true, Description: 'Empty or Postgres.' },
  ],
  data: [],
};

export function plan(rb, cfg, { addUsers = false, addRoles = false, people = [] } = {}) {
  const changes = []; const problems = []; const notes = [];
  const out = structuredClone(rb);

  // ---------------------------------------------------------------- the tables
  const ensureFromFragment = (name, file) => {
    const frag = fragment(file)[name];
    out[name] = structuredClone(frag);
    changes.push(`add table ${name} (${frag.schema.map((f) => f.name).join(', ')})${frag.data.length ? ` with ${frag.data.length} rows (${frag.data.map((r) => r[pkOf(frag)]).join(', ')})` : ''}`);
  };
  if (!out[cfg.usersTable]) {
    if (addUsers && cfg.usersTable === 'AppUsers') ensureFromFragment('AppUsers', 'app-users.fragment.json');
    else if (addUsers) problems.push(`--add-users-table adds AppUsers, but usersTable is ${cfg.usersTable}: --set usersTable=AppUsers (and the AppUsers field names) or map ${cfg.usersTable} to a table that exists`);
    else problems.push(`usersTable ${cfg.usersTable} is not in the rulebook. Map it to the project's table of people (candidates.mjs lists them), or pass --add-users-table when the project has none.`);
  }
  if (cfg.rolesTable && !out[cfg.rolesTable]) {
    if (addRoles && cfg.rolesTable === 'AppRoles') ensureFromFragment('AppRoles', 'app-roles.fragment.json');
    else if (addRoles) problems.push(`--add-roles-table adds AppRoles, but rolesTable is ${cfg.rolesTable}`);
    else problems.push(`rolesTable ${cfg.rolesTable} is not in the rulebook. Map it, set it blank (roles as plain text), or pass --add-roles-table.`);
  }

  // ---------------------------------------------------------------- the mapping, field by field
  const users = out[cfg.usersTable];
  const needField = (t, tableName, setting, name, { boolean = false } = {}) => {
    if (!name || !t) return null;
    const f = field(t, name);
    if (!f) { problems.push(`${setting}: ${tableName} has no field ${name} (it has ${t.schema.map((x) => x.name).join(', ')})`); return null; }
    if (boolean && f.datatype !== 'boolean') problems.push(`${setting}: ${tableName}.${name} is ${f.datatype}, not boolean`);
    return f;
  };
  if (users) {
    needField(users, cfg.usersTable, 'userKeyField', cfg.userKeyField);
    if (cfg.userKeyField && pkOf(users) !== cfg.userKeyField) notes.push(`userKeyField ${cfg.userKeyField} is not ${cfg.usersTable}'s first field (${pkOf(users)}): fine if it is unique`);
    needField(users, cfg.usersTable, 'emailField', cfg.emailField);
    needField(users, cfg.usersTable, 'nameField', cfg.nameField);
    needField(users, cfg.usersTable, 'activeField', cfg.activeField.replace(/^!\s*/, ''), { boolean: true });
    const roleF = needField(users, cfg.usersTable, 'roleField', cfg.roleField);
    if (roleF && roleF.type === 'relationship' && cfg.rolesTable && roleF.RelatedTo !== cfg.rolesTable) {
      problems.push(`roleField ${cfg.roleField} links to ${roleF.RelatedTo}, but rolesTable is ${cfg.rolesTable}`);
    }
    for (const [claim, f] of Object.entries(cfg.claims)) needField(users, cfg.usersTable, `claims.${claim}`, f);
  }
  if (cfg.rolesTable && out[cfg.rolesTable]) needField(out[cfg.rolesTable], cfg.rolesTable, 'roleKeyField', cfg.roleKeyField);
  if (cfg.userRolesTable) {
    const link = out[cfg.userRolesTable];
    if (!link) problems.push(`userRolesTable ${cfg.userRolesTable} is not in the rulebook`);
    else {
      const uf = needField(link, cfg.userRolesTable, 'userRolesUserField', cfg.userRolesUserField);
      needField(link, cfg.userRolesTable, 'userRolesRoleField', cfg.userRolesRoleField);
      if (uf && uf.type === 'relationship' && uf.RelatedTo !== cfg.usersTable) problems.push(`userRolesUserField ${cfg.userRolesUserField} links to ${uf.RelatedTo}, not ${cfg.usersTable}`);
    }
    if (cfg.roleField) problems.push('roleField and userRolesTable are both set: pick one source of roles');
  }
  if (!cfg.roleField && !cfg.userRolesTable) notes.push(`no role mapping: everyone signed in is the same and nobody holds ${cfg.adminRole}, so nobody can open the setup screen or pass "ready to publish"`);

  // ---------------------------------------------------------------- the people
  const roleKnown = (role) => {
    if (!cfg.rolesTable || !out[cfg.rolesTable]) return true;
    return out[cfg.rolesTable].data.some((r) => lower(r[cfg.roleKeyField]) === lower(role));
  };
  const active = cfg.activeField.replace(/^!\s*/, '');
  const inverted = cfg.activeField.startsWith('!');
  for (const spec of people) {
    const [emailRaw, name, roleRaw] = spec.split('|').map((s) => (s || '').trim());
    const email = lower(emailRaw);
    const role = roleRaw || cfg.adminRole;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { problems.push(`--person "${spec}": not an email address`); continue; }
    if (!users) continue;
    if (!roleKnown(role)) { problems.push(`--person "${spec}": role ${role} is not a row of ${cfg.rolesTable} (${out[cfg.rolesTable].data.map((r) => r[cfg.roleKeyField]).join(', ')})`); continue; }
    const existing = users.data.find((r) => lower(r[cfg.emailField]) === email);
    const key = existing ? existing[cfg.userKeyField || cfg.emailField] : email;
    if (!existing) {
      const row = {};
      if (cfg.userKeyField) row[cfg.userKeyField] = email;
      row[cfg.emailField] = email;
      if (cfg.nameField && field(users, cfg.nameField)?.type === 'raw') row[cfg.nameField] = name || email.split('@')[0];
      if (cfg.roleField) row[cfg.roleField] = role;
      if (active) row[active] = !inverted;
      users.data.push(row);
      changes.push(`add ${cfg.usersTable} row ${email}${cfg.roleField ? ` (${role})` : ''}`);
    } else if (cfg.roleField && lower(existing[cfg.roleField]) !== lower(role) && !String(existing[cfg.roleField] || '').split(',').map(lower).includes(lower(role))) {
      notes.push(`${email} is already in ${cfg.usersTable} with role ${existing[cfg.roleField] || '(none)'}: left as it is; change it in the setup screen or the Data tab`);
    }
    if (cfg.userRolesTable && out[cfg.userRolesTable]) {
      const link = out[cfg.userRolesTable];
      const has = link.data.some((r) => lower(r[cfg.userRolesUserField]) === lower(key) && lower(r[cfg.userRolesRoleField]) === lower(role));
      if (!has) {
        const id = `${key}-${role}`;
        link.data.push({ [pkOf(link)]: id, [cfg.userRolesUserField]: key, [cfg.userRolesRoleField]: role });
        changes.push(`add ${cfg.userRolesTable} row ${id}`);
      }
    }
  }

  // ---------------------------------------------------------------- the SQL rows
  if (!problems.length) {
    if (!out.ERBCustomizations) {
      out.ERBCustomizations = structuredClone(CUSTOMIZATIONS);
      changes.push('add table ERBCustomizations (the rulebook\'s place for SQL)');
    }
    const ct = out.ERBCustomizations;
    const pk = pkOf(ct);
    for (const kind of ['functions', 'policies']) {
      const { name, at } = ROWS[kind];
      const want = block(kind, cfg);
      const rows = ct.data.filter((r) => r.Name === name);
      if (rows.length > 1) notes.push(`${rows.length} ERBCustomizations rows are named ${name}; the build uses one. The seed's block goes in the first; merge the others into it.`);
      const row = rows[0];
      if (!row) {
        ct.data.push({ [pk]: name.replace(/\.sql$/, ''), Name: name, CustomizationType: 'Custom', SQLCode: withBlock('', want, at), SQLTarget: 'Postgres' });
        changes.push(`add ERBCustomizations row ${name} (the seed's ${kind} block)`);
      } else if (currentBlock(row.SQLCode) !== want || withBlock(row.SQLCode, want, at) !== row.SQLCode) {
        const had = currentBlock(row.SQLCode);
        row.SQLCode = withBlock(row.SQLCode, want, at);
        if (row.SQLTarget && !/^postgres$/i.test(row.SQLTarget)) notes.push(`${name}: SQLTarget is ${row.SQLTarget}; the build reads only empty or Postgres`);
        changes.push(`${had ? 'update' : 'add'} the seed's ${kind} block in ERBCustomizations row ${name}${had ? '' : ' (the project\'s own SQL in it is kept)'}`);
      }
    }
  }
  return { rulebook: out, changes, problems, notes };
}

function parseSets(values) {
  const out = {};
  for (const v of values) {
    const i = v.indexOf('=');
    if (i < 1) throw new Error(`--set ${v}: write key=value`);
    const k = v.slice(0, i).trim();
    if (!SETTINGS.some((s) => s.key === k)) throw new Error(`--set ${k}: not a setting (see effortless-seed.json; settings: ${SETTINGS.map((s) => s.key).join(', ')})`);
    out[k] = v.slice(i + 1).trim();
  }
  return out;
}

export function run(argv, { cwd = process.cwd(), seedDir = SEED_DIR, log = console.log } = {}) {
  const a = args(argv);
  const file = rulebookPath(a.value('--rulebook'), cwd);
  if (!file || !fs.existsSync(file)) throw new Error('No rulebook found: run inside the project or pass --rulebook <path to effortless-rulebook.json>');
  const sets = parseSets(a.values('--set'));
  const before = loadConfig(seedDir, {});
  const cfg = loadConfig(seedDir, {});
  for (const [k, v] of Object.entries(sets)) {
    const s = SETTINGS.find((x) => x.key === k);
    cfg[k] = s.valueType === 'number' ? Number(v) : s.valueType === 'list' ? v.split(',').map((x) => x.trim()).filter(Boolean)
      : s.valueType === 'map' ? Object.fromEntries(v.split(',').map((x) => x.trim()).filter(Boolean).map((p) => p.split('=').map((y) => y.trim()))) : v;
  }
  validate(cfg);
  const text = fs.readFileSync(file, 'utf8');
  const rb = JSON.parse(text);
  const result = plan(rb, cfg, { addUsers: a.flag('--add-users-table'), addRoles: a.flag('--add-roles-table'), people: a.values('--person') });
  const configChanges = SETTINGS.filter((s) => JSON.stringify(before[s.key]) !== JSON.stringify(cfg[s.key]))
    .map((s) => `set ${s.key} = ${JSON.stringify(cfg[s.key])} (was ${JSON.stringify(before[s.key])})`);

  // Dev's seeded copies: written once from a row, then never again, so a stale one hides a change.
  const root = findProjectRoot(path.dirname(file)) || path.dirname(path.dirname(file));
  const stale = Object.values(ROWS).map((r) => path.join(root, 'postgres', r.name))
    .filter((p) => fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('effortless-magic-links'));

  const report = {
    rulebook: path.relative(cwd, file) || file, write: a.flag('--write'),
    config: configChanges, changes: result.changes, problems: result.problems, notes: result.notes,
    staleDevFiles: stale.map((p) => path.relative(cwd, p)),
  };
  const nothing = !configChanges.length && !result.changes.length;
  if (a.flag('--write') && !result.problems.length) {
    if (configChanges.length) saveConfig(seedDir, cfg);
    if (result.changes.length) fs.writeFileSync(file, toRulebookJson(result.rulebook));
    if (result.changes.length) for (const p of stale) fs.rmSync(p);
  }
  report.next = result.problems.length ? ['Fix the problems above (candidates.mjs shows what the project has), then run this again.']
    : nothing ? ['Nothing to change. Run doctor.mjs.']
      : a.flag('--write') ? ['Rebuild (the editor\'s Rebuild, or effortless build), then run doctor.mjs.']
        : ['Dry run: say these changes to the person, then run again with --write.'];

  if (a.flag('--json')) log(JSON.stringify(report, null, 2));
  else {
    log(`${report.write ? 'Writing' : 'Dry run'}: ${report.rulebook}`);
    for (const c of report.config) log(`  config  ${c}`);
    for (const c of report.changes) log(`  rulebook  ${c}`);
    for (const p of report.staleDevFiles) log(`  delete  ${p} (Dev's copy of an old row; the next build writes it again)`);
    for (const n of report.notes) log(`  note  ${n}`);
    for (const p of report.problems) log(`  PROBLEM  ${p}`);
    for (const n of report.next) log(n);
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const r = run(process.argv.slice(2));
    process.exitCode = r.problems.length ? 1 : 0;
  } catch (e) { console.error(e.message); process.exitCode = 2; }
}
