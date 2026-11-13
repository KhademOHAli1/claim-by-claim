import { createKnowledgeStore } from './knowledge.mjs';
import { normalizeEngagement } from './sources.mjs';

const day = 24 * 60 * 60_000;
const defaultLeaseMs = 20 * 60_000;
const maxTranscriptionAttempts = 2;
const defaultResearchMonthlyLimit = 20;

function utcMonth(timestamp) {
  return `${timestamp.slice(0, 7)}-01T00:00:00.000Z`;
}

function statement(sql, ...params) {
  return params.length ? { sql, params } : { sql };
}

function first(results) {
  return results[0]?.[0] ?? null;
}

function validateTranscript({ language, segments, durationSeconds }) {
  if (typeof language !== 'string' || !language.trim() || language.length > 100) {
    throw new Error('Transcript language is required.');
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Array.isArray(segments) || !segments.length) {
    throw new Error('A timed transcript and measured video duration are required.');
  }
  const ids = new Set();
  let previousStart = 0;
  for (const { id, start, end, text, words } of segments) {
    if (typeof id !== 'string' || !id.trim() || ids.has(id) ||
        !Number.isFinite(start) || start < previousStart ||
        !Number.isFinite(end) || end <= start || end > durationSeconds + 0.1 ||
        typeof text !== 'string' || !text.trim() ||
        (words !== undefined && !Array.isArray(words))) {
      throw new Error('Transcript segments require unique IDs, ordered timestamps, and nonempty text.');
    }
    ids.add(id);
    previousStart = start;
  }
}

function segmentInserts(caseId, transcriptId, segments) {
  return segments.map(({ id, start, end, text, words }) => statement(`
    INSERT INTO transcript_segments (case_id, transcript_id, id, start_seconds, end_seconds, text, words_json)
    SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM transcripts WHERE id = ? AND case_id = ?)
  `, caseId, transcriptId, id, start, end, text, JSON.stringify(words ?? []), transcriptId, caseId));
}

const runningLease = `
  id = ? AND video_id = ? AND kind = ? AND state = 'running'
  AND lease_token = ? AND lease_expires_at > ?
`;

const engagementInsert = `
  INSERT INTO engagement_observations
    (id, video_id, source_url, observed_at, recorded_at, recorded_by, limitations_json,
      views, likes, comments, shares, method)
  SELECT ?, v.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  FROM videos v JOIN video_posts p ON p.video_id = v.id
`;

function engagementValues(record, now, reviewer) {
  const { views, likes, comments, shares } = record.counts;
  return [
    crypto.randomUUID(), record.provenance.sourceUrl, record.observedAt, now, reviewer,
    JSON.stringify(record.limitations), views, likes, comments, shares, record.method,
  ];
}

function leaseParameters(job, now) {
  return [job.id, job.videoId, job.kind, job.leaseToken, now];
}

/** A batch adapter accepts prepared statements and returns one row array per statement. */
export function createWorkflowStore(batch, {
  clock = Date.now,
  database = 'sqlite',
  researchMonthlyLimit = defaultResearchMonthlyLimit,
} = {}) {
  if (!Number.isSafeInteger(researchMonthlyLimit) || researchMonthlyLimit < 0) {
    throw new Error('CLAIM_RESEARCH_MONTHLY_LIMIT must be a nonnegative whole number.');
  }
  const timestamp = () => new Date(clock()).toISOString();

  async function submit(title, sourceRef, postUrl = null) {
    const caseId = crypto.randomUUID();
    const videoId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const createdAt = timestamp();
    const postMatch = postUrl ? `
      AND EXISTS (SELECT 1 FROM video_posts p WHERE p.video_id = v.id AND p.post_url = ?)
    ` : '';
    const postParams = postUrl ? [postUrl] : [];
    const result = await batch([
      statement(`
        INSERT INTO cases (id, title, stage, created_at)
        SELECT ?, ?, 'submitted', ?
        WHERE NOT EXISTS (
          SELECT 1 FROM videos v JOIN jobs j ON j.video_id = v.id AND j.kind = 'transcribe'
          WHERE v.source_ref = ? ${postMatch}
        )
      `, caseId, title, createdAt, sourceRef, ...postParams),
      statement(`
        INSERT INTO videos (id, case_id, source_ref, created_at)
        SELECT ?, id, ?, ? FROM cases WHERE id = ?
      `, videoId, sourceRef, createdAt, caseId),
      statement(`
        INSERT INTO jobs (id, video_id, kind, state, created_at)
        SELECT ?, id, 'transcribe', 'queued', ? FROM videos WHERE id = ?
      `, jobId, createdAt, videoId),
      ...(postUrl ? [statement(`
        INSERT INTO video_posts (video_id, post_url)
        SELECT id, ? FROM videos WHERE id = ?
      `, postUrl, videoId)] : []),
      statement(`
        SELECT v.case_id AS caseId, v.id AS videoId, j.id AS jobId, j.state AS jobState
        FROM videos v JOIN jobs j ON j.video_id = v.id AND j.kind = 'transcribe'
        WHERE v.source_ref = ? ${postMatch}
        ORDER BY j.created_at DESC, j.id DESC LIMIT 1
      `, sourceRef, ...postParams),
    ]);
    const row = first([result.at(-1)]);
    if (!row) throw new Error('The video submission was not recorded.');
    return { ...row, alreadySubmitted: row.jobId !== jobId };
  }

  async function attachPost(caseId, postUrl) {
    const [, [row]] = await batch([
      statement(`
        INSERT INTO video_posts (video_id, post_url)
        SELECT id, ? FROM videos WHERE case_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
        ON CONFLICT (video_id) DO NOTHING
      `, postUrl, caseId),
      statement(`
        SELECT v.id AS videoId, p.post_url AS postUrl
        FROM videos v JOIN video_posts p ON p.video_id = v.id
        WHERE v.case_id = ? ORDER BY v.created_at DESC, v.id DESC LIMIT 1
      `, caseId),
    ]);
    if (!row) throw new Error('Case not found.');
    if (row.postUrl !== postUrl) throw new Error('This video already has a different original post URL.');
    return row;
  }

  async function media(caseId) {
    const [[record], frames, engagement] = await batch([
      statement(`
        SELECT v.id AS videoId, v.sha256 AS mediaSha256, p.post_url AS postUrl,
          a.method, a.sampling_status AS samplingStatus, a.ocr_status AS ocrStatus,
          sc.method AS captureMethod, sc.media_url AS mediaUrl, sc.captured_at AS capturedAt
        FROM videos v LEFT JOIN video_posts p ON p.video_id = v.id
        LEFT JOIN jobs j ON j.video_id = v.id AND j.kind = 'transcribe' AND j.state = 'succeeded'
        LEFT JOIN video_analysis a ON a.transcript_id = j.output_transcript_id
        LEFT JOIN source_captures sc ON sc.transcript_id = j.output_transcript_id
        WHERE v.case_id = ? ORDER BY v.created_at DESC, v.id DESC LIMIT 1
      `, caseId),
      statement(`
        SELECT f.offset_seconds AS offsetSeconds, f.sha256, f.ocr_text AS ocrText
        FROM video_frames f JOIN jobs j ON j.output_transcript_id = f.transcript_id
        WHERE j.video_id = (SELECT id FROM videos WHERE case_id = ? ORDER BY created_at DESC, id DESC LIMIT 1)
        ORDER BY f.offset_seconds
      `, caseId),
      statement(`
        SELECT e.id, e.method, e.source_url AS sourceUrl, e.observed_at AS observedAt, e.recorded_by AS recordedBy,
          e.recorded_at AS recordedAt, e.views, e.likes, e.comments, e.shares, e.limitations_json
        FROM engagement_observations e
        WHERE e.video_id = (SELECT id FROM videos WHERE case_id = ? ORDER BY created_at DESC, id DESC LIMIT 1)
        ORDER BY e.observed_at DESC, e.id LIMIT 50
      `, caseId),
    ]);
    if (!record) throw new Error('Case not found.');
    return { ...record, frames, engagement: engagement.map(({
      id, method, sourceUrl, observedAt, recordedAt, recordedBy, views, likes, comments, shares, limitations_json,
    }) => ({
      id, method, observedAt, recordedAt, recordedBy, provenance: { sourceUrl },
      counts: { views, likes, comments, shares }, limitations: JSON.parse(limitations_json),
    })) };
  }

  async function recordEngagement(caseId, input, reviewer) {
    const record = normalizeEngagement(input);
    if (record.method !== 'manual') throw new Error('Only manually observed engagement is retained.');
    if (typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 200) {
      throw new Error('An editor name is required to record engagement.');
    }
    const { views, likes, comments, shares } = record.counts;
    if ([views, likes, comments, shares].every((count) => count === null)) {
      throw new Error('At least one engagement count is required.');
    }
    const row = first(await batch([statement(`
      ${engagementInsert}
      WHERE v.id = (
        SELECT id FROM videos WHERE case_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
      ) AND p.post_url = ?
      ON CONFLICT (video_id, observed_at, source_url) DO NOTHING
      RETURNING id
    `, ...engagementValues(record, timestamp(), reviewer.trim()), caseId, record.postUrl)]));
    if (!row) throw new Error('The original post must match the case, and each observation must be new.');
    return { ...row, ...record };
  }

  async function status() {
    const monthStartsAt = utcMonth(timestamp());
    const [[counts], cases, recentJobs, [researchBudget]] = await batch([
      statement(`
        SELECT (SELECT COUNT(*) FROM cases) AS cases,
               (SELECT COUNT(*) FROM videos) AS videos,
               (SELECT COUNT(*) FROM transcript_segments) AS transcriptSegments,
               (SELECT COUNT(*) FROM claims) AS claims,
               (SELECT COUNT(*) FROM sources) AS sources,
               (SELECT COUNT(*) FROM evidence) AS evidence,
               (SELECT COUNT(*) FROM claim_evidence) AS claimEvidenceLinks,
               (SELECT COUNT(*) FROM transcript_approvals) AS approvedTranscripts,
               (SELECT COUNT(*) FROM research_drafts) AS researchDrafts
      `),
      statement('SELECT id, title, stage FROM cases ORDER BY created_at, id'),
      statement(`
        SELECT j.id, v.case_id AS caseId, j.kind, j.state, j.created_at AS createdAt,
          j.attempt_count AS attemptCount, j.started_at AS startedAt,
          j.finished_at AS finishedAt, j.last_error AS lastError
        FROM jobs j JOIN videos v ON v.id = j.video_id
        ORDER BY j.created_at DESC, j.id DESC LIMIT 20
      `),
      statement(`
        SELECT COUNT(*) AS started, ? AS monthStartsAt, ? AS monthlyLimit
        FROM jobs WHERE kind = 'research' AND started_at >= ?
      `, monthStartsAt, researchMonthlyLimit, monthStartsAt),
    ]);
    return { database, counts, cases, recentJobs, researchBudget };
  }

  async function showCase(caseId) {
    const [[caseRecord], videos, transcripts, transcriptSegments, claims, sources, evidence,
      claimEvidence, visualObservations, approvals, jobs] = await batch([
      statement('SELECT * FROM cases WHERE id = ?', caseId),
      statement('SELECT * FROM videos WHERE case_id = ? ORDER BY created_at, id', caseId),
      statement('SELECT * FROM transcripts WHERE case_id = ? ORDER BY created_at, id', caseId),
      statement(`
        SELECT * FROM transcript_segments WHERE case_id = ? ORDER BY transcript_id, start_seconds, id
      `, caseId),
      statement('SELECT * FROM claims WHERE case_id = ? ORDER BY start_seconds, id', caseId),
      statement('SELECT * FROM sources WHERE case_id = ? ORDER BY id', caseId),
      statement('SELECT * FROM evidence WHERE case_id = ? ORDER BY id', caseId),
      statement('SELECT * FROM claim_evidence WHERE case_id = ? ORDER BY claim_id, evidence_id', caseId),
      statement(`
        SELECT * FROM visual_observations WHERE case_id = ? ORDER BY video_id, timestamp_seconds, id
      `, caseId),
      statement('SELECT * FROM transcript_approvals WHERE case_id = ?', caseId),
      statement(`
        SELECT j.id, j.video_id, j.kind, j.state, j.created_at, j.started_at,
          j.attempt_count, j.finished_at, j.last_error
        FROM jobs j JOIN videos v ON v.id = j.video_id WHERE v.case_id = ?
        ORDER BY j.created_at, j.id
      `, caseId),
    ]);
    if (!caseRecord) throw new Error('Case not found.');
    return { case: caseRecord, videos, transcripts, transcriptSegments, claims, sources, evidence,
      claimEvidence, visualObservations, approvals, jobs };
  }

  async function loadTranscript(caseId, transcriptId) {
    const [[record], segments] = await batch([
      statement(`
        SELECT t.case_id AS caseId, t.video_id AS videoId, t.id AS transcriptId,
          t.language, t.note, t.provisional, v.duration_seconds AS durationSeconds
        FROM transcripts t JOIN videos v ON v.id = t.video_id
        WHERE t.case_id = ? AND t.id = ?
      `, caseId, transcriptId),
      statement(`
        SELECT id, start_seconds AS start, end_seconds AS end, text, words_json
        FROM transcript_segments WHERE case_id = ? AND transcript_id = ?
        ORDER BY start_seconds, id
      `, caseId, transcriptId),
    ]);
    if (!record) throw new Error('Transcript not found.');
    return { ...record, segments: segments.map(({ words_json, ...segment }) => ({
      ...segment, words: JSON.parse(words_json),
    })) };
  }

  async function transcript(caseId) {
    const job = first(await batch([statement(`
      SELECT j.output_transcript_id AS transcriptId FROM jobs j JOIN videos v ON v.id = j.video_id
      WHERE v.case_id = ? AND j.kind = 'transcribe' AND j.state = 'succeeded'
        AND j.output_transcript_id IS NOT NULL
      ORDER BY j.finished_at DESC, j.id DESC LIMIT 1
    `, caseId)]));
    if (!job) throw new Error('No transcript is ready for review.');
    return loadTranscript(caseId, job.transcriptId);
  }

  async function observe(caseId, timestampSeconds, observation) {
    if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0 ||
        typeof observation !== 'string' || !observation.trim() || observation.length > 2000) {
      throw new Error('Provide a nonnegative video timestamp and an observation up to 2000 characters.');
    }
    const row = first(await batch([statement(`
      INSERT INTO visual_observations (case_id, video_id, id, timestamp_seconds, observation, created_at)
      SELECT v.case_id, v.id, ?, ?, ?, ?
      FROM videos v JOIN cases c ON c.id = v.case_id
        JOIN jobs j ON j.video_id = v.id AND j.kind = 'transcribe' AND j.state = 'succeeded'
      WHERE c.id = ? AND c.stage = 'needs_transcript_review' AND v.duration_seconds >= ?
        AND j.output_transcript_id IS NOT NULL
      ORDER BY j.finished_at DESC, j.id DESC LIMIT 1
      RETURNING case_id AS caseId, video_id AS videoId, id, timestamp_seconds AS timestampSeconds, observation
    `, crypto.randomUUID(), timestampSeconds, observation.trim(), timestamp(), caseId, timestampSeconds)]));
    if (!row) throw new Error('The case must be awaiting transcript review, and the timestamp must be within its video.');
    return row;
  }

  async function claim({ leaseMs = defaultLeaseMs, caseId = null, kind = null, allowResearch = false, allowLocal = true } = {}) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > day) throw new Error('Invalid job lease length.');
    if (kind !== null && !['transcribe', 'research'].includes(kind)) throw new Error('Unknown job kind.');
    const nowMs = clock();
    const now = new Date(nowMs).toISOString();
    const leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
    const leaseToken = crypto.randomUUID();
    const [, , [job]] = await batch([
      statement(`
        UPDATE jobs
        SET state = CASE WHEN kind = 'transcribe' AND attempt_count < ? THEN 'queued' ELSE 'failed' END,
          finished_at = CASE WHEN kind = 'transcribe' AND attempt_count < ? THEN NULL ELSE ? END,
          last_error = 'The runner stopped before the job completed.',
          lease_token = NULL, lease_expires_at = NULL
        WHERE state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      `, maxTranscriptionAttempts, maxTranscriptionAttempts, now, now),
      statement(`
        UPDATE jobs SET state = 'running', lease_token = ?, lease_expires_at = ?,
          started_at = ?, attempt_count = attempt_count + 1, last_error = NULL
        WHERE id = (
          SELECT j.id
          FROM jobs j JOIN videos v ON v.id = j.video_id JOIN cases c ON c.id = v.case_id
          WHERE j.state = 'queued' AND (? IS NULL OR v.case_id = ?) AND (? IS NULL OR j.kind = ?)
            AND ((j.kind = 'transcribe' AND c.stage IN ('submitted', 'transcribing')
                AND (? = 1 OR v.source_ref LIKE 'https://%'))
              OR (? = 1 AND j.kind = 'research' AND c.stage = 'researching'
                AND (SELECT COUNT(*) FROM jobs WHERE kind = 'research' AND started_at >= ?) < ?
                AND EXISTS (
                SELECT 1 FROM transcript_approvals a
                WHERE a.video_id = j.video_id AND a.approved_transcript_id = j.input_transcript_id
              )))
          ORDER BY j.created_at, j.id LIMIT 1
        )
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE state = 'running')
      `, leaseToken, leaseExpiresAt, now, caseId, caseId, kind, kind, Number(allowLocal), Number(allowResearch),
      utcMonth(now), researchMonthlyLimit),
      statement(`
        SELECT j.id, v.case_id AS caseId, j.video_id AS videoId, j.kind,
          v.source_ref AS sourceRef, c.title, j.lease_token AS leaseToken,
          j.lease_expires_at AS leaseExpiresAt, j.attempt_count AS attemptCount,
          j.input_transcript_id AS transcriptId
        FROM jobs j JOIN videos v ON v.id = j.video_id JOIN cases c ON c.id = v.case_id
        WHERE j.state = 'running' AND j.lease_token = ?
      `, leaseToken),
      statement(`
        UPDATE cases SET stage = 'transcribing'
        WHERE stage = 'submitted' AND id IN (
          SELECT v.case_id FROM jobs j JOIN videos v ON v.id = j.video_id
          WHERE j.kind = 'transcribe' AND j.state = 'running' AND j.lease_token = ?
        )
      `, leaseToken),
    ]);
    return job ?? null;
  }

  async function finishTranscription(job, result) {
    if (job.kind !== 'transcribe') throw new Error('Expected a transcription job.');
    validateTranscript(result);
    const now = timestamp();
    const transcriptId = crypto.randomUUID();
    const lease = leaseParameters(job, now);
    const visual = result.visual;
    const visualInserts = visual ? [
      statement(`
        INSERT INTO video_analysis (transcript_id, method, sampling_status, ocr_status, created_at)
        SELECT id, ?, ?, ?, ? FROM transcripts WHERE id = ?
      `, visual.method, visual.samplingStatus, visual.ocrStatus, now, transcriptId),
      ...visual.frames.map((frame) => statement(`
        INSERT INTO video_frames (transcript_id, offset_seconds, sha256, ocr_text)
        SELECT transcript_id, ?, ?, ? FROM video_analysis WHERE transcript_id = ?
      `, frame.offsetSeconds, frame.sha256, frame.ocrText, transcriptId)),
    ] : [];
    const capture = result.capture;
    const captureInserts = capture ? [statement(`
      INSERT INTO source_captures (transcript_id, method, media_url, captured_at)
      SELECT id, ?, ?, ? FROM transcripts WHERE id = ?
    `, capture.method, capture.mediaUrl, capture.capturedAt, transcriptId)] : [];
    if (capture?.engagement) {
      const engagement = normalizeEngagement(capture.engagement);
      if (engagement.method !== 'mastodon-public-api' || capture.method !== engagement.method) {
        throw new Error('The captured engagement provider does not match the video source.');
      }
      if (Object.values(engagement.counts).some((count) => count !== null)) {
        captureInserts.push(statement(`
          ${engagementInsert}
          WHERE v.id = ? AND p.post_url = ? AND EXISTS (SELECT 1 FROM transcripts WHERE id = ?)
          ON CONFLICT (video_id, observed_at, source_url) DO NOTHING
        `, ...engagementValues(engagement, now, 'Mastodon public API'), job.videoId, engagement.postUrl, transcriptId));
      }
    }
    const results = await batch([
      statement(`
        INSERT INTO transcripts (id, case_id, video_id, language, provisional, note, created_at)
        SELECT ?, case_id, id, ?, 1, ?, ? FROM videos
        WHERE id = ? AND case_id = ? AND EXISTS (SELECT 1 FROM jobs WHERE ${runningLease})
      `, transcriptId, result.language, result.note ?? null, now, job.videoId, job.caseId, ...lease),
      ...segmentInserts(job.caseId, transcriptId, result.segments),
      ...visualInserts,
      ...captureInserts,
      statement(`
        UPDATE videos SET duration_seconds = ?, sha256 = COALESCE(?, sha256),
          size_bytes = COALESCE(?, size_bytes)
        WHERE id = ? AND EXISTS (SELECT 1 FROM transcripts WHERE id = ? AND video_id = videos.id)
      `, result.durationSeconds, result.sha256 ?? null, result.sizeBytes ?? null, job.videoId, transcriptId),
      statement(`
        UPDATE cases SET stage = 'needs_transcript_review'
        WHERE id = ? AND EXISTS (SELECT 1 FROM transcripts WHERE id = ? AND case_id = cases.id)
      `, job.caseId, transcriptId),
      statement(`
        UPDATE jobs SET state = 'succeeded', output_transcript_id = ?, finished_at = ?,
          lease_token = NULL, lease_expires_at = NULL, last_error = NULL
        WHERE ${runningLease} AND EXISTS (SELECT 1 FROM transcripts WHERE id = ?)
        RETURNING id
      `, transcriptId, now, ...lease, transcriptId),
    ]);
    return results.at(-1).length === 1;
  }

  async function approve(caseId, review, reviewer) {
    if (typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 200) {
      throw new Error('An editor name is required for transcript approval.');
    }
    const draft = await transcript(caseId);
    if (!review || review.caseId !== caseId || review.transcriptId !== draft.transcriptId) {
      throw new Error('Review the latest draft transcript for this case before approving it.');
    }
    validateTranscript({ ...review, durationSeconds: draft.durationSeconds });
    if (review.segments.length !== draft.segments.length ||
        review.segments.some(({ id }, i) => id !== draft.segments[i].id)) {
      throw new Error('Keep the existing segment IDs and order when editing the transcript.');
    }
    const segments = review.segments.map(({ id, start, end, text }, i) => {
      const original = draft.segments[i];
      const unchanged = original.text === text && original.start === start && original.end === end;
      return { id, start, end, text, words: unchanged ? original.words : [] };
    });
    const now = timestamp();
    const approvedId = crypto.randomUUID();
    const researchJobId = crypto.randomUUID();
    const results = await batch([
      statement(`
        INSERT INTO transcripts (id, case_id, video_id, language, provisional, note, created_at)
        SELECT ?, t.case_id, t.video_id, ?, 0, ?, ?
        FROM transcripts t JOIN cases c ON c.id = t.case_id
        WHERE t.id = ? AND t.case_id = ? AND t.provisional = 1 AND c.stage = 'needs_transcript_review'
          AND NOT EXISTS (SELECT 1 FROM transcript_approvals a WHERE a.video_id = t.video_id)
          AND EXISTS (SELECT 1 FROM jobs j WHERE j.output_transcript_id = t.id AND j.state = 'succeeded')
      `, approvedId, review.language, review.note ?? null, now, draft.transcriptId, caseId),
      ...segmentInserts(caseId, approvedId, segments),
      statement(`
        INSERT INTO transcript_approvals (video_id, case_id, draft_transcript_id, approved_transcript_id, reviewer, approved_at)
        SELECT video_id, case_id, ?, id, ?, ? FROM transcripts WHERE id = ?
      `, draft.transcriptId, reviewer.trim(), now, approvedId),
      statement(`
        INSERT INTO jobs (id, video_id, kind, state, created_at, input_transcript_id)
        SELECT ?, video_id, 'research', 'queued', ?, approved_transcript_id
        FROM transcript_approvals WHERE approved_transcript_id = ?
      `, researchJobId, now, approvedId),
      statement(`
        UPDATE cases SET stage = 'researching'
        WHERE id = ? AND EXISTS (SELECT 1 FROM transcript_approvals WHERE approved_transcript_id = ?)
      `, caseId, approvedId),
      statement(`
        SELECT a.approved_transcript_id AS approvedTranscriptId, a.reviewer, a.approved_at AS approvedAt,
          j.id AS jobId, j.state AS jobState
        FROM transcript_approvals a JOIN jobs j ON j.video_id = a.video_id
          AND j.kind = 'research' AND j.input_transcript_id = a.approved_transcript_id
        WHERE a.video_id = ? AND a.draft_transcript_id = ?
        ORDER BY j.created_at DESC, j.id DESC LIMIT 1
      `, draft.videoId, draft.transcriptId),
    ]);
    const row = results.at(-1)[0];
    if (!row) throw new Error('This transcript is not awaiting approval.');
    return { ...row, alreadyApproved: row.approvedTranscriptId !== approvedId };
  }

  async function researchInput(job, { includeMedia = false } = {}) {
    if (job.kind !== 'research') throw new Error('Expected a research job.');
    const [[approval], visualObservations, sources] = await batch([
      statement(`
        SELECT a.approved_transcript_id AS transcriptId
        FROM transcript_approvals a JOIN jobs j ON j.video_id = a.video_id
        WHERE j.id = ? AND j.lease_token = ? AND j.state = 'running' AND j.lease_expires_at > ?
          AND a.case_id = ? AND j.input_transcript_id = a.approved_transcript_id
      `, job.id, job.leaseToken, timestamp(), job.caseId),
      statement(`
        SELECT id, timestamp_seconds AS timestampSeconds, observation, evidence_id AS evidenceId
        FROM visual_observations WHERE case_id = ? AND video_id = ? ORDER BY timestamp_seconds, id
      `, job.caseId, job.videoId),
      statement(`
        SELECT id, title, url, type, published, pinpoint, origin_group AS originGroup,
          establishes, limits, inspected FROM sources WHERE case_id = ? ORDER BY id
      `, job.caseId),
    ]);
    if (!approval) throw new Error('The approved transcript or research lease is unavailable.');
    const checked = await loadTranscript(job.caseId, approval.transcriptId);
    if (checked.provisional) throw new Error('Research requires a human-approved transcript.');
    const [frames] = includeMedia ? await batch([statement(`
      SELECT f.offset_seconds AS offsetSeconds, f.sha256, f.ocr_text AS ocrText
      FROM video_frames f JOIN transcript_approvals a ON a.draft_transcript_id = f.transcript_id
      WHERE a.approved_transcript_id = ? AND f.ocr_text IS NOT NULL ORDER BY f.offset_seconds
    `, approval.transcriptId)]) : [[]];
    return { ...checked, title: job.title, visualObservations, sources,
      frameLeads: frames };
  }

  async function finishResearch(job, result) {
    if (job.kind !== 'research') throw new Error('Expected a research job.');
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('A structured research draft is required.');
    }
    const payload = JSON.stringify(result);
    if (new TextEncoder().encode(payload).byteLength > 1_000_000) throw new Error('Research draft is too large.');
    const now = timestamp();
    const draftId = crypto.randomUUID();
    const lease = leaseParameters(job, now);
    const results = await batch([
      statement(`
        INSERT INTO research_drafts (id, job_id, case_id, video_id, transcript_id, payload_json, created_at)
        SELECT ?, j.id, a.case_id, j.video_id, j.input_transcript_id, ?, ?
        FROM jobs j JOIN transcript_approvals a ON a.video_id = j.video_id
          AND a.approved_transcript_id = j.input_transcript_id
        WHERE j.id IN (SELECT id FROM jobs WHERE ${runningLease}) AND a.case_id = ?
      `, draftId, payload, now, ...lease, job.caseId),
      statement(`
        UPDATE cases SET stage = 'needs_editor'
        WHERE id = ? AND EXISTS (SELECT 1 FROM research_drafts WHERE id = ? AND case_id = cases.id)
      `, job.caseId, draftId),
      statement(`
        UPDATE jobs SET state = 'succeeded', finished_at = ?, lease_token = NULL,
          lease_expires_at = NULL, last_error = NULL
        WHERE ${runningLease} AND EXISTS (SELECT 1 FROM research_drafts WHERE id = ?)
        RETURNING id
      `, now, ...lease, draftId),
    ]);
    return results.at(-1).length === 1;
  }

  async function fail(job, error) {
    const now = timestamp();
    const message = typeof error === 'string' ? error : error?.message ?? 'Unexpected runner error.';
    const result = first(await batch([statement(`
      UPDATE jobs SET state = 'failed', finished_at = ?, lease_token = NULL,
        lease_expires_at = NULL, last_error = ?
      WHERE ${runningLease} RETURNING id
    `, now, message.replaceAll(/[\r\n\0]+/g, ' ').slice(0, 500), ...leaseParameters(job, now))]));
    return Boolean(result);
  }

  async function retry(caseId, kind) {
    if (!['transcribe', 'research'].includes(kind)) throw new Error('Unknown job kind.');
    const jobId = crypto.randomUUID();
    const now = timestamp();
    const [rows] = await batch([statement(`
      INSERT INTO jobs (id, video_id, kind, state, created_at, input_transcript_id)
      SELECT ?, j.video_id, j.kind, 'queued', ?, j.input_transcript_id
      FROM jobs j JOIN videos v ON v.id = j.video_id JOIN cases c ON c.id = v.case_id
      WHERE v.case_id = ? AND j.kind = ? AND j.state IN ('failed', 'blocked')
        AND ((j.kind = 'transcribe' AND c.stage IN ('submitted', 'transcribing'))
          OR (j.kind = 'research' AND c.stage = 'researching' AND EXISTS (
            SELECT 1 FROM transcript_approvals a
            WHERE a.video_id = j.video_id AND a.approved_transcript_id = j.input_transcript_id
          )))
        AND NOT EXISTS (
          SELECT 1 FROM jobs active WHERE active.video_id = j.video_id AND active.kind = j.kind
            AND active.state IN ('queued', 'running', 'succeeded')
        )
      ORDER BY j.created_at DESC, j.id DESC LIMIT 1
      RETURNING id AS jobId, state AS jobState
    `, jobId, now, caseId, kind)]);
    if (!rows.length) throw new Error('There is no failed job eligible to retry.');
    return rows[0];
  }

  async function draft(caseId) {
    const row = first(await batch([statement(`
      SELECT id, job_id AS jobId, case_id AS caseId, video_id AS videoId, transcript_id AS transcriptId,
        created_at AS createdAt, payload_json
      FROM research_drafts WHERE case_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `, caseId)]));
    if (!row) throw new Error('No research draft is ready.');
    const { payload_json, ...metadata } = row;
    return { ...metadata, draft: JSON.parse(payload_json) };
  }

  return { submit, status, showCase, transcript, observe, claim, finishTranscription, approve, researchInput,
    finishResearch, fail, retry, draft, attachPost, media, recordEngagement, ...createKnowledgeStore(batch, { clock }) };
}
