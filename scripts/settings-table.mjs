#!/usr/bin/env node
// Prints the README's settings table from effortless-seed.json, the one place settings are declared.
// After changing a setting there: node scripts/settings-table.mjs, paste it into README.md
// ("Settings"), and check-seed.mjs confirms they agree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const m = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'effortless-seed.json'), 'utf8'));
const cell = (s) => String(s).replace(/\|/g, '\\|');
console.log('| Setting | Default | Example | When | A change reaches | What it means |');
console.log('|---|---|---|---|---|---|');
for (const r of m.replacements) {
  console.log(`| \`${r.key}\` | ${r.default === '' ? '(blank)' : `\`${r.default}\``} | \`${cell(r.example)}\` | ${r.when} | ${r.affects === 'rulebook' ? 'the SQL rows: re-run install.mjs, rebuild' : 'the server: restart it'} | ${cell(r.description)} |`);
}
