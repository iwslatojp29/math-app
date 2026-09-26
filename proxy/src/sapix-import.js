import { sapixImportPage } from './sapix-import-ui.js';
import generatedProblems from '../../sapix/generated-problems.js';

export const SAPIX_IMPORT_FOLDER = '1f1AhUw8Yciyye8V1_eZbvTBGlpQU0EyO';
export const SAPIX_IMPORT_SINCE = '2026-09-23T15:00:00Z';
const JOB = 'sapix-import:job:', SCAN = 'sapix-import:scan:', SCAN_DATA = 'sapix-import:scan-data:';
const CATALOG_PATH = 'sapix/problems/generated.json';
const WORKFLOW = 'sapix-import.yml';
const TERMINAL = new Set(['completed', 'failed', 'needs_attention', 'cancelled']);
const MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const FILE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const ASSET = /^assets\/drive\/([A-Za-z0-9_-]{1,160})\/([a-f0-9]{64})\.(png|jpg|jpeg|webp)$/;
const MAX_ASSET = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const now = () => new Date().toISOString();
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, required) => object(value) && Object.keys(value).length === required.length && required.every(key => Object.hasOwn(value, key));
const safeMessage = value => typeof value === 'string' ? value.slice(0, 2000).replace(/(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+|ya29\.[A-Za-z0-9._-]+)/gi, '[非表示]') : '';
const decode = value => Uint8Array.from(atob(value.replace(/\s/g, '')), character => character.charCodeAt(0));
const encode = value => { let binary = ''; const bytes = encoder.encode(value); for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192)); return btoa(binary); };
const emptyCatalog = () => ({ schemaVersion: 1, sources: [], problems: [] });
const publicJob = job => ({ id: job.id, status: job.status, stage: job.stage, message: job.message, error: job.error, progress: job.progress, model: job.model, files: job.files.map(({ id, name }) => ({ id, name })), createdAt: job.createdAt, updatedAt: job.updatedAt, recovering: Boolean(job.retryable || job.dispatchUncertain), result: job.status === 'completed' ? job.result || null : null });

// Data only: the frontend performs the same strict schema validation before
// constructing DOM. No generated JavaScript or HTML is accepted for publishing.
export function validSapixCatalog(value) {
  try { generatedProblems.validateCatalog(value); return encoder.encode(JSON.stringify(value)).length <= 8 * 1024 * 1024; } catch { return false; }
}

export class SapixImport {
  constructor(owner, helpers) { this.owner = owner; this.storage = owner.storage; this.env = owner.env; Object.assign(this, helpers); }
  async route(request, url, path) {
    if (path === '/studio/sapix-import' && request.method === 'GET') return new Response(sapixImportPage(), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'" } });
    if (path.startsWith('/studio/runner/sapix-import/')) {
      if (!await this.sameSecret(request.headers.get('Authorization')?.replace(/^Bearer /, ''), this.env.STUDIO_RUNNER_TOKEN)) this.fail(401, 'unauthorized');
      return this.runner(request, path);
    }
    const session = await this.owner.session(request);
    if (!session) this.fail(401, 'unauthorized');
    if (request.method !== 'GET' && (request.headers.get('Origin') !== this.env.STUDIO_ORIGIN || !await this.sameSecret(request.headers.get('x-studio-csrf'), session.csrf))) this.fail(403, 'forbidden');
    const base = '/studio/api/sapix-import';
    if (path === base + '/candidates' && request.method === 'GET') return this.result(await this.scan());
    if (path === base + '/jobs' && request.method === 'GET') { await this.reconcilePublications(); return this.result({ jobs: (await this.jobs()).map(publicJob) }); }
    if (path === base + '/jobs' && request.method === 'POST') { const body = await this.readBody(request, 16000); return this.owner.serial(async () => this.result({ job: publicJob(await this.createJob(body)) })); }
    const match = /^\/studio\/api\/sapix-import\/jobs\/([A-Za-z0-9-]+)(?:\/(cancel|retry))?$/.exec(path);
    if (match && !match[2] && request.method === 'GET') { await this.reconcilePublications(match[1]); return this.result({ job: publicJob(await this.job(match[1])) }); }
    if (match && request.method === 'POST' && match[2]) return this.owner.serial(async () => {
      const job = await this.job(match[1]);
      if (job.result && match[2] === 'cancel' && job.status !== 'completed') this.fail(409, 'sapix_import_publishing');
      if (job.result && match[2] === 'retry') { job.status = 'publishing'; job.publicationStartedAt = now(); job.publicationCheckedAt = null; job.error = null; await this.save(job); await this.checkPublication(job); return this.result({ job: publicJob(job) }); }
      if (match[2] === 'cancel' && job.status !== 'completed') { job.status = 'cancelled'; job.retryable = false; job.dispatchUncertain = false; job.message = '取り込みを停止しました。'; await this.save(job); if (job.runId) await this.owner.github(`actions/runs/${job.runId}/cancel`, 'POST').catch(() => {}); }
      if (match[2] === 'retry' && ['failed', 'needs_attention'].includes(job.status)) { if ((await this.jobs()).some(other => other.id !== job.id && (!TERMINAL.has(other.status) || other.retryable || other.dispatchUncertain))) this.fail(409, 'busy'); if (await this.liveRun(job)) this.fail(409, 'busy'); if (job.dispatchUncertain && Date.now() - Date.parse(job.dispatchedAt) < 900000) this.fail(409, 'busy'); job.status = 'queued'; job.runId = null; job.error = null; job.retryable = false; job.autoAttempts = 0; await this.save(job); await this.dispatch(job); }
      return this.result({ job: publicJob(job) });
    });
    this.fail(404, 'not_found');
  }
  async catalog() {
    let file = await this.owner.github(`contents/${CATALOG_PATH}?ref=${encodeURIComponent(this.env.BRANCH)}`, 'GET', undefined, [404]);
    if (file.httpStatus === 404) return emptyCatalog();
    // Contents responses omit base64 content above 1 MiB. The blob endpoint
    // retains the same immutable revision and supports the full catalog limit.
    if (file.encoding === 'none' && /^[a-f0-9]{40}$/.test(file.sha || '')) file = await this.owner.github(`git/blobs/${file.sha}`);
    try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(file.content))); if (!validSapixCatalog(value)) throw new Error(); return value; } catch { this.fail(409, 'sapix_import_catalog'); }
  }
  async model() {
    const cached = await this.storage.get('sapix-import:model');
    if (cached?.checkedAt > Date.now() - 900000) return cached.model;
    if (!this.env.ANTHROPIC_API_KEY) this.fail(503, 'sapix_import_model');
    const models = []; let after;
    try {
      for (let page = 0; page < 10; page++) {
        const url = new URL('https://api.anthropic.com/v1/models'); url.searchParams.set('limit', '100'); if (after) url.searchParams.set('after_id', after);
        const response = await fetch(url, { headers: { 'x-api-key': this.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(); const body = await response.json(); if (!Array.isArray(body.data)) throw new Error();
        models.push(...body.data.filter(item => /^claude-fable-\d[A-Za-z0-9-]*$/.test(item.id || '') && Number.isFinite(Date.parse(item.created_at))));
        if (!body.has_more) { after = null; break; } if (!body.last_id || body.last_id === after) throw new Error(); after = body.last_id;
      }
      if (after || !models.length) throw new Error();
      models.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id, 'en', { numeric: true }));
      const model = { id: models[0].id, name: safeMessage(models[0].display_name) || models[0].id };
      await this.storage.put('sapix-import:model', { model, checkedAt: Date.now() }); return model;
    } catch { this.fail(503, 'sapix_import_model'); }
  }
  async fingerprint(file) { return this.digest(JSON.stringify([file.id, file.name, file.mimeType, file.md5Checksum || null, file.createdTime, file.modifiedTime, String(file.size || ''), [...(file.parents || [])].sort()])); }
  async files() {
    const queue = [{ id: SAPIX_IMPORT_FOLDER, path: '' }], seen = new Set(), files = [];
    while (queue.length) {
      const folder = queue.shift(); if (seen.has(folder.id)) continue; seen.add(folder.id); if (seen.size > 1000) this.fail(413, 'sapix_import_capacity');
      let pageToken; const pages = new Set();
      do {
        const data = await this.owner.drive('files', { q: `'${folder.id}' in parents and trashed = false`, fields: 'nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,size,md5Checksum,parents)', pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', ...(pageToken ? { pageToken } : {}) });
        for (const file of data.files || []) {
          if (!FILE_ID.test(file.id)) continue;
          if (file.mimeType === 'application/vnd.google-apps.folder') queue.push({ id: file.id, path: [folder.path, file.name].filter(Boolean).join('/') });
          else if (MIME.has(file.mimeType) && Date.parse(file.createdTime) >= Date.parse(SAPIX_IMPORT_SINCE)) files.push({ ...file, unitPath: folder.path, fingerprint: await this.fingerprint(file) });
        }
        pageToken = data.nextPageToken; if (pageToken && pages.has(pageToken)) this.fail(502, 'drive_unavailable'); if (pageToken) pages.add(pageToken);
      } while (pageToken);
    }
    return files.sort((a, b) => a.createdTime.localeCompare(b.createdTime) || a.name.localeCompare(b.name, 'ja'));
  }
  async scan() {
    const [files, catalog, model] = await Promise.all([this.files(), this.catalog(), this.model()]);
    const imported = new Set(catalog.sources.map(source => source.fileId));
    const candidates = files.filter(file => !imported.has(file.id));
    const scanId = crypto.randomUUID(), content = JSON.stringify(candidates), chunks = {};
    for (let index = 0; index * 20000 < content.length; index++) chunks[`${SCAN_DATA}${scanId}:${index}`] = content.slice(index * 20000, (index + 1) * 20000);
    await this.storage.transaction(async transaction => { await transaction.put(chunks); await transaction.put(SCAN + scanId, { parts: Object.keys(chunks).length, model, expires: Date.now() + 1800000 }); });
    for (const [key, value] of await this.storage.list({ prefix: SCAN })) if (value.expires < Date.now()) { await this.storage.delete(Array.from({ length: value.parts }, (_, index) => SCAN_DATA + key.slice(SCAN.length) + ':' + index)); await this.storage.delete(key); }
    return { files: candidates.map(({ id, name, mimeType, createdTime, modifiedTime, size, unitPath }) => ({ id, name, mimeType, createdTime, modifiedTime, size, unitPath })), model, scanId };
  }
  async createJob(body) {
    if (!keys(body, ['scanId', 'fileIds']) || typeof body.scanId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.scanId) || !Array.isArray(body.fileIds) || !body.fileIds.length || body.fileIds.length > 10 || body.fileIds.some(id => !FILE_ID.test(id)) || new Set(body.fileIds).size !== body.fileIds.length) this.fail(400, 'invalid_request');
    const scan = await this.storage.get(SCAN + body.scanId); if (!scan || scan.expires < Date.now()) this.fail(409, 'sapix_import_scan_expired');
    const parts = await this.storage.get(Array.from({ length: scan.parts }, (_, index) => `${SCAN_DATA}${body.scanId}:${index}`));
    scan.files = JSON.parse(Array.from({ length: scan.parts }, (_, index) => parts.get(`${SCAN_DATA}${body.scanId}:${index}`)).join(''));
    const files = body.fileIds.map(id => scan.files.find(file => file.id === id)); if (files.some(file => !file)) this.fail(400, 'invalid_request');
    const fingerprint = await this.digest(JSON.stringify([scan.model.id, files.map(file => [file.id, file.fingerprint]).sort()]));
    const jobs = await this.jobs(), duplicate = jobs.find(job => job.fingerprint === fingerprint && job.status !== 'cancelled'); if (duplicate) return duplicate;
    if (jobs.some(job => !TERMINAL.has(job.status) || job.retryable || job.dispatchUncertain)) this.fail(409, 'busy');
    const catalog = await this.catalog(); if (files.some(file => catalog.sources.some(source => source.fileId === file.id))) this.fail(409, 'sapix_import_duplicate');
    // A current tree scan validates both the selected revision and folder membership.
    const current = await this.files();
    if (files.some(file => !current.some(item => item.id === file.id && item.fingerprint === file.fingerprint && item.unitPath === file.unitPath))) this.fail(409, 'sapix_import_source_changed');
    const job = { id: crypto.randomUUID(), fingerprint, files, folderId: SAPIX_IMPORT_FOLDER, cutoff: SAPIX_IMPORT_SINCE, model: scan.model, status: 'queued', stage: 'queued', message: '確認した資料の取り込みを開始します。', error: null, progress: 0, createdAt: now(), updatedAt: now(), runId: null, autoAttempts: 0, assets: {} };
    if (encoder.encode(JSON.stringify(job)).length > 64000) this.fail(413, 'sapix_import_capacity');
    await this.save(job); await this.dispatch(job); return job;
  }
  async jobs() { return [...(await this.storage.list({ prefix: JOB })).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async job(id) { const job = await this.storage.get(JOB + id); if (!job) this.fail(404, 'not_found'); return job; }
  async save(job) { job.updatedAt = now(); await this.storage.put(JOB + job.id, job); if (!TERMINAL.has(job.status) || job.retryable || job.dispatchUncertain) await this.owner.scheduleCheck(job.status === 'publishing' ? 60000 : undefined); }
  async dispatch(job) {
    job.dispatchedAt = now(); job.dispatchUncertain = false; await this.save(job);
    try { await this.owner.github(`actions/workflows/${WORKFLOW}/dispatches`, 'POST', { ref: this.env.BRANCH, inputs: { job_id: job.id } }); }
    catch { job.status = 'needs_attention'; job.dispatchUncertain = true; job.error = 'クラウド処理の開始を確認できません。重複実行を防ぎながら自動で再確認します。'; await this.save(job); }
  }
  async liveRun(job) {
    const runs = (await this.owner.github(`actions/workflows/${WORKFLOW}/runs?per_page=100`)).workflow_runs || [];
    return runs.find(run => run.display_title === 'sapix-import-' + job.id && run.status !== 'completed');
  }
  async alarm() {
    try {
      for (const snapshot of await this.jobs()) await this.owner.serial(async () => {
        let job = await this.job(snapshot.id); if (['cancelled', 'completed'].includes(job.status)) return;
        if (job.result) { if (job.status === 'publishing') await this.checkPublication(job); return; }
        if (Date.now() - Date.parse(job.updatedAt) < 120000) return;
        if (job.dispatchUncertain && Date.now() - Date.parse(job.dispatchedAt) < 900000) return;
        const live = await this.liveRun(job); if (live) { if (!job.runId) { job.runId = String(live.id); job.status = 'running'; job.dispatchUncertain = false; await this.save(job); } return; }
        if (job.runId && (await this.owner.github(`actions/runs/${job.runId}`)).status !== 'completed') return;
        if (!TERMINAL.has(job.status)) { if (!job.runId && Date.now() - Date.parse(job.dispatchedAt || job.createdAt) < 900000) return; job.status = 'failed'; job.retryable = true; job.error = 'クラウド処理が中断しました。保存済みの資料から再開します。'; await this.save(job); return; }
        if (!job.retryable && !job.dispatchUncertain) return;
        if ((job.autoAttempts || 0) >= 3) { job.retryable = false; job.dispatchUncertain = false; job.error = '自動再試行を3回行いました。状況を確認して再試行してください。'; await this.save(job); return; }
        if ((await this.jobs()).some(other => other.id !== job.id && !TERMINAL.has(other.status))) return;
        job.autoAttempts = (job.autoAttempts || 0) + 1; job.runId = null; job.retryable = false; job.error = null; job.status = 'queued'; await this.save(job); await this.dispatch(job);
      }).catch(() => {});
    } finally { if ((await this.jobs()).some(job => !TERMINAL.has(job.status) || job.retryable || job.dispatchUncertain)) await this.owner.scheduleCheck(); }
  }
  requireRunner(job, runId) { if (!job) this.fail(404, 'not_found'); if (job.status === 'cancelled') this.fail(409, 'cancelled'); if (!runId || !/^\d+$/.test(runId) || job.runId !== runId) this.fail(409, 'runner_conflict'); }
  async runner(request, path) {
    const match = /^\/studio\/runner\/sapix-import\/jobs\/([a-f0-9-]{36})(?:\/(config|assets|publish|checkpoints)(?:\/([A-Za-z0-9_.-]{1,160}))?)?$/.exec(path); if (!match) this.fail(404, 'not_found');
    const job = await this.job(match[1]), runId = request.headers.get('X-Studio-Run-Id');
    if (!match[2] && request.method === 'GET') return this.result({ job: { ...job, assets: Object.keys(job.assets || {}) } });
    if (!match[2] && request.method === 'POST') {
      const body = await this.readBody(request, 16000); if (!object(body)) this.fail(400, 'invalid_request');
      return this.owner.serial(async () => {
        const current = await this.job(job.id); if (current.status === 'cancelled') this.fail(409, 'cancelled');
        if (!current.runId && body.status === 'running' && String(body.runId) === runId && /^\d+$/.test(runId || '')) current.runId = runId;
        this.requireRunner(current, runId);
        if (current.result && current.status !== 'completed') this.fail(409, 'sapix_import_publishing');
        if (current.status === 'completed' && body.status !== 'completed') this.fail(409, 'runner_conflict');
        if (body.status && !['running', 'failed', 'needs_attention', 'completed'].includes(body.status)) this.fail(400, 'invalid_request');
        if (body.status === 'completed' && !current.result) this.fail(409, 'invalid_request');
        if (body.status) current.status = body.status;
        for (const field of ['stage', 'message', 'error']) if (body[field] !== undefined) current[field] = safeMessage(body[field]);
        if (Number.isFinite(body.progress)) current.progress = Math.max(0, Math.min(100, body.progress));
        current.retryable = body.retryable === true && current.status === 'failed'; current.dispatchUncertain = false;
        await this.save(current); return this.result({ job: publicJob(current) });
      });
    }
    this.requireRunner(job, runId);
    if (match[2] === 'checkpoints' && match[3]) {
      const key = `sapix-import:checkpoint:${job.id}:${match[3]}`;
      if (request.method === 'GET') {
        const metadata = await this.storage.get(key); if (!metadata) return this.result({ value: null });
        const parts = await this.storage.get(Array.from({ length: metadata.parts }, (_, index) => `${key}:${metadata.version}:${index}`));
        return this.result({ value: JSON.parse(Array.from({ length: metadata.parts }, (_, index) => parts.get(`${key}:${metadata.version}:${index}`)).join('')) });
      }
      if (request.method === 'PUT') {
        const body = await this.readBody(request), content = JSON.stringify(body.value ?? null), version = crypto.randomUUID(), chunks = {};
        for (let index = 0; index * 20000 < content.length; index++) chunks[`${key}:${version}:${index}`] = content.slice(index * 20000, (index + 1) * 20000);
        await this.storage.transaction(async transaction => {
          this.requireRunner(await transaction.get(JOB + job.id), runId);
          const prior = await transaction.get(key); await transaction.put(chunks); await transaction.put(key, { version, parts: Object.keys(chunks).length });
          if (prior) await transaction.delete(Array.from({ length: prior.parts }, (_, index) => `${key}:${prior.version}:${index}`));
        });
        return this.result({ ok: true });
      }
    }
    if (match[2] === 'config' && request.method === 'GET') {
      const [token, catalog] = await Promise.all([this.owner.accessToken(), this.catalog()]); this.requireRunner(await this.job(job.id), runId);
      if (!this.env.ANTHROPIC_API_KEY) this.fail(503, 'sapix_import_model');
      return this.result({ driveAccessToken: token.accessToken, driveExpiresIn: token.expiresIn, anthropicApiKey: this.env.ANTHROPIC_API_KEY, model: job.model, files: job.files, folderId: SAPIX_IMPORT_FOLDER, cutoff: SAPIX_IMPORT_SINCE, catalogPath: CATALOG_PATH, existingSourceFileIds: catalog.sources.map(source => source.fileId) });
    }
    if (match[2] === 'assets' && request.method === 'POST') { const body = await this.readBody(request, 12 * 1024 * 1024); return this.owner.serial(() => this.asset(job.id, runId, body)); }
    if (match[2] === 'publish' && request.method === 'POST') { const body = await this.readBody(request, 8 * 1024 * 1024 + 1024); return this.owner.serial(() => this.publish(job.id, runId, body)); }
    this.fail(404, 'not_found');
  }
  async asset(id, runId, body) {
    const job = await this.job(id); this.requireRunner(job, runId); const match = typeof body?.path === 'string' && ASSET.exec(body.path);
    if (!keys(body, ['path', 'contentBase64']) || !match || !job.files.some(file => file.id === match[1]) || typeof body.contentBase64 !== 'string' || body.contentBase64.length > 4 * Math.ceil(MAX_ASSET / 3) || body.contentBase64.length % 4 || /[^A-Za-z0-9+/=]/.test(body.contentBase64) || !/^[^=]*={0,2}$/.test(body.contentBase64)) this.fail(400, 'invalid_request');
    let bytes; try { bytes = decode(body.contentBase64); } catch { this.fail(400, 'invalid_request'); }
    if (!bytes.length || bytes.length > MAX_ASSET) this.fail(413, 'sapix_import_capacity');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10;
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
    if (hash !== match[2] || !(match[3] === 'png' ? png : match[3] === 'webp' ? webp : jpeg)) this.fail(400, 'invalid_request');
    if (job.assets[body.path]) return this.result({ path: body.path, sha: job.assets[body.path].sha });
    if (job.status === 'completed') this.fail(409, 'runner_conflict');
    if (Object.keys(job.assets).length >= 100 || Object.values(job.assets).reduce((sum, asset) => sum + asset.size, 0) + bytes.length > 64 * 1024 * 1024) this.fail(413, 'sapix_import_capacity');
    const blob = await this.owner.github('git/blobs', 'POST', { encoding: 'base64', content: body.contentBase64 });
    job.assets[body.path] = { sha: blob.sha, size: bytes.length }; await this.save(job); return this.result({ path: body.path, sha: blob.sha });
  }
  async publish(id, runId, body) {
    const job = await this.job(id); this.requireRunner(job, runId);
    if (!keys(body, ['catalog']) || !validSapixCatalog(body.catalog)) this.fail(400, 'sapix_import_catalog');
    const addition = body.catalog;
    // A resumed runner may discover that every selected source was already
    // published. This is read-only reconciliation, never a duplicate append.
    if (!addition.sources.length && !addition.problems.length) {
      if (job.result) return this.result(job.result);
      const ref = await this.owner.github(`git/ref/heads/${this.env.BRANCH}`), commit = await this.owner.github(`git/commits/${ref.object.sha}`), tree = await this.owner.github(`git/trees/${commit.tree.sha}?recursive=1`);
      if (tree.truncated) this.fail(502, 'github_unavailable');
      const entry = tree.tree.find(item => item.path === CATALOG_PATH); if (!entry) this.fail(409, 'sapix_import_duplicate');
      const blob = await this.owner.github(`git/blobs/${entry.sha}`); let catalog;
      try { catalog = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(blob.content))); } catch { this.fail(409, 'sapix_import_catalog'); }
      if (!validSapixCatalog(catalog)) this.fail(409, 'sapix_import_catalog');
      if (!job.files.every(file => catalog.sources.some(source => source.fileId === file.id && source.fingerprint === file.fingerprint && source.modifiedTime === file.modifiedTime && source.name === file.name))) this.fail(409, 'sapix_import_source_changed');
      const sources = catalog.sources.filter(source => job.files.some(file => file.id === source.fileId)), ids = new Set(sources.flatMap(source => source.problemIds));
      const recovered = { schemaVersion: 1, sources, problems: catalog.problems.filter(problem => ids.has(problem.id)) };
      const samePublication = job.publicationDigest === await this.digest(JSON.stringify(recovered));
      if (samePublication && recovered.problems.some(problem => problem.sourceImages.some(path => !job.assets[path] || !tree.tree.some(item => item.path === 'sapix/' + path && item.sha === job.assets[path].sha)))) this.fail(409, 'sapix_import_assets');
      if (!samePublication) job.publicationDigest = await this.digest(JSON.stringify(addition));
      return this.finish(job, ref.object.sha, samePublication ? recovered : addition, recovered);
    }
    if (addition.sources.length !== job.files.length || addition.sources.some(source => !job.files.some(file => file.id === source.fileId && file.name === source.name && file.modifiedTime === source.modifiedTime && file.fingerprint === source.fingerprint))) this.fail(409, 'sapix_import_source_changed');
    const images = [...new Set(addition.problems.flatMap(problem => problem.sourceImages))]; if (images.some(path => !job.assets[path])) this.fail(400, 'sapix_import_assets');
    const publicationDigest = await this.digest(JSON.stringify(addition));
    if (job.result) { if (job.publicationDigest !== publicationDigest) this.fail(409, 'sapix_import_duplicate'); return this.result(job.result); }
    const currentFiles = await this.files(); if (job.files.some(file => !currentFiles.some(current => current.id === file.id && current.fingerprint === file.fingerprint && current.unitPath === file.unitPath))) this.fail(409, 'sapix_import_source_changed');
    for (let attempt = 0; attempt < 4; attempt++) {
      const ref = await this.owner.github(`git/ref/heads/${this.env.BRANCH}`), commit = await this.owner.github(`git/commits/${ref.object.sha}`);
      const tree = await this.owner.github(`git/trees/${commit.tree.sha}?recursive=1`); if (tree.truncated) this.fail(502, 'github_unavailable');
      const entry = tree.tree.find(item => item.path === CATALOG_PATH); let catalog = emptyCatalog();
      if (entry) { const blob = await this.owner.github(`git/blobs/${entry.sha}`); try { catalog = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(blob.content))); } catch { this.fail(409, 'sapix_import_catalog'); } if (!validSapixCatalog(catalog)) this.fail(409, 'sapix_import_catalog'); }
      const duplicates = addition.sources.filter(source => catalog.sources.some(existing => existing.fileId === source.fileId));
      if (duplicates.length) {
        const identical = duplicates.length === addition.sources.length && addition.sources.every(source => catalog.sources.some(existing => JSON.stringify(existing) === JSON.stringify(source))) && addition.problems.every(problem => catalog.problems.some(existing => JSON.stringify(existing) === JSON.stringify(problem)));
        if (job.publicationDigest === publicationDigest && identical && images.every(path => tree.tree.some(item => item.path === 'sapix/' + path && item.sha === job.assets[path].sha))) return this.finish(job, ref.object.sha, addition);
        this.fail(409, 'sapix_import_duplicate');
      }
      if (addition.problems.some(problem => catalog.problems.some(existing => existing.id === problem.id))) this.fail(409, 'sapix_import_duplicate');
      const merged = { schemaVersion: 1, sources: [...catalog.sources, ...addition.sources], problems: [...catalog.problems, ...addition.problems] };
      if (!validSapixCatalog(merged)) this.fail(413, 'sapix_import_capacity');
      const changes = [];
      for (const path of images) { const existing = tree.tree.find(item => item.path === 'sapix/' + path); if (existing && existing.sha !== job.assets[path].sha) this.fail(409, 'existing_file'); changes.push({ path: 'sapix/' + path, mode: '100644', type: 'blob', sha: job.assets[path].sha }); }
      const catalogBlob = await this.owner.github('git/blobs', 'POST', { encoding: 'base64', content: encode(JSON.stringify(merged)) });
      changes.push({ path: CATALOG_PATH, mode: '100644', type: 'blob', sha: catalogBlob.sha });
      const nextTree = await this.owner.github('git/trees', 'POST', { base_tree: commit.tree.sha, tree: changes });
      const next = await this.owner.github('git/commits', 'POST', { message: `Import ${addition.sources.length} SAPIX source files`, tree: nextTree.sha, parents: [ref.object.sha] });
      job.publicationDigest = publicationDigest; await this.save(job);
      const changed = await this.owner.github(`git/refs/heads/${this.env.BRANCH}`, 'PATCH', { sha: next.sha, force: false }, [409, 422]);
      if (!changed.httpStatus) return this.finish(job, next.sha, addition);
    }
    this.fail(502, 'github_unavailable');
  }
  async finish(job, commitSha, addition, expected = addition) {
    job.result = this.publicationResult(commitSha, addition); job.expectedCatalogDigest = await this.digest(JSON.stringify(expected));
    job.status = 'publishing'; job.stage = 'publishing'; job.progress = 95; job.retryable = false; job.dispatchUncertain = false; job.error = null; job.message = '問題と元画像を保存しました。サイトへの反映を確認しています。';
    job.publicationStartedAt = now(); job.publicationCheckedAt = null; job.publicationVerifiedAssets = 0;
    await this.save(job); return this.result(job.result);
  }
  async reconcilePublications(id) {
    for (const job of await this.jobs()) if ((!id || job.id === id) && job.result && ['publishing', 'needs_attention'].includes(job.status)) await this.owner.serial(async () => this.checkPublication(await this.job(job.id))).catch(() => {});
  }
  async checkPublication(job) {
    if (!job.result || !['publishing', 'needs_attention'].includes(job.status) || Date.now() - Date.parse(job.publicationCheckedAt || '') < 15000) return;
    job.publicationCheckedAt = now();
    try {
      const base = new URL('./', job.result.url), url = new URL('problems/generated.json', base); url.searchParams.set('v', job.result.commitSha); url.searchParams.set('check', Date.now());
      const response = await fetch(url, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      const catalog = await this.readBody(response, 8 * 1024 * 1024); if (!validSapixCatalog(catalog)) throw new Error();
      const sources = catalog.sources.filter(source => job.files.some(file => file.id === source.fileId)), ids = new Set(sources.flatMap(source => source.problemIds));
      const expected = { schemaVersion: 1, sources, problems: catalog.problems.filter(problem => ids.has(problem.id)) };
      if (await this.digest(JSON.stringify(expected)) !== job.expectedCatalogDigest) throw new Error();
      const paths = [...new Set(expected.problems.flatMap(problem => problem.sourceImages))];
      // Check a bounded group each poll/alarm so large PDFs cannot monopolize
      // the owner object. Every referenced asset must pass before completion.
      const start = job.publicationVerifiedAssets || 0, selected = paths.slice(start, start + 20);
      for (let index = 0; index < selected.length; index += 5) {
        const responses = await Promise.all(selected.slice(index, index + 5).map(path => { const asset = new URL(path, base); asset.searchParams.set('v', job.result.commitSha); return fetch(asset, { method: 'HEAD', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) }); }));
        for (const asset of responses) { if (asset.status !== 200) throw new Error(); job.publicationVerifiedAssets = (job.publicationVerifiedAssets || 0) + 1; }
      }
      if (job.publicationVerifiedAssets >= paths.length) { job.status = 'completed'; job.stage = 'completed'; job.progress = 100; job.error = null; job.message = `${job.result.addedProblems} 小問の取り込みが完了しました。問題と元画像の公開を確認しました。`; }
    } catch { /* Publication is eventually consistent. Never expose provider bodies. */ }
    if (job.status !== 'completed' && Date.now() - Date.parse(job.publicationStartedAt) >= 20 * 60000) { job.status = 'needs_attention'; job.stage = 'publishing'; job.error = 'サイトへの反映を20分以内に確認できませんでした。問題は保存済みです。「再試行する」で公開状況を再確認できます。'; }
    await this.save(job);
  }
  publicationResult(commitSha, addition) { const [owner, repo] = this.env.REPO.split('/'); return { url: `https://${owner}.github.io/${repo}/sapix/sapix_sansu_trainer.html?v=${encodeURIComponent(commitSha)}`, commitSha, addedProblems: addition.problems.length, addedSources: addition.sources.length }; }
}
