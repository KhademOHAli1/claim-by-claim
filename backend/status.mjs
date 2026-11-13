import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const origin = 'https://claim-by-claim-backend.alikhadem425.workers.dev';
const credential = process.env.CLAIM_BY_CLAIM_OPERATOR_SECRET_FILE ||
  join(homedir(), '.config', 'claim-by-claim', 'operator-secret.json');

async function main() {
  const { OPERATOR_API_TOKEN: token } = JSON.parse(await readFile(credential, 'utf8'));
  const url = new URL('/v1/status', origin);
  const anonymous = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (anonymous.status !== 401 || anonymous.headers.get('www-authenticate') !== 'Bearer') {
    throw new Error(`Backend did not return its expected authentication challenge (HTTP ${anonymous.status}).`);
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Authenticated backend check returned HTTP ${response.status}.`);
  const { counts, researchBudget } = await response.json();
  console.log(JSON.stringify({ url: url.href, anonymousStatus: 401, authenticatedStatus: 200, counts, researchBudget }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
