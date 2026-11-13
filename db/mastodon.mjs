import { directMediaUrl, normalizeEngagement } from './sources.mjs';

const API_ORIGIN = 'https://mastodon.social';
const MEDIA_HOSTS = new Set(['files.mastodon.social']);
const handlePattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const statusIdPattern = /^[1-9]\d{0,63}$/;
const maxUrlLength = 2048;
const maxStatusBytes = 512 * 1024;
const requestTimeoutMs = 10_000;

function parseMastodonUrl(value) {
  if (typeof value !== 'string' || value.length > maxUrlLength || !value.trim()) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'mastodon.social'
    || url.port || url.username || url.password) return null;
  const match = /^\/@([^/]+)\/([^/]+)$/.exec(url.pathname.replace(/\/$/, ''));
  if (!match || !handlePattern.test(match[1]) || !statusIdPattern.test(match[2])) return null;
  return { handle: match[1].toLowerCase(), id: match[2] };
}

/** Canonicalize a public mastodon.social status URL. */
export function mastodonPostUrl(value) {
  const parsed = parseMastodonUrl(value);
  return parsed ? `${API_ORIGIN}/@${parsed.handle}/${parsed.id}` : null;
}

function statusEndpoint(postUrl) {
  const parsed = parseMastodonUrl(postUrl);
  return parsed ? `${API_ORIGIN}/api/v1/statuses/${parsed.id}` : null;
}

function bodySignal(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  timer.unref?.();
  const abort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

async function readBoundedJson(response) {
  if (!response?.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxStatusBytes) {
      throw new Error('Mastodon status response exceeded the size limit.');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Mastodon returned invalid status JSON.');
    }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxStatusBytes) {
        await reader.cancel();
        throw new Error('Mastodon status response exceeded the size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Mastodon returned invalid status JSON.');
  }
}

function safeMediaUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Mastodon returned an invalid video URL.');
  }
  if (!MEDIA_HOSTS.has(url.hostname.toLowerCase())
    || !url.pathname.startsWith('/media_attachments/')) {
    throw new Error('Mastodon returned a video URL outside the trusted CDN.');
  }
  try {
    return directMediaUrl(value);
  } catch {
    throw new Error('Mastodon returned a non-direct or unsupported video URL.');
  }
}

function nonnegativeCount(value, field) {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`Mastodon ${field} was not a safe integer.`);
  }
  return numeric;
}

/** Resolve one public status and its unambiguous video attachment. */
export async function resolveMastodonVideo(postUrl, {
  signal,
  fetcher = globalThis.fetch,
} = {}) {
  const canonicalPostUrl = mastodonPostUrl(postUrl);
  const endpoint = statusEndpoint(postUrl);
  if (!canonicalPostUrl || !endpoint) throw new TypeError('Use a public mastodon.social status URL.');
  if (typeof fetcher !== 'function') throw new TypeError('A fetcher function is required.');

  const request = bodySignal(signal);
  let response;
  let status;
  try {
    response = await fetcher(endpoint, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'application/json' },
      signal: request.signal,
    });
    if (!response || (Number.isInteger(response.status) && response.status >= 300 && response.status < 400)
      || response.redirected === true || (response.url && response.url !== endpoint)) {
      throw new Error('Mastodon status lookup redirected or returned no stable response.');
    }
    if (response.ok !== true) throw new Error(`Mastodon status lookup failed with HTTP ${response.status ?? 'unknown'}.`);
    status = await readBoundedJson(response);
  } finally {
    request.clear();
  }
  const parsed = parseMastodonUrl(canonicalPostUrl);
  if (!status || status.id !== parsed.id || status.visibility !== 'public') {
    throw new Error('Mastodon status is missing, private, or not public.');
  }
  if (mastodonPostUrl(status.url) !== canonicalPostUrl) {
    throw new Error('The Mastodon status URL does not match the original post.');
  }
  const attachments = status.media_attachments;
  if (!Array.isArray(attachments) || attachments.length !== 1 || attachments[0]?.type !== 'video') {
    throw new Error('Mastodon status must contain exactly one video attachment.');
  }
  const mediaUrl = safeMediaUrl(attachments[0].url);
  const observedAt = new Date().toISOString();
  const engagement = normalizeEngagement({
    postUrl: canonicalPostUrl,
    observedAt,
    method: 'mastodon-public-api',
    counts: {
      views: null,
      likes: nonnegativeCount(status.favourites_count, 'favourites_count'),
      comments: nonnegativeCount(status.replies_count, 'replies_count'),
      shares: nonnegativeCount(status.reblogs_count, 'reblogs_count'),
    },
    provenance: { sourceUrl: endpoint },
    limitations: [
      'Point-in-time values reported by mastodon.social. Counts can differ across instances.',
      'Likes are favourites, comments are replies and shares are boosts. Public views are unavailable.',
    ],
  });
  return { mediaUrl, engagement };
}
