import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import worker, { updateIndex } from '../src/index.js';

// These are deliberately fake test fixtures, never deployment credentials.
const env = { ALLOWED_ORIGIN: 'https://example.github.io', UPLOAD_SECRET: 'test-passphrase', GITHUB_TOKEN: 'test-upstream-credential', REPO: 'example/math-app', BRANCH: 'main', LABEL_WITH_EXT: 'false' };
const originalFetch = globalThis.fetch;
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
let comparisons = 0;
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: {
  digest: webcrypto.subtle.digest.bind(webcrypto.subtle),
  timingSafeEqual(a, b) {
    comparisons++;
    assert.equal(a.byteLength, 32);
    assert.equal(b.byteLength, 32);
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  },
} } });
after(() => {
  globalThis.fetch = originalFetch;
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  else delete globalThis.crypto;
});

const b64 = value => Buffer.from(value, 'utf8').toString('base64');
const simpleIndex = '<!doctype html><html><body>\n<h1>一覧</h1>\n</body></html>';

function mockGithub(initial = { 'math/index.html': simpleIndex }, intercept) {
  let revision = 0;
  const files = new Map();
  const calls = [];
  function set(path, text) { files.set(path, { text, sha: `sha-${++revision}` }); }
  for (const [path, text] of Object.entries(initial)) set(path, text);
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com');
    assert.equal(options.headers['User-Agent'], 'math-app-proxy');
    assert.equal(options.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
    assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
    const path = decodeURIComponent(parsed.pathname.replace('/repos/example/math-app/contents/', ''));
    const body = options.body ? JSON.parse(options.body) : undefined;
    const call = { path, method: options.method, body };
    calls.push(call);
    if (options.method === 'GET') assert.equal(parsed.searchParams.get('ref'), env.BRANCH);
    else assert.equal(body.branch, env.BRANCH);
    const overridden = await intercept?.(call, { files, set, calls });
    if (overridden) return overridden;
    const existing = files.get(path);
    if (options.method === 'GET') return existing
      ? Response.json({ type: 'file', sha: existing.sha, encoding: 'base64', content: b64(existing.text).match(/.{1,60}/g)?.join('\n') || '' })
      : Response.json({ message: 'Not Found' }, { status: 404 });
    if (options.method === 'PUT') {
      if ((existing && body.sha !== existing.sha) || (!existing && body.sha)) return Response.json({ message: 'sha conflict' }, { status: 409 });
      set(path, Buffer.from(body.content, 'base64').toString('utf8'));
      return Response.json({ content: { sha: files.get(path).sha } });
    }
    if (options.method === 'DELETE') {
      if (!existing) return Response.json({ message: 'Not Found' }, { status: 404 });
      if (body.sha !== existing.sha) return Response.json({ message: 'sha conflict' }, { status: 409 });
      files.delete(path);
      return Response.json({ content: null });
    }
    throw new Error('Unexpected method');
  };
  return { files, calls, set };
}

function request(path = '/api/commit', body = {}, { method = 'POST', origin = env.ALLOWED_ORIGIN, authorization = `Bearer ${env.UPLOAD_SECRET}`, headers = {}, rawBody } = {}) {
  const actualHeaders = { 'Content-Type': 'application/json', ...headers };
  if (origin !== null) actualHeaders.Origin = origin;
  if (authorization !== null) actualHeaders.Authorization = authorization;
  return new Request(`https://worker.example${path}`, { method, headers: actualHeaders, ...(!['GET', 'OPTIONS'].includes(method) ? { body: rawBody ?? JSON.stringify(body) } : {}) });
}

async function send(body, path = '/api/commit', overrides, environment = env) {
  const response = await worker.fetch(request(path, body, overrides), environment);
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const commitBody = (filename = '問題.html') => ({ folder: 'math', filename, contentBase64: b64('<!doctype html><title>別のタイトル</title><body>日本語 😊</body>') });

test('preflight, exact endpoint routing, CORS and native constant-time authentication', async () => {
  const backend = mockGithub();
  const preflight = await worker.fetch(request('/api/commit', {}, { method: 'OPTIONS', authorization: null }), env);
  assert.equal(preflight.status, 204);
  assert.equal(await preflight.text(), '');
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), env.ALLOWED_ORIGIN);
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
  assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Authorization, Content-Type');
  for (const origin of [null, 'null', 'https://evil.example', `${env.ALLOWED_ORIGIN}.evil.example`]) {
    const result = await send(commitBody(), '/api/commit', { origin });
    assert.equal(result.status, 403);
    assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
  }
  for (const authorization of [null, 'Bearer wrong', 'Bearer test', 'Basic test-passphrase', 'Bearer  test-passphrase']) {
    const result = await send(commitBody(), '/api/commit', { authorization });
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { ok: false, error: 'unauthorized' });
  }
  for (const [path, method] of [['/api/list', 'POST'], ['/api/commit/', 'POST'], ['/api/commit', 'GET'], ['/api/delete', 'PUT'], ['/elsewhere', 'OPTIONS']]) {
    const result = await worker.fetch(request(path, {}, { method }), env);
    assert.equal(result.status, 404);
  }
  assert.ok(comparisons >= 2);
  assert.equal(backend.calls.length, 0);
});

test('create and update use the filename label, preserve UTF-8, and never duplicate a card', async () => {
  const backend = mockGithub();
  const body = commitBody();
  const created = await send(body);
  assert.equal(created.status, 200);
  assert.deepEqual(created.body, { ok: true, file: 'math/問題.html', indexUpdated: true, label: '問題' });
  assert.equal(backend.files.get('math/問題.html').text, Buffer.from(body.contentBase64, 'base64').toString('utf8'));
  let index = backend.files.get('math/index.html').text;
  assert.match(index, /href="\.\/%E5%95%8F%E9%A1%8C.html">問題<\/a>/);
  assert.ok(!index.includes('別のタイトル'));
  const updated = await send({ ...body, contentBase64: b64('<body>変更済み</body>'), commitMessage: 'Update lesson' });
  assert.deepEqual(updated.body, { ok: true, file: 'math/問題.html', indexUpdated: false, label: '問題' });
  assert.equal(backend.files.get('math/問題.html').text, '<body>変更済み</body>');
  assert.equal(backend.files.get('math/index.html').text, index);
  const filePuts = backend.calls.filter(call => call.path === 'math/問題.html' && call.method === 'PUT');
  assert.equal(filePuts[0].body.message, 'Add 問題.html');
  assert.equal(filePuts[0].body.sha, undefined);
  assert.ok(filePuts[1].body.sha);
  assert.equal(filePuts[1].body.message, 'Update lesson');
});

test('extension setting, Japanese and HTML-special filenames produce escaped labels and URL-safe hrefs', async () => {
  const backend = mockGithub();
  const filename = '日本語 <&"\'?#%.HTML';
  const result = await send(commitBody(filename), '/api/commit', undefined, { ...env, LABEL_WITH_EXT: 'true' });
  assert.equal(result.status, 200);
  assert.equal(result.body.label, filename);
  const html = backend.files.get('math/index.html').text;
  assert.ok(html.includes('日本語 &lt;&amp;&quot;&#39;?#%.HTML</a>'));
  assert.ok(html.includes('%3C%26%22%27%3F%23%25.HTML'));
  assert.ok(!html.includes('href="./日本語'));
  const deletion = await send({ folder: 'math', filename }, '/api/delete');
  assert.equal(deletion.status, 200);
  assert.equal(backend.files.has(`math/${filename}`), false);
  assert.equal(backend.files.get('math/index.html').text, simpleIndex);
});

test('existing raw/encoded/entity hrefs are recognized; deletion removes duplicate nested cards intact', async () => {
  const filename = '問題 & (1).html';
  const html = `<html><body>\n<div class='card featured' data-note='>'><div><a href='./問題 &amp; (1).html'><span>旧表示名</span></a></div><p>説明</p></div>\n<div class="card"><a href="./%E5%95%8F%E9%A1%8C%20%26%20(1).html">重複</a></div>\n<div class="card"><a href="./別.html">保存</a></div>\n</body></html>`;
  const backend = mockGithub({ 'math/index.html': html, [`math/${filename}`]: '<p>旧</p>' });
  const uploaded = await send(commitBody(filename));
  assert.equal(uploaded.body.indexUpdated, false);
  assert.equal(backend.files.get('math/index.html').text, html);
  const deleted = await send({ folder: 'math', filename }, '/api/delete');
  assert.deepEqual(deleted.body, { ok: true });
  const final = backend.files.get('math/index.html').text;
  assert.ok(!final.includes('旧表示名'));
  assert.ok(!final.includes('説明'));
  assert.ok(!final.includes('重複'));
  assert.ok(final.includes('<div class="card"><a href="./別.html">保存</a></div>'));
});

test('space and literal-percent filenames coexist and deleting either preserves the other', async () => {
  const index = '<html><body>\n<div class="card"><a href="./a%20b.html?view=1#section">SPACE</a></div>\n</body></html>';
  const backend = mockGithub({ 'math/index.html': index, 'math/a b.html': '<p>space file</p>' });
  const literal = commitBody('a%20b.html');
  const created = await send(literal);
  assert.equal(created.status, 200);
  assert.equal(created.body.indexUpdated, true);
  assert.ok(backend.files.get('math/index.html').text.includes('href="./a%2520b.html"'));
  assert.ok(backend.files.get('math/index.html').text.includes('>SPACE</a>'));
  assert.equal((await send(literal, '/api/delete')).status, 200);
  assert.equal(backend.files.get('math/index.html').text, index);
  assert.equal(backend.files.get('math/a b.html').text, '<p>space file</p>');
  assert.equal(backend.files.has('math/a%20b.html'), false);
  assert.equal((await send(literal)).status, 200);
  assert.equal((await send({ folder: 'math', filename: 'a b.html' }, '/api/delete')).status, 200);
  assert.ok(!backend.files.get('math/index.html').text.includes('>SPACE</a>'));
  assert.ok(backend.files.get('math/index.html').text.includes('href="./a%2520b.html"'));
  assert.ok(backend.files.has('math/a%20b.html'));
  assert.equal(backend.files.has('math/a b.html'), false);
});

test('href matching respects query/fragment boundaries, single decoding and legacy bare percent signs', () => {
  const index = '<html><body><div class="card"><a href="./lesson.html?name=a#b.html">QUERY</a></div><div class="card"><a href="./100%完了.html">PERCENT</a></div><div class="card"><a href="./a%2520b.html">ENCODED</a></div></body></html>';
  assert.equal(updateIndex(index, { folder: 'math', filename: 'lesson.html' }, 'lesson'), index);
  const literalQuery = updateIndex(index, { folder: 'math', filename: 'lesson.html?name=a#b.html' }, 'literal');
  assert.notEqual(literalQuery, index);
  assert.ok(literalQuery.includes('href="./lesson.html%3Fname%3Da%23b.html"'));
  assert.ok(updateIndex(index, { folder: 'math', filename: 'lesson.html' }, 'lesson', true).includes('>PERCENT</a>'));
  assert.equal(updateIndex(index, { folder: 'math', filename: '100%完了.html' }, 'percent'), index);
  assert.equal(updateIndex(index, { folder: 'math', filename: 'a%20b.html' }, 'encoded'), index);
  assert.notEqual(updateIndex(index, { folder: 'math', filename: 'a b.html' }, 'space'), index);
  assert.notEqual(updateIndex(index, { folder: 'math', filename: 'a%2520b.html' }, 'double'), index);
});

test('tokenizer ignores comments/scripts/styles/textarea markup and handles greater-than in attributes', () => {
  const fake = '<div class="card"><a href="./test.html">FAKE</a></div>';
  const html = `<html><head><style>/* ${fake} */</style></head><body><!-- ${fake} --><script>const x = '${fake}'; const y = '</body>';</script><textarea>${fake}</textarea><div class="card" title="a > b"><div><a href="./test.html">REAL</a></div><p>tail</p></div>\n<footer>keep</footer></body></html>`;
  const result = updateIndex(html, { folder: 'math', filename: 'test.html' }, 'test', true);
  assert.ok(!result.includes('REAL'));
  assert.ok(!result.includes('<p>tail</p>'));
  assert.equal(result.match(/FAKE/g).length, 4);
  assert.ok(result.includes('<footer>keep</footer>'));
});

test('science/social cards preserve subject tabs and insert inside card-list', async () => {
  const index = '<html><body><div id="card-list">\n<!-- CARDS -->\n</div><script>keep()</script></body></html>';
  const backend = mockGithub({ 'science-society/index.html': index });
  const body = { ...commitBody('社会の問題.html'), folder: 'science-society', subject: '社会' };
  assert.equal((await send(body)).status, 200);
  const html = backend.files.get('science-society/index.html').text;
  assert.match(html, /class="card" data-subject="社会"/);
  assert.ok(html.indexOf('>社会の問題</a>') < html.indexOf('<!-- CARDS -->'));
  assert.ok(!html.includes('【社会】'));
  const noMarker = '<html><body><div id="card-list"><p>keep</p></div></body></html>';
  const fallback = updateIndex(noMarker, { folder: 'science-society', filename: '科学.html' }, '科学');
  assert.ok(fallback.includes('data-subject="理科"'));
  assert.ok(fallback.indexOf('>科学</a>') < fallback.lastIndexOf('</div>'));
  assert.throws(() => updateIndex(simpleIndex, body, 'lesson'), /index_unavailable/);
});

test('all real subject indexes preserve every existing card and restore byte-for-byte after a Japanese card round trip', async () => {
  for (const folder of ['math', 'japanese', 'science-society']) {
    const bytes = await readFile(new URL(`../../${folder}/index.html`, import.meta.url));
    const original = bytes.toString('utf8');
    const body = { folder, filename: '_worker_local_検証.html', subject: '社会' };
    const inserted = updateIndex(original, body, '_worker_local_検証');
    assert.notEqual(inserted, original, `${folder}: card inserted`);
    assert.equal(updateIndex(inserted, body, '_worker_local_検証'), inserted, `${folder}: duplicate skipped`);
    assert.ok(Buffer.from(updateIndex(inserted, body, '_worker_local_検証', true), 'utf8').equals(bytes), `${folder}: byte-for-byte restoration`);
    let existingCards = 0;
    for (const match of original.matchAll(/href\s*=\s*["']\.\/([^"']+\.html)["']/gi)) {
      const filename = decodeURIComponent(match[1]);
      if (['index.html', 'upload.html', 'delete.html'].includes(filename.toLowerCase())) continue;
      assert.equal(updateIndex(original, { folder, filename }, filename.replace(/\.html$/i, '')), original, `${folder}: existing card retained`);
      existingCards++;
    }
    assert.ok(existingCards > 0, `${folder}: existing cards checked`);
  }
});

test('valid newlines in base64 are normalized; incorrect UTF-8, padding, JSON, and unsafe paths are rejected before upstream calls', async () => {
  const backend = mockGithub();
  const badBodies = [
    null, [], {}, { ...commitBody(), folder: 'proxy' }, { ...commitBody(), folder: 'shared' },
    { ...commitBody(), folder: '.github' }, { ...commitBody(), folder: '../math' }, { ...commitBody(), folder: 'Math' },
    ...['index.html', 'UPLOAD.HTML', 'delete.html', '../test.html', 'a/b.html', 'a\\b.html', 'a..b.html', 'a\n.html', 'a\u0000.html', 'test.txt', '.html', '\ud800.html'].map(filename => ({ ...commitBody(), filename })),
    ...['abcd=', 'AB==', 'a===', 'a b=', '____', '/w==', 'YQ==YQ==', 'a'].map(contentBase64 => ({ ...commitBody(), contentBase64 })),
    { ...commitBody(), subject: 'invalid' }, { ...commitBody(), commitMessage: 'line\nbreak' },
  ];
  for (const body of badBodies) assert.equal((await send(body)).status, 400, JSON.stringify(body));
  assert.equal((await send({}, '/api/commit', { rawBody: '{"broken"' })).status, 400);
  assert.equal((await send(commitBody(), '/api/commit', { headers: { 'Content-Type': 'text/plain' } })).status, 400);
  assert.equal(backend.calls.length, 0);
  const valid = { ...commitBody('valid.html'), contentBase64: 'YQ==\r\n' };
  assert.equal((await send(valid)).status, 200);
  assert.equal(backend.files.get('math/valid.html').text, 'a');
});

test('10 MiB decoded-content limit and streamed JSON limit return 413 without upstream writes', async () => {
  const backend = mockGithub();
  const maxBytes = 10 * 1024 * 1024;
  const maxBase64 = 4 * Math.ceil(maxBytes / 3);
  const oversize = [
    { ...commitBody(), contentBase64: 'A'.repeat(maxBase64 + 4) },
    // One byte over the decoded limit has the same encoded length as the limit.
    { ...commitBody(), contentBase64: Buffer.alloc(maxBytes + 1, 97).toString('base64') },
  ];
  assert.equal(oversize[1].contentBase64.length, maxBase64);
  for (const body of oversize) {
    const result = await send(body);
    assert.equal(result.status, 413);
    assert.deepEqual(result.body, { ok: false, error: 'file_too_large' });
  }
  const declaredLarge = await send(commitBody(), '/api/commit', { headers: { 'Content-Length': String(maxBase64 + 16 * 1024 + 1) } });
  assert.equal(declaredLarge.status, 413);
  assert.equal(declaredLarge.body.error, 'file_too_large');
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024).fill(32)); },
    cancel() { cancelled = true; },
  });
  const streamed = new Request('https://worker.example/api/commit', { method: 'POST', headers: { Origin: env.ALLOWED_ORIGIN, Authorization: `Bearer ${env.UPLOAD_SECRET}`, 'Content-Type': 'application/json' }, body: stream, duplex: 'half' });
  const streamResponse = await worker.fetch(streamed, env);
  assert.equal(streamResponse.status, 413);
  assert.deepEqual(await streamResponse.json(), { ok: false, error: 'file_too_large' });
  assert.equal(cancelled, true);
  assert.equal(backend.calls.length, 0);
  const maxContent = Buffer.alloc(maxBytes, 97).toString('base64');
  assert.equal(maxContent.length, maxBase64);
  assert.equal((await send({ ...commitBody('maximum.html'), contentBase64: maxContent })).status, 200);
  assert.equal(Buffer.byteLength(backend.files.get('math/maximum.html').text), maxBytes);
});

test('large Japanese image-heavy HTML can be created, updated and deleted with metadata-only GitHub reads', async () => {
  const filename = '2026年8月号_図形と比_講義アニメーション.html';
  const source = process.env.MATH_APP_UPLOAD_TEST_FILE
    ? await readFile(process.env.MATH_APP_UPLOAD_TEST_FILE)
    : Buffer.from('<!doctype html><body>図形と比の講義<img src="data:image/png;base64,' + 'A'.repeat(8_701_000) + '"></body>');
  assert.ok(source.length > 8 * 1024 * 1024 && source.length < 10 * 1024 * 1024);
  const path = `math/${filename}`;
  let metadataReads = 0;
  const backend = mockGithub(undefined, (call, store) => {
    if (call.method === 'GET' && call.path === path && store.files.has(path)) {
      metadataReads++;
      return Response.json({ type: 'file', sha: store.files.get(path).sha, encoding: 'none', content: '' });
    }
  });
  const body = { folder: 'math', filename, contentBase64: source.toString('base64') };
  const created = await send(body);
  assert.equal(created.status, 200);
  assert.equal(created.body.label, '2026年8月号_図形と比_講義アニメーション');
  assert.ok(Buffer.from(backend.files.get(path).text, 'utf8').equals(source));
  const updated = await send(body);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.indexUpdated, false);
  assert.equal((await send({ folder: 'math', filename }, '/api/delete')).status, 200);
  assert.equal(metadataReads, 2);
  assert.equal(backend.files.has(path), false);
  assert.equal(backend.files.get('math/index.html').text, simpleIndex);
});

test('chunked content validation handles multibyte UTF-8 across boundaries and rejects truncated UTF-8 before writes', async () => {
  const backend = mockGithub();
  // The Japanese code point starts one byte before the base64 chunk boundary.
  const text = 'a'.repeat(49151) + '講義🙂' + 'b'.repeat(49152);
  assert.equal((await send({ ...commitBody('utf8-chunks.html'), contentBase64: b64(text) })).status, 200);
  assert.equal(backend.files.get('math/utf8-chunks.html').text, text);
  const calls = backend.calls.length;
  const truncated = Buffer.concat([Buffer.alloc(49151, 97), Buffer.from([0xe8, 0xac])]).toString('base64');
  const invalid = await send({ ...commitBody('invalid-utf8.html'), contentBase64: truncated });
  assert.equal(invalid.status, 400);
  assert.equal(backend.calls.length, calls);
});

test('missing or malformed index aborts before changing content', async () => {
  for (const initial of [{}, { 'math/index.html': '<html><body><div class="card"></body></html>' }, { 'math/index.html': '<p>No body end</p>' }]) {
    const backend = mockGithub(initial);
    const result = await send(commitBody());
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'index_unavailable');
    assert.equal(backend.calls.some(call => call.method !== 'GET'), false);
  }
});

test('file and index SHA conflicts re-read current state without losing unrelated concurrent cards', async () => {
  let fileConflict = false;
  let indexConflict = false;
  const backend = mockGithub(undefined, (call, store) => {
    if (call.method === 'PUT' && call.path === 'math/問題.html' && !fileConflict) {
      fileConflict = true;
      store.set(call.path, '<p>Concurrent upload</p>');
      return Response.json({}, { status: 409 });
    }
    if (call.method === 'PUT' && call.path === 'math/index.html' && !indexConflict) {
      indexConflict = true;
      store.set(call.path, simpleIndex.replace('</body>', '<div class="card"><a href="./other.html">other</a></div></body>'));
      return Response.json({}, { status: 409 });
    }
  });
  const result = await send(commitBody());
  assert.equal(result.status, 200);
  const html = backend.files.get('math/index.html').text;
  assert.ok(html.includes('other.html'));
  assert.equal(html.match(/%E5%95%8F%E9%A1%8C.html/g).length, 1);
  assert.equal(fileConflict && indexConflict, true);
});

test('retry after a partial commit repairs index and does not duplicate a concurrent matching card', async () => {
  let indexFailure = true;
  const backend = mockGithub(undefined, call => {
    if (call.path === 'math/index.html' && call.method === 'PUT' && indexFailure) {
      indexFailure = false;
      return Response.json({ message: `${env.GITHUB_TOKEN} private upstream detail` }, { status: 500 });
    }
  });
  const first = await send(commitBody());
  assert.equal(first.status, 502);
  assert.deepEqual(first.body, { ok: false, error: 'upstream_error' });
  assert.ok(backend.files.has('math/問題.html'));
  assert.equal((await send(commitBody())).status, 200);
  assert.equal(backend.files.get('math/index.html').text.match(/%E5%95%8F%E9%A1%8C.html/g).length, 1);

  let inserted = false;
  const concurrent = mockGithub(undefined, (call, store) => {
    if (!inserted && call.method === 'PUT' && call.path === 'math/index.html') {
      inserted = true;
      store.set(call.path, updateIndex(simpleIndex, commitBody(), '問題'));
      return Response.json({}, { status: 409 });
    }
  });
  assert.equal((await send(commitBody())).status, 200);
  assert.equal(concurrent.files.get('math/index.html').text.match(/%E5%95%8F%E9%A1%8C.html/g).length, 1);
});

test('delete retries handle concurrent SHA changes and missing-file cleanup after partial success', async () => {
  const initial = { 'math/index.html': updateIndex(simpleIndex, commitBody(), '問題'), 'math/問題.html': '<p>old</p>' };
  let deleteConflict = true;
  let indexFailure = true;
  const backend = mockGithub(initial, (call, store) => {
    if (call.method === 'DELETE' && deleteConflict) {
      deleteConflict = false;
      store.set(call.path, '<p>new</p>');
      return Response.json({}, { status: 409 });
    }
    if (call.method === 'PUT' && call.path === 'math/index.html' && indexFailure) {
      indexFailure = false;
      return Response.json({}, { status: 500 });
    }
  });
  assert.equal((await send(commitBody(), '/api/delete')).status, 502);
  assert.equal(backend.files.has('math/問題.html'), false);
  assert.ok(backend.files.get('math/index.html').text.includes('>問題</a>'));
  assert.deepEqual((await send(commitBody(), '/api/delete')).body, { ok: true });
  assert.ok(!backend.files.get('math/index.html').text.includes('>問題</a>'));
  assert.equal((await send(commitBody(), '/api/delete')).status, 200);
});

test('bounded conflict retries and upstream/network failures return only safe public errors', async () => {
  const backend = mockGithub(undefined, call => call.method === 'PUT' ? Response.json({ message: env.GITHUB_TOKEN }, { status: 409 }) : undefined);
  const conflict = await send(commitBody());
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body, { ok: false, error: 'conflict_retry' });
  assert.equal(backend.calls.filter(call => call.method === 'PUT').length, 4);
  globalThis.fetch = async () => { throw new Error(`${env.GITHUB_TOKEN} sensitive request URL`); };
  const failed = await send(commitBody());
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.body, { ok: false, error: 'upstream_error' });
  assert.equal(failed.headers.get('Cache-Control'), 'no-store');
});
