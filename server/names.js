// Rulebook names -> the names Postgres holds. The mapping in magic-links.config.json is in
// RULEBOOK names (AppUsers, EmailAddress); the SQL this seed writes needs the physical ones.
//
// snake() MUST stay byte-identical to `snake` in rulebook-to-node-postgres-api's db.js, which
// itself mirrors SnakeCase() in rulebook-to-postgres. That tool creates the tables; a guess that
// differs is a 42P01 "relation does not exist" at sign-in, not a build error.
export const snake = (s) =>
  s
    .replace(/([A-Z]+s)([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+?)([A-Z](?!s$|s(?=[A-Z]))[a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');

export const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;
export const quoteLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** activeField may start with "!" (IsDisabled, IsArchived): active when that field is not true. */
export const parseActive = (field) => {
  const f = String(field || '').trim();
  if (!f) return null;
  return f.startsWith('!') ? { field: f.slice(1).trim(), inverted: true } : { field: f, inverted: false };
};

/** Everything the SQL and the server need, physical and rulebook, from the config. */
export function physical(cfg) {
  const col = (f) => (f ? snake(f) : null);
  const active = parseActive(cfg.activeField);
  return {
    usersTable: snake(cfg.usersTable),
    usersView: `vw_${snake(cfg.usersTable)}`,
    key: col(cfg.userKeyField),
    email: col(cfg.emailField),
    name: col(cfg.nameField),
    active: active ? { column: col(active.field), inverted: active.inverted } : null,
    role: col(cfg.roleField),
    rolesTable: cfg.rolesTable ? snake(cfg.rolesTable) : null,
    roleKey: col(cfg.roleKeyField),
    linkTable: cfg.userRolesTable ? snake(cfg.userRolesTable) : null,
    linkView: cfg.userRolesTable ? `vw_${snake(cfg.userRolesTable)}` : null,
    linkUser: col(cfg.userRolesUserField),
    linkRole: col(cfg.userRolesRoleField),
    claims: Object.entries(cfg.claims || {}).map(([claim, field]) => ({ claim, column: snake(field) })),
  };
}
