#!/usr/bin/env node
// Applies the auth SQL and the row-level-security defaults to a database WITHOUT starting the API.
// The API does the same on every boot; run this after `effortless build` when you want the
// database ready before anything starts (CI, a migration, a base on bases.effortlessapi.com).
//
//   PGHOST=... PGDATABASE=... node scripts/install.mjs [--api ../backend/api]
//
// Mode comes from the same place as the server: dev unless NODE_ENV=production / EFFORTLESS_STAGE=beta|production.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveMode } from '../server/config.js';
import { loadDevKeys } from '../server/dev.js';
import { ensureSchema } from '../server/install.js';
import { magicLinkClient } from '../server/magiclink.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const seedDir = path.resolve(here, '..');
const i = process.argv.indexOf('--api');
const candidates = [i > 0 && process.argv[i + 1], '../backend/api', '../api', '.'].filter(Boolean)
  .map((p) => path.resolve(process.cwd(), p));
const apiDir = candidates.find((d) => fs.existsSync(path.join(d, 'node_modules', 'pg')));
if (!apiDir) { console.error('cannot find the pg module; pass --api <the generated api folder, after npm install>'); process.exit(2); }
const pg = createRequire(path.join(apiDir, 'package.json'))('pg');

const mode = resolveMode();
const cfg = loadConfig(seedDir);
const client = magicLinkClient(cfg.baseUrl);
const pool = new pg.Pool({ max: 2 });
try {
  await ensureSchema(pool, cfg, mode, {
    devPublicPem: mode === 'dev' ? loadDevKeys(seedDir).publicPem : undefined, devTenant: 'dev-local',
    fetchTenantPem: async (id) => (await client.tenantInfo(id)).public_key_pem,
  });
  console.log(`magic-links installed (${mode} mode)`);
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { await pool.end(); }
