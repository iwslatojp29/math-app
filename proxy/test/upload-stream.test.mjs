import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, timingSafeEqual } from 'node:crypto';
import worker from '../src/index.js';
import { MAX_UPLOAD_BYTES, githubUploadStream } from '../src/upload-stream.js';

const originalFetch = globalThis.fetch;
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: {
  digest: webcrypto.subtle.digest.bind(webcrypto.subtle),
  timingSafeEqual: (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b)),
} } });
after(() => { globalThis.fetch = originalFetch; Object.defineProperty(globalThis, 'crypto', originalCrypto); });
const env = { REPO: 'fixture/math-app', BRANCH: 'main', GITHUB_TOKEN: 'fake-upstream', UPLOAD_SECRET: 'fake-upload', ALLOWED_ORIGIN: 'https://fixture.github.io' };

function request(bytes, { size = bytes.length, filename = '2026年6月号_日日の演習.html', origin = env.ALLOWED_ORIGIN, token = env.UPLOAD_SECRET, contentLength, chunks } = {}) {
  const params = new URLSearchParams({ folder: 'math', filename, bytes: String(size) });
  let offset = 0;
  const body = new ReadableStream({ pull(controller) {
    if (offset === bytes.length) return controller.close();
    const end = Math.min(offset + (chunks || bytes.length), bytes.length);
    controller.enqueue(bytes.subarray(offset, end)); offset = end;
  } });
  return new Request('https://worker.test/api/commit?' + params, { method: 'POST', duplex: 'half', body,
    headers: { Origin: origin, Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream', ...(contentLength === undefined ? {} : { 'Content-Length': String(contentLength) }) } });
}

function backend({ conflict = false } = {}) {
  const files = new Map([['math/index.html', '<html><body>\n</body></html>']]);
  const calls = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).host, 'api.github.com');
    assert.equal(options.headers.Authorization, 'Bearer fake-upstream');
    const path = decodeURIComponent(new URL(url).pathname.split('/contents/')[1]);
    calls.push({ path, method: options.method });
    if (options.method === 'GET') return files.has(path)
      ? Response.json({ sha: 'fixture-sha', encoding: 'base64', content: Buffer.from(files.get(path)).toString('base64') })
      : Response.json({}, { status: 404 });
    const text = typeof options.body === 'string' ? options.body : await new Response(options.body).text();
    const json = JSON.parse(text);
    if (conflict && path !== 'math/index.html') return Response.json({}, { status: 409 });
    files.set(path, Buffer.from(json.content, 'base64').toString('utf8'));
    return Response.json({});
  };
  return { files, calls };
}

test('raw HTML keeps Japanese, BOM and scripts; updates file and index with filename label', async () => {
  const store = backend();
  const source = Buffer.from('\ufeff<html><body>算数🙂<script>lecture()</script></body></html>');
  const response = await worker.fetch(request(source, { chunks: 1, contentLength: source.length }), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).label, '2026年6月号_日日の演習');
  assert.equal(store.files.get('math/2026年6月号_日日の演習.html'), source.toString('utf8'));
  assert.match(store.files.get('math/index.html'), /2026年6月号_日日の演習/);
});

test('origin, authentication, reserved paths, declared size and length reject before upstream access', async () => {
  const source = Buffer.from('<html><body>解説</body></html>');
  const cases = [[{ origin: 'https://other.test' }, 403], [{ token: 'wrong' }, 401], [{ filename: 'index.html' }, 400],
    [{ size: MAX_UPLOAD_BYTES + 1 }, 413], [{ size: 0 }, 400], [{ contentLength: source.length + 1 }, 400]];
  for (const [options, status] of cases) {
    const store = backend();
    assert.equal((await worker.fetch(request(source, options), env)).status, status);
    assert.equal(store.calls.length, 0);
  }
});

test('truncated/extra bodies and invalid UTF-8 never complete a GitHub JSON write', async () => {
  for (const [source, size] of [[Buffer.from('abc'), 4], [Buffer.from('abcd'), 3], [Buffer.from([0x61, 0xe8, 0xac]), 3]]) {
    const store = backend();
    const response = await worker.fetch(request(source, { size, chunks: 1 }), env);
    assert.equal(response.status, 400);
    assert.equal(store.files.size, 1);
    assert.equal(store.calls.filter(call => call.method === 'PUT' && call.path === 'math/index.html').length, 0);
  }
});

test('a conflicting stream returns 409 without replaying it or updating the index', async () => {
  const store = backend({ conflict: true });
  const response = await worker.fetch(request(Buffer.from('<html><body>解説</body></html>')), env);
  assert.equal(response.status, 409);
  assert.equal(store.calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(store.files.size, 1);
});

test('base64 chunk alignment and declared JSON length hold across padding boundaries', async () => {
  for (const size of [1, 2, 3, 49151, 49152, 49153, 98307]) {
    const input = Buffer.alloc(size, 97);
    const upload = githubUploadStream(new Blob([input]).stream(), size, { branch: 'main', message: '講義' });
    const result = await new Response(upload.readable).text();
    assert.equal(Buffer.byteLength(result), upload.byteLength);
    assert.deepEqual(Buffer.from(JSON.parse(result).content, 'base64'), input);
  }
});
