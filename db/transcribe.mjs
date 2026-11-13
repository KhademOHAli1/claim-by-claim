import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { request } from 'node:https';
import { BlockList } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { analyzeVideo } from './visual.mjs';

export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_DURATION_SECONDS = 600;

const run = promisify(execFile);
const pythonScript = fileURLToPath(new URL('./transcribe-local.py', import.meta.url));
const previousPython = fileURLToPath(new URL('../../work/media-inspection/.venv/bin/python', import.meta.url));
const modelRepository = 'models--mlx-community--whisper-large-v3-turbo';
const backends = {
  mlx: { name: 'MLX Whisper', module: 'mlx_whisper', timeout: 240_000 },
  'faster-whisper': { name: 'faster-whisper on CPU with INT8', module: 'faster_whisper', timeout: 360_000 },
};
const acceptedTypes = new Set([
  'video/mp4', 'video/quicktime', 'video/x-m4v', 'application/mp4', 'application/octet-stream',
]);
const nonPublicIp = new BlockList();
for (const [network, length] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) {
  nonPublicIp.addSubnet(network, length, 'ipv4');
}

const processEnv = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'SYSTEMROOT'].flatMap((key) =>
  process.env[key] === undefined ? [] : [[key, process.env[key]]]));
const offlineEnv = {
  ...processEnv, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
};

async function isPresent(path) {
  return access(path).then(() => true, () => false);
}

async function modelPath(backend) {
  const explicit = process.env.CLAIM_BY_CLAIM_WHISPER_MODEL;
  if (backend === 'faster-whisper') {
    const model = explicit && resolve(explicit);
    const files = ['config.json', 'model.bin', 'tokenizer.json'];
    const available = model && await Promise.all(files.map((file) => isPresent(join(model, file))));
    if (!available || !available.every(Boolean) ||
        !await isPresent(join(model, 'vocabulary.json')) && !await isPresent(join(model, 'vocabulary.txt'))) {
      throw new Error('Set CLAIM_BY_CLAIM_WHISPER_MODEL to a complete local CTranslate2 Whisper model directory.');
    }
    return model;
  }
  const hfHome = process.env.HF_HOME || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'huggingface');
  const cache = join(process.env.HF_HUB_CACHE || join(hfHome, 'hub'), modelRepository);
  const revision = explicit ? '' : (await readFile(join(cache, 'refs', 'main'), 'utf8').catch(() => '')).trim();
  const model = explicit ? resolve(explicit) : join(cache, 'snapshots', /^[0-9a-f]{40}$/.test(revision) ? revision : '');
  if (!await isPresent(join(model, 'config.json')) ||
    !await isPresent(join(model, 'weights.safetensors')) && !await isPresent(join(model, 'weights.npz'))) {
    throw new Error('The local Whisper model is missing. Set CLAIM_BY_CLAIM_WHISPER_MODEL to an installed MLX model directory.');
  }
  return model;
}

async function findFfmpeg(signal) {
  const configured = process.env.CLAIM_BY_CLAIM_FFMPEG;
  const command = configured || 'ffmpeg';
  const works = (binary) => run(binary, ['-version'], { env: processEnv, signal, timeout: 3000 })
    .then(() => true, () => false);
  if (await works(command)) return command;
  signal?.throwIfAborted();
  if (!configured && process.platform === 'darwin' && process.arch === 'arm64') {
    // Reuse an already installed imageio-ffmpeg wheel, if the system binary is unavailable.
    const archive = join(process.env.UV_CACHE_DIR || join(homedir(), '.cache', 'uv'), 'archive-v0');
    for (const directory of await readdir(archive).catch(() => [])) {
      const binaries = join(archive, directory, 'imageio_ffmpeg', 'binaries');
      const names = await readdir(binaries).catch(() => []);
      for (const name of names) {
        if (/^ffmpeg-macos-aarch64-v[\d.]+$/.test(name)) {
          const binary = join(binaries, name);
          if (await works(binary)) return binary;
        }
      }
    }
  }
  signal?.throwIfAborted();
  throw new Error('A working FFmpeg is required. Set CLAIM_BY_CLAIM_FFMPEG to a local FFmpeg executable.');
}

let readySetup;

export async function checkTranscriptionSetup({ signal } = {}) {
  if (readySetup) return readySetup;
  const backend = process.env.CLAIM_BY_CLAIM_WHISPER_BACKEND || 'mlx';
  if (!Object.hasOwn(backends, backend)) {
    throw new Error('Set CLAIM_BY_CLAIM_WHISPER_BACKEND to mlx or faster-whisper.');
  }
  const settings = backends[backend];
  const python = process.env.CLAIM_BY_CLAIM_WHISPER_PYTHON ||
    (backend === 'mlx' && await isPresent(previousPython) ? previousPython : 'python3');
  const [model, ffmpeg] = await Promise.all([modelPath(backend), findFfmpeg(signal)]);
  try {
    await run(python, ['-c', `import ${settings.module}, numpy`], { env: offlineEnv, signal, timeout: 15000 });
  } catch {
    signal?.throwIfAborted();
    throw new Error(`Python with ${settings.name} is required. Set CLAIM_BY_CLAIM_WHISPER_PYTHON to its environment.`);
  }
  readySetup = { python, model, ffmpeg, backend };
  return readySetup;
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function directResponse(url, address, signal) {
  return new Promise((resolve, reject) => {
    // Connect to the checked address directly. Keep the original host for TLS
    // certificate verification, SNI, and HTTP virtual hosting.
    const req = request({
      hostname: address,
      servername: url.hostname,
      headers: { Host: url.hostname, Accept: [...acceptedTypes].join(', ') },
      path: url.pathname + url.search,
      port: 443,
      agent: false,
      rejectUnauthorized: true,
      signal,
    }, resolve);
    req.on('error', reject);
    req.end();
  });
}

async function downloadVideo(source, output, signal) {
  const deadline = AbortSignal.timeout(90000);
  const transferSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  let url = source;
  let redirects = 0;
  try {
    while (true) {
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/i.test(url.hostname)) {
        throw new Error('Use a public HTTPS video link on port 443 without embedded credentials.');
      }
      const addresses = await abortable(lookup(url.hostname, { family: 4, all: true }), transferSignal);
      if (!addresses.length || addresses.some(({ address }) => nonPublicIp.check(address, 'ipv4'))) {
        throw new Error('The video link must resolve to a public IPv4 address. Alternatively, submit a local file.');
      }
      const response = await directResponse(url, addresses[0].address, transferSignal);
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.destroy();
        if (++redirects > 3) throw new Error('Too many video link redirects. Submit a direct media URL or a local file.');
        url = new URL(response.headers.location, url);
        continue;
      }
      const contentType = response.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
      if (response.statusCode !== 200 || contentType && !acceptedTypes.has(contentType)) {
        response.destroy();
        throw new Error('The link must return a downloadable MP4, MOV, or M4V video. For gated sites or web pages, submit a local copy.');
      }
      if (Number(response.headers['content-length']) > MAX_VIDEO_BYTES) {
        response.destroy();
        throw new Error('The video exceeds the 100 MiB intake limit.');
      }
      let size = 0;
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          callback(size > MAX_VIDEO_BYTES ? new Error('The video exceeds the 100 MiB intake limit.') : null, chunk);
        },
      });
      await pipeline(response, limit, createWriteStream(output, { flags: 'wx', mode: 0o600 }), { signal: transferSignal });
      return output;
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted) throw new Error('The video download took longer than 90 seconds. Submit a local copy.');
    if (error.code) throw new Error('The video could not be downloaded over HTTPS. Use a direct public media URL or submit a local file.');
    throw error;
  }
}

async function inspectVideo(ffmpeg, path, signal) {
  let info;
  try {
    // Only local MP4/MOV-family media is decoded. Both video and audio are required.
    ({ stderr: info } = await run(ffmpeg, [
      '-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0',
      '-i', path, '-map', '0:v:0', '-map', '0:a:0', '-t', '0', '-f', 'null', '-',
    ], { env: processEnv, signal, timeout: 15000, killSignal: 'SIGKILL' }));
  } catch {
    signal?.throwIfAborted();
    throw new Error('The media must be a readable MP4, MOV, or M4V with a video stream and an audio track.');
  }
  const match = /^\s*Duration: (\d+):(\d+):([\d.]+),/m.exec(info);
  const duration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not read the video duration.');
  if (duration > MAX_DURATION_SECONDS) throw new Error('The video exceeds the 10-minute intake limit.');
  return duration;
}

async function sha256File(path, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

export async function transcribeVideo(sourceRef, { signal, workDir = tmpdir() } = {}) {
  const source = new URL(sourceRef);
  if (source.protocol !== 'file:' && source.protocol !== 'https:') {
    throw new Error('Submit a local video or a direct HTTPS link.');
  }
  const setup = await checkTranscriptionSetup({ signal });
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const jobDir = await mkdtemp(join(resolve(workDir), 'transcribe-'));
  try {
    const path = source.protocol === 'file:' ? fileURLToPath(source) :
      await downloadVideo(source, join(jobDir, 'video.mp4'), signal);
    const mediaReadAt = new Date().toISOString();
    const file = await stat(path).catch((error) => {
      if (error.code === 'ENOENT') throw new Error('The local video is missing from this runner. Submit a copy from this machine.');
      throw error;
    });
    if (!file.isFile() || !file.size) throw new Error('The submitted video must be a nonempty file.');
    if (file.size > MAX_VIDEO_BYTES) throw new Error('The video exceeds the 100 MiB intake limit.');
    const durationSeconds = await inspectVideo(setup.ffmpeg, path, signal);
    const sha256 = await sha256File(path, signal);
    const wav = join(jobDir, 'audio.wav');
    try {
      await run(setup.ffmpeg, [
        '-v', 'error', '-nostdin', '-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0', '-i', path,
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
        '-af', 'aresample=async=1:first_pts=0', '-t', String(durationSeconds), wav,
      ], { env: processEnv, signal, timeout: 45000, killSignal: 'SIGKILL' });
    } catch {
      signal?.throwIfAborted();
      throw new Error('The video’s audio track could not be decoded.');
    }
    let result;
    const settings = backends[setup.backend];
    try {
      ({ stdout: result } = await run(setup.python, [
        pythonScript, wav, setup.model, String(durationSeconds), setup.backend,
      ], { env: offlineEnv, signal, timeout: settings.timeout, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 }));
    } catch (error) {
      signal?.throwIfAborted();
      if (error.killed) throw new Error('Local Whisper exceeded its time limit.');
      const knownMessage = error.stderr?.split('\n').find((line) => line.startsWith('Transcription: '));
      throw new Error(knownMessage || 'Local Whisper failed. Check the Python environment and cached model.');
    }
    const { language, segments } = JSON.parse(result);
    const visual = await analyzeVideo(path, { ffmpeg: setup.ffmpeg, workDir: jobDir, durationSeconds, signal });
    return {
      language, durationSeconds, sha256, sizeBytes: file.size, segments, visual, mediaReadAt,
      note: `Machine transcript from local ${settings.name}. Check wording, names, and timestamps before approval.`,
    };
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
}
