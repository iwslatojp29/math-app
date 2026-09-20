import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { StudioState, FOLDERS, seal, unseal } from '../src/studio.js';
import { studioPage, studioScript } from '../src/studio-ui.js';

// Deliberately fake fixtures. No environment variables or real credentials are read.
const ENV = {
  GOOGLE_CLIENT_ID: 'fake-google-client', GOOGLE_CLIENT_SECRET: 'fake-google-secret',
  STUDIO_SECRET: 'fake-studio-encryption-secret-for-unit-tests', STUDIO_RUNNER_TOKEN: 'fake-runner-token',
  STUDIO_OWNER_EMAIL: 'owner@example.test', STUDIO_ORIGIN: 'https://studio.example.test',
  GITHUB_TOKEN: 'fake-github-token', OPENAI_API_KEY: 'fake-openai-key', REPO: 'example/math-app', BRANCH: 'main',
};
const CSRF = 'fake-csrf-token';
const SOURCE = { id: 'source-pdf', name: '2026年9月号.pdf', mimeType: 'application/pdf', md5Checksum: 'source-checksum', modifiedTime: '2026-09-01T00:00:00Z', parents: [FOLDERS.source] };
const CATALOG = { defaultModel: 'gpt-6-astra', latestVerified: true, checkedAt: new Date().toISOString(), verifiedAt: new Date().toISOString(), models: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', maxOutputTokens: 128000 }, { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', maxOutputTokens: 64000 }] };
const clone = value => value === undefined ? undefined : structuredClone(value);
class MemoryStorage {
  values = new Map();
  alarmAt = null;
  alarmWrites = [];
  async getAlarm() { return this.alarmAt; }
  async setAlarm(value) { this.alarmAt = value; this.alarmWrites.push(value); }
  async get(key) { return Array.isArray(key) ? new Map(key.filter(k => this.values.has(k)).map(k => [k, clone(this.values.get(k))])) : clone(this.values.get(key)); }
  async put(key, value) { if (typeof key === 'object') { for (const [k, v] of Object.entries(key)) this.values.set(k, clone(v)); } else this.values.set(key, clone(value)); }
  async delete(key) { for (const k of Array.isArray(key) ? key : [key]) this.values.delete(k); }
  async list({ prefix = '' } = {}) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, clone(value)])); }
  async transaction(action) { const before = clone(this.values); try { return await action(this); } catch (error) { this.values = before; throw error; } }
}
async function fixture() {
  const storage = new MemoryStorage();
  const state = new StudioState({ storage }, { ...ENV });
  state.access = { accessToken: 'fake-google-access', expires: Date.now() + 3600000 };
  await storage.put('catalog-v2', CATALOG);
  const cookie = await seal({ email: ENV.STUDIO_OWNER_EMAIL, csrf: CSRF, expires: Date.now() + 3600000 }, ENV.STUDIO_SECRET, 'session');
  return { state, storage, cookie };
}
function request(path, { method = 'GET', body, cookie, csrf = CSRF, origin = ENV.STUDIO_ORIGIN, runner = false, headers = {} } = {}) {
  const h = new Headers(headers);
  if (cookie) h.set('Cookie', '__Host-studio=' + cookie);
  if (origin !== null) h.set('Origin', origin);
  if (csrf !== null) h.set('x-studio-csrf', csrf);
  if (runner) { h.set('Authorization', 'Bearer ' + ENV.STUDIO_RUNNER_TOKEN); if (!h.has('X-Studio-Run-Id')) h.set('X-Studio-Run-Id', '42'); }
  if (body !== undefined) h.set('Content-Type', 'application/json');
  return new Request(ENV.STUDIO_ORIGIN + path, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function withFetch(mock, action) { const original = globalThis.fetch; globalThis.fetch = mock; try { return await action(); } finally { globalThis.fetch = original; } }
function cloud({ source = SOURCE, dispatch, pages } = {}) {
  const calls = [];
  return { calls, fetch: async (input, options = {}) => {
    const url = new URL(input); calls.push({ url, method: options.method || 'GET' });
    if (url.origin === 'https://www.googleapis.com' && url.pathname === '/drive/v3/files') {
      assert.equal(options.headers.Authorization, 'Bearer fake-google-access');
      const query = url.searchParams.get('q');
      assert.match(query, /trashed = false/);
      assert.match(query, /mimeType = 'application\/pdf'/);
      if (pages) return Response.json(pages(url));
      assert(query.startsWith(`'${FOLDERS.source}' in parents`));
      return Response.json({ files: [source] });
    }
    if (url.pathname.endsWith('/actions/workflows/monthly-pdf.yml/dispatches')) {
      assert.equal(options.method, 'POST');
      return dispatch ? dispatch(url, options) : new Response(null, { status: 204 });
    }
    throw new Error('Unexpected mock request: ' + url.pathname);
  } };
}
function job(overrides = {}) {
  return { id: 'job-test', fileId: SOURCE.id, fileName: SOURCE.name, source: SOURCE, model: 'gpt-6-astra', fingerprint: 'fake-fingerprint', status: 'running', stage: 'generating', progress: 25, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), runId: null, ...overrides };
}

test('sessions reject unauthenticated, expired, wrong-owner and tampered cookies without touching providers', async () => {
  const { state, cookie } = await fixture();
  await withFetch(() => { throw new Error('Provider must not be called'); }, async () => {
    const initial = await (await state.fetch(request('/api/studio/session'))).json();
    assert.deepEqual(initial, { authenticated: false, configured: true });
    const valid = await (await state.fetch(request('/api/studio/session', { cookie }))).json();
    assert.equal(valid.authenticated, true); assert.equal(valid.csrf, CSRF);
    const expired = await seal({ email: ENV.STUDIO_OWNER_EMAIL, csrf: CSRF, expires: Date.now() - 1 }, ENV.STUDIO_SECRET, 'session');
    const other = await seal({ email: 'other@example.test', csrf: CSRF, expires: Date.now() + 60000 }, ENV.STUDIO_SECRET, 'session');
    for (const invalid of [null, expired, other, 'broken.' + cookie]) {
      const response = await state.fetch(request('/api/studio/sources', { cookie: invalid }));
      assert.equal(response.status, 401); assert.equal((await response.json()).error, 'unauthorized');
    }
  });
});

test('mutations require both matching Origin and session CSRF, and runner endpoints require their separate token', async () => {
  const { state, cookie } = await fixture();
  for (const override of [{ csrf: null }, { csrf: 'wrong' }, { origin: null }, { origin: 'https://attacker.example' }]) {
    const response = await state.fetch(request('/api/studio/jobs', { cookie, method: 'POST', body: { fileId: SOURCE.id }, ...override }));
    assert.equal(response.status, 403);
  }
  const runner = await state.fetch(request('/api/studio/runner/drive-token', { cookie }));
  assert.equal(runner.status, 401);
  const authorized = await state.fetch(request('/api/studio/runner/drive-token', { runner: true }));
  assert.equal((await authorized.json()).accessToken, 'fake-google-access');
  const logout = await state.fetch(request('/api/studio/logout', { cookie, method: 'POST', body: {} }));
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=0/);
});

test('encrypted token storage is authenticated and purpose-separated', async () => {
  const original = { refreshToken: 'fake-refresh-token-for-tests', email: ENV.STUDIO_OWNER_EMAIL };
  const encrypted = await seal(original, ENV.STUDIO_SECRET, 'google');
  assert(!encrypted.includes(original.refreshToken));
  assert.deepEqual(await unseal(encrypted, ENV.STUDIO_SECRET, 'google'), original);
  assert.equal(await unseal(encrypted, ENV.STUDIO_SECRET, 'session'), null);
  assert.equal(await unseal(encrypted, 'wrong-secret', 'google'), null);
  assert.equal(await unseal('A' + encrypted, ENV.STUDIO_SECRET, 'google'), null);
});

test('OAuth starts with state + PKCE and stores only encrypted refresh data after owner verification', async () => {
  const { state, storage } = await fixture();
  const start = await state.fetch(request('/api/studio/google/start'));
  assert.equal(start.status, 302);
  const target = new URL(start.headers.get('Location'));
  assert.equal(target.origin, 'https://accounts.google.com');
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert(target.searchParams.get('code_challenge'));
  assert.equal(target.searchParams.get('redirect_uri'), ENV.STUDIO_ORIGIN + '/api/studio/google/callback');
  assert(!target.href.includes(ENV.GOOGLE_CLIENT_SECRET));
  const oauthCookie = start.headers.get('Set-Cookie').split(';')[0];
  const oauth = await unseal(oauthCookie.split('=')[1], ENV.STUDIO_SECRET, 'oauth');
  assert.equal(oauth.state, target.searchParams.get('state'));
  const callback = request('/api/studio/google/callback?state=' + encodeURIComponent(oauth.state) + '&code=fake-code', { headers: { Cookie: oauthCookie } });
  const response = await withFetch(async (input, options) => {
    if (String(input) === 'https://oauth2.googleapis.com/token') {
      assert.equal(options.body.get('code_verifier'), oauth.verifier);
      return Response.json({ access_token: 'fake-new-access', refresh_token: 'fake-new-refresh', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/drive' });
    }
    assert.equal(String(input), 'https://openidconnect.googleapis.com/v1/userinfo');
    return Response.json({ email: ENV.STUDIO_OWNER_EMAIL, email_verified: true });
  }, () => state.fetch(callback));
  assert.equal(response.status, 302);
  const saved = await storage.get('google');
  assert(!saved.includes('fake-new-refresh'));
  assert.equal((await unseal(saved, ENV.STUDIO_SECRET, 'google')).refreshToken, 'fake-new-refresh');
  assert(!JSON.stringify([...storage.values]).includes('fake-new-access'));
  assert(!response.headers.get('Set-Cookie').includes('fake-new-refresh'));
  assert(!response.headers.get('Set-Cookie').includes('fake-new-access'));
});

test('OAuth rejects incorrect state and non-owner identity without persisting tokens', async () => {
  const { state, storage } = await fixture();
  const value = await seal({ state: 'fake-state', verifier: 'fake-verifier', expires: Date.now() + 60000 }, ENV.STUDIO_SECRET, 'oauth');
  const headers = { Cookie: '__Host-studio-oauth=' + value };
  let requests = 0;
  await withFetch(async input => {
    requests++;
    return String(input).endsWith('/token') ? Response.json({ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive' }) : Response.json({ email: 'not-owner@example.test', email_verified: true });
  }, async () => {
    const badState = await state.fetch(request('/api/studio/google/callback?state=wrong&code=fake', { headers }));
    assert.equal(badState.status, 403); assert.equal(requests, 0);
    const badOwner = await state.fetch(request('/api/studio/google/callback?state=fake-state&code=fake', { headers }));
    assert.equal(badOwner.status, 403); assert.equal(await storage.get('google'), undefined);
  });
});

test('source discovery stays within the configured tree, follows pagination and excludes generated folders', async () => {
  const { state } = await fixture();
  const visited = [];
  const mock = cloud({ pages: url => {
    const parent = url.searchParams.get('q').match(/^'([^']+)'/)[1];
    visited.push(parent);
    if (parent === FOLDERS.source && !url.searchParams.has('pageToken')) return { nextPageToken: 'page-2', files: [SOURCE, { id: 'nested', name: 'nested', mimeType: 'application/vnd.google-apps.folder' }, { id: FOLDERS.practice, mimeType: 'application/vnd.google-apps.folder' }, { id: FOLDERS.advanced, mimeType: 'application/vnd.google-apps.folder' }] };
    if (parent === FOLDERS.source) return { files: [{ ...SOURCE, id: 'second', name: '2026年8月号.pdf' }] };
    assert.equal(parent, 'nested');
    return { files: [{ ...SOURCE, id: 'nested-pdf', name: '2026年7月号.pdf' }] };
  } });
  const files = await withFetch(mock.fetch, () => state.sources());
  assert.deepEqual(files.map(file => file.id), [SOURCE.id, 'second', 'nested-pdf']);
  assert.deepEqual(visited, [FOLDERS.source, FOLDERS.source, 'nested']);
});

test('concurrent identical job creation dispatches once and forbids arbitrary Drive IDs', async () => {
  const { state, cookie } = await fixture();
  const mock = cloud();
  await withFetch(mock.fetch, async () => {
    const responses = await Promise.all(Array.from({ length: 3 }, () => state.fetch(request('/api/studio/jobs', { method: 'POST', cookie, body: { fileId: SOURCE.id, model: 'auto' } }))));
    const bodies = await Promise.all(responses.map(response => response.json()));
    assert.equal(new Set(bodies.map(body => body.job.id)).size, 1);
    assert.equal(mock.calls.filter(call => call.url.pathname.endsWith('/dispatches')).length, 1);
    assert.equal((await state.jobs()).length, 1);
    assert.equal(bodies[0].job.model, 'gpt-6-astra');
    assert.equal(bodies[0].job.fingerprint, undefined, 'public job must omit internal fingerprint');
    assert.equal(bodies[0].job.folders, undefined, 'public job must omit runner settings');
    const outside = await state.fetch(request('/api/studio/jobs', { method: 'POST', cookie, body: { fileId: 'outside-the-source-tree', model: 'auto' } }));
    assert.equal(outside.status, 404);
  });
});

test('auto refuses unverified latest while explicit available selection works; unknown models fail', async () => {
  const { state, storage, cookie } = await fixture();
  await storage.put('catalog-v2', { ...CATALOG, latestVerified: false });
  const mock = cloud();
  await withFetch(mock.fetch, async () => {
    for (const model of ['auto', 'gpt-imaginary']) {
      const response = await state.fetch(request('/api/studio/jobs', { method: 'POST', cookie, body: { fileId: SOURCE.id, model } }));
      assert.equal(response.status, 409); assert.equal((await response.json()).error, 'latest_unavailable');
    }
    const explicit = await state.fetch(request('/api/studio/jobs', { method: 'POST', cookie, body: { fileId: SOURCE.id, model: 'gpt-5.6-sol' } }));
    assert.equal(explicit.status, 200); assert.equal((await explicit.json()).job.model, 'gpt-5.6-sol');
    assert.equal(mock.calls.filter(call => call.url.pathname.endsWith('/dispatches')).length, 1);
  });
});

test('a different model cannot start while another job is active, and changed source revisions produce a new job', async () => {
  const { state, cookie } = await fixture();
  const source = clone(SOURCE), mock = cloud({ source });
  await withFetch(mock.fetch, async () => {
    const first = (await (await state.fetch(request('/api/studio/jobs', { cookie, method: 'POST', body: { fileId: SOURCE.id, model: 'auto' } }))).json()).job;
    const busy = await state.fetch(request('/api/studio/jobs', { cookie, method: 'POST', body: { fileId: SOURCE.id, model: 'gpt-5.6-sol' } }));
    assert.equal(busy.status, 409); assert.equal((await busy.json()).error, 'busy');
    await state.saveJob({ ...await state.job(first.id), status: 'completed' });
    source.md5Checksum = 'new-source-checksum';
    const next = (await (await state.fetch(request('/api/studio/jobs', { cookie, method: 'POST', body: { fileId: SOURCE.id, model: 'auto' } }))).json()).job;
    assert.notEqual(next.id, first.id);
  });
});

test('cancellation persists and rejects late runner state updates and publishing', async () => {
  const { state, cookie } = await fixture();
  await state.saveJob(job());
  const cancelled = await state.fetch(request('/api/studio/jobs/job-test/cancel', { cookie, method: 'POST', body: {} }));
  assert.equal((await cancelled.json()).job.status, 'cancelled');
  const update = await state.fetch(request('/api/studio/runner/jobs/job-test', { runner: true, method: 'PATCH', body: { status: 'completed' } }));
  assert.equal(update.status, 409);
  const publish = await state.fetch(request('/api/studio/runner/jobs/job-test/publish', { runner: true, method: 'POST', body: {} }));
  assert.equal(publish.status, 409);
  assert.equal((await state.job('job-test')).status, 'cancelled');
});

test('checkpoint chunks preserve Unicode and atomic replacement removes the old chunks', async () => {
  const { state, storage } = await fixture();
  await state.saveJob(job({ runId: '42' }));
  const endpoint = '/api/studio/runner/jobs/job-test/checkpoints/analysis.json';
  const value = { text: '数学🧮'.repeat(18000), problems: [{ id: 'one', answer: '42' }] };
  const saved = await state.fetch(request(endpoint, { runner: true, method: 'PUT', body: { value } }));
  assert.equal(saved.status, 200);
  const read = await state.fetch(request(endpoint, { runner: true }));
  assert.deepEqual((await read.json()).value, value);
  const previous = await storage.get('checkpoint:job-test:analysis.json');
  const replaced = await state.fetch(request(endpoint, { runner: true, method: 'PUT', body: { value: { text: 'replacement' } } }));
  assert.equal(replaced.status, 200);
  assert.equal([...storage.values.keys()].some(key => key.includes(previous.version)), false);
});

function gitFixture({ initial = {}, dropAfterPatch = false } = {}) {
  const blobs = new Map(), trees = new Map(), commits = new Map(), calls = [];
  let revision = 0, head = 'commit-0', dropped = false;
  const blob = bytes => { const sha = createHash('sha1').update(bytes).digest('hex'); blobs.set(sha, Buffer.from(bytes)); return sha; };
  const initialFiles = { 'math/index.html': '<!doctype html><html><body><h1>教材</h1></body></html>', ...initial };
  trees.set('tree-0', new Map(Object.entries(initialFiles).map(([path, content]) => [path, blob(Buffer.from(content))])));
  commits.set(head, { sha: head, tree: { sha: 'tree-0' }, parents: [] });
  const files = () => new Map([...trees.get(commits.get(head).tree.sha)].map(([path, sha]) => [path, blobs.get(sha).toString()]));
  const writeManual = (path, content) => {
    const next = new Map(trees.get(commits.get(head).tree.sha)); next.set(path, blob(Buffer.from(content)));
    const id = ++revision, tree = `manual-tree-${id}`, commit = `manual-commit-${id}`;
    trees.set(tree, next); commits.set(commit, { sha: commit, tree: { sha: tree }, parents: [head] }); head = commit;
  };
  return { calls, files, writeManual, fetch: async (input, options = {}) => {
    const url = new URL(input), path = url.pathname.replace('/repos/example/math-app/', ''), method = options.method || 'GET';
    assert.equal(url.origin, 'https://api.github.com');
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method, body });
    if (path === 'git/ref/heads/main') return Response.json({ object: { sha: head } });
    if (path.startsWith('git/commits/') && method === 'GET') return Response.json(commits.get(path.slice('git/commits/'.length)));
    if (path.startsWith('git/trees/') && method === 'GET') return Response.json({ truncated: false, tree: [...trees.get(path.slice('git/trees/'.length))].map(([path, sha]) => ({ path, sha, mode: '100644', type: 'blob' })) });
    if (path.startsWith('git/blobs/') && method === 'GET') return Response.json({ content: blobs.get(path.slice('git/blobs/'.length)).toString('base64'), encoding: 'base64' });
    if (path === 'git/blobs' && method === 'POST') return Response.json({ sha: blob(Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8')) });
    if (path === 'git/trees' && method === 'POST') {
      const tree = new Map(trees.get(body.base_tree)); for (const entry of body.tree) tree.set(entry.path, entry.sha);
      const sha = 'tree-' + ++revision; trees.set(sha, tree); return Response.json({ sha });
    }
    if (path === 'git/commits' && method === 'POST') { const sha = 'commit-' + ++revision; commits.set(sha, { sha, tree: { sha: body.tree }, parents: body.parents }); return Response.json({ sha }); }
    if (path === 'git/refs/heads/main' && method === 'PATCH') {
      assert.equal(body.force, false);
      if (commits.get(body.sha).parents[0] !== head) return Response.json({}, { status: 422 });
      head = body.sha;
      if (dropAfterPatch && !dropped) { dropped = true; throw new Error('Fake transport interruption after atomic ref update'); }
      return Response.json({ object: { sha: head } });
    }
    throw new Error('Unexpected mock GitHub request: ' + path);
  } };
}
const OUTPUT_NAME = '2026年9月号‗日日の演習_講義アニメーション.html';
const OUTPUT_PATH = 'math/' + OUTPUT_NAME;
const OUTPUT_HTML = '<!doctype html><html><head><meta name="math-app-generated-lesson" content="v1"></head><body>数学の教材</body></html>';
const PUBLISH_BODY = { fileName: OUTPUT_NAME, contentBase64: Buffer.from(OUTPUT_HTML).toString('base64') };
async function publishRequest(state, body = PUBLISH_BODY) { return state.fetch(request('/api/studio/runner/jobs/job-test/publish', { runner: true, method: 'POST', body })); }

test('publishing creates lesson and index together in one atomic branch update and a retry is idempotent', async () => {
  const { state } = await fixture(); await state.saveJob(job({ runId: '42' }));
  const git = gitFixture();
  await withFetch(git.fetch, async () => {
    const response = await publishRequest(state); assert.equal(response.status, 200);
    assert.equal((await response.json()).path, OUTPUT_PATH);
    assert.equal(git.files().get(OUTPUT_PATH), OUTPUT_HTML);
    assert(git.files().get('math/index.html').includes(encodeURIComponent(OUTPUT_NAME)));
    const tree = git.calls.find(call => call.path === 'git/trees' && call.method === 'POST');
    assert.deepEqual(tree.body.tree.map(entry => entry.path), [OUTPUT_PATH, 'math/index.html']);
    assert.equal(git.calls.filter(call => call.method === 'PATCH').length, 1);
    const retry = await publishRequest(state); assert.equal(retry.status, 200);
    assert.equal(git.calls.filter(call => call.method === 'PATCH').length, 1);
  });
});

test('publishing protects an existing manual file and rejects unapproved output names', async () => {
  const { state } = await fixture(); await state.saveJob(job({ runId: '42' }));
  const git = gitFixture({ initial: { [OUTPUT_PATH]: 'manual lesson, preserve me' } });
  await withFetch(git.fetch, async () => {
    const response = await publishRequest(state); assert.equal(response.status, 409); assert.equal((await response.json()).error, 'existing_file');
    assert.equal(git.files().get(OUTPUT_PATH), 'manual lesson, preserve me');
    assert.equal(git.calls.some(call => call.method !== 'GET'), false);
    const invalid = await publishRequest(state, { ...PUBLISH_BODY, fileName: 'index.html' });
    assert.equal(invalid.status, 400);
  });
});

test('a response lost after publishing can be retried, but later manual edits are protected', async () => {
  const { state } = await fixture(); await state.saveJob(job({ runId: '42' }));
  const git = gitFixture({ dropAfterPatch: true });
  await withFetch(git.fetch, async () => {
    const interrupted = await publishRequest(state); assert.equal(interrupted.status, 500);
    assert.equal(git.files().get(OUTPUT_PATH), OUTPUT_HTML);
    const retry = await publishRequest(state); assert.equal(retry.status, 200);
    assert.equal(git.calls.filter(call => call.method === 'PATCH').length, 1);
    git.writeManual(OUTPUT_PATH, 'manually corrected after publishing');
    const protectedResponse = await publishRequest(state); assert.equal(protectedResponse.status, 409);
    assert.equal(git.files().get(OUTPUT_PATH), 'manually corrected after publishing');
  });
});

test('reconcile cannot overwrite a cancellation that arrives while the GitHub status request is pending', async () => {
  const { state, cookie } = await fixture();
  await state.saveJob(job({ status: 'running', updatedAt: new Date(Date.now() - 180000).toISOString() }));
  let resolveRuns, queried;
  const started = new Promise(resolve => { queried = resolve; });
  await withFetch(() => { queried(); return new Promise(resolve => { resolveRuns = resolve; }); }, async () => {
    const reconciliation = state.reconcile(); await started;
    const cancelled = await state.fetch(request('/api/studio/jobs/job-test/cancel', { cookie, method: 'POST', body: {} }));
    assert.equal(cancelled.status, 200);
    resolveRuns(Response.json({ workflow_runs: [{ id: 42, display_title: 'monthly-job-test', status: 'completed', conclusion: 'cancelled' }] }));
    await reconciliation;
    assert.equal((await state.job('job-test')).status, 'cancelled');
  });
});

test('retry reconciles an uncertain dispatch before starting another live run for the same job', async () => {
  const { state, cookie } = await fixture();
  await state.saveJob(job({ status: 'needs_attention' }));
  let dispatched = 0;
  await withFetch(async (input, options) => {
    if (String(input).includes('/dispatches')) { dispatched++; return new Response(null, { status: 204 }); }
    if (String(input).includes('/runs')) return Response.json({ workflow_runs: [{ id: 42, display_title: 'monthly-job-test', status: 'in_progress' }] });
    throw new Error('Unexpected retry request');
  }, async () => {
    const response = await state.fetch(request('/api/studio/jobs/job-test/retry', { cookie, method: 'POST', body: {} }));
    assert.equal(response.status, 200);
    assert.equal(dispatched, 0, 'uncertain initial dispatch must not create a second live workflow');
    assert.equal(String((await state.job('job-test')).runId), '42');
  });
});

test('a competing workflow run cannot replace the active job runner claim', async () => {
  const { state } = await fixture();
  await state.saveJob(job({ runId: '42' }));
  const response = await state.fetch(request('/api/studio/runner/jobs/job-test', { runner: true, method: 'PATCH', headers: { 'X-Studio-Run-Id': '43' }, body: { status: 'running', runId: '43' } }));
  assert.equal(response.status, 409);
  assert.equal((await state.job('job-test')).runId, '42');
});

test('concurrent initial runner claims elect one owner', async () => {
  const { state } = await fixture();
  await state.saveJob(job({ status: 'queued', runId: null }));
  const responses = await Promise.all(['42', '43'].map(runId => state.fetch(request('/api/studio/runner/jobs/job-test', {
    runner: true, method: 'PATCH', headers: { 'X-Studio-Run-Id': runId }, body: { status: 'running', runId },
  }))));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert(['42', '43'].includes((await state.job('job-test')).runId));
});

test('checkpoint writes recheck cancellation or runner replacement after waiting for storage', async () => {
  for (const update of [{ status: 'cancelled' }, { runId: '43' }]) {
    const { state, storage } = await fixture();
    await state.saveJob(job({ runId: '42' }));
    const endpoint = '/api/studio/runner/jobs/job-test/checkpoints/analysis.json';
    assert.equal((await state.fetch(request(endpoint, { runner: true, method: 'PUT', body: { value: 'original' } }))).status, 200);
    const before = await storage.list({ prefix: 'checkpoint:' });
    let waiting, release;
    const entered = new Promise(resolve => { waiting = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const transaction = storage.transaction.bind(storage);
    storage.transaction = async action => { waiting(); await barrier; return transaction(action); };
    const writing = state.fetch(request(endpoint, { runner: true, method: 'PUT', body: { value: 'late result' } }));
    await entered;
    await state.saveJob({ ...await state.job('job-test'), ...update });
    release();
    const response = await writing;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, update.status ? 'cancelled' : 'runner_conflict');
    assert.deepEqual(await storage.list({ prefix: 'checkpoint:' }), before, 'the last good checkpoint must remain intact');
  }
});

test('reconcile cannot replace a completion received while GitHub status is pending', async () => {
  const { state } = await fixture();
  await state.saveJob(job({ runId: '42', status: 'running', updatedAt: new Date(Date.now() - 180000).toISOString() }));
  let resolveRuns, queried;
  const started = new Promise(resolve => { queried = resolve; });
  await withFetch(() => { queried(); return new Promise(resolve => { resolveRuns = resolve; }); }, async () => {
    const reconciliation = state.reconcile(); await started;
    const result = { outputs: [{ kind: 'practice', published: { url: 'https://example.test/lesson.html' } }] };
    const completion = await state.fetch(request('/api/studio/runner/jobs/job-test', { runner: true, method: 'PATCH', body: { status: 'completed', result } }));
    assert.equal(completion.status, 200);
    resolveRuns(Response.json({ workflow_runs: [{ id: 42, display_title: 'monthly-job-test', status: 'completed', conclusion: 'success' }] }));
    await reconciliation;
    assert.equal((await state.job('job-test')).status, 'completed');
    assert.deepEqual((await state.job('job-test')).result, result);
  });
});

test('reconcile follows the claimed runner when a rejected duplicate finishes first', async () => {
  const { state } = await fixture();
  await state.saveJob(job({ runId: '42', status: 'running', updatedAt: new Date(Date.now() - 180000).toISOString() }));
  await withFetch(() => Response.json({ workflow_runs: [
    { id: 43, display_title: 'monthly-job-test', status: 'completed', conclusion: 'failure' },
    { id: 42, display_title: 'monthly-job-test', status: 'in_progress' },
  ] }), async () => {
    await state.reconcile();
    assert.equal((await state.job('job-test')).runId, '42');
    assert.equal((await state.job('job-test')).status, 'running');
  });
});

test('auto job creation dispatches a future verified model instead of a fixed fallback', async () => {
  const { state, storage, cookie } = await fixture();
  await storage.put('catalog-v2', { ...CATALOG, defaultModel: 'gpt-7-nova', models: [{ id: 'gpt-7-nova', label: 'Future official flagship', maxOutputTokens: 192000 }] });
  const mock = cloud();
  await withFetch(mock.fetch, async () => {
    const response = await state.fetch(request('/api/studio/jobs', { cookie, method: 'POST', body: { fileId: SOURCE.id, model: 'auto' } }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).job.model, 'gpt-7-nova');
    assert.equal(mock.calls.filter(call => call.url.pathname.endsWith('/dispatches')).length, 1);
  });
});

test('new jobs copy the selected verified output capacity and ignore browser-supplied limits', async () => {
  const { state, cookie } = await fixture();
  const mock = cloud();
  await withFetch(mock.fetch, async () => {
    const response = await state.fetch(request('/api/studio/jobs', { cookie, method: 'POST', body: { fileId: SOURCE.id, model: 'gpt-5.6-sol', modelMaxOutputTokens: 999999 } }));
    assert.equal(response.status, 200);
    const created = (await response.json()).job;
    const saved = await state.job(created.id);
    assert.equal(saved.model, 'gpt-5.6-sol');
    assert.equal(saved.modelMaxOutputTokens, 64000);
    const runner = await state.fetch(request('/api/studio/runner/jobs/' + created.id, { runner: true }));
    assert.equal((await runner.json()).job.modelMaxOutputTokens, 64000);
  });
});

test('legacy runner jobs acquire only their own verified model capacity without switching models', async () => {
  for (const model of ['gpt-5.6-sol', 'gpt-unknown']) {
    const { state } = await fixture();
    await state.saveJob(job({ model, runId: '42' }));
    await withFetch(() => { throw new Error('Current capability cache should avoid provider calls'); }, async () => {
      const response = await state.fetch(request('/api/studio/runner/jobs/job-test', { runner: true }));
      assert.equal(response.status, 200);
      const current = (await response.json()).job;
      assert.equal(current.model, model);
      assert.equal(current.modelMaxOutputTokens, model === 'gpt-5.6-sol' ? 64000 : undefined);
    });
  }
});

test('legacy catalog entries refresh capacity even while their old timestamp is still fresh', async () => {
  const { state, storage } = await fixture();
  await storage.put('catalog-v2', { ...CATALOG, models: CATALOG.models.map(({ id, label }) => ({ id, label })) });
  const calls = [];
  await withFetch(async input => {
    const url = String(input); calls.push(url);
    if (url === 'https://api.openai.com/v1/models') return Response.json({ data: [{ id: 'gpt-6-astra' }] });
    if (url.endsWith('/models.md')) return new Response('Use [GPT Astra](/api/docs/models/gpt-6-astra), our flagship model for reasoning.');
    assert(url.endsWith('/gpt-6-astra.md'));
    return new Response('Model ID: `gpt-6-astra`\n- Input modalities: text, image\n- Output modalities: text\n- 128,000 max output tokens\n- structured_outputs\n| Responses | `v1/responses` | Supported |\n');
  }, async () => {
    const value = await state.catalog();
    assert.equal(value.models[0].maxOutputTokens, 128000);
    assert.equal(value.latestVerified, true);
    assert.equal((await storage.get('catalog-v2')).models[0].maxOutputTokens, 128000);
    assert.equal(calls.length, 3);
    await state.catalog();
    assert.equal(calls.length, 3, 'capacity-aware cache should be reused normally');
  });
});

test('legacy capacity lookup cannot overwrite or hide a concurrent cancellation', async () => {
  const { state } = await fixture();
  await state.saveJob(job({ runId: '42' }));
  let requested, finish;
  const started = new Promise(resolve => { requested = resolve; });
  state.catalog = () => { requested(); return new Promise(resolve => { finish = resolve; }); };
  const response = state.fetch(request('/api/studio/runner/jobs/job-test', { runner: true }));
  await started;
  await state.saveJob({ ...await state.job('job-test'), status: 'cancelled' });
  finish(CATALOG);
  const current = (await (await response).json()).job;
  assert.equal(current.status, 'cancelled');
  assert.equal(current.modelMaxOutputTokens, 128000);
  assert.equal((await state.job('job-test')).status, 'cancelled');
});

const ago = milliseconds => new Date(Date.now() - milliseconds).toISOString();
function alarmGithub(state, { runs = [{ id: 42, display_title: 'monthly-job-test', status: 'completed', conclusion: 'failure' }], exact, failFirstList = false } = {}) {
  const calls = [];
  let lists = 0;
  state.github = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path.endsWith('/dispatches')) { assert.equal(method, 'POST'); return {}; }
    if (path.endsWith('/cancel')) return {};
    if (path.includes('/runs?')) {
      if (failFirstList && ++lists === 1) throw new Error('Fake temporary GitHub outage');
      return { workflow_runs: runs };
    }
    if (/^actions\/runs\/\d+$/.test(path)) {
      const value = exact || runs.find(run => String(run.id) === path.split('/').at(-1));
      if (!value) throw new Error('Fake run not found');
      return value;
    }
    throw new Error('Unexpected mocked alarm request: ' + path);
  };
  return calls;
}
const dispatchCalls = calls => calls.filter(call => call.path.endsWith('/dispatches'));
async function fireAlarm(state, storage) {
  storage.alarmAt = null; // Durable storage clears a fired alarm before invoking its handler.
  await state.alarm();
}

test('durable recovery schedules active work without postponing an existing earlier alarm', async () => {
  const { state, storage } = await fixture();
  const start = Date.now();
  storage.alarmAt = start + 3600000;
  await state.saveJob(job());
  const initial = storage.alarmAt;
  assert(initial >= start + 300000 && initial <= Date.now() + 300000);
  await state.saveJob(job({ progress: 50 }));
  assert.equal(storage.alarmAt, initial);
  assert.equal(storage.alarmWrites.length, 1);
});

test('durable recovery never dispatches while the previous workflow remains live', async () => {
  for (const status of ['queued', 'in_progress']) {
    const { state, storage } = await fixture();
    await state.saveJob(job({ runId: '42', status: 'failed', retryable: true, autoAttempts: 1, updatedAt: ago(180000) }));
    const calls = alarmGithub(state, { runs: [{ id: 42, display_title: 'monthly-job-test', status }] });
    await fireAlarm(state, storage);
    assert.equal(dispatchCalls(calls).length, 0);
    assert.equal((await state.job('job-test')).autoAttempts, 1);
    assert.equal((await state.job('job-test')).runId, '42');
    assert(storage.alarmAt > Date.now(), 'live prior workflow must be checked again without an open browser');
  }
});

test('durable recovery waits after a reported failure, then dispatches one completed-run retry', async () => {
  const { state, storage } = await fixture();
  await state.saveJob(job({ runId: '42', status: 'failed', retryable: true, updatedAt: ago(10000) }));
  const calls = alarmGithub(state);
  await fireAlarm(state, storage);
  assert.equal(calls.length, 0, 'a freshly reported failure must allow its prior workflow to exit');
  await state.saveJob({ ...await state.job('job-test'), updatedAt: ago(65000) });
  await fireAlarm(state, storage);
  assert.equal(dispatchCalls(calls).length, 1);
  assert.equal(dispatchCalls(calls)[0].body.inputs.job_id, 'job-test');
  const restarted = await state.job('job-test');
  assert.equal(restarted.status, 'queued');
  assert.equal(restarted.runId, null);
  assert.equal(restarted.retryable, false);
  assert.equal(restarted.autoAttempts, 1);
  await fireAlarm(state, storage);
  assert.equal(dispatchCalls(calls).length, 1, 'another alarm must not dispatch a duplicate retry');
  assert(storage.alarmAt > Date.now());
});

test('durable recovery verifies a claimed run omitted from the recent workflow list', async () => {
  const { state, storage } = await fixture();
  await state.saveJob(job({ runId: '42', status: 'failed', retryable: true, updatedAt: ago(180000) }));
  const calls = alarmGithub(state, { runs: [], exact: { id: 42, display_title: 'monthly-job-test', status: 'in_progress' } });
  await fireAlarm(state, storage);
  assert.equal(dispatchCalls(calls).length, 0, 'absence from a paginated list is not proof that the claimed run finished');
  assert.equal((await state.job('job-test')).runId, '42');
  assert(storage.alarmAt > Date.now());
});

test('durable recovery caps transient retries at three and stops scheduling exhausted work', async () => {
  const { state, storage } = await fixture();
  const calls = alarmGithub(state);
  await state.saveJob(job({ runId: '42', status: 'failed', retryable: true, autoAttempts: 0, updatedAt: ago(180000) }));
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await state.saveJob({ ...await state.job('job-test'), runId: '42', status: 'failed', retryable: true, updatedAt: ago(180000) });
    await fireAlarm(state, storage);
    assert.equal((await state.job('job-test')).autoAttempts, attempt);
    assert.equal(dispatchCalls(calls).length, attempt);
  }
  await state.saveJob({ ...await state.job('job-test'), runId: '42', status: 'failed', retryable: true, updatedAt: ago(180000) });
  await fireAlarm(state, storage);
  assert.equal(dispatchCalls(calls).length, 3);
  assert.equal((await state.job('job-test')).retryable, false);
  assert.equal((await state.job('job-test')).autoAttempts, 3);
  assert.equal(storage.alarmAt, null);
});

test('a planned continuation preserves the transient retry budget, including an exhausted budget', async () => {
  for (const autoAttempts of [0, 2, 3]) {
    const { state, storage } = await fixture();
    await state.saveJob(job({ runId: '42', autoAttempts }));
    const response = await state.fetch(request('/api/studio/runner/jobs/job-test', { runner: true, method: 'PATCH', body: { status: 'failed', retryable: true, continuation: true, stage: 'continuation', message: '保存済みの段階から次の実行で続けます。' } }));
    assert.equal(response.status, 200);
    await state.saveJob({ ...await state.job('job-test'), updatedAt: ago(180000) });
    const calls = alarmGithub(state);
    await fireAlarm(state, storage);
    const restarted = await state.job('job-test');
    assert.equal(dispatchCalls(calls).length, 1);
    assert.equal(restarted.autoAttempts, autoAttempts);
    assert.equal(restarted.continuation, false);
    assert.equal(restarted.retryable, false);
    assert.equal(restarted.status, 'queued');
  }
});

test('cancelling retryable work prevents every later durable alarm from reviving it', async () => {
  const { state, storage, cookie } = await fixture();
  await state.saveJob(job({ runId: '42', status: 'failed', retryable: true, continuation: true, updatedAt: ago(180000) }));
  const calls = alarmGithub(state);
  assert.equal((await state.fetch(request('/api/studio/jobs/job-test/cancel', { cookie, method: 'POST', body: {} }))).status, 200);
  await fireAlarm(state, storage);
  await fireAlarm(state, storage);
  assert.equal((await state.job('job-test')).status, 'cancelled');
  assert.equal((await state.job('job-test')).retryable, false);
  assert.equal(dispatchCalls(calls).length, 0);
  assert.equal(storage.alarmAt, null);
});

test('an alarm isolates a temporary per-job provider failure and schedules unfinished recovery', async () => {
  const { state, storage } = await fixture();
  await state.saveJob(job({ id: 'job-first', runId: '41', status: 'failed', retryable: true, createdAt: '2026-09-02T00:00:00Z', updatedAt: ago(180000) }));
  await state.saveJob(job({ id: 'job-second', runId: '42', status: 'failed', retryable: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: ago(180000) }));
  const calls = alarmGithub(state, { failFirstList: true, runs: [
    { id: 41, display_title: 'monthly-job-first', status: 'completed', conclusion: 'failure' },
    { id: 42, display_title: 'monthly-job-second', status: 'completed', conclusion: 'failure' },
  ] });
  let failure;
  try { await fireAlarm(state, storage); } catch (error) { failure = error; }
  assert.equal(dispatchCalls(calls).length, 1, 'one failed provider read must not skip other recoverable jobs');
  assert.equal(dispatchCalls(calls)[0].body.inputs.job_id, 'job-second');
  assert.equal((await state.job('job-first')).retryable, true);
  assert(storage.alarmAt > Date.now(), 'the failed job must remain scheduled for a later recovery check');
  assert.equal(failure, undefined, 'provider failures should be isolated per job');
});

// A deliberately small DOM harness executes the real generated browser script.
// It covers API contracts and async state, including production-bundled code.
class Element {
  constructor(tagName = 'div') { this.tagName = tagName; this.children = []; this.dataset = {}; this.style = {}; this.listeners = {}; this.value = ''; this.hidden = false; this.disabled = false; this.classes = new Set(); }
  get classList() { return { toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name), remove: name => this.classes.delete(name) }; }
  get childNodes() { return this.children; }
  get options() { return this.children; }
  get textContent() { return (this.content || '') + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.content = String(value); this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.content = ''; this.children = children; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute(name, value) { this[name] = value; }
  focus() {}
  scrollIntoView() {}
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
}
async function uiFixture({ jobs = [], files = [SOURCE], models = CATALOG, responder, script = studioScript() } = {}) {
  const elements = new Map([...studioPage().matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const calls = [];
  const document = { hidden: false, activeElement: null, getElementById: id => { assert(elements.has(id), 'Missing UI element: ' + id); return elements.get(id); },
    createElement: tag => new Element(tag), querySelectorAll: () => [...elements.values()].flatMap(element => [element, ...element.descendants()]), addEventListener() {} };
  const defaults = { '/session': { authenticated: true, configured: true, csrf: CSRF, email: ENV.STUDIO_OWNER_EMAIL }, '/sources': { files }, '/models': models, '/jobs': { jobs }, '/logout': { ok: true } };
  runInNewContext(script, { document, URL, URLSearchParams, AbortController, Intl, Date, Set, console,
    location: { origin: ENV.STUDIO_ORIGIN, pathname: '/studio', search: '', hash: '' }, history: { replaceState() {} }, matchMedia: () => ({ matches: true }),
    setTimeout: () => 1, clearTimeout() {}, fetch: async (url, options) => {
      const path = url.replace('/api/studio', ''); calls.push({ path, options });
      return await responder?.(path, options) || Response.json(defaults[path] || { job: jobs.find(job => path === '/jobs/' + job.id) });
    },
  });
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
  await flush();
  return { elements, calls, flush, click: async id => { await elements.get(id).listeners.click?.(); await flush(); } };
}

test('studio renders real pipeline outputs, partial errors, warnings and safe links', async () => {
  const error = '公開ページの反映をまだ確認できません。';
  const { elements } = await uiFixture({ jobs: [job({ status: 'needs_attention', result: {
    outputs: [{ kind: 'practice', pdf: { name: '日日の演習.pdf', url: 'https://drive.google.com/file/d/pdf/view' }, html: { name: '講義.html', url: 'https://drive.google.com/file/d/html/view' }, published: { url: 'https://example.test/lesson.html' } },
      { kind: 'advanced', pdf: { name: '発展演習.pdf', url: 'javascript:alert(1)' }, error: { message: error }, missing: ['学力コンテストの掲載なし'] }],
    warnings: ['practice: 対象コーナーの掲載なし'], errors: [{ kind: 'advanced', message: error }],
  } })] });
  const history = elements.get('jobs'), links = history.descendants().filter(element => element.tagName === 'a');
  assert.deepEqual(links.map(link => link.href), ['https://example.test/lesson.html', 'https://drive.google.com/file/d/pdf/view', 'https://drive.google.com/file/d/html/view']);
  assert(links.every(link => link.rel === 'noopener noreferrer'));
  assert.equal(history.textContent.split(error).length - 1, 1, 'the same per-output error must not appear twice');
  assert.match(history.textContent, /日日の演習： 対象コーナーの掲載なし/);
  assert.match(history.textContent, /学力コンテストの掲載なし/);
  assert.match(history.textContent, /もう一度試す/);
});

test('studio shows Japanese progress and prevents concurrent issue selection', async () => {
  const ui = await uiFixture({ files: [SOURCE, { ...SOURCE, id: 'other', name: '2026年8月号.pdf' }], jobs: [job({ stage: 'lesson_generation' })] });
  assert.match(ui.elements.get('jobs').textContent, /全問題の講義と検算を進めています/);
  assert(ui.elements.get('sources').children.every(button => button.disabled));
  assert.match(ui.elements.get('sources').textContent, /別の号を作成中です/);
  const cancelled = await uiFixture({ jobs: [job({ status: 'cancelled' })] });
  assert(!cancelled.elements.get('jobs').textContent.includes('再試行する'));
  assert.match(cancelled.elements.get('jobs').textContent, /作成を取り消しました/);
});

test('studio permits explicit fallback selection but never silently marks it as latest', async () => {
  const ui = await uiFixture({ models: { ...CATALOG, latestVerified: false, defaultModel: null } });
  assert(ui.elements.get('sources').children[0].disabled);
  assert.equal(ui.elements.get('model-settings').open, true);
  await ui.elements.get('model').listeners.change({ target: { value: 'gpt-5.6-sol' } });
  assert.equal(ui.elements.get('sources').children[0].disabled, false);
  assert.match(ui.elements.get('model').children[0].textContent, /確認できていません/);
});

test('studio logout uses CSRF and removes private screen data; Drive expiry gives a reconnect link', async () => {
  const ui = await uiFixture({ jobs: [job({ status: 'completed' })] });
  assert.equal(ui.elements.get('logout').hidden, false);
  await ui.click('logout');
  const sent = ui.calls.find(call => call.path === '/logout');
  assert.equal(sent.options.method, 'POST');
  assert.equal(sent.options.headers['x-studio-csrf'], CSRF);
  assert.equal(ui.elements.get('workspace').hidden, true);
  assert.equal(ui.elements.get('account').textContent, '');
  assert.equal(ui.elements.get('jobs').children.length, 0);
  assert.equal(ui.elements.get('login').hidden, false);
  const disconnected = await uiFixture({ responder: path => path === '/sources' ? Response.json({ error: 'drive_reconnect' }, { status: 401 }) : null });
  assert.equal(disconnected.elements.get('workspace').hidden, true);
  assert.equal(disconnected.elements.get('login').hidden, false);
  assert.match(disconnected.elements.get('gate-copy').textContent, /Google Drive/);
});

test('production bundling with preserved names keeps browser code self-contained', async () => {
  const { build } = await import('esbuild');
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/studio-ui.js', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', keepNames: true, minify: true });
  const bundled = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const ui = await uiFixture({ script: bundled.studioScript() });
  assert.equal(ui.elements.get('connection-label').textContent, 'Google 接続済み');
  assert.equal(ui.elements.get('workspace').hidden, false);
  assert.equal(ui.elements.get('sources').children[0].disabled, false);
});
