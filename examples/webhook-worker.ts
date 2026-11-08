import { createServer } from 'node:http';
import { TransparencyClient } from '@afkzona/rationale';
import { createIntake, createNodeHandler, startQueueWorker } from '@afkzona/rationale/connectors';
import { JsonlQueueStore } from '@afkzona/rationale/node';

// Your moderation system POSTs each decision here. Statements are validated
// and written to a durable queue; a worker sends them to the database.
export const store = await JsonlQueueStore.open('rationale-queue.jsonl');

const client = new TransparencyClient({
  environment: 'sandbox',
  sandboxBaseUrl: process.env['TDB_SANDBOX_URL'] ?? '',
  token: { env: 'RATIONALE_API_TOKEN' },
});

const handler = createNodeHandler({
  intake: createIntake({ store }),
  secret: { env: 'INTAKE_SECRET' },
});

export const server = createServer((req, res) => void handler(req, res));
server.listen(Number(process.env['PORT'] ?? 8787), '127.0.0.1');

export const worker = startQueueWorker({
  client,
  store,
  intervalMs: 10_000,
  onReport: (r) => {
    console.log(`sent: created ${r.created}, duplicate ${r.duplicate}, rejected ${r.rejected}, failed ${r.failed}`);
  },
});

process.once('SIGTERM', () => {
  server.close();
  void worker.stop().then(() => store.close());
});
