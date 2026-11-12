// Databases shaped the way the platform runs them.
//
//   stage(): like a published stage on bases: <db>_owner owns the tables and runs the release
//            (NOSUPERUSER, NOCREATEROLE, CREATE on the database), <db>_app is what the app connects
//            as (row access only, held to row-level security). The seed's SQL is applied as the owner.
//   dev():   like Dev: everything as the superuser, which row-level security does not hold.
import crypto from 'node:crypto';
import pg from 'pg';
import { freshDb } from './helpers.mjs';
import { block } from '../server/sql.js';

// The order a build runs them: 02b (the seed's block first), then the 04b row (the project's own
// policies, then the seed's block last).
const seedSql = (cfg, projectPolicies = '') => `${block('functions', cfg)}\n${projectPolicies}\n${block('policies', cfg)}\n`;

export async function stage(name, schemaSql, cfg, projectPolicies) {
  const db = await freshDb(name);
  const dbName = db.url.split('/').pop();
  const owner = `${dbName}_owner`; const app = `${dbName}_app`;
  const pw = crypto.randomBytes(8).toString('hex');
  const su = db.pool;
  for (const r of [owner, app]) {
    await su.query(`DROP ROLE IF EXISTS ${r}`).catch(() => {});
    await su.query(`CREATE ROLE ${r} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${pw}'`);
  }
  await su.query(`GRANT CONNECT, TEMP, CREATE ON DATABASE ${dbName} TO ${owner}`);
  await su.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${app}`);
  await su.query(`ALTER SCHEMA public OWNER TO ${owner}`);
  const url = (role) => db.url.replace('://postgres@', `://${role}:${pw}@`);
  const ownerPool = new pg.Pool({ connectionString: url(owner), max: 2 });
  await ownerPool.query(schemaSql);
  await ownerPool.query(`GRANT USAGE ON SCHEMA public TO ${app};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${app};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${app};`);
  if (cfg) await ownerPool.query(seedSql(cfg, projectPolicies));
  const appPool = new pg.Pool({ connectionString: url(app), max: 4 });
  return {
    ...db, owner, app, ownerPool, appPool, url: url(app), ownerUrl: url(owner),
    async drop() {
      await ownerPool.end(); await appPool.end();
      await db.drop();
      for (const r of [owner, app]) await (async () => {
        const a = new pg.Client({ connectionString: db.url.replace(/\/[^/]*$/, '/postgres') });
        await a.connect(); await a.query(`DROP ROLE IF EXISTS ${r}`).catch(() => {}); await a.end();
      })();
    },
  };
}

export async function dev(name, schemaSql, cfg, projectPolicies) {
  const db = await freshDb(name);
  await db.pool.query(schemaSql);
  if (cfg) await db.pool.query(seedSql(cfg, projectPolicies));
  return db;
}

/** One transaction as the person holding `token`. */
export async function asPerson(pool, token, sql, params) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT auth.sign_in($1)', [token]);
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
