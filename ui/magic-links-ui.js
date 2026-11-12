// effortless-magic-links: the sign-in UI. Plain custom elements, no build, no framework.
//
//   <script type="module" src="/api/magic-links/ui/magic-links-ui.js"></script>
//   <ml-gate> ...the whole app... </ml-gate>      nothing inside shows until someone is signed in
//   <ml-setup></ml-setup>                         the admin screen (served at /api/magic-links/setup)
//
// The gate fires `ml-session` on document with the session ({ signedIn, user, admin, mode, ... })
// and keeps it on window.mlSession, so the app can show who is signed in and what their roles allow.
// Colours: --ml-accent, --ml-bg, --ml-fg, --ml-muted, --ml-line on any ancestor.
const API = '/api/auth';
const call = async (method, path, body) => {
  const r = await fetch(path.startsWith('/') ? path : `${API}${path}`, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  let data = {}; try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw Object.assign(new Error(data.message || data.error || `${r.status}`), { status: r.status, data });
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BASE_CSS = `
:host { --a: var(--ml-accent, #c8102e); --bg: var(--ml-bg, #fff); --fg: var(--ml-fg, #1d1d1f); --mu: var(--ml-muted, #6b6b70); --ln: var(--ml-line, #e3e3e6);
  font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); }
@media (prefers-color-scheme: dark) { :host { --bg: var(--ml-bg, #17171a); --fg: var(--ml-fg, #f2f2f4); --mu: var(--ml-muted, #a0a0a8); --ln: var(--ml-line, #2e2e33); } }
* { box-sizing: border-box; }
button { font: inherit; border-radius: 8px; border: 1px solid var(--ln); background: var(--bg); color: var(--fg); padding: 8px 14px; cursor: pointer; }
button.primary { background: var(--a); border-color: var(--a); color: #fff; font-weight: 600; }
button:disabled { opacity: .55; cursor: default; }
input, select { font: inherit; width: 100%; padding: 9px 11px; border: 1px solid var(--ln); border-radius: 8px; background: var(--bg); color: var(--fg); }
.muted { color: var(--mu); } .err { color: #c0392b; } .ok { color: #1e8e3e; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 0 0 8px; }
`;

// ------------------------------------------------------------------------------------- <ml-gate>
class MlGate extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }); this.state = { step: 'loading' }; }
  connectedCallback() { this.load(); }
  async load() {
    // Arrived from the Sign in button in the code email (?ml=<token>&email=<address>): swap it here,
    // in script, so a mail scanner that fetches the link signs nobody in. Even for someone already
    // signed in: it may be another person's link, and an owner's test link has to land.
    const url = new URL(window.location.href);
    const link = url.searchParams.get('ml'); const linkEmail = url.searchParams.get('email');
    if (link && linkEmail) {
      url.searchParams.delete('ml'); url.searchParams.delete('email');
      window.history.replaceState(null, '', url);
      this.set({ step: 'loading' });
      try { await call('POST', '/verify-link', { email: linkEmail, token: link }); }
      catch {
        // Used already (a second click) or expired: the session decides, else the code in the same email.
        const s = await call('GET', '/session').catch(() => null);
        if (!s?.signedIn) return this.set({ step: 'code', email: linkEmail, session: s, error: 'That link has expired or was used. Type the code from the same email.' });
      }
    }
    try {
      const s = await call('GET', '/session');
      window.mlSession = s;
      document.dispatchEvent(new CustomEvent('ml-session', { detail: s }));
      if (s.signedIn) return this.set({ step: 'in', session: s });
      if (s.mode === 'dev') {
        const { users } = await call('GET', '/simulated/users');
        return this.set({ step: 'pick', session: s, users });
      }
      return this.set({ step: 'email', session: s });
    } catch (e) {
      this.set({ step: 'error', error: e.status === 503 ? (e.data.message || e.message) : `Sign-in is not answering (${e.message}).` });
    }
  }
  set(patch) { this.state = { ...this.state, ...patch }; this.render(); }
  async act(fn) {
    this.set({ busy: true, error: null });
    try { await fn(); } catch (e) { this.set({ error: e.data?.hint || e.data?.error?.replace(/_/g, ' ') || e.message }); } finally { this.set({ busy: false }); }
  }
  render() {
    const s = this.state;
    const css = `<style>${BASE_CSS}
      .wrap { min-height: 100vh; display: grid; place-items: center; background: var(--bg); padding: 24px; }
      .card { width: min(440px, 100%); border: 1px solid var(--ln); border-radius: 14px; padding: 24px; background: var(--bg); }
      .card form { display: grid; gap: 10px; margin-top: 14px; }
      .people { display: grid; gap: 6px; margin-top: 14px; max-height: 60vh; overflow: auto; }
      .person { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; text-align: left; padding: 10px 12px; }
      .person b { font-weight: 600; } .person small { color: var(--mu); }
      .role { font-size: 12px; border: 1px solid var(--ln); border-radius: 99px; padding: 1px 8px; color: var(--mu); align-self: center; grid-row: span 2; }
      .tag { display: inline-block; font-size: 12px; border-radius: 99px; padding: 2px 8px; background: color-mix(in srgb, var(--a) 12%, transparent); color: var(--a); margin-bottom: 8px; }
      .badge { position: fixed; left: 12px; bottom: 12px; z-index: 2147483000; display: flex; gap: 8px; align-items: center; font-size: 13px;
               background: var(--bg); border: 1px solid var(--ln); border-radius: 99px; padding: 5px 6px 5px 12px; box-shadow: 0 2px 10px rgba(0,0,0,.08); }
      .badge button { padding: 3px 10px; border-radius: 99px; font-size: 12px; }
      .badge a { color: var(--a); font-size: 12px; text-decoration: none; }
    </style>`;
    if (s.step === 'in') {
      const u = s.session.user;
      this.shadowRoot.innerHTML = `${css}<slot></slot>
        <div class="badge" part="badge">
          <span title="${esc(u.email)}">${esc(u.name || u.email)}${u.roles.length ? ` · <span class="muted">${esc(u.roles.join(', '))}</span>` : ''}${s.session.simulated ? ' <span class="muted">(simulated)</span>' : ''}</span>
          ${s.session.admin ? `<a href="${esc(s.session.setup)}">Sign-in setup</a>` : ''}
          <button id="out">${s.session.mode === 'dev' ? 'Switch' : 'Sign out'}</button>
        </div>`;
      this.shadowRoot.getElementById('out').onclick = () => this.act(async () => { await call('POST', '/logout'); window.location.reload(); });
      return;
    }
    const err = s.error ? `<p class="err">${esc(s.error)}</p>` : '';
    let body = '';
    if (s.step === 'loading') body = '<p class="muted">Checking who you are…</p>';
    if (s.step === 'error') body = `<h1>Sign-in is not ready</h1><p class="err">${esc(s.error)}</p><button id="retry">Try again</button>`;
    if (s.step === 'pick') {
      body = `<span class="tag">Dev: simulated users</span><h1>Pick who you are</h1>
        <p class="muted">Nobody types a code here. You see exactly what this person will see once the app is published.</p>
        ${s.users.length ? `<div class="people">${s.users.map((u, i) => `<button class="person" data-i="${i}"><b>${esc(u.name || u.email)}</b><span class="role">${esc(u.roles.join(', ') || 'no role')}</span><small>${esc(u.email)}</small></button>`).join('')}</div>`
          : '<p class="err">Nobody is active in the table of people yet. Add someone (the Data tab, or ask the agent) and reload.</p>'}${err}`;
    }
    if (s.step === 'email') {
      body = `<h1>Sign in</h1><p class="muted">We email you a six-digit code. Only people this app has approved get one.</p>
        <form id="f"><input id="email" type="email" autocomplete="email" placeholder="you@example.com" required value="${esc(s.email || '')}">
        <button class="primary" ${s.busy ? 'disabled' : ''}>Email me a code</button></form>${err}`;
    }
    if (s.step === 'code') {
      body = `<h1>Check your email</h1><p class="muted">If you have an account, we sent a code to <b>${esc(s.email)}</b>. It lasts five minutes.</p>
        <form id="f"><input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" placeholder="123456" required>
        <button class="primary" ${s.busy ? 'disabled' : ''}>Sign in</button></form>
        <p><button id="back">Use another address</button></p>${err}`;
    }
    this.shadowRoot.innerHTML = `${css}<div class="wrap"><div class="card" part="card">${body}</div></div>`;
    const $ = (id) => this.shadowRoot.getElementById(id);
    if ($('retry')) $('retry').onclick = () => this.load();
    if ($('back')) $('back').onclick = () => this.set({ step: 'email', error: null });
    this.shadowRoot.querySelectorAll('.person').forEach((b) => {
      b.onclick = () => this.act(async () => { await call('POST', '/simulated/sign-in', { email: s.users[Number(b.dataset.i)].email }); window.location.reload(); });
    });
    const f = $('f');
    if (f && s.step === 'email') f.onsubmit = (e) => { e.preventDefault(); const email = $('email').value.trim(); this.act(async () => { await call('POST', '/request-code', { email }); this.set({ step: 'code', email }); }); };
    if (f && s.step === 'code') f.onsubmit = (e) => { e.preventDefault(); const code = $('code').value.trim(); this.act(async () => { await call('POST', '/verify-code', { email: s.email, code }); window.location.reload(); }); };
  }
}

// ------------------------------------------------------------------------------------ <ml-setup>
class MlSetup extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }); this.state = { loading: true }; }
  connectedCallback() { this.load(); }
  set(patch) { this.state = { ...this.state, ...patch }; this.render(); }
  async load() {
    try {
      const report = await call('GET', '/setup');
      const p = report.people;
      const fields = [p.key, p.email, p.name, p.active.replace(/^!/, ''), p.role].filter(Boolean);
      let people = []; let roles = [];
      try { people = (await call('GET', `/api/tables/${encodeURIComponent(p.table)}?fields=${fields.join(',')}`)).rows || []; } catch (e) { report.peopleError = e.message; }
      if (p.rolesTable && p.roleKey) {
        try { roles = ((await call('GET', `/api/tables/${encodeURIComponent(p.rolesTable)}?fields=${p.roleKey}`)).rows || []).map((r) => Object.values(r)[0]); } catch { /* text roles */ }
      }
      this.set({ loading: false, report, people, roles, error: null });
    } catch (e) { this.set({ loading: false, error: e.status === 403 ? 'Only an admin can open this screen.' : e.message }); }
  }
  // The rows come from the view (snake_case columns); writes take rulebook names.
  col(name) { return name ? name.replace(/([A-Z]+s)([A-Z])/g, '$1_$2').replace(/([A-Z]+?)([A-Z](?!s$|s(?=[A-Z]))[a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^\p{L}\p{N}]+/gu, '_').toLowerCase().replace(/^_+|_+$/g, '') : null; }
  async act(fn, okMsg) {
    this.set({ busy: true, msg: null, error: null });
    try { await fn(); this.set({ msg: okMsg || null }); } catch (e) { this.set({ error: e.data?.error || e.message }); } finally { this.set({ busy: false }); }
  }
  render() {
    const s = this.state;
    const css = `<style>${BASE_CSS}
      :host { display: block; max-width: 920px; margin: 0 auto; padding: 24px 16px 64px; }
      section { border: 1px solid var(--ln); border-radius: 12px; padding: 18px; margin-top: 16px; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; } td, th { text-align: left; padding: 7px 8px; border-top: 1px solid var(--ln); vertical-align: top; }
      th { font-weight: 600; color: var(--mu); border-top: 0; } code { font-size: 13px; }
      .check { display: grid; grid-template-columns: 22px 1fr; gap: 2px 8px; padding: 6px 0; } .check .fix { grid-column: 2; color: var(--mu); font-size: 13px; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: end; } .row > * { flex: 1 1 160px; } .row button { flex: 0 0 auto; }
      .pill { font-size: 12px; border-radius: 99px; padding: 2px 9px; border: 1px solid var(--ln); }
      .scroll { overflow-x: auto; }
    </style>`;
    if (s.loading) { this.shadowRoot.innerHTML = `${css}<p class="muted">Loading…</p>`; return; }
    if (!s.report) { this.shadowRoot.innerHTML = `${css}<h1>Sign-in</h1><p class="err">${esc(s.error)}</p>`; return; }
    const r = s.report; const p = r.people;
    const k = this.col(p.key); const em = this.col(p.email); const nm = this.col(p.name);
    const act = p.active.replace(/^!/, ''); const inv = p.active.startsWith('!'); const ac = this.col(act); const rl = this.col(p.role);
    const isActive = (row) => (!ac ? true : inv ? row[ac] !== true : row[ac] !== false);
    const roleCell = (row, i) => {
      if (!p.role) return `<span class="muted">${p.grants ? `in ${esc(p.grants)}` : '—'}</span>`;
      if (s.roles.length) return `<select data-role="${i}" ${s.busy ? 'disabled' : ''}>${['', ...s.roles].map((x) => `<option ${String(row[rl] ?? '') === x ? 'selected' : ''} value="${esc(x)}">${esc(x || '(none)')}</option>`).join('')}</select>`;
      return `<input data-role="${i}" value="${esc(row[rl] ?? '')}">`;
    };
    this.shadowRoot.innerHTML = `${css}
      <h1>Sign-in</h1>
      <p class="muted">${r.mode === 'dev' ? 'Dev: people sign in by picking a user. Every published stage asks for an emailed code.' : `Live (${esc(r.stage)}): people sign in with an emailed code.`}
        You are ${esc(r.you.email)} (${esc(r.you.roles.join(', '))}).</p>
      ${s.msg ? `<p class="ok">${esc(s.msg)}</p>` : ''}${s.error ? `<p class="err">${esc(s.error)}</p>` : ''}

      <section><h2>${r.readyToPublish ? '<span class="ok">Ready to publish</span>' : 'Before you publish'}</h2>
        ${r.checks.map((c) => `<div class="check"><span class="${c.ok ? 'ok' : 'err'}">${c.ok ? '✓' : '✗'}</span><span>${esc(c.says)}</span>${c.ok ? '' : `<span class="fix">${esc(c.fix)}</span>`}</div>`).join('')}
      </section>

      <section><h2>People who may sign in</h2>
        <p class="muted">Rows of <code>${esc(p.table)}</code>. There is no sign-up: only these people get a code. ${r.mode === 'dev' ? 'In Dev a change here is a change to the rulebook\'s data; save it from the editor like any Data tab edit, and it is what a stage starts with.' : 'These are this stage\'s people.'}</p>
        ${r.peopleError ? `<p class="err">${esc(r.peopleError)}</p>` : ''}
        <div class="scroll"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th><th></th></tr>
        ${s.people.map((row, i) => `<tr><td>${esc(nm ? row[nm] : '')}</td><td>${esc(row[em])}</td><td>${roleCell(row, i)}</td>
          <td>${ac ? `<input type="checkbox" data-active="${i}" ${isActive(row) ? 'checked' : ''} ${s.busy ? 'disabled' : ''} style="width:auto">` : '<span class="muted">always</span>'}</td>
          <td>${p.key ? `<button data-del="${i}" ${s.busy ? 'disabled' : ''}>Remove</button>` : ''}</td></tr>`).join('')}
        </table></div>
        <form id="add" class="row" style="margin-top:12px">
          <label>Email<input id="nemail" type="email" required></label>
          ${p.name ? '<label>Name<input id="nname"></label>' : ''}
          ${p.role ? (s.roles.length ? `<label>Role<select id="nrole">${s.roles.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>` : '<label>Role<input id="nrole"></label>') : ''}
          <button class="primary" ${s.busy ? 'disabled' : ''}>Add</button>
        </form>
      </section>

      <section><h2>Email</h2>
        ${r.tenant ? `<p>Codes are sent by tenant <code>${esc(r.tenant.id)}</code>${r.tenant.name ? ` as “${esc(r.tenant.name)}”` : ''}${r.tenant.fromEmail ? ` from ${esc(r.tenant.fromEmail)}` : ''}.
          ${r.tenantManaged ? 'Effortless manages it: its name, sender and sign-in link are in your project\'s Settings, Sign-in.' : ''}</p>
          <div class="row"><button id="send" ${s.busy ? 'disabled' : ''}>Send me a code</button><label>Code<input id="tcode" inputmode="numeric"></label><button id="verify" ${s.busy ? 'disabled' : ''}>Check it</button></div>
          <p class="muted">Proves the tenant sends to you and accepts its code. No session is made.</p>`
        : `<p class="err">No magic-link tenant yet.${r.tenantManaged ? '' : ' On Effortless the platform makes one when the seed is added. Here, create your own below (Dev only): it is written to magic-links.config.json, which you commit.'}</p>`}
        ${r.tenantManaged ? '' : `
          <h2 style="margin-top:14px">${r.tenant ? 'Change the tenant' : 'Create a tenant'} (your own magiclink account)</h2>
          ${!s.self ? `<div class="row"><label>Your email<input id="selfemail" type="email" value="${esc(r.you.email)}"></label><button id="selfsend" ${s.busy ? 'disabled' : ''}>Send me a code</button>
            ${s.selfSent ? '<label>Code<input id="selfcode" inputmode="numeric"></label><button id="selfverify">Sign in to magiclink</button>' : ''}</div>`
          : `<p class="ok">Signed in to magiclink as ${esc(s.self)}.</p>
            <form id="tenantform" class="row">
              <label>App name<input id="tname" value="${esc(r.tenant?.name || '')}"></label>
              <label>Sender<input id="tfrom" type="email" value="${esc(r.tenant?.fromEmail || '')}"></label>
              <label>Sign-in link (the app's address)<input id="tlogin" placeholder="https://..."></label>
              <button class="primary">${r.tenant ? 'Save' : 'Create'}</button>
            </form>`}`}
      </section>

      <section><h2>Where people and roles live</h2>
        <p class="muted">From <code>server/magic-links/magic-links.config.json</code>. To change one, ask the agent (it re-runs install.mjs and rebuilds); every setting is described in the seed's README.</p>
        <div class="scroll"><table><tr><th>Setting</th><th>Value</th><th>Meaning</th></tr>
        ${r.mapping.map((m) => `<tr><td><code>${esc(m.key)}</code></td><td><code>${esc(m.value || '—')}</code></td><td class="muted">${esc(m.description)}</td></tr>`).join('')}</table></div>
      </section>`;

    const $ = (id) => this.shadowRoot.getElementById(id);
    const rowsUrl = (id) => `/api/tables/${encodeURIComponent(p.table)}/rows${id !== undefined ? `/${encodeURIComponent(id)}` : ''}`;
    this.shadowRoot.querySelectorAll('[data-active]').forEach((el) => {
      el.onchange = () => { const row = s.people[Number(el.dataset.active)]; this.act(async () => { await call('PATCH', rowsUrl(row[k]), { [act]: inv ? !el.checked : el.checked }); await this.load(); }, 'Saved.'); };
    });
    this.shadowRoot.querySelectorAll('[data-role]').forEach((el) => {
      el.onchange = () => { const row = s.people[Number(el.dataset.role)]; this.act(async () => { await call('PATCH', rowsUrl(row[k]), { [p.role]: el.value || null }); await this.load(); }, 'Saved.'); };
    });
    this.shadowRoot.querySelectorAll('[data-del]').forEach((el) => {
      el.onclick = () => { const row = s.people[Number(el.dataset.del)]; this.act(async () => { await call('DELETE', rowsUrl(row[k])); await this.load(); }, 'Removed.'); };
    });
    if ($('add')) $('add').onsubmit = (e) => {
      e.preventDefault();
      const email = $('nemail').value.trim().toLowerCase();
      const row = { [p.email]: email };
      if (p.key) row[p.key] = email;
      if (p.name && $('nname')) row[p.name] = $('nname').value.trim() || email.split('@')[0];
      if (p.role && $('nrole')) row[p.role] = $('nrole').value.trim() || null;
      if (act) row[act] = !inv;
      this.act(async () => { await call('POST', rowsUrl(), row); await this.load(); }, `Added ${email}.`);
    };
    if ($('selfsend')) $('selfsend').onclick = () => this.act(async () => { const email = $('selfemail').value.trim(); await call('POST', '/setup/self/send', { email }); this.state.selfSent = true; this.state.selfEmail = email; }, 'Code sent: it is from magiclink, for you.');
    if ($('selfverify')) $('selfverify').onclick = () => this.act(async () => { await call('POST', '/setup/self/verify', { email: s.selfEmail, code: $('selfcode').value.trim() }); this.state.self = s.selfEmail; });
    if ($('tenantform')) $('tenantform').onsubmit = (e) => {
      e.preventDefault();
      const body = { display_name: $('tname').value.trim() || undefined, from_email: $('tfrom').value.trim() || undefined, login_url: $('tlogin').value.trim() || undefined };
      this.act(async () => { await call(r.tenant ? 'PATCH' : 'POST', '/setup/tenant', body); await this.load(); }, r.tenant ? 'Saved.' : 'Tenant created and written to magic-links.config.json: commit it.');
    };
    if ($('send')) $('send').onclick = () => this.act(async () => { const o = await call('POST', '/setup/test-code'); this.state.sentTo = o.sentTo; }, `Code sent to ${r.you.email}.`);
    if ($('verify')) $('verify').onclick = () => this.act(async () => { await call('POST', '/setup/test-verify', { code: $('tcode').value.trim() }); }, 'The tenant works: code accepted.');
  }
}

if (!customElements.get('ml-gate')) customElements.define('ml-gate', MlGate);
if (!customElements.get('ml-setup')) customElements.define('ml-setup', MlSetup);
