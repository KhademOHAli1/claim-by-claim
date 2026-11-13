import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createD1Store } from './d1-transport.mjs';
import { privateDirectory, resolveRunnerSource } from './intake.mjs';
import { mastodonPostUrl, resolveMastodonVideo } from './mastodon.mjs';
import { checkResearchSetup, draftFindings } from './research.mjs';
import { checkTranscriptionSetup, transcribeVideo } from './transcribe.mjs';

const pollMs = 120_000;
const maximumJobMs = 8 * 60_000;
const leaseMs = 12 * 60_000;
const usage = `Usage:
  bun run db:runner --check
  bun run db:runner --once [--case CASE_ID] [--max-claims N]
  bun run db:runner --watch`;

function parseArgs(args) {
  const [mode, ...options] = args;
  if (!['--check', '--once', '--watch'].includes(mode)) throw new Error(usage);
  if (options.length && mode !== '--once') throw new Error(usage);
  let caseId;
  let maxClaims;
  for (let index = 0; index < options.length; index += 2) {
    const [option, value] = options.slice(index, index + 2);
    if (option === '--case' && value && !value.startsWith('-') && caseId === undefined) {
      caseId = value;
    } else if (option === '--max-claims' && /^(?:[1-9]|1[0-2])$/.test(value || '') && maxClaims === undefined) {
      maxClaims = Number(value);
    } else {
      throw new Error(usage);
    }
  }
  return { mode, caseId, maxClaims };
}

function report(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

async function runOne(store, options, stopSignal) {
  stopSignal.throwIfAborted();
  const job = await store.claim({
    caseId: options.caseId,
    allowResearch: true,
    allowLocal: process.env.CLAIM_BY_CLAIM_REMOTE_MEDIA_ONLY !== '1',
    leaseMs,
  });
  if (!job) return null;
  const summary = { caseId: job.caseId, jobId: job.id, kind: job.kind };
  report('started', summary);
  let workDir;
  try {
    await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
    workDir = await mkdtemp(join(privateDirectory, 'job-'));
    const signal = AbortSignal.any([stopSignal, AbortSignal.timeout(maximumJobMs)]);
    signal.throwIfAborted();

    if (job.kind === 'transcribe') {
      const postUrl = mastodonPostUrl(job.sourceRef);
      const platform = postUrl ? await resolveMastodonVideo(postUrl, { signal }) : null;
      const source = platform?.mediaUrl ?? await resolveRunnerSource(job.sourceRef);
      const result = await transcribeVideo(source, { signal, workDir });
      result.capture = {
        method: platform ? 'mastodon-public-api' : source.startsWith('file:') ? 'local-file' : 'direct-https',
        mediaUrl: source.startsWith('https:') ? source : null,
        capturedAt: result.mediaReadAt,
        engagement: platform?.engagement,
      };
      signal.throwIfAborted();
      const saved = await store.finishTranscription(job, result);
      report(saved ? 'awaiting_transcript_review' : 'lease_lost', summary);
      return saved;
    }

    const input = await store.researchInput(job, { includeMedia: true });
    const searchText = [input.title, ...input.segments.map((segment) => segment.text)].join(' ').slice(0, 2000);
    const relatedCaseLeads = (await store.findKnowledge({ text: searchText, limit: 12, researchOnly: true }))
      .filter((node) => node.caseId !== job.caseId && node.claimCaseId !== job.caseId && node.score >= 0.35)
      .slice(0, 4);
    const result = await draftFindings({ ...input, relatedCaseLeads }, { signal, maxClaims: options.maxClaims });
    signal.throwIfAborted();
    const saved = await store.finishResearch(job, result);
    report(saved ? 'draft_ready' : 'lease_lost', summary);
    return saved;
  } catch (error) {
    const saved = await store.fail(job, error);
    report(saved ? 'job_failed' : 'lease_lost', summary);
    return false;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stop = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => stop.abort(new Error('Runner stopped.')));
  }
  const store = createD1Store();

  await Promise.all([checkTranscriptionSetup(), checkResearchSetup(), store.status()]);
  report('ready');
  if (options.mode === '--check') return;
  if (options.mode === '--once') {
    const result = await runOne(store, options, stop.signal);
    if (result === null) report('no_queued_jobs');
    if (result === false) process.exitCode = 1;
    return;
  }

  while (!stop.signal.aborted) {
    let result;
    try {
      result = await runOne(store, options, stop.signal);
    } catch (error) {
      if (!stop.signal.aborted) report('queue_error', { message: String(error.message || error).slice(0, 240) });
    }
    if (result !== true) await delay(pollMs, undefined, { signal: stop.signal }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
