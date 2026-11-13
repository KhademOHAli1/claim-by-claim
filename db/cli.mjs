import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Database } from 'bun:sqlite';
import { publicSeedSql } from './seed-public.mjs';
import { registerSource } from './intake.mjs';
import { fetchYouTubeEngagement, publicPostUrl } from './sources.mjs';
import { mastodonPostUrl } from './mastodon.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const migrationsDirectory = new URL('./migrations/', import.meta.url);
const databasePath = resolve(process.env.CLAIM_BY_CLAIM_DB || resolve(root, '.case-data/claim-by-claim.sqlite'));
const usage = `Usage:
  bun run db status
  bun run db case "<case-id>"
  bun run db submit "<title>" "<Mastodon post, direct HTTPS video URL, or local video path>" ["<original post URL>"]
  bun run db attach-post "<case-id>" "<original post URL>"
  bun run db media "<case-id>"
  bun run db engagement "<case-id>" "<observation.json>"
  bun run db youtube-metrics "<YouTube post URL>"
  bun run db knowledge-put "<node.json>"
  bun run db knowledge-link "<edge.json>"
  bun run db knowledge-find "<search text>"
  bun run db knowledge-node "<node-id>"
  bun run db transcript "<case-id>" "<review.json>"
  bun run db observe "<case-id>" "<seconds>" "<what is visible>"
  bun run db approve "<case-id>" "<review.json>"
  bun run db draft "<case-id>"
  bun run db retry "<case-id>" <transcribe|research>

Use --local as the first argument for the original SQLite commands (init/status/case/submit).
Set CLAIM_BY_CLAIM_DB to select a different local SQLite file.`;

async function migrate(db) {
  const files = (await readdir(migrationsDirectory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const migrations = await Promise.all(files.map(async (name) => {
    const sql = await readFile(new URL(name, migrationsDirectory), 'utf8');
    const sha256 = createHash('sha256').update(sql).digest('hex');
    return { name, sql, sha256 };
  }));

  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_schema_migrations (
        name TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL
      )
    `);
    for (const { name, sql, sha256 } of migrations) {
      const applied = db.query('SELECT sha256 FROM local_schema_migrations WHERE name = ?').get(name);
      if (applied) {
        if (applied.sha256 !== sha256) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      db.exec(sql);
      db.run('INSERT INTO local_schema_migrations (name, sha256) VALUES (?, ?)', [name, sha256]);
    }
  }).immediate();
}

async function sourceReference(source) {
  if (/^[a-z][a-z\d+.-]*:/i.test(source)) {
    const url = new URL(source);
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('Use an HTTPS video URL without embedded credentials, or a local file path.');
    }
    return url.href;
  }

  const path = await realpath(source);
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error('The local video must be a nonempty file.');
  return pathToFileURL(path).href;
}

function submit(db, title, source) {
  return db.transaction(() => {
    const existing = db.query(`
      SELECT v.case_id AS caseId, v.id AS videoId, j.id AS jobId, j.state AS jobState
      FROM videos v
      JOIN jobs j ON j.video_id = v.id AND j.kind = 'transcribe'
      WHERE v.source_ref = ?
      ORDER BY j.created_at, j.id
      LIMIT 1
    `).get(source);
    if (existing) return { ...existing, alreadySubmitted: true };

    const caseId = randomUUID();
    const videoId = randomUUID();
    const jobId = randomUUID();
    const createdAt = new Date().toISOString();
    db.run('INSERT INTO cases (id, title, stage, created_at) VALUES (?, ?, ?, ?)',
      [caseId, title, 'submitted', createdAt]);
    db.run('INSERT INTO videos (id, case_id, source_ref, created_at) VALUES (?, ?, ?, ?)',
      [videoId, caseId, source, createdAt]);
    db.run('INSERT INTO jobs (id, video_id, kind, state, created_at) VALUES (?, ?, ?, ?, ?)',
      [jobId, videoId, 'transcribe', 'queued', createdAt]);
    return { caseId, videoId, jobId, jobState: 'queued', alreadySubmitted: false };
  }).immediate();
}

function status(db) {
  const counts = db.query(`
    SELECT (SELECT COUNT(*) FROM cases) AS cases,
           (SELECT COUNT(*) FROM videos) AS videos,
           (SELECT COUNT(*) FROM transcript_segments) AS transcriptSegments,
           (SELECT COUNT(*) FROM claims) AS claims,
           (SELECT COUNT(*) FROM sources) AS sources,
           (SELECT COUNT(*) FROM evidence) AS evidence,
           (SELECT COUNT(*) FROM claim_evidence) AS claimEvidenceLinks
  `).get();
  const cases = db.query('SELECT id, title, stage FROM cases ORDER BY created_at, id').all();
  const jobs = db.query(`
    SELECT j.id, v.case_id AS caseId, j.kind, j.state, j.created_at AS createdAt
    FROM jobs j JOIN videos v ON v.id = j.video_id
    ORDER BY j.created_at DESC, j.id
    LIMIT 20
  `).all();
  return { database: databasePath, counts, cases, recentJobs: jobs };
}

function showCase(db, caseId) {
  const caseRecord = db.query('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!caseRecord) throw new Error(`Case not found: ${caseId}`);
  return {
    case: caseRecord,
    videos: db.query('SELECT * FROM videos WHERE case_id = ? ORDER BY created_at, id').all(caseId),
    transcripts: db.query('SELECT * FROM transcripts WHERE case_id = ? ORDER BY created_at, id').all(caseId),
    transcriptSegments: db.query(`
      SELECT * FROM transcript_segments WHERE case_id = ? ORDER BY transcript_id, start_seconds, id
    `).all(caseId),
    claims: db.query('SELECT * FROM claims WHERE case_id = ? ORDER BY start_seconds, id').all(caseId),
    sources: db.query('SELECT * FROM sources WHERE case_id = ? ORDER BY id').all(caseId),
    evidence: db.query('SELECT * FROM evidence WHERE case_id = ? ORDER BY id').all(caseId),
    claimEvidence: db.query('SELECT * FROM claim_evidence WHERE case_id = ? ORDER BY claim_id, evidence_id').all(caseId),
    visualObservations: db.query(`
      SELECT * FROM visual_observations WHERE case_id = ? ORDER BY video_id, timestamp_seconds, id
    `).all(caseId),
  };
}

async function localMain([command, ...args]) {
  if (command === undefined || command === '--help') {
    console.log(usage);
    return;
  }
  if (command === 'init' && args.length === 0) {
    const seed = await publicSeedSql();
    await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
    const db = new Database(databasePath);
    try {
      db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      await migrate(db);
      db.transaction(() => db.exec(seed)).immediate();
      console.log(JSON.stringify(status(db), null, 2));
    } finally {
      db.close();
    }
    return;
  }

  const isStatus = command === 'status' && args.length === 0;
  const isCase = command === 'case' && args.length === 1;
  const isSubmission = command === 'submit' && args.length === 2;
  if (!isStatus && !isCase && !isSubmission) throw new Error(usage);
  await stat(databasePath).catch((error) => {
    if (error.code === 'ENOENT') throw new Error('Run bun run db init first.');
    throw error;
  });
  const db = new Database(databasePath, { readonly: !isSubmission, create: false });
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (isStatus) {
      console.log(JSON.stringify(status(db), null, 2));
      return;
    }
    if (isCase) {
      console.log(JSON.stringify(showCase(db, args[0]), null, 2));
      return;
    }
    const title = args[0].trim();
    if (!title || title.length > 200) throw new Error('Use a title between 1 and 200 characters.');
    const source = await sourceReference(args[1]);
    console.log(JSON.stringify(submit(db, title, source), null, 2));
  } finally {
    db.close();
  }
}

function json(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function readJsonFile(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 2_000_000) throw new Error('Choose a JSON file smaller than 2 MB.');
  return JSON.parse(await readFile(path, 'utf8'));
}

function originalPost(value) {
  const url = mastodonPostUrl(value) ?? publicPostUrl(value);
  if (!url) throw new Error('Use a public HTTPS original post URL.');
  return url;
}

async function main([command, ...args]) {
  if (command === '--local') return localMain(args);
  if (command === 'init') return localMain([command, ...args]);
  if (command === undefined || command === '--help') return console.log(usage);
  if (command === 'youtube-metrics' && args.length === 1) {
    return json(await fetchYouTubeEngagement(args[0], {
      apiKey: process.env.CLAIM_BY_CLAIM_YOUTUBE_API_KEY, signal: AbortSignal.timeout(12_000),
    }));
  }
  const commands = {
    status: [0], case: [1], submit: [2, 3], transcript: [2], observe: [3], approve: [2], draft: [1], retry: [2],
    'attach-post': [2], media: [1], engagement: [2], 'knowledge-put': [1], 'knowledge-link': [1],
    'knowledge-find': [1], 'knowledge-node': [1],
  };
  if (!Object.hasOwn(commands, command) || !commands[command].includes(args.length)) throw new Error(usage);

  const { createD1Store } = await import('./d1-transport.mjs');
  const store = createD1Store();
  const [id, path] = args;
  const reviewer = process.env.CLAIM_BY_CLAIM_REVIEWER || userInfo().username;
  switch (command) {
    case 'status': return json(await store.status());
    case 'case': return json(await store.showCase(id));
    case 'submit': {
      const title = id.trim();
      if (!title || title.length > 200) throw new Error('Use a title between 1 and 200 characters.');
      const postUrl = args.length === 3 ? originalPost(args[2]) : null;
      const platformUrl = mastodonPostUrl(path);
      if (platformUrl && postUrl && platformUrl !== postUrl) throw new Error('The original post must match the submitted link.');
      return json(await store.submit(title, await registerSource(path), platformUrl ?? postUrl));
    }
    case 'attach-post': return json(await store.attachPost(id, originalPost(path)));
    case 'media': return json(await store.media(id));
    case 'engagement': return json(await store.recordEngagement(id, await readJsonFile(path), reviewer));
    case 'knowledge-put': return json(await store.putKnowledgeNode(await readJsonFile(id), reviewer));
    case 'knowledge-link': return json(await store.linkKnowledgeNodes(await readJsonFile(id), reviewer));
    case 'knowledge-find': return json(await store.findKnowledge(id));
    case 'knowledge-node': return json(await store.knowledgeNode(id));
    case 'transcript': {
      const transcript = await store.transcript(id);
      if (!transcript) throw new Error('There is no transcript to review yet. Check the job status.');
      await writeFile(path, JSON.stringify(transcript, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      return console.log(`Wrote ${path}. Check the video against the transcript, save any corrections, then run db approve.`);
    }
    case 'approve': {
      return json(await store.approve(id, await readJsonFile(path), reviewer));
    }
    case 'observe': {
      if (!/^\d+(?:\.\d+)?$/.test(path)) throw new Error('Enter the timestamp in seconds, for example 42.5.');
      return json(await store.observe(id, Number(path), args[2]));
    }
    case 'draft': {
      const draft = await store.draft(id);
      if (!draft) throw new Error('There is no Codex draft yet. Check the job status.');
      return json(draft);
    }
    case 'retry': return json(await store.retry(id, path));
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
