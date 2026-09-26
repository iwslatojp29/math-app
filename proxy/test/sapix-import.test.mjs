import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { StudioState, seal, unseal } from '../src/studio.js';
import { SAPIX_IMPORT_FOLDER, SAPIX_IMPORT_SINCE, validSapixCatalog } from '../src/sapix-import.js';
import { sapixImportPage } from '../src/sapix-import-ui.js';

// Fictional values only. These tests never read environment secrets or use a provider.
const ENV = { STUDIO_OWNER_EMAIL: 'owner@example.test', STUDIO_ORIGIN: 'https://studio.example.test', STUDIO_SECRET: 'fake-studio-secret', STUDIO_RUNNER_TOKEN: 'fake-runner-token', GOOGLE_CLIENT_ID: 'fake-client', GOOGLE_CLIENT_SECRET: 'fake-google-secret', GITHUB_TOKEN: 'fake-github', OPENAI_API_KEY: 'fake-openai', ANTHROPIC_API_KEY: 'fake-anthropic', REPO: 'example/math-app', BRANCH: 'main' };
const API = '/studio/api/sapix-import', RUNNER = '/studio/runner/sapix-import/jobs/';
const ID = '00000000-0000-4000-8000-000000000001', CSRF = 'fake-csrf';
const SOURCE = { id: 'source-one', name: '算数.pdf', mimeType: 'application/pdf', size: '200', md5Checksum: 'a'.repeat(32), createdTime: SAPIX_IMPORT_SINCE, modifiedTime: '2026-09-24T01:00:00Z', parents: [SAPIX_IMPORT_FOLDER], unitPath: '' };
const MODEL = { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' };
const EMPTY = () => ({ schemaVersion: 1, sources: [], problems: [] });
const clone = value => value === undefined ? undefined : structuredClone(value);
const encode = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
const sha = value => createHash('sha256').update(value).digest('hex');
const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
class Storage {
  values = new Map(); alarmAt = null;
  async getAlarm() { return this.alarmAt; }
  async setAlarm(value) { this.alarmAt = value; }
  async get(key) { return Array.isArray(key) ? new Map(key.filter(k => this.values.has(k)).map(k => [k, clone(this.values.get(k))])) : clone(this.values.get(key)); }
  async put(key, value) { if (typeof key === 'object') { for (const [k, v] of Object.entries(key)) await this.put(k, v); } else { assert(Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024, 'Durable Object single-value limit'); this.values.set(key, clone(value)); } }
  async delete(key) { for (const item of Array.isArray(key) ? key : [key]) this.values.delete(item); }
  async list({ prefix = '' } = {}) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, clone(value)])); }
  async transaction(action) { const before = clone(this.values); try { return await action(this); } catch (error) { this.values = before; throw error; } }
}
async function fixture() {
  const storage = new Storage(), state = new StudioState({ storage }, { ...ENV }), service = state.sapixImport;
  state.access = { accessToken: 'fake-drive-access', expires: Date.now() + 3600000 };
  state.drive = async () => ({ files: [clone(SOURCE)] });
  const githubCalls = [];
  state.github = async (path, method = 'GET', body) => { githubCalls.push({ path, method, body }); if (path.startsWith('contents/')) return { content: encode(EMPTY()) }; if (path.endsWith('/dispatches')) return {}; if (path.includes('/runs?')) return { workflow_runs: [] }; if (/^actions\/runs\/\d+$/.test(path)) return { status: 'completed' }; if (path.endsWith('/cancel')) return {}; throw new Error('Unexpected GitHub request: ' + path); };
  await storage.put('sapix-import:model', { model: MODEL, checkedAt: Date.now() });
  const cookie = await seal({ email: ENV.STUDIO_OWNER_EMAIL, csrf: CSRF, expires: Date.now() + 3600000 }, ENV.STUDIO_SECRET, 'session');
  return { state, service, storage, cookie, githubCalls };
}
function request(path, { method = 'GET', body, cookie, csrf = CSRF, origin = ENV.STUDIO_ORIGIN, runner = false, runId = '42', headers = {} } = {}) {
  const h = new Headers(headers); if (cookie) h.set('Cookie', '__Host-studio=' + cookie); if (origin !== null) h.set('Origin', origin); if (csrf !== null) h.set('x-studio-csrf', csrf);
  if (runner) { h.set('Authorization', 'Bearer ' + ENV.STUDIO_RUNNER_TOKEN); if (runId !== null) h.set('X-Studio-Run-Id', runId); }
  if (body !== undefined) h.set('Content-Type', 'application/json');
  return new Request(ENV.STUDIO_ORIGIN + path, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function seedJob(f, overrides = {}) {
  const source = { ...clone(SOURCE), fingerprint: await f.service.fingerprint(SOURCE) };
  const job = { id: ID, files: [source], folderId: SAPIX_IMPORT_FOLDER, cutoff: SAPIX_IMPORT_SINCE, model: MODEL, status: 'running', stage: 'preparing', progress: 1, createdAt: ago(10), updatedAt: ago(5), dispatchedAt: ago(10), runId: '42', autoAttempts: 0, assets: {}, ...overrides };
  await f.storage.put('sapix-import:job:' + job.id, job); return job;
}
function addition(job, path = 'assets/drive/source-one/' + 'a'.repeat(64) + '.png') {
  const file = job.files[0], id = 'drive-' + file.id + '-q1';
  return { schemaVersion: 1, sources: [{ fileId: file.id, name: file.name, modifiedTime: file.modifiedTime, fingerprint: file.fingerprint, problemIds: [id] }], problems: [{ id, unit: '数と計算', title: '計算', src: file.name, stars: 1, tests: [], question: '1 + 1 はいくつですか。', subquestions: [], answers: [{ label: '', text: '2' }], steps: [{ title: '数える', text: '1 に 1 を加えると 2 です。' }], sourceImages: [path] }] };
}
async function responseJSON(state, req, status = 200) { const response = await state.fetch(req); const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body; }
async function mockedFetch(mock, action) { const previous = globalThis.fetch; globalThis.fetch = mock; try { return await action(); } finally { globalThis.fetch = previous; } }

test('SAPIX candidates/jobs require Studio owner, mutations require CSRF, grading cookies cannot authorize, runner has separate bearer', async () => {
  const f = await fixture(); await seedJob(f);
  for (const path of [API + '/candidates', API + '/jobs', API + '/jobs/' + ID]) await responseJSON(f.state, request(path), 401);
  const other = await seal({ email: 'grading@example.test', csrf: CSRF, expires: Date.now() + 60000 }, ENV.STUDIO_SECRET, 'session');
  await responseJSON(f.state, request(API + '/jobs', { cookie: other }), 401);
  await responseJSON(f.state, request(API + '/jobs', { headers: { Cookie: '__Host-sapix=' + f.cookie } }), 401);
  for (const override of [{ csrf: null }, { csrf: 'wrong' }, { origin: null }, { origin: 'https://evil.example' }]) await responseJSON(f.state, request(API + '/jobs/' + ID + '/cancel', { cookie: f.cookie, method: 'POST', body: {}, ...override }), 403);
  await responseJSON(f.state, request(RUNNER + ID + '/config', { cookie: f.cookie }), 401);
  assert.equal((await responseJSON(f.state, request(API + '/jobs', { cookie: f.cookie }))).jobs.length, 1);
  assert.equal((await f.state.jobs()).length, 0, 'monthly job namespace remains isolated');
});

test('OAuth import return is sealed and allowlisted without touching grading OAuth', async () => {
  const f = await fixture();
  const start = await f.state.fetch(request('/api/studio/google/start?return=sapix-import'));
  const oauth = await unseal(start.headers.get('Set-Cookie').split(';')[0].split('=')[1], ENV.STUDIO_SECRET, 'oauth');
  assert.equal(oauth.returnTo, '/studio/sapix-import'); assert.equal(oauth.sapix, undefined);
  assert.match(new URL(start.headers.get('Location')).searchParams.get('scope'), /auth\/drive/);
  const other = await f.state.fetch(request('/api/studio/google/start?return=https://evil.example'));
  assert.equal((await unseal(other.headers.get('Set-Cookie').split(';')[0].split('=')[1], ENV.STUDIO_SECRET, 'oauth')).returnTo, undefined);
});

test('scan traverses every folder/page, uses inclusive JST creation cutoff and excludes published file IDs even if modified', async () => {
  const f = await fixture(), visits = [], old = { ...SOURCE, id: 'old', createdTime: '2026-09-23T14:59:59Z', modifiedTime: '2026-09-26T00:00:00Z' };
  const existingJob = await seedJob(f), existing = addition(existingJob);
  f.state.github = async () => ({ content: encode(existing) });
  f.state.drive = async (path, params) => {
    const parent = params.q.match(/^'([^']+)'/)[1]; visits.push([parent, params.pageToken || '']); assert.equal(params.supportsAllDrives, 'true');
    if (parent === SAPIX_IMPORT_FOLDER && !params.pageToken) return { files: [SOURCE, old, { id: 'unit-a', name: '図形', mimeType: 'application/vnd.google-apps.folder', createdTime: '2020-01-01T00:00:00Z' }], nextPageToken: 'next' };
    if (parent === SAPIX_IMPORT_FOLDER) return { files: [{ ...SOURCE, id: 'root-image', mimeType: 'image/png' }, { ...SOURCE, id: 'unsupported', mimeType: 'text/plain' }] };
    return { files: [{ ...SOURCE, id: 'nested', name: '図.png', mimeType: 'image/png', parents: ['unit-a'] }] };
  };
  const scan = await responseJSON(f.state, request(API + '/candidates', { cookie: f.cookie }));
  assert.deepEqual(scan.files.map(file => file.id).sort(), ['nested', 'root-image']); assert.equal(scan.files.find(file => file.id === 'nested').unitPath, '図形');
  assert.deepEqual(visits, [[SAPIX_IMPORT_FOLDER, ''], [SAPIX_IMPORT_FOLDER, 'next'], ['unit-a', '']]);
  assert.equal(scan.model.id, MODEL.id); assert(!JSON.stringify(scan).includes('fingerprint')); assert.equal(scan.files.find(file => file.id === 'root-image').createdTime, SAPIX_IMPORT_SINCE);
});

test('large candidate snapshots are split below Durable Object value limits and reassembled when selecting', async () => {
  const f = await fixture(); const files = Array.from({ length: 600 }, (_, index) => ({ ...SOURCE, id: 'file-' + index, name: 'あ'.repeat(150) + index + '.pdf' }));
  f.state.drive = async () => ({ files }); const scan = await f.service.scan();
  assert.equal(scan.files.length, 600); assert((await f.storage.list({ prefix: 'sapix-import:scan-data:' })).size > 10);
  const result = await responseJSON(f.state, request(API + '/jobs', { cookie: f.cookie, method: 'POST', body: { scanId: scan.scanId, fileIds: ['file-599'] } }));
  assert.equal(result.job.files[0].id, 'file-599');
});

test('catalog above Contents API inline limit is read from its immutable Git blob', async () => {
  const f = await fixture(), calls = [], blobSha = 'b'.repeat(40);
  f.state.github = async path => { calls.push(path); return path.startsWith('contents/') ? { sha: blobSha, encoding: 'none', content: '', size: 2000000 } : { content: encode(EMPTY()) }; };
  assert.deepEqual(await f.service.catalog(), EMPTY()); assert.equal(calls[1], 'git/blobs/' + blobSha);
});

test('Fable discovery follows model pagination, verifies newest model and fails closed rather than using another family', async () => {
  const f = await fixture(); await f.storage.delete('sapix-import:model'); const calls = [];
  await mockedFetch(async (input, options) => { const url = new URL(input); calls.push(url.href); assert.equal(options.headers['x-api-key'], ENV.ANTHROPIC_API_KEY); assert.equal(url.pathname, '/v1/models');
    return Response.json(url.searchParams.has('after_id') ? { data: [{ id: 'claude-fable-9-2', display_name: 'Future Fable', created_at: '2028-05-01T00:00:00Z' }, { id: 'claude-other-99', created_at: '2029-01-01T00:00:00Z' }], has_more: false } : { data: [{ id: MODEL.id, display_name: MODEL.name, created_at: '2026-08-28T00:00:00Z' }], has_more: true, last_id: MODEL.id });
  }, async () => { assert.equal((await f.service.model()).id, 'claude-fable-9-2'); assert.equal((await f.service.model()).id, 'claude-fable-9-2'); });
  assert.equal(calls.length, 2);
  await f.storage.delete('sapix-import:model');
  await mockedFetch(async () => Response.json({ data: [{ id: 'claude-other-7', created_at: '2027-01-01T00:00:00Z' }], has_more: false }), async () => { await assert.rejects(f.service.model(), error => error.code === 'sapix_import_model'); });
});

test('model diagnostics distinguish configuration, HTTP, network, parsing, selection and storage without exposing provider secrets', async () => {
  const payload = 'sk-ant-sensitive-fake-api-key provider response body';
  const cases = [
    { diagnostic: 'models_config_missing', setup: f => { delete f.state.env.ANTHROPIC_API_KEY; } },
    { diagnostic: 'models_http_403', fetch: async () => new Response(payload, { status: 403 }) },
    { diagnostic: 'models_network_typeerror', fetch: async () => { throw new TypeError(payload); } },
    { diagnostic: 'models_network_timeout', fetch: async () => { throw new DOMException(payload, 'TimeoutError'); } },
    { diagnostic: 'models_invalid_json', fetch: async () => new Response(payload, { status: 200 }) },
    { diagnostic: 'models_invalid_response', fetch: async () => Response.json({ error: payload }) },
    { diagnostic: 'models_fable_unavailable', fetch: async () => Response.json({ data: [{ id: 'claude-other-5', created_at: '2026-08-01T00:00:00Z' }], has_more: false }) },
    { diagnostic: 'models_cache_write_failed', setup: f => { const put = f.storage.put.bind(f.storage); f.storage.put = async (key, value) => { if (key === 'sapix-import:model') throw new Error(payload); return put(key, value); }; }, fetch: async () => Response.json({ data: [{ id: MODEL.id, display_name: MODEL.name, created_at: '2026-08-28T00:00:00Z' }], has_more: false }) },
  ];
  for (const entry of cases) {
    const f = await fixture(); await f.storage.delete('sapix-import:model'); entry.setup?.(f);
    await mockedFetch(entry.fetch || (() => { throw new Error('Provider must not be called'); }), async () => {
      const result = await responseJSON(f.state, request(API + '/candidates', { cookie: f.cookie }), 503);
      assert.equal(result.error, 'sapix_import_model'); assert.equal(result.diagnostic, entry.diagnostic);
      assert(!JSON.stringify(result).includes(payload)); assert(!JSON.stringify(result).includes(ENV.ANTHROPIC_API_KEY));
    });
  }
});

test('confirmation pins selected revisions/model, concurrent double submit dispatches once, unselected IDs and 11-file batches fail', async () => {
  const f = await fixture(), scan = await f.service.scan(); await f.storage.put('sapix-import:model', { model: { id: 'claude-fable-6', name: 'Later' }, checkedAt: Date.now() });
  const body = { scanId: scan.scanId, fileIds: [SOURCE.id] };
  const results = await Promise.all([1, 2, 3].map(() => responseJSON(f.state, request(API + '/jobs', { cookie: f.cookie, method: 'POST', body }))));
  assert.equal(new Set(results.map(value => value.job.id)).size, 1); assert.equal(results[0].job.model.id, MODEL.id); assert.equal(f.githubCalls.filter(call => call.path.endsWith('/dispatches')).length, 1);
  assert.equal(results[0].job.assets, undefined); assert.equal(results[0].job.runId, undefined);
  for (const fileIds of [['outside'], Array.from({ length: 11 }, (_, index) => 'file-' + index), [SOURCE.id, SOURCE.id]]) await responseJSON(f.state, request(API + '/jobs', { cookie: f.cookie, method: 'POST', body: { scanId: scan.scanId, fileIds } }), 400);
});

test('a selected source changed, renamed, moved or no longer within the fixed tree is rejected before dispatch', async () => {
  for (const change of [{ md5Checksum: 'b'.repeat(32) }, { name: 'renamed.pdf' }, { createdTime: '2026-09-25T00:00:00Z' }, { parents: ['elsewhere'] }, null]) {
    const f = await fixture(), scan = await f.service.scan(); f.state.drive = async () => ({ files: change ? [{ ...SOURCE, ...change }] : [] });
    const body = await responseJSON(f.state, request(API + '/jobs', { cookie: f.cookie, method: 'POST', body: { scanId: scan.scanId, fileIds: [SOURCE.id] } }), 409);
    assert.equal(body.error, 'sapix_import_source_changed'); assert.equal(f.githubCalls.filter(call => call.path.endsWith('/dispatches')).length, 0);
  }
});

test('expired scans cannot incur dispatch, failed dispatch persists uncertainty for browser-closed recovery', async () => {
  const f = await fixture(), scan = await f.service.scan(), snapshot = await f.storage.get('sapix-import:scan:' + scan.scanId); snapshot.expires = Date.now() - 1; await f.storage.put('sapix-import:scan:' + scan.scanId, snapshot);
  assert.equal((await responseJSON(f.state, request(API + '/jobs', { cookie: f.cookie, method: 'POST', body: { scanId: scan.scanId, fileIds: [SOURCE.id] } }), 409)).error, 'sapix_import_scan_expired');
  snapshot.expires = Date.now() + 60000; await f.storage.put('sapix-import:scan:' + scan.scanId, snapshot); const github = f.state.github; f.state.github = (path, ...args) => path.endsWith('/dispatches') ? Promise.reject(new Error('fake timeout')) : github(path, ...args);
  const result = await responseJSON(f.state, request(API + '/jobs', { cookie: f.cookie, method: 'POST', body: { scanId: scan.scanId, fileIds: [SOURCE.id] } }));
  assert.equal(result.job.status, 'needs_attention'); assert.equal(result.job.recovering, true); assert(f.storage.alarmAt > Date.now());
});

test('runner must claim matching run before config; pinned credentials are no-store and absent from browser responses', async () => {
  const f = await fixture(); await seedJob(f, { runId: null, status: 'queued' });
  await responseJSON(f.state, request(RUNNER + ID + '/config', { runner: true }), 409);
  await responseJSON(f.state, request(RUNNER + ID, { runner: true, method: 'POST', body: { status: 'running', runId: '43' } }), 409);
  await responseJSON(f.state, request(RUNNER + ID, { runner: true, method: 'POST', body: { status: 'running', runId: '42' } }));
  await responseJSON(f.state, request(RUNNER + ID + '/config', { runner: true, runId: '43' }), 409);
  const response = await f.state.fetch(request(RUNNER + ID + '/config', { runner: true })), config = await response.json();
  assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(config.driveAccessToken, 'fake-drive-access'); assert.equal(config.anthropicApiKey, ENV.ANTHROPIC_API_KEY); assert.deepEqual(config.model, MODEL); assert.equal(config.folderId, SAPIX_IMPORT_FOLDER); assert.deepEqual(config.existingSourceFileIds, []);
  const publicResponse = await responseJSON(f.state, request(API + '/jobs', { cookie: f.cookie })); assert(!JSON.stringify(publicResponse).includes(ENV.ANTHROPIC_API_KEY));
  await responseJSON(f.state, request(RUNNER + ID, { runner: true, method: 'POST', body: { status: 'failed', retryable: true, error: 'sk-ant-fake-secret Bearer fake-token ya29.fake-access github_pat_fake' } }));
  const failed = await f.service.job(ID); assert.equal(failed.error, '[非表示] [非表示] [非表示] [非表示]'); assert.equal(failed.retryable, true);
});

test('an uncertain dispatch or pending automatic retry blocks new generation until explicitly cancelled', async () => {
  for (const pending of [{ status: 'needs_attention', dispatchUncertain: true }, { status: 'failed', retryable: true }]) {
    const f = await fixture(), scan = await f.service.scan(); await seedJob(f, pending);
    await responseJSON(f.state, request(API + '/jobs', { cookie: f.cookie, method: 'POST', body: { scanId: scan.scanId, fileIds: [SOURCE.id] } }), 409);
    assert(!f.githubCalls.some(call => call.path.endsWith('/dispatches')));
    await responseJSON(f.state, request(API + '/jobs/' + ID + '/cancel', { cookie: f.cookie, method: 'POST', body: {} }));
    await responseJSON(f.state, request(API + '/jobs', { cookie: f.cookie, method: 'POST', body: { scanId: scan.scanId, fileIds: [SOURCE.id] } }));
    assert.equal(f.githubCalls.filter(call => call.path.endsWith('/dispatches')).length, 1);
  }
});

test('checkpoint chunk replacement is atomic and rechecks cancel/runner ownership inside storage transaction', async () => {
  const f = await fixture(); await seedJob(f); const path = RUNNER + ID + '/checkpoints/extracted-source', value = { text: 'あ'.repeat(130000) };
  await responseJSON(f.state, request(path, { runner: true, method: 'PUT', body: { value } })); assert.deepEqual((await responseJSON(f.state, request(path, { runner: true }))).value, value);
  const priorKeys = [...f.storage.values.keys()].filter(key => key.startsWith('sapix-import:checkpoint:'));
  await responseJSON(f.state, request(path, { runner: true, method: 'PUT', body: { value: { checked: true } } })); assert.equal(priorKeys.filter(key => f.storage.values.has(key)).length, 1, 'old chunks deleted, metadata retained');
  const original = f.storage.transaction.bind(f.storage); f.storage.transaction = async action => { const job = await f.service.job(ID); job.status = 'cancelled'; await f.storage.put('sapix-import:job:' + ID, job); return original(action); };
  await responseJSON(f.state, request(path, { runner: true, method: 'PUT', body: { value: 'stale-result' } }), 409);
  assert.equal((await f.service.job(ID)).status, 'cancelled');
  await responseJSON(f.state, request(RUNNER + ID + '/config', { runner: true }), 409);
});

function gitFixture(f, initial = EMPTY(), { refConflict = false, lostResponse = false } = {}) {
  let serial = 0, head = 'head0'; const commits = new Map([['head0', { tree: { sha: 'tree0' } }]]), trees = new Map(), blobs = new Map(), calls = [];
  blobs.set('catalog0', encode(initial)); trees.set('tree0', [{ path: 'sapix/problems/generated.json', sha: 'catalog0', type: 'blob' }, { path: 'math/existing.html', sha: 'untouched', type: 'blob' }]);
  f.state.github = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path === 'git/ref/heads/main') return { object: { sha: head } };
    if (method === 'GET' && path.startsWith('git/commits/')) return clone(commits.get(path.split('/').at(-1)));
    if (method === 'GET' && path.startsWith('git/trees/')) return { tree: clone(trees.get(path.split('/').at(-1).split('?')[0])), truncated: false };
    if (method === 'GET' && path.startsWith('git/blobs/')) return { content: blobs.get(path.split('/').at(-1)) };
    if (method === 'POST' && path === 'git/blobs') { const id = 'blob' + ++serial; blobs.set(id, body.content); return { sha: id }; }
    if (method === 'POST' && path === 'git/trees') { const id = 'tree' + ++serial, next = new Map(trees.get(body.base_tree).map(entry => [entry.path, entry])); for (const entry of body.tree) next.set(entry.path, entry); trees.set(id, [...next.values()]); return { sha: id }; }
    if (method === 'POST' && path === 'git/commits') { const id = 'commit' + ++serial; commits.set(id, { tree: { sha: body.tree } }); return { sha: id }; }
    if (method === 'PATCH' && path === 'git/refs/heads/main') { assert.equal(body.force, false); if (refConflict) { refConflict = false; return { httpStatus: 409 }; } head = body.sha; if (lostResponse) { lostResponse = false; throw new Error('fake lost successful response'); } return {}; }
    throw new Error('Unexpected Git request: ' + path);
  };
  return { calls, blobs, trees, current: () => ({ head, tree: trees.get(commits.get(head).tree.sha) }) };
}

test('asset staging accepts only selected source hashes and matching image signatures without publishing a branch', async () => {
  const f = await fixture(); await seedJob(f); const git = gitFixture(f), bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(1024 * 1024)]), path = 'assets/drive/source-one/' + sha(bytes) + '.png';
  await responseJSON(f.state, request(RUNNER + ID + '/assets', { runner: true, method: 'POST', body: { path, contentBase64: bytes.toString('base64') } }));
  assert.equal(git.calls.filter(call => call.method === 'POST').length, 1); assert.equal(git.current().head, 'head0');
  for (const body of [{ path: path.replace('source-one', 'outside'), contentBase64: bytes.toString('base64') }, { path: 'assets/drive/source-one/' + 'a'.repeat(64) + '.png', contentBase64: bytes.toString('base64') }, { path: '../index.html', contentBase64: 'AAAA' }, { path, contentBase64: '====' }, null]) await responseJSON(f.state, request(RUNNER + ID + '/assets', { runner: true, method: 'POST', body }), 400);
  assert.equal(git.calls.length, 1); assert.equal((await f.service.job(ID)).assets[path].size, bytes.length);
});

test('catalog publish merges additions and staged assets atomically with nonforce retries and preserves unrelated files', async () => {
  const f = await fixture(), job = await seedJob(f), catalog = addition(job), path = catalog.problems[0].sourceImages[0]; job.assets[path] = { sha: 'imageblob', size: 100 }; await f.storage.put('sapix-import:job:' + ID, job);
  const priorJob = { files: [{ ...job.files[0], id: 'prior' }] }, prior = addition(priorJob, 'assets/drive/prior/' + 'b'.repeat(64) + '.png'), git = gitFixture(f, prior, { refConflict: true });
  const result = await responseJSON(f.state, request(RUNNER + ID + '/publish', { runner: true, method: 'POST', body: { catalog } }));
  assert.equal(result.addedProblems, 1); assert.equal((await f.service.job(ID)).status, 'publishing');
  assert.equal(git.calls.filter(call => call.method === 'PATCH').length, 2);
  const tree = git.current().tree, catalogBlob = tree.find(entry => entry.path === 'sapix/problems/generated.json');
  const merged = JSON.parse(Buffer.from(git.blobs.get(catalogBlob.sha), 'base64').toString()); assert.equal(merged.sources.length, 2); assert.equal(merged.problems.length, 2); assert(tree.some(entry => entry.path === 'math/existing.html' && entry.sha === 'untouched')); assert(tree.some(entry => entry.path === 'sapix/' + path && entry.sha === 'imageblob'));
  for (const call of git.calls.filter(call => call.path === 'git/trees')) assert.deepEqual(call.body.tree.map(entry => entry.path).sort(), [ 'sapix/' + path, 'sapix/problems/generated.json' ].sort());
  const before = git.calls.length; assert.deepEqual(await responseJSON(f.state, request(RUNNER + ID + '/publish', { runner: true, method: 'POST', body: { catalog } })), result); assert.equal(git.calls.length, before, 'same-job result replay does not write or generate again');
});

test('publish rejects invalid schema, missing images, changed source and duplicate IDs without a branch write', async () => {
  for (const scenario of ['schema', 'assets', 'changed', 'duplicate']) {
    const f = await fixture(), job = await seedJob(f), catalog = addition(job), path = catalog.problems[0].sourceImages[0]; if (scenario !== 'assets') job.assets[path] = { sha: 'imageblob', size: 100 }; await f.storage.put('sapix-import:job:' + ID, job);
    const git = gitFixture(f, scenario === 'duplicate' ? catalog : EMPTY()); if (scenario === 'schema') catalog.problems[0].script = 'evil'; if (scenario === 'changed') f.state.drive = async () => ({ files: [] });
    const result = await responseJSON(f.state, request(RUNNER + ID + '/publish', { runner: true, method: 'POST', body: { catalog } }), ['schema', 'assets'].includes(scenario) ? 400 : 409);
    assert.match(result.error, /^sapix_import_/); assert.equal(git.calls.filter(call => call.method !== 'GET').length, 0);
  }
});

test('lost successful branch response is reconciled from same-job digest by empty publish without duplicate writes', async () => {
  const f = await fixture(), job = await seedJob(f), catalog = addition(job), path = catalog.problems[0].sourceImages[0]; job.assets[path] = { sha: 'imageblob', size: 100 }; await f.storage.put('sapix-import:job:' + ID, job); const git = gitFixture(f, EMPTY(), { lostResponse: true });
  await responseJSON(f.state, request(RUNNER + ID + '/publish', { runner: true, method: 'POST', body: { catalog } }), 500);
  assert.equal((await f.service.job(ID)).result, undefined); const writes = git.calls.filter(call => call.method !== 'GET').length;
  const result = await responseJSON(f.state, request(RUNNER + ID + '/publish', { runner: true, method: 'POST', body: { catalog: EMPTY() } }));
  assert.equal(result.addedProblems, 1); assert.equal((await f.service.job(ID)).status, 'publishing'); assert.equal(git.calls.filter(call => call.method !== 'GET').length, writes);
});

test('empty publish is allowed only when every selected revision is already in the published catalog', async () => {
  const f = await fixture(), job = await seedJob(f); gitFixture(f, EMPTY());
  await responseJSON(f.state, request(RUNNER + ID + '/publish', { runner: true, method: 'POST', body: { catalog: EMPTY() } }), 409);
  const git = gitFixture(f, addition(job)); const result = await responseJSON(f.state, request(RUNNER + ID + '/publish', { runner: true, method: 'POST', body: { catalog: EMPTY() } }));
  assert.equal(result.addedSources, 0); assert.equal(git.calls.filter(call => call.method !== 'GET').length, 0);
});

async function publishingFixture() {
  const f = await fixture(), job = await seedJob(f), catalog = addition(job), path = catalog.problems[0].sourceImages[0]; job.assets[path] = { sha: 'imageblob', size: 100 }; await f.storage.put('sapix-import:job:' + ID, job); const git = gitFixture(f);
  const result = await responseJSON(f.state, request(RUNNER + ID + '/publish', { runner: true, method: 'POST', body: { catalog } }));
  return { ...f, catalog, result, git };
}
async function allowPublicationCheck(f, overrides = {}) { const job = await f.service.job(ID); job.publicationCheckedAt = null; Object.assign(job, overrides); await f.storage.put('sapix-import:job:' + ID, job); }

test('completion waits for public catalog plus every original image, hides premature links, and does not let the runner bypass the check', async () => {
  const f = await publishingFixture(); assert.match(f.result.url, /\?v=commit/);
  let readyCatalog = false, readyImage = false; const publicCalls = [];
  await mockedFetch(async (input, options) => { const url = new URL(input); publicCalls.push({ url, options }); assert.equal(url.origin, 'https://example.github.io'); assert.equal(options.redirect, 'manual'); assert.equal(options.headers?.Authorization, undefined); return options.method === 'HEAD' ? new Response(null, { status: readyImage ? 200 : 404 }) : Response.json(readyCatalog ? f.catalog : EMPTY()); }, async () => {
    const first = await responseJSON(f.state, request(API + '/jobs', { cookie: f.cookie })); assert.equal(first.jobs[0].status, 'publishing'); assert.equal(first.jobs[0].result, null);
    await responseJSON(f.state, request(RUNNER + ID, { runner: true, method: 'POST', body: { status: 'completed' } }), 409);
    await responseJSON(f.state, request(API + '/jobs/' + ID + '/cancel', { cookie: f.cookie, method: 'POST', body: {} }), 409);
    readyCatalog = true; await allowPublicationCheck(f); await f.service.alarm(); assert.equal((await f.service.job(ID)).status, 'publishing');
    readyImage = true; await allowPublicationCheck(f); const done = await responseJSON(f.state, request(API + '/jobs/' + ID, { cookie: f.cookie })); assert.equal(done.job.status, 'completed'); assert.equal(done.job.result.url, f.result.url); assert.equal(done.job.progress, 100);
  });
  assert(publicCalls.some(call => call.options.method === 'HEAD')); assert(publicCalls.every(call => call.url.searchParams.get('v') === f.result.commitSha));
  assert.equal(f.git.calls.filter(call => call.path.includes('actions/')).length, 0, 'a committed publication never regenerates in Actions');
});

test('publication timeout remains retryable as a public check without dispatching or undoing the saved commit', async () => {
  const f = await publishingFixture(); await allowPublicationCheck(f, { publicationStartedAt: ago(21) });
  await mockedFetch(async () => new Response(null, { status: 404 }), async () => { await f.service.alarm(); });
  const timedOut = await f.service.job(ID); assert.equal(timedOut.status, 'needs_attention'); assert.equal(timedOut.stage, 'publishing'); assert.match(timedOut.error, /20分/); assert.equal(timedOut.retryable, false); assert.equal(timedOut.result.commitSha, f.result.commitSha);
  await mockedFetch(async (input, options) => options.method === 'HEAD' ? new Response(null, { status: 200 }) : Response.json(f.catalog), async () => { const retry = await responseJSON(f.state, request(API + '/jobs/' + ID + '/retry', { cookie: f.cookie, method: 'POST', body: {} })); assert.equal(retry.job.status, 'completed'); });
  assert.equal(f.git.calls.filter(call => call.path.includes('actions/')).length, 0);
});

test('publication of many assets progresses through bounded checks with a one-minute browser-closed alarm', async () => {
  const f = await publishingFixture(), catalog = clone(f.catalog), source = catalog.sources[0];
  catalog.problems = Array.from({ length: 30 }, (_, index) => ({ ...clone(catalog.problems[0]), id: 'drive-source-one-q' + (index + 1), sourceImages: ['assets/drive/source-one/' + sha(String(index)) + '.png'] })); source.problemIds = catalog.problems.map(problem => problem.id);
  const job = await f.service.job(ID); await f.service.finish(job, f.result.commitSha, catalog);
  assert(f.storage.alarmAt <= Date.now() + 60000, 'five-minute recovery intervals would exhaust 20 minutes on large batches');
  const heads = [];
  await mockedFetch(async (input, options) => { if (options.method === 'HEAD') { heads.push(String(input)); return new Response(null, { status: 200 }); } return Response.json(catalog); }, async () => {
    await f.service.alarm(); assert.equal(heads.length, 20); assert.equal((await f.service.job(ID)).status, 'publishing');
    await allowPublicationCheck(f); await f.service.alarm(); assert.equal(heads.length, 30); assert.equal((await f.service.job(ID)).status, 'completed');
  });
});

test('alarms wait for prior exact run to finish, respect dispatch grace and never revive cancelled jobs', async () => {
  for (const status of ['queued', 'in_progress']) {
    const f = await fixture(); await seedJob(f, { status: 'failed', retryable: true }); const calls = [];
    f.state.github = async path => { calls.push(path); return path.includes('/runs?') ? { workflow_runs: [] } : { status }; };
    await f.service.alarm(); assert(!calls.some(path => path.endsWith('/dispatches'))); assert.equal((await f.service.job(ID)).autoAttempts, 0); assert(f.storage.alarmAt > Date.now());
  }
  const f = await fixture(); await seedJob(f, { runId: null, status: 'needs_attention', dispatchUncertain: true, dispatchedAt: ago(5) }); await f.service.alarm(); assert.equal(f.githubCalls.length, 0);
  await seedJob(f, { status: 'cancelled', retryable: true, dispatchUncertain: true }); await f.service.alarm(); assert.equal(f.githubCalls.length, 0); assert.equal((await f.service.job(ID)).status, 'cancelled');
});

test('browser-closed recovery retries at most three times and isolates provider failures between jobs', async () => {
  const f = await fixture(); await seedJob(f, { status: 'failed', retryable: true });
  for (let index = 1; index <= 3; index++) { if (index > 1) await seedJob(f, { status: 'failed', retryable: true, autoAttempts: index - 1 }); await f.service.alarm(); assert.equal((await f.service.job(ID)).autoAttempts, index); }
  await seedJob(f, { status: 'failed', retryable: true, autoAttempts: 3 }); await f.service.alarm(); assert.equal((await f.service.job(ID)).retryable, false); assert.equal(f.githubCalls.filter(call => call.path.endsWith('/dispatches')).length, 3);
  const other = await fixture(); await seedJob(other, { status: 'failed', retryable: true }); const second = '00000000-0000-4000-8000-000000000002'; await seedJob(other, { id: second, status: 'failed', retryable: true });
  const github = other.state.github; let fail = true; other.state.github = async (...args) => { if (fail) { fail = false; throw new Error('fake provider outage'); } return github(...args); };
  await other.service.alarm(); assert.equal(other.githubCalls.filter(call => call.path.endsWith('/dispatches')).length, 1); assert.equal((await other.service.job(second)).status, 'queued'); assert(other.storage.alarmAt > Date.now());
});

test('shared strict catalog validator rejects cross-source image paths and executable extra fields', () => {
  const job = { files: [{ ...SOURCE, fingerprint: 'verified-revision' }] }, catalog = addition(job); assert.equal(validSapixCatalog(catalog), true);
  catalog.problems[0].sourceImages = ['https://evil.example/image.png']; assert.equal(validSapixCatalog(catalog), false);
  const second = addition(job); second.problems[0].question = '問題'; second.extra = 'script'; assert.equal(validSapixCatalog(second), false);
});

test('import UI script is self-contained, safely initializes without bundler helpers, and waits for confirmation', async () => {
  const { build } = await import('esbuild');
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/sapix-import.js', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', keepNames: true, minify: true });
  const bundled = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')); assert(bundled.validSapixCatalog(EMPTY()), 'shared frontend CommonJS schema works in Worker bundle');
  const uiBundle = await build({ entryPoints: [fileURLToPath(new URL('../src/sapix-import-ui.js', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', keepNames: true, minify: true });
  const ui = await import('data:text/javascript;base64,' + Buffer.from(uiBundle.outputFiles[0].text).toString('base64'));
  const page = ui.sapixImportPage(); assert.match(page, /作成された PDF・画像/); assert.match(page, /確認前に問題生成は行いません/); assert.equal(page, sapixImportPage());
  const handlers = new Map(), nodes = new Map(); function node(id) { if (!nodes.has(id)) nodes.set(id, { hidden: false, className: '', textContent: '', addEventListener(event, handler) { handlers.set(id + ':' + event, handler); }, replaceChildren() {}, append() {}, setAttribute() {} }); return nodes.get(id); }
  const calls = [], script = page.match(/<script>([\s\S]*)<\/script>/)[1];
  runInNewContext(script, { document: { hidden: false, getElementById: node, addEventListener() {}, createElement: () => node(crypto.randomUUID()) }, fetch: async (path, options) => { calls.push({ path, options }); return Response.json({ authenticated: false }); }, clearTimeout, setTimeout, Set, URL });
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(calls.length, 1); assert.equal(calls[0].path, '/api/studio/session'); assert.equal(calls[0].options.method, undefined); assert.equal(node('gate').hidden, false); assert.equal(node('workspace').hidden, true); assert(handlers.has('confirm-start:click'));
});
