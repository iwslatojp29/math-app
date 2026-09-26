// ChatGPT handoff serves existing source files; it never creates an AI job.
export const MAX_CHAT_PDF_BYTES = 100 * 1024 * 1024;
const PRIVATE_HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store', Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
});
const disposition = (name, fallback) => `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name.replace(/[\\/\u0000-\u001f\u007f]/g, '_')).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;

export class StudioChat {
  constructor(studio, { fail, folders }) { this.studio = studio; this.fail = fail; this.folders = folders; }
  async instructions() {
    // Bundle the canonical file itself. Never maintain a second instruction copy.
    const { default: instructions } = await import('../../automation/specs/animation-html.md');
    return new Response(instructions, { headers: { ...PRIVATE_HEADERS,
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': disposition('中学受験算数_アニメーション付き解答解説HTML_作成指示書_v1.0.md', 'animation-html.md'),
    } });
  }
  validSource(source, id) {
    return source?.id === id && source.trashed === false && source.mimeType === 'application/pdf'
      && typeof source.name === 'string' && /\.pdf$/i.test(source.name)
      && Array.isArray(source.parents) && ['practice', 'advanced'].some(kind => source.parents.includes(this.folders[kind]));
  }
  identity(source) {
    return JSON.stringify([source.id, source.name, source.modifiedTime, source.md5Checksum, source.version, source.size,
      [...source.parents].sort()]);
  }
  async pdf(id, modifiedTime) {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id) || typeof modifiedTime !== 'string' || !modifiedTime
        || modifiedTime.length > 80 || !Number.isFinite(Date.parse(modifiedTime))) this.fail(400, 'invalid_request');
    const metadata = () => this.studio.drive(`files/${id}`, {
      fields: 'id,name,mimeType,size,modifiedTime,md5Checksum,parents,trashed,version', supportsAllDrives: 'true',
    });
    const source = await metadata();
    if (!this.validSource(source, id)) this.fail(404, 'not_found');
    if (source.modifiedTime !== modifiedTime) this.fail(409, 'source_changed');
    const size = Number(source.size);
    if (!/^\d+$/.test(String(source.size)) || !Number.isSafeInteger(size) || size < 1) this.fail(502, 'drive_unavailable');
    if (size > MAX_CHAT_PDF_BYTES) this.fail(413, 'source_too_large');
    const token = await this.studio.accessToken();
    const media = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${token.accessToken}` }, signal: AbortSignal.timeout(120000), redirect: 'error',
    });
    if (!media.ok || !media.body) {
      await media.body?.cancel();
      this.fail(media.status === 401 ? 401 : 502, media.status === 401 ? 'drive_reconnect' : 'drive_unavailable');
    }
    const length = media.headers.get('Content-Length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== size)) {
      await media.body.cancel(); this.fail(409, 'source_changed');
    }
    const reader = media.body.getReader(), identity = this.identity(source);
    let received = 0;
    const stream = new ReadableStream({
      pull: async controller => {
        try {
          const { value, done } = await reader.read();
          if (done) {
            if (received !== size) this.fail(409, 'source_changed');
            // Moving, trashing or replacing the selected PDF during download
            // must fail the download, rather than deliver a successful old name.
            const after = await metadata();
            if (!this.validSource(after, id) || this.identity(after) !== identity) this.fail(409, 'source_changed');
            reader.releaseLock(); controller.close(); return;
          }
          received += value.byteLength;
          if (received > size || received > MAX_CHAT_PDF_BYTES) this.fail(409, 'source_changed');
          controller.enqueue(value);
        } catch {
          await reader.cancel().catch(() => {});
          controller.error(new Error('PDF download could not be verified'));
        }
      },
      cancel: reason => reader.cancel(reason),
    });
    return new Response(stream, { headers: { ...PRIVATE_HEADERS, 'Content-Type': 'application/pdf',
      'Content-Disposition': disposition(source.name, 'problem.pdf'),
    } });
  }
}
