// The magiclink.effortlessapi.com HTTP API (and a localhost stand-in for it). Magic-links is a
// notary, not a referee: it says "this inbox is read by this person"; who is APPROVED is ours.
const j = async (res) => { try { return await res.json(); } catch { return {}; } };

export function magicLinkClient(baseUrl, fetchImpl = globalThis.fetch) {
  const call = async (method, url, { body, token } = {}) => {
    const res = await fetchImpl(baseUrl + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await j(res);
    if (!res.ok) throw Object.assign(new Error(data.error || data.message || `magic-links ${res.status}`), { status: res.status, data });
    return data;
  };
  return {
    tenantInfo: (id) => call('GET', `/api/tenants/${encodeURIComponent(id)}`),
    sendCode: (id, email) => call('POST', `/api/tenants/${encodeURIComponent(id)}/send-code`, { body: { email } }),
    verifyCode: (id, email, code) => call('POST', `/api/tenants/${encodeURIComponent(id)}/verify-code`, { body: { email, code } }),
    // The developer's own sign-in, needed to create or change a tenant.
    selfSend: (email) => call('POST', '/auth/send-code', { body: { email } }),
    selfVerify: (email, code) => call('POST', '/auth/verify-code', { body: { email, code } }),
    createTenant: (token, body) => call('POST', '/api/tenants', { token, body }),
    patchTenant: (token, id, body) => call('PATCH', `/api/tenants/${encodeURIComponent(id)}`, { token, body }),
  };
}
