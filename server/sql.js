// The seed's SQL for one project: the two templates in sql/ with the mapping filled in. The install
// script writes the result into the rulebook's ERBCustomizations rows; the doctor compares them.
import fs from 'node:fs';
import path from 'node:path';
import { SEED_DIR } from './config.js';
import { physical, quoteIdent as q, quoteLiteral as lit } from './names.js';

export const BLOCK_START = '-- >>> effortless-magic-links';
export const BLOCK_END = '-- <<< effortless-magic-links';
// Where the block sits in its row. 02b: first, because a project function written in SQL may call
// app.claim() and SQL bodies are checked when created. 04b: last, so it sees every policy the
// project's own SQL made and never adds ml_allow_all beside one.
export const ROWS = {
  functions: { name: '02b-customize-functions.sql', template: '02b-auth.sql', at: 'start' },
  policies: { name: '04b-customize-policies.sql', template: '04b-policies.sql', at: 'end' },
};

export function placeholders(cfg) {
  const p = physical(cfg);
  const u = (c) => `u.${q(c)}`;
  const emailExpr = u(p.email);
  const keyExpr = p.key ? u(p.key) : `lower(${emailExpr}::text)`;
  const activeExpr = !p.active ? 'true'
    : p.active.inverted ? `NOT coalesce(${u(p.active.column)}, false)` : `coalesce(${u(p.active.column)}, true)`;
  let rolesExpr = 'ARRAY[]::text[]';
  if (p.linkTable) {
    rolesExpr = `ARRAY(SELECT lr.${q(p.linkRole)}::text FROM public.${q(p.linkView)} lr WHERE lr.${q(p.linkUser)}::text = (${keyExpr})::text AND lr.${q(p.linkRole)} IS NOT NULL ORDER BY 1)`;
  } else if (p.role) {
    rolesExpr = `array_remove(string_to_array(replace(coalesce(${u(p.role)}::text, ''), ' ', ''), ','), '')`;
  }
  const claimsExpr = p.claims.length
    ? `jsonb_build_object(${p.claims.map((c) => `${lit(c.claim)}, ${u(c.column)}`).join(', ')})`
    : `'{}'::jsonb`;
  return {
    USERS_VIEW: q(p.usersView),
    KEY_EXPR: keyExpr,
    EMAIL_EXPR: emailExpr,
    NAME_EXPR: p.name ? u(p.name) : emailExpr,
    ACTIVE_EXPR: activeExpr,
    ROLES_EXPR: rolesExpr,
    CLAIMS_EXPR: claimsExpr,
    ADMIN_ROLE: lit(cfg.adminRole),
    SESSION_SECONDS: String(Math.round(cfg.sessionHours * 3600)),
    USERS_TABLE_LITERAL: lit(p.usersTable),
    ROLES_TABLE_LITERAL: p.rolesTable ? lit(p.rolesTable) : 'NULL',
    LINK_TABLE_LITERAL: p.linkTable ? lit(p.linkTable) : 'NULL',
    OWN_ROW_EXPR: p.key ? `${q(p.key)}::text = app.user_key()` : `lower(${q(p.email)}::text) = app.jwt_email()`,
    OWN_LINK_EXPR: p.linkTable ? `${q(p.linkUser)}::text = app.user_key()` : 'false',
  };
}

export function fill(template, map) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => {
    if (!(k in map)) throw new Error(`magic-links: unknown placeholder ${m}`);
    return map[k];
  });
}

const read = (file) => fs.readFileSync(path.join(SEED_DIR, 'sql', file), 'utf8');

/** The seed's block for one ERBCustomizations row, between its markers. */
export function block(kind, cfg) {
  const row = ROWS[kind];
  const sql = fill(read(row.template), placeholders(cfg)).trimEnd();
  return `${BLOCK_START} (${row.name}; written by server/magic-links/scripts/install.mjs from magic-links.config.json: change the config and re-run it, never edit here)\n${sql}\n${BLOCK_END}`;
}

/** The row's SQL without the seed's block. */
export function withoutBlock(existing) {
  const text = existing || '';
  const start = text.indexOf(BLOCK_START);
  if (start < 0) return text;
  const end = text.indexOf(BLOCK_END, start);
  if (end < 0) throw new Error('magic-links: the row has the seed\'s start marker but no end marker; fix it by hand');
  return (text.slice(0, start).trimEnd() + '\n' + text.slice(end + BLOCK_END.length).trimStart()).trim();
}

/** Put the seed's block into a row's SQL, at the start or the end (ROWS[kind].at), replacing the old one. */
export function withBlock(existing, newBlock, at = 'end') {
  const rest = withoutBlock(existing).trim();
  if (!rest) return `${newBlock}\n`;
  return at === 'start' ? `${newBlock}\n\n${rest}\n` : `${rest}\n\n${newBlock}\n`;
}

/** The block currently in a row's SQL, or null. */
export function currentBlock(existing) {
  const text = existing || '';
  const start = text.indexOf(BLOCK_START);
  if (start < 0) return null;
  const end = text.indexOf(BLOCK_END, start);
  return end < 0 ? null : text.slice(start, end + BLOCK_END.length);
}

/** Both blocks, for tests and the doctor. */
export const allSql = (cfg) => `${block('functions', cfg)}\n${block('policies', cfg)}\n`;
