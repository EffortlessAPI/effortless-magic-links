// Shared by the scripts: finding the project, reading and writing its rulebook in the convention
// every Effortless tool writes ("Standard JSON + Single Line Leaves": each field and each row on
// one line), and the queries the scripts ask of it. Nothing here reads the whole rulebook into a
// prompt: the scripts answer narrow questions about it.
import fs from 'node:fs';
import path from 'node:path';

export const args = (argv = process.argv.slice(2)) => {
  const flag = (n) => argv.includes(n);
  const values = (n) => argv.flatMap((a, i) => (a === n && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
  const value = (n) => values(n)[0];
  return { flag, values, value };
};

/** The project root: the nearest folder above `from` holding effortless-rulebook/effortless-rulebook.json. */
export function findProjectRoot(from = process.cwd()) {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'effortless-rulebook', 'effortless-rulebook.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function rulebookPath(explicit, from) {
  if (explicit) return path.resolve(explicit);
  const root = findProjectRoot(from);
  return root ? path.join(root, 'effortless-rulebook', 'effortless-rulebook.json') : null;
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export const isTable = (v) => isPlainObject(v) && Array.isArray(v.schema) && Array.isArray(v.data);
export const tables = (rb) => Object.entries(rb).filter(([, v]) => isTable(v));

const oneLine = (v) => {
  const keys = Object.keys(v);
  if (!keys.length) return '{}';
  return `{ ${keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(v[k])}`).join(', ')} }`;
};
const renderArray = (arr, indent) => {
  if (!arr.length) return '[]';
  const inner = indent + '  ';
  return '[\n' + arr.map((item) => inner + (isPlainObject(item) ? oneLine(item) : JSON.stringify(item))).join(',\n') + '\n' + indent + ']';
};
const renderTable = (table, indent) => {
  const inner = indent + '  ';
  return '{\n' + Object.entries(table).map(([key, value]) => (key === 'schema' || key === 'data'
    ? `${inner}${JSON.stringify(key)}: ${renderArray(value, inner)}`
    : `${inner}${JSON.stringify(key)}: ${JSON.stringify(value)}`)).join(',\n') + '\n' + indent + '}';
};
/** The same output as www-rulebook-server's toRulebookJson (rulebook-drops/serialize.js). */
export const toRulebookJson = (rb) => '{\n' + Object.entries(rb).map(([key, value]) => (isTable(value)
  ? `  ${JSON.stringify(key)}: ${renderTable(value, '  ')}`
  : `  ${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replace(/\n/g, '\n  ')}`)).join(',\n') + '\n}\n';

export const pkOf = (table) => (table.schema[0] ? table.schema[0].name : null);
export const field = (table, name) => table.schema.find((f) => f.name === name) || null;
export const lower = (s) => String(s ?? '').trim().toLowerCase();
