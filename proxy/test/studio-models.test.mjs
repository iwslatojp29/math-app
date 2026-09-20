import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCatalog } from '../src/studio-models.js';

const CATALOG = 'https://developers.openai.com/api/docs/models.md';
const API = 'https://api.openai.com/v1/models';
const KEY = 'fake-test-key-not-a-secret';
const catalog = (latest = 'gpt-6-astra', others = ['gpt-5.6-sol']) => `# Models
If you're not sure where to start, use [GPT latest](/api/docs/models/${latest}), our flagship model for complex reasoning and coding.
All latest OpenAI models support text and image input, text output, multilingual capabilities, and vision.
## Featured models
${[latest, ...others].map(id => `- [${id}](/api/docs/models/${id}.md): A general-purpose model`).join('\n')}
`;
const modelDoc = (id, input = 'text, image', support = 'Supported', maxOutput = '128,000', structured = true) => `# ${id}
Model ID: \`${id}\`
## Model details
- Input modalities: ${input}
- Output modalities: text
- ${maxOutput} max output tokens
## Features
${structured ? '- structured_outputs' : '- streaming'}
## Endpoints
| Endpoint | Route | Support |
| --- | --- | --- |
| Responses | \`v1/responses\` | ${support} |
`;

function mock({ markdown = catalog(), ids = ['gpt-6-astra', 'gpt-5.6-sol'], docs = {}, apiStatus = 200, docsStatus = 200 } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === API) return new Response(JSON.stringify({ data: ids.map(id => typeof id === 'string' ? { id, created: 1 } : id) }), { status: apiStatus });
      assert.equal(options.headers.Authorization, undefined, 'key must never be sent to documentation hosts');
      assert.equal(options.redirect, 'manual');
      if (url === CATALOG) return new Response(markdown, { status: docsStatus });
      const id = url.match(/\/([^/]+)\.md$/)?.[1];
      return new Response(docs[id] ?? modelDoc(id));
    },
  };
}

test('resolves the live official recommendation and validates selectable models', async () => {
  const upstream = mock();
  const result = await fetchCatalog({ apiKey: KEY, fetchImpl: upstream.fetchImpl });
  assert.equal(result.defaultModel, 'gpt-6-astra');
  assert.equal(result.latestVerified, true);
  assert.equal(result.verifiedAt, result.checkedAt);
  assert.deepEqual(result.models.map(model => model.id), ['gpt-6-astra', 'gpt-5.6-sol']);
  assert.equal(upstream.calls.find(call => call.url === API).options.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('a future flagship is discovered from live markup without a static priority list', async () => {
  const upstream = mock({ markdown: catalog('gpt-7-nova', ['gpt-6-astra']), ids: [
    { id: 'gpt-6-astra', created: 9999999999 }, { id: 'gpt-7-nova', created: 1 },
  ] });
  const result = await fetchCatalog({ apiKey: KEY, fetchImpl: upstream.fetchImpl });
  assert.equal(result.defaultModel, 'gpt-7-nova');
  assert.equal(result.latestVerified, true);
});

test('filters specialized, text-only, unavailable, and unsupported Responses models', async () => {
  const ids = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-cyber', 'gpt-4o-audio-preview', 'gpt-4o-realtime-preview',
    'gpt-5-codex', 'gpt-5-chat-latest', 'gpt-image-2', 'text-embedding-3-large', 'gpt-4', 'gpt-3.5-turbo', 'gpt-5.5'];
  const upstream = mock({ markdown: catalog('gpt-6-astra', ids.slice(1)), ids: ids.filter(id => id !== 'gpt-5.5'), docs: {
    'gpt-4': modelDoc('gpt-4', 'text'), 'gpt-3.5-turbo': modelDoc('gpt-3.5-turbo', 'text, image', 'Not supported'),
  } });
  const result = await fetchCatalog({ apiKey: KEY, fetchImpl: upstream.fetchImpl });
  assert.deepEqual(result.models.map(model => model.id), ['gpt-6-astra', 'gpt-5.6-sol']);
  assert.equal(upstream.calls.some(call => call.url.includes('cyber.md')), false);
});

test('an unavailable official latest is not silently replaced with an older model', async () => {
  const upstream = mock({ ids: ['gpt-5.6-sol'] });
  const result = await fetchCatalog({ apiKey: KEY, fetchImpl: upstream.fetchImpl });
  assert.equal(result.defaultModel, null);
  assert.equal(result.latestVerified, false);
  assert.deepEqual(result.models.map(model => model.id), ['gpt-5.6-sol']);
  assert.match(result.warning, /利用できません/);
});

test('requires explicit structured outputs and enough output tokens for a lesson', async () => {
  const ids = ['gpt-6-astra', 'gpt-4-turbo', 'gpt-4o', 'gpt-5.5', 'gpt-5.4', 'gpt-5.2', 'gpt-5.1'];
  const upstream = mock({ ids, markdown: catalog('gpt-6-astra', ids.slice(1)), docs: {
    'gpt-4-turbo': modelDoc('gpt-4-turbo', 'text, image', 'Supported', '4,096', false),
    'gpt-4o': modelDoc('gpt-4o', 'text, image', 'Supported', '16,384'),
    'gpt-5.5': modelDoc('gpt-5.5', 'text, image', 'Supported', '128,000', false),
    'gpt-5.4': modelDoc('gpt-5.4', 'text, image', 'Supported', 'unknown'),
    'gpt-5.2': modelDoc('gpt-5.2', 'text, image', 'Supported', '27,999'),
    'gpt-5.1': modelDoc('gpt-5.1', 'text, image', 'Supported', '28000'),
  } });
  const result = await fetchCatalog({ apiKey: KEY, fetchImpl: upstream.fetchImpl });
  assert.deepEqual(result.models.map(model => model.id), ['gpt-6-astra', 'gpt-5.1']);
  assert.equal(result.defaultModel, 'gpt-6-astra');
  assert.equal(result.latestVerified, true);
});

test('an unsuitable official recommendation never becomes the default', async () => {
  for (const document of [
    modelDoc('gpt-6-astra', 'text, image', 'Supported', '28,,000'),
    modelDoc('gpt-6-astra').replace('- structured_outputs', '- structured_outputs_not_supported'),
    modelDoc('gpt-6-astra').replace('- 128,000 max output tokens', '- 1,050,000 context window'),
  ]) {
    const upstream = mock({ docs: { 'gpt-6-astra': document } });
    const result = await fetchCatalog({ apiKey: KEY, fetchImpl: upstream.fetchImpl });
    assert.equal(result.defaultModel, null);
    assert.equal(result.latestVerified, false);
    assert.equal(result.diagnosticReason, 'model_docs_unsupported');
    assert.deepEqual(result.models.map(model => model.id), ['gpt-5.6-sol']);
  }
});

test('changed recommendation markup does not invent latest from ordering', async () => {
  const upstream = mock({ markdown: catalog().replace('our flagship model', 'a useful model') });
  const result = await fetchCatalog({ apiKey: KEY, fetchImpl: upstream.fetchImpl });
  assert.equal(result.defaultModel, null);
  assert.equal(result.latestVerified, false);
  assert.equal(result.models.length, 2);
});

test('failed official fetch uses timestamped cache intersected with live availability', async () => {
  const previous = { defaultModel: 'gpt-6-astra', latestVerified: true, checkedAt: '2026-09-01T00:00:00.000Z',
    models: [{ id: 'gpt-6-astra', label: 'Latest confirmed' }, { id: 'gpt-5.6-sol', label: 'Sol' }] };
  const upstream = mock({ docsStatus: 503, ids: ['gpt-6-astra'] });
  const result = await fetchCatalog({ apiKey: KEY, previous, fetchImpl: upstream.fetchImpl });
  assert.equal(result.defaultModel, 'gpt-6-astra');
  assert.equal(result.latestVerified, false);
  assert.equal(result.verifiedAt, previous.checkedAt);
  assert.deepEqual(result.models, [{ id: 'gpt-6-astra', label: 'gpt-6-astra' }]);
  assert.match(result.warning, /前回/);
  assert.equal(result.diagnosticReason, 'catalog_http_503');
});

test('API failure never reuses stale availability or returns upstream errors', async () => {
  const upstream = mock({ apiStatus: 401 });
  const result = await fetchCatalog({ apiKey: KEY, fetchImpl: upstream.fetchImpl,
    previous: { latestVerified: true, checkedAt: new Date().toISOString(), defaultModel: 'gpt-6-astra', models: [{ id: 'gpt-6-astra' }] } });
  assert.equal(result.defaultModel, null);
  assert.deepEqual(result.models, []);
  assert.equal(result.latestVerified, false);
  assert.equal(result.diagnosticReason, 'api_http_401');
  const thrown = await fetchCatalog({ apiKey: KEY, fetchImpl: () => { throw new Error(`secret ${KEY}`); } });
  assert.equal(JSON.stringify(thrown).includes(KEY), false);
  assert.equal(thrown.diagnosticReason, 'api_network');
});

test('capability markup mismatch fails closed and shutdown models are omitted', async () => {
  const upstream = mock({ ids: ['gpt-6-astra', { id: 'gpt-5.6-sol', shutdown_date: '2000-01-01' }], docs: {
    'gpt-6-astra': modelDoc('gpt-unrelated'),
  } });
  const result = await fetchCatalog({ apiKey: KEY, fetchImpl: upstream.fetchImpl });
  assert.equal(result.latestVerified, false);
  assert.deepEqual(result.models, []);
  assert.equal(result.diagnosticReason, 'model_docs_unsupported');
});

test('redirects and API errors expose only status codes and are never followed', async () => {
  for (const status of [301, 302, 307, 403, 429, 500]) {
    let apiRequests = 0;
    const result = await fetchCatalog({ apiKey: KEY, fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'manual');
      if (url !== API) return new Response(catalog());
      apiRequests++;
      return new Response(`upstream secret ${KEY}`, { status, headers: { Location: `https://example.invalid/${KEY}` } });
    } });
    assert.equal(result.diagnosticReason, `api_http_${status}`);
    assert.equal(apiRequests, 1);
    assert.deepEqual(result.models, []);
    assert.equal(result.latestVerified, false);
    assert.equal(JSON.stringify(result).includes(KEY), false);
    assert.equal(JSON.stringify(result).includes('example.invalid'), false);
  }
});

test('invalid API responses and failed model-document requests have sanitized diagnostics', async () => {
  const invalid = await fetchCatalog({ apiKey: KEY, fetchImpl: async url => new Response(url === API ? `invalid ${KEY}` : catalog()) });
  assert.equal(invalid.diagnosticReason, 'api_invalid_response');
  assert.equal(JSON.stringify(invalid).includes(KEY), false);
  const upstream = mock();
  const failed = await fetchCatalog({ apiKey: KEY, fetchImpl: async (url, options) => {
    if (url.endsWith('/gpt-6-astra.md')) throw new Error(`headers: Bearer ${KEY}`);
    return upstream.fetchImpl(url, options);
  } });
  assert.equal(failed.diagnosticReason, 'model_docs_network');
  assert.equal(failed.latestVerified, false);
  assert.equal(failed.defaultModel, null);
  assert.deepEqual(failed.models.map(model => model.id), ['gpt-5.6-sol']);
  assert.equal(JSON.stringify(failed).includes(KEY), false);
});

test('all requests have a bounded total deadline even if fetch ignores abort', async () => {
  const result = await fetchCatalog({ apiKey: KEY, timeoutMs: 15, fetchImpl: () => new Promise(() => {}) });
  assert.equal(result.latestVerified, false);
  assert.equal(result.defaultModel, null);
  assert.deepEqual(result.models, []);
  assert.equal(result.diagnosticReason, 'api_timeout');
});

test('caps outbound requests while keeping the official latest candidate first', async () => {
  const ids = Array.from({ length: 45 }, (_, n) => `gpt-5.${n}`);
  const upstream = mock({ markdown: catalog('gpt-7-nova', ids), ids: [...ids, 'gpt-7-nova'] });
  const result = await fetchCatalog({ apiKey: KEY, fetchImpl: upstream.fetchImpl });
  assert.equal(result.defaultModel, 'gpt-7-nova');
  assert.equal(result.models.length, 32);
  assert.equal(upstream.calls.length, 34);
  assert.match(result.warning, /一部/);
});
