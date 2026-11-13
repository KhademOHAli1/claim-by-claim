import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, link, mkdir, realpath, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAX_VIDEO_BYTES } from './transcribe.mjs';
import { directMediaUrl } from './sources.mjs';
import { mastodonPostUrl } from './mastodon.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultDataDirectory = process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', 'Claim by Claim', 'data')
  : join(root, '.case-data');
export const privateDirectory = resolve(process.env.CLAIM_BY_CLAIM_DATA_DIR || defaultDataDirectory);
const mediaDirectory = join(privateDirectory, 'intake');
const videoExtensions = new Set(['.mp4', '.mov', '.m4v']);
const stagedRef = /^local:([a-f\d]{64})(\.[a-z\d]{2,5})$/;

export async function registerSource(input) {
  if (/^[a-z][a-z\d+.-]*:/i.test(input)) {
    return mastodonPostUrl(input) ?? directMediaUrl(input);
  }

  const source = await realpath(input);
  const ext = extname(source).toLowerCase();
  if (!videoExtensions.has(ext)) throw new Error('Choose an MP4, MOV or M4V video.');
  const sourceInfo = await stat(source);
  if (!sourceInfo.isFile() || sourceInfo.size === 0 || sourceInfo.size > MAX_VIDEO_BYTES) {
    throw new Error(`The video file must be nonempty and no larger than ${MAX_VIDEO_BYTES / 1024 ** 2} MiB.`);
  }

  await mkdir(mediaDirectory, { recursive: true, mode: 0o700 });
  const temporary = join(mediaDirectory, `.intake-${randomUUID()}`);
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, 0o600);
    const hash = createHash('sha256');
    let copiedBytes = 0;
    for await (const chunk of createReadStream(temporary)) {
      copiedBytes += chunk.length;
      if (copiedBytes > MAX_VIDEO_BYTES) throw new Error('The video changed size while being staged.');
      hash.update(chunk);
    }
    if (copiedBytes === 0) throw new Error('The staged video is empty.');
    const digest = hash.digest('hex');
    const destination = join(mediaDirectory, digest + ext);
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    return `local:${digest}${ext}`;
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function resolveRunnerSource(sourceRef) {
  if (sourceRef.startsWith('https://')) return sourceRef;
  const match = stagedRef.exec(sourceRef);
  if (!match || !videoExtensions.has(match[2])) throw new Error('The staged video reference is invalid.');
  const path = join(mediaDirectory, match[1] + match[2]);
  const resolved = await realpath(path).catch(() => {
    throw new Error('The staged video is missing on this Mac. Restore the file to the private intake directory.');
  });
  if (dirname(resolved) !== await realpath(mediaDirectory)) throw new Error('The staged video is outside the intake directory.');
  return pathToFileURL(resolved).href;
}
