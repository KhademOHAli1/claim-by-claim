import { expect, test } from 'bun:test';
import { mastodonPostUrl, resolveMastodonVideo } from './mastodon.mjs';

const post = 'https://mastodon.social/@Reporter/1234567890?utm_source=feed#media';
const media = 'https://files.mastodon.social/media_attachments/files/001/234/567/original/clip.mp4';

test('mastodonPostUrl canonicalizes only mastodon.social public status forms', () => {
  expect(mastodonPostUrl(post)).toBe('https://mastodon.social/@reporter/1234567890');
  expect(mastodonPostUrl('https://mastodon.social/@reporter/1/')).toBe('https://mastodon.social/@reporter/1');
  for (const value of [
    'http://mastodon.social/@reporter/123',
    'https://user:pass@mastodon.social/@reporter/123',
    'https://mastodon.social.evil.example/@reporter/123',
    'https://mastodon.social/users/reporter/statuses/123',
    'https://mastodon.social/@reporter/not-a-status-id',
    'https://mastodon.social/@reporter/0',
    'https://other.social/@reporter/123',
  ]) expect(mastodonPostUrl(value)).toBeNull();
});

test('resolveMastodonVideo uses the fixed public endpoint and maps status metrics', async () => {
  const calls = [];
  const resolved = await resolveMastodonVideo(post, {
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        id: '1234567890',
        url: 'https://mastodon.social/@reporter/1234567890',
        visibility: 'public',
        favourites_count: 7,
        replies_count: 3,
        reblogs_count: 2,
        media_attachments: [{ type: 'video', url: media }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://mastodon.social/api/v1/statuses/1234567890');
  expect(calls[0].init.method).toBe('GET');
  expect(calls[0].init.redirect).toBe('manual');
  expect(resolved.mediaUrl).toBe(media);
  expect(resolved.engagement.postUrl).toBe('https://mastodon.social/@reporter/1234567890');
  expect(resolved.engagement.method).toBe('mastodon-public-api');
  expect(resolved.engagement.provenance.sourceUrl).toBe('https://mastodon.social/api/v1/statuses/1234567890');
  expect(resolved.engagement.counts).toEqual({ views: null, likes: 7, comments: 3, shares: 2 });
  expect(resolved.engagement.limitations).toEqual([
    'Point-in-time values reported by mastodon.social. Counts can differ across instances.',
    'Likes are favourites, comments are replies and shares are boosts. Public views are unavailable.',
  ]);
});

test('resolveMastodonVideo rejects redirects, non-public statuses, ambiguous media, and untrusted CDNs', async () => {
  const fetcher = (payload, status = 200, responseInit = {}) => async () =>
    new Response(payload === null ? null : JSON.stringify(payload), { status, ...responseInit });
  await expect(resolveMastodonVideo(post, {
    fetcher: fetcher(null, 302, { headers: { location: 'https://evil.example/' } }),
  })).rejects.toThrow('redirected');
  await expect(resolveMastodonVideo(post, {
    fetcher: fetcher({ id: '1234567890', visibility: 'private', media_attachments: [] }),
  })).rejects.toThrow('private');
  await expect(resolveMastodonVideo(post, {
    fetcher: fetcher({ id: '1234567890', url: 'https://mastodon.social/@reporter/1234567890', visibility: 'public', media_attachments: [
      { type: 'video', url: media }, { type: 'video', url: media },
    ] }),
  })).rejects.toThrow('exactly one');
  await expect(resolveMastodonVideo(post, {
    fetcher: fetcher({ id: '1234567890', url: 'https://mastodon.social/@reporter/1234567890', visibility: 'public', media_attachments: [
      { type: 'video', url: 'https://evil.example/video.mp4' },
    ] }),
  })).rejects.toThrow('trusted CDN');
});

test('resolveMastodonVideo bounds metadata response bytes', async () => {
  const oversized = JSON.stringify({
    id: '1234567890',
    visibility: 'public',
    media_attachments: [{ type: 'video', url: media }],
    content: 'x'.repeat(600 * 1024),
  });
  await expect(resolveMastodonVideo(post, {
    fetcher: async () => new Response(oversized, { status: 200 }),
  })).rejects.toThrow('size limit');
});
