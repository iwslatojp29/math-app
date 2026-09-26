import { handleStudio } from './studio.js';
export { StudioState } from './studio.js';

const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_BYTES = 4 * Math.ceil(MAX_CONTENT_BYTES / 3);
const MAX_JSON_BYTES = MAX_BASE64_BYTES + 16 * 1024;
const ATTEMPTS = 4;
const encoder = new TextEncoder();
const protectedFiles = new Set(['index.html', 'upload.html', 'delete.html']);

class SafeError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function fail(status, code) { throw new SafeError(status, code); }

function jsonResponse(status, body, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(JSON.stringify(body), { status, headers });
}

async function authorized(header, secret) {
  if (typeof secret !== 'string' || !secret || !header || header.length > 4096) return false;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match) return false;
  // Cloudflare's native comparison is constant-time. Hashing first fixes both lengths.
  const [supplied, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(match[1])),
    crypto.subtle.digest('SHA-256', encoder.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(supplied, expected);
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) fail(400, 'invalid_request');
  const length = request.headers.get('Content-Length');
  if (length && !/^\d+$/.test(length)) fail(400, 'invalid_request');
  if (length && Number(length) > MAX_JSON_BYTES) fail(413, 'file_too_large');
  if (!request.body) fail(400, 'invalid_request');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => {});
        fail(413, 'file_too_large');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    const value = JSON.parse(chunks.join(''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_request');
    return value;
  } catch (error) {
    if (error instanceof SafeError) throw error;
    fail(400, 'invalid_request');
  }
  finally { reader.releaseLock(); }
}

function decodeBase64(value, status = 400, code = 'invalid_request', returnText = true) {
  if (typeof value !== 'string') fail(status, code);
  const tooLarge = () => fail(status === 400 ? 413 : status, status === 400 ? 'file_too_large' : code);
  if (value.length > MAX_BASE64_BYTES) tooLarge();
  const normalized = value.replace(/[\r\n]/g, '');
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  if (normalized.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(normalized) || normalized.indexOf('=') !== (padding ? normalized.length - padding : -1)) fail(status, code);
  if (normalized.length / 4 * 3 - padding > MAX_CONTENT_BYTES) tooLarge();
  // Canonical padding bits are checked before decoding. The final base64 group
  // can encode either the exact byte limit or one extra byte at the same length.
  if (padding) {
    const bits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(normalized.at(-padding - 1));
    if (bits < 0 || (bits & (padding === 2 ? 15 : 3))) fail(status, code);
  }
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const text = [];
    // Upload validation needs no decoded HTML string. Bounded chunks avoid
    // materializing several full-size copies of image-heavy documents.
    for (let offset = 0; offset < normalized.length; offset += 65536) {
      const chunk = normalized.slice(offset, offset + 65536);
      let bytes;
      if (typeof Uint8Array.fromBase64 === 'function') bytes = Uint8Array.fromBase64(chunk);
      else {
        const binary = atob(chunk);
        bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      }
      const decoded = decoder.decode(bytes, { stream: true });
      if (returnText) text.push(decoded);
    }
    const final = decoder.decode();
    return returnText ? text.join('') + final : undefined;
  } catch { fail(status, code); }
}

function encodeBase64(value) {
  const bytes = encoder.encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function validateInput(body, isCommit) {
  const { folder, filename } = body;
  if (typeof folder !== 'string' || !/^[a-z0-9_-]{1,100}$/.test(folder) || ['proxy', 'shared', '.github'].includes(folder)) fail(400, 'invalid_request');
  if (typeof filename !== 'string' || !/\.html$/i.test(filename) || filename.length <= 5 || encoder.encode(filename).length > 255 || /[\/\\\u0000-\u001f\u007f-\u009f]/.test(filename) || filename.includes('..') || protectedFiles.has(filename.toLowerCase())) fail(400, 'invalid_request');
  // Lone surrogates are not valid file names or encodable URL components.
  try { encodeURIComponent(filename); } catch { fail(400, 'invalid_request'); }
  if (body.subject !== undefined && body.subject !== '理科' && body.subject !== '社会') fail(400, 'invalid_request');
  if (isCommit) {
    decodeBase64(body.contentBase64, 400, 'invalid_request', false);
    if (body.commitMessage !== undefined && (typeof body.commitMessage !== 'string' || body.commitMessage.length > 500 || /[\u0000-\u001f\u007f]/.test(body.commitMessage))) fail(400, 'invalid_request');
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function decodeEntities(value) {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|quot|apos|lt|gt|nbsp));/gi, (all, decimal, hex, name) => {
    if (name) return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: '\u00a0' })[name.toLowerCase()];
    const code = parseInt(decimal || hex, decimal ? 10 : 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
  });
}

function attributes(tag) {
  const values = Object.create(null);
  const source = tag.replace(/^<\s*[a-z][a-z0-9:-]*/i, '').replace(/\/?\s*>$/, '');
  const pattern = /([^\s=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (!(name in values)) values[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return values;
}

function matchesHref(href, filename) {
  if (typeof href !== 'string') return false;
  // Match the URL's file target: encoded %20 means a space, while a literal
  // filename containing "%20" must be represented as %2520. Never decode twice.
  const value = href.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  const urlPath = value.split(/[?#]/, 1)[0];
  const path = urlPath.startsWith('./') ? urlPath.slice(2) : urlPath;
  if (/[\/\\]/.test(path)) return false;
  // A bare, non-escape percent sign in a legacy raw filename is literal. Valid
  // escapes still receive exactly one decode; malformed UTF-8 never falls back
  // to an ambiguous raw-string match.
  try { return decodeURIComponent(path.replace(/%(?![0-9a-f]{2})/gi, '%25')) === filename; }
  catch { return false; }
}

// A source-preserving tokenizer: comments and raw text are skipped, quoted '>'
// characters cannot terminate tags, and div ranges are matched with a stack.
// This avoids regex removal truncating a card containing nested div elements.
function inspectIndex(html, filename) {
  const stack = [];
  const cards = [];
  const lists = [];
  const markers = [];
  let bodyEnd = -1;
  let position = 0;
  while (position < html.length) {
    const start = html.indexOf('<', position);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      if (end < 0) fail(409, 'index_unavailable');
      if (html.slice(start + 4, end).trim() === 'CARDS') markers.push({ start, containers: [...stack] });
      position = end + 3;
      continue;
    }
    const opening = /^<\s*(\/?)\s*([a-z][a-z0-9:-]*)\b/i.exec(html.slice(start));
    if (!opening) { position = start + 1; continue; }
    let end = start + opening[0].length;
    let quote = '';
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === html.length) fail(409, 'index_unavailable');
    const tag = html.slice(start, end + 1);
    const name = opening[2].toLowerCase();
    const closing = Boolean(opening[1]);
    position = end + 1;
    if (!closing && ['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes'].includes(name)) {
      const close = new RegExp(`<\\/\\s*${name}\\s*>`, 'gi');
      close.lastIndex = position;
      if (!close.exec(html)) fail(409, 'index_unavailable');
      position = close.lastIndex;
      continue;
    }
    if (name === 'body' && closing) bodyEnd = start;
    if (name === 'div') {
      if (closing) {
        const node = stack.pop();
        if (!node) fail(409, 'index_unavailable');
        node.closeStart = start;
        node.end = position;
      } else {
        const attrs = attributes(tag);
        const node = { start, end: -1, closeStart: -1, card: /(?:^|\s)card(?:\s|$)/.test(attrs.class || ''), matches: false };
        stack.push(node);
        if (node.card) cards.push(node);
        if (attrs.id === 'card-list') lists.push(node);
      }
    } else if (name === 'a' && !closing && matchesHref(attributes(tag).href, filename)) {
      // Remove the closest card, preserving any surrounding card-list or other card.
      const card = [...stack].reverse().find(node => node.card);
      if (card) card.matches = true;
    }
  }
  if (stack.length || bodyEnd < 0) fail(409, 'index_unavailable');
  return { cards: cards.filter(card => card.matches), lists, markers, bodyEnd };
}

export function updateIndex(html, { filename, folder, subject }, label, remove = false) {
  const { cards, lists, markers, bodyEnd } = inspectIndex(html, filename);
  if (remove) {
    // Merge overlapping ranges before removal, including the immediate newline.
    const ranges = cards.map(card => {
      const newline = /^(?:\r\n|\n)/.exec(html.slice(card.end));
      const lineStart = html.lastIndexOf('\n', card.start - 1) + 1;
      const start = /^[\t ]*$/.test(html.slice(lineStart, card.start)) ? lineStart : card.start;
      return { start, end: card.end + (newline?.[0].length || 0) };
    }).sort((a, b) => a.start - b.start);
    const merged = [];
    for (const range of ranges) {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push(range);
    }
    let result = html;
    for (const { start, end } of merged.reverse()) result = result.slice(0, start) + result.slice(end);
    return result;
  }
  if (cards.length) return html;
  let insertion = bodyEnd;
  let subjectAttribute = '';
  if (folder === 'science-society') {
    if (lists.length !== 1) fail(409, 'index_unavailable');
    const list = lists[0];
    insertion = markers.find(marker => marker.containers.includes(list))?.start ?? list.closeStart;
    subjectAttribute = ` data-subject="${subject || '理科'}"`;
  }
  const href = encodeURIComponent(filename).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  const card = `  <div class="card"${subjectAttribute}>\n    <a href="./${href}">${escapeHtml(label)}</a>\n  </div>\n`;
  return html.slice(0, insertion) + card + html.slice(insertion);
}

function githubClient(env) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.REPO || '') || typeof env.BRANCH !== 'string' || !env.BRANCH || !env.GITHUB_TOKEN) fail(503, 'service_unavailable');
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'math-app-proxy',
    'Content-Type': 'application/json',
  };
  return async (method, path, body) => {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const url = `https://api.github.com/repos/${env.REPO}/contents/${encodedPath}${method === 'GET' ? `?ref=${encodeURIComponent(env.BRANCH)}` : ''}`;
    let response;
    try { response = await fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { fail(502, 'upstream_error'); }
    if (method === 'GET' && response.status === 404) return null;
    if (method !== 'GET' && [409, 422, ...(method === 'DELETE' ? [404] : [])].includes(response.status)) return { conflict: true };
    if (!response.ok) fail(502, 'upstream_error');
    if (method !== 'GET') return { conflict: false };
    try {
      const result = await response.json();
      if (!result || Array.isArray(result) || typeof result.sha !== 'string' || !result.sha) fail(502, 'upstream_error');
      return result;
    } catch { fail(502, 'upstream_error'); }
  };
}

async function readIndex(github, path) {
  const index = await github('GET', path);
  if (!index || index.encoding !== 'base64') fail(409, 'index_unavailable');
  return { sha: index.sha, html: decodeBase64(index.content, 409, 'index_unavailable') };
}

async function mutateFile(github, env, body, remove) {
  const path = `${body.folder}/${body.filename}`;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const existing = await github('GET', path);
    if (remove && !existing) return;
    const mutation = remove
      ? { message: `Delete ${body.filename}`, branch: env.BRANCH, sha: existing.sha }
      : { message: body.commitMessage?.trim() || `Add ${body.filename}`, branch: env.BRANCH, content: body.contentBase64.replace(/[\r\n]/g, ''), ...(existing ? { sha: existing.sha } : {}) };
    const result = await github(remove ? 'DELETE' : 'PUT', path, mutation);
    if (!result.conflict) return;
  }
  fail(409, 'conflict_retry');
}

async function mutateIndex(github, env, path, initial, body, label, remove) {
  let index = initial;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const updated = updateIndex(index.html, body, label, remove);
    if (updated === index.html) return false;
    const result = await github('PUT', path, { message: 'Auto-update index.html', branch: env.BRANCH, sha: index.sha, content: encodeBase64(updated) });
    if (!result.conflict) return true;
    index = await readIndex(github, path);
  }
  fail(409, 'conflict_retry');
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/studio' || path.startsWith('/studio/') || path.startsWith('/api/studio/') || path.startsWith('/api/sapix/')) return handleStudio(request, env);
    const endpoint = path === '/api/commit' || path === '/api/delete';
    const origin = request.headers.get('Origin');
    const allowedOrigin = origin && origin === env.ALLOWED_ORIGIN ? origin : null;
    if (!endpoint || !['POST', 'OPTIONS'].includes(request.method)) return jsonResponse(404, { ok: false, error: 'not_found' }, allowedOrigin);
    if (!allowedOrigin) return jsonResponse(403, { ok: false, error: 'forbidden_origin' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      Vary: 'Origin',
    } });
    try {
      if (!await authorized(request.headers.get('Authorization'), env.UPLOAD_SECRET)) fail(401, 'unauthorized');
      const body = await readJson(request);
      const remove = path === '/api/delete';
      validateInput(body, !remove);
      const github = githubClient(env);
      const indexPath = `${body.folder}/index.html`;
      const label = String(env.LABEL_WITH_EXT).toLowerCase() === 'true' ? body.filename : body.filename.replace(/\.html$/i, '');
      // Validate the index before any file write. Client retries can repair an index
      // after a previous file write/delete succeeded but the index request failed.
      const initial = await readIndex(github, indexPath);
      updateIndex(initial.html, body, label, remove);
      await mutateFile(github, env, body, remove);
      const indexUpdated = await mutateIndex(github, env, indexPath, initial, body, label, remove);
      return jsonResponse(200, remove ? { ok: true } : { ok: true, file: `${body.folder}/${body.filename}`, indexUpdated, label }, allowedOrigin);
    } catch (error) {
      const safe = error instanceof SafeError ? error : new SafeError(500, 'internal_error');
      return jsonResponse(safe.status, { ok: false, error: safe.code }, allowedOrigin);
    }
  },
};
