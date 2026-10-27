// effortless-magic-links UI: plain custom elements, no build step, no framework, no dependency.
//
//   <script type="module" src="/magic-links/ui/magic-links-ui.js"></script>
//
//   <ml-gate>            wrap your whole app in it: sign-in when live, pick-your-user in dev
//     ...your app...
//   </ml-gate>
//
//   <ml-admin></ml-admin>   the configuration screen, for an admin: tenant, email branding, approved users
//
// Attribute `api` on either = where /auth lives (default: same origin). Restyle with the
// --ml-* custom properties below. Events: `ml-session` (detail = the session) on document.

const CSS = `
ml-gate, ml-admin { --ml-accent:#c8102e; --ml-ink:#1d1d1f; --ml-muted:#6b6b72; --ml-bg:#fff; --ml-line:#e2e2e6; --ml-warn:#8a5a00; font:15px/1.45 system-ui,sans-serif; color:var(--ml-ink); }
ml-gate[data-locked] > :not(.ml-overlay) { display:none !important; }
.ml-overlay { min-height:100vh; display:grid; place-items:center; padding:16px; background:#f6f6f8; box-sizing:border-box; }
.ml-card { width:100%; max-width:420px; background:var(--ml-bg); border:1px solid var(--ml-line); border-radius:12px; padding:24px; box-sizing:border-box; }
.ml-card h2 { margin:0 0 4px; font-size:20px; } .ml-card p { margin:0 0 16px; color:var(--ml-muted); }
.ml-card label, ml-admin label { display:block; font-size:13px; color:var(--ml-muted); margin:12px 0 4px; }
.ml-card input, ml-admin input, ml-admin select { width:100%; box-sizing:border-box; padding:10px 12px; font:inherit; border:1px solid var(--ml-line); border-radius:8px; background:var(--ml-bg); color:inherit; }
.ml-btn { margin-top:16px; width:100%; padding:11px 14px; font:inherit; font-weight:600; border:0; border-radius:8px; background:var(--ml-accent); color:#fff; cursor:pointer; }
.ml-btn.ml-quiet { background:transparent; color:var(--ml-ink); border:1px solid var(--ml-line); margin-top:8px; }
.ml-btn[disabled] { opacity:.5; cursor:default; }
.ml-err { color:#b00020; margin-top:10px; min-height:1em; } .ml-note { color:var(--ml-muted); font-size:13px; margin-top:10px; }
.ml-users { display:grid; gap:8px; margin-top:8px; }
.ml-user { display:flex; justify-content:space-between; align-items:center; gap:8px; text-align:left; padding:10px 12px; border:1px solid var(--ml-line); border-radius:8px; background:var(--ml-bg); color:inherit; font:inherit; cursor:pointer; width:100%; }
.ml-user small { color:var(--ml-muted); }
.ml-badge { position:fixed; right:12px; bottom:12px; z-index:9999; background:#1d1d1f; color:#fff; border-radius:999px; padding:6px 12px; font-size:12px; display:flex; gap:10px; align-items:center; }
.ml-badge.ml-dev { background:var(--ml-warn); } .ml-badge button { background:none; border:0; color:inherit; text-decoration:underline; cursor:pointer; font:inherit; padding:0; }
ml-admin { display:block; max-width:760px; margin:0 auto; padding:16px; box-sizing:border-box; }
ml-admin section { border:1px solid var(--ml-line); border-radius:12px; padding:16px; margin:16px 0; background:var(--ml-bg); }
ml-admin h3 { margin:0 0 8px; font-size:16px; }
ml-admin .ml-row { display:grid; grid-template-columns:1fr 140px 90px 80px; gap:8px; align-items:center; padding:8px 0; border-top:1px solid var(--ml-line); }
ml-admin .ml-row.ml-head { border-top:0; color:var(--ml-muted); font-size:13px; }
ml-admin .ml-grid { display:grid; grid-template-columns:1fr 1fr; gap:0 12px; }
ml-admin .ml-btn { width:auto; margin-top:12px; padding:9px 14px; }
ml-admin .ml-inline { display:flex; gap:8px; align-items:end; } ml-admin .ml-inline > div { flex:1; }
ml-admin code { background:#f0f0f3; padding:1px 5px; border-radius:4px; }
@media (max-width:560px) { ml-admin .ml-row { grid-template-columns:1fr 1fr; } ml-admin .ml-grid { grid-template-columns:1fr; } }
`;
function injectCss() {
  if (document.getElementById('ml-css')) return;
  const s = document.createElement('style'); s.id = 'ml-css'; s.textContent = CSS; document.head.appendChild(s);
}
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function client(api = '') {
  const call = async (method, path, body) => {
    const res = await fetch(`${api}/auth${path}`, {
      method, credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
    return data;
  };
  return {
    session: () => call('GET', '/session'),
    logout: () => call('POST', '/logout'),
    requestCode: (email) => call('POST', '/request-code', { email }),
    verifyCode: (email, code) => call('POST', '/verify-code', { email, code }),
    devUsers: () => call('GET', '/dev/users'),
    devLogin: (b) => call('POST', '/dev/login', b),
    admin: {
      status: () => call('GET', '/admin/status'),
      selfSend: (email) => call('POST', '/admin/self-auth/send', { email }),
      selfVerify: (email, code) => call('POST', '/admin/self-auth/verify', { email, code }),
      createTenant: (b) => call('POST', '/admin/tenant', b),
      patchTenant: (b) => call('PATCH', '/admin/tenant', b),
      users: () => call('GET', '/admin/users'),
      addUser: (b) => call('POST', '/admin/users', b),
      setUser: (email, b) => call('PATCH', `/admin/users/${encodeURIComponent(email)}`, b),
      removeUser: (email) => call('DELETE', `/admin/users/${encodeURIComponent(email)}`),
    },
  };
}

// ---------------------------------------------------------------- sign in (live)
class MlLogin extends HTMLElement {
  connectedCallback() {
    injectCss(); this.api = client(this.getAttribute('api') || ''); this.step = 'email'; this.email = ''; this.render();
  }
  render(err = '') {
    const email = this.step === 'email';
    this.innerHTML = `<div class="ml-card">
      <h2>Sign in</h2><p>${email ? 'Enter your email and we will send you a code.' : `We sent a code to <b>${esc(this.email)}</b>.`}</p>
      ${email ? `<label>Email</label><input type="email" autocomplete="email" autofocus>`
              : `<label>Code</label><input inputmode="numeric" autocomplete="one-time-code" autofocus>`}
      <button class="ml-btn">${email ? 'Send code' : 'Sign in'}</button>
      ${email ? '' : '<button class="ml-btn ml-quiet" data-back>Use a different email</button>'}
      <div class="ml-err">${esc(err)}</div>
      <div class="ml-note">Only approved people can sign in. There is no sign-up.</div></div>`;
    const input = this.querySelector('input'); const go = this.querySelector('.ml-btn');
    const submit = async () => {
      go.disabled = true;
      try {
        if (email) { this.email = input.value.trim(); await this.api.requestCode(this.email); this.step = 'code'; this.render(); }
        else { await this.api.verifyCode(this.email, input.value.trim()); this.dispatchEvent(new CustomEvent('ml-signed-in', { bubbles: true })); }
      } catch (e) { this.render(e.message === 'not_approved' ? 'That email is not approved for this app.' : 'That did not work. Check the code and try again.'); }
    };
    go.onclick = submit; input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    this.querySelector('[data-back]')?.addEventListener('click', () => { this.step = 'email'; this.render(); });
  }
}

// ---------------------------------------------------------------- pick your user (dev only)
class MlPickUser extends HTMLElement {
  async connectedCallback() {
    injectCss(); this.api = client(this.getAttribute('api') || '');
    this.innerHTML = '<div class="ml-card"><h2>Pick your user</h2><p>Loading…</p></div>';
    try { this.users = (await this.api.devUsers()).users; this.render(); }
    catch (e) { this.innerHTML = `<div class="ml-card"><h2>Pick your user</h2><div class="ml-err">${esc(e.message)}</div></div>`; }
  }
  render(err = '') {
    this.innerHTML = `<div class="ml-card"><h2>Pick your user</h2>
      <p>Development only. You get the same token a real sign-in would give them, and every rule applies.</p>
      <div class="ml-users">${this.users.map((u, i) => `<button class="ml-user" data-i="${i}"><span>${u.devAdmin ? 'Global admin (dev default)' : esc(u.email)}<br><small>${esc(u.role)}</small></span><span>›</span></button>`).join('')}</div>
      <div class="ml-err">${esc(err)}</div>
      ${this.users.length < 2 ? '<div class="ml-note">No approved users yet. Add them in the admin screen, or in the AppUsers table.</div>' : ''}</div>`;
    this.querySelectorAll('.ml-user').forEach((b) => b.onclick = async () => {
      const u = this.users[+b.dataset.i];
      try { await this.api.devLogin(u.devAdmin ? { admin: true } : { email: u.email }); this.dispatchEvent(new CustomEvent('ml-signed-in', { bubbles: true })); }
      catch (e) { this.render(e.message); }
    });
  }
}

// ---------------------------------------------------------------- the gate
class MlGate extends HTMLElement {
  connectedCallback() { injectCss(); this.api = client(this.getAttribute('api') || ''); this.check(); this.addEventListener('ml-signed-in', () => this.check()); }
  async check() {
    this.setAttribute('data-locked', '');
    let s;
    try { s = await this.api.session(); }
    catch (e) { return this.overlay(`<div class="ml-card"><h2>Cannot reach sign-in</h2><p>${esc(e.message)}</p></div>`); }
    this.session = s; document.dispatchEvent(new CustomEvent('ml-session', { detail: s }));
    const dev = s.mode === 'dev';
    if (dev ? !s.picked : !s.authenticated) {
      return this.overlay(dev ? '<ml-pick-user></ml-pick-user>' : '<ml-login></ml-login>');
    }
    this.querySelector('.ml-overlay')?.remove();
    this.removeAttribute('data-locked');
    this.badge(s);
  }
  overlay(html) {
    this.querySelector('.ml-overlay')?.remove();
    const o = document.createElement('div'); o.className = 'ml-overlay'; o.innerHTML = html;
    o.firstElementChild?.setAttribute?.('api', this.getAttribute('api') || '');
    this.prepend(o);
  }
  badge(s) {
    this.querySelector('.ml-badge')?.remove();
    const b = document.createElement('div'); b.className = `ml-badge${s.mode === 'dev' ? ' ml-dev' : ''}`;
    b.innerHTML = `<span>${s.mode === 'dev' ? 'DEV · ' : ''}${esc(s.devAdmin ? 'global admin' : s.email)}${s.role && !s.devAdmin ? ` (${esc(s.role)})` : ''}</span><button>${s.mode === 'dev' ? 'switch user' : 'sign out'}</button>`;
    b.querySelector('button').onclick = async () => { await this.api.logout(); this.check(); };
    this.appendChild(b);
  }
}

// ---------------------------------------------------------------- admin
class MlAdmin extends HTMLElement {
  connectedCallback() { injectCss(); this.api = client(this.getAttribute('api') || ''); this.load(); }
  async load(msg = '') {
    try {
      const [st, us] = await Promise.all([this.api.admin.status(), this.api.admin.users().catch(() => ({ users: [] }))]);
      this.st = st; this.users = us.users; this.render(msg);
    } catch (e) { this.innerHTML = `<section><h3>Magic links</h3><div class="ml-err">${esc(e.status === 403 ? 'Admins only.' : e.message)}</div></section>`; }
  }
  render(msg) {
    const { st } = this; const t = st.tenant; const live = st.mode === 'live';
    this.innerHTML = `
    <section><h3>Sign-in</h3>
      <div>Mode: <b>${live ? 'live (real magic links)' : 'dev (pick your user)'}</b>. ${live ? '' : 'Beta and production switch to live magic links automatically.'}</div>
      <div class="ml-note">Tenant: ${st.config.tenantId ? `<code>${esc(st.config.tenantId)}</code>${t ? ` · ${esc(t.display_name || '')}` : ''}${st.tenantError ? ` · <span class="ml-err">${esc(st.tenantError)}</span>` : ''}` : 'none yet. Beta and production cannot start until one exists.'}</div>
      <div class="ml-note">This database trusts: ${st.trustedTenants.map((x) => `<code>${esc(x.tenant_id)}</code>${x.is_dev ? ' (dev)' : ''}`).join(', ') || 'nobody'}.</div>
      <div class="ml-err" data-msg>${esc(msg)}</div></section>
    <section><h3>Magic-link tenant</h3>${this.tenantForm()}</section>
    <section><h3>Approved users</h3>
      <div class="ml-note">Only these people can sign in. Their role comes from this list, never from the sign-in token.</div>
      <div class="ml-row ml-head"><span>Email</span><span>Role</span><span>Active</span><span></span></div>
      ${this.users.map((u, i) => `<div class="ml-row"><span>${esc(u.email)}</span>
        <input data-role="${i}" value="${esc(u.role)}"><span><input type="checkbox" data-active="${i}" ${u.is_active === false ? '' : 'checked'}></span>
        <button class="ml-btn ml-quiet" data-del="${i}">Remove</button></div>`).join('')}
      <div class="ml-inline"><div><label>Add by email</label><input data-new-email type="email" placeholder="person@example.com"></div>
        <div><label>Role</label><input data-new-role value="member"></div><button class="ml-btn" data-add>Add</button></div></section>`;
    this.wire();
  }
  tenantForm() {
    const { st } = this; const t = st.tenant || {};
    const signedIn = st.selfAuth;
    const auth = signedIn ? `<div class="ml-note">Signed in to magic-links as <b>${esc(signedIn)}</b>.</div>` : `
      <div class="ml-note">Creating or changing a tenant needs <i>your</i> developer sign-in at magiclink.effortlessapi.com.</div>
      <div class="ml-inline"><div><label>Your email</label><input data-self-email type="email"></div><button class="ml-btn" data-self-send>Send code</button></div>
      <div class="ml-inline"><div><label>Code</label><input data-self-code inputmode="numeric"></div><button class="ml-btn" data-self-verify>Sign in</button></div>`;
    if (!st.config.tenantId) {
      return `${auth}<div class="ml-grid"><div><label>App name (shown in the email)</label><input data-t="display_name"></div>
        <div><label>From address (optional)</label><input data-t="from_email" type="email"></div></div>
        <button class="ml-btn" data-create ${signedIn && st.mode === 'dev' ? '' : 'disabled'}>Create tenant</button>
        ${st.mode === 'dev' ? '' : '<div class="ml-note">Tenants are created in dev, then committed.</div>'}`;
    }
    return `${auth}<div class="ml-grid">
      <div><label>App name</label><input data-t="display_name" value="${esc(t.display_name)}"></div>
      <div><label>From address</label><input data-t="from_email" value="${esc(t.from_email)}"></div>
      <div><label>Brand colour</label><input data-t="brand_color" value="${esc(t.brand_color)}" placeholder="#c8102e"></div>
      <div><label>Gradient to (optional)</label><input data-t="gradient_to" value="${esc(t.gradient_to)}"></div>
      <div><label>Session length (seconds)</label><input data-t="jwt_expires_in_seconds" value="${esc(t.jwt_expires_in_seconds)}"></div></div>
      <button class="ml-btn" data-save ${signedIn ? '' : 'disabled'}>Save branding</button>`;
  }
  wire() {
    const $ = (s) => this.querySelector(s); const say = (m) => this.load(m);
    const run = (fn) => async () => { try { await fn(); } catch (e) { $('[data-msg]').textContent = e.message; } };
    const fields = () => Object.fromEntries([...this.querySelectorAll('[data-t]')].map((i) => [i.dataset.t, i.value]).filter(([, v]) => v !== ''));
    $('[data-self-send]')?.addEventListener('click', run(async () => { await this.api.admin.selfSend($('[data-self-email]').value.trim()); $('[data-msg]').textContent = 'Code sent. Check your inbox.'; }));
    $('[data-self-verify]')?.addEventListener('click', run(async () => { await this.api.admin.selfVerify($('[data-self-email]').value.trim(), $('[data-self-code]').value.trim()); say('Signed in to magic-links.'); }));
    $('[data-create]')?.addEventListener('click', run(async () => { await this.api.admin.createTenant(fields()); say('Tenant created. Commit magic-links.config.json.'); }));
    $('[data-save]')?.addEventListener('click', run(async () => {
      const f = fields(); if (f.jwt_expires_in_seconds) f.jwt_expires_in_seconds = Number(f.jwt_expires_in_seconds);
      await this.api.admin.patchTenant(f); say('Saved.');
    }));
    $('[data-add]')?.addEventListener('click', run(async () => { await this.api.admin.addUser({ email: $('[data-new-email]').value.trim(), role: $('[data-new-role]').value.trim() || 'member' }); say('Added.'); }));
    this.querySelectorAll('[data-role]').forEach((i) => i.onchange = run(async () => { await this.api.admin.setUser(this.users[+i.dataset.role].email, { role: i.value }); say('Saved.'); }));
    this.querySelectorAll('[data-active]').forEach((i) => i.onchange = run(async () => { await this.api.admin.setUser(this.users[+i.dataset.active].email, { is_active: i.checked }); say('Saved.'); }));
    this.querySelectorAll('[data-del]').forEach((b) => b.onclick = run(async () => { await this.api.admin.removeUser(this.users[+b.dataset.del].email); say('Removed.'); }));
  }
}

for (const [name, cls] of [['ml-login', MlLogin], ['ml-pick-user', MlPickUser], ['ml-gate', MlGate], ['ml-admin', MlAdmin]]) {
  if (!customElements.get(name)) customElements.define(name, cls);
}
