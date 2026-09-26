import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { StudioState, FOLDERS, seal } from '../src/studio.js';
import { MAX_CHAT_PDF_BYTES } from '../src/studio-chat.js';

// Synthetic identities only. No live Drive, OpenAI or GitHub calls are permitted.
const ENV = { STUDIO_SECRET: 'synthetic-cookie-key', STUDIO_OWNER_EMAIL: 'owner@example.test',
  STUDIO_ORIGIN: 'https://studio.example.test', STUDIO_RUNNER_TOKEN: 'synthetic-runner-key' };
const CSRF = 'synthetic-csrf', PDF = Buffer.from('%PDF-1.7\nsynthetic complete PDF bytes\n%%EOF\n');
const SOURCE = { id: 'cut-pdf', name: '整数_日日の演習.pdf', mimeType: 'application/pdf', size: String(PDF.length),
  parents: [FOLDERS.practice], modifiedTime: '2026-09-01T00:00:00.000Z', md5Checksum: 'synthetic-md5', version: '7', trashed: false };
const clone = value => value === undefined ? value : structuredClone(value);
class MemoryStorage {
  values = new Map(); alarms = [];
  async get(key) { return clone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, clone(value)); }
  async list({ prefix = '' } = {}) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, clone(value)])); }
  async getAlarm() { return this.alarms.at(-1); }
  async setAlarm(value) { this.alarms.push(value); }
}
async function fixture(State = StudioState) {
  const storage = new MemoryStorage(), state = new State({ storage }, { ...ENV });
  state.access = { accessToken: 'synthetic-drive-access', expires: Date.now() + 3600000 };
  const cookie = await seal({ email: ENV.STUDIO_OWNER_EMAIL, csrf: CSRF, expires: Date.now() + 3600000 }, ENV.STUDIO_SECRET, 'session');
  const calls = [];
  state.drive = async (path, params) => { calls.push({ path, params }); return clone(SOURCE); };
  state.sapixImport.alarm = async () => {};
  return { state, storage, cookie, calls };
}
function request(path, cookie, body) {
  return new Request(ENV.STUDIO_ORIGIN + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(cookie ? { Cookie: '__Host-studio=' + cookie } : {}), Origin: ENV.STUDIO_ORIGIN,
      'x-studio-csrf': CSRF, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const path = (modifiedTime = SOURCE.modifiedTime) => '/api/studio/chat/pdf/' + SOURCE.id + '?modifiedTime=' + encodeURIComponent(modifiedTime);
async function network(mock, action) { const old = globalThis.fetch; globalThis.fetch = mock; try { return await action(); } finally { globalThis.fetch = old; } }
const forbid = () => { throw new Error('No provider call is permitted'); };
const oldJob = overrides => ({ id: 'old-html', operation: 'html', source: clone(SOURCE), fileId: SOURCE.id, fileName: SOURCE.name,
  status: 'needs_attention', stage: 'lesson_generation', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  retryable: true, continuation: true, dispatchUncertain: true, model: 'synthetic-model', runId: null,
  result: { outputs: [{ pdf: clone(SOURCE), html: { id: 'old-html-result' }, published: { url: 'https://example.test/old.html' } }] }, ...overrides });

test('handoff endpoints require a current owner session before any source access', async () => {
  const { state, cookie, calls } = await fixture();
  const expired = await seal({ email: ENV.STUDIO_OWNER_EMAIL, expires: 1 }, ENV.STUDIO_SECRET, 'session');
  const other = await seal({ email: 'other@example.test', expires: Date.now() + 60000 }, ENV.STUDIO_SECRET, 'session');
  await network(forbid, async () => {
    for (const invalid of [undefined, expired, other, cookie + '-tampered']) for (const route of [path(), '/api/studio/chat/instructions']) {
      const response = await state.fetch(request(route, invalid));
      assert.equal(response.status, 401); assert.equal((await response.json()).error, 'unauthorized');
    }
    assert.deepEqual(calls, []);
  });
});

test('production text bundling serves the exact canonical instruction bytes privately with no AI keys', async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/studio.js', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', loader: { '.md': 'text' } });
  const module = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const { state, cookie, calls } = await fixture(module.StudioState);
  const before = [...state.storage.values];
  await network(forbid, async () => {
    const response = await state.fetch(request('/api/studio/chat/instructions', cookie));
    assert.equal(response.status, 200); assert.match(response.headers.get('Content-Type'), /text\/markdown/);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('Vary'), 'Cookie');
    assert.match(response.headers.get('Content-Disposition'), /^attachment;.*filename\*=UTF-8''/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL('../../automation/specs/animation-html.md', import.meta.url)));
    assert.deepEqual([...state.storage.values], before); assert.deepEqual(calls, []);
  });
});

test('an explicit PDF download checks direct folders then streams unchanged bytes and rechecks metadata', async () => {
  for (const folder of [FOLDERS.practice, FOLDERS.advanced]) {
    const { state, storage, cookie, calls } = await fixture();
    state.drive = async (route, params) => { calls.push({ route, params }); return { ...clone(SOURCE), parents: [folder] }; };
    let downloads = 0;
    await network(async (input, options) => {
      downloads++; const url = new URL(input);
      assert.equal(url.origin, 'https://www.googleapis.com'); assert.equal(url.pathname, '/drive/v3/files/cut-pdf');
      assert.equal(url.searchParams.get('alt'), 'media');
      assert.equal(options.headers.Authorization, 'Bearer synthetic-drive-access');
      assert.equal(options.redirect, 'error');
      return new Response(PDF, { headers: { 'Content-Length': String(PDF.length) } });
    }, async () => {
      assert.equal(downloads, 0, 'selection and fixture setup never download the PDF');
      const response = await state.fetch(request(path(), cookie));
      assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'application/pdf');
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      assert.match(response.headers.get('Content-Disposition'), /filename\*=UTF-8''%/);
      assert(![...response.headers].flat().join(' ').includes('synthetic-drive-access'));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), PDF);
      assert.equal(downloads, 1); assert.equal(calls.length, 2);
      assert(calls.every(call => call.route === 'files/cut-pdf' && call.params.fields.includes('trashed')));
      assert.equal(storage.values.size, 0);
    });
  }
});

test('changed, moved, trashed, non-PDF and oversized sources fail before media fetch', async () => {
  for (const [change, status, code] of [
    [{ modifiedTime: '2026-09-02T00:00:00Z' }, 409, 'source_changed'],
    [{ parents: [FOLDERS.source] }, 404, 'not_found'], [{ parents: ['nested-cut-folder'] }, 404, 'not_found'],
    [{ trashed: true }, 404, 'not_found'], [{ mimeType: 'text/html' }, 404, 'not_found'],
    [{ name: 'wrong.html' }, 404, 'not_found'], [{ id: 'different-id' }, 404, 'not_found'],
    [{ size: String(MAX_CHAT_PDF_BYTES + 1) }, 413, 'source_too_large'], [{ size: 'unknown' }, 502, 'drive_unavailable'],
  ]) {
    const { state, cookie } = await fixture(); state.drive = async () => ({ ...clone(SOURCE), ...change });
    await network(forbid, async () => {
      const response = await state.fetch(request(path(), cookie));
      assert.equal(response.status, status, JSON.stringify(change)); assert.equal((await response.json()).error, code);
    });
  }
});

test('source snapshot is mandatory and invalid IDs cannot escape the fixed Drive endpoint', async () => {
  const { state, cookie, calls } = await fixture();
  await network(forbid, async () => {
    for (const route of ['/api/studio/chat/pdf/cut-pdf', path('bad-time'), path(''), '/api/studio/chat/pdf/cut-pdf%2Fother']) {
      const response = await state.fetch(request(route, cookie));
      assert([400, 404].includes(response.status));
    }
    assert.deepEqual(calls, []);
  });
});

test('stream size and final metadata checks reject truncated, extra or changed PDF bytes', async () => {
  for (const mode of ['short', 'long', 'header', 'changed-after', 'moved-after', 'trashed-after']) {
    const { state, cookie } = await fixture(); let reads = 0;
    state.drive = async () => {
      const source = clone(SOURCE); reads++;
      if (reads > 1) {
        if (mode === 'changed-after') source.version = '8';
        if (mode === 'moved-after') source.parents = [FOLDERS.source];
        if (mode === 'trashed-after') source.trashed = true;
      }
      return source;
    };
    await network(async () => new Response(mode === 'short' ? PDF.subarray(1) : mode === 'long' ? Buffer.concat([PDF, Buffer.from('x')]) : PDF,
      { headers: mode === 'header' ? { 'Content-Length': String(PDF.length + 1) } : {} }), async () => {
      const response = await state.fetch(request(path(), cookie));
      if (mode === 'header') { assert.equal(response.status, 409); assert.equal((await response.json()).error, 'source_changed'); }
      else { assert.equal(response.status, 200); await assert.rejects(response.arrayBuffer(), /PDF download could not be verified/); }
    });
  }
});

test('new HTML jobs, manual retries, direct dispatch and alarms never purchase another run', async () => {
  const { state, storage, cookie } = await fixture();
  state.sources = forbid; state.catalog = forbid; state.github = forbid;
  const existing = oldJob(); await state.saveJob(existing);
  const before = clone(storage.values), alarms = [...storage.alarms];
  await network(forbid, async () => {
    for (const [route, body] of [['/api/studio/jobs', { operation: 'html', fileId: SOURCE.id }], ['/api/studio/jobs/old-html/retry', {}]]) {
      const response = await state.fetch(request(route, cookie, body));
      assert.equal(response.status, 409); const data = await response.json();
      assert.equal(data.error, 'html_chat_required'); assert.match(data.message, /ChatGPT/);
    }
    await assert.rejects(state.dispatch(existing), { code: 'html_chat_required' });
    await state.alarm();
    const history = await state.fetch(request('/api/studio/jobs/old-html', cookie));
    assert.equal(history.status, 200); assert.deepEqual((await history.json()).job.result, existing.result);
    assert.deepEqual(storage.values, before); assert.deepEqual(storage.alarms, alarms);
  });
});

test('cancel and completed HTML history stay available after handoff migration', async () => {
  const { state, cookie } = await fixture();
  await state.saveJob(oldJob({ status: 'completed', retryable: false, dispatchUncertain: false }));
  await network(forbid, async () => {
    const history = await state.fetch(request('/api/studio/jobs/old-html', cookie));
    assert.equal((await history.json()).job.status, 'completed');
    await state.saveJob(oldJob({ status: 'running' }));
    const response = await state.fetch(request('/api/studio/jobs/old-html/cancel', cookie, {}));
    const cancelled = (await response.json()).job;
    assert.equal(cancelled.status, 'cancelled'); assert.deepEqual(cancelled.result, oldJob().result);
    await state.alarm(); assert.equal((await state.job('old-html')).status, 'cancelled');
  });
});
