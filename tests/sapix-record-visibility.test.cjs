const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../sapix/sapix_sansu_trainer.html'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

// Exercise the shipped page helpers, with browser surfaces and records isolated.
function sourceOf(name) {
  const match = new RegExp(`(?:async\\s+)?function ${name}\\(`).exec(html);
  assert.ok(match, `production function ${name} exists`);
  const source = html.slice(match.index);
  const first = source.slice(0, source.indexOf('\n')).trimEnd();
  if (first.endsWith('}')) return first;
  const end = /^}/m.exec(source);
  assert.ok(end, `production function ${name} closes`);
  return source.slice(0, end.index + 1);
}

function readOnly(value) {
  Object.values(value).forEach(item => { if (item && typeof item === 'object') readOnly(item); });
  return Object.freeze(value);
}

function recordFixture(records) {
  const context = vm.createContext({
    state: {records: readOnly(records)},
    fmtDate: date => date,
    fmtSec: seconds => `${seconds}秒`,
    mk: mark => `[${mark}]`
  });
  vm.runInContext(['recs', 'latest', 'recordSource', 'matchFilter', 'stripHtml', 'stripForProblem'].map(sourceOf).join('\n'), context);
  return context;
}

test('parent-only grades stay visible and filterable without creating child attempts', () => {
  const records = {parent: [{d: '2026-09-25', r: 'x', s: 91, over: true}]};
  const before = plain(records), ctx = recordFixture(records);
  const child = {id: 'parent::part:(1)', parentId: 'parent'};
  assert.equal(ctx.recordSource(child), 'parent');
  assert.equal(ctx.matchFilter(child, 'all'), true);
  assert.equal(ctx.matchFilter(child, 'recorded'), true);
  assert.equal(ctx.matchFilter(child, 'none'), false);
  assert.equal(ctx.matchFilter(child, 'x'), true);
  assert.equal(ctx.matchFilter(child, 't'), false);
  const strip = ctx.stripForProblem(child);
  assert.match(strip, /分割前/);
  assert.match(strip, /2026-09-25/);
  assert.match(strip, /\[x\]/);
  assert.deepEqual(records, before);
  assert.equal(Object.hasOwn(records, child.id), false);
});

test('a child grade takes precedence over its parent while ungraded siblings retain the old history', () => {
  const child = {id: 'parent::part:(1)', parentId: 'parent'};
  const sibling = {id: 'parent::part:(2)', parentId: 'parent'};
  const records = {parent: [{d: '2026-09-25', r: 'x'}], [child.id]: [{d: '2026-09-26', r: 't', s: 17}]};
  const before = plain(records), ctx = recordFixture(records);
  assert.equal(ctx.recordSource(child), child.id);
  assert.equal(ctx.matchFilter(child, 'recorded'), true);
  assert.equal(ctx.matchFilter(child, 't'), true);
  assert.equal(ctx.matchFilter(child, 'x'), false);
  assert.equal(ctx.matchFilter(child, 'none'), false);
  const strip = ctx.stripForProblem(child);
  assert.match(strip, /2026-09-26/);
  assert.match(strip, /\[t\]/);
  assert.doesNotMatch(strip, /分割前|2026-09-25|\[x\]/);
  assert.equal(ctx.matchFilter(sibling, 'x'), true);
  assert.match(ctx.stripForProblem(sibling), /分割前/);
  assert.deepEqual(records, before);
});

test('empty child arrays fall back to parent grades; truly ungraded and ordinary problems retain their meaning', () => {
  const ctx = recordFixture({parent: [{d: '2026-09-25', r: 'o'}], child: [], ordinary: [{d: '2026-09-26', r: 'o'}]});
  const child = {id: 'child', parentId: 'parent'};
  assert.equal(ctx.recordSource(child), 'parent');
  assert.equal(ctx.matchFilter(child, 'recorded'), true);
  for (const problem of [{id: 'new-child', parentId: 'ungraded-parent'}, {id: 'new-ordinary'}]) {
    assert.equal(ctx.recordSource(problem), problem.id);
    assert.equal(ctx.matchFilter(problem, 'none'), true);
    assert.equal(ctx.matchFilter(problem, 'recorded'), false);
    assert.match(ctx.stripForProblem(problem), /未実施/);
    assert.doesNotMatch(ctx.stripForProblem(problem), /分割前/);
  }
  assert.equal(ctx.recordSource({id: 'ordinary'}), 'ordinary');
  assert.equal(ctx.matchFilter({id: 'ordinary'}, 'recorded'), true);
  assert.doesNotMatch(ctx.stripForProblem({id: 'ordinary'}), /分割前/);
});

test('record shortcut removes stale unit and test restrictions, selects a recorded problem, and keeps its list open', () => {
  const records = readOnly({parent: [{d: '2026-09-25', r: 'x'}]});
  const calls = [];
  const ctx = vm.createContext({
    state: {unit: '計算', test: 'old-test', filter: 'none', pid: 'ungraded', records},
    ensureSelection() {
      assert.equal(ctx.state.unit, '*'); assert.equal(ctx.state.test, '*');
      assert.equal(ctx.state.filter, 'recorded');
      ctx.state.pid = 'parent::part:(1)'; calls.push('select');
    },
    renderSide() { calls.push('side'); }, renderProblem() { calls.push('problem'); },
    saveSettings() { calls.push('save'); }, openSide() { calls.push('open'); },
    closeSide() { throw Error('record shortcut must leave its problem list visible'); }
  });
  vm.runInContext(sourceOf('showRecordedProblems'), ctx);
  ctx.showRecordedProblems();
  assert.equal(ctx.state.pid, 'parent::part:(1)');
  for (const action of ['select', 'side', 'problem', 'save']) assert.equal(calls.filter(call => call === action).length, 1, action);
  assert.equal(ctx.state.records, records);
});

test('cloud records arriving into an empty recorded view select the restored problem without copying its parent grades', () => {
  const child = {id: 'parent::part:(1)', parentId: 'parent', unit: '計算'};
  const calls = [], records = readOnly({parent: [{d: '2026-09-25', r: 'x'}]});
  const ctx = vm.createContext({
    state: {records: {}, pid: null, unit: '*', test: '*', filter: 'recorded', sort: 'no'},
    PROBLEMS: [child], syncReady: true,
    renderSide() { calls.push('side'); }, renderTop() {}, renderParentHistory() {},
    renderProblem() { calls.push('problem'); }
  });
  vm.runInContext(['recs', 'recordSource', 'latest', 'matchFilter', 'inUnit', 'inTest', 'problemsOf', 'sortList', 'visible', 'current', 'ensureSelection', 'refreshSyncedRecords'].map(sourceOf).join('\n'), ctx);
  ctx.refreshSyncedRecords(records);
  assert.equal(ctx.state.pid, child.id);
  assert.equal(ctx.state.records, records);
  assert.equal(Object.hasOwn(records, child.id), false);
  assert.deepEqual(calls, ['side', 'problem']);
});

test('a background record refresh preserves an already selected problem and its running view', () => {
  const current = {id: 'current'}, restored = {id: 'restored'};
  const records = readOnly({restored: [{d: '2026-09-26', r: 'o'}]});
  const ctx = vm.createContext({
    state: {records: {}, pid: current.id}, PROBLEMS: [current, restored], syncReady: true,
    $: () => ({innerHTML: ''}), historyHtml: () => '', renderParentHistory() {}, renderSide() {}, renderTop() {},
    ensureSelection() { throw Error('sync must not navigate away from the current question'); },
    renderProblem() { throw Error('sync must not restart the current question'); }
  });
  vm.runInContext(['current', 'refreshSyncedRecords'].map(sourceOf).join('\n'), ctx);
  ctx.refreshSyncedRecords(records);
  assert.equal(ctx.state.pid, current.id);
  assert.equal(ctx.state.records, records);
});

function cloudFixture(status, failure) {
  const nodes = new Map(), calls = [], errors = [];
  const records = readOnly({p1: [{d: '2026-09-26', r: 'o', s: 14}]});
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {hidden: true, disabled: false, textContent: '', setAttribute() {}});
    return nodes.get(id);
  }
  const ctx = vm.createContext({
    cloudState: status, state: {records}, $: node,
    recordStore: {
      getStatus: () => status,
      sync: async () => { calls.push('sync'); if (failure) throw Error('private network detail'); return true; },
      connect: async () => { calls.push('connect'); if (failure) throw Error('private network detail'); }
    },
    recordsError: message => errors.push(message),
    toast: message => errors.push(message)
  });
  return {ctx, nodes, calls, errors, records};
}

test('sync action connects an unconnected or expired device and syncs a connected device without changing grades', async () => {
  for (const [status, action] of [
    [{connected: false, needsAuth: false}, 'connect'],
    [{connected: false, needsAuth: true}, 'connect'],
    [{connected: true, needsAuth: true}, 'connect'],
    [{connected: true, needsAuth: false}, 'sync']
  ]) {
    const h = cloudFixture(status);
    vm.runInContext(sourceOf('syncRecords'), h.ctx);
    await h.ctx.syncRecords();
    assert.deepEqual(h.calls, [action]);
    assert.equal(h.ctx.state.records, h.records);
    assert.equal(h.errors.length, 0);
  }
});

test('a failed sync/connect action reports a visible safe error while retaining records', async () => {
  for (const connected of [false, true]) {
    const h = cloudFixture({connected, needsAuth: false}, true);
    vm.runInContext(sourceOf('syncRecords'), h.ctx);
    await h.ctx.syncRecords();
    assert.equal(h.errors.length, 1);
    assert.ok(h.errors[0]);
    assert.doesNotMatch(h.errors[0], /private network detail/);
    assert.equal(h.ctx.state.records, h.records);
  }
});

test('sync remains discoverable when disconnected, expired, busy or blocked, and the latest status drives the action', () => {
  for (const status of [
    {connected: false}, {connected: false, needsAuth: true},
    {connected: true, email: 'fixture@example.test', synced: true},
    {connected: true, email: 'fixture@example.test', syncing: true},
    {connected: true, email: 'fixture@example.test', blocked: true, error: 'fixture error'}
  ]) {
    const h = cloudFixture({});
    vm.runInContext(sourceOf('renderCloudStatus'), h.ctx);
    h.ctx.renderCloudStatus({pending: 0, ...status});
    assert.equal(h.nodes.get('cloudSync').hidden, false);
    assert.equal(h.ctx.cloudState.connected, status.connected);
    assert.equal(Boolean(h.ctx.cloudState.needsAuth), Boolean(status.needsAuth));
  }
});

function ancestorsOf(id) {
  const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const stack = [], voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  for (const match of markup.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
    const [, closing, originalTag, attributes] = match, tag = originalTag.toLowerCase();
    if (closing) {
      const index = stack.map(item => item.tag).lastIndexOf(tag);
      if (index >= 0) stack.splice(index);
      continue;
    }
    const currentId = /\bid\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    if (currentId === id) return stack;
    if (!voids.has(tag) && !/\/\s*$/.test(attributes)) stack.push({tag, id: currentId});
  }
  assert.fail(`element ${id} is present`);
}

test('sync controls are outside the unit/settings scrolling region and expose direct record actions', () => {
  assert.ok(!ancestorsOf('cloudPanel').some(ancestor => ancestor.id === 'selectionScroll'));
  assert.ok(!ancestorsOf('cloudSync').some(ancestor => ancestor.id === 'selectionScroll'));
  assert.match(html, /<button\b[^>]*id="cloudSync"[^>]*>記録を同期<\/button>/);
  assert.match(html, /<button\b[^>]*>記録を見る<\/button>/);
});

test('old parent history is expanded when present and remains separate from child grades', () => {
  const nodes = {parentHistory: {hidden: true}, parentHist: {innerHTML: ''}};
  const records = readOnly({parent: [{d: '2026-09-25', r: 'x'}], child: [{d: '2026-09-26', r: 'o'}]});
  const ctx = vm.createContext({
    $: id => nodes[id], recs: id => records[id] || [], historyHtml: id => `history:${id}`
  });
  vm.runInContext(sourceOf('renderParentHistory'), ctx);
  ctx.renderParentHistory({id: 'child', parentId: 'parent'});
  assert.equal(nodes.parentHistory.hidden, false);
  assert.match(html, /<section\b[^>]*id="parentHistory"/);
  assert.doesNotMatch(html, /<details\b[^>]*id="parentHistory"/);
  assert.equal(nodes.parentHist.innerHTML, 'history:parent');
  ctx.renderParentHistory({id: 'ungraded', parentId: 'ungraded-parent'});
  assert.equal(nodes.parentHistory.hidden, true);
  assert.equal(nodes.parentHist.innerHTML, '');
  assert.deepEqual(records.child, [{d: '2026-09-26', r: 'o'}]);
});
