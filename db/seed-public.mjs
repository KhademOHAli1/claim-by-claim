import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const relations = ['supporting', 'contradicting', 'context'];

function requireValid(condition, reason) {
  if (!condition) throw new Error(`Public case seed: ${reason}`);
}

function indexBy(records, field, label) {
  requireValid(Array.isArray(records), `expected a list of ${label}`);
  const index = new Map();
  for (const record of records) {
    const key = record?.[field];
    requireValid(typeof key === 'string' && key.length > 0, `missing ${label} identifier`);
    requireValid(!index.has(key), `duplicate ${label} identifier ${key}`);
    index.set(key, record);
  }
  return index;
}

function sameIds(left, right) {
  return new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.length === right.length &&
    left.every((id) => right.includes(id));
}

function requireTimeRange(start, end, duration, label) {
  requireValid(Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start && end <= duration,
    `invalid media time range for ${label}`);
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && !value.includes('\0')) return `'${value.replaceAll("'", "''")}'`;
  throw new Error('Public case seed: invalid SQL value');
}

function insert(table, row, primaryKey) {
  const columns = Object.keys(row).join(', ');
  const values = Object.values(row).map(sqlValue).join(', ');
  return `INSERT INTO ${table} (${columns}) VALUES (${values}) ON CONFLICT (${primaryKey}) DO NOTHING;`;
}

async function publicVideoMetadata(source) {
  requireValid(typeof source === 'string' && /^\/media\/[A-Za-z0-9_.-]+\.mp4$/.test(source),
    'invalid public video reference');
  const file = new URL(`../public${source}`, import.meta.url);
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    sizeBytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), size_bytes: sizeBytes };
}

/** Export the repository's existing public case as portable SQLite/D1 SQL. */
export async function publicSeedSql() {
  const [data, sourceLocations, registry, manifest] = await Promise.all([
    readJson('../src/data/case.json'),
    readJson('../src/data/source-locations.json'),
    readJson('../evidence/registry.json'),
    readJson('../public/evidence/manifest.json'),
  ]);
  requireValid(data.schemaVersion === 1 && registry.schemaVersion === 1 && manifest.schemaVersion === 1,
    'unsupported public artifact version');

  const caseId = data.id;
  const videoId = `${caseId}-video`;
  const transcriptId = `${caseId}-transcript`;
  const asOf = new Date(data.asOf);
  requireValid(typeof caseId === 'string' && caseId.length > 0 && Number.isFinite(asOf.getTime()),
    'invalid case identity or as-of date');
  // Use the known snapshot date for deterministic historical rows.
  const snapshotDate = asOf.toISOString();
  const duration = data.video.durationSeconds;
  requireValid(Number.isFinite(duration) && duration > 0, 'invalid video duration');
  requireValid(typeof data.transcript.provisional === 'boolean', 'transcript review state is missing');
  const videoMetadata = await publicVideoMetadata(data.video.src);

  const sources = indexBy(data.sources, 'id', 'source');
  const records = indexBy(registry.records, 'evidenceId', 'evidence');
  const assets = indexBy(manifest.assets, 'sourceId', 'preview source');
  const segments = indexBy(data.transcript.segments, 'id', 'transcript segment');
  const claims = indexBy(data.claims, 'id', 'claim');

  requireValid(sameIds(data.evidenceIds, [...records.keys()]), 'case and evidence registry IDs differ');
  requireValid(sameIds(data.sources.map((source) => source.evidenceId), [...records.keys()]),
    'sources and evidence registry IDs differ');
  requireValid(sameIds(Object.keys(sourceLocations), [...sources.keys()]), 'source locators do not match the case sources');
  requireValid([...assets.keys()].every((id) => sources.has(id)), 'a preview has no case source');

  const statements = [
    insert('cases', {
      id: caseId,
      title: data.title,
      stage: 'needs_editor',
      created_at: snapshotDate,
      as_of: data.asOf,
      review_note: data.reviewStatus,
      scope_notes_json: JSON.stringify(data.scopeNotes),
    }, 'id'),
    insert('videos', {
      id: videoId,
      case_id: caseId,
      source_ref: data.video.src,
      created_at: snapshotDate,
      duration_seconds: duration,
      poster_ref: data.video.poster,
      captions_ref: data.video.captions,
      ...videoMetadata,
    }, 'id'),
    insert('transcripts', {
      id: transcriptId,
      case_id: caseId,
      video_id: videoId,
      language: data.transcript.language,
      provisional: data.transcript.provisional,
      note: data.transcript.note,
      created_at: snapshotDate,
    }, 'id'),
  ];

  for (const segment of segments.values()) {
    requireTimeRange(segment.start, segment.end, duration, segment.id);
    for (const word of segment.words) requireTimeRange(word.start, word.end, duration, `${segment.id} word`);
    statements.push(insert('transcript_segments', {
      case_id: caseId,
      transcript_id: transcriptId,
      id: segment.id,
      start_seconds: segment.start,
      end_seconds: segment.end,
      text: segment.text,
      words_json: JSON.stringify(segment.words),
    }, 'case_id, transcript_id, id'));
  }

  for (const source of sources.values()) {
    const record = records.get(source.evidenceId);
    const asset = assets.get(source.id);
    const preview = source.preview;
    requireValid(record.sourceId === source.id && record.originalUrl === source.url && record.originGroup === source.originGroup,
      `evidence provenance differs for ${source.id}`);
    if (asset) {
      requireValid(preview.kind === 'image' && preview.src === asset.src &&
        asset.evidenceId === record.evidenceId && record.previewPath === `public${asset.src}` &&
        record.previewSha256 === asset.sha256 && record.previewPage === asset.page &&
        record.previewIsDerivative === asset.derivative,
      `preview provenance differs for ${source.id}`);
    } else {
      requireValid(preview.kind === 'metadata' && record.previewPath === null,
        `missing preview manifest record for ${source.id}`);
    }

    statements.push(insert('sources', {
      case_id: caseId,
      id: source.id,
      title: source.title,
      type: source.type,
      url: source.url,
      published: source.published,
      pinpoint: source.pinpoint,
      origin_group: source.originGroup,
      establishes: source.establishes,
      limits: source.limits,
      inspected: source.inspected,
      locations_json: JSON.stringify(sourceLocations[source.id]),
      usage_limit_words: source.usageLimitWords,
    }, 'case_id, id'));
    statements.push(insert('evidence', {
      case_id: caseId,
      id: record.evidenceId,
      source_id: source.id,
      retention_status: record.retentionStatus,
      repository_path: record.repositoryPath,
      sha256: record.sha256,
      size_bytes: record.sizeBytes,
      publication_copy: record.publicationCopy,
      preview_json: JSON.stringify(asset ? { ...preview, ...asset } : preview),
      registry_json: JSON.stringify(record),
    }, 'case_id, id'));
  }

  for (const claim of claims.values()) {
    requireTimeRange(claim.start, claim.end, duration, claim.id);
    const claimSources = claim.sourceIds.map((id) => sources.get(id));
    requireValid(claimSources.every(Boolean), `unknown source on ${claim.id}`);
    requireValid(sameIds(claim.evidenceIds, claimSources.map((source) => source.evidenceId)),
      `claim sources and evidence differ for ${claim.id}`);
    requireValid(sameIds(claim.originGroups, [...new Set(claimSources.map((source) => source.originGroup))]),
      `claim source groups differ for ${claim.id}`);
    requireValid(sameIds(Object.keys(claim.relations), relations) &&
      relations.every((relation) => Array.isArray(claim.relations[relation])) &&
      sameIds(claim.evidenceIds, [...new Set(relations.flatMap((relation) => claim.relations[relation]))]),
    `claim evidence and relation IDs differ for ${claim.id}`);

    statements.push(insert('claims', {
      case_id: caseId,
      video_id: videoId,
      id: claim.id,
      start_seconds: claim.start,
      end_seconds: claim.end,
      quote: claim.quote,
      category: claim.category,
      scope: claim.scope,
      verdict: claim.verdict,
      status: claim.status,
      confidence: claim.confidence,
      confidence_reason: claim.confidenceReason,
      finding: claim.finding,
      counterevidence: claim.counterevidence,
      unresolved: claim.unresolved,
      next_test: claim.nextTest,
      review_status: claim.reviewStatus,
    }, 'case_id, id'));
    for (const relation of relations) {
      for (const evidenceId of claim.relations[relation]) {
        statements.push(insert('claim_evidence', {
          case_id: caseId,
          claim_id: claim.id,
          evidence_id: evidenceId,
          relation,
        }, 'case_id, claim_id, evidence_id, relation'));
      }
    }
  }

  return `${statements.join('\n')}\n`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.write(await publicSeedSql());
}
