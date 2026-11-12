/** Redirect the legacy host, enforce the cutoff, and serve video byte ranges. */
declare const SOURCE_VIDEO_SIZE: number;
const packagedVideoSize = typeof SOURCE_VIDEO_SIZE === 'number' ? SOURCE_VIDEO_SIZE : NaN;
const legacyHostname = 'claim-by-claim.alikhadem425.workers.dev';
const canonicalOrigin = 'https://claim-by-claim.khademohali.me';
const offlineAt = Date.parse('2026-12-03T22:24:40.000Z');
const sunset = new Date(offlineAt).toUTCString();

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

interface ByteRange { start: number; end: number }

function parseRange(value: string, size: number): ByteRange | null {
  // A single range is enough for browser MP4 playback. Reject multipart ranges.
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const length = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (suffix === 0n) return null;
    return { start: Number(suffix >= length ? 0n : length - suffix), end: size - 1 };
  }
  const start = BigInt(match[1]);
  const end = match[2] ? BigInt(match[2]) : length - 1n;
  if (start >= length || end < start) return null;
  return { start: Number(start), end: Number(end >= length ? length - 1n : end) };
}

function ifRangeMatches(value: string | null, headers: Headers): boolean {
  if (value === null) return true;
  const validator = value.trim();
  if (validator.startsWith('"')) {
    // Weak ETags cannot satisfy If-Range (RFC 9110, section 13.1.5).
    return validator === headers.get('ETag');
  }
  if (validator.startsWith('W/')) return false;
  const modified = headers.get('Last-Modified');
  const date = headers.get('Date');
  if (!modified || !date) return false;
  const modifiedTime = Date.parse(modified);
  const dateTime = Date.parse(date);
  // Conservative strong-date validation; the comparison itself is exact.
  return Number.isFinite(modifiedTime) && Number.isFinite(dateTime)
    && dateTime - modifiedTime >= 60_000 && Date.parse(validator) === modifiedTime;
}

/** Keep at most one source chunk in memory, and stop reading after the range. */
function sliceStream(body: ReadableStream<Uint8Array>, range: ByteRange): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let position = 0;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!finished) {
          const { value, done } = await reader.read();
          if (done) {
            finished = true;
            controller.error(new Error('Media asset ended before its declared Content-Length.'));
            return;
          }
          const chunkStart = position;
          position += value.byteLength;
          const start = Math.max(range.start - chunkStart, 0);
          const end = Math.min(range.end + 1 - chunkStart, value.byteLength);
          if (start < end) controller.enqueue(value.subarray(start, end));
          if (position > range.end) {
            finished = true;
            controller.close();
            await reader.cancel();
            return;
          }
          // Honor downstream backpressure after emitting one chunk.
          if (start < end) return;
        }
      } catch (error) {
        finished = true;
        controller.error(error);
        await reader.cancel(error).catch(() => {});
      }
    },
    async cancel(reason) {
      finished = true;
      await reader.cancel(reason);
    },
  });
}

function withKnownLength(body: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  // Workers derives Content-Length from the body, ignoring a manually supplied
  // value for arbitrary streams. Node's standard stream is retained for tests.
  const FixedLength = (globalThis as typeof globalThis & {
    FixedLengthStream?: new (length: number) => {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    };
  }).FixedLengthStream;
  if (!FixedLength) return body;
  const { readable, writable } = new FixedLength(length);
  // The readable propagates failures; also consume the pipe promise rejection.
  void body.pipeTo(writable).catch(() => {});
  return readable;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === legacyHostname) {
      const target = new URL(canonicalOrigin);
      target.pathname = url.pathname;
      target.search = url.search;
      return Response.redirect(target, 308);
    }

    if (Date.now() >= offlineAt) {
      return new Response(request.method === 'HEAD' ? null : 'This website is no longer available.\n', {
        status: 410,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    const path = url.pathname;
    if (!path.startsWith('/media/')) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 200 || !asset.headers.get('Content-Type')?.startsWith('text/html')) return asset;
      const response = new Response(asset.body, asset);
      response.headers.set('Sunset', sunset);
      return response;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Content-Length': '0' } });
    }

    const upstreamHeaders = new Headers(request.headers);
    upstreamHeaders.delete('Range');
    upstreamHeaders.delete('If-Range');
    upstreamHeaders.set('Accept-Encoding', 'identity');
    // Preserve normal conditional headers so ASSETS can return 304 or 412 first.
    const asset = await env.ASSETS.fetch(new Request(request, { headers: upstreamHeaders }));
    const headers = new Headers(asset.headers);
    if (asset.status !== 200) return asset;

    const rawSize = headers.get('Content-Length');
    let size = rawSize !== null && /^\d+$/.test(rawSize) ? Number(rawSize) : NaN;
    // The ASSETS response can omit Content-Length even when the public response has it.
    const contentType = headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (!Number.isSafeInteger(size) && path === '/media/source.mp4' && contentType === 'video/mp4') {
      size = packagedVideoSize;
    }
    const encoded = headers.get('Content-Encoding');
    const canRange = Number.isSafeInteger(size) && (!encoded || encoded === 'identity');
    headers.set('Accept-Ranges', canRange ? 'bytes' : 'none');

    // Range only applies to GET. HEAD returns metadata for the full resource.
    if (request.method === 'HEAD') {
      await asset.body?.cancel();
      return new Response(null, { status: asset.status, headers });
    }

    const requestedRange = request.headers.get('Range');
    if (!requestedRange || !canRange || !ifRangeMatches(request.headers.get('If-Range'), headers)) {
      return new Response(asset.body, { status: asset.status, headers });
    }

    const range = parseRange(requestedRange, size);
    if (!range) {
      await asset.body?.cancel();
      headers.set('Content-Range', `bytes */${size}`);
      headers.set('Content-Length', '0');
      return new Response(null, { status: 416, headers });
    }
    if (!asset.body) return new Response(null, { status: 502, headers: { 'Content-Length': '0' } });

    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    const length = range.end - range.start + 1;
    headers.set('Content-Length', String(length));
    return new Response(withKnownLength(sliceStream(asset.body, range), length), { status: 206, headers });
  },
};
