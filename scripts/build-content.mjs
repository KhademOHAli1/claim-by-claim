#!/usr/bin/env node
/**
 * Build the public review data without publishing private working material.
 * Uses Node's standard library only; never fetches a URL.
 *
 * In the research workspace it reads the reviewed source ledgers. In a public
 * checkout without those working files it validates the committed public data
 * and deterministically regenerates captions from its transcript.
 *
 * Run: node scripts/build-content.mjs [--check]
 */
import { readFile, writeFile, access } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(siteRoot, '..');
const publicRoot = join(siteRoot, 'public');
const outputPath = join(siteRoot, 'src/data/case.json');
const captionsPath = join(publicRoot, 'transcript.vtt');
const checkOnly = process.argv.includes('--check');
const inputPaths = {
  claims: join(workspaceRoot, 'work/factcheck/analysis/resolved-claims.json'),
  sources: join(workspaceRoot, 'work/factcheck/analysis/source-catalog.json'),
  transcript: join(workspaceRoot, 'work/media-inspection/corrected-premiere-extracted.json'),
};
const statuses = {
  Supported: 'green',
  Contradicted: 'red',
  Mixed: 'orange',
  Misleading: 'orange',
  Unsubstantiated: 'orange',
  Unresolved: 'orange',
  'Not fact-checkable': 'neutral',
};
const allowedImageSources = new Set(['S004', 'S013', 'S015', 'S016', 'S017', 'S018']);
const restrictedSources = new Set(['S024', 'S025']);
const readJSON = async (path) => JSON.parse(await readFile(path, 'utf8'));
const exists = async (path) => access(path).then(() => true, () => false);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const text = (value) => typeof value === 'string' ? value : '';
const strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
const sortedUnique = (items) => [...new Set(items)].sort();
const finiteTime = (value) => Number.isFinite(value) && value >= 0;

const assetManifest = await readJSON(join(publicRoot, 'evidence/manifest.json'));
assert(Array.isArray(assetManifest.assets), 'Public evidence manifest has no assets array.');
const assetsBySource = new Map();
for (const asset of assetManifest.assets) {
  assert(allowedImageSources.has(asset.sourceId), `Local preview is not approved for ${asset.sourceId}.`);
  assert(/^\/evidence\/[A-Za-z0-9_.-]+\.(png|jpg)$/.test(asset.src), `Unsafe preview path: ${asset.src}`);
  assert(!assetsBySource.has(asset.sourceId), `Duplicate preview for ${asset.sourceId}.`);
  const bytes = await readFile(join(publicRoot, asset.src.slice(1)));
  assert(createHash('sha256').update(bytes).digest('hex') === asset.sha256, `Preview changed: ${asset.src}`);
  assetsBySource.set(asset.sourceId, asset);
}

const hasPrivateInputs = (await Promise.all(Object.values(inputPaths).map(exists))).every(Boolean);
let data;
if (hasPrivateInputs) {
  const [rawClaims, rawSources, rawTranscript] = await Promise.all([
    readJSON(inputPaths.claims), readJSON(inputPaths.sources), readJSON(inputPaths.transcript),
  ]);
  assert(rawClaims.length === 47, 'Expected all 47 reviewed claims.');
  assert(rawSources.length === 40, 'Expected all 40 retained sources.');
  const claims = rawClaims.map((claim) => ({
    id: text(claim.claim_id),
    start: claim.start_seconds,
    end: claim.end_seconds,
    quote: text(claim.exact_claim),
    category: text(claim.category),
    scope: text(claim.scope_and_definitions),
    verdict: text(claim.verdict),
    status: statuses[claim.verdict],
    confidence: text(claim.confidence),
    confidenceReason: text(claim.confidence_reason),
    finding: text(claim.proposed_wording),
    counterevidence: text(claim.counterevidence_or_limit),
    unresolved: text(claim.unresolved_question),
    nextTest: text(claim.next_test),
    sourceIds: strings(claim.source_ids),
    evidenceIds: strings(claim.evidence_ids),
    originGroups: strings(claim.origin_groups),
    relations: {
      supporting: strings(claim.supporting_evidence_ids),
      contradicting: strings(claim.contradicting_evidence_ids),
      context: strings(claim.context_or_inconclusive_evidence_ids),
    },
    reviewStatus: text(claim.review_status),
  }));
  const sources = rawSources.map((source) => {
    const asset = assetsBySource.get(source.source_id);
    const record = {
      id: text(source.source_id),
      evidenceId: text(source.evidence_id),
      title: text(source.title),
      type: text(source.source_type),
      url: text(source.url),
      published: text(source.publication_or_version),
      pinpoint: text(source.pinpoint),
      originGroup: text(source.origin_group),
      establishes: text(source.establishes),
      limits: text(source.limitations),
      inspected: source.parent_inspected === true,
      preview: asset ? {
        kind: 'image', src: asset.src, label: asset.label, caption: asset.caption, page: asset.page,
      } : {
        kind: 'metadata', label: 'Source metadata',
        caption: 'No local reproduction. Open the original source and read its scope and limitations.',
      },
    };
    if (restrictedSources.has(record.id)) record.usageLimitWords = 25;
    return record;
  });
  const segments = rawTranscript.segments.map((segment) => ({
    id: `T${String(Number(segment.id) + 1).padStart(3, '0')}`,
    start: segment.start, end: segment.end, text: text(segment.text),
    words: segment.words.filter((word) => text(word.word).trim()).map((word) => ({
      text: word.word, start: word.start, end: word.end,
    })),
  }));
  const dates = sortedUnique(rawClaims.map((claim) => text(claim.as_of_utc)).filter(Boolean));
  assert(dates.length === 1, 'Claims have different review cutoffs; resolve before rebuilding.');
  data = {
    schemaVersion: 1,
    id: 'ilhan-omar-video-review-2026-11-12',
    title: 'Ilhan Omar video: claim-by-claim review',
    asOf: dates[0],
    reviewStatus: 'Research assessment; identified gaps remain. No human editorial sign-off.',
    scopeNotes: [
      'The original publication and recording dates are unknown. A local file date is not a publication date.',
      'The narrator is not independently authenticated. The recording carries a visible @ALEXISANNABETH watermark.',
      'Quotes come from a corrected automated transcript compared with a separate recognition pass. A complete listening review is outstanding.',
      'Unsubstantiated means the evidence reviewed does not adequately support a claim; it does not establish falsity.',
      'C017 supports the existence of a documented October-November 2026 inquiry, not the narrator’s authority or its live status on November 12.',
      'C029 concerns reported public support for Tim Walz. The intensity described as heavily is subjective.',
      'Different reports that depend on one record or statement are one underlying evidence stream.',
    ],
    video: { src: '/media/source.mp4', poster: '/video-poster.jpg', captions: '/transcript.vtt', durationSeconds: 179.1 },
    transcript: {
      language: text(rawTranscript.language) || 'en-us',
      provisional: true,
      note: 'Corrected automated transcription, not complete listening verification. Review wording near 00:56.500 and name spelling near 01:47.860 before quotation.',
      segments,
    },
    evidenceIds: sortedUnique(sources.map((source) => source.evidenceId)),
    claims,
    sources,
  };
} else {
  data = await readJSON(outputPath);
}

function validatePublicData(value) {
  assert(value.schemaVersion === 1, 'Unsupported public data schema.');
  assert(value.claims.length === 47 && value.sources.length === 40, 'Claim/source coverage changed.');
  assert(value.evidenceIds.length === 40, 'Retained evidence coverage changed.');
  const sourceIds = new Set(value.sources.map((source) => source.id));
  const evidenceIds = new Set(value.evidenceIds);
  assert(sourceIds.size === 40 && evidenceIds.size === 40, 'Duplicate source or evidence IDs.');
  for (const claim of value.claims) {
    assert(statuses[claim.verdict] === claim.status, `Incorrect verdict colour for ${claim.id}.`);
    assert(finiteTime(claim.start) && finiteTime(claim.end) && claim.end >= claim.start, `Invalid claim time for ${claim.id}.`);
    assert(claim.sourceIds.every((id) => sourceIds.has(id)), `Missing source for ${claim.id}.`);
    assert(claim.evidenceIds.every((id) => evidenceIds.has(id)), `Missing evidence for ${claim.id}.`);
    for (const ids of Object.values(claim.relations)) assert(ids.every((id) => evidenceIds.has(id)), `Missing relation evidence for ${claim.id}.`);
  }
  for (const source of value.sources) {
    const url = new URL(source.url);
    assert(['https:', 'http:'].includes(url.protocol) && !['localhost', '127.0.0.1'].includes(url.hostname), `Unsafe original URL for ${source.id}.`);
    assert(evidenceIds.has(source.evidenceId), `Retained evidence absent for ${source.id}.`);
    if (source.preview.kind === 'image') assert(assetsBySource.has(source.id), `Unapproved image for ${source.id}.`);
    if (restrictedSources.has(source.id)) {
      const words = [source.title, source.type, source.pinpoint, source.establishes, source.limits].join(' ').trim().split(/\s+/).length;
      assert(words <= 25 && source.usageLimitWords === 25, `Restricted source ${source.id} exceeds the short-summary allowance.`);
    }
  }
  for (const segment of value.transcript.segments) {
    assert(finiteTime(segment.start) && finiteTime(segment.end) && segment.end >= segment.start, `Invalid segment ${segment.id}.`);
    for (const word of segment.words) assert(finiteTime(word.start) && finiteTime(word.end) && word.end >= word.start, `Invalid word time in ${segment.id}.`);
  }
  const serialized = JSON.stringify(value);
  assert(!/(\/Users\/|\/home\/|\/tmp\/|file:\/\/|work\/factcheck\/|corrected-project\.xml)/i.test(serialized), 'Local path or internal working metadata leaked into public data.');
  for (const id of ['C017', 'C029']) {
    const claim = value.claims.find((item) => item.id === id);
    assert(claim && claim.scope && claim.finding && claim.counterevidence, `Missing qualified scope for ${id}.`);
  }
}

function timestamp(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const secs = Math.floor(milliseconds / 1000) % 60;
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function captionsFromTranscript(segments) {
  const captionLines = (body) => {
    const lines = []; let line = '';
    for (const word of body.split(/\s+/)) {
      if (line && `${line} ${word}`.length > 42) { lines.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
    return lines;
  };
  const cues = [];
  let current = [];
  const finish = () => { if (current.length) cues.push(current); current = []; };
  for (const segment of segments) {
    for (const word of segment.words) {
      const prior = current.at(-1);
      const proposed = [...current, word].map((item) => item.text).join(' ');
      if (prior && (word.start - prior.end > 0.6 || word.end - current[0].start > 6 || proposed.length > 78 || captionLines(proposed).length > 2)) finish();
      current.push(word);
      if (/[.!?]$/.test(word.text) && current.map((item) => item.text).join(' ').length > 12) finish();
    }
    finish();
  }
  const wrap = (body) => captionLines(body).join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return 'WEBVTT\n\nNOTE\nCorrected automated transcript. Not complete listening verification.\n\n' + cues.map((words, index) => {
    const start = words[0].start;
    const end = Math.max(start + 0.04, words.at(-1).end);
    return `${index + 1}\n${timestamp(start)} --> ${timestamp(end)}\n${wrap(words.map((word) => word.text).join(' '))}\n`;
  }).join('\n');
}

validatePublicData(data);
await access(join(publicRoot, 'video-poster.jpg'));
const jsonOutput = JSON.stringify(data, null, 2) + '\n';
const vttOutput = captionsFromTranscript(data.transcript.segments);
if (checkOnly) {
  assert(await readFile(outputPath, 'utf8') === jsonOutput, 'Public case.json needs regeneration.');
  assert(await readFile(captionsPath, 'utf8') === vttOutput, 'Public captions need regeneration.');
} else {
  await writeFile(outputPath, jsonOutput);
  await writeFile(captionsPath, vttOutput);
}
console.log(`${checkOnly ? 'Verified' : 'Built'} ${data.claims.length} claims, ${data.sources.length} sources, ${data.evidenceIds.length} evidence IDs, ${data.transcript.segments.length} transcript segments and ${assetManifest.assets.length} local previews${hasPrivateInputs ? '' : ' from committed public data'}.`);
