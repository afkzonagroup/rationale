/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Doctest-style checks: every example file appears verbatim in README.md and
 * runs for real. Network examples talk to the local mock API: only the
 * network hop is redirected (the sandbox host name in TDB_SANDBOX_URL is
 * mapped to the mock server); the client code runs unchanged.
 */

import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_TOKEN, startMock, type MockApi } from './helpers/mock-server.js';
import { ROOT, validStatement } from './helpers/vectors.js';

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const examples = readdirSync(join(ROOT, 'examples')).filter((f) => f.endsWith('.ts'));
const SANDBOX = 'https://sandbox.test.europa.eu';

/** Expected output: comment lines directly after a line with console.log. */
function expectedOutput(code: string): string[] {
  const lines = code.split('\n');
  return lines.filter((line, i) => line.startsWith('// ') && (lines[i - 1] ?? '').includes('console.log(')).map((line) => line.slice(3));
}

async function load(name: string): Promise<Record<string, unknown>> {
  // eslint-disable-next-line no-restricted-syntax -- loads a fixed example file from this repository
  return (await import(pathToFileURL(join(ROOT, 'examples', name)).href)) as Record<string, unknown>;
}

let api: MockApi;
let mockUrl: string;
let dir: string;
let printed: string[];
const cwd = process.cwd();

beforeEach(async () => {
  ({ api, url: mockUrl } = await startMock());
  dir = mkdtempSync(join(tmpdir(), 'rationale-example-'));
  chmodSync(dir, 0o700);
  process.chdir(dir);
  printed = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string, init: RequestInit) => realFetch(input.replace(SANDBOX, mockUrl), init));
  vi.stubEnv('TDB_SANDBOX_URL', SANDBOX);
  vi.stubEnv('RATIONALE_API_TOKEN', MOCK_TOKEN);
  vi.stubEnv('INTAKE_SECRET', 'intake-secret-123456');
  vi.stubEnv('PORT', '0');
});

afterEach(async () => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await api.stop();
});

describe('README examples', () => {
  it('has the five examples', () => {
    expect(examples.sort()).toEqual(['build-and-validate.ts', 'express.ts', 'fastify.ts', 'submit-batch.ts', 'webhook-worker.ts']);
  });

  for (const f of examples) {
    it(`README contains examples/${f} verbatim`, () => {
      expect(readme).toContain(readFileSync(join(ROOT, 'examples', f), 'utf8'));
    });
  }

  it('build-and-validate.ts prints the documented output', async () => {
    await load('build-and-validate.ts');
    expect(printed).toEqual(expectedOutput(readFileSync(join(ROOT, 'examples', 'build-and-validate.ts'), 'utf8')));
  });

  it('submit-batch.ts prints the documented output', async () => {
    writeFileSync('statements.jsonl', `${JSON.stringify(validStatement('ex-1'))}\n${JSON.stringify(validStatement('ex-2'))}\n`);
    await load('submit-batch.ts');
    expect(printed).toEqual(expectedOutput(readFileSync(join(ROOT, 'examples', 'submit-batch.ts'), 'utf8')));
    expect(api.calls('/api/v1/statements')).toHaveLength(2);
  });

  it('webhook-worker.ts queues posted statements and the worker sends them', async () => {
    const m = await load('webhook-worker.ts');
    const server = m['server'] as Server;
    if (!server.listening) await new Promise<void>((r) => server.once('listening', () => {
      r();
    }));
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer intake-secret-123456' },
      body: JSON.stringify(validStatement('hook-1')),
    });
    expect(res.status).toBe(202);
    const worker = m['worker'] as { runNow: () => Promise<unknown>; stop: () => Promise<void> };
    await worker.runNow();
    await worker.stop();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => { r(); }));
    await (m['store'] as { close: () => Promise<void> }).close();
    expect(printed).toEqual(['sent: created 1, duplicate 0, rejected 0, failed 0']);
    expect(api.puids.has('hook-1')).toBe(true);
  });

  for (const name of ['express.ts', 'fastify.ts']) {
    it(`${name} mounts the intake handler and enforces its checks`, async () => {
      const m = await load(name);
      let base: string;
      let close: () => Promise<void>;
      if (name === 'express.ts') {
        const app = m['app'] as { listen: (port: number, host: string, cb: () => void) => Server };
        const server = await new Promise<Server>((r) => {
          const s = app.listen(0, '127.0.0.1', () => { r(s); });
        });
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        close = () => new Promise<void>((r) => server.close(() => { r(); }));
      } else {
        const app = m['app'] as { listen: (o: { port: number; host: string }) => Promise<string>; close: () => Promise<void> };
        base = await app.listen({ port: 0, host: '127.0.0.1' });
        close = () => app.close();
      }
      const post = (body: string, headers: Record<string, string>): Promise<Response> => fetch(`${base}/dsa/statements`, { method: 'POST', headers, body });
      const auth = { Authorization: 'Bearer intake-secret-123456' };
      expect((await post(JSON.stringify(validStatement('fw-1')), { ...auth, 'Content-Type': 'application/json' })).status).toBe(202);
      expect((await post('{}', { ...auth, 'Content-Type': 'text/plain' })).status).toBe(415);
      expect((await post('{}', { 'Content-Type': 'application/json' })).status).toBe(401);
      expect((await post(JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }), { ...auth, 'Content-Type': 'application/json' })).status).toBe(413);
      await close();
      const lines = readFileSync(join(dir, 'rationale-queue.jsonl'), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
    });
  }
});
