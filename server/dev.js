// Dev mode: a throwaway keypair stands in for the magic-link tenant. The private key never
// leaves .dev/ (gitignored); the database trusts the public half ONLY as a dev tenant, which
// a live boot deletes and a live database refuses (sql/00-auth-core.sql).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEV_TENANT = 'dev-local';
export const DEV_ADMIN_EMAIL = 'dev-admin@local.invalid';

export function loadDevKeys(dir) {
  const file = path.join(dir, '.dev', 'dev-keys.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* generate below */ }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keys = {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

export function signRs256(privatePem, claims) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${b({ alg: 'RS256', typ: 'JWT' })}.${b(claims)}`;
  return `${input}.${crypto.sign('sha256', Buffer.from(input), privatePem).toString('base64url')}`;
}

// A token shaped like one magic-links would issue, plus dev_admin for the global admin.
export function mintDevToken(keys, { email, devAdmin = false, hours = 8 }) {
  const now = Math.floor(Date.now() / 1000);
  return signRs256(keys.privatePem, {
    iss: `http://localhost/${DEV_TENANT}`, tenant_id: DEV_TENANT,
    email: String(email).toLowerCase(), iat: now, nbf: now - 5, exp: now + hours * 3600,
    ...(devAdmin ? { dev_admin: true } : {}),
  });
}
