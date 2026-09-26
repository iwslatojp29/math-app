import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Run the actual Worker code in workerd. Every outbound request is handled
// locally by the test; no provider, real credential, or public site is contacted.
const catalog = { schemaVersion: 1, sources: [{ fileId: 'source', name: 'test.pdf', modifiedTime: '2026-09-24T00:00:00Z', fingerprint: 'fake-revision', problemIds: ['drive-source-q1'] }], problems: [{ id: 'drive-source-q1', unit: '計算', title: '足し算', src: 'test.pdf', stars: 1, tests: [], question: '1 + 1', subquestions: [], answers: [{ label: '', text: '2' }], steps: [{ title: '', text: '1 を加えます。' }], sourceImages: ['assets/drive/source/' + 'a'.repeat(64) + '.png'] }] };
const source = `
import { StudioState } from './src/studio.js';
class MemoryStorage {
  values = new Map();
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
}
export default { async fetch(request) {
  const state = new StudioState({ storage: new MemoryStorage() }, { ANTHROPIC_API_KEY: 'fake-runtime-test-key', REPO: 'example/math-app', BRANCH: 'main' });
  const service = state.sapixImport;
  try {
    if (new URL(request.url).pathname === '/model') return Response.json({ model: await service.model() });
    const catalog = ${JSON.stringify(catalog)};
    const job = { id: 'runtime-test', files: [{ id: 'source' }], model: { id: 'claude-fable-5-1', name: 'Fable' }, assets: {} };
    await service.finish(job, 'fake-commit', catalog);
    await service.checkPublication(job);
    return Response.json({ status: job.status, checkedAssets: job.publicationVerifiedAssets });
  } catch (error) { return Response.json({ code: error.code || 'runtime_error', diagnostic: error.diagnostic || null }, { status: error.status || 500 }); }
} };
`;

test('real workerd accepts model/Pages GET/asset HEAD options, and never follows redirects with API credentials', async () => {
  const bundle = await build({ stdin: { contents: source, resolveDir: fileURLToPath(new URL('..', import.meta.url)), sourcefile: 'runtime-fixture.js' }, bundle: true, write: false, format: 'esm', platform: 'neutral', keepNames: true });
  let redirect = null; const calls = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-09-20', script: bundle.outputFiles[0].text, outboundService: async request => {
    const url = new URL(request.url); calls.push({ host: url.host, path: url.pathname, method: request.method });
    if (url.host === 'api.anthropic.com') {
      assert.equal(request.headers.get('x-api-key'), 'fake-runtime-test-key');
      if (redirect === 'model') return new Response(null, { status: 302, headers: { Location: 'https://forbidden.example.test/models' } });
      return Response.json({ data: [{ id: 'claude-fable-5', display_name: 'Fable 5', created_at: '2026-04-01T00:00:00Z' }, { id: 'claude-fable-5-1', display_name: 'Fable 5.1', created_at: '2026-08-28T00:00:00Z' }], has_more: false });
    }
    assert.equal(url.host, 'example.github.io', 'unexpected host or followed redirect');
    assert.equal(request.headers.get('x-api-key'), null);
    if ((redirect === 'catalog' && request.method === 'GET') || (redirect === 'asset' && request.method === 'HEAD')) return new Response(null, { status: 302, headers: { Location: 'https://forbidden.example.test/asset' } });
    return request.method === 'HEAD' ? new Response(null, { status: 200 }) : Response.json(catalog);
  } }));
  try {
    const modelResponse = await mf.dispatchFetch('https://worker.example.test/model'); assert.equal(modelResponse.status, 200); assert.equal((await modelResponse.json()).model.id, 'claude-fable-5-1');
    redirect = 'model'; const rejected = await mf.dispatchFetch('https://worker.example.test/model'); assert.equal(rejected.status, 503); assert.equal((await rejected.json()).diagnostic, 'models_http_302');
    redirect = null; const publication = await mf.dispatchFetch('https://worker.example.test/publication'); assert.deepEqual(await publication.json(), { status: 'completed', checkedAssets: 1 });
    for (const target of ['catalog', 'asset']) { redirect = target; const pending = await mf.dispatchFetch('https://worker.example.test/publication'); assert.equal((await pending.json()).status, 'publishing'); }
    assert(calls.some(call => call.method === 'HEAD')); assert(!calls.some(call => call.host === 'forbidden.example.test'));
  } finally { await mf.dispose(); }
});

test('real SQLite Durable Object scans 28 subfolders and persists both zero and chunked candidate snapshots', async () => {
  const code = `
    import {StudioState} from './src/studio.js';
    export class RuntimeState extends StudioState {
      constructor(ctx, env) {
        super(ctx, env);
        this.access = {accessToken:'fake-access', expires:Date.now()+3600000};
        this.sapixImport.catalog = async () => ({schemaVersion:1,sources:[],problems:[]});
        this.sapixImport.model = async () => ({id:'claude-fable-5-1',name:'Fable'});
      }
      async fetch(request) {
        try { const result=await this.sapixImport.scan(); return Response.json({count:result.files.length,scanIdValid:result.scanId.length===36}); }
        catch(error) { return Response.json({code:error.code||'runtime_error',diagnostic:error.diagnostic||null},{status:error.status||500}); }
      }
    }
    export default {fetch(request,env) { return env.STUDIO.get(env.STUDIO.idFromName('owner')).fetch(request); }};
  `;
  const bundle = await build({ stdin: { contents: code, resolveDir: fileURLToPath(new URL('..', import.meta.url)), sourcefile: 'runtime-scan.js' }, bundle: true, write: false, format: 'esm', platform: 'neutral' });
  let calls = 0, countPerFolder = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-09-20', script: bundle.outputFiles[0].text, durableObjects: { STUDIO: { className: 'RuntimeState', useSQLite: true } }, outboundService: async request => {
    calls++; const url = new URL(request.url); assert.equal(url.host, 'www.googleapis.com');
    const parents = [...url.searchParams.get('q').matchAll(/'([^']+)' in parents/g)].map(match => match[1]);
    assert(parents.length <= 20);
    const root = parents.includes('1f1AhUw8Yciyye8V1_eZbvTBGlpQU0EyO');
    return Response.json({ files: root ? Array.from({ length: 28 }, (_, index) => ({ id: 'unit-' + index, name: 'unit-' + index, mimeType: 'application/vnd.google-apps.folder', parents: [parents[0]] })) : parents.flatMap(parent => Array.from({ length: countPerFolder }, (_, index) => ({ id: 'file-' + parent + '-' + index, name: 'test.pdf', mimeType: 'application/pdf', size: '200', md5Checksum: 'a'.repeat(32), createdTime: '2026-09-24T00:00:00Z', modifiedTime: '2026-09-24T00:00:00Z', parents: [parent] }))) });
  } }));
  try {
    for (const size of [0, 20]) {
      countPerFolder = size; const response = await mf.dispatchFetch('https://worker.example.test/scan');
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { count: 28 * size, scanIdValid: true });
    }
    assert.equal(calls, 6, '28 sibling folders are fetched in two grouped requests per scan');
  } finally { await mf.dispose(); }
});
