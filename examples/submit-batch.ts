import { readFile } from 'node:fs/promises';
import { TransparencyClient } from '@afkzona/rationale';

// The sandbox address comes with your onboarding email; the token from your profile page.
const client = new TransparencyClient({
  environment: 'sandbox',
  sandboxBaseUrl: process.env['TDB_SANDBOX_URL'] ?? '',
  token: { env: 'RATIONALE_API_TOKEN' },
});

const lines = (await readFile('statements.jsonl', 'utf8')).split('\n').filter((l) => l.trim() !== '');
const report = await client.submitBatch(lines.map((l): unknown => JSON.parse(l)));

console.log(JSON.stringify(report.counts));
// {"created":2,"duplicate":0,"invalid":0,"rejected":0,"failed":0,"validated":0}

// Sending the same file again is safe: the PUIDs are already in the database.
const again = await client.submitBatch(lines.map((l): unknown => JSON.parse(l)));
console.log(again.counts.duplicate);
// 2
