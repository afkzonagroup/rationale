import Fastify from 'fastify';
import { createIntake, createNodeHandler } from '@afkzona/rationale/connectors';
import { JsonlQueueStore } from '@afkzona/rationale/node';

const store = await JsonlQueueStore.open('rationale-queue.jsonl');
const handler = createNodeHandler({ intake: createIntake({ store }), secret: { env: 'INTAKE_SECRET' } });

export const app = Fastify();
await app.register((scope, _opts, done) => {
  // Leave the body unread so the handler can check its size and type itself.
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser('*', (_req, _payload, next) => {
    next(null);
  });
  scope.post('/dsa/statements', (req, reply) => {
    reply.hijack();
    void handler(req.raw, reply.raw);
  });
  done();
});
