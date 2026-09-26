// These credentials are scoped exclusively to private grading records. They do
// not grant access to the Studio, Drive, GitHub, or the upload/delete endpoints.
const RETURN_URL = 'https://iwslatojp29.github.io/math-app/sapix/sapix_sansu_trainer.html';
const TOKEN_AGE = 90 * 86400000;
const CODE_AGE = 3 * 60000;
const RECORD_PREFIX = 'sapix:record:';
const META_KEY = 'sapix:meta';
const MAX_RECORDS = 100000;
const ID = /^[A-Za-z0-9_-]{1,1024}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));

export function sapixCors(request, env) {
  return { Vary: 'Origin', 'Referrer-Policy': 'no-referrer', ...(request.headers.get('Origin') === env.ALLOWED_ORIGIN ? { 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN } : {}) };
}

function validDate(date) {
  if (typeof date !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number), check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() + 1 === month && check.getUTCDate() === day;
}

export class SapixRecords {
  constructor(owner, helpers) { this.owner = owner; this.env = owner.env; this.storage = owner.storage; Object.assign(this, helpers); }
  configured() { return ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'STUDIO_SECRET', 'STUDIO_OWNER_EMAIL', 'STUDIO_ORIGIN', 'ALLOWED_ORIGIN'].every(name => Boolean(this.env[name])); }
  validLogin(value) { return object(value) && SECRET.test(value.challenge) && typeof value.state === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(value.state); }
  async route(request, url, path) {
    if (path === '/api/sapix/auth/start' && request.method === 'GET') {
      if (!this.configured()) this.fail(503, 'not_configured');
      const login = { challenge: url.searchParams.get('challenge'), state: url.searchParams.get('state') };
      if (!this.validLogin(login)) this.fail(400, 'invalid_request');
      if (await this.owner.session(request)) return this.issueCode(login);
      return this.owner.oauthStart(login);
    }
    const headers = sapixCors(request, this.env);
    // Require the known Pages Origin on both reads and writes. An absent/null
    // Origin cannot turn this browser API into a cross-site credential oracle.
    if (!this.env.ALLOWED_ORIGIN || request.headers.get('Origin') !== this.env.ALLOWED_ORIGIN) this.fail(403, 'forbidden');
    if (request.method === 'OPTIONS') {
      if (!['GET', 'POST'].includes(request.headers.get('Access-Control-Request-Method'))) this.fail(403, 'forbidden');
      const requested = (request.headers.get('Access-Control-Request-Headers') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
      if (requested.some(value => !['authorization', 'content-type'].includes(value))) this.fail(403, 'forbidden');
      return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store' } });
    }
    if (path === '/api/sapix/auth/exchange' && request.method === 'POST') {
      const body = await this.readBody(request, 4096);
      return this.owner.serial(async () => this.result(await this.exchange(body), 200, headers));
    }
    return this.owner.serial(async () => {
      const tokenKey = await this.authenticate(request);
      if (path === '/api/sapix/auth/revoke' && request.method === 'POST') {
        await this.storage.delete(tokenKey);
        return this.result({ ok: true }, 200, headers);
      }
      if (path !== '/api/sapix/records') this.fail(404, 'not_found');
      if (request.method === 'GET') return this.result(await this.snapshot(), 200, headers);
      if (request.method === 'POST') {
        const body = await this.readBody(request, 2 * 1024 * 1024);
        return this.result(await this.apply(body), 200, headers);
      }
      this.fail(404, 'not_found');
    });
  }
  async issueCode(login) {
    if (!this.validLogin(login)) this.fail(400, 'invalid_request');
    return this.owner.serial(async () => {
      await this.cleanupAuth();
      const code = this.random();
      await this.storage.put('sapix:code:' + await this.digest(code), { challenge: login.challenge, expires: Date.now() + CODE_AGE });
      const location = new URL(RETURN_URL);
      location.hash = new URLSearchParams({ sapix_code: code, sapix_state: login.state }).toString();
      return new Response(null, { status: 302, headers: { Location: location.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
    });
  }
  async cleanupAuth() {
    // Auth records are small and never touch job data or grading tombstones.
    for (const prefix of ['sapix:code:', 'sapix:token:']) {
      const values = await this.storage.list({ prefix, limit: 1000 });
      const expired = [...values].filter(([, value]) => value.expires <= Date.now()).map(([key]) => key);
      for (let index = 0; index < expired.length; index += 128) await this.storage.delete(expired.slice(index, index + 128));
      if (values.size - expired.length >= 1000) this.fail(409, 'busy');
    }
  }
  async exchange(body) {
    if (!exactKeys(body, ['code', 'verifier']) || typeof body.code !== 'string' || !SECRET.test(body.code) || typeof body.verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.verifier)) this.fail(400, 'invalid_request');
    const key = 'sapix:code:' + await this.digest(body.code), challenge = await this.digest(body.verifier);
    const token = this.random(), tokenKey = 'sapix:token:' + await this.digest(token), expires = Date.now() + TOKEN_AGE;
    await this.storage.transaction(async storage => {
      const code = await storage.get(key);
      if (!code || code.expires <= Date.now() || code.challenge !== challenge) this.fail(401, 'unauthorized');
      await storage.delete(key);
      await storage.put(tokenKey, { email: this.env.STUDIO_OWNER_EMAIL, expires });
    });
    return { token, expiresAt: expires, email: this.env.STUDIO_OWNER_EMAIL };
  }
  async authenticate(request) {
    const supplied = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') || '')?.[1];
    if (!supplied) this.fail(401, 'unauthorized');
    const key = 'sapix:token:' + await this.digest(supplied), token = await this.storage.get(key);
    if (!token || token.email !== this.env.STUDIO_OWNER_EMAIL || token.expires <= Date.now()) this.fail(401, 'unauthorized');
    return key;
  }
  validateOperations(body) {
    if (!exactKeys(body, ['ops']) || !Array.isArray(body.ops) || body.ops.length > 1000) this.fail(400, 'invalid_request');
    for (const op of body.ops) {
      if (!object(op) || typeof op.id !== 'string' || !ID.test(op.id)) this.fail(400, 'invalid_request');
      if (op.type === 'delete') {
        if (!exactKeys(op, ['type', 'id'])) this.fail(400, 'invalid_request');
      } else if (op.type === 'put') {
        if (!exactKeys(op, ['type', 'id', 'pid', 'seq', 'value']) || typeof op.pid !== 'string' || !op.pid || op.pid.length > 200 || /[\u0000-\u001f\u007f]/.test(op.pid) || ['__proto__', 'constructor', 'prototype'].includes(op.pid) || !Number.isSafeInteger(op.seq) || op.seq < 1) this.fail(400, 'invalid_request');
        const value = op.value;
        if (!exactKeys(value, ['d', 'r', 's', 'over']) || !validDate(value.d) || !['o', 't', 'x'].includes(value.r) || (own(value, 's') && (!Number.isFinite(value.s) || value.s < 0 || value.s > 31536000)) || (own(value, 'over') && typeof value.over !== 'boolean')) this.fail(400, 'invalid_request');
      } else this.fail(400, 'invalid_request');
    }
  }
  async apply(body) {
    this.validateOperations(body);
    const operations = await Promise.all(body.ops.map(async op => ({ op, key: RECORD_PREFIX + await this.digest(op.id) })));
    await this.storage.transaction(async storage => {
      const meta = await storage.get(META_KEY) || { revision: 0, order: 0, count: 0 };
      let changed = false;
      for (const { op, key } of operations) {
        const previous = await storage.get(key);
        if (previous && previous.id !== op.id) this.fail(409, 'invalid_request');
        if (op.type === 'put' && previous && !previous.deleted && previous.pid !== op.pid) this.fail(400, 'invalid_request');
        if (previous?.deleted || (op.type === 'put' && previous && previous.seq >= op.seq)) continue;
        if (!previous && ++meta.count > MAX_RECORDS) this.fail(413, 'file_too_large');
        if (op.type === 'delete') await storage.put(key, { id: op.id, deleted: true });
        else await storage.put(key, { id: op.id, pid: op.pid, seq: op.seq, value: op.value, order: previous?.order || ++meta.order });
        changed = true;
      }
      if (changed) { meta.revision++; await storage.put(META_KEY, meta); }
    });
    return this.snapshot();
  }
  async snapshot() {
    const rows = await this.storage.list({ prefix: RECORD_PREFIX });
    const meta = await this.storage.get(META_KEY), entries = [], deleted = [];
    for (const row of rows.values()) { if (row.deleted) deleted.push(row.id); else entries.push(row); }
    entries.sort((a, b) => a.order - b.order);
    return { revision: meta?.revision || 0, entries, deleted };
  }
}
