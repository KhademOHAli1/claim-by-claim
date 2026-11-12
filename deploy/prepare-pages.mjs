import { stat, writeFile } from 'node:fs/promises';
import { compileMediaWorker } from './compile-media-worker.mjs';

const output = new URL('../out/', import.meta.url);

const index = await stat(new URL('index.html', output));
if (!index.isFile() || index.size === 0) {
  throw new Error('Expected a nonempty Next.js export file at out/index.html.');
}

const worker = await compileMediaWorker(new URL('media/source.mp4', output), { requireVideo: true });
const routes = { version: 1, include: ['/*'], exclude: [] };

await writeFile(new URL('_worker.js', output), worker);
await writeFile(new URL('_routes.json', output), `${JSON.stringify(routes, null, 2)}\n`);
console.log('Prepared out/ for Cloudflare Pages with a Worker for all routes.');
