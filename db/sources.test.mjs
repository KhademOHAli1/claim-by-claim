import { expect, test } from 'bun:test';
import {
  directMediaUrl,
  fetchYouTubeEngagement,
  normalizeEngagement,
  publicPostUrl,
  youtubePostUrl,
} from './sources.mjs';

test('directMediaUrl follows the private worker intake policy', () => {
  expect(directMediaUrl('https://cdn.example.org/video.MP4#fragment'))
    .toBe('https://cdn.example.org/video.MP4');
  for (const value of [
    'http://cdn.example.org/video.mp4',
    'https://cdn.example.org/video.mp4?token=secret',
    'https://user:pass@cdn.example.org/video.mp4',
    'https://127.0.0.1/video.mp4',
    'https://cdn.local/video.mp4',
    'https://cdn.example.org/video.webm',
    'https://cdn.example.org/video.mp4:443',
    '',
    null,
  ]) {
    expect(() => directMediaUrl(value)).toThrow();
  }
});

test('youtubePostUrl canonicalizes supported forms and discards tracking', () => {
  expect(youtubePostUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=abc&t=10#x'))
    .toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  expect(youtubePostUrl('https://youtube.com/shorts/dQw4w9WgXcQ?feature=share'))
    .toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  expect(youtubePostUrl('https://youtu.be/dQw4w9WgXcQ?si=abc'))
    .toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  for (const value of [
    'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=otherid1234',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://evil.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ',
  ]) expect(youtubePostUrl(value)).toBeNull();
});

test('publicPostUrl removes fragments and rejects credential-bearing pages', () => {
  expect(publicPostUrl('https://social.example.org/posts/42?ref=feed#comments'))
    .toBe('https://social.example.org/posts/42?ref=feed');
  expect(publicPostUrl('https://social.example.org/posts/42?access_token=secret')).toBeNull();
  expect(publicPostUrl('https://social.example.org/')).toBeNull();
});

test('normalizeEngagement returns complete stable counts and a 30-day API expiry', () => {
  const manual = normalizeEngagement({
    postUrl: 'https://social.example.org/posts/42#comments',
    observedAt: '2026-11-13T12:00:00+01:00',
    method: 'manual',
    counts: { views: 0, likes: null, comments: 4, shares: 1 },
    provenance: { sourceUrl: 'https://social.example.org/posts/42#comments' },
  });
  expect(manual).toEqual({
    postUrl: 'https://social.example.org/posts/42',
    observedAt: '2026-11-13T11:00:00.000Z',
    method: 'manual',
    counts: { views: 0, likes: null, comments: 4, shares: 1 },
    provenance: { sourceUrl: 'https://social.example.org/posts/42' },
    limitations: ['Point-in-time manual observation.'],
    expiresAt: null,
  });

  const api = normalizeEngagement({
    postUrl: 'https://youtu.be/dQw4w9WgXcQ',
    observedAt: '2026-11-13T00:00:00.000Z',
    method: 'youtube-data-api',
    counts: { views: 12, likes: 3, comments: 0, shares: null },
    provenance: { sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  });
  expect(api.postUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  expect(api.expiresAt).toBe('2026-12-13T00:00:00.000Z');
  expect(api.limitations).toEqual(['Point-in-time YouTube API values may change.']);
});

test('normalizeEngagement rejects unsafe counts, methods, and expiry windows', () => {
  const base = {
    postUrl: 'https://social.example.org/posts/42',
    observedAt: '2026-11-13T00:00:00Z',
    method: 'manual',
    counts: { views: 1, likes: 2, comments: 3, shares: 4 },
    provenance: { sourceUrl: 'https://social.example.org/posts/42' },
  };
  expect(() => normalizeEngagement({ ...base, counts: { ...base.counts, likes: -1 } })).toThrow();
  expect(() => normalizeEngagement({ ...base, counts: { ...base.counts, likes: 1.2 } })).toThrow();
  expect(() => normalizeEngagement({ ...base, method: 'scrape' })).toThrow();
  expect(() => normalizeEngagement({ ...base, provenance: {} })).toThrow();
  expect(() => normalizeEngagement({
    ...base,
    method: 'youtube-data-api',
    postUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    provenance: { sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    expiresAt: '2027-01-01T00:00:00Z',
  })).toThrow();
});

test('fetchYouTubeEngagement uses only the fixed official endpoint and keeps the API key out of results', async () => {
  let requestUrl;
  let requestInit;
  const result = await fetchYouTubeEngagement('https://youtu.be/dQw4w9WgXcQ?si=tracking', {
    apiKey: 'test-secret-key',
    fetcher: async (url, init) => {
      requestUrl = url;
      requestInit = init;
      return new Response(JSON.stringify({
        items: [{ statistics: { viewCount: '12', likeCount: '3', commentCount: '0' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const parsed = new URL(requestUrl);
  expect(parsed.origin + parsed.pathname).toBe('https://www.googleapis.com/youtube/v3/videos');
  expect(parsed.searchParams.get('part')).toBe('statistics');
  expect(parsed.searchParams.get('id')).toBe('dQw4w9WgXcQ');
  expect(parsed.searchParams.get('key')).toBe('test-secret-key');
  expect(requestInit.method).toBe('GET');
  expect(result.counts).toEqual({ views: 12, likes: 3, comments: 0, shares: null });
  expect(result.method).toBe('youtube-data-api');
  expect(result.expiresAt).toBeTruthy();
  expect(JSON.stringify(result)).not.toContain('test-secret-key');
});

test('fetchYouTubeEngagement does not expose API errors or secrets', async () => {
  await expect(fetchYouTubeEngagement('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    apiKey: 'test-secret-key',
    fetcher: async () => new Response('denied', { status: 403 }),
  })).rejects.toThrow('HTTP 403');
});
