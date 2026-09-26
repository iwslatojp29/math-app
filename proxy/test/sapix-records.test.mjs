import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { StudioState, seal, unseal } from '../src/studio.js';
import worker from '../src/index.js';

// All accounts, credentials and storage here are isolated test fixtures.
const ENV = {
  GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-google-secret', STUDIO_SECRET: 'test-encryption-key',
  STUDIO_OWNER_EMAIL: 'owner@example.test', SAPIX_OWNER_EMAIL: 'owner@example.test', STUDIO_ORIGIN: 'https://worker.example.test',
  ALLOWED_ORIGIN: 'https://iwslatojp29.github.io', STUDIO_RUNNER_TOKEN: 'r'.repeat(43),
  UPLOAD_SECRET: 'u'.repeat(43), GITHUB_TOKEN: 'g'.repeat(43), OPENAI_API_KEY: 'unused',
};
const TRAINER = 'https://iwslatojp29.github.io/math-app/sapix/sapix_sansu_trainer.html';
const hash = value => createHash('sha256').update(value).digest('base64url');
class MemoryStorage {
  values = new Map();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key); }
  async list({ prefix = '', limit = Infinity } = {}) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])); }
  async transaction(action) { const previous = structuredClone(this.values); try { return await action(this); } catch (error) { this.values = previous; throw error; } }
}
function request(path, { method = 'GET', body, token, cookie, origin = ENV.ALLOWED_ORIGIN, headers = {} } = {}) {
  const h = new Headers(headers);
  if (origin !== null) h.set('Origin', origin);
  if (token) h.set('Authorization', 'Bearer ' + token);
  if (cookie) h.set('Cookie', '__Host-studio=' + cookie);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  return new Request(ENV.STUDIO_ORIGIN + path, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function fixture(overrides = {}) {
  const storage = new MemoryStorage(), env = { ...ENV, ...overrides }, state = new StudioState({ storage }, env);
  const cookie = await seal({ email: env.STUDIO_OWNER_EMAIL, csrf: 'fake-csrf', expires: Date.now() + 60000 }, env.STUDIO_SECRET, 'session');
  return { state, storage, cookie, env };
}
async function login(f, seed = 'v') {
  const verifier = seed.repeat(43), state = seed.repeat(24), challenge = hash(verifier);
  const start = await f.state.fetch(request('/api/sapix/auth/start?' + new URLSearchParams({ state, challenge }), { cookie: f.cookie, origin: null }));
  assert.equal(start.status, 302);
  const url = new URL(start.headers.get('Location')), fragment = new URLSearchParams(url.hash.slice(1));
  assert.equal(url.origin + url.pathname, TRAINER); assert.equal(fragment.get('sapix_state'), state);
  const code = fragment.get('sapix_code');
  const exchange = await f.state.fetch(request('/api/sapix/auth/exchange', { method: 'POST', body: { code, verifier } }));
  assert.equal(exchange.status, 200);
  return { ...(await exchange.json()), code, verifier };
}
async function json(f, path, options) { const response = await f.state.fetch(request(path, options)); assert.equal(response.status, 200, await response.clone().text()); return response.json(); }
const put = (id, pid = 'calc-1', seq = 1, r = 'o') => ({ type: 'put', id, pid, seq, value: { d: '2026-09-26', r, s: 30, over: false } });
async function write(f, token, ops) { return json(f, '/api/sapix/records', { method: 'POST', token, body: { ops } }); }

test('Pages routes use the existing owner Durable Object and preflight allows only the Pages origin and required headers', async () => {
  const f = await fixture();
  let usedId;
  const env = { ...f.env, STUDIO: { idFromName: value => value, get: id => { usedId = id; return f.state; } } };
  const response = await worker.fetch(request('/api/sapix/records', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } }), env);
  assert.equal(response.status, 204); assert.equal(usedId, 'owner');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ENV.ALLOWED_ORIGIN);
  assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Authorization, Content-Type');
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  for (const options of [
    { origin: 'https://attacker.example' }, { origin: null }, { origin: 'null' },
    { headers: { 'Access-Control-Request-Method': 'DELETE' } },
    { headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-studio-csrf' } },
  ]) {
    const bad = await f.state.fetch(request('/api/sapix/records', { method: 'OPTIONS', ...options }));
    assert.equal(bad.status, 403);
  }
});

test('owner login creates a PKCE-bound one-use code and hashes code/device tokens in durable storage', async () => {
  const f = await fixture(), client = await login(f);
  assert.equal(client.email, ENV.STUDIO_OWNER_EMAIL);
  assert.equal(typeof client.expiresAt, 'number'); assert(client.expiresAt > Date.now() + 89 * 86400000);
  assert.match(client.token, /^[A-Za-z0-9_-]{43}$/);
  assert(!JSON.stringify([...f.storage.values]).includes(client.token));
  assert(!JSON.stringify([...f.storage.values]).includes(client.code));
  const replay = await f.state.fetch(request('/api/sapix/auth/exchange', { method: 'POST', body: { code: client.code, verifier: client.verifier } }));
  assert.equal(replay.status, 401);
  assert.equal(replay.headers.get('Access-Control-Allow-Origin'), ENV.ALLOWED_ORIGIN);
  const saved = await json(f, '/api/sapix/records', { token: client.token });
  assert.deepEqual(saved, { revision: 0, entries: [], deleted: [] });
});

test('PKCE mismatch, expired code, forged cookie and malformed login parameters never issue usable credentials', async () => {
  const f = await fixture(), verifier = 'a'.repeat(43), state = 'b'.repeat(24);
  const path = '/api/sapix/auth/start?' + new URLSearchParams({ state, challenge: hash(verifier) });
  const started = await f.state.fetch(request(path, { cookie: f.cookie }));
  const code = new URLSearchParams(new URL(started.headers.get('Location')).hash.slice(1)).get('sapix_code');
  const mismatch = await f.state.fetch(request('/api/sapix/auth/exchange', { method: 'POST', body: { code, verifier: 'z'.repeat(43) } }));
  assert.equal(mismatch.status, 401);
  const key = 'sapix:code:' + hash(code), saved = await f.storage.get(key);
  await f.storage.put(key, { ...saved, expires: Date.now() - 1 });
  const expired = await f.state.fetch(request('/api/sapix/auth/exchange', { method: 'POST', body: { code, verifier } }));
  assert.equal(expired.status, 401);
  const forged = await f.state.fetch(request(path, { cookie: 'invalid-cookie' }));
  assert.equal(new URL(forged.headers.get('Location')).origin, 'https://accounts.google.com');
  for (const query of [{ state: 'short', challenge: hash(verifier) }, { state, challenge: 'bad' }]) {
    assert.equal((await f.state.fetch(request('/api/sapix/auth/start?' + new URLSearchParams(query), { cookie: f.cookie }))).status, 400);
  }
});

test('simultaneous exchange consumes the authorization code only once', async () => {
  const f = await fixture(), verifier = 'a'.repeat(43), state = 'b'.repeat(24);
  const response = await f.state.fetch(request('/api/sapix/auth/start?' + new URLSearchParams({ state, challenge: hash(verifier) }), { cookie: f.cookie }));
  const code = new URLSearchParams(new URL(response.headers.get('Location')).hash.slice(1)).get('sapix_code');
  const responses = await Promise.all(Array.from({ length: 2 }, () => f.state.fetch(request('/api/sapix/auth/exchange', { method: 'POST', body: { code, verifier } }))));
  assert.deepEqual(responses.map(value => value.status).sort(), [200, 401]);
});

test('grading login requests identity only, checks the owner, and leaves Drive credentials and Studio session untouched', async () => {
  const f = await fixture(); await f.storage.put('google', 'protected-existing-drive-credential');
  const started = await f.state.fetch(request('/api/sapix/auth/start?' + new URLSearchParams({ state: 's'.repeat(24), challenge: hash('v'.repeat(43)) })));
  const auth = new URL(started.headers.get('Location'));
  assert.equal(auth.searchParams.get('scope'), 'openid email');
  assert.equal(auth.searchParams.get('access_type'), null);
  assert.equal(auth.searchParams.get('redirect_uri'), ENV.STUDIO_ORIGIN + '/api/studio/google/callback');
  const cookie = started.headers.get('Set-Cookie').split(';')[0];
  const oauth = await unseal(cookie.slice(cookie.indexOf('=') + 1), ENV.STUDIO_SECRET, 'oauth');
  assert.equal(oauth.sapix.state, 's'.repeat(24));
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      assert.equal(options.body.get('code_verifier'), oauth.verifier);
      return Response.json({ access_token: 'identity-only-access', expires_in: 3600, scope: 'openid email' });
    }
    assert.equal(url, 'https://openidconnect.googleapis.com/v1/userinfo');
    return Response.json({ email: ENV.STUDIO_OWNER_EMAIL, email_verified: true });
  };
  try {
    const response = await f.state.fetch(request('/api/studio/google/callback?state=' + oauth.state + '&code=fake-google-code', { headers: { Cookie: cookie } }));
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get('Location')).origin, ENV.ALLOWED_ORIGIN);
    assert.match(response.headers.get('Set-Cookie'), /__Host-studio-oauth=;/);
    assert(!response.headers.get('Set-Cookie').includes('__Host-studio='));
    assert.equal(await f.storage.get('google'), 'protected-existing-drive-credential');
    assert.equal(f.state.access, undefined);
  } finally { globalThis.fetch = original; }
});

test('grading OAuth rejects a non-owner identity and does not create authorization codes', async () => {
  const f = await fixture(), value = await seal({ state: 'google-state', verifier: 'fake-verifier', expires: Date.now() + 60000, sapix: { state: 's'.repeat(24), challenge: hash('v'.repeat(43)), email: ENV.SAPIX_OWNER_EMAIL } }, ENV.STUDIO_SECRET, 'oauth');
  const original = globalThis.fetch;
  globalThis.fetch = async url => url.endsWith('/token') ? Response.json({ access_token: 'fake' }) : Response.json({ email: 'other@example.test', email_verified: true });
  try {
    const response = await f.state.fetch(request('/api/studio/google/callback?state=google-state&code=fake', { headers: { Cookie: '__Host-studio-oauth=' + value } }));
    assert.equal(response.status, 403);
    assert.equal((await f.storage.list({ prefix: 'sapix:code:' })).size, 0);
  } finally { globalThis.fetch = original; }
});

test('grades require their device token, never accept owner cookies or broader server credentials, and revoke independently', async () => {
  const f = await fixture(), first = await login(f), second = await login(f, 'w');
  for (const token of [undefined, ENV.STUDIO_RUNNER_TOKEN, ENV.UPLOAD_SECRET, ENV.GITHUB_TOKEN, 'f'.repeat(43)]) {
    const response = await f.state.fetch(request('/api/sapix/records', { token, cookie: f.cookie }));
    assert.equal(response.status, 401);
  }
  for (const origin of ['https://attacker.example', null, 'null']) {
    const response = await f.state.fetch(request('/api/sapix/records', { token: first.token, origin }));
    assert.equal(response.status, 403); assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal((await f.state.fetch(request('/api/studio/sources', { token: first.token }))).status, 401);
  assert.equal((await f.state.fetch(request('/api/studio/runner/drive-token', { token: first.token }))).status, 401);
  await json(f, '/api/sapix/auth/revoke', { method: 'POST', token: first.token });
  assert.equal((await f.state.fetch(request('/api/sapix/records', { token: first.token }))).status, 401);
  assert.equal((await f.state.fetch(request('/api/sapix/records', { token: second.token }))).status, 200);
  const key = 'sapix:token:' + hash(second.token), stored = await f.storage.get(key);
  await f.storage.put(key, { ...stored, expires: Date.now() - 1 });
  assert.equal((await f.state.fetch(request('/api/sapix/records', { token: second.token }))).status, 401);
});

test('two independently authenticated clients converge on concurrent additions, corrections and idempotent retry', async () => {
  const f = await fixture(), a = await login(f), b = await login(f, 'w');
  await Promise.all([write(f, a.token, [put('attempt_a')]), write(f, b.token, [put('attempt_b', 'geo-2', 1, 'x')])]);
  const initial = await json(f, '/api/sapix/records', { token: a.token });
  assert.equal(initial.entries.length, 2); assert.equal(initial.revision, 2);
  assert.deepEqual(initial.entries.map(row => row.order).sort(), [1, 2]);
  const amended = await write(f, a.token, [put('attempt_a', 'calc-1', 2, 't')]);
  assert.equal(amended.revision, 3);
  const retry = await write(f, a.token, [put('attempt_a', 'calc-1', 2, 't')]);
  assert.deepEqual(retry, amended);
  const stale = await write(f, b.token, [put('attempt_a', 'calc-1', 1, 'x')]);
  assert.deepEqual(stale, amended);
  const sameVersion = await write(f, b.token, [put('attempt_a', 'calc-1', 2, 'x')]);
  assert.deepEqual(sameVersion, amended);
  assert.deepEqual(await json(f, '/api/sapix/records', { token: b.token }), amended);
});

test('delete permanently wins over offline uploads, repeated delete is harmless, clear cannot delete unseen additions', async () => {
  const f = await fixture(), a = await login(f), b = await login(f, 'w');
  await write(f, a.token, [put('seen')]);
  await write(f, b.token, [put('unseen')]);
  const cleared = await write(f, a.token, [{ type: 'delete', id: 'seen' }]);
  assert.deepEqual(cleared.entries.map(row => row.id), ['unseen']); assert.deepEqual(cleared.deleted, ['seen']);
  const replay = await write(f, b.token, [put('seen', 'calc-1', 999)]);
  assert.deepEqual(replay, cleared);
  assert.deepEqual(await write(f, a.token, [{ type: 'delete', id: 'seen' }]), cleared);
  await write(f, a.token, [{ type: 'delete', id: 'offline_undone' }]);
  const undone = await write(f, a.token, [put('offline_undone')]);
  assert(!undone.entries.some(row => row.id === 'offline_undone'));
  assert(undone.deleted.includes('offline_undone'));
});

test('malformed data and cross-problem reuse reject the complete batch without modifying records', async () => {
  const f = await fixture(), a = await login(f);
  const before = await write(f, a.token, [put('original')]);
  for (const bad of [
    { ...put('bad'), id: '__id/invalid' }, { ...put('bad'), id: 'x'.repeat(1025) },
    { ...put('bad'), pid: '__proto__' }, { ...put('bad'), pid: 'x'.repeat(201) }, { ...put('bad'), pid: 'x\n' },
    { ...put('bad'), seq: 0 }, { ...put('bad'), seq: 1.5 },
    { ...put('bad'), value: { d: '2026-02-29', r: 'o' } }, { ...put('bad'), value: { d: '2026-09-26', r: 'wrong' } },
    { ...put('bad'), value: { d: '2026-09-26', r: 'o', s: -1 } }, { ...put('bad'), value: { d: '2026-09-26', r: 'o', s: null } },
    { ...put('bad'), value: { d: '2026-09-26', r: 'o', over: 'true' } }, { ...put('bad'), value: { d: '2026-09-26', r: 'o', secret: 'unexpected' } },
    { type: 'delete', id: 'original', all: true }, put('original', 'other-problem', 2),
  ]) {
    const response = await f.state.fetch(request('/api/sapix/records', { token: a.token, method: 'POST', body: { ops: [put('would_be_added'), bad] } }));
    assert.equal(response.status, 400);
    assert.deepEqual(await json(f, '/api/sapix/records', { token: a.token }), before);
  }
  const tooMany = await f.state.fetch(request('/api/sapix/records', { token: a.token, method: 'POST', body: { ops: Array.from({ length: 1001 }, (_, index) => put('a' + index)) } }));
  assert.equal(tooMany.status, 400);
  await f.storage.put('sapix:meta', { revision: 1, order: 1, count: 100000 });
  const full = await f.state.fetch(request('/api/sapix/records', { token: a.token, method: 'POST', body: { ops: [put('original', 'calc-1', 2, 'x'), put('one_too_many')] } }));
  assert.equal(full.status, 413);
  assert.deepEqual(await json(f, '/api/sapix/records', { token: a.token }), before);
});

test('long deterministic legacy IDs and many attempts use bounded per-record values and never modify Studio data', async () => {
  const f = await fixture(), a = await login(f);
  const untouched = { status: 'needs_attention', id: 'real-job-placeholder' };
  await f.storage.put('job:unrelated', untouched); await f.storage.put('google', 'protected-token');
  const legacy = 'legacy-' + Buffer.from(JSON.stringify(['図形-1', '2026-09-26', 'o', null, null, 0])).toString('base64url');
  const ops = [put(legacy, '図形-1'), ...Array.from({ length: 999 }, (_, index) => put('many_' + index))];
  const result = await write(f, a.token, ops);
  assert.equal(result.entries.length, 1000); assert.equal(result.revision, 1);
  assert.equal((await f.storage.list({ prefix: 'sapix:record:' })).size, 1000);
  for (const [key, value] of await f.storage.list({ prefix: 'sapix:record:' })) { assert(key.length < 100); assert(JSON.stringify(value).length < 2000); }
  assert.deepEqual(await f.storage.get('job:unrelated'), untouched);
  assert.equal(await f.storage.get('google'), 'protected-token');
});

async function identityCallback(f, started, email, tokenOverrides = {}) {
  const cookie = started.headers.get('Set-Cookie').split(';')[0];
  const oauth = await unseal(cookie.slice(cookie.indexOf('=') + 1), f.env.STUDIO_SECRET, 'oauth');
  const original = globalThis.fetch;
  globalThis.fetch = async url => url === 'https://oauth2.googleapis.com/token'
    ? Response.json({ access_token: 'fake-identity-token', expires_in: 3600, scope: 'openid email', ...tokenOverrides })
    : Response.json({ email, email_verified: true });
  try { return await f.state.fetch(request('/api/studio/google/callback?state=' + oauth.state + '&code=test-google-code', { headers: { Cookie: cookie } })); }
  finally { globalThis.fetch = original; }
}

async function childLogin(f) {
  const verifier = 'c'.repeat(43), state = 'd'.repeat(24);
  const started = await f.state.fetch(request('/api/sapix/auth/start?' + new URLSearchParams({ state, challenge: hash(verifier) }), { cookie: f.cookie }));
  assert.equal(started.status, 302);
  const google = new URL(started.headers.get('Location'));
  assert.equal(google.origin, 'https://accounts.google.com');
  assert.equal(google.searchParams.get('login_hint'), f.env.SAPIX_OWNER_EMAIL);
  assert.equal(google.searchParams.get('prompt'), 'select_account');
  assert.equal(google.searchParams.get('scope'), 'openid email');
  const response = await identityCallback(f, started, f.env.SAPIX_OWNER_EMAIL);
  assert.equal(response.status, 302);
  assert(!response.headers.get('Set-Cookie').includes('__Host-studio='));
  const fragment = new URLSearchParams(new URL(response.headers.get('Location')).hash.slice(1));
  assert.equal(fragment.get('sapix_state'), state);
  return json(f, '/api/sapix/auth/exchange', { method: 'POST', body: { code: fragment.get('sapix_code'), verifier } });
}

test('a dedicated child account signs into grading without inheriting or receiving Studio and Drive access', async () => {
  const f = await fixture({ SAPIX_OWNER_EMAIL: 'child@example.test' });
  await f.storage.put('google', 'existing-studio-drive-credential');
  await f.storage.put('job:untouched', { status: 'needs_attention' });
  const child = await childLogin(f);
  assert.equal(child.email, f.env.SAPIX_OWNER_EMAIL);
  const snapshot = await write(f, child.token, [put('child_attempt')]);
  assert.equal(snapshot.entries.length, 1);
  assert.equal((await f.state.fetch(request('/api/studio/sources', { token: child.token }))).status, 401);
  assert.equal((await f.state.fetch(request('/api/studio/runner/drive-token', { token: child.token }))).status, 401);
  const childCookie = await seal({ email: f.env.SAPIX_OWNER_EMAIL, csrf: 'test', expires: Date.now() + 60000 }, f.env.STUDIO_SECRET, 'session');
  assert.equal((await f.state.fetch(request('/api/studio/sources', { cookie: childCookie }))).status, 401);
  assert.deepEqual(await f.storage.get('job:untouched'), { status: 'needs_attention' });
  assert.equal(await f.storage.get('google'), 'existing-studio-drive-credential');
  assert.equal(f.state.access, undefined);
});

test('Studio owner identity and a valid Studio cookie cannot authorize a different grading account', async () => {
  const f = await fixture({ SAPIX_OWNER_EMAIL: 'child@example.test' });
  const started = await f.state.fetch(request('/api/sapix/auth/start?' + new URLSearchParams({ state: 's'.repeat(24), challenge: hash('v'.repeat(43)) }), { cookie: f.cookie }));
  assert.equal(new URL(started.headers.get('Location')).origin, 'https://accounts.google.com');
  assert.equal((await identityCallback(f, started, f.env.STUDIO_OWNER_EMAIL)).status, 403);
  assert.equal((await f.storage.list({ prefix: 'sapix:code:' })).size, 0);
  assert.equal((await f.state.fetch(request('/api/sapix/records', { cookie: f.cookie }))).status, 401);
});

test('owner change invalidates old tokens and pending old or ownerless codes while preserving all records', async () => {
  const f = await fixture(), original = await login(f);
  const existing = await write(f, original.token, [put('existing_grade'), { type: 'delete', id: 'existing_deleted' }]);
  const verifier = 'p'.repeat(43), state = 'q'.repeat(24);
  const started = await f.state.fetch(request('/api/sapix/auth/start?' + new URLSearchParams({ state, challenge: hash(verifier) }), { cookie: f.cookie }));
  const oldCode = new URLSearchParams(new URL(started.headers.get('Location')).hash.slice(1)).get('sapix_code');
  assert.equal((await f.storage.get('sapix:code:' + hash(oldCode))).email, ENV.SAPIX_OWNER_EMAIL);
  const legacyCode = 'l'.repeat(43);
  await f.storage.put('sapix:code:' + hash(legacyCode), { challenge: hash(verifier), expires: Date.now() + 60000 });
  f.env.SAPIX_OWNER_EMAIL = 'child@example.test';
  assert.equal((await f.state.fetch(request('/api/sapix/records', { token: original.token }))).status, 401);
  assert.equal((await f.state.fetch(request('/api/sapix/records', { token: original.token, method: 'POST', body: { ops: [put('must_not_be_added')] } }))).status, 401);
  for (const code of [oldCode, legacyCode]) {
    const rejected = await f.state.fetch(request('/api/sapix/auth/exchange', { method: 'POST', body: { code, verifier } }));
    assert.equal(rejected.status, 401);
  }
  const child = await childLogin(f);
  assert.deepEqual(await json(f, '/api/sapix/records', { token: child.token }), existing);
  assert.equal((await f.state.fetch(request('/api/sapix/records', { token: original.token }))).status, 401);
});

test('OAuth started for the former grading owner cannot finish after an account change, including older ownerless cookies', async () => {
  const f = await fixture();
  const started = await f.state.fetch(request('/api/sapix/auth/start?' + new URLSearchParams({ state: 's'.repeat(24), challenge: hash('v'.repeat(43)) })));
  const cookie = started.headers.get('Set-Cookie').split(';')[0];
  const pending = await unseal(cookie.slice(cookie.indexOf('=') + 1), f.env.STUDIO_SECRET, 'oauth');
  f.env.SAPIX_OWNER_EMAIL = 'child@example.test';
  const original = globalThis.fetch; let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw Error('must reject before contacting Google'); };
  try {
    for (const login of [pending, { ...pending, sapix: { state: pending.sapix.state, challenge: pending.sapix.challenge } }]) {
      const sealed = await seal(login, f.env.STUDIO_SECRET, 'oauth');
      const response = await f.state.fetch(request('/api/studio/google/callback?state=' + pending.state + '&code=pending-google-code', { headers: { Cookie: '__Host-studio-oauth=' + sealed } }));
      assert.equal(response.status, 403);
    }
    assert.equal(providerCalls, 0);
    assert.equal((await f.storage.list({ prefix: 'sapix:code:' })).size, 0);
  } finally { globalThis.fetch = original; }
});

test('Studio Google login keeps its original owner and Drive consent when the grading owner differs', async () => {
  const f = await fixture({ SAPIX_OWNER_EMAIL: 'child@example.test' });
  const started = await f.state.fetch(request('/api/studio/google/start'));
  const google = new URL(started.headers.get('Location'));
  assert.equal(google.searchParams.get('login_hint'), f.env.STUDIO_OWNER_EMAIL);
  assert.equal(google.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/drive');
  assert.equal(google.searchParams.get('prompt'), 'consent');
  assert.equal(google.searchParams.get('access_type'), 'offline');
  const response = await identityCallback(f, started, f.env.STUDIO_OWNER_EMAIL, { refresh_token: 'fake-studio-refresh', scope: 'openid email https://www.googleapis.com/auth/drive' });
  assert.equal(response.status, 302); assert.equal(response.headers.get('Location'), '/studio');
  assert.match(response.headers.get('Set-Cookie'), /__Host-studio=/);
  assert.equal((await unseal(await f.storage.get('google'), f.env.STUDIO_SECRET, 'google')).email, f.env.STUDIO_OWNER_EMAIL);
  assert.equal((await f.storage.list({ prefix: 'sapix:code:' })).size, 0);
  const denied = await identityCallback(f, started, f.env.SAPIX_OWNER_EMAIL, { refresh_token: 'must-not-store', scope: 'openid email https://www.googleapis.com/auth/drive' });
  assert.equal(denied.status, 403);
  assert.equal((await unseal(await f.storage.get('google'), f.env.STUDIO_SECRET, 'google')).refreshToken, 'fake-studio-refresh');
});

test('missing grading owner fails closed instead of falling back to the Studio owner', async () => {
  const f = await fixture({ SAPIX_OWNER_EMAIL: undefined });
  const response = await f.state.fetch(request('/api/sapix/auth/start?' + new URLSearchParams({ state: 's'.repeat(24), challenge: hash('v'.repeat(43)) }), { cookie: f.cookie }));
  assert.equal(response.status, 503);
  assert.equal((await f.storage.list({ prefix: 'sapix:code:' })).size, 0);
});
