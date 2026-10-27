// /auth/*  The only routes this seed adds. All JSON.
import { saveConfig } from './config.js';
import { DEV_ADMIN_EMAIL, mintDevToken } from './dev.js';
import { runAs } from './identity.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const isEmail = (v) => typeof v === 'string' && v.length <= 254 && EMAIL.test(v);

async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 100_000) throw Object.assign(new Error('body too large'), { status: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

export function mountRoutes(ctx) {
  const { app, pool, cfg, mode } = ctx;
  const raw = pool.__raw.query;
  const route = (method, p, handler, { admin = false, devOnly = false, liveOnly = false } = {}) => {
    app[method](`/auth${p}`, async (req, res) => {
      try {
        if (devOnly && mode !== 'dev') return res.status(404).json({ error: 'not_found' });
        if (liveOnly && mode !== 'live') return res.status(404).json({ error: 'not_found' });
        if (admin) {
          const u = req.ml?.user;
          if (!u) return res.status(401).json({ error: 'unauthenticated' });
          if (!(u.role || '').toLowerCase().split(',').map((s) => s.trim()).includes(cfg.adminRole.toLowerCase())) {
            return res.status(403).json({ error: 'admin_only' });
          }
        }
        await handler(req, res, await body(req));
      } catch (e) {
        res.status(e.status && e.status < 600 ? e.status : 500).json({ error: e.data?.error || e.message });
      }
    });
  };
  const asCaller = (req, fn) => runAs({ token: req.ml.token }, fn);

  // ------------------------------------------------------------------ everyone
  route('get', '/session', async (req, res) => {
    const u = req.ml.user;
    res.json({
      mode, authenticated: !!(u && u.approved), email: u?.email ?? null, role: u?.role ?? null,
      admin: !!u && (u.role || '').toLowerCase().split(',').map((s) => s.trim()).includes(cfg.adminRole.toLowerCase()),
      picked: req.ml.picked, devAdmin: !!u?.devAdmin,
      tenantConfigured: !!cfg.tenantId,
    });
  });

  route('post', '/logout', async (req, res) => { ctx.clearCookie(res); res.json({ ok: true }); });

  // ------------------------------------------------------------------ live: real magic links
  route('post', '/request-code', async (req, res, b) => {
    // Never mail a code to a stranger, and never say whether an address is approved.
    if (isEmail(b.email)) {
      const ok = (await raw('SELECT app.ml_is_email_approved($1) AS ok', [b.email])).rows[0].ok;
      if (ok) await ctx.client.sendCode(cfg.tenantId, b.email.toLowerCase());
    }
    res.json({ ok: true });
  }, { liveOnly: true });

  route('post', '/verify-code', async (req, res, b) => {
    if (!isEmail(b.email) || !/^\d{4,10}$/.test(String(b.code || ''))) return res.status(400).json({ error: 'email_and_code_required' });
    if (!(await raw('SELECT app.ml_is_email_approved($1) AS ok', [b.email])).rows[0].ok) {
      return res.status(403).json({ error: 'not_approved' });
    }
    const out = await ctx.client.verifyCode(cfg.tenantId, b.email.toLowerCase(), String(b.code));
    const who = await ctx.read(out.jwt);                       // the DATABASE checks the signature
    if (!who || !who.approved) return res.status(403).json({ error: 'not_approved' });
    ctx.setCookie(res, out.jwt, out.expires_in || 3600);
    res.json({ ok: true, email: who.email, role: who.role, token: out.jwt, expires_in: out.expires_in });
  }, { liveOnly: true });

  // ------------------------------------------------------------------ dev: pick your user
  route('get', '/dev/users', async (req, res) => {
    const rows = (await raw(`SELECT ${cfg.emailColumn} AS email, ${cfg.roleColumn} AS role
                               FROM public.${cfg.usersView} ${cfg.activeColumn ? `WHERE coalesce(${cfg.activeColumn}, true)` : ''}
                              ORDER BY 1`).catch(() => ({ rows: [] }))).rows;
    res.json({ users: [{ email: DEV_ADMIN_EMAIL, role: cfg.adminRole, devAdmin: true }, ...rows] });
  }, { devOnly: true });

  route('post', '/dev/login', async (req, res, b) => {
    const admin = b.admin === true;
    if (!admin) {
      if (!isEmail(b.email)) return res.status(400).json({ error: 'email_required' });
      if (!(await raw('SELECT app.ml_is_email_approved($1) AS ok', [b.email])).rows[0].ok) {
        return res.status(403).json({ error: 'not_approved' });   // no registration, even in dev
      }
    }
    const token = mintDevToken(ctx.devKeys, { email: admin ? DEV_ADMIN_EMAIL : b.email, devAdmin: admin, hours: cfg.devTokenHours });
    ctx.setCookie(res, token, cfg.devTokenHours * 3600);
    const who = await ctx.read(token);
    res.json({ ok: true, email: who.email, role: who.role, token });
  }, { devOnly: true });

  // ------------------------------------------------------------------ admin
  let selfAuth = null;   // { token, email, until }: the developer's own sign-in, in memory only
  const selfToken = () => (selfAuth && selfAuth.until > Date.now() ? selfAuth.token : null);

  route('get', '/admin/status', async (req, res) => {
    let tenant = null; let tenantError = null;
    if (cfg.tenantId) {
      try { tenant = await ctx.client.tenantInfo(cfg.tenantId); delete tenant.public_key_pem; }
      catch (e) { tenantError = e.message; }
    }
    const trusted = (await raw('SELECT tenant_id, is_dev, is_active FROM auth.trusted_tenants ORDER BY is_dev DESC, tenant_id').catch(() => ({ rows: [] }))).rows;
    res.json({ mode, config: { ...cfg, systemPaths: undefined }, tenant, tenantError, trustedTenants: trusted, selfAuth: selfAuth && selfToken() ? selfAuth.email : null });
  }, { admin: true });

  route('post', '/admin/self-auth/send', async (req, res, b) => {
    if (!isEmail(b.email)) return res.status(400).json({ error: 'email_required' });
    await ctx.client.selfSend(b.email); res.json({ ok: true });
  }, { admin: true });

  route('post', '/admin/self-auth/verify', async (req, res, b) => {
    const out = await ctx.client.selfVerify(b.email, String(b.code || ''));
    selfAuth = { token: out.token, email: b.email, until: Date.now() + Math.max(60, (out.expires_in || 3600) - 60) * 1000 };
    res.json({ ok: true, email: b.email });
  }, { admin: true });

  route('post', '/admin/tenant', async (req, res, b) => {
    if (mode !== 'dev') return res.status(409).json({ error: 'create the tenant in dev, commit magic-links.config.json, then publish' });
    const token = selfToken();
    if (!token) return res.status(409).json({ error: 'sign_in_to_magiclink_first' });
    if (cfg.tenantId) return res.status(409).json({ error: 'a tenant is already configured', tenantId: cfg.tenantId });
    const t = await ctx.client.createTenant(token, {
      display_name: b.display_name || 'My app', project_name: b.project_name || b.display_name || 'my-app',
      ...(b.from_email ? { from_email: b.from_email } : {}),
      jwt_expires_in_seconds: Number(b.jwt_expires_in_seconds) || 3600,
    });
    cfg.tenantId = t.tenant_id;
    saveConfig(ctx.dir, cfg);
    res.json({ ok: true, tenantId: t.tenant_id });
  }, { admin: true });

  const BRANDING = ['display_name', 'brand_color', 'gradient_to', 'from_email', 'jwt_expires_in_seconds', 'smtp_config'];
  route('patch', '/admin/tenant', async (req, res, b) => {
    const token = selfToken();
    if (!token) return res.status(409).json({ error: 'sign_in_to_magiclink_first' });
    if (!cfg.tenantId) return res.status(409).json({ error: 'no_tenant' });
    const patch = Object.fromEntries(Object.entries(b).filter(([k]) => BRANDING.includes(k)));
    res.json(await ctx.client.patchTenant(token, cfg.tenantId, patch));
  }, { admin: true });

  // approved users, as the caller: row-level security decides, not this code
  const cols = () => [cfg.userKeyColumn, cfg.emailColumn, cfg.roleColumn, cfg.activeColumn].filter(Boolean);
  route('get', '/admin/users', async (req, res) => {
    const r = await asCaller(req, () => pool.query(
      `SELECT ${cfg.emailColumn} AS email, ${cfg.roleColumn} AS role${cfg.activeColumn ? `, ${cfg.activeColumn} AS is_active` : ''}
         FROM public.${cfg.usersView} ORDER BY 1`));
    res.json({ users: r.rows });
  }, { admin: true });

  route('post', '/admin/users', async (req, res, b) => {
    if (!isEmail(b.email)) return res.status(400).json({ error: 'email_required' });
    const email = b.email.toLowerCase();
    const names = cols(); const vals = [];
    for (const c of names) {
      vals.push(c === cfg.userKeyColumn ? email : c === cfg.emailColumn ? email : c === cfg.roleColumn ? String(b.role || 'member') : b.is_active !== false);
    }
    const r = await asCaller(req, () => pool.query(
      `INSERT INTO public.${cfg.usersTable} (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT DO NOTHING`, vals));
    if (!r.rowCount) return res.status(409).json({ error: 'already_approved' });
    res.json({ ok: true });
  }, { admin: true });

  route('patch', '/admin/users/:email', async (req, res, b) => {
    const sets = []; const vals = [];
    if (b.role !== undefined) { vals.push(String(b.role)); sets.push(`${cfg.roleColumn} = $${vals.length}`); }
    if (b.is_active !== undefined && cfg.activeColumn) { vals.push(!!b.is_active); sets.push(`${cfg.activeColumn} = $${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_change' });
    vals.push(req.params.email.toLowerCase());
    const r = await asCaller(req, () => pool.query(
      `UPDATE public.${cfg.usersTable} SET ${sets.join(', ')} WHERE lower(${cfg.emailColumn}) = $${vals.length}`, vals));
    res.json({ ok: r.rowCount > 0 });
  }, { admin: true });

  route('delete', '/admin/users/:email', async (req, res) => {
    if (req.params.email.toLowerCase() === req.ml.user.email) return res.status(400).json({ error: 'cannot_remove_yourself' });
    const r = await asCaller(req, () => pool.query(
      `DELETE FROM public.${cfg.usersTable} WHERE lower(${cfg.emailColumn}) = $1`, [req.params.email.toLowerCase()]));
    res.json({ ok: r.rowCount > 0 });
  }, { admin: true });
}
