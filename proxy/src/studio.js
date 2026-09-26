import { fetchCatalog, validOutputTokens } from './studio-models.js';
import { studioPage } from './studio-ui.js';
import { updateIndex } from './index.js';
import { SapixRecords, sapixCors } from './sapix-records.js';
import { SapixImport } from './sapix-import.js';

export const FOLDERS = Object.freeze({ source: '1xHRr5uA9idJP0H9BJcbldZiXdARDxCxi', practice: '1vaAx2_MJrjrqav8ySHxTsyTxrTbAIxxp', advanced: '1HVHjm0QceRgUjhYIAmI7kAfafrFjp-S0', html: '1vaAx2_MJrjrqav8ySHxTsyTxrTbAIxxp' });
const SPEC_VERSION = 'monthly-2026-09-20-v1';
const SESSION_SECONDS = 90 * 86400;
const TERMINAL = new Set(['completed', 'failed', 'needs_attention', 'cancelled']);
const encoder = new TextEncoder();
const errorText = {
  unauthorized: 'Googleでログインしてください。', forbidden: 'この操作は許可されていません。',
  not_configured: '初回のクラウド連携設定がまだ完了していません。', invalid_request: '入力を確認してください。',
  drive_reconnect: 'Google Driveの再接続が必要です。いったんログアウトしてGoogleで接続し直してください。',
  drive_unavailable: 'Google Driveを読み取れませんでした。時間をおいて再試行してください。',
  github_unavailable: 'クラウド処理の起動または公開に失敗しました。保存済みの処理は再開できます。',
  cancelled: '処理は停止されています。', latest_unavailable: '最新モデルを確認できません。モデルを明示的に選ぶか、後でお試しください。',
  existing_file: '同名の既存教材を保護するため公開を停止しました。', file_too_large: '生成HTMLが公開できる容量を超えています。',
  not_found: '対象が見つかりません。', source_changed: '選択したPDFが更新されています。一覧を読み直してください。',
  busy: '別の教材を処理しています。完了後に選択してください。', internal_error: '処理を完了できませんでした。保存済みの状態から再試行できます。',
  runner_conflict: '別のクラウド実行がこの処理を担当しています。',
  sapix_import_model: '最新の Claude Fable を確認できません。API の接続を確認して再試行してください。',
  sapix_import_scan: 'Drive の候補一覧を確認できませんでした。時間をおいて候補を更新してください。',
  sapix_import_parent: '資料の単元フォルダを一意に確認できませんでした。親フォルダを確認して候補を更新してください。',
  sapix_import_catalog: '追加問題のデータ形式を確認できないため、取り込みを保留しました。',
  sapix_import_scan_expired: '候補一覧の有効期限が切れました。候補を更新して選び直してください。',
  sapix_import_source_changed: '選択した資料が更新または移動されています。候補を更新して確認し直してください。',
  sapix_import_duplicate: '選択した資料はすでに取り込まれています。候補一覧を更新してください。',
  sapix_import_assets: '問題の元画像を確認できないため、公開を保留しました。',
  sapix_import_capacity: '一度に処理できる容量を超えています。資料を少なくして取り込んでください。',
  sapix_import_publishing: '保存した問題の公開を確認しています。この段階では取り消しできません。',
};
class StudioError extends Error { constructor(status, code, diagnostic) { super(code); this.status = status; this.code = code; if ((code === 'sapix_import_model' && /^models_[a-z0-9_]{1,60}$/.test(diagnostic || '')) || (code === 'sapix_import_scan' && /^scan_[a-z0-9_]{1,60}$/.test(diagnostic || ''))) this.diagnostic = diagnostic; } }
const fail = (status, code, diagnostic) => { throw new StudioError(status, code, diagnostic); };
const now = () => new Date().toISOString();
const result = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
const b64 = bytes => typeof bytes.toBase64 === 'function' ? bytes.toBase64() : btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
const unb64 = text => typeof Uint8Array.fromBase64 === 'function' ? Uint8Array.fromBase64(text) : Uint8Array.from(atob(text), b => b.charCodeAt(0));
const b64url = bytes => b64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const from64url = text => unb64(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - text.length % 4) % 4));
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const digest = async text => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
const cookie = (name, value, age) => `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${age}`;
function getCookie(request, name) { return (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1) || ''; }
async function key(secret) { return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(secret)), 'AES-GCM', false, ['encrypt', 'decrypt']); }
export async function seal(value, secret, purpose) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) }, await key(secret), encoder.encode(JSON.stringify(value)));
  return `${b64url(iv)}.${b64url(new Uint8Array(encrypted))}`;
}
export async function unseal(value, secret, purpose) {
  try {
    const [iv, encrypted] = value.split('.');
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64url(iv), additionalData: encoder.encode(purpose) }, await key(secret), from64url(encrypted));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; }
}
async function sameSecret(a, b) {
  if (!a || !b || a.length > 4096) return false;
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(a)), crypto.subtle.digest('SHA-256', encoder.encode(b))]);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(x, y);
  const xa = new Uint8Array(x), ya = new Uint8Array(y); let different = 0;
  for (let i = 0; i < xa.length; i++) different |= xa[i] ^ ya[i];
  return different === 0;
}
export async function readBody(request, limit = 512 * 1024) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '') || !request.body) fail(400, 'invalid_request');
  if (Number(request.headers.get('Content-Length')) > limit) fail(413, 'file_too_large');
  const reader = request.body.getReader(), chunks = []; let length = 0;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > limit) { await reader.cancel(); fail(413, 'file_too_large'); } chunks.push(decoder.decode(value, { stream: true })); }
    chunks.push(decoder.decode());
    const body = JSON.parse(chunks.join(''));
    if (!body || Array.isArray(body) || typeof body !== 'object') fail(400, 'invalid_request');
    return body;
  } catch (error) { if (error instanceof StudioError) throw error; fail(400, 'invalid_request'); }
  finally { reader.releaseLock(); }
}
function cleanMessage(value) {
  if (typeof value !== 'string') return '';
  return value.slice(0, 2000).replace(/(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|Bearer\s+\S+|ya29\.[A-Za-z0-9._-]+)/g, '[非表示]');
}
function publicJob(job) {
  const { id, fileId, fileName, source, model, status, stage, message, progress, createdAt, updatedAt, result: output, error, runId } = job;
  return { id, fileId, fileName, source, model, status, stage, message, progress, createdAt, updatedAt, result: output, error, runId };
}

export function handleStudio(request, env) {
  if (!env.STUDIO) return result({ error: 'not_configured', message: errorText.not_configured }, 503);
  return env.STUDIO.get(env.STUDIO.idFromName('owner')).fetch(request);
}

export class StudioState {
  constructor(ctx, env) { this.ctx = ctx; this.storage = ctx.storage; this.env = env; this.mutation = Promise.resolve(); this.sapix = new SapixRecords(this, { result, fail, random, digest, readBody }); this.sapixImport = new SapixImport(this, { result, fail, random, digest, readBody, sameSecret }); }
  async serial(action) {
    const previous = this.mutation; let release;
    this.mutation = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }
  configured() { return ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'STUDIO_SECRET', 'STUDIO_RUNNER_TOKEN', 'STUDIO_OWNER_EMAIL', 'GITHUB_TOKEN', 'OPENAI_API_KEY'].every(name => Boolean(this.env[name])); }
  async session(request) {
    const session = await unseal(getCookie(request, '__Host-studio'), this.env.STUDIO_SECRET || '', 'session');
    return session?.email === this.env.STUDIO_OWNER_EMAIL && session.expires > Date.now() ? session : null;
  }
  async fetch(request) {
    try { return await this.route(request); }
    catch (error) { const safe = error instanceof StudioError ? error : new StudioError(500, 'internal_error'); return result({ error: safe.code, message: errorText[safe.code], ...(safe.diagnostic ? { diagnostic: safe.diagnostic } : {}) }, safe.status, new URL(request.url).pathname.startsWith('/api/sapix/') ? sapixCors(request, this.env) : {}); }
  }
  async route(request) {
    const url = new URL(request.url), path = url.pathname.replace(/\/$/, ''), method = request.method;
    if (path === '/studio/sapix-import' || path.startsWith('/studio/api/sapix-import') || path.startsWith('/studio/runner/sapix-import/')) return this.sapixImport.route(request, url, path);
    if (path.startsWith('/api/sapix/')) return this.sapix.route(request, url, path);
    if (path === '/studio' && method === 'GET') return new Response(studioPage(), { headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    } });
    if (path === '/api/studio/google/start' && method === 'GET') return this.oauthStart(null, url.searchParams.get('return') === 'sapix-import' ? '/studio/sapix-import' : null);
    if (path === '/api/studio/google/callback' && method === 'GET') return this.oauthCallback(request, url);
    if (path.startsWith('/api/studio/runner/')) {
      if (!await sameSecret(request.headers.get('Authorization')?.replace(/^Bearer /, ''), this.env.STUDIO_RUNNER_TOKEN)) fail(401, 'unauthorized');
      return this.runner(request, path, method);
    }
    const session = await this.session(request);
    if (path === '/api/studio/session' && method === 'GET') return result({ authenticated: Boolean(session), configured: this.configured(), ...(session ? { email: session.email, csrf: session.csrf } : {}) });
    if (!session) fail(401, 'unauthorized');
    if (!['GET', 'HEAD'].includes(method)) {
      if (request.headers.get('Origin') !== this.env.STUDIO_ORIGIN || !await sameSecret(request.headers.get('x-studio-csrf'), session.csrf)) fail(403, 'forbidden');
    }
    if (path === '/api/studio/logout' && method === 'POST') return result({ ok: true }, 200, { 'Set-Cookie': cookie('__Host-studio', '', 0) });
    if (path === '/api/studio/sources' && method === 'GET') return result({ files: await this.sources() });
    if (path === '/api/studio/models' && method === 'GET') return result(await this.catalog());
    if (path === '/api/studio/jobs' && method === 'GET') { await this.reconcile(); return result({ jobs: (await this.jobs()).map(publicJob) }); }
    if (path === '/api/studio/jobs' && method === 'POST') { const body = await readBody(request); return this.serial(async () => result({ job: publicJob(await this.createJob(body)) })); }
    const match = /^\/api\/studio\/jobs\/([a-zA-Z0-9-]+)(?:\/(cancel|retry))?$/.exec(path);
    if (match) {
      const job = await this.job(match[1]);
      if (!match[2] && method === 'GET') { await this.reconcile(job); return result({ job: publicJob(await this.job(job.id)) }); }
      if (method === 'POST') return this.serial(async () => {
        const current = await this.job(job.id);
        if (match[2] === 'cancel' && !['completed', 'cancelled'].includes(current.status)) {
          current.status = 'cancelled'; current.dispatchUncertain = false; current.retryable = false; current.message = '停止しました。'; current.updatedAt = now(); await this.saveJob(current);
          if (current.runId) await this.github(`actions/runs/${current.runId}/cancel`, 'POST').catch(() => {});
        } else if (match[2] === 'retry' && ['failed', 'needs_attention'].includes(current.status)) {
          if ((await this.jobs()).some(j => !TERMINAL.has(j.status) && j.id !== current.id)) fail(409, 'busy');
          const runs = (await this.github('actions/workflows/monthly-pdf.yml/runs?per_page=100')).workflow_runs || [];
          const existing = runs.find(run => run.display_title === `monthly-${current.id}` && run.status !== 'completed');
          if (existing) {
            current.runId = String(existing.id); current.status = existing.status === 'in_progress' ? 'running' : 'queued'; current.error = null;
            current.updatedAt = now(); await this.saveJob(current); return result({ job: publicJob(current) });
          }
          // A network timeout may hide a successful dispatch. Allow GitHub time to expose it.
          if (current.dispatchUncertain && Date.now() - Date.parse(current.dispatchedAt) < 15 * 60000) return result({ job: publicJob(current) });
          current.status = 'queued'; current.retryable = false; current.autoAttempts = 0; current.error = null; current.runId = null; current.message = '保存済みの処理から再開します。'; current.updatedAt = now();
          await this.saveJob(current); await this.dispatch(current);
        }
        return result({ job: publicJob(current) });
      });
    }
    fail(404, 'not_found');
  }
  async oauthStart(sapix = null, returnTo = null) {
    if (sapix ? !this.sapix.configured() : !this.configured()) fail(503, 'not_configured');
    const state = random(), verifier = random();
    const clientId = sapix ? this.env.SAPIX_GOOGLE_CLIENT_ID : this.env.GOOGLE_CLIENT_ID;
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({ client_id: clientId, redirect_uri: `${this.env.STUDIO_ORIGIN}/api/studio/google/callback`, response_type: 'code', scope: sapix ? 'openid email' : 'openid email https://www.googleapis.com/auth/drive', ...(sapix ? (this.sapix.ownerEmail() !== this.env.STUDIO_OWNER_EMAIL ? { prompt: 'select_account' } : {}) : { access_type: 'offline', prompt: 'consent' }), state, code_challenge: await digest(verifier), code_challenge_method: 'S256', login_hint: sapix ? this.sapix.ownerEmail() : this.env.STUDIO_OWNER_EMAIL }).toString();
    const value = await seal({ state, verifier, expires: Date.now() + 600000, ...(sapix ? { sapix: { ...sapix, email: this.sapix.ownerEmail(), clientId } } : {}), ...(returnTo === '/studio/sapix-import' ? { returnTo } : {}) }, this.env.STUDIO_SECRET, 'oauth');
    return new Response(null, { status: 302, headers: { Location: auth.href, 'Set-Cookie': cookie('__Host-studio-oauth', value, 600), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }
  async oauthCallback(request, url) {
    const value = await unseal(getCookie(request, '__Host-studio-oauth'), this.env.STUDIO_SECRET || '', 'oauth');
    if (!value || value.expires < Date.now() || !await sameSecret(value.state, url.searchParams.get('state')) || !url.searchParams.get('code')) fail(403, 'forbidden');
    if (value.sapix && !this.sapix.configured()) fail(503, 'not_configured');
    if (value.sapix && (!value.sapix.email || value.sapix.email !== this.sapix.ownerEmail() || !value.sapix.clientId || value.sapix.clientId !== this.env.SAPIX_GOOGLE_CLIENT_ID)) fail(403, 'forbidden');
    const clientId = value.sapix ? this.env.SAPIX_GOOGLE_CLIENT_ID : this.env.GOOGLE_CLIENT_ID;
    const clientSecret = value.sapix ? this.env.SAPIX_GOOGLE_CLIENT_SECRET : this.env.GOOGLE_CLIENT_SECRET;
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: url.searchParams.get('code'), code_verifier: value.verifier, redirect_uri: `${this.env.STUDIO_ORIGIN}/api/studio/google/callback`, grant_type: 'authorization_code' }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) fail(401, value.sapix ? 'unauthorized' : 'drive_reconnect');
    const token = await response.json();
    const identityResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(15000) });
    if (!identityResponse.ok) fail(401, 'unauthorized');
    const identity = await identityResponse.json();
    if (!identity.email_verified || identity.email !== (value.sapix ? value.sapix.email : this.env.STUDIO_OWNER_EMAIL)) fail(403, 'forbidden');
    if (value.sapix) {
      const response = await this.sapix.issueCode(value.sapix, identity.email);
      response.headers.append('Set-Cookie', cookie('__Host-studio-oauth', '', 0));
      return response;
    }
    const previous = await unseal(await this.storage.get('google') || '', this.env.STUDIO_SECRET, 'google');
    const refreshToken = token.refresh_token || previous?.refreshToken;
    if (!refreshToken || !String(token.scope || '').split(' ').includes('https://www.googleapis.com/auth/drive')) fail(401, 'drive_reconnect');
    await this.storage.put('google', await seal({ refreshToken, email: identity.email }, this.env.STUDIO_SECRET, 'google'));
    this.access = { accessToken: token.access_token, expires: Date.now() + token.expires_in * 1000 };
    const session = await seal({ email: identity.email, csrf: random(), expires: Date.now() + SESSION_SECONDS * 1000 }, this.env.STUDIO_SECRET, 'session');
    const headers = new Headers({ Location: value.returnTo === '/studio/sapix-import' ? value.returnTo : '/studio', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    headers.append('Set-Cookie', cookie('__Host-studio', session, SESSION_SECONDS)); headers.append('Set-Cookie', cookie('__Host-studio-oauth', '', 0));
    return new Response(null, { status: 302, headers });
  }
  async accessToken() {
    if (this.access?.expires > Date.now() + 120000) return { accessToken: this.access.accessToken, expiresIn: Math.floor((this.access.expires - Date.now()) / 1000) };
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const saved = await unseal(await this.storage.get('google') || '', this.env.STUDIO_SECRET, 'google');
      if (!saved?.refreshToken) fail(401, 'drive_reconnect');
      const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.env.GOOGLE_CLIENT_ID, client_secret: this.env.GOOGLE_CLIENT_SECRET, refresh_token: saved.refreshToken, grant_type: 'refresh_token' }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) fail(401, 'drive_reconnect');
      const token = await response.json();
      this.access = { accessToken: token.access_token, expires: Date.now() + token.expires_in * 1000 };
      return { accessToken: token.access_token, expiresIn: token.expires_in };
    })();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }
  async drive(path, params = {}) {
    const token = await this.accessToken();
    const url = new URL(`https://www.googleapis.com/drive/v3/${path}`); url.search = new URLSearchParams(params).toString();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token.accessToken}` }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) fail(response.status === 401 ? 401 : 502, response.status === 401 ? 'drive_reconnect' : 'drive_unavailable');
    return response.json();
  }
  async sources() {
    // Only the selected source tree; generated folders are never recursively ingested.
    const folders = [FOLDERS.source], seen = new Set(), files = [];
    while (folders.length) {
      const parent = folders.shift(); if (seen.has(parent) || [FOLDERS.practice, FOLDERS.advanced].includes(parent)) continue;
      seen.add(parent); if (seen.size > 30) fail(502, 'drive_unavailable');
      let pageToken;
      do {
        const page = await this.drive('files', { q: `'${parent}' in parents and trashed = false and (mimeType = 'application/pdf' or mimeType = 'application/vnd.google-apps.folder')`, fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum,parents)', pageSize: '1000', ...(pageToken ? { pageToken } : {}) });
        for (const file of page.files || []) { if (file.mimeType === 'application/vnd.google-apps.folder') folders.push(file.id); else files.push(file); }
        pageToken = page.nextPageToken;
      } while (pageToken);
    }
    files.sort((a, b) => b.name.localeCompare(a.name, 'ja', { numeric: true }));
    return files;
  }
  async catalog() {
    const previous = await this.storage.get('catalog-v2');
    // Refresh older catalog-v2 entries once so capacity is always grounded in
    // the same capability document that made a model selectable.
    const capacityKnown = Array.isArray(previous?.models) && previous.models.every(model => validOutputTokens(model.maxOutputTokens));
    if (previous && capacityKnown && Date.now() - Date.parse(previous.checkedAt) < (previous.latestVerified ? 3600000 : 30000)) return previous;
    if (this.catalogPromise) return this.catalogPromise;
    this.catalogPromise = fetchCatalog({ apiKey: this.env.OPENAI_API_KEY, previous }).then(async catalog => { await this.storage.put('catalog-v2', catalog); return catalog; });
    try { return await this.catalogPromise; } finally { this.catalogPromise = null; }
  }
  async jobs() { return [...(await this.storage.list({ prefix: 'job:' })).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async job(id) { const job = await this.storage.get(`job:${id}`); if (!job) fail(404, 'not_found'); return job; }
  async saveJob(job) {
    await this.storage.put(`job:${job.id}`, job);
    if (!TERMINAL.has(job.status) || job.retryable || job.dispatchUncertain) await this.scheduleCheck();
  }
  async scheduleCheck(delay = 5 * 60000) {
    if (!this.storage.setAlarm) return; // Unit-test storage adapters do not run timers.
    const due = Date.now() + delay, previous = await this.storage.getAlarm();
    if (!previous || previous > due) await this.storage.setAlarm(due);
  }
  async alarm() {
    await this.sapixImport.alarm().catch(() => {});
    // Durable alarms continue recovery even with every browser closed.
    try {
      await this.reconcile();
      for (const snapshot of await this.jobs()) {
        if (!snapshot.retryable && !snapshot.dispatchUncertain) continue;
        await this.serial(async () => {
          const job = await this.job(snapshot.id);
          if (!['failed', 'needs_attention'].includes(job.status) || (!job.retryable && !job.dispatchUncertain)) return;
          if (!job.continuation && (job.autoAttempts || 0) >= 3) { job.retryable = false; job.dispatchUncertain = false; job.error = '自動再試行を3回行いました。接続状況を確認して「再開」を押してください。'; await this.saveJob(job); return; }
          if (Date.now() - Date.parse(job.updatedAt) < 60000 || (job.dispatchUncertain && Date.now() - Date.parse(job.dispatchedAt) < 15 * 60000)) return;
          if (job.runId) {
            const ownerRun = await this.github(`actions/runs/${job.runId}`);
            if (ownerRun.status !== 'completed') return;
          }
          const runs = (await this.github('actions/workflows/monthly-pdf.yml/runs?per_page=100')).workflow_runs || [];
          const live = runs.find(run => run.display_title === `monthly-${job.id}` && run.status !== 'completed');
          if (live) return;
          if ((await this.jobs()).some(other => other.id !== job.id && !TERMINAL.has(other.status))) return;
          if (!job.continuation) job.autoAttempts = (job.autoAttempts || 0) + 1;
          job.status = 'queued'; job.retryable = false; job.continuation = false; job.runId = null; job.error = null; job.updatedAt = now();
          job.message = '保存済みの段階からクラウド処理を自動で再開しています。';
          await this.saveJob(job); await this.dispatch(job);
        }).catch(() => { /* A provider outage for one job must not prevent other resumable jobs. */ });
      }
    } finally {
      if ((await this.jobs()).some(job => !TERMINAL.has(job.status) || job.retryable || job.dispatchUncertain)) await this.scheduleCheck();
    }
  }
  async createJob(body) {
    if (typeof body.fileId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(body.fileId)) fail(400, 'invalid_request');
    const source = (await this.sources()).find(file => file.id === body.fileId);
    if (!source) fail(404, 'not_found');
    const catalog = await this.catalog();
    const model = !body.model || body.model === 'auto' ? (catalog.latestVerified ? catalog.defaultModel : null) : body.model;
    const selectedModel = catalog.models.find(candidate => candidate.id === model && validOutputTokens(candidate.maxOutputTokens));
    if (!model || !selectedModel) fail(409, 'latest_unavailable');
    const fingerprint = await digest(JSON.stringify([source.id, source.md5Checksum || source.modifiedTime, model, SPEC_VERSION]));
    const jobs = await this.jobs(), duplicate = jobs.find(job => job.fingerprint === fingerprint && job.status !== 'cancelled');
    if (duplicate) return duplicate;
    if (jobs.some(job => !TERMINAL.has(job.status))) fail(409, 'busy');
    const job = { id: crypto.randomUUID(), fileId: source.id, fileName: source.name, source, model, modelMaxOutputTokens: selectedModel.maxOutputTokens, folders: FOLDERS, specVersion: SPEC_VERSION, fingerprint, status: 'queued', stage: 'queued', progress: 0, message: 'クラウド処理の開始を待っています。', createdAt: now(), updatedAt: now(), runId: null, result: null, error: null };
    await this.saveJob(job); await this.dispatch(job); return job;
  }
  async github(path, method = 'GET', body, allow = []) {
    const response = await fetch(`https://api.github.com/repos/${this.env.REPO}/${path}`, { method, headers: { Authorization: `Bearer ${this.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'math-app-studio', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000) });
    if (allow.includes(response.status)) return { httpStatus: response.status };
    if (!response.ok) fail(502, 'github_unavailable');
    return response.status === 204 ? {} : response.json();
  }
  async dispatch(job) {
    // Save queued before dispatch. An uncertain dispatch is reconciled by run-name, never blindly replayed.
    job.dispatchedAt = now(); job.dispatchUncertain = false; await this.saveJob(job);
    try { await this.github('actions/workflows/monthly-pdf.yml/dispatches', 'POST', { ref: this.env.BRANCH, inputs: { job_id: job.id } }); }
    catch { job.dispatchUncertain = true; job.status = 'needs_attention'; job.error = 'クラウド処理の起動を確認しています。重複実行を防いで自動的に再開します。'; job.updatedAt = now(); await this.saveJob(job); }
  }
  async reconcile(onlyJob = null) {
    const jobs = onlyJob ? [onlyJob] : await this.jobs();
    const candidates = jobs.filter(job => (['queued', 'running'].includes(job.status) || job.dispatchUncertain) && Date.now() - Date.parse(job.updatedAt) > 120000);
    if (!candidates.length) return;
    let runs;
    try { runs = (await this.github('actions/workflows/monthly-pdf.yml/runs?per_page=50')).workflow_runs || []; } catch { return; }
    for (const candidate of candidates) await this.serial(async () => {
      const job = await this.job(candidate.id);
      if ((!['queued', 'running'].includes(job.status) && !job.dispatchUncertain) || Date.now() - Date.parse(job.updatedAt) <= 120000) return;
      let run = runs.find(run => job.runId ? String(run.id) === job.runId : run.display_title === `monthly-${job.id}`);
      if (!run && job.runId) { try { run = await this.github(`actions/runs/${job.runId}`); } catch { return; } }
      if (run) {
        job.runId = String(run.id);
        job.dispatchUncertain = false;
        if (run.status === 'completed') { job.status = 'failed'; job.retryable = true; job.error = 'クラウド実行が中断しました。保存済みの段階から自動で再開します。'; job.updatedAt = now(); }
        else if (job.status === 'needs_attention') { job.status = run.status === 'in_progress' ? 'running' : 'queued'; job.error = null; job.updatedAt = now(); }
      } else if (Date.now() - Date.parse(job.updatedAt) > 15 * 60000) { job.status = 'failed'; job.retryable = true; job.error = 'クラウド処理の開始を確認できません。保存済みの処理から自動で再開します。'; job.updatedAt = now(); }
      await this.saveJob(job);
    });
  }
  async runner(request, path, method) {
    if (path === '/api/studio/runner/drive-token' && method === 'GET') return result(await this.accessToken());
    const match = /^\/api\/studio\/runner\/jobs\/([a-zA-Z0-9-]+)(?:\/(publish|checkpoints)(?:\/([a-zA-Z0-9_.-]{1,180}))?)?$/.exec(path);
    if (!match) fail(404, 'not_found');
    const job = await this.job(match[1]);
    if (!match[2] && method === 'GET') {
      if (!validOutputTokens(job.modelMaxOutputTokens)) {
        const catalog = await this.catalog();
        const selectedModel = catalog.models.find(candidate => candidate.id === job.model && validOutputTokens(candidate.maxOutputTokens));
        // Enrich the response without writing a stale job snapshot over a
        // cancellation or progress update received during catalog refresh.
        const current = await this.job(job.id);
        if (selectedModel && current.model === job.model) return result({ job: { ...current, modelMaxOutputTokens: selectedModel.maxOutputTokens } });
        return result({ job: current });
      }
      return result({ job });
    }
    if (job.status === 'cancelled') fail(409, 'cancelled');
    const runId = request.headers.get('X-Studio-Run-Id');
    if (!runId || !/^\d+$/.test(runId)) fail(409, 'runner_conflict');
    const claiming = !match[2] && method === 'PATCH';
    if ((!job.runId && !claiming) || (job.runId && job.runId !== runId)) fail(409, 'runner_conflict');
    if (match[2] === 'publish' && method === 'POST') { const body = await readBody(request, 34 * 1024 * 1024); return this.serial(() => this.publish(job.id, body, runId)); }
    if (match[2] === 'checkpoints' && match[3]) {
      const checkpointKey = `checkpoint:${job.id}:${match[3]}`;
      if (method === 'GET') {
        const metadata = await this.storage.get(checkpointKey);
        if (!metadata) return result({ value: null });
        const parts = await this.storage.get(Array.from({ length: metadata.parts }, (_, i) => `${checkpointKey}:${metadata.version}:${i}`));
        return result({ value: JSON.parse(Array.from({ length: metadata.parts }, (_, i) => parts.get(`${checkpointKey}:${metadata.version}:${i}`)).join('')) });
      }
      if (method === 'PUT') {
        const body = await readBody(request), text = JSON.stringify(body.value ?? null), version = crypto.randomUUID(), chunks = {};
        for (let i = 0; i * 20000 < text.length; i++) chunks[`${checkpointKey}:${version}:${i}`] = text.slice(i * 20000, (i + 1) * 20000);
        await this.storage.transaction(async txn => {
          const current = await txn.get(`job:${job.id}`);
          if (current?.status === 'cancelled') fail(409, 'cancelled');
          if (!current || current.runId !== runId) fail(409, 'runner_conflict');
          const previous = await txn.get(checkpointKey);
          await txn.put(chunks); await txn.put(checkpointKey, { parts: Object.keys(chunks).length, version });
          if (previous) await txn.delete(Array.from({ length: previous.parts }, (_, i) => `${checkpointKey}:${previous.version}:${i}`));
        });
        return result({ ok: true });
      }
    }
    if (!match[2] && method === 'PATCH') {
      const body = await readBody(request);
      return this.serial(async () => {
        const current = await this.job(job.id); if (current.status === 'cancelled') fail(409, 'cancelled');
        if (current.runId && current.runId !== runId) fail(409, 'runner_conflict');
        if (!current.runId && (body.status !== 'running' || String(body.runId) !== runId)) fail(409, 'runner_conflict');
        if (current.status === 'completed' && body.status !== 'completed') fail(409, 'runner_conflict');
        if (body.status && !['queued', 'running', 'needs_attention', 'failed', 'completed'].includes(body.status)) fail(400, 'invalid_request');
        for (const name of ['stage', 'message', 'error']) if (body[name] !== undefined) current[name] = cleanMessage(body[name]);
        if (body.status) current.status = body.status;
        if (typeof body.retryable === 'boolean') current.retryable = body.retryable;
        if (typeof body.continuation === 'boolean') current.continuation = body.continuation;
        if (['completed', 'needs_attention'].includes(current.status) && !current.dispatchUncertain) current.retryable = false;
        if (Number.isFinite(body.progress)) current.progress = Math.max(0, Math.min(100, body.progress));
        current.runId = runId; current.dispatchUncertain = false;
        if (body.result && encoder.encode(JSON.stringify(body.result)).length < 32000) current.result = body.result;
        current.updatedAt = now(); await this.saveJob(current); return result({ job: current });
      });
    }
    fail(404, 'not_found');
  }
  async publish(id, body, runId) {
    const job = await this.job(id); if (job.status === 'cancelled') fail(409, 'cancelled');
    if (!runId || job.runId !== runId) fail(409, 'runner_conflict');
    const filename = body.fileName, base = job.source.name.replace(/\.pdf$/i, '');
    if (![`${base}‗日日の演習_講義アニメーション.html`, `${base}‗発展演習+学力コンテスト_講義アニメーション.html`].includes(filename)) fail(400, 'invalid_request');
    if (encoder.encode(filename).length > 255 || /[\\/\u0000-\u001f]/.test(filename)) fail(400, 'invalid_request');
    const content = body.contentBase64;
    if (typeof content !== 'string' || content.length > 4 * Math.ceil(24 * 1024 * 1024 / 3)) fail(413, 'file_too_large');
    // Chunked native decoding validates UTF-8 without retaining a second HTML copy.
    const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
    if (content.length % 4 || /[^A-Za-z0-9+/=]/.test(content) || content.indexOf('=') !== (padding ? content.length - padding : -1)) fail(400, 'invalid_request');
    if (padding) {
      const bits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(content.at(-padding - 1));
      if (bits < 0 || (bits & (padding === 2 ? 15 : 3))) fail(400, 'invalid_request');
    }
    const decoder = new TextDecoder('utf-8', { fatal: true }); let prefix = '';
    try { for (let i = 0; i < content.length; i += 65536) { const decoded = decoder.decode(unb64(content.slice(i, i + 65536)), { stream: true }); if (!i) prefix = decoded; } decoder.decode(); } catch { fail(400, 'invalid_request'); }
    if (!/<!doctype html/i.test(prefix) || !prefix.includes('math-app-generated-lesson')) fail(400, 'invalid_request');
    const path = `math/${filename}`, ownershipKey = `published:${await digest(path)}`;
    const owner = await this.storage.get(ownershipKey);
    for (let attempt = 0; attempt < 4; attempt++) {
      const reference = await this.github(`git/ref/heads/${this.env.BRANCH}`);
      const head = await this.github(`git/commits/${reference.object.sha}`);
      const tree = await this.github(`git/trees/${head.tree.sha}?recursive=1`);
      if (tree.truncated) fail(502, 'github_unavailable');
      const existing = tree.tree.find(entry => entry.path === path);
      if (existing && (owner?.sourceId !== job.source.id || ![owner.blob, owner.previousBlob].includes(existing.sha))) fail(409, 'existing_file');
      const indexEntry = tree.tree.find(entry => entry.path === 'math/index.html'); if (!indexEntry) fail(502, 'github_unavailable');
      const indexBlob = await this.github(`git/blobs/${indexEntry.sha}`);
      const html = new TextDecoder('utf-8', { fatal: true }).decode(unb64(indexBlob.content.replace(/\s/g, '')));
      const updated = updateIndex(html, { filename, folder: 'math' }, filename.replace(/\.html$/, ''));
      const blob = await this.github('git/blobs', 'POST', { encoding: 'base64', content });
      // Record ownership before branch mutation, so a dropped response can be retried safely.
      await this.storage.put(ownershipKey, { sourceId: job.source.id, jobId: job.id, blob: blob.sha, previousBlob: existing?.sha || null });
      if (existing?.sha === blob.sha && updated === html) return result({ path, url: `https://iwslatojp29.github.io/math-app/math/${encodeURIComponent(filename)}`, commitSha: reference.object.sha });
      const index = await this.github('git/blobs', 'POST', { encoding: 'utf-8', content: updated });
      const nextTree = await this.github('git/trees', 'POST', { base_tree: head.tree.sha, tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }, { path: 'math/index.html', mode: '100644', type: 'blob', sha: index.sha }] });
      const commit = await this.github('git/commits', 'POST', { message: `Publish generated lesson: ${filename}`, tree: nextTree.sha, parents: [reference.object.sha] });
      const changed = await this.github(`git/refs/heads/${this.env.BRANCH}`, 'PATCH', { sha: commit.sha, force: false }, [409, 422]);
      if (!changed.httpStatus) return result({ path, url: `https://iwslatojp29.github.io/math-app/math/${encodeURIComponent(filename)}`, commitSha: commit.sha });
    }
    fail(502, 'github_unavailable');
  }
}
