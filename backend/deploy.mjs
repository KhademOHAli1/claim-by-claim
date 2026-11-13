import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const cf = join(root, 'node_modules', '.bin', 'cf');
const accountId = process.env.CLAIM_BY_CLAIM_CF_ACCOUNT_ID || '5abc8ec0546ecf5ea6046f50925d06fe';
const databaseId = process.env.CLAIM_BY_CLAIM_D1_ID || 'a7136304-cef0-4efa-ba42-e52040370f18';
const credential = process.env.CLAIM_BY_CLAIM_OPERATOR_SECRET_FILE ||
  join(homedir(), '.config', 'claim-by-claim', 'operator-secret.json');
const name = 'claim-by-claim-backend';

async function ensureCredential() {
  await mkdir(dirname(credential), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  try {
    await writeFile(credential, JSON.stringify({ OPERATOR_API_TOKEN: token }) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await chmod(credential, 0o600);
  const stored = JSON.parse(await readFile(credential, 'utf8'));
  if (Object.keys(stored).length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(stored.OPERATOR_API_TOKEN || '')) {
    throw new Error('Operator secret file must contain only a 32-byte base64url OPERATOR_API_TOKEN.');
  }
  return stored.OPERATOR_API_TOKEN;
}

async function deployThroughApi(source) {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) throw new Error('Set CLOUDFLARE_API_TOKEN for direct Workers API deployment.');
  const operatorToken = await ensureCredential();
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}`;
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify({
    main_module: 'worker.js',
    compatibility_date: '2026-11-12',
    bindings: [
      { type: 'd1', name: 'DB', database_id: databaseId },
      { type: 'secret_text', name: 'OPERATOR_API_TOKEN', text: operatorToken },
    ],
  })], { type: 'application/json' }));
  form.set('worker.js', new Blob([source], { type: 'application/javascript+module' }), 'worker.js');
  for (const { url, method, body, headers, description } of [
    { url: endpoint, method: 'PUT', body: form, description: 'Worker upload' },
    {
      url: endpoint + '/subdomain', method: 'POST', body: JSON.stringify({ enabled: true, previews_enabled: false }),
      headers: { 'Content-Type': 'application/json' }, description: 'Worker URL activation',
    },
  ]) {
    const response = await fetch(url, {
      method, body, headers: { Authorization: 'Bearer ' + apiToken, ...headers },
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.success !== true) {
      const codes = (result?.errors ?? []).map(({ code }) => Number(code)).filter(Number.isFinite);
      throw new Error(`${description} failed (HTTP ${response.status}${codes.length ? ', codes ' + codes.join(', ') : ''}).`);
    }
    console.log(`${description} succeeded.`);
  }
  console.log(`Operator credential file: ${credential}`);
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (rest.length || !['--check', '--deploy', '--deploy-api'].includes(mode)) {
    throw new Error('Usage: bun backend/deploy.mjs --check|--deploy|--deploy-api');
  }
  if (!/^[0-9a-f]{32}$/i.test(accountId) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(databaseId)) {
    throw new Error('Check the Cloudflare account and D1 database IDs.');
  }
  const build = await Bun.build({
    entrypoints: [join(root, 'backend', 'worker.mjs')],
    target: 'browser',
    format: 'esm',
  });
  if (!build.success || build.outputs.length !== 1) throw new Error('Backend bundling failed.');
  const source = await build.outputs[0].text();
  if (mode === '--deploy-api') return deployThroughApi(source);

  const project = await mkdtemp(join(tmpdir(), 'claim-by-claim-backend-'));
  try {
    const output = join(project, '.cloudflare', 'output', 'v0');
    const worker = join(output, 'workers', 'default');
    const bundle = join(worker, 'bundle');
    await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, 'worker.js'), source);
    await writeFile(join(output, 'config.json'), JSON.stringify({
      accountId,
      buildContext: { isPreview: false },
    }));
    await writeFile(join(worker, 'worker.config.json'), JSON.stringify({
      name,
      compatibilityDate: '2026-11-12',
      workersDev: true,
      previewUrls: false,
      env: {
        DB: { type: 'd1', id: databaseId, jurisdiction: 'eu' },
        OPERATOR_API_TOKEN: { type: 'secret' },
      },
      manifest: {
        type: 'complete',
        mainModule: 'worker.js',
        modules: { 'worker.js': { type: 'esm' } },
      },
    }));

    const args = ['deploy', '--prebuilt', '--no-provision'];
    if (mode === '--check') args.push('--dry-run');
    else {
      await ensureCredential();
      args.push('--secrets-file', credential);
      const profile = process.env.CLAIM_BY_CLAIM_DEPLOY_PROFILE;
      if (profile) args.push('--profile', profile);
    }
    try {
      const { stdout, stderr } = await exec(cf, args, { cwd: project, timeout: 120_000 });
      if (stdout.trim()) console.log(stdout.trim());
      if (stderr.trim()) console.error(stderr.trim());
    } catch (error) {
      const diagnostic = String(error.stderr || error.stdout || error.message);
      // The credential is passed by file path; never print the contents on failure.
      throw new Error(diagnostic.trim().slice(0, 1500));
    }
    if (mode === '--deploy') console.log(`Operator credential file: ${credential}`);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
