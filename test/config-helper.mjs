// A config from overrides, the way a project's magic-links.config.json would give it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';

export function writeConfigDir(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlcfg-'));
  fs.writeFileSync(path.join(dir, 'magic-links.config.json'), JSON.stringify(overrides));
  return dir;
}

export function loadConfigFrom(overrides = {}, env = {}) {
  const dir = writeConfigDir(overrides);
  try { return loadConfig(dir, env); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
