(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SapixRecordSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var recordsKey = 'sapix_sansu_records_v2';
  var legacyKey = 'sapix_sansu_records_v1';
  var authTokenKey = 'sapix_sansu_sync_auth_v1';
  var pkceKey = 'sapix_sansu_sync_pkce_v1';
  var API = 'https://math-app-proxy.iwslatojp29.workers.dev';
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function validValue(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.d) || !['o', 't', 'x'].includes(v.r)) return false;
    var y = +v.d.slice(0, 4), m = +v.d.slice(5, 7), d = +v.d.slice(8, 10), date = new Date(0);
    date.setUTCFullYear(y, m - 1, d);
    return y >= 1000 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d &&
      (v.s == null || (typeof v.s === 'number' && Number.isFinite(v.s) && v.s >= 0 && v.s <= 31536000)) && (v.over === undefined || typeof v.over === 'boolean');
  }
  function cleanValue(v) { var n = { d: v.d, r: v.r }; if (v.s != null) n.s = v.s; if (v.over !== undefined) n.over = v.over; return n; }
  function identity(pid, v) { return JSON.stringify([pid, v.d, v.r, v.s == null ? null : v.s, v.over == null ? null : v.over]); }
  function base64url(bytes) {
    var text = ''; bytes.forEach(function (n) { text += String.fromCharCode(n); });
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function legacyId(pid, value, occurrence) {
    return 'legacy-' + base64url(new TextEncoder().encode(JSON.stringify([pid, value.d, value.r, value.s == null ? null : value.s, value.over == null ? null : value.over, occurrence])));
  }
  function empty() { return { version: 2, revision: 0, entries: [], deleted: [], outbox: [] }; }
  function validId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,1024}$/.test(id); }
  function validPid(pid) { return typeof pid === 'string' && pid.length > 0 && pid.length <= 200 && !/[\x00-\x1f\x7f]/.test(pid) && !['__proto__', 'constructor', 'prototype'].includes(pid); }
  function validEntry(e) { return e && validId(e.id) && validPid(e.pid) && Number.isSafeInteger(e.seq) && e.seq > 0 && validValue(e.value); }
  function validOp(op) { return op && (op.type === 'delete' ? validId(op.id) : op.type === 'put' && validEntry(op)); }
  function validateEnvelope(e) {
    if (!e || e.version !== 2 || !Number.isSafeInteger(e.revision) || e.revision < 0 || !Array.isArray(e.entries) || !Array.isArray(e.deleted) || !Array.isArray(e.outbox) ||
      e.entries.some(function (x) { return !validEntry(x) || !Number.isFinite(x.order); }) || e.deleted.some(function (x) { return !validId(x); }) || e.outbox.some(function (x) { return !validOp(x); }) ||
      new Set(e.entries.map(function (x) { return x.id; })).size !== e.entries.length || new Set(e.outbox.map(function (x) { return x.id; })).size !== e.outbox.length) throw Error('invalid_data');
    return e;
  }
  function apply(e, op, order) {
    var index = e.entries.findIndex(function (x) { return x.id === op.id; });
    if (op.type === 'delete') {
      if (!e.deleted.includes(op.id)) e.deleted.push(op.id);
      if (index >= 0) e.entries.splice(index, 1);
    } else if (!e.deleted.includes(op.id) && (index < 0 || op.seq > e.entries[index].seq)) {
      var entry = { id: op.id, pid: op.pid, seq: op.seq, value: cleanValue(op.value), order: index >= 0 ? e.entries[index].order : order };
      if (index < 0) e.entries.push(entry); else e.entries[index] = entry;
    }
  }
  function enqueue(e, op, order) {
    apply(e, op, order);
    e.outbox = e.outbox.filter(function (x) { return x.id !== op.id; });
    e.outbox.push(op);
  }
  function create(options) {
    var o = options || {}, storage = o.storage || localStorage, session = o.sessionStorage || (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
    var request = o.fetch || fetch, crypt = o.crypto || globalThis.crypto, now = o.now || Date.now;
    var schedule = o.setTimeout || setTimeout, unschedule = o.clearTimeout || clearTimeout;
    var loc = o.location || (typeof location !== 'undefined' ? location : null), hist = o.history || (typeof history !== 'undefined' ? history : null);
    var envelope = empty(), auth = null, blocked = false, raw = null, blockedKey = recordsKey, error = '', busy = false, retry = null, delay = 2000, needsAuth = false, loaded = false, synced = false;
    function status() {
      var s = { connected: !!auth, email: auth ? auth.email : '', pending: envelope.outbox.length, syncing: busy, synced: synced, blocked: blocked, needsAuth: needsAuth, error: error };
      if (o.onStatus) o.onStatus(s);
      return s;
    }
    function records() {
      var map = Object.create(null);
      envelope.entries.slice().sort(function (a, b) { return a.value.d.localeCompare(b.value.d) || a.order - b.order || a.id.localeCompare(b.id); }).forEach(function (e) { (map[e.pid] || (map[e.pid] = [])).push(clone(e.value)); });
      return map;
    }
    function changed() { if (o.onChange) o.onChange(records()); status(); }
    function readLatest() {
      var text = storage.getItem(recordsKey);
      if (text != null) envelope = validateEnvelope(JSON.parse(text));
      else if (loaded && !blocked) throw Error('missing_local_data');
    }
    function refresh() {
      try {
        readLatest();
        var saved = JSON.parse(storage.getItem(authTokenKey) || 'null');
        if ((!saved && auth) || (saved && (!auth || saved.token !== auth.token))) { auth = saved; needsAuth = false; synced = false; }
        changed();
      } catch (e) { blocked = true; error = '保存済みの記録を読み込めません。元データを保管して確認してください。'; status(); }
    }
    async function send(url, init) {
      var controller = new AbortController();
      var timer = schedule(function () { controller.abort(); }, 20000);
      if (timer && typeof timer.unref === 'function') timer.unref();
      try {
        var response = await request(url, { ...init, cache: 'no-store', signal: controller.signal });
        if (response.ok && !url.endsWith('/revoke')) {
          var body = await response.json();
          return { ok: true, status: response.status, headers: response.headers, json: async function () { return body; } };
        }
        return response;
      }
      finally { unschedule(timer); }
    }
    function persist(next) {
      validateEnvelope(next);
      storage.setItem(recordsKey, JSON.stringify(next));
      envelope = next; blocked = false; error = '';
      changed();
    }
    function migrate(map) {
      if (!map || typeof map !== 'object' || Array.isArray(map)) throw Error('invalid_data');
      var e = empty(), counts = new Map(), order = 0;
      Object.keys(map).forEach(function (pid) {
        if (!validPid(pid) || !Array.isArray(map[pid])) throw Error('invalid_data');
        map[pid].forEach(function (v) {
          if (!validValue(v)) throw Error('invalid_data');
          var key = identity(pid, v), occurrence = counts.get(key) || 0;
          counts.set(key, occurrence + 1);
          var op = { type: 'put', id: legacyId(pid, v, occurrence), pid: pid, seq: 1, value: cleanValue(v) };
          if (!validOp(op)) throw Error('invalid_data');
          enqueue(e, op, ++order);
        });
      });
      return e;
    }
    function load() {
      try {
        raw = storage.getItem(recordsKey);
        if (raw != null) envelope = validateEnvelope(JSON.parse(raw));
        else {
          blockedKey = legacyKey; raw = storage.getItem(legacyKey);
          envelope = migrate(JSON.parse(raw == null ? '{}' : raw));
          // Migration and its initial outbox are committed in the same write; v1 is untouched.
          storage.setItem(recordsKey, JSON.stringify(envelope));
        }
        blocked = false;
      } catch (e) {
        blocked = true; error = '保存済みの記録を読み込めません。元データを保管して確認してください。';
        if (blockedKey === legacyKey && raw != null) {
          try {
            var source = JSON.parse(raw), safe = Object.create(null);
            if (source && typeof source === 'object' && !Array.isArray(source)) {
              Object.keys(source).forEach(function (pid) { if (validPid(pid) && Array.isArray(source[pid])) safe[pid] = source[pid].filter(validValue); });
              envelope = migrate(safe);
            }
          } catch (ignored) { /* Keep the original text available for export without writing it. */ }
        }
      }
      try {
        var a = JSON.parse(storage.getItem(authTokenKey) || 'null');
        if (a && typeof a.token === 'string' && a.token && typeof a.email === 'string') auth = a;
      } catch (e) { error = '接続情報を読み込めません。もう一度Googleに接続してください。'; }
      loaded = true; changed();
      return { records: records(), blocked: blocked, raw: raw, error: error, rawKey: blockedKey };
    }
    function mutate(fn, recover) {
      if (!loaded) load();
      if (blocked && !recover) throw Error('invalid_local_data');
      var wasBlocked = blocked;
      try { readLatest(); }
      catch (e) { if (!(recover && wasBlocked)) { blocked = true; error = '保存済みの記録を読み込めないため、上書きしていません。'; status(); throw e; } }
      var next = clone(envelope);
      fn(next);
      try { persist(next); } catch (e) { error = '端末に保存できません。保存設定や空き容量を確認してください。'; status(); throw e; }
      kick();
    }
    function uuid() { return crypt.randomUUID ? crypt.randomUUID() : base64url(crypt.getRandomValues(new Uint8Array(24))); }
    function put(pid, value, id) {
      if (!validPid(pid) || !validValue(value)) throw Error('invalid_record');
      var result = id || uuid();
      mutate(function (e) {
        if (e.deleted.includes(result)) throw Error('record_deleted');
        var old = e.entries.find(function (x) { return x.id === result; });
        if (id && (!old || old.pid !== pid)) throw Error('record_deleted');
        enqueue(e, { type: 'put', id: result, pid: pid, seq: old ? old.seq + 1 : 1, value: cleanValue(value) }, now());
      });
      return result;
    }
    function remove(ids) {
      mutate(function (e) { ids.forEach(function (id) { if (!validId(id)) throw Error('invalid_id'); enqueue(e, { type: 'delete', id: id }, now()); }); });
    }
    function replaceRecords(map, flags) {
      var incoming = migrate(map);
      var observed = new Set(envelope.entries.map(function (x) { return x.id; }));
      var added = 0;
      mutate(function (e) {
        var retained = new Set(), used = new Set();
        incoming.entries.forEach(function (item) {
          var match = e.entries.find(function (x) { return !used.has(x.id) && identity(x.pid, x.value) === identity(item.pid, item.value); });
          if (match) { used.add(match.id); retained.add(match.id); }
          else {
            // An explicit import can restore a backup as a new attempt. Reusing
            // a tombstoned/corrected legacy ID would silently discard that row.
            var id = e.deleted.includes(item.id) || e.entries.some(function (x) { return x.id === item.id; }) ? uuid() : item.id;
            enqueue(e, { type: 'put', id: id, pid: item.pid, seq: 1, value: item.value }, now()); retained.add(id); added++;
          }
        });
        if (!(flags && flags.additive)) e.entries.slice().forEach(function (x) { if (observed.has(x.id) && !retained.has(x.id)) enqueue(e, { type: 'delete', id: x.id }, now()); });
      }, flags && flags.recover);
      return added;
    }
    function importRecords(map) { return replaceRecords(map, { additive: true }); }
    function retryLater(ms) {
      if (retry || !auth || needsAuth || blocked) return;
      retry = schedule(function () { retry = null; sync(); }, ms || delay);
      if (retry && typeof retry.unref === 'function') retry.unref();
      delay = Math.min(delay * 2, 60000);
    }
    function kick() { if (auth && !needsAuth && !blocked) retryLater(20); }
    function snapshot(data, sent) {
      readLatest();
      if (!data || !Number.isSafeInteger(data.revision) || data.revision < envelope.revision || !Array.isArray(data.entries) || !Array.isArray(data.deleted)) throw Error('invalid_response');
      var next = { version: 2, revision: data.revision, entries: clone(data.entries), deleted: [...new Set(data.deleted.concat(envelope.deleted))], outbox: [] };
      validateEnvelope(next);
      next.entries = next.entries.filter(function (x) { return !next.deleted.includes(x.id); });
      next.outbox = envelope.outbox.filter(function (op) { return !sent.some(function (ack) { return JSON.stringify(ack) === JSON.stringify(op); }); });
      next.outbox = next.outbox.filter(function (op) { return op.type === 'delete' || !next.deleted.includes(op.id); });
      next.outbox.forEach(function (op) {
        var old = envelope.entries.find(function (x) { return x.id === op.id; });
        apply(next, op, old ? old.order : now());
      });
      persist(next);
    }
    function batch() {
      var ops = [], length = 12;
      for (var op of envelope.outbox) {
        var size = new TextEncoder().encode(JSON.stringify(op)).length + 1;
        if (ops.length >= 1000 || length + size > 500 * 1024) break;
        ops.push(clone(op)); length += size;
      }
      return ops;
    }
    async function sync() {
      if (!loaded) load();
      if (busy || !auth || needsAuth || blocked) { status(); return false; }
      if (retry) { unschedule(retry); retry = null; }
      busy = true; error = ''; status();
      var token = auth.token;
      try {
        readLatest();
        var sent = batch();
        var response = await send(API + '/api/sapix/records', { method: sent.length ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(sent.length ? { 'Content-Type': 'application/json' } : {}) }, ...(sent.length ? { body: JSON.stringify({ ops: sent }) } : {}) });
        if (!auth || auth.token !== token) return false;
        if (!response.ok) {
          if (response.status === 401) {
            // An expired or replaced account must not stay displayed as connected.
            // The local records and unsent operations are kept for reconnection.
            auth = null; needsAuth = true; synced = false;
            try { storage.removeItem(authTokenKey); } catch (e) {}
            error = '接続を確認できません。Googleに再接続してください。';
          }
          else { error = '端末には保存済みです。同期できませんでした。通信が戻ると再試行します。'; if (response.status === 429 && response.headers) { var seconds = +response.headers.get('Retry-After'); if (seconds > 0) delay = Math.min(seconds * 1000, 300000); } }
          throw Error('http_' + response.status);
        }
        snapshot(await response.json(), sent);
        delay = 2000; synced = true;
        return true;
      } catch (e) {
        if (!error) error = '端末には保存済みです。同期できませんでした。通信が戻ると再試行します。';
        retryLater();
        return false;
      } finally { busy = false; status(); if (!error && envelope.outbox.length) kick(); }
    }
    async function connect() {
      var verifier = base64url(crypt.getRandomValues(new Uint8Array(32))), state = base64url(crypt.getRandomValues(new Uint8Array(24)));
      var digest = await crypt.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      session.setItem(pkceKey, JSON.stringify({ verifier: verifier, state: state, created: now() }));
      loc.assign(API + '/api/sapix/auth/start?challenge=' + base64url(new Uint8Array(digest)) + '&state=' + encodeURIComponent(state));
    }
    async function finishAuth() {
      if (!loc || !loc.hash || !/sapix_(code|state|error)=/.test(loc.hash)) return false;
      var params = new URLSearchParams(loc.hash.slice(1));
      hist.replaceState(null, '', loc.pathname + loc.search);
      try {
        var saved = JSON.parse(session.getItem(pkceKey) || 'null'); session.removeItem(pkceKey);
        if (!saved || !params.get('sapix_code') || saved.state !== params.get('sapix_state') || !/^[A-Za-z0-9_-]{43}$/.test(saved.verifier) || !Number.isFinite(saved.created) || now() < saved.created || now() - saved.created > 10 * 60 * 1000) throw Error('invalid_state');
        var response = await send(API + '/api/sapix/auth/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: params.get('sapix_code'), verifier: saved.verifier }) });
        if (!response.ok) throw Error('exchange_failed');
        var value = await response.json();
        if (!value || typeof value.token !== 'string' || !value.token || typeof value.email !== 'string') throw Error('invalid_response');
        storage.setItem(authTokenKey, JSON.stringify(value)); auth = value; needsAuth = false; error = ''; status();
        await sync(); return true;
      } catch (e) { error = 'Google接続を完了できませんでした。「Googleで接続」からもう一度お試しください。'; status(); return false; }
    }
    async function disconnect() {
      var token = auth && auth.token;
      storage.removeItem(authTokenKey); auth = null; needsAuth = false; error = ''; synced = false;
      if (retry) { unschedule(retry); retry = null; }
      status();
      if (token) {
        try { var r = await send(API + '/api/sapix/auth/revoke', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }); if (!r.ok && r.status !== 401) throw Error('revoke'); }
        catch (e) { error = 'この端末の接続は解除しました。サーバーへの解除通知は届きませんでした。'; status(); }
      }
    }
    var events = o.eventTarget || (typeof window !== 'undefined' ? window : null);
    if (events) events.addEventListener('storage', function (event) { if (event.key === recordsKey || event.key === authTokenKey || event.key === null) refresh(); });
    return { load: load, refresh: refresh, getRecords: records, getEntries: function () { return clone(envelope.entries); }, getState: function () { return clone(envelope); }, getStatus: status,
      put: put, remove: remove, replaceRecords: replaceRecords, importRecords: importRecords, sync: sync, connect: connect, finishAuth: finishAuth, disconnect: disconnect };
  }
  return { create: create, recordsKey: recordsKey, legacyKey: legacyKey, authTokenKey: authTokenKey, pkceKey: pkceKey, legacyId: legacyId, validValue: validValue };
});
