import { onTestFinished, test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { prepare } from './prepare.mjs';

const execute = promisify(execFile);
const cf = fileURLToPath(new URL('../node_modules/cf/bin/cf', import.meta.url));

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'claim-by-claim-export-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'out', 'media'), { recursive: true });
  await writeFile(join(root, 'out', 'index.html'), '<!doctype html><title>Export fixture</title>');
  await writeFile(join(root, 'out', '404.html'), '<!doctype html><title>Not found</title>');
  await writeFile(join(root, 'out', 'media', 'source.mp4'), 'video fixture');
  return root;
}

test('official cf consumer validates the combined static export and media Worker', async () => {
  const root = await project();
  const result = await prepare({ projectRoot: root, accountId: undefined });
  assert.equal(result.assets, 3);
  const output = join(root, '.cloudflare', 'output', 'v0');
  assert.equal(await readFile(join(output, 'workers', 'default', 'assets', 'media', 'source.mp4'), 'utf8'), 'video fixture');
  const config = JSON.parse(await readFile(join(output, 'workers', 'default', 'worker.config.json'), 'utf8'));
  assert.equal(config.env.ASSETS.type, 'assets');
  assert.deepEqual(config.assets.runWorkerFirst, ['/media/*']);
  const { default: worker } = await import(pathToFileURL(join(output, 'workers', 'default', 'bundle', 'worker.js')));
  const asset = new Response('video fixture', { headers: { 'Content-Type': 'video/mp4' } });
  assert.equal(asset.headers.get('Content-Length'), null);
  const response = await worker.fetch(new Request('https://example.test/media/source.mp4', {
    headers: { Range: 'bytes=0-1' },
  }), { ASSETS: { fetch: async () => asset } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), 'bytes 0-1/13');
  assert.equal(response.headers.get('Content-Length'), '2');
  assert.equal(await response.text(), 'vi');
  // A nonzero exit rejects this promise. This checks the actual CLI consumer,
  // rather than reimplementing its evolving beta output schema in the test.
  await execute(process.execPath, [cf, 'deploy', '--prebuilt', '--dry-run'], {
    cwd: root, env: { ...process.env, CI: 'true' }, timeout: 30_000,
  });
  // A negative control proves that the CLI actually consumes this tree.
  await writeFile(join(output, 'workers', 'default', 'worker.config.json'), JSON.stringify({ ...config, assets: { directory: './out' } }));
  await assert.rejects(execute(process.execPath, [cf, 'deploy', '--prebuilt', '--dry-run'], {
    cwd: root, env: { ...process.env, CI: 'true' }, timeout: 30_000,
  }));
});

test('a missing Next export fails before touching previous output', async () => {
  const root = await project();
  await rm(join(root, 'out', 'index.html'));
  await assert.rejects(prepare({ projectRoot: root }), /ENOENT/);
});

test('oversize source media is rejected before it is copied', async () => {
  const root = await project();
  await truncate(join(root, 'out', 'media', 'source.mp4'), 25 * 1024 * 1024 + 1);
  await assert.rejects(prepare({ projectRoot: root }), /25 MiB/);
});

test('symlinks cannot pull files outside the static export into a deployment', async () => {
  const root = await project();
  await writeFile(join(root, 'outside.txt'), 'not a public asset');
  await symlink(join(root, 'outside.txt'), join(root, 'out', 'outside-link.txt'));
  await assert.rejects(prepare({ projectRoot: root }), /symlink/);
});
