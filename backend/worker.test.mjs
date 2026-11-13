import { readFile } from 'node:fs/promises';
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createWorkflowStore } from '../db/d1.mjs';
import worker from './worker.mjs';

const token = 'test-only-operator-credential-000000000000';

function request(path, { credential = token, body, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const headers = new Headers();
  if (credential) headers.set('Authorization', `Bearer ${credential}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`https://operator.example.com${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('every route checks the operator token before touching D1', async () => {
  const env = {
    OPERATOR_API_TOKEN: token,
    get DB() { throw new Error('Unexpected database access'); },
  };
  for (const path of ['/v1/status', '/v1/cases', '/v1/cases/some-case/draft']) {
    for (const credential of ['', token + 'wrong']) {
      const response = await worker.fetch(request(path, { credential }), env);
      expect(response.status).toBe(401);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    }
  }
  expect((await worker.fetch(request('/v1/status'), {})).status).toBe(503);
});

test('operator intake waits for explicit transcript approval, then exposes the private draft', async () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const name of ['0001_initial.sql', '0002_workflow.sql', '0003_research_budget.sql',
      '0004_media_observations.sql', '0005_knowledge.sql', '0006_source_captures.sql']) {
      db.exec(await readFile(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8'));
    }
    const execute = db.transaction((statements) => statements.map(({ sql, params = [] }) => db.query(sql).all(...params)));
    const binding = {
      prepare: (sql) => ({ sql, bind: (...params) => ({ sql, params }) }),
      batch: async (statements) => execute.immediate(statements).map((results) => ({ success: true, results })),
    };
    const runner = createWorkflowStore(async (statements) => execute.immediate(statements));
    const env = { OPERATOR_API_TOKEN: token, DB: binding };
    const call = (path, options) => worker.fetch(request(path, options), env);
    const invalid = await call('/v1/cases', { body: { title: 'Video', sourceUrl: 'https://example.com/clip.mp4?signature=private' } });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain('signature=private');
    expect((await call('/v1/cases', { body: { title: 'x'.repeat(20_000) } })).status).toBe(413);

    const body = {
      title: 'Video', sourceUrl: 'https://example.com/clip.mp4',
      originalPostUrl: 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    };
    const submitted = await call('/v1/cases', { body });
    expect(submitted.status).toBe(201);
    const { caseId } = await submitted.json();
    const path = `/v1/cases/${caseId}`;
    expect(submitted.headers.get('Location')).toBe(path);
    expect((await call('/v1/cases', { body })).status).toBe(200);
    expect((await call(`${path}/draft`)).status).toBe(409);
    expect((await (await call(`${path}/media`)).json()).postUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const engagement = await call(`${path}/engagement`, { body: {
      reviewer: 'Test operator', observation: {
        method: 'manual', postUrl: 'https://youtu.be/dQw4w9WgXcQ', sourceUrl: 'https://youtu.be/dQw4w9WgXcQ',
        observedAt: '2026-11-13T14:00:00Z', counts: { views: 100 },
      },
    } });
    expect(engagement.status).toBe(201);
    expect((await engagement.json()).counts).toMatchObject({ views: 100, shares: null });
    expect((await (await call(path)).json()).case.stage).toBe('submitted');
    const platform = await call('/v1/cases', { body: {
      title: 'Public post', sourceUrl: 'https://mastodon.social/@example/123456789#fragment',
    } });
    expect(platform.status).toBe(201);
    const { caseId: platformId } = await platform.json();
    expect((await (await call(`/v1/cases/${platformId}/media`)).json()).postUrl)
      .toBe('https://mastodon.social/@example/123456789');

    const transcription = await runner.claim({ caseId });
    await runner.finishTranscription(transcription, {
      language: 'en',
      durationSeconds: 3,
      segments: [{ id: 's1', start: 0, end: 2, text: 'First draft.' }],
    });
    expect(await runner.claim({ caseId, allowResearch: true })).toBeNull();
    const review = await (await call(`${path}/transcript`)).json();
    expect(review.provisional).toBe(1);
    review.segments[0].text = 'Reviewed words.';
    expect((await call(`${path}/observations`, {
      body: { timestampSeconds: 1, observation: 'A document appears.' },
    })).status).toBe(201);
    expect((await call(`${path}/approve`, { body: { review, reviewer: 'Test operator' } })).status).toBe(202);
    expect((await call(`${path}/approve`, { body: { review, reviewer: 'Test operator' } })).status).toBe(200);
    const research = await runner.claim({ caseId, allowResearch: true });
    const input = await runner.researchInput(research);
    expect(input.segments[0].text).toBe('Reviewed words.');
    expect(input.visualObservations[0].observation).toBe('A document appears.');
    await runner.finishResearch(research, { summary: 'A private result.' });
    expect((await (await call(`${path}/draft`)).json()).draft.summary).toBe('A private result.');
  } finally {
    db.close();
  }
});
