import { createWorkflowStore } from './d1.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDirectory = fileURLToPath(new URL('../', import.meta.url));
const cf = fileURLToPath(new URL('../node_modules/.bin/cf', import.meta.url));
export function createD1Store({
  databaseId = process.env.CLAIM_BY_CLAIM_D1_ID || 'a7136304-cef0-4efa-ba42-e52040370f18',
  accountId = process.env.CLAIM_BY_CLAIM_CF_ACCOUNT_ID || '5abc8ec0546ecf5ea6046f50925d06fe',
  profile = process.env.CLAIM_BY_CLAIM_CF_PROFILE || 'claim-by-claim-d1',
  researchMonthlyLimit = Number(process.env.CLAIM_RESEARCH_MONTHLY_LIMIT ?? 20),
  apiToken = process.env.CLAUDFLARE_API_TOKEN,
} = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(databaseId) || !/^[0-9a-f]{32}$/i.test(accountId)) {
    throw new Error('Invalid Cloudflare account or D1 database ID.');
  }
  function resultRows(results, expectedCount) {
    if (!Array.isArray(results) || results.length !== expectedCount ||
        results.some((result) => result.success !== true || !Array.isArray(result.results))) {
      throw new Error('Cloudflare D1 returned an incomplete query result.');
    }
    return results.map(({ results: rows }) => rows);
  }

  async function batch(statements) {
    if (apiToken) {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch: statements }),
        redirect: 'error',
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) throw new Error(`Cloudflare D1 API returned HTTP ${response.status}.`);
      const data = await response.json();
      if (!data.success) throw new Error('Cloudflare D1 rejected the query batch.');
      return resultRows(data.result, statements.length);
    }

    const directory = await mkdtemp(join(tmpdir(), 'claim-by-claim-query-'));
    const file = join(directory, 'batch.json');
    try {
      await writeFile(file, JSON.stringify(statements), { mode: 0o600 });
      const args = [cf, 'd1', 'query', databaseId, '--quiet', '--batch', `@${file}`];
      args.push('--profile', profile);
      const child = Bun.spawn(args, {
        cwd: siteDirectory,
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
        stdout: 'pipe',
        stderr: 'pipe',
        signal: AbortSignal.timeout(45_000),
      });
      const [output, , code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      // CLI error bodies can echo bound values. Keep transcript and evidence data out of runner logs.
      if (code !== 0) throw new Error(`Cloudflare D1 query failed (CLI exit ${code}). Check the D1 profile and migration status.`);
      return resultRows(JSON.parse(output), statements.length);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return createWorkflowStore(batch, { database: `d1:${databaseId}`, researchMonthlyLimit });
}
