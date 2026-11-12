import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const workerSource = fileURLToPath(new URL('./worker.ts', import.meta.url));
const assetLimit = 25 * 1024 * 1024;

async function inspectAssets(directory) {
  let count = 0;
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Static export contains a symlink: ${entry.name}`);
    if (stat.isDirectory()) {
      const child = await inspectAssets(path);
      count += child.count;
      bytes += child.bytes;
    } else if (stat.isFile()) {
      if (stat.size > assetLimit) throw new Error(`Static asset exceeds the 25 MiB limit: ${entry.name}`);
      count++;
      bytes += stat.size;
    } else {
      throw new Error(`Unsupported static export entry: ${entry.name}`);
    }
  }
  return { count, bytes };
}

/** Package an existing `next build` static export for `cf deploy --prebuilt`. */
export async function prepare({
  projectRoot = projectDirectory,
  assetsDirectory = join(projectRoot, 'out'),
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
} = {}) {
  const root = resolve(projectRoot);
  const assets = resolve(assetsDirectory);
  // Refuse an incomplete Next export before replacing any previous build.
  await readFile(join(assets, 'index.html'));
  const inspected = await inspectAssets(assets);
  const compiledWorker = stripTypeScriptTypes(await readFile(workerSource, 'utf8'), { mode: 'strip' });

  const outputParent = join(root, '.cloudflare', 'output');
  const output = join(outputParent, 'v0');
  await mkdir(outputParent, { recursive: true });
  const staging = await mkdtemp(join(outputParent, '.prepare-'));
  try {
    const workerDirectory = join(staging, 'workers', 'default');
    const bundle = join(workerDirectory, 'bundle');
    await mkdir(bundle, { recursive: true });
    await cp(assets, join(workerDirectory, 'assets'), { recursive: true, dereference: false });
    await writeFile(join(bundle, 'worker.js'), compiledWorker);
    const rootConfig = {
      ...(accountId ? { accountId } : {}),
      buildContext: { isPreview: false },
    };
    const workerConfig = {
      name: 'claim-by-claim',
      compatibilityDate: '2026-11-12',
      env: { ASSETS: { type: 'assets' } },
      assets: {
        htmlHandling: 'auto-trailing-slash',
        notFoundHandling: '404-page',
        runWorkerFirst: ['/media/*'],
      },
      manifest: {
        type: 'complete',
        mainModule: 'worker.js',
        modules: { 'worker.js': { type: 'esm' } },
      },
    };
    await writeFile(join(staging, 'config.json'), JSON.stringify(rootConfig, null, 2) + '\n');
    await writeFile(join(workerDirectory, 'worker.config.json'), JSON.stringify(workerConfig, null, 2) + '\n');
    // This directory is generated build output, never source or credentials.
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { directory: output, assets: inspected.count, bytes: inspected.bytes };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await prepare();
  console.log(`Prepared ${relative(projectDirectory, result.directory)} with ${result.assets} assets (${result.bytes} bytes).`);
  console.log('Validate with: cf deploy --prebuilt --dry-run');
}
