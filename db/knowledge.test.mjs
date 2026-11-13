import { beforeEach, afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFile } from 'node:fs/promises';
import { createKnowledgeStore, vectorDimension, vectorVersion } from './knowledge.mjs';

let db;
let store;
let now;

beforeEach(async () => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of ['0001_initial.sql', '0002_workflow.sql', '0003_research_budget.sql', '0005_knowledge.sql']) {
    db.exec(await readFile(new URL(`./migrations/${file}`, import.meta.url), 'utf8'));
  }
  now = Date.parse('2026-11-13T10:00:00Z');
  const batch = db.transaction((statements) => statements.map(({ sql, params = [] }) => db.query(sql).all(...params)));
  store = createKnowledgeStore(async (statements) => batch.immediate(statements), { clock: () => now });
});

afterEach(() => db.close());

test('stores scoped topics and explicit reviewed claim relationships', async () => {
  const topic = await store.putKnowledgeNode({
    id: 'topic-public-health',
    nodeType: 'topic',
    label: 'Public health funding',
    scope: 'Federal budget allocations, 2020 through 2026',
    provenance: { kind: 'editorial_scope', source: 'reviewer-notes' },
  }, 'editor@example.test');
  expect(topic).toMatchObject({ id: 'topic-public-health', nodeType: 'topic', scope: 'Federal budget allocations, 2020 through 2026' });
  expect(topic.vectorVersion).toBe(vectorVersion);
  expect(topic.vector).toHaveLength(vectorDimension);

  const claimCaseId = 'case-1';
  const videoId = 'video-1';
  db.run('INSERT INTO cases (id, title, created_at) VALUES (?, ?, ?)', [claimCaseId, 'Test case', new Date(now).toISOString()]);
  db.run('INSERT INTO videos (id, case_id, source_ref, created_at) VALUES (?, ?, ?, ?)', [videoId, claimCaseId, 'local:test.mp4', new Date(now).toISOString()]);
  db.run('INSERT INTO claims (case_id, video_id, id, start_seconds, end_seconds, quote) VALUES (?, ?, ?, ?, ?, ?)', [claimCaseId, videoId, 'C1', 1, 2, 'Funding increased.']);
  const claim = await store.putKnowledgeNode({
    nodeType: 'claim',
    label: 'Funding increased',
    claimRef: { caseId: claimCaseId, claimId: 'C1', occurrence: { startSeconds: 1, endSeconds: 2 } },
  }, 'editor@example.test');
  const edge = await store.linkKnowledgeNodes({
    fromNodeId: claim.id,
    toNodeId: topic.id,
    relation: 'about',
    provenance: { reason: 'claim scope review' },
  }, 'editor@example.test');
  expect(edge).toMatchObject({ from_node_id: claim.id, to_node_id: topic.id, relation: 'about', reviewer: 'editor@example.test' });
  const hydrated = await store.knowledgeNode(claim.id);
  expect(hydrated.edgesFrom).toHaveLength(1);
  expect(hydrated.claimCaseId).toBe(claimCaseId);
  expect(hydrated.occurrence).toMatchObject({ startSeconds: 1, endSeconds: 2 });
});

test('retrieval returns bounded hashed lexical leads and does not claim semantic corroboration', async () => {
  await store.putKnowledgeNode({ id: 'n1', nodeType: 'topic', label: 'Energy prices in Germany', scope: '2024' }, 'reviewer');
  await store.putKnowledgeNode({ id: 'n2', nodeType: 'topic', label: 'Municipal elections', scope: '2024' }, 'reviewer');
  const results = await store.findKnowledge({ text: 'Germany energy prices', limit: 1 });
  expect(results).toHaveLength(1);
  expect(results[0].id).toBe('n1');
  expect(results[0].matchMethod).toBe('hashed-lexical-cosine');
  expect(results[0].score).toBeGreaterThan(0);
  expect(results[0].score).toBeLessThanOrEqual(1);
});

test('requires an explicit reviewer and rejects unknown graph types', async () => {
  await expect(store.putKnowledgeNode({ nodeType: 'topic', label: 'A topic' }, '')).rejects.toThrow('reviewer is required');
  await expect(store.putKnowledgeNode({ nodeType: 'not-a-node', label: 'A topic' }, 'reviewer')).rejects.toThrow('Unknown knowledge node type');
  await expect(store.linkKnowledgeNodes({ fromNodeId: 'a', toNodeId: 'b', relation: 'supports' }, '')).rejects.toThrow('reviewer is required');
});

test('only explicitly cleared graph entries may be sent to the research model', async () => {
  const topic = { nodeType: 'topic', label: 'Federal energy prices', scope: '2024' };
  await store.putKnowledgeNode({ ...topic, id: 'private' }, 'reviewer');
  await store.putKnowledgeNode({ ...topic, id: 'shared', metadata: { researchLead: true } }, 'reviewer');
  expect((await store.findKnowledge('Federal energy prices')).map(({ id }) => id)).toEqual(['private', 'shared']);
  const allowed = await store.findKnowledge({ text: 'Federal energy prices', researchOnly: true });
  expect(allowed.map(({ id }) => id)).toEqual(['shared']);
});
