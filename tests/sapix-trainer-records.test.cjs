const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Sync = require('../sapix/record-sync.js');
const crypto = require('node:crypto').webcrypto;

const html = fs.readFileSync(path.join(__dirname, '../sapix/sapix_sansu_trainer.html'), 'utf8');
const recordKey = Sync.recordsKey;
const plain = value => JSON.parse(JSON.stringify(value));
const savedRecords = h => plain(boot({ stored: h.stored }).ctx.state.records);

// Run the real standalone-page functions, with only browser surfaces stubbed.
// Top-level function closing braces in this page start at column zero.
function sourceOf(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `production function ${name} exists`);
  const rest = html.slice(start);
  const first = rest.slice(0, rest.indexOf('\n')).trimEnd();
  if (first.endsWith('}')) return first;
  const end = /^}/m.exec(rest);
  assert.ok(end, `production function ${name} closes`);
  return rest.slice(0, end.index + 1);
}

function boot({ stored = new Map(), failRead = false } = {}) {
  const nodes = new Map();
  function node(id) {
    const attrs = new Map();
    const el = { id, hidden: false, innerHTML: '', textContent: '', value: '', disabled: false,
      classList: { add() {}, remove() {} },
      setAttribute(k, v) { attrs.set(k, v); }, getAttribute(k) { return attrs.get(k); },
      appendChild(child) { nodes.set(child.id, child); }, remove() { nodes.delete(this.id); }
    };
    nodes.set(id, el);
    return el;
  }
  ['hist', 'recorded', 'recordError', 'nextBtn', 'prevBtn', 'main', 'modal', 'modalText', 'modalTa'].forEach(node);
  nodes.get('recorded').hidden = true;
  nodes.get('recordError').hidden = true;
  nodes.get('modal').hidden = true;
  const buttons = ['o', 't', 'x'].map(r => {
    const b = node(`mark-${r}`);
    b.dataset = { r };
    b.setAttribute('data-r', r);
    b.setAttribute('aria-pressed', 'false');
    b.listeners = [];
    b.addEventListener = (type, fn) => b.listeners.push({ type, fn });
    return b;
  });
  const content = { innerHTML: '', querySelectorAll: () => buttons };
  const h = { stored, nodes, buttons, writes: 0, failWrite: false, modal: null, messages: [], renderCount: 0 };
  // A local calendar date that differs from the UTC date catches accidental UTC recording.
  class LocalDate extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-09-25T15:05:00Z'])); }
    getFullYear() { return 2026; }
    getMonth() { return 8; }
    getDate() { return 26; }
  }
  const ctx = vm.createContext({
    Date: LocalDate,
    localStorage: {
      getItem(k) { if (failRead) throw Error('blocked'); return stored.get(k) ?? null; },
      setItem(k, v) { h.writes++; if (h.failWrite) throw Error('quota'); stored.set(k, v); },
      removeItem(k) { stored.delete(k); }
    },
    document: { querySelectorAll: () => buttons, createElement: () => node('') },
    $: id => nodes.get(id), $content: content,
    PROBLEMS: [{ id: 'p1', no: 1, src: 'fixture', body: '問題' }, { id: 'p2' }],
    T: { over: false }, elapsedSec: () => 12.4,
    toast: message => h.messages.push(message),
    renderSide() {}, renderTop() {}, ensureSelection() {},
    renderProblem() { h.renderCount++; },
    figureHtml: () => '', visible: () => ctx.PROBLEMS, timerInit() {},
    ICON_PAUSE: '', ICON_RESET: '',
    showModal(options) { h.modal = options; nodes.get('modal').hidden = false; nodes.get('modalTa').value = options.value || ''; },
    hideModal() { nodes.get('modal').hidden = true; }
  });
  ctx.SapixRecordSync = { create: options => Sync.create({ ...options, storage: ctx.localStorage, crypto, setTimeout: () => 1, clearTimeout() {} }) };
  ctx.recordStore = null;
  ctx.syncReady = false;
  ctx.refreshSyncedRecords = records => { ctx.state.records = records; };
  ctx.renderCloudStatus = () => {};
  const declarations = ['LS_REC', 'state', 'MARK', 'MARK_CAP'].map(name => {
    const match = html.match(new RegExp(`^var ${name} = .+$`, 'm'));
    assert.ok(match, `${name} exists`);
    return match[0];
  });
  const functions = ['loadAll', 'validRecordDate', 'validateRecordMap', 'copyRecords', 'recordsError',
    'saveRecords', 'recs', 'latest', 'countOf', 'current', 'todayISO', 'fmtDate', 'fmtSec',
    'historyHtml', 'record', 'undoRecord', 'mergeRecords', 'importRecords', 'clearRecords',
    'exportRecords', 'mk', 'esc'];
  vm.runInContext([...declarations, ...functions.map(sourceOf)].join('\n'), ctx);
  ctx.loadAll();
  h.writes = 0;
  ctx.state.pid = 'p1';
  ctx.state.revealed = true;
  h.ctx = ctx;
  h.clickAction = label => h.modal.actions.find(a => a.label === label).fn();
  h.import = data => { ctx.importRecords(); nodes.get('modalTa').value = typeof data === 'string' ? data : JSON.stringify(data); h.clickAction('読み込む'); };
  return h;
}

test('every inline script compiles', () => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length);
  for (const script of scripts) new vm.Script(script[1]);
});

for (const mark of ['o', 't', 'x']) {
  test(`${mark} saves to the atomic v2 envelope and survives a fresh load with the local date`, () => {
    const h = boot();
    h.ctx.record(mark);
    const expected = { p1: [{ d: '2026-09-26', r: mark, s: 12 }] };
    assert.deepEqual(savedRecords(h), expected);
    assert.equal(JSON.parse(h.stored.get(recordKey)).outbox.length, 1);
    assert.deepEqual(plain(boot({ stored: h.stored }).ctx.state.records), expected);
    assert.equal(h.nodes.get('recorded').hidden, false);
    assert.match(h.nodes.get('recorded').innerHTML, /2026\/9\/26/);
    assert.equal(h.buttons.find(b => b.dataset.r === mark).getAttribute('aria-pressed'), 'true');
  });
}

test('correction replaces only this attempt, another visit appends, and undo persists', () => {
  const h = boot();
  h.ctx.record('x');
  h.ctx.record('t');
  h.ctx.record('o');
  assert.equal(h.ctx.recs('p1').length, 1);
  assert.equal(h.ctx.latest('p1'), 'o');
  h.ctx.state.justRecorded = null;
  h.ctx.record('x');
  assert.equal(h.ctx.recs('p1').length, 2);
  h.ctx.undoRecord();
  assert.equal(h.ctx.state.justRecorded, null);
  assert.deepEqual(plain(boot({ stored: h.stored }).ctx.recs('p1')), [{ d: '2026-09-26', r: 'o', s: 12 }]);
  assert.equal(h.nodes.get('recorded').hidden, true);
});

test('unrevealed or invalid marks never write', () => {
  const h = boot();
  h.ctx.state.revealed = false;
  h.ctx.record('o');
  h.ctx.state.revealed = true;
  for (const mark of [undefined, null, {}, 'invalid', 'toString', '__proto__']) h.ctx.record(mark);
  assert.equal(h.writes, 0);
  assert.deepEqual(plain(h.ctx.state.records), {});
});

test('failed first save leaves no fake record or success and retry clears the persistent error', () => {
  const h = boot();
  h.failWrite = true;
  h.ctx.record('o');
  assert.deepEqual(savedRecords(h), {});
  assert.deepEqual(plain(h.ctx.state.records), {});
  assert.equal(h.ctx.state.justRecorded, null);
  assert.equal(h.nodes.get('recorded').hidden, true);
  assert.equal(h.nodes.get('recordError').hidden, false);
  assert.match(h.nodes.get('recordError').textContent, /保存できません/);
  h.failWrite = false;
  h.ctx.record('o');
  assert.equal(h.ctx.recs('p1').length, 1);
  assert.equal(h.ctx.state.recordsError, '');
  assert.equal(h.nodes.get('recordError').hidden, true);
});

test('failed correction and undo preserve bytes, state, selected mark, and undo position', () => {
  const h = boot();
  h.ctx.record('x');
  const before = h.stored.get(recordKey), beforeUi = h.nodes.get('recorded').innerHTML;
  const beforeRecords = plain(h.ctx.state.records), beforeId = h.ctx.state.justRecorded;
  h.failWrite = true;
  for (const action of [() => h.ctx.record('o'), () => h.ctx.undoRecord()]) {
    action();
    assert.equal(h.stored.get(recordKey), before);
    assert.deepEqual(plain(h.ctx.state.records), beforeRecords);
    assert.equal(h.ctx.state.justRecorded, beforeId);
    assert.equal(h.nodes.get('recorded').innerHTML, beforeUi);
    assert.equal(h.buttons[2].getAttribute('aria-pressed'), 'true');
  }
  h.failWrite = false;
  h.ctx.undoRecord();
  assert.deepEqual(plain(boot({ stored: h.stored }).ctx.state.records), {});
});

test('v1 and legacy raw imports merge, deduplicate, preserve existing rows, and round trip', () => {
  const h = boot();
  h.ctx.record('o');
  const data = { p1: [{ d: '2024-02-29', r: 't' }], p2: [{ d: '2026-09-25', r: 'x', s: null, over: true }] };
  h.import({ app: 'sapix-sansu', version: 1, records: data });
  h.import(data);
  const expected = { p1: [data.p1[0], { d: '2026-09-26', r: 'o', s: 12 }], p2: [{ d: '2026-09-25', r: 'x', over: true }] };
  assert.deepEqual(plain(boot({ stored: h.stored }).ctx.state.records), expected);
  h.ctx.exportRecords();
  assert.deepEqual(JSON.parse(h.modal.value).records, expected);
});

test('failed import keeps active records, input, and modal; a later successful retry saves', () => {
  const h = boot();
  h.ctx.record('o');
  const before = h.stored.get(recordKey);
  const beforeRecords = plain(h.ctx.state.records);
  const input = JSON.stringify({ p2: [{ d: '2026-09-25', r: 'x', s: 9 }] });
  h.failWrite = true;
  h.import(input);
  assert.equal(h.stored.get(recordKey), before);
  assert.deepEqual(plain(h.ctx.state.records), beforeRecords);
  assert.equal(h.nodes.get('modal').hidden, false);
  assert.equal(h.nodes.get('modalTa').value, input);
  assert.match(h.nodes.get('modalRecordError').textContent, /保存できません/);
  assert.equal(h.renderCount, 0);
  h.failWrite = false;
  h.clickAction('読み込む');
  assert.equal(h.nodes.get('modal').hidden, true);
  assert.equal(boot({ stored: h.stored }).ctx.recs('p2').length, 1);
});

test('invalid imports fail atomically, including calendar dates, marks, times, and versions', () => {
  const h = boot();
  h.ctx.record('o');
  const before = h.stored.get(recordKey);
  const beforeRecords = plain(h.ctx.state.records);
  const valid = { d: '2026-09-26', r: 'o', s: 2 };
  const badRows = [null, [], { ...valid, d: '2026-02-29' }, { ...valid, d: '2026-04-31' },
    { ...valid, d: '0000-01-01' }, { ...valid, r: 'toString' }, { ...valid, s: -1 },
    { ...valid, s: '2' }, { ...valid, over: 'false' }];
  const badInputs = ['{', 'null', '[]', { p2: 'bad' },
    { app: 'sapix-sansu', version: 2, records: { p2: [valid] } },
    { app: 'other', version: 1, records: { p2: [valid] } },
    ...badRows.map(row => ({ p2: [valid, row] }))];
  for (const input of badInputs) {
    h.import(input);
    assert.equal(h.stored.get(recordKey), before);
    assert.deepEqual(plain(h.ctx.state.records), beforeRecords);
    assert.equal(h.nodes.get('modal').hidden, false);
    assert.match(h.ctx.state.recordsError, /読み込めません/);
  }
  assert.equal(h.ctx.validateRecordMap({ p2: [{ ...valid, s: Infinity }] }).invalid, true);
});

test('clear failure preserves records and the confirmation modal; success survives reload', () => {
  const h = boot();
  h.ctx.record('t');
  const before = h.stored.get(recordKey);
  const beforeRecords = plain(h.ctx.state.records);
  h.failWrite = true;
  h.ctx.clearRecords();
  h.clickAction('消去する');
  assert.equal(h.stored.get(recordKey), before);
  assert.deepEqual(plain(h.ctx.state.records), beforeRecords);
  assert.equal(h.nodes.get('modal').hidden, false);
  assert.equal(h.renderCount, 0);
  h.failWrite = false;
  h.clickAction('消去する');
  assert.equal(h.nodes.get('modal').hidden, true);
  assert.deepEqual(plain(boot({ stored: h.stored }).ctx.state.records), {});
});

test('malformed saved data is not overwritten, valid rows remain readable, raw export is lossless', () => {
  const good = { d: '2026-09-24', r: 't', s: 8 };
  for (const raw of ['{unfinished', 'null', '[]', JSON.stringify({ p1: [good, { d: 'bad', r: 'x' }], p2: {} })]) {
    const h = boot({ stored: new Map([[Sync.legacyKey, raw]]) });
    assert.equal(h.ctx.state.recordsBlocked, true);
    if (raw.includes('p1')) {
      assert.deepEqual(plain(h.ctx.recs('p1')), [good]);
      assert.doesNotThrow(() => h.ctx.historyHtml('p1'));
    }
    h.ctx.record('o');
    assert.equal(h.writes, 0);
    assert.equal(h.stored.get(Sync.legacyKey), raw);
    h.ctx.exportRecords();
    assert.equal(h.modal.value, raw);
    h.ctx.clearRecords();
    h.clickAction('消去する');
    assert.equal(h.ctx.state.recordsBlocked, false);
    assert.deepEqual(plain(boot({ stored: h.stored }).ctx.state.records), {});
  }
});

test('storage read denial is visible and cannot overwrite unknown stored data', () => {
  const raw = JSON.stringify({ p2: [{ d: '2026-09-25', r: 'x', s: 10 }] });
  const h = boot({ stored: new Map([[recordKey, raw]]), failRead: true });
  h.ctx.record('o');
  assert.equal(h.ctx.state.recordsBlocked, true);
  assert.equal(h.writes, 0);
  assert.equal(h.stored.get(recordKey), raw);
  assert.equal(h.nodes.get('recordError').hidden, false);
});

test('rendered score buttons use their native currentTarget and do not depend on an SVG/text target', () => {
  const h = boot();
  vm.runInContext(sourceOf('renderProblem'), h.ctx);
  h.ctx.renderProblem();
  assert.match(h.ctx.$content.innerHTML, /type="button" class="mbtn"/);
  assert.match(h.ctx.$content.innerHTML, /id="recorded" role="status" aria-live="polite"/);
  h.ctx.state.revealed = true;
  const nestedTargets = [{ tagName: 'circle' }, { tagName: 'span' }, { nodeType: 3 }];
  h.buttons.forEach((button, i) => {
    assert.equal(button.listeners.length, 1);
    assert.equal(button.listeners[0].type, 'click');
    button.listeners[0].fn({ currentTarget: button, target: nestedTargets[i] });
    assert.equal(h.ctx.latest('p1'), button.dataset.r);
  });
  assert.equal(h.writes, 3);
  assert.equal(h.ctx.recs('p1').length, 1);
  const delegated = html.slice(html.indexOf("document.addEventListener('click'"), html.indexOf("$('scrim').addEventListener"));
  assert.doesNotMatch(delegated, /\bmbtn\b|\brecord\(/);
});
