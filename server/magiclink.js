// magiclink.effortlessapi.com: the notary. It answers one narrow question, "did this email return
// the six-digit code within five minutes", as an RS256 token signed by the project's tenant. No
// users, no roles. The project's server checks that token HERE, once, and drops it; who the person
// is in this app is the project's own table of people (auth.issue_session).
import crypto from 'node:crypto';

const j = async (res) => { try { return await res.json(); } catch { return {}; } };

// A developer's own sign-in at magiclink (to create or change a tenant without the platform) is
// behind a proof-of-work puzzle: find the number where SHA-256(salt + number) is the challenge.
// Well under a second; each answer works once.
export function solveChallenge({ salt, challenge, maxnumber, signature }) {
  for (let number = 0; number <= maxnumber; number++) {
    if (crypto.createHash('sha256').update(salt + number).digest('hex') === challenge) {
      return Buffer.from(JSON.stringify({ salt, number, challenge, signature })).toString('base64');
    }
  }
  throw new Error('magic-links sent a puzzle with no answer');
}

export function tenantClient(cfg, fetchImpl = globalThis.fetch) {
  const base = cfg.magicLinkBaseUrl;
  const id = () => {
    if (!cfg.tenantId) throw Object.assign(new Error('no magic-link tenant is configured (MAGICLINK_TENANT_ID or tenantId)'), { status: 409, code: 'no_tenant' });
    return encodeURIComponent(cfg.tenantId);
  };
  const call = async (method, url, body, token) => {
    const res = await fetchImpl(base + url, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await j(res);
    if (!res.ok) throw Object.assign(new Error(data.error || data.message || `magic-links answered ${res.status}`), { status: res.status, data });
    return data;
  };

  let key = null; // { pem, until }
  const publicKey = async ({ fresh = false } = {}) => {
    if (!fresh && key && key.until > Date.now()) return key.pem;
    const info = await call('GET', `/api/tenants/${id()}`);
    if (!info.public_key_pem) throw new Error('the tenant answered without a public key');
    key = { pem: info.public_key_pem, until: Date.now() + 10 * 60 * 1000 };
    return key.pem;
  };

  /** The proven, lower-cased email, or an error. Checks signature, tenant, issuer, expiry, email. */
  const verifyProof = async (token, expectedEmail) => {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw Object.assign(new Error('the magic-links token is malformed'), { status: 401 });
    let header; let claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { throw Object.assign(new Error('the magic-links token is malformed'), { status: 401 }); }
    if (header.alg !== 'RS256') throw Object.assign(new Error('the magic-links token is not RS256'), { status: 401 });
    const check = (pem) => crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), pem, Buffer.from(parts[2], 'base64url'));
    let ok = check(await publicKey());
    if (!ok) ok = check(await publicKey({ fresh: true })); // the tenant's key may have been rotated
    if (!ok) throw Object.assign(new Error('the magic-links token is not signed by this project\'s tenant'), { status: 401 });
    if (claims.tenant_id !== cfg.tenantId || !String(claims.iss || '').endsWith(cfg.tenantId)) {
      throw Object.assign(new Error('the magic-links token is for another tenant'), { status: 401 });
    }
    const now = Date.now() / 1000;
    if (!claims.exp || claims.exp <= now) throw Object.assign(new Error('the magic-links token has expired'), { status: 401 });
    const email = String(claims.email || '').toLowerCase();
    if (!email || (expectedEmail && email !== String(expectedEmail).toLowerCase())) {
      throw Object.assign(new Error('the magic-links token is for another address'), { status: 401 });
    }
    return email;
  };

  return {
    configured: () => !!cfg.tenantId,
    info: () => call('GET', `/api/tenants/${id()}`),
    publicKey,
    sendCode: (email) => call('POST', `/api/tenants/${id()}/send-code`, { email }),
    verifyCode: (email, code) => call('POST', `/api/tenants/${id()}/verify-code`, { email, code }),
    // The Sign in button in the code email (the tenant's login_url, ?ml=<token>&email=<address>).
    verifyLink: (email, token) => call('POST', `/api/tenants/${id()}/verify-link`, { email, token }),
    verifyProof,
    // A developer managing their own tenant (not on Effortless, where the platform owns it).
    selfSend: async (email) => call('POST', '/auth/send-code', { email, captcha_token: solveChallenge(await call('GET', '/auth/challenge')) }),
    selfVerify: (email, code) => call('POST', '/auth/verify-code', { email, code }),
    createTenant: (token, body) => call('POST', '/api/tenants', body, token),
    patchTenant: (token, body) => call('PATCH', `/api/tenants/${id()}`, body, token),
  };
}
