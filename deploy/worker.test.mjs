import { beforeEach, onTestFinished, spyOn, test } from 'bun:test';
import assert from 'node:assert/strict';
import worker from './worker.ts';

const bytes = new TextEncoder().encode('0123456789abcdefghijklmnopqrstuvwxyz');
const url = 'https://example.test/media/source.mp4';
const cutoff = Date.parse('2026-12-03T22:24:40.000Z');
let clock;

beforeEach(() => {
  clock = spyOn(Date, 'now').mockReturnValue(cutoff - 1);
  onTestFinished(() => clock.mockRestore());
});

const metadata = {
  'Content-Type': 'video/mp4',
  'Content-Length': String(bytes.length),
  'Cache-Control': 'public, max-age=0, must-revalidate',
  ETag: '"test-asset"',
  'Last-Modified': 'Tue, 10 Nov 2026 12:00:00 GMT',
  Date: 'Thu, 12 Nov 2026 12:00:00 GMT',
};

function fixture({ status = 200, headers = metadata, body = true, truncated = false } = {}) {
  const state = { requests: [], reads: 0, cancelled: false };
  const data = truncated ? bytes.subarray(0, 5) : bytes;
  const env = { ASSETS: { async fetch(request) {
    state.requests.push(request);
    let position = 0;
    const stream = body && request.method !== 'HEAD' ? new ReadableStream({
      pull(controller) {
        state.reads++;
        if (position === data.length) return controller.close();
        const end = Math.min(position + 4, data.length);
        controller.enqueue(data.subarray(position, end));
        position = end;
      },
      cancel() { state.cancelled = true; },
    }, { highWaterMark: 0 }) : null;
    return new Response(stream, { status, headers });
  } } };
  return { env, state };
}

async function request(range, options = {}, setup = {}) {
  const { env, state } = fixture(setup);
  const headers = new Headers(options.headers);
  if (range !== undefined) headers.set('Range', range);
  const response = await worker.fetch(new Request(url, { ...options, headers }), env);
  return { response, state };
}

test('the cutoff serves the site until the scheduled instant and then blocks all assets', async () => {
  const { env, state } = fixture({ headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const homepage = new Request('https://example.test/');
  const live = await worker.fetch(homepage, env);
  assert.equal(live.status, 200);
  assert.equal(live.headers.get('Sunset'), 'Thu, 03 Dec 2026 22:24:40 GMT');
  assert.deepEqual(new Uint8Array(await live.arrayBuffer()), bytes);

  clock.mockReturnValue(cutoff);
  const gone = await worker.fetch(homepage, env);
  assert.equal(gone.status, 410);
  assert.equal(gone.headers.get('Cache-Control'), 'no-store');

  clock.mockReturnValue(cutoff + 1);
  const staticAsset = await worker.fetch(new Request('https://example.test/_next/static/site.css', {
    method: 'HEAD',
  }), env);
  assert.equal(staticAsset.status, 410);
  assert.equal(staticAsset.body, null);
  const media = await worker.fetch(new Request(url, {
    headers: { Range: 'bytes=0-1', 'If-None-Match': '"test-asset"' },
  }), env);
  assert.equal(media.status, 410);
  assert.equal(media.headers.get('Content-Range'), null);
  assert.deepEqual(state.requests, [homepage]);
});

test('full GET preserves content, validators and cache policy', async () => {
  const { response, state } = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(response.headers.get('Content-Length'), '36');
  assert.equal(response.headers.get('Content-Range'), null);
  assert.equal(response.headers.get('ETag'), metadata.ETag);
  assert.equal(response.headers.get('Cache-Control'), metadata['Cache-Control']);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(state.requests[0].headers.get('Accept-Encoding'), 'identity');
});

for (const [range, expected, contentRange] of [
  ['bytes=0-1', '01', 'bytes 0-1/36'],
  ['bytes=3-10', '3456789a', 'bytes 3-10/36'],
  ['bytes=30-', 'uvwxyz', 'bytes 30-35/36'],
  ['bytes=-3', 'xyz', 'bytes 33-35/36'],
  ['bytes=33-999999999999999999999999', 'xyz', 'bytes 33-35/36'],
  ['bytes=-999999999999999999999999', new TextDecoder().decode(bytes), 'bytes 0-35/36'],
]) {
  test(`range ${range} returns exact bytes and metadata`, async () => {
    const { response, state } = await request(range);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), contentRange);
    assert.equal(response.headers.get('Content-Length'), String(expected.length));
    assert.equal(response.headers.get('Content-Type'), 'video/mp4');
    assert.equal(response.headers.get('ETag'), metadata.ETag);
    assert.equal(await response.text(), expected);
    assert.equal(state.requests[0].headers.get('Range'), null);
    assert.equal(state.cancelled, true);
  });
}

test('short probe cancels the unread source without buffering the file', async () => {
  const { response, state } = await request('bytes=0-1');
  assert.equal(await response.text(), '01');
  assert.ok(state.reads <= 2, `unexpected source reads: ${state.reads}`);
  assert.equal(state.cancelled, true);
});

for (const range of ['bytes=36-', 'bytes=9-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'items=0-1', 'bytes=abc']) {
  test(`invalid or unsatisfiable range ${range} returns 416`, async () => {
    const { response, state } = await request(range);
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('Content-Range'), 'bytes */36');
    assert.equal(response.headers.get('Content-Length'), '0');
    assert.equal(await response.text(), '');
    assert.equal(state.cancelled, true);
  });
}

test('HEAD ignores Range and preserves full-file metadata without a body', async () => {
  const { response, state } = await request('bytes=0-1', { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Length'), '36');
  assert.equal(response.headers.get('Content-Range'), null);
  assert.equal(response.body, null);
  assert.equal(state.requests[0].method, 'HEAD');
  assert.equal(state.requests[0].headers.get('Range'), null);
});

for (const [validator, status] of [
  ['"test-asset"', 206], ['"old-asset"', 200], ['W/"test-asset"', 200],
  [metadata['Last-Modified'], 206], ['Wed, 11 Nov 2026 12:00:00 GMT', 200], ['invalid', 200],
]) {
  test(`If-Range ${validator} returns ${status}`, async () => {
    const { response, state } = await request('bytes=0-1', { headers: { 'If-Range': validator } });
    assert.equal(response.status, status);
    assert.equal(await response.text(), status === 206 ? '01' : new TextDecoder().decode(bytes));
    assert.equal(state.requests[0].headers.get('If-Range'), null);
  });
}

test('304 and precondition failures from ASSETS precede range handling', async () => {
  for (const status of [304, 412]) {
    const { response, state } = await request('bytes=0-1', {
      headers: { 'If-None-Match': '"test-asset"' },
    }, { status, body: false });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Content-Range'), null);
    assert.equal(state.requests[0].headers.get('If-None-Match'), '"test-asset"');
  }
});

test('non-media routes fall through unchanged', async () => {
  const { env, state } = fixture({ status: 404 });
  const original = new Request('https://example.test/missing', { headers: { Range: 'bytes=0-1' } });
  const response = await worker.fetch(original, env);
  assert.equal(response.status, 404);
  assert.equal(state.requests[0], original);
  await response.body.cancel();
});

test('missing media keeps its upstream error instead of becoming a 206', async () => {
  const { response } = await request('bytes=0-1', {}, { status: 404 });
  assert.equal(response.status, 404);
  await response.body.cancel();
});

test('unknown length or encoded content safely returns the full representation', async () => {
  for (const headers of [
    { 'Content-Type': 'video/mp4' },
    { ...metadata, 'Content-Encoding': 'gzip' },
  ]) {
    const { response } = await request('bytes=0-1', {}, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Accept-Ranges'), 'none');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  }
});

test('zero-length asset has no satisfiable range', async () => {
  const { response } = await request('bytes=0-', {}, { headers: { ...metadata, 'Content-Length': '0' }, body: false });
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('Content-Range'), 'bytes */0');
});

test('truncated upstream data errors instead of silently completing a short 206', async () => {
  const { response } = await request('bytes=0-9', {}, { truncated: true });
  await assert.rejects(response.arrayBuffer(), /ended before/);
});

test('client cancellation propagates to the source', async () => {
  const { response, state } = await request('bytes=0-35');
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel('client disconnected');
  assert.equal(state.cancelled, true);
});

test('unsupported media methods return 405 without reading an asset', async () => {
  const { response, state } = await request(undefined, { method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET, HEAD');
  assert.equal(state.requests.length, 0);
});

test('Workers FixedLengthStream is given the precise partial length', async () => {
  let declaredLength;
  const original = globalThis.FixedLengthStream;
  globalThis.FixedLengthStream = class extends TransformStream {
    constructor(length) {
      declaredLength = length;
      let written = 0;
      super({
        transform(chunk, controller) {
          written += chunk.byteLength;
          assert.ok(written <= length);
          controller.enqueue(chunk);
        },
        flush() { assert.equal(written, length); },
      });
    }
  };
  try {
    const { response, state } = await request('bytes=3-10');
    assert.equal(await response.text(), '3456789a');
    assert.equal(declaredLength, 8);
    assert.equal(state.cancelled, true);
  } finally {
    if (original === undefined) delete globalThis.FixedLengthStream;
    else globalThis.FixedLengthStream = original;
  }
});
