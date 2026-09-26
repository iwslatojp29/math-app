const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../math/upload.html'), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const client = fs.readFileSync(path.join(__dirname, '../shared/proxy-client.js'), 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.style = {}; this.attributes = new Map();
    this.listeners = {}; this.value = ''; this.disabled = false; this.hidden = false; this.srcdoc = '';
    this.classList = {add() {}, remove() {}};
  }
  addEventListener(name, action) { this.listeners[name] = action; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  focus() { this.focused = true; }
  get textContent() { return this._text || this.children.map(child => child.textContent).join(' '); }
  set textContent(value) { this._text = String(value); this.children = []; }
}

function harness(responses = []) {
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement(tag) { return new Element(tag); },
  };
  const calls = [];
  const context = vm.createContext({document, TextEncoder, TextDecoder, Uint8Array, Set, console,
    window: {}, btoa: text => Buffer.from(text, 'binary').toString('base64'),
    fetch: async (url, init) => {
      calls.push({url, ...init, json: JSON.parse(init.body)});
      const next = responses.shift() || {status: 200, label: '解答解説'};
      if (next.wait) await next.wait;
      return {ok: next.status === 200, status: next.status,
        json: async () => ({ok: true, label: next.label})};
    },
  });
  vm.runInContext(client, context);
  context.MathAppProxy = context.window.MathAppProxy;
  vm.runInContext(script, context);
  // UI transport tests do not emulate an HTML parser; preview isolation is
  // exercised separately through the attribute policy and real DOM traversal.
  vm.runInContext('previewMarkup = text => "STATIC PREVIEW";', context);
  return {context, calls, elements, get: id => document.getElementById(id),
    run: code => vm.runInContext(code, context)};
}

function file(name = '解説.html', text = '<!doctype html><html><body><h1>3 × 4 = 12</h1><script>playAnimation()</script></body></html>') {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return {name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)};
}

async function select(h, files) {
  h.get('pw-input').value ||= 'test-memory-only';
  h.context.files = files;
  await h.run('handleFiles(files)');
}

test('file selection sends nothing; explicit publish retains scripts and adds the established return link once', async () => {
  const h = harness();
  const source = file();
  await select(h, [source]);
  assert.equal(h.calls.length, 0);
  assert.equal(h.get('publish-btn').disabled, false);
  assert.equal(h.get('review-panel').hidden, false);
  assert.match(h.get('preview-title').textContent, /解説.html/);
  await h.run('publishFiles()');
  assert.equal(h.calls.length, 1);
  const saved = Buffer.from(h.calls[0].json.contentBase64, 'base64').toString('utf8');
  assert.equal(saved, h.run('injectBackLink')('<!doctype html><html><body><h1>3 × 4 = 12</h1><script>playAnimation()</script></body></html>'));
  assert.match(saved, /<script>playAnimation\(\)<\/script>/);
  assert.equal((saved.match(/コンテンツ一覧へ戻る/g) || []).length, 1);
  assert.equal(h.calls[0].json.folder, 'math');
  assert.equal(h.calls[0].headers.Authorization, 'Bearer test-memory-only');
  assert.equal(h.calls[0].credentials, 'omit');
  assert.equal(h.get('publish-btn').disabled, true);
  await h.run('publishFiles()');
  assert.equal(h.calls.length, 1, 'completed files are not uploaded again');
});

test('multiple files preview individually and publish once each; filenames and API labels remain text', async () => {
  const h = harness([{status: 200, label: '<img src=x onerror=alert(1)>'}, {status: 200, label: '二つ目'}]);
  await select(h, [file('<img onerror=alert(1)>.html'), file('二つ目.html')]);
  h.run('showPreview(entries[1])');
  assert.match(h.get('preview-title').textContent, /二つ目.html/);
  assert.equal(h.calls.length, 0);
  await h.run('publishFiles()');
  assert.equal(h.calls.length, 2);
  assert.match(h.get('status-list').textContent, /<img src=x onerror=alert\(1\)>/);
  const row = h.get('status-list').children[0].children[1];
  assert.ok(row.children.every(child => child.tag === 'span'));
  assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie/);
});

test('invalid UTF-8, plain text, markdown wrappers, reserved names and duplicate selections cannot upload', async () => {
  const h = harness();
  await select(h, [file('bad.html', new Uint8Array([0xff, 0xfe])), file('plain.html', 'answer is 12'),
    file('fenced.html', '```html\n<html><body>12</body></html>\n```'), file('index.html'),
    file('../outside.html'), file('ok.html'), file('ok.html')]);
  assert.equal(h.run('entries.filter(e => e.html !== undefined).length'), 1);
  assert.match(h.get('status-list').textContent, /UTF-8/);
  assert.match(h.get('status-list').textContent, /完全なHTML/);
  await h.run('publishFiles()');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].json.filename, 'ok.html');
});

test('complete HTML may retain trailing comments, but trailing prose and unfinished comments are rejected', async () => {
  const h = harness();
  const source = '<!doctype html><html><body>解説</body></html>\n<!-- Chatで作成 -->\n<!-- 保存版 -->\n';
  assert.equal(h.run('basicHtml')(source), true);
  assert.equal(h.run('basicHtml')('<html><body>解説</body></html>余分な説明'), false);
  assert.equal(h.run('basicHtml')('<html><body>解説</body></html><!-- incomplete'), false);
  await select(h, [file('comments.html', source)]);
  assert.equal(h.calls.length, 0);
  await h.run('publishFiles()');
  assert.equal(Buffer.from(h.calls[0].json.contentBase64, 'base64').toString('utf8'), h.run('injectBackLink')(source));
});

test('size is checked before reading and again after UTF-8 return-link insertion; original BOM survives', async () => {
  const h = harness();
  let reads = 0;
  const oversized = {name: 'huge.html', size: 10 * 1024 * 1024 + 1, arrayBuffer() { reads++; throw new Error('must not read'); }};
  const prefix = '<html><body>', suffix = '</body></html>';
  const boundary = file('boundary.html', prefix + 'x'.repeat(10 * 1024 * 1024 - prefix.length - suffix.length) + suffix);
  await select(h, [oversized, boundary]);
  assert.equal(reads, 0);
  assert.equal(h.get('publish-btn').disabled, true);
  assert.equal(h.run('entries.filter(e => e.html !== undefined).length'), 0);
  await select(h, [file('bom.html', '\uFEFF<html><body>算数</body></html>')]);
  await h.run('publishFiles()');
  assert.equal(Buffer.from(h.calls[0].json.contentBase64, 'base64').subarray(0, 3).toString('hex'), 'efbbbf');
});

test('failed authentication stops the batch; explicit retry resumes only unfinished files', async () => {
  const h = harness([{status: 200, label: 'a'}, {status: 401}, {status: 200, label: 'b'}, {status: 200, label: 'c'}]);
  await select(h, [file('a.html'), file('b.html'), file('c.html')]);
  await h.run('publishFiles()');
  assert.equal(h.calls.length, 2);
  assert.equal(h.get('pw-input').focused, true);
  h.get('pw-input').value = 'corrected-memory-only';
  await h.run('publishFiles()');
  assert.deepEqual(h.calls.map(call => call.json.filename), ['a.html', 'b.html', 'b.html', 'c.html']);
  assert.equal(h.calls[2].headers.Authorization, 'Bearer corrected-memory-only');
});

test('repeated publish while a request is pending cannot duplicate a write', async () => {
  let resolve;
  const wait = new Promise(done => { resolve = done; });
  const h = harness([{status: 200, label: 'one', wait}]);
  await select(h, [file()]);
  const first = h.run('publishFiles()');
  await h.run('publishFiles()');
  assert.equal(h.calls.length, 1);
  assert.equal(h.get('file-input').disabled, true);
  resolve(); await first;
  assert.equal(h.calls.length, 1);
});

test('preview isolation blocks active elements, navigation attributes and remote resource sources', () => {
  const h = harness();
  assert.match(html, /<iframe[^>]+sandbox="allow-same-origin"[^>]+referrerpolicy="no-referrer"/);
  const sandbox = html.match(/<iframe[^>]+sandbox="([^"]*)"/)[1].trim().split(/\s+/);
  assert.deepEqual(sandbox, ['allow-same-origin']);
  assert.ok(!sandbox.includes('allow-scripts'), 'same-origin must never be combined with script execution');
  const allowed = h.run('previewAttributeAllowed');
  for (const [tag, name, value] of [['a','href','https://example.test/leak'], ['a','href','#fragment'],
    ['img','src','https://example.test/leak'], ['img','srcset','https://example.test/leak 2x'],
    ['svg','onload','alert(1)'], ['button','formaction','https://example.test/leak'],
    ['div','srcdoc','<script>bad()</script>'], ['a','ping','https://example.test/leak'], ['input','autofocus','']]) {
    assert.equal(allowed(tag, name, value), false, `${tag}.${name}`);
  }
  assert.equal(allowed('img', 'src', 'data:image/png;base64,AA=='), true);
  assert.equal(allowed('use', 'href', '#triangle'), true);
  for (const tag of ['script','iframe','object','embed','meta','base','link','form','animate','set','foreignobject','template']) {
    h.context.tag = tag;
    assert.equal(h.run('PREVIEW_TAGS.has(tag)'), false, tag);
  }
  const csp = h.run('PREVIEW_CSP');
  for (const directive of ["default-src 'none'", "script-src 'none'", "connect-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(directive));
  assert.doesNotMatch(csp, /https?:|\*|unsafe-eval/);
  assert.match(html, /静的プレビュー/);
  assert.match(html, /Chatのプレビューまたは保存したHTML/);
});

test('actual sanitizer removes active nodes and forbidden attributes without editing upload HTML', () => {
  const elements = [
    {localName: 'script', attributes: []}, {localName: 'meta', attributes: [{name: 'http-equiv', value: 'refresh'}]},
    {localName: 'a', attributes: [{name: 'href', value: 'https://example.test/leak'}, {name: 'style', value: 'color:red'}]},
    {localName: 'img', attributes: [{name: 'src', value: 'https://example.test/leak'}, {name: 'onerror', value: 'bad()'}]},
    {localName: 'button', attributes: []},
  ].map(item => ({...item, remove() { this.removed = true; }, removeAttribute(name) { this.attributes = this.attributes.filter(a => a.name !== name); },
    setAttribute(name, value) { this.attributes.push({name, value}); }}));
  let source;
  const template = {content: {querySelectorAll: () => elements},
    set innerHTML(text) { source = text; },
    get innerHTML() { return elements.filter(item => !item.removed).map(item => `<${item.localName}${item.attributes.map(a => ` ${a.name}="${a.value}"`).join('')}></${item.localName}>`).join(''); }};
  const h = harness();
  h.context.document.createElement = tag => { assert.equal(tag, 'template'); return template; };
  const actual = script.slice(script.indexOf('function previewMarkup('), script.indexOf('\nfunction showPreview('));
  vm.runInContext(actual, h.context);
  const result = h.run('previewMarkup("<html><body>original input</body></html>")');
  assert.equal(source, '<html><body>original input</body></html>');
  assert.match(result, /^<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy"/);
  assert.doesNotMatch(result, /example\.test|onerror|<script|http-equiv="refresh"/);
  assert.match(result, /<a style="color:red">/);
  assert.match(result, /<button disabled="">/);
});
