const maxUrlLength = 2048;
const maxLimitations = 3;
const maxLimitationLength = 280;
const maxEngagementAgeMs = 30 * 24 * 60 * 60 * 1000;
const videoPath = /\.(?:mp4|mov|m4v)$/i;
const hostnamePattern = /^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/i;
const youtubeHosts = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);
const youtubeIdPattern = /^[A-Za-z0-9_-]{11}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function publicHostname(value) {
  const hostname = value.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  return hostnamePattern.test(hostname)
    && !/\.(?:localhost|local|internal|home|onion)$/i.test(hostname);
}

function parseUrl(value, message) {
  if (typeof value !== 'string' || value.length > maxUrlLength || !value.trim()) {
    throw new TypeError(message);
  }
  try {
    return new URL(value);
  } catch {
    throw new TypeError(message);
  }
}

function invalidDirectMedia() {
  return new TypeError('Use a public HTTPS link to an MP4, MOV or M4V video without query parameters or credentials.');
}

/**
 * Validate a direct public video URL using the same policy as the intake API.
 * The caller should perform DNS pinning again immediately before downloading.
 */
export function directMediaUrl(value) {
  let url;
  try {
    url = parseUrl(value, invalidDirectMedia().message);
  } catch {
    throw invalidDirectMedia();
  }
  if (url.protocol !== 'https:' || !publicHostname(url.hostname) || url.port
    || url.username || url.password || url.search || !videoPath.test(url.pathname)) {
    throw invalidDirectMedia();
  }
  url.hash = '';
  return url.href;
}

function canonicalYoutubeId(url) {
  const host = url.hostname.toLowerCase();
  if (!youtubeHosts.has(host)) return null;
  if (url.username || url.password || url.port || url.protocol !== 'https:') return null;

  const parts = url.pathname.split('/').filter(Boolean);
  let id = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    if (parts.length !== 1) return null;
    id = parts[0];
  } else if (parts.length === 1 && parts[0] === 'watch') {
    const values = url.searchParams.getAll('v');
    if (values.length !== 1) return null;
    id = values[0];
  } else if (parts.length === 2 && parts[0] === 'shorts') {
    id = parts[1];
  } else {
    return null;
  }
  return youtubeIdPattern.test(id) ? id : null;
}

/** Canonicalize the supported public YouTube post URL forms. */
export function youtubePostUrl(value) {
  let url;
  try {
    url = parseUrl(value, 'Use a public YouTube post URL.');
  } catch {
    return null;
  }
  const id = canonicalYoutubeId(url);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

/**
 * Canonicalize a public post page for manual observations. This is deliberately
 * separate from direct media intake because a post page is never downloaded as
 * a video by this module.
 */
export function publicPostUrl(value) {
  let url;
  try {
    url = parseUrl(value, 'Use a public HTTPS post URL.');
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !publicHostname(url.hostname) || url.port
    || url.username || url.password || url.pathname === '/') return null;
  if (youtubeHosts.has(url.hostname)) return youtubePostUrl(value);
  for (const key of url.searchParams.keys()) {
    if (/^(?:api[_-]?key|access[_-]?token|auth|password|secret|sig(?:nature)?|token)$/i.test(key)) {
      return null;
    }
  }
  url.hash = '';
  return url.href;
}

function isoTimestamp(value, field) {
  if (!(value instanceof Date) && (typeof value !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value))) {
    throw new TypeError(`${field} must be a valid ISO timestamp.`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError(`${field} must be a valid ISO timestamp.`);
  }
  return date.toISOString();
}

function count(value, field) {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer or null.`);
  }
  return numeric;
}

function normalizedLimitations(value, method) {
  const defaults = method === 'youtube-data-api'
    ? ['Point-in-time YouTube API values may change.']
    : method === 'mastodon-public-api'
      ? ['Point-in-time public status counts as reported by the Mastodon instance.']
      : ['Point-in-time manual observation.'];
  if (value === undefined || value === null || value === '') return defaults;
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.length > maxLimitations
    || values.some((item) => typeof item !== 'string' || !item.trim() || item.length > maxLimitationLength)) {
    throw new TypeError(`limitations must contain up to ${maxLimitations} short strings.`);
  }
  return values.map((item) => item.trim());
}

/** Normalize a point-in-time engagement observation into the stored contract. */
export function normalizeEngagement(record) {
  if (!isObject(record)) throw new TypeError('An engagement record is required.');
  const method = record.method;
  if (!['manual', 'youtube-data-api', 'mastodon-public-api'].includes(method)) {
    throw new TypeError('Unsupported engagement method.');
  }
  const postUrl = method === 'youtube-data-api'
    ? youtubePostUrl(record.postUrl)
    : publicPostUrl(record.postUrl);
  if (!postUrl) throw new TypeError('Engagement postUrl must be a public canonical post URL.');
  const observedAt = isoTimestamp(record.observedAt, 'observedAt');
  const sourceUrl = record.provenance?.sourceUrl ?? record.sourceUrl;
  const canonicalSourceUrl = publicPostUrl(sourceUrl) ?? youtubePostUrl(sourceUrl);
  if (!canonicalSourceUrl) throw new TypeError('Engagement provenance.sourceUrl must be public HTTPS.');

  const inputCounts = isObject(record.counts) ? record.counts : record;
  const counts = {
    views: count(inputCounts.views, 'views'),
    likes: count(inputCounts.likes, 'likes'),
    comments: count(inputCounts.comments, 'comments'),
    shares: count(inputCounts.shares, 'shares'),
  };
  let expiresAt = null;
  if (method === 'youtube-data-api') {
    const maxExpiry = Date.parse(observedAt) + maxEngagementAgeMs;
    expiresAt = record.expiresAt === undefined || record.expiresAt === null
      ? new Date(maxExpiry).toISOString()
      : isoTimestamp(record.expiresAt, 'expiresAt');
    if (Date.parse(expiresAt) <= Date.parse(observedAt) || Date.parse(expiresAt) > maxExpiry) {
      throw new TypeError('YouTube API engagement expiresAt must be after observedAt and within 30 days.');
    }
  }
  return {
    postUrl,
    observedAt,
    method,
    counts,
    provenance: { sourceUrl: canonicalSourceUrl },
    limitations: normalizedLimitations(record.limitations, method),
    expiresAt,
  };
}

function apiCount(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError(`YouTube ${field} is not a numeric count.`);
  }
  return count(value, field);
}

/** Fetch public YouTube statistics through the fixed Data API endpoint. */
export async function fetchYouTubeEngagement(postUrl, {
  apiKey,
  signal,
  fetcher = globalThis.fetch,
} = {}) {
  const canonicalPostUrl = youtubePostUrl(postUrl);
  if (!canonicalPostUrl) throw new TypeError('Use a public YouTube post URL.');
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new TypeError('A YouTube Data API key is required.');
  if (typeof fetcher !== 'function') throw new TypeError('A fetcher function is required.');

  const videoId = new URL(canonicalPostUrl).searchParams.get('v');
  const endpoint = new URL('https://www.googleapis.com/youtube/v3/videos');
  endpoint.searchParams.set('part', 'statistics');
  endpoint.searchParams.set('id', videoId);
  endpoint.searchParams.set('key', apiKey);
  let response;
  try {
    response = await fetcher(endpoint.href, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new Error('The YouTube Data API request could not be completed.');
  }
  if (!response || response.ok !== true) {
    throw new Error(`YouTube Data API request failed with HTTP ${response?.status ?? 'unknown'}.`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('YouTube Data API returned invalid JSON.');
  }
  const statistics = payload?.items?.[0]?.statistics;
  if (!statistics) throw new Error('YouTube video statistics were unavailable.');
  return normalizeEngagement({
    postUrl: canonicalPostUrl,
    observedAt: new Date().toISOString(),
    method: 'youtube-data-api',
    counts: {
      views: apiCount(statistics.viewCount, 'viewCount'),
      likes: apiCount(statistics.likeCount, 'likeCount'),
      comments: apiCount(statistics.commentCount, 'commentCount'),
      shares: null,
    },
    provenance: { sourceUrl: canonicalPostUrl },
  });
}
