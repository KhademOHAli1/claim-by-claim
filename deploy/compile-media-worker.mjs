import { stat } from 'node:fs/promises';

const workerSource = new URL('./worker.ts', import.meta.url);

export async function compileMediaWorker(videoPath, { requireVideo = false } = {}) {
  const video = await stat(videoPath).catch(error => {
    if (!requireVideo && error.code === 'ENOENT') return null;
    throw error;
  });
  if (video && (!video.isFile() || video.size === 0)) {
    throw new Error('Expected a nonempty export file at out/media/source.mp4.');
  }

  const define = video ? { SOURCE_VIDEO_SIZE: String(video.size) } : {};
  const transpiler = new Bun.Transpiler({ loader: 'ts', define });
  return transpiler.transformSync(await Bun.file(workerSource).text());
}
