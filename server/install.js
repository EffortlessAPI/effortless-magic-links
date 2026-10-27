// Applies the SQL (idempotent, every boot) and registers which tenant the database trusts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SQL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const LOCK = 7788991;

export function fill(sql, cfg) {
  const activeExpr = cfg.activeColumn ? `coalesce(${cfg.activeColumn}, true)` : 'true';
  const map = {
    VIEW: cfg.usersView, TABLE: cfg.usersTable, EMAIL: cfg.emailColumn,
    ROLE_EXPR: cfg.roleColumn, ACTIVE_EXPR: activeExpr, ADMIN: cfg.adminRole,
  };
  return sql.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => {
    if (!(k in map)) throw new Error(`magic-links: unknown placeholder ${m}`);
    return map[k];
  });
}

const sqlFile = (name, cfg) => fill(fs.readFileSync(path.join(SQL_DIR, name), 'utf8'), cfg);

// opts: { devPublicPem, devTenant, fetchTenantPem(tenantId) }
export async function ensureSchema(pool, cfg, mode, opts = {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK]);
    if (cfg.dbVerifier !== 'canonical') await client.query(sqlFile('00-auth-core.sql', cfg));
    await client.query(sqlFile('10-approved-users.sql', cfg));
    await client.query(sqlFile('20-rls.sql', cfg));

    if (mode === 'dev') {
      const stage = await client.query(`SELECT value FROM auth.ml_settings WHERE key = 'stage'`);
      if (stage.rows[0]?.value === 'live') {
        throw new Error('magic-links: this database has been live; refusing to run in dev mode against it');
      }
      await client.query('SELECT auth.register_tenant($1, $2, true, $3)', [opts.devTenant, opts.devPublicPem, 'Dev (pick your user)']);
    } else {
      if (!cfg.tenantId) {
        throw new Error('magic-links: live mode needs a magic-link tenant: set MAGICLINK_TENANT_ID (or tenantId in magic-links.config.json)');
      }
      let pem = null;
      try { pem = await opts.fetchTenantPem(cfg.tenantId); }
      catch (e) {
        const known = await client.query('SELECT 1 FROM auth.trusted_tenants WHERE tenant_id = $1 AND is_active', [cfg.tenantId]);
        if (!known.rowCount) throw new Error(`magic-links: tenant ${cfg.tenantId} is not trusted by this database and its key could not be fetched (${e.message})`);
        console.warn(`magic-links: could not refresh tenant key (${e.message}); using the one already stored`);
      }
      if (pem) await client.query('SELECT auth.register_tenant($1, $2, false)', [cfg.tenantId, pem]);
      await client.query('SELECT auth.go_live()');
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK]); } catch { /* connection already gone */ }
    client.release();
  }
}
