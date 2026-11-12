import { stat, writeFile } from 'node:fs/promises';

const output = new URL('../out/', import.meta.url);

for (const path of ['index.html', 'media/source.mp4']) {
  const file = await stat(new URL(path, output));
  if (!file.isFile() || file.size === 0) {
    throw new Error(`Expected a nonempty Next.js export file at out/${path}.`);
  }
}

const workerSource = await Bun.file(new URL('./worker.ts', import.meta.url)).text();
const worker = new Bun.Transpiler({ loader: 'ts' }).transformSync(workerSource);
const routes = { version: 1, include: ['/media/*'], exclude: [] };

await writeFile(new URL('_worker.js', output), worker);
await writeFile(new URL('_routes.json', output), `${JSON.stringify(routes, null, 2)}\n`);
console.log('Prepared out/ for Cloudflare Pages with a Worker for /media/*.');
