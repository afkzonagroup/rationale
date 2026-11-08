import express from 'express';
import { createIntake, createNodeHandler } from '@afkzona/rationale/connectors';
import { JsonlQueueStore } from '@afkzona/rationale/node';

const store = await JsonlQueueStore.open('rationale-queue.jsonl');
const handler = createNodeHandler({ intake: createIntake({ store }), secret: { env: 'INTAKE_SECRET' } });

export const app = express();
// No body parser on this route: the handler reads and limits the body itself.
app.post('/dsa/statements', (req, res) => void handler(req, res));
