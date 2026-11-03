// Keep the browser-to-Worker request below Cloudflare's 100 MB request limit.
// GitHub receives base64 JSON, generated a small chunk at a time.
export const MAX_UPLOAD_BYTES = 90 * 1024 * 1024;

export class RequestError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

const encoder = new TextEncoder();

export function uploadSize(request, params) {
  if (!/^application\/octet-stream(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) throw new RequestError(400, 'invalid_request');
  const value = params.get('bytes');
  if (!/^[1-9]\d{0,9}$/.test(value || '')) throw new RequestError(400, 'invalid_request');
  const size = Number(value);
  if (size > MAX_UPLOAD_BYTES) throw new RequestError(413, 'file_too_large');
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== size)) throw new RequestError(400, 'invalid_request');
  if (!request.body) throw new RequestError(400, 'invalid_request');
  return size;
}

function base64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function githubUploadStream(input, size, metadata) {
  const prefix = encoder.encode(JSON.stringify(metadata).slice(0, -1) + ',"content":"');
  const suffix = encoder.encode('"}');
  const byteLength = prefix.length + 4 * Math.ceil(size / 3) + suffix.length;
  const state = { error: null };
  const reader = input.getReader();
  async function* generate() {
    let total = 0;
    let carry = new Uint8Array();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      yield prefix;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Bound encoding/decoding work even if the caller supplies a large chunk.
        for (let offset = 0; offset < value.byteLength; offset += 49152) {
          const part = value.subarray(offset, offset + 49152);
          total += part.length;
          if (total > MAX_UPLOAD_BYTES) throw new RequestError(413, 'file_too_large');
          if (total > size) throw new RequestError(400, 'invalid_request');
          decoder.decode(part, { stream: true });
          const joined = new Uint8Array(carry.length + part.length);
          joined.set(carry); joined.set(part, carry.length);
          const complete = joined.length - joined.length % 3;
          carry = joined.slice(complete);
          if (complete) yield encoder.encode(base64(joined.subarray(0, complete)));
        }
      }
      decoder.decode();
      if (total !== size) throw new RequestError(400, 'invalid_request');
      if (carry.length) yield encoder.encode(base64(carry));
      // Never finish the JSON request until byte count and UTF-8 are validated.
      yield suffix;
    } catch (error) {
      state.error = error instanceof RequestError ? error : new RequestError(400, 'invalid_request');
      throw state.error;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const iterator = generate();
  const source = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close(); else controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await reader.cancel().catch(() => {}); await iterator.return(); },
  }, { highWaterMark: 0 });
  // FixedLengthStream makes Workers emit a Content-Length accepted by GitHub.
  // The generic stream is used only in Node tests, which lack this runtime API.
  let readable = source;
  let completion = Promise.resolve();
  if (typeof FixedLengthStream === 'function') {
    const fixed = new FixedLengthStream(byteLength);
    completion = source.pipeTo(fixed.writable);
    completion.catch(() => {});
    readable = fixed.readable;
  }
  return { readable, byteLength, state, completion };
}
