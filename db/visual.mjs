import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const method = 'ffmpeg-even-sampling-v1';
const maximumFrames = 8;
const processEnv = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'SYSTEMROOT'].flatMap((key) =>
  process.env[key] === undefined ? [] : [[key, process.env[key]]]));

async function sampleFrame(ffmpeg, path, directory, index, target, signal) {
  const prefix = `sample-${index}-`;
  await run(ffmpeg, [
    '-v', 'error', '-nostdin', '-copyts', '-start_at_zero', '-ss', String(target),
    '-threads', '2', '-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0', '-i', path,
    '-map', '0:V:0', '-an', '-sn', '-dn', '-filter_threads', '1',
    '-vf', "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease",
    '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '4', '-enc_time_base', '1:1000',
    '-fps_mode', 'passthrough', '-f', 'image2', '-frame_pts', '1', join(directory, `${prefix}%d.jpg`),
  ], { env: processEnv, signal, timeout: 3500, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 });
  // The muxer names the JPEG using the decoded frame's PTS in milliseconds.
  const name = (await readdir(directory)).find((file) => file.startsWith(prefix));
  const pts = name && /^(\d+)\.jpg$/.exec(name.slice(prefix.length));
  if (!pts) return null;
  const image = join(directory, name);
  const jpeg = await readFile(image, { signal });
  if (!jpeg.length) return null;
  return { image, offsetSeconds: Number(pts[1]) / 1000, sha256: createHash('sha256').update(jpeg).digest('hex') };
}

async function readFrameText(image, command, language, signal) {
  const { stdout } = await run(command, [image, 'stdout', '-l', language, '--psm', '11'], {
    env: { ...processEnv, OMP_THREAD_LIMIT: '1' },
    signal,
    timeout: 2000,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024,
  });
  return stdout.replace(/\s+/g, ' ').trim().slice(0, 1500) || null;
}

function status(completed, requested) {
  if (completed === 0) return 'unavailable';
  return completed === requested ? 'complete' : 'partial';
}

export async function analyzeVideo(path, { ffmpeg, workDir, durationSeconds, signal }) {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(18_000);
  const visualSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const sampleCount = Math.min(maximumFrames, Math.max(durationSeconds < 2 ? 1 : 2, Math.ceil(durationSeconds / 8)));
  const ocrEnabled = process.env.CLAIM_BY_CLAIM_VISUAL_OCR === '1';
  const ocrCommand = process.env.CLAIM_BY_CLAIM_TESSERACT || 'tesseract';
  const ocrLanguage = process.env.CLAIM_BY_CLAIM_OCR_LANGUAGE || 'eng';
  const ocrLanguageValid = /^[a-z0-9_]+(?:\+[a-z0-9_]+)*$/i.test(ocrLanguage);
  const frames = [];
  let completedOcr = 0;
  let directory;
  try {
    directory = await mkdtemp(join(workDir, 'visual-'));
    for (let index = 0; index < sampleCount && !visualSignal.aborted; index++) {
      const target = Number((index * durationSeconds / sampleCount).toFixed(3));
      const frame = await sampleFrame(ffmpeg, path, directory, index, target, visualSignal).catch(() => null);
      if (!frame || frame.offsetSeconds > durationSeconds || frames.some(({ offsetSeconds }) => offsetSeconds === frame.offsetSeconds)) {
        continue;
      }
      let ocrText = null;
      if (ocrEnabled && ocrLanguageValid && !visualSignal.aborted) {
        try {
          ocrText = await readFrameText(frame.image, ocrCommand, ocrLanguage, visualSignal);
          completedOcr++;
        } catch {
          // Frame timing and hash are useful even when the optional OCR cannot run.
        }
      }
      frames.push({ offsetSeconds: frame.offsetSeconds, sha256: frame.sha256, ocrText });
    }
  } catch {
    // Local scratch space can be unavailable while the audio transcript is usable.
  } finally {
    // The transcription job also removes this private parent directory.
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  signal?.throwIfAborted();
  return {
    method,
    samplingStatus: status(frames.length, sampleCount),
    ocrStatus: ocrEnabled ? status(completedOcr, frames.length) : 'disabled',
    frames,
  };
}
