#!/usr/bin/env node
// Adds this seed's rulebook tables (rulebook/*.fragment.json) to the project's rulebook.
// Dry run unless --write. Touches nothing that is already there; appends the new tables as
// text at the end of the file so the diff is only the new tables.
//
//   node scripts/merge-rulebook.mjs --rulebook ../effortless-rulebook/effortless-rulebook.json \
//        [--admin you@example.com ...] [--write]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const values = (n) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));
const rulebookPath = path.resolve(values('--rulebook')[0] || '../effortless-rulebook/effortless-rulebook.json');
const admins = values('--admin').map((e) => e.toLowerCase());

const text = fs.readFileSync(rulebookPath, 'utf8');
const rulebook = JSON.parse(text);
const dir = path.join(here, '..', 'rulebook');
const fragments = fs.readdirSync(dir).filter((f) => f.endsWith('.fragment.json'));

const line = (o) => JSON.stringify(o);
const fmt = (name, t) => {
  const rows = (arr) => arr.map((x) => `      ${line(x)}`).join(',\n');
  return `  ${line(name)}: {\n    "Description": ${line(t.Description)},\n    "schema": [\n${rows(t.schema)}\n    ],\n    "data": [${t.data.length ? '\n' + rows(t.data) + '\n    ' : ''}]\n  }`;
};

const added = []; const present = [];
for (const f of fragments) {
  const frag = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const [name, table] of Object.entries(frag)) {
    if (rulebook[name]) { present.push(name); continue; }
    if (name === 'AppUsers') {
      table.data = admins.map((email) => ({ AppUserId: email, EmailAddress: email, DisplayName: email.split('@')[0], Role: 'admin', IsActive: true }));
    }
    added.push([name, table]);
  }
}

for (const n of present) console.log(`= ${n} already in the rulebook: left alone`);
if (!added.length) { console.log('nothing to add'); process.exit(0); }
for (const [n, t] of added) console.log(`+ ${n}: ${t.schema.length} fields, ${t.data.length} rows`);
if (!admins.length) console.log('! no --admin given: nobody can sign in on beta/production until an AppUsers admin row exists');
if (!flag('--write')) { console.log('dry run: add --write to change', rulebookPath); process.exit(0); }

const end = text.lastIndexOf('}');
const out = text.slice(0, end).replace(/\s+$/, '') + ',\n' + added.map(([n, t]) => fmt(n, t)).join(',\n') + '\n}\n';
JSON.parse(out); // never write a rulebook that does not parse
fs.writeFileSync(rulebookPath, out);
console.log('written. Now run: effortless build');
