// /api/auth/*: the only routes this seed adds. All JSON.
import { setupReport } from './setup.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const isEmail = (v) => typeof v === 'string' && v.length <= 254 && EMAIL.test(v.trim());

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 100_000) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {
    throw Object.assign(new Error('bad json'), { status: 400 });
  }
}

export async function handleAuth(ctx, req, res, p, json) {
  const { cfg, mode, pool, tenant } = ctx;
  const { claims } = req.signIn;
  const route = `${req.method} ${p.slice('/api/auth'.length) || '/'}`;
  const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
  const adminOnly = () => {
    if (!claims) { json(res, 401, { error: 'sign_in_required', mode }); return true; }
    if (!ctx.isAdmin(claims)) { json(res, 403, { error: 'admin_only' }); return true; }
    return false;
  };

  switch (route) {
    case 'GET /session':
      return json(res, 200, {
        mode, signedIn: !!claims, simulated: !!claims?.simulated,
        user: claims ? { key: claims.sub, email: claims.email, name: claims.name, roles: claims.roles || [] } : null,
        claims: claims || null,
        admin: ctx.isAdmin(claims),
        expiresAt: claims ? new Date(claims.exp * 1000).toISOString() : null,
        tenantConfigured: tenant.configured(),
        setup: '/api/magic-links/setup',
      });

    case 'POST /logout':
      if (req.signIn.token) ctx.forget(req.signIn.token);
      ctx.clearSession(res);
      return json(res, 200, { ok: true });

    // ---------------------------------------------------------------- published stages
    case 'POST /request-code': {
      if (mode !== 'live') return json(res, 404, { error: 'not_found', hint: 'Dev signs in by picking a user: POST /api/auth/simulated/sign-in' });
      // Never mail a code to a stranger, and never say whether an address is approved.
      if (isEmail(body.email)) {
        const email = body.email.trim().toLowerCase();
        const ok = (await pool.query('SELECT auth.email_is_approved($1) AS ok', [email])).rows[0].ok;
        if (ok) await tenant.sendCode(email);
      }
      return json(res, 200, { ok: true });
    }

    case 'POST /verify-code': {
      if (mode !== 'live') return json(res, 404, { error: 'not_found' });
      const code = String(body.code || '').trim();
      if (!isEmail(body.email) || !/^\d{4,10}$/.test(code)) return json(res, 400, { error: 'email_and_code_required' });
      const email = body.email.trim().toLowerCase();
      // magic-links refuses a code it never sent, and it is never sent to an unapproved address,
      // so this answers nothing about who is approved.
      let proof;
      try { proof = await tenant.verifyCode(email, code); } catch (e) {
        return json(res, e.status === 429 ? 429 : 401, { error: 'wrong_or_expired_code' });
      }
      const proven = await tenant.verifyProof(proof.jwt || proof.token, email);
      const token = (await pool.query('SELECT auth.issue_session($1) AS t', [proven])).rows[0].t;
      if (!token) return json(res, 403, { error: 'not_approved' });
      ctx.setSession(res, token);
      return json(res, 200, { ok: true, token });
    }

    // ---------------------------------------------------------------- Dev
    case 'GET /simulated/users': {
      if (mode !== 'dev') return json(res, 404, { error: 'not_found' });
      const rows = (await pool.query('SELECT user_key, email, name, roles FROM auth.simulated_users()')).rows;
      return json(res, 200, { users: rows.map((r) => ({ key: r.user_key, email: r.email, name: r.name, roles: r.roles || [] })) });
    }

    case 'POST /simulated/sign-in': {
      if (mode !== 'dev') return json(res, 404, { error: 'not_found' });
      if (!isEmail(body.email)) return json(res, 400, { error: 'email_required' });
      const token = (await pool.query('SELECT auth.issue_simulated_session($1) AS t', [body.email.trim().toLowerCase()])).rows[0].t;
      if (!token) return json(res, 403, { error: 'not_approved', hint: 'Only active people in the table of people can sign in, in Dev too.' });
      ctx.setSession(res, token);
      return json(res, 200, { ok: true, token });
    }

    // ---------------------------------------------------------------- the setup screen
    case 'GET /setup':
      if (adminOnly()) return undefined;
      return json(res, 200, await setupReport(ctx, req));

    case 'POST /setup/test-code': {
      if (adminOnly()) return undefined;
      await tenant.sendCode(claims.email);
      return json(res, 200, { ok: true, sentTo: claims.email });
    }

    case 'POST /setup/test-verify': {
      if (adminOnly()) return undefined;
      const code = String(body.code || '').trim();
      if (!/^\d{4,10}$/.test(code)) return json(res, 400, { error: 'code_required' });
      let proof;
      try { proof = await tenant.verifyCode(claims.email, code); } catch { return json(res, 401, { error: 'wrong_or_expired_code' }); }
      const proven = await tenant.verifyProof(proof.jwt || proof.token, claims.email);
      return json(res, 200, { ok: true, proven, note: 'The tenant sends and verifies codes for this project. No session was issued.' });
    }

    default:
      return json(res, 404, { error: 'not_found' });
  }
}
