import { beforeEach, afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFile } from 'node:fs/promises';
import { createWorkflowStore } from './d1.mjs';

let db;
let store;
let now;

beforeEach(async () => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of ['0001_initial.sql', '0002_workflow.sql', '0003_research_budget.sql',
    '0004_media_observations.sql', '0005_knowledge.sql', '0006_source_captures.sql']) {
    db.exec(await readFile(new URL(`./migrations/${file}`, import.meta.url), 'utf8'));
  }
  now = Date.parse('2026-11-30T23:59:00Z');
  const batch = db.transaction((statements) => statements.map(({ sql, params = [] }) => db.query(sql).all(...params)));
  store = createWorkflowStore(async (statements) => batch.immediate(statements), {
    clock: () => now,
    researchMonthlyLimit: 1,
  });
});

afterEach(() => db.close());

const draft = {
  language: 'en',
  durationSeconds: 3,
  segments: [{ id: 's1', start: 0, end: 2, text: 'Original line.', words: [
    { start: 0, end: 0.6, text: 'Original' },
  ] }],
};

test('duplicate intake produces one job and Codex sees only the approved transcript', async () => {
  const source = 'https://example.com/video.mp4';
  const submission = await store.submit('First submission', source);
  const duplicate = await store.submit('Repeated submission', source);
  expect(duplicate).toMatchObject({ jobId: submission.jobId, alreadySubmitted: true });

  const transcription = await store.claim();
  expect(transcription.kind).toBe('transcribe');
  expect(await store.claim({ allowResearch: true })).toBeNull();
  expect(await store.finishTranscription(transcription, draft)).toBe(true);
  expect(await store.claim({ allowResearch: true })).toBeNull();

  const review = await store.transcript(submission.caseId);
  review.segments[0].text = 'Corrected line.';
  await store.observe(submission.caseId, 1.2, 'A document is visible.');
  const approval = await store.approve(submission.caseId, review, 'Test reviewer');
  expect(await store.approve(submission.caseId, review, 'Test reviewer'))
    .toMatchObject({ jobId: approval.jobId, alreadyApproved: true });

  const research = await store.claim({ allowResearch: true });
  expect(research.id).toBe(approval.jobId);
  const input = await store.researchInput(research);
  expect(input.transcriptId).toBe(approval.approvedTranscriptId);
  expect(input.segments[0]).toMatchObject({ text: 'Corrected line.', words: [] });
  expect(input.visualObservations[0]).toMatchObject({ observation: 'A document is visible.' });
  expect(await store.finishResearch(research, { summary: 'Test draft.' })).toBe(true);
  expect(await store.draft(submission.caseId)).toMatchObject({ draft: { summary: 'Test draft.' } });
  expect((await store.showCase(submission.caseId)).case.stage).toBe('needs_editor');
});

test('reviewers can inspect frame leads and record time-stamped engagement for the original post', async () => {
  const postUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const submission = await store.submit('Video and public post', 'https://example.com/a.mp4', postUrl);
  const { caseId } = submission;
  expect((await store.attachPost(caseId, postUrl)).postUrl).toBe(postUrl);
  await expect(store.attachPost(caseId, 'https://example.com/posts/42')).rejects.toThrow('different original post');
  const job = await store.claim();
  const frame = { offsetSeconds: 1, sha256: 'd'.repeat(64), ocrText: 'POLL OPENS AT 8 AM' };
  expect(await store.finishTranscription(job, {
    ...draft, sha256: 'a'.repeat(64),
    visual: { method: 'ffmpeg-even-sampling-v1', samplingStatus: 'complete', ocrStatus: 'complete', frames: [frame] },
  })).toBe(true);
  const observation = {
    method: 'manual', postUrl: 'https://youtu.be/dQw4w9WgXcQ', sourceUrl: postUrl,
    observedAt: '2026-11-30T12:00:00Z', counts: { likes: 0, comments: 4 }, limitations: ['Comments shown on the post.'],
  };
  await store.recordEngagement(caseId, observation, 'Editor');
  await expect(store.recordEngagement(caseId, observation, 'Editor')).rejects.toThrow('each observation must be new');
  await expect(store.recordEngagement(caseId, { ...observation, method: 'youtube-data-api' }, 'Editor'))
    .rejects.toThrow('manually observed');
  expect(await store.media(caseId)).toMatchObject({
    postUrl, mediaSha256: 'a'.repeat(64), frames: [frame], engagement: [{
      counts: { views: null, likes: 0, comments: 4, shares: null }, limitations: observation.limitations,
    }],
  });
  expect(await store.claim({ allowResearch: true })).toBeNull();
  await store.approve(caseId, await store.transcript(caseId), 'Editor');
  const research = await store.claim({ allowResearch: true });
  expect((await store.researchInput(research, { includeMedia: true })).frameLeads).toEqual([frame]);
});

test('distinct posts of the same media can retain separate engagement and provenance', async () => {
  const sourceRef = 'https://example.com/identical-media.mp4';
  const postOne = 'https://example.org/video/1';
  const postTwo = 'https://example.org/video/2';
  const first = await store.submit('Post one', sourceRef, postOne);
  const second = await store.submit('Post two', sourceRef, postTwo);
  expect(second.caseId).not.toBe(first.caseId);
  expect(await store.submit('Repeated post one', sourceRef, postOne)).toMatchObject({
    caseId: first.caseId, alreadySubmitted: true,
  });
  expect((await store.media(second.caseId)).postUrl).toBe(postTwo);
});

test('a platform capture records method, media URL and counts only with the successful lease', async () => {
  const postUrl = 'https://mastodon.social/@example/123456789';
  const { caseId } = await store.submit('Public Mastodon clip', postUrl, postUrl);
  const expired = await store.claim({ leaseMs: 10 });
  now += 10;
  const job = await store.claim();
  const capture = {
    method: 'mastodon-public-api', mediaUrl: 'https://files.mastodon.social/media_attachments/files/clip.mp4',
    capturedAt: '2026-11-30T12:00:05Z', engagement: {
      method: 'mastodon-public-api', postUrl, sourceUrl: 'https://mastodon.social/api/v1/statuses/123456789',
      observedAt: '2026-11-30T12:00:00Z', counts: { likes: 10, comments: 0, shares: 1 },
    },
  };
  expect(await store.finishTranscription(expired, { ...draft, capture })).toBe(false);
  expect((await store.media(caseId)).engagement).toEqual([]);
  expect(await store.finishTranscription(job, { ...draft, capture })).toBe(true);
  expect(await store.media(caseId)).toMatchObject({
    postUrl, mediaUrl: capture.mediaUrl, captureMethod: capture.method, capturedAt: capture.capturedAt,
    engagement: [{ method: capture.method, counts: { views: null, likes: 10, comments: 0, shares: 1 } }],
  });
});

test('expired work cannot write results and a research retry respects the UTC monthly limit', async () => {
  const { caseId } = await store.submit('Second test', 'https://example.com/second.mp4');
  const expired = await store.claim({ leaseMs: 10 });
  now += 10;
  const replacement = await store.claim();
  expect(replacement.attemptCount).toBe(2);
  expect(await store.finishTranscription(expired, draft)).toBe(false);
  expect(await store.finishTranscription(replacement, draft)).toBe(true);
  await store.approve(caseId, await store.transcript(caseId), 'Test reviewer');

  const research = await store.claim({ allowResearch: true });
  expect(await store.fail(research, 'Synthetic failure')).toBe(true);
  expect(await store.claim({ allowResearch: true })).toBeNull();
  await store.retry(caseId, 'research');
  expect(await store.claim({ allowResearch: true })).toBeNull();
  now = Date.parse('2026-12-01T00:00:01Z');
  expect(await store.claim({ allowResearch: true })).toMatchObject({ caseId, kind: 'research' });
});

test('a remote runner skips media that exists only on the intake Mac', async () => {
  const local = await store.submit('Local only', 'local:mock.mp4');
  const remote = await store.submit('Public video', 'https://example.com/remote.mp4');
  expect(await store.claim({ allowLocal: false })).toMatchObject({ caseId: remote.caseId });
  expect((await store.showCase(local.caseId)).jobs[0].state).toBe('queued');
});
