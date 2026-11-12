#!/usr/bin/env node
// Which tables and fields in this project could the seed map onto? Prints a short, ranked answer
// (never the rulebook itself) for the agent to decide from, with the reasons and the doubts.
//
//   node server/magic-links/scripts/candidates.mjs [--rulebook <path>] [--json]
//
// It does not decide. Two tables of people, a role kept as text in one and as a link in another, an
// "archived" flag instead of an "active" one: those are for the agent (and, when it is not clear,
// the person) to settle. The answer ends with a suggested --set line for install.mjs.
import fs from 'node:fs';
import { args, rulebookPath, tables, pkOf, field } from './lib.mjs';

const PEOPLE = /(user|member|person|people|staff|employee|volunteer|customer|contact|account|player|student|teacher|patient|client|admin|owner|participant|attendee|agent|operator)/i;
const ROLES = /(role|position|permission|access|group|persona|tier|level)/i;
const EMAIL = /e-?mail/i;
const NAME = /^(display_?name|full_?name|name|first_?name|title|label)$/i;
const ACTIVE = /^(is_?)?(active|enabled|approved|allowed|verified)$/i;
const INACTIVE = /^(is_?)?(archived|disabled|deleted|blocked|suspended|banned|inactive|deactivated|removed)$/i;
const ROLE_FIELD = /^(role|roles|user_?role|app_?role|erb_?role|position|access_?level|permission|group|persona)$/i;

export function candidates(rb) {
  const all = tables(rb);
  const roleTables = all.filter(([n]) => ROLES.test(n) && !/^ERB(Role(Table|Field)Permissions)$/.test(n))
    .map(([n, t]) => ({ table: n, key: pkOf(t), rows: t.data.length, sample: t.data.slice(0, 5).map((r) => r[pkOf(t)]) }));

  const people = [];
  for (const [name, t] of all) {
    if (/^ERB(?!Users$)/.test(name) || name === '__meta__') continue;
    const fields = t.schema;
    const emails = fields.filter((f) => EMAIL.test(f.name) && (f.datatype || 'string') === 'string');
    if (!emails.length) continue;
    const reasons = []; const doubts = [];
    let score = 0;
    if (PEOPLE.test(name)) { score += 3; reasons.push(`the name "${name}" reads like people`); }
    if (name === 'ERBUsers') { score += 4; reasons.push('the editor\'s own table of people (Users and roles module)'); }
    score += 2; reasons.push(`has ${emails.map((f) => f.name).join(', ')}`);
    if (emails.length > 1) doubts.push(`more than one email field (${emails.map((f) => f.name).join(', ')}): which one do they sign in with?`);
    const emailRank = (f) => (/^(email|e_?mail_?address|email_?address)$/i.test(f.name) ? 0 : /work|login|primary/i.test(f.name) ? 1 : 2);
    const email = [...emails].sort((a, b) => emailRank(a) - emailRank(b))[0];

    const active = fields.find((f) => ACTIVE.test(f.name) && f.datatype === 'boolean');
    const inactive = fields.find((f) => INACTIVE.test(f.name) && f.datatype === 'boolean');
    const status = fields.find((f) => /^status$/i.test(f.name));
    let activeField = '';
    if (active) { activeField = active.name; reasons.push(`${active.name} says who is active`); }
    else if (inactive) { activeField = `!${inactive.name}`; reasons.push(`${inactive.name} is true for people NOT allowed: map it as !${inactive.name}`); }
    else if (status) doubts.push(`no active flag; ${status.name} is text: add a calculated boolean (IsActive = ${status.name} = "Active") with the person's yes, or leave activeField blank (everyone active)`);
    else doubts.push('no active flag: leave activeField blank (every row can sign in) unless the person wants one');

    const roleRel = fields.find((f) => f.type === 'relationship' && roleTables.some((r) => r.table === f.RelatedTo));
    const roleText = fields.find((f) => ROLE_FIELD.test(f.name) && f.type !== 'relationship');
    const grants = all.filter(([gn, gt]) => gn !== name && gt.schema.some((f) => f.type === 'relationship' && f.RelatedTo === name)
      && gt.schema.some((f) => ROLE_FIELD.test(f.name) || (f.type === 'relationship' && roleTables.some((r) => r.table === f.RelatedTo))));
    let roles = { roleField: '', rolesTable: '', roleKeyField: '', userRolesTable: '', userRolesUserField: '', userRolesRoleField: '' };
    if (roleRel) {
      roles = { ...roles, roleField: roleRel.name, rolesTable: roleRel.RelatedTo, roleKeyField: pkOf(rb[roleRel.RelatedTo]) };
      reasons.push(`${roleRel.name} links to ${roleRel.RelatedTo}`);
      score += 1;
    } else if (roleText) {
      roles.roleField = roleText.name;
      const values = [...new Set(t.data.map((r) => r[roleText.name]).filter(Boolean))].slice(0, 8);
      reasons.push(`${roleText.name} holds the role as text${values.length ? ` (${values.join(', ')})` : ''}`);
      if (values.some((v) => String(v).includes(','))) reasons.push('some rows hold several roles, comma-separated: supported');
      score += 1;
    }
    if (grants.length) {
      const [gn, gt] = grants[0];
      const userF = gt.schema.find((f) => f.type === 'relationship' && f.RelatedTo === name);
      const roleF = gt.schema.find((f) => f.type === 'relationship' && roleTables.some((r) => r.table === f.RelatedTo)) || gt.schema.find((f) => ROLE_FIELD.test(f.name));
      const msg = `${gn} grants roles to ${name} (${userF.name} -> ${roleF.name})`;
      if (roles.roleField) doubts.push(`${msg} AND ${roles.roleField} holds a role on the row: which is the truth? Ask.`);
      else {
        roles = { ...roles, userRolesTable: gn, userRolesUserField: userF.name, userRolesRoleField: roleF.name,
          rolesTable: roleF.type === 'relationship' ? roleF.RelatedTo : '', roleKeyField: roleF.type === 'relationship' ? pkOf(rb[roleF.RelatedTo]) : '' };
        reasons.push(msg);
      }
      score += 1;
    }
    if (!roles.roleField && !roles.userRolesTable) doubts.push('no role anywhere: everyone signed in is the same, and nobody is admin until a role field exists (ask before adding one)');

    const nameF = fields.find((f) => NAME.test(f.name) && f.name !== 'Name' && f.type === 'raw') || fields.find((f) => f.name === 'Name');
    const withEmail = t.data.filter((r) => r[email.name]);
    const emailsLower = withEmail.map((r) => String(r[email.name]).toLowerCase());
    const dupes = [...new Set(emailsLower.filter((e, i) => emailsLower.indexOf(e) !== i))];
    if (dupes.length) doubts.push(`${dupes.length} address(es) on more than one row (${dupes.slice(0, 3).join(', ')}): the active row wins at sign-in`);
    if (t.data.length && withEmail.length < t.data.length) doubts.push(`${t.data.length - withEmail.length} of ${t.data.length} rows have no ${email.name}: they cannot sign in`);
    if (field(t, email.name)?.type !== 'raw' && field(t, email.name)?.type) doubts.push(`${email.name} is ${field(t, email.name).type}, not typed in: fine to read, but the setup screen cannot edit it`);

    people.push({
      table: name, score, rows: t.data.length, reasons, doubts,
      mapping: { usersTable: name, userKeyField: pkOf(t), emailField: email.name, nameField: nameF ? nameF.name : '', activeField, ...roles },
    });
  }
  people.sort((a, b) => b.score - a.score || b.rows - a.rows);
  const out = { people: people.slice(0, 5), roleTables, verdict: '' };
  if (!people.length) out.verdict = 'No table with an email field: nothing to map. install.mjs --add-users-table --add-roles-table adds AppUsers and AppRoles (say so to the person first).';
  else if (people.length > 1 && people[0].score - people[1].score < 2) out.verdict = `Close call between ${people[0].table} and ${people[1].table}: ask the person which one holds the people who sign in.`;
  else out.verdict = `${people[0].table} is the likely table of people.`;
  if (people[0]) {
    const m = people[0].mapping;
    out.suggested = `node server/magic-links/scripts/install.mjs ${Object.entries(m).map(([k, v]) => `--set ${k}=${v}`).join(' ')}`;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = args();
  const file = rulebookPath(a.value('--rulebook'));
  if (!file || !fs.existsSync(file)) { console.error('No rulebook found: pass --rulebook <path to effortless-rulebook.json>'); process.exit(2); }
  const out = candidates(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (a.flag('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
  console.log(out.verdict);
  for (const p of out.people) {
    console.log(`\n${p.table} (score ${p.score}, ${p.rows} rows)`);
    for (const r of p.reasons) console.log(`  + ${r}`);
    for (const d of p.doubts) console.log(`  ? ${d}`);
    console.log(`  mapping: ${Object.entries(p.mapping).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  if (out.roleTables.length) console.log(`\nRole tables: ${out.roleTables.map((r) => `${r.table} (${r.sample.join(', ')})`).join('; ')}`);
  if (out.suggested) console.log(`\nSuggested (dry run first):\n  ${out.suggested}`);
}
