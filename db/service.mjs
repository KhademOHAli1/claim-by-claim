import { chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateDirectory } from './intake.mjs';
import { checkTranscriptionSetup } from './transcribe.mjs';

const label = 'me.khademohali.claim-by-claim.runner';
const directory = join(homedir(), 'Library', 'LaunchAgents');
const plist = join(directory, `${label}.plist`);
const domain = `gui/${userInfo().uid}`;
const service = `${domain}/${label}`;
const runner = fileURLToPath(new URL('./runner.mjs', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
const stdout = join(privateDirectory, 'runner.log');
const stderr = join(privateDirectory, 'runner-error.log');
const launchctl = '/bin/launchctl';
const runtimeDirectory = join(homedir(), 'Library', 'Application Support', 'Claim by Claim', 'runtime');

const overrides = [
  'CLAIM_BY_CLAIM_CF_ACCOUNT_ID',
  'CLAIM_BY_CLAIM_CF_PROFILE',
  'CLAIM_BY_CLAIM_D1_ID',
  'CLAIM_BY_CLAIM_WHISPER_MODEL',
  'CLAIM_BY_CLAIM_FFMPEG',
  'CLAIM_BY_CLAIM_VISUAL_OCR',
  'CLAIM_BY_CLAIM_TESSERACT',
  'CLAIM_BY_CLAIM_OCR_LANGUAGE',
  'CLAIM_RESEARCH_SKILL_DIR',
  'CLAIM_RESEARCH_MAX_CLAIMS',
  'CLAIM_RESEARCH_MONTHLY_LIMIT',
  'CLAIM_RESEARCH_REASONING',
  'CLAIM_RESEARCH_CHATGPT_MODEL',
];

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function string(value) {
  return `<string>${xml(value)}</string>`;
}

async function run(command, { show = true, tolerate = false } = {}) {
  const subprocess = Bun.spawn(command, {
    cwd: root,
    stdout: show ? 'inherit' : 'ignore',
    stderr: show ? 'inherit' : 'ignore',
  });
  const code = await subprocess.exited;
  if (code !== 0 && !tolerate) throw new Error(`${command[0]} ${command[1]} failed (exit ${code}).`);
  return code;
}

async function install() {
  const codex = process.env.CLAIM_RESEARCH_CODEX || Bun.which('codex');
  const node = Bun.which('node');
  if (!codex) throw new Error('Codex is missing. Set CLAIM_RESEARCH_CODEX to its executable path.');
  if (!node) throw new Error('Node.js 22 or later is required by the Cloudflare CLI.');
  const current = await readFile(plist, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (current !== null) {
    if (await run([launchctl, 'print', service], { show: false, tolerate: true }) !== 0) {
      await run([launchctl, 'bootstrap', domain, plist]);
    }
    console.log('Runner is installed. To refresh its code or settings, remove it and install it again.');
    return;
  }

  await run([process.execPath, runner, '--check']);
  const transcription = await checkTranscriptionSetup();
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const runtime = await mkdtemp(join(runtimeDirectory, 'release-'));
  const transcriptionPython = transcription.python;
  const venv = dirname(dirname(transcriptionPython));
  const isVenv = await stat(join(venv, 'pyvenv.cfg')).then((info) => info.isFile(), () => false);
  if (isVenv) await run(['/bin/cp', '-cR', venv, join(runtime, 'whisper-venv')]);
  await run(['/bin/cp', '-cR', join(root, 'db'), join(runtime, 'db')]);
  await run(['/bin/cp', '-cR', join(root, 'node_modules'), join(runtime, 'node_modules')]);
  const serviceRunner = join(runtime, 'db', 'runner.mjs');
  const environment = {
    PATH: [dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    CLAIM_BY_CLAIM_DATA_DIR: privateDirectory,
    CLAIM_RESEARCH_CODEX: codex,
    CLAIM_BY_CLAIM_WHISPER_PYTHON: isVenv ? join(runtime, 'whisper-venv', 'bin', 'python') : transcriptionPython,
    CLAIM_BY_CLAIM_WHISPER_MODEL: transcription.model,
    CLAIM_BY_CLAIM_FFMPEG: transcription.ffmpeg,
    ...Object.fromEntries(overrides.filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
  };
  const check = Bun.spawn([process.execPath, serviceRunner, '--check'], {
    cwd: runtime, env: { ...environment, HOME: homedir() }, stdout: 'inherit', stderr: 'inherit',
  });
  if (await check.exited !== 0) {
    await rm(runtime, { recursive: true, force: true });
    throw new Error('The staged background runner failed its preflight.');
  }
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>${string(label)}
  <key>ProgramArguments</key><array>${[process.execPath, serviceRunner, '--watch'].map(string).join('')}</array>
  <key>WorkingDirectory</key>${string(runtime)}
  <key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${xml(key)}</key>${string(value)}`).join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>120</integer>
  <key>StandardOutPath</key>${string(stdout)}
  <key>StandardErrorPath</key>${string(stderr)}
</dict></plist>
`;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  for (const file of [stdout, stderr]) {
    await writeFile(file, '', { flag: 'a', mode: 0o600 });
    await chmod(file, 0o600);
  }
  await writeFile(plist, content, { flag: 'wx', mode: 0o600 });
  await run(['/usr/bin/plutil', '-lint', plist]);
  if (await run([launchctl, 'print', service], { show: false, tolerate: true }) !== 0) {
    await run([launchctl, 'bootstrap', domain, plist]);
  }
  console.log(`Runner installed for this Mac user. Log: ${stdout}`);
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('This service command is for macOS.');
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Usage: bun run db:service install|status|remove');
  if (command === 'install') return install();
  if (command === 'status') return run([launchctl, 'print', service]);
  if (command === 'remove') {
    if (await run([launchctl, 'print', service], { show: false, tolerate: true }) === 0) {
      await run([launchctl, 'bootout', service]);
    }
    if (await stat(plist).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) await unlink(plist);
    return console.log('Runner stopped and removed.');
  }
  throw new Error('Usage: bun run db:service install|status|remove');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
