/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { constantTimeEqual, createIntake, createNodeHandler, startQueueWorker } from '../src/connectors/index.js';
import { MemoryQueueStore, TransparencyClient, type DrainReport, type QueueStore } from '../src/index.js';
import { MOCK_TOKEN, startMock, type MockApi } from './helpers/mock-server.js';
import { validStatement } from './helpers/vectors.js';

const SECRET = 'intake-secret-0123456789';
let server: Server;
let base: string;
let store: MemoryQueueStore;
let allow = true;

beforeEach(async () => {
  store = new MemoryQueueStore();
  allow = true;
  const handler = createNodeHandler({
    intake: createIntake({ store, maxStatements: 5 }),
    secret: { env: 'INTAKE_SECRET' },
    env: { INTAKE_SECRET: SECRET },
    maxBodyBytes: 20_000,
    rateLimit: () => allow,
  });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => { r(); }));
});

const post = (body: string, headers: Record<string, string> = {}, method = 'POST'): Promise<Response> =>
  fetch(`${base}/statements`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}`, ...headers },
    ...(method === 'GET' ? {} : { body }),
  });

describe('Node.js intake handler', () => {
  it('queues a valid statement (202) with security headers', async () => {
    const res = await post(JSON.stringify(validStatement('h1')));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: ['h1'], alreadyKnown: [], invalid: [] });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await store.stats()).toEqual({ pending: 1, done: 0, rejected: 0 });
  });

  it('accepts lists, reports invalid entries (200) and fully invalid requests (422)', async () => {
    const mixed = await post(JSON.stringify({ statements: [validStatement('h2'), { puid: 'x' }] }));
    expect(mixed.status).toBe(200);
    const body = (await mixed.json()) as { invalid: { index: number }[] };
    expect(body.invalid.map((i) => i.index)).toEqual([1]);
    expect((await post(JSON.stringify({ puid: 'x' }))).status).toBe(422);
    expect((await post(JSON.stringify({ statements: [] }))).status).toBe(400);
    expect((await post(JSON.stringify({ statements: Array.from({ length: 6 }, (_, i) => validStatement(`m${i}`)) }))).status).toBe(400);
    expect((await post('[1,2]')).status).toBe(400);
  });

  it('rejects missing or wrong credentials (401)', async () => {
    expect((await post(JSON.stringify(validStatement('a')), { Authorization: '' })).status).toBe(401);
    expect((await post(JSON.stringify(validStatement('a')), { Authorization: `Bearer ${SECRET}x` })).status).toBe(401);
    expect((await post(JSON.stringify(validStatement('a')), { Authorization: `Basic ${SECRET}` })).status).toBe(401);
    expect(await store.stats()).toEqual({ pending: 0, done: 0, rejected: 0 });
  });

  it('accepts only POST with application/json (CSRF-safe: no simple cross-site requests)', async () => {
    expect((await post('', {}, 'GET')).status).toBe(405);
    expect((await post('{}', { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post('a=1', { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect((await post('{}', { 'Content-Type': 'multipart/form-data; boundary=x' })).status).toBe(415);
    expect((await post(JSON.stringify(validStatement('cs')), { 'Content-Type': 'application/json; charset=utf-8' })).status).toBe(202);
  });

  it('limits the body size (413), parses safely (400) and calls the rate-limit hook (429)', async () => {
    expect((await post(JSON.stringify({ pad: 'x'.repeat(30_000) }))).status).toBe(413);
    expect((await post('{"bad json')).status).toBe(400);
    expect((await post(`${'['.repeat(100)}${']'.repeat(100)}`)).status).toBe(400);
    allow = false;
    const limited = await post(JSON.stringify(validStatement('rl')));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
  });

  it('closes the connection when a streamed body without Content-Length goes far over the limit', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const req = request(`${base}/statements`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}`, 'Transfer-Encoding': 'chunked' } }, (res) => {
        resolve(`status ${res.statusCode ?? 0}`);
      });
      req.on('error', () => { resolve('closed'); });
      const chunk = 'x'.repeat(64 * 1024);
      let sent = 0;
      const pump = (): void => {
        while (sent < 4 * 1024 * 1024) {
          sent += chunk.length;
          if (!req.write(chunk)) {
            req.once('drain', pump);
            return;
          }
        }
        req.end();
      };
      pump();
    });
    expect(outcome).toBe('closed');
  });

  it('closes the connection when a body is far over the limit', async () => {
    await expect(post(JSON.stringify({ pad: 'x'.repeat(2_000_000) }))).rejects.toThrow();
    // The server is still healthy afterwards.
    expect((await post(JSON.stringify(validStatement('after')))).status).toBe(202);
  });

  it('answers 500 without details when the secret is not configured', async () => {
    const h = createNodeHandler({ intake: createIntake({ store }), secret: { env: 'MISSING' }, env: {} });
    const s = createServer((req, res) => void h(req, res));
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"The intake is not configured."}');
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => { r(); }));
  });

  it('never leaks stack traces', async () => {
    const broken = createNodeHandler({
      intake: () => Promise.reject(new Error('secret internal detail')),
      secret: { env: 'S' },
      env: { S: SECRET },
    });
    const s = createServer((req, res) => void broken(req, res));
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: '{}',
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"Internal error."}');
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => { r(); }));
  });

  it('compares secrets in constant time and exactly', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });

  it('checks its options', () => {
    expect(() => createIntake({ store, maxStatements: 0 })).toThrow();
    expect(() => createNodeHandler({ intake: createIntake({ store }), secret: { env: 'S' }, maxBodyBytes: 0 })).toThrow();
  });
});

describe('queue worker', () => {
  let api: MockApi;
  let url: string;
  beforeEach(async () => {
    ({ api, url } = await startMock());
  });
  afterEach(async () => {
    await api.stop();
  });

  it('drains the queue on demand and on its interval, without overlapping runs', async () => {
    const client = new TransparencyClient({ environment: 'local', localBaseUrl: url, token: { env: 'T' }, env: { T: MOCK_TOKEN } });
    await store.add([validStatement('w1')] as never);
    const reports: DrainReport[] = [];
    const worker = startQueueWorker({ client, store, intervalMs: 20, onReport: (r) => reports.push(r) });
    const [a, b] = await Promise.all([worker.runNow(), worker.runNow()]);
    expect(a).toBe(b);
    expect(a?.created).toBe(1);
    await store.add([validStatement('w2')] as never);
    await new Promise((r) => setTimeout(r, 150));
    await worker.stop();
    expect(await store.stats()).toEqual({ pending: 0, done: 2, rejected: 0 });
    expect(reports.length).toBeGreaterThanOrEqual(2);
    expect(() => startQueueWorker({ client, store, intervalMs: 0 })).toThrow();
  });

  it('reports errors and keeps running', async () => {
    const client = new TransparencyClient({ environment: 'local', localBaseUrl: url, token: { env: 'T' }, env: { T: MOCK_TOKEN } });
    const errors: unknown[] = [];
    const failing: QueueStore = {
      add: (x) => store.add(x),
      pending: () => Promise.reject(new Error('disk')),
      settle: (u) => store.settle(u),
      stats: () => store.stats(),
      close: () => store.close(),
    };
    const worker = startQueueWorker({ client, store: failing, intervalMs: 10, onError: (e) => errors.push(e) });
    expect(await worker.runNow()).toBeUndefined();
    await worker.stop();
    expect(errors).toHaveLength(1);
  });
});
