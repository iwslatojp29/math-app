const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto').webcrypto;
const Sync = require('../sapix/record-sync.js');
const value = r => ({ d: '2026-09-26', r, s: 12 });
const copy = x => JSON.parse(JSON.stringify(x));
function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
}
function server() {
  const rows = new Map(), deleted = new Set();
  let revision = 0;
  const api = { calls: [], snapshot: () => ({ revision, entries: [...rows.values()].map(copy), deleted: [...deleted] }) };
  api.fetch = async (url, init) => {
    api.calls.push({ url, init });
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal);
    for (const op of init.body ? JSON.parse(init.body).ops || [] : []) {
      if (op.type === 'delete') { deleted.add(op.id); rows.delete(op.id); revision++; }
      else if (!deleted.has(op.id) && (!rows.has(op.id) || rows.get(op.id).seq < op.seq)) {
        rows.set(op.id, { id: op.id, pid: op.pid, seq: op.seq, value: copy(op.value), order: rows.get(op.id)?.order || ++revision });
      }
    }
    return { ok: true, status: 200, json: async () => api.snapshot() };
  };
  return api;
}
function client(api, options = {}) {
  const store = options.storage || storage({ [Sync.authTokenKey]: JSON.stringify({ token: 'test-only-token', email: 'test@example.invalid', expiresAt: Date.now() + 60000 }) });
  const statuses = [], timers = new Map();
  let timerId = 0;
  const c = Sync.create({ storage: store, fetch: api.fetch, crypto, onStatus: s => statuses.push(s),
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id), ...options });
  c.load();
  return { c, store, statuses, timers };
}

test('two devices migrate the same legacy attempts once, preserving repeated identical attempts', async () => {
  const api = server(), legacy = JSON.stringify({ p1: [value('o'), value('o'), value('x')] });
  const a = client(api), b = client(api);
  for (const h of [a, b]) { h.store.removeItem(Sync.recordsKey); h.store.setItem(Sync.legacyKey, legacy); h.c.load(); }
  await a.c.sync(); await b.c.sync(); await a.c.sync();
  assert.equal(a.c.getEntries().length, 3);
  assert.deepEqual(a.c.getRecords(), b.c.getRecords());
  assert.equal(a.store.getItem(Sync.legacyKey), legacy);
  assert.equal(b.store.getItem(Sync.legacyKey), legacy);
  assert.equal(a.c.getState().outbox.length, 0);
});

test('both devices add, correct stable IDs, undo and clear only observed IDs', async () => {
  const api = server(), a = client(api), b = client(api);
  const first = a.c.put('p1', value('x')), second = b.c.put('p1', value('t'));
  await a.c.sync(); await b.c.sync(); await a.c.sync();
  a.c.put('p1', value('o'), first);
  await a.c.sync(); await b.c.sync();
  assert.equal(b.c.getEntries().find(e => e.id === first).seq, 2);
  assert.equal(b.c.getEntries().length, 2);
  b.c.remove([second]); await b.c.sync(); await a.c.sync();
  const unseen = b.c.put('p2', value('t'));
  a.c.replaceRecords({}); await a.c.sync(); await b.c.sync(); await a.c.sync();
  assert.deepEqual(a.c.getEntries().map(e => e.id), [unseen]);
  assert.ok(a.c.getState().deleted.includes(first));
  assert.ok(a.c.getState().deleted.includes(second));
});

test('a lost response retries the same operation and reload keeps its pending queue', async () => {
  const api = server(); let lose = true;
  const h = client(api, { fetch: async (...args) => { const r = await api.fetch(...args); if (lose) { lose = false; throw Error('lost response'); } return r; } });
  const id = h.c.put('p1', value('o'));
  assert.equal(await h.c.sync(), false);
  assert.equal(h.c.getState().outbox.length, 1);
  assert.ok(h.statuses.at(-1).error);
  assert.equal(h.statuses.at(-1).synced, false);
  const resumed = client(api, { storage: h.store });
  await resumed.c.sync();
  assert.deepEqual(api.snapshot().entries.map(e => e.id), [id]);
  assert.equal(resumed.c.getState().outbox.length, 0);
});

test('new grades and corrections created while a request is in flight stay queued', async () => {
  const api = server(); let release;
  const h = client(api, { fetch: async (...args) => { const response = await api.fetch(...args); const fixed = api.snapshot(); await new Promise(resolve => { release = resolve; }); return { ...response, json: async () => fixed }; } });
  const id = h.c.put('p1', value('x'));
  const sending = h.c.sync();
  await Promise.resolve(); await Promise.resolve();
  h.c.put('p1', value('o'), id);
  h.c.put('p2', value('t'));
  release(); await sending;
  assert.equal(h.c.getState().outbox.length, 2);
  assert.equal(h.c.getEntries().find(e => e.id === id).value.r, 'o');
  assert.equal(h.c.getEntries().length, 2);
});

test('same-browser tabs reread durable state before mutation and after network response', async () => {
  const api = server(), a = client(api); let release;
  const b = client(api, { storage: a.store });
  const id = a.c.put('p1', value('o'));
  const bId = b.c.put('p2', value('t'));
  assert.equal(b.c.getEntries().length, 2);
  const slow = client(api, { storage: a.store, fetch: async (...args) => { const r = await api.fetch(...args), fixed = api.snapshot(); await new Promise(resolve => { release = resolve; }); return { ...r, json: async () => fixed }; } });
  const sending = slow.c.sync(); await Promise.resolve(); await Promise.resolve();
  a.c.put('p1', value('x'), id);
  b.c.put('p3', value('o'));
  release(); await sending;
  assert.equal(slow.c.getEntries().length, 3);
  assert.equal(slow.c.getEntries().find(e => e.id === id).value.r, 'x');
  assert.ok(slow.c.getEntries().some(e => e.id === bId));
  assert.equal(slow.c.getState().outbox.length, 2);
});

test('storage events refresh records without requiring reload', () => {
  const api = server(), a = client(api); let listener, changes = 0;
  const b = client(api, { storage: a.store, eventTarget: { addEventListener(type, fn) { assert.equal(type, 'storage'); listener = fn; } }, onChange: () => changes++ });
  a.c.put('p1', value('o'));
  listener({ key: Sync.recordsKey });
  assert.equal(b.c.getEntries().length, 1);
  assert.equal(changes, 2);
});

test('401 asks for reconnect; 429 and 503 preserve pending records and schedule retries', async () => {
  for (const status of [401, 429, 503]) {
    const h = client({ fetch: async () => ({ ok: false, status, headers: { get: () => '3' } }) });
    h.c.put('p1', value('x'));
    assert.equal(await h.c.sync(), false);
    assert.equal(h.c.getState().outbox.length, 1);
    assert.equal(h.c.getStatus().needsAuth, status === 401);
    assert.equal(h.c.getStatus().connected, status !== 401);
    if (status === 401) {
      assert.equal(h.c.getStatus().email, '');
      assert.equal(h.store.getItem(Sync.authTokenKey), null);
      assert.equal(h.c.getRecords().p1[0].r, 'x');
    }
    assert.equal(h.c.getStatus().syncing, false);
    assert.ok(h.c.getStatus().error);
    assert.equal(h.timers.size > 0, status !== 401);
  }
});

test('timed-out fetch aborts and releases busy state with records still pending', async () => {
  const h = client({ fetch: async (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Error('aborted')))) });
  h.c.put('p1', value('o'));
  const sending = h.c.sync();
  [...h.timers.values()].find(t => t.ms === 20000).fn();
  await sending;
  assert.equal(h.c.getStatus().syncing, false);
  assert.equal(h.c.getState().outbox.length, 1);
});

test('invalid callback state clears the URL fragment immediately and never exchanges a code', async () => {
  const api = server(), session = storage(); let navigated = '', cleared = '';
  const location = { hash: '', pathname: '/math-app/sapix/sapix_sansu_trainer.html', search: '', assign: u => { navigated = u; } };
  const h = client(api, { sessionStorage: session, location, history: { replaceState(a, b, url) { cleared = url; } } });
  await h.c.connect();
  const url = new URL(navigated), pkce = JSON.parse(session.getItem(Sync.pkceKey));
  assert.equal(url.searchParams.get('challenge').length, 43);
  assert.equal(url.searchParams.get('state'), pkce.state);
  location.hash = '#sapix_code=test-only-code&sapix_state=wrong';
  assert.equal(await h.c.finishAuth(), false);
  assert.equal(cleared, location.pathname);
  assert.equal(session.getItem(Sync.pkceKey), null);
  assert.equal(api.calls.length, 0);
  assert.ok(h.c.getStatus().error);
});

test('disconnect preserves local grades and pending edits', async () => {
  const api = server(), h = client(api);
  h.c.put('p1', value('x'));
  const before = h.store.getItem(Sync.recordsKey);
  await h.c.disconnect();
  assert.equal(h.store.getItem(Sync.recordsKey), before);
  assert.equal(h.store.getItem(Sync.authTokenKey), null);
  assert.equal(h.c.getStatus().connected, false);
  assert.equal(api.calls.at(-1).url.endsWith('/auth/revoke'), true);
});

test('invalid imported IDs, dates and times cannot enter a permanently failing outbox', () => {
  const h = client(server());
  for (const pid of ['__proto__', 'constructor', 'prototype', 'x'.repeat(201), 'a\nb']) assert.throws(() => h.c.put(pid, value('o')));
  for (const v of [{ ...value('o'), d: '0999-01-01' }, { ...value('o'), s: 31536001 }, { ...value('o'), d: '2025-02-29' }]) assert.throws(() => h.c.put('p1', v));
  assert.equal(h.c.getState().outbox.length, 0);
});

test('explicit backup import restores a deleted attempt with a new ID and repeated import deduplicates it', async () => {
  const api = server(), h = client(api);
  const original = { p1: [value('x')] };
  h.c.replaceRecords(original);
  const oldId = h.c.getEntries()[0].id;
  await h.c.sync();
  h.c.replaceRecords({}); await h.c.sync();
  h.c.replaceRecords(original);
  const newId = h.c.getEntries()[0].id;
  assert.notEqual(newId, oldId);
  h.c.replaceRecords(original);
  assert.equal(h.c.getEntries().length, 1);
  assert.equal(h.c.getEntries()[0].id, newId);
  await h.c.sync();
  assert.ok(api.snapshot().deleted.includes(oldId));
  assert.deepEqual(api.snapshot().entries.map(e => e.id), [newId]);
});

test('importing the original value after correcting a legacy attempt preserves both values', () => {
  const h = client(server());
  h.c.replaceRecords({ p1: [value('x')] });
  const oldId = h.c.getEntries()[0].id;
  h.c.put('p1', value('o'), oldId);
  h.c.replaceRecords({ p1: [value('o'), value('x')] });
  assert.equal(h.c.getEntries().length, 2);
  assert.equal(h.c.getEntries().find(e => e.id === oldId).value.r, 'o');
  assert.equal(h.c.getEntries().find(e => e.id !== oldId).value.r, 'x');
});

test('explicit clear with recovery enabled preserves another tab’s unobserved pending attempt', () => {
  const api = server(), a = client(api);
  const observed = a.c.put('p1', value('o'));
  const b = client(api, { storage: a.store });
  const unseen = b.c.put('p2', value('t'));
  a.c.replaceRecords({}, { recover: true });
  assert.deepEqual(a.c.getEntries().map(e => e.id), [unseen]);
  const persisted = JSON.parse(a.store.getItem(Sync.recordsKey));
  assert.ok(persisted.deleted.includes(observed));
  assert.ok(persisted.outbox.some(op => op.id === unseen && op.type === 'put'));
});

test('an additive import in a stale tab preserves another tab’s latest correction', () => {
  const api = server(), a = client(api);
  const id = a.c.put('p1', value('x'));
  const b = client(api, { storage: a.store });
  b.c.put('p1', value('o'), id);
  assert.equal(a.c.importRecords({ p2: [value('t')] }), 1);
  assert.equal(a.c.getEntries().length, 2);
  assert.equal(a.c.getEntries().find(e => e.id === id).value.r, 'o');
  assert.equal(a.c.getEntries().find(e => e.id === id).seq, 2);
  assert.equal(a.c.getState().deleted.length, 0);
  assert.equal(a.c.importRecords({ p2: [value('t')] }), 0);
});
