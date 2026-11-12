#!/usr/bin/env node
// For the seed's AUTHOR: is the seed complete enough to publish? The same checks belong in every
// seed (effortless-seeds/SEED-MANIFEST.md, "check-seed"); copy this file, keep it identical.
//
//   node scripts/check-seed.mjs [seed folder]     exit code 1 on any problem
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkSeed(dir) {
  const problems = [];
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const has = (f) => fs.existsSync(path.join(dir, f));
  let m;
  try { m = JSON.parse(read('effortless-seed.json')); } catch (e) { return [`effortless-seed.json: ${e.message}`]; }
  if (!has('effortless.json')) problems.push('effortless.json is missing (a seed needs it at the root)');

  for (const k of ['id', 'version', 'displayName', 'tagline', 'description', 'kind', 'category']) if (!m.seed?.[k]) problems.push(`seed.${k} is missing`);
  if (m.seed?.version && !/^\d+\.\d+\.\d+$/.test(m.seed.version)) problems.push(`seed.version ${m.seed.version} is not x.y.z`);
  if (m.seed?.kind === 'child' && !m.seed.mountPath) problems.push('an add-in (kind child) needs seed.mountPath');
  if (!has('CHANGELOG.md') || (m.seed?.version && !read('CHANGELOG.md').includes(m.seed.version))) problems.push(`CHANGELOG.md has no entry for ${m.seed?.version}`);

  const keys = new Set();
  for (const r of m.replacements || []) {
    if (keys.has(r.key)) problems.push(`replacements: ${r.key} twice`);
    keys.add(r.key);
    for (const k of ['key', 'label', 'description', 'valueType', 'when']) if (r[k] === undefined || r[k] === '') problems.push(`replacements.${r.key || '?'}: ${k} is missing`);
    if (!('default' in r)) problems.push(`replacements.${r.key}: no default (every setting needs one, "" included)`);
    if (!('example' in r)) problems.push(`replacements.${r.key}: no example`);
    if (r.when && !['install', 'any time'].includes(r.when)) problems.push(`replacements.${r.key}: when is "install" or "any time"`);
  }

  // Every config key is a declared setting, and every setting is in the config as its $token$.
  const configs = fs.readdirSync(dir).filter((f) => f.endsWith('.config.json'));
  for (const c of configs) {
    const cfg = JSON.parse(read(c));
    for (const k of Object.keys(cfg)) if (!keys.has(k)) problems.push(`${c}: ${k} is not declared in replacements`);
    for (const k of keys) if (!(k in cfg)) problems.push(`${c}: setting ${k} is missing`);
    for (const [k, v] of Object.entries(cfg)) if (v !== `$${k}$`) problems.push(`${c}: ${k} should be "$${k}$" in the published seed (answers replace it)`);
  }

  // The README's settings table lists every setting with its default.
  if (!has('README.md')) problems.push('README.md is missing');
  else {
    const readme = read('README.md');
    for (const r of m.replacements || []) {
      const row = readme.split('\n').find((l) => l.startsWith(`| \`${r.key}\``));
      if (!row) problems.push(`README.md: no settings row for ${r.key}`);
      else if (r.default !== '' && !row.includes(r.default)) problems.push(`README.md: the ${r.key} row does not show its default ${r.default}`);
    }
  }

  // The agent's instructions: every step says how to know it worked.
  for (const [k, f] of Object.entries(m.agent || {})) {
    if (!/\.md$/.test(f)) continue;
    if (!has(f)) { problems.push(`agent.${k}: ${f} is missing`); continue; }
    const steps = read(f).split(/\n(?=## \d)/).slice(1);
    if (!steps.length) problems.push(`${f}: no numbered steps (## 1. ...)`);
    for (const s of steps) if (!/Works when/.test(s)) problems.push(`${f}: step "${s.split('\n')[0].slice(3)}" has no "Works when"`);
  }
  if (!m.agent?.integrate) problems.push('agent.integrate is missing (the engine\'s instructions)');
  if (m.setup?.path && !m.setup.path.startsWith('/')) problems.push('setup.path starts with /');
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const problems = checkSeed(dir);
  for (const p of problems) console.log(`PROBLEM ${p}`);
  console.log(problems.length ? `\n${problems.length} problem(s): not ready to publish.` : 'The seed is complete.');
  process.exitCode = problems.length ? 1 : 0;
}
