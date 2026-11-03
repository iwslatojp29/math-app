import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { MAX_UPLOAD_BYTES } from '../src/upload-stream.js';

const env = { REPO: 'fixture/math-app', BRANCH: 'main', GITHUB_TOKEN: 'fake-upstream', UPLOAD_SECRET: 'fake-upload', ALLOWED_ORIGIN: 'https://fixture.github.io' };

// The real workerd runtime has the production 128 MB isolate memory limit.
// Outbound GitHub requests are consumed locally, never sent to a real service.
test('workerd streams 90 MiB and an optional real lecture without buffering base64 JSON', async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/index.js', import.meta.url))], bundle: true, write: false,
    format: 'esm', platform: 'neutral', loader: { '.md': 'text' } });
  let index = '<html><body>\n</body></html>';
  let uploaded = false;
  const results = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-09-20',
    script: bundle.outputFiles[0].text, bindings: env, outboundService: async request => {
      const url = new URL(request.url);
      assert.equal(url.host, 'api.github.com');
      assert.equal(request.headers.get('Authorization'), 'Bearer fake-upstream');
      const path = decodeURIComponent(url.pathname.split('/contents/')[1]);
      if (request.method === 'GET') {
        if (path === 'math/index.html') return Response.json({ sha: 'index-sha', encoding: 'base64', content: Buffer.from(index).toString('base64') });
        return uploaded ? Response.json({ sha: 'file-sha', encoding: 'none', content: '' }) : Response.json({}, { status: 404 });
      }
      assert.equal(request.method, 'PUT');
      if (path === 'math/index.html') { index = Buffer.from((await request.json()).content, 'base64').toString('utf8'); return Response.json({}); }
      const digest = createHash('sha256');
      let header = '', carry = '', tail = '', bodyBytes = 0, decodedBytes = 0, metadata, ended = false;
      const decoder = new TextDecoder();
      for await (const part of request.body) {
        bodyBytes += part.byteLength;
        let value = decoder.decode(part, { stream: true });
        if (!metadata) {
          header += value;
          const at = header.indexOf(',"content":"');
          if (at < 0) { assert.ok(header.length < 4096); continue; }
          metadata = JSON.parse(header.slice(0, at) + '}');
          value = header.slice(at + ',"content":"'.length); header = '';
        }
        if (ended) { tail += value; continue; }
        const quote = value.indexOf('"');
        if (quote >= 0) { tail = value.slice(quote); value = value.slice(0, quote); ended = true; }
        carry += value;
        const length = carry.length - carry.length % 4;
        const bytes = Buffer.from(carry.slice(0, length), 'base64');
        digest.update(bytes); decodedBytes += bytes.length;
        carry = carry.slice(length);
      }
      assert.equal(tail, '"}'); assert.equal(carry, '');
      assert.equal(Number(request.headers.get('Content-Length')), bodyBytes, 'FixedLengthStream must produce an exact request length');
      assert.equal(metadata.branch, 'main');
      if (uploaded) assert.equal(metadata.sha, 'file-sha');
      uploaded = true;
      results.push({ decodedBytes, sha256: digest.digest('hex') });
      return Response.json({});
    },
  }));
  try {
    const chunk = Buffer.alloc(49152, 97);
    let remaining = MAX_UPLOAD_BYTES;
    const expected = createHash('sha256');
    const body = new ReadableStream({ pull(controller) {
      if (!remaining) return controller.close();
      const part = chunk.subarray(0, Math.min(remaining, chunk.length));
      remaining -= part.length; expected.update(part); controller.enqueue(part);
    } });
    const params = new URLSearchParams({ folder: 'math', filename: 'runtime-lecture.html', bytes: String(MAX_UPLOAD_BYTES) });
    const headers = { Origin: env.ALLOWED_ORIGIN, Authorization: 'Bearer fake-upload', 'Content-Type': 'application/octet-stream', 'Content-Length': String(MAX_UPLOAD_BYTES) };
    const response = await mf.dispatchFetch('https://worker.test/api/commit?' + params, { method: 'POST', headers, body, duplex: 'half' });
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(results[0], { decodedBytes: MAX_UPLOAD_BYTES, sha256: expected.digest('hex') });
    if (process.env.MATH_APP_UPLOAD_TEST_FILE) {
      const file = process.env.MATH_APP_UPLOAD_TEST_FILE;
      const size = (await stat(file)).size;
      const hash = createHash('sha256');
      for await (const part of createReadStream(file)) hash.update(part);
      params.set('bytes', String(size)); headers['Content-Length'] = String(size);
      const actual = await mf.dispatchFetch('https://worker.test/api/commit?' + params, { method: 'POST', headers, body: Readable.toWeb(createReadStream(file)), duplex: 'half' });
      assert.equal(actual.status, 200, await actual.text());
      assert.deepEqual(results[1], { decodedBytes: size, sha256: hash.digest('hex') });
    }
  } finally { await mf.dispose(); }
});
