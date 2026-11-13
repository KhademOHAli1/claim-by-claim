import { createWorkflowStore } from '../db/d1.mjs';
import { directMediaUrl, normalizeEngagement, publicPostUrl } from '../db/sources.mjs';
import { mastodonPostUrl } from '../db/mastodon.mjs';

const utf8 = new TextEncoder();
const authMessage = utf8.encode('claim-by-claim operator API');
const tokenPattern = /^[A-Za-z0-9_~+./=-]{32,256}$/;
const casePath = /^\/v1\/cases\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,119})(?:\/(transcript|approve|draft|observations|retry|media|engagement))?$/;
const shortBodyLimit = 12 * 1024;
const reviewBodyLimit = 512 * 1024;
const requestHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const storeErrors = new Map([
  ['Case not found.', 404],
  ['Transcript not found.', 404],
  ['No transcript is ready for review.', 409],
  ['No research draft is ready.', 409],
  ['Review the latest draft transcript for this case before approving it.', 409],
  ['Keep the existing segment IDs and order when editing the transcript.', 400],
  ['This transcript is not awaiting approval.', 409],
  ['Transcript language is required.', 400],
  ['A timed transcript and measured video duration are required.', 400],
  ['Transcript segments require unique IDs, ordered timestamps, and nonempty text.', 400],
  ['The case must be awaiting transcript review, and the timestamp must be within its video.', 409],
  ['There is no failed job eligible to retry.', 409],
  ['This video already has a different original post URL.', 409],
  ['The original post must match the case, and each observation must be new.', 409],
  ['Only manually observed engagement is retained.', 400],
  ['At least one engagement count is required.', 400],
]);

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { ...requestHeaders, ...headers } });
}

async function isAuthorized(request, expected) {
  const token = /^Bearer ([^ ]+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!token || !tokenPattern.test(token)) return false;
  const [candidateKey, expectedKey] = await Promise.all([
    crypto.subtle.importKey('raw', utf8.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    crypto.subtle.importKey('raw', utf8.encode(expected), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']),
  ]);
  const signature = await crypto.subtle.sign('HMAC', candidateKey, authMessage);
  return crypto.subtle.verify('HMAC', expectedKey, signature, authMessage);
}

function d1Store(env) {
  return createWorkflowStore(async (statements) => {
    const prepared = statements.map(({ sql, params }) => {
      const query = env.DB.prepare(sql);
      return params?.length ? query.bind(...params) : query;
    });
    const results = await env.DB.batch(prepared);
    if (results.length !== statements.length ||
        results.some(({ success, results: rows }) => !success || !Array.isArray(rows))) {
      throw new Error('Cloudflare D1 returned an incomplete result.');
    }
    return results.map(({ results: rows }) => rows);
  }, {
    database: 'd1',
    researchMonthlyLimit: Number(env.CLAIM_RESEARCH_MONTHLY_LIMIT ?? 20),
  });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(request, limit) {
  const mediaType = request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') throw new RequestError(415, 'Send an application/json request body.');
  if (Number(request.headers.get('Content-Length')) > limit) {
    throw new RequestError(413, 'The request body is too large.');
  }

  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, 'Send a JSON object.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let raw = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RequestError(413, 'The request body is too large.');
      }
      raw += decoder.decode(value, { stream: true });
    }
    const value = JSON.parse(raw + decoder.decode());
    if (!isObject(value)) throw new RequestError(400, 'Send a JSON object.');
    return value;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, 'Send a valid JSON object.');
  } finally {
    reader.releaseLock();
  }
}

function validText(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength && value.trim().length > 0;
}

function validatedMediaUrl(value) {
  try {
    return directMediaUrl(value);
  } catch (error) {
    throw new RequestError(400, error.message + ' For post-link intake, use a public mastodon.social video post.');
  }
}

function method(request, expected) {
  if (request.method !== expected) {
    return json({ error: 'Method not allowed.' }, 405, { Allow: expected });
  }
  return null;
}

async function route(request, store) {
  const { pathname } = new URL(request.url);
  if (pathname === '/v1/status') {
    return method(request, 'GET') ?? json(await store.status());
  }
  if (pathname === '/v1/cases') {
    const denied = method(request, 'POST');
    if (denied) return denied;
    const { title, sourceUrl, originalPostUrl } = await readJson(request, shortBodyLimit);
    if (!validText(title, 200)) throw new RequestError(400, 'Enter a case title of up to 200 characters.');
    const platformUrl = mastodonPostUrl(sourceUrl);
    const postUrl = originalPostUrl === undefined ? null : mastodonPostUrl(originalPostUrl) ?? publicPostUrl(originalPostUrl);
    if (originalPostUrl !== undefined && !postUrl) throw new RequestError(400, 'Use a public HTTPS original post URL.');
    if (platformUrl && postUrl && platformUrl !== postUrl) {
      throw new RequestError(400, 'The original post must match the submitted link.');
    }
    const result = await store.submit(title.trim(), platformUrl ?? validatedMediaUrl(sourceUrl), platformUrl ?? postUrl);
    return json(result, result.alreadySubmitted ? 200 : 201, { Location: `/v1/cases/${result.caseId}` });
  }

  const match = casePath.exec(pathname);
  if (!match) return json({ error: 'Route not found.' }, 404);
  const [, caseId, action] = match;
  if (action === undefined) return method(request, 'GET') ?? json(await store.showCase(caseId));
  if (action === 'transcript') return method(request, 'GET') ?? json(await store.transcript(caseId));
  if (action === 'draft') return method(request, 'GET') ?? json(await store.draft(caseId));
  if (action === 'media') return method(request, 'GET') ?? json(await store.media(caseId));

  const denied = method(request, 'POST');
  if (denied) return denied;
  const body = await readJson(request, action === 'approve' ? reviewBodyLimit : shortBodyLimit);
  if (action === 'approve') {
    const { review, reviewer } = body;
    if (!validText(reviewer, 200) || !isObject(review) || !Array.isArray(review.segments) ||
        review.segments.some((segment) => !isObject(segment)) ||
        (review.note != null && (typeof review.note !== 'string' || review.note.length > 2000))) {
      throw new RequestError(400, 'Send the reviewed transcript and the reviewer’s name.');
    }
    const result = await store.approve(caseId, review, reviewer);
    return json(result, result.alreadyApproved ? 200 : 202);
  }
  if (action === 'observations') {
    const { timestampSeconds, observation } = body;
    if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0 || !validText(observation, 2000)) {
      throw new RequestError(400, 'Enter a nonnegative timestamp and an observation of up to 2000 characters.');
    }
    return json(await store.observe(caseId, timestampSeconds, observation), 201);
  }
  if (action === 'engagement') {
    if (!validText(body.reviewer, 200)) throw new RequestError(400, 'Enter the reviewer’s name.');
    try {
      normalizeEngagement(body.observation);
    } catch (error) {
      throw new RequestError(400, error.message);
    }
    return json(await store.recordEngagement(caseId, body.observation, body.reviewer), 201);
  }
  if (body.kind !== 'transcribe' && body.kind !== 'research') {
    throw new RequestError(400, 'Choose transcribe or research.');
  }
  return json(await store.retry(caseId, body.kind), 202);
}

export default {
  async fetch(request, env) {
    const token = env.OPERATOR_API_TOKEN;
    if (typeof token !== 'string' || !tokenPattern.test(token)) {
      return json({ error: 'Operator API unavailable.' }, 503);
    }
    if (!await isAuthorized(request, token)) {
      return json({ error: 'Authentication required.' }, 401, { 'WWW-Authenticate': 'Bearer' });
    }
    try {
      return await route(request, d1Store(env));
    } catch (error) {
      if (error instanceof RequestError) return json({ error: error.message }, error.status);
      const status = storeErrors.get(error?.message);
      if (status) return json({ error: error.message }, status);
      return json({ error: 'The operator API could not complete this request.' }, 500);
    }
  },
};
