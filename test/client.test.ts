/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/http.js';
import { RationaleError, TransparencyClient, type ClientEvent, type ClientOptions, type Clock } from '../src/index.js';
import { MOCK_TOKEN, startMock, type MockApi } from './helpers/mock-server.js';
import { validStatement } from './helpers/vectors.js';

let api: MockApi;
let url: string;
let sleeps: number[];
let events: ClientEvent[];

const fastClock = (): Clock => ({
  now: () => Date.now(),
  sleep: (ms) => {
    sleeps.push(ms);
    return Promise.resolve();
  },
});

function client(extra: Partial<ClientOptions> = {}): TransparencyClient {
  return new TransparencyClient({
    environment: 'local',
    localBaseUrl: url,
    token: { env: 'TDB_TOKEN' },
    env: { TDB_TOKEN: MOCK_TOKEN },
    clock: fastClock(),
    random: () => 0.5,
    onEvent: (e) => events.push(e),
    ...extra,
  });
}

const many = (n: number, prefix = 'p'): Record<string, unknown>[] => Array.from({ length: n }, (_, i) => validStatement(`${prefix}-${i}`));

beforeEach(async () => {
  ({ api, url } = await startMock());
  sleeps = [];
  events = [];
});
afterEach(async () => {
  await api.stop();
});

describe('single submission', () => {
  it('creates a statement and sends the documented headers', async () => {
    const o = await client().submit(validStatement('one'));
    expect(o.status).toBe('created');
    expect(o.status === 'created' && o.uuid).toMatch(/^[0-9a-f-]{36}$/);
    const [req] = api.calls('/api/v1/statement');
    expect(req?.method).toBe('POST');
    expect(req?.headers.authorization).toBe(`Bearer ${MOCK_TOKEN}`);
    expect(req?.headers.accept).toBe('application/json');
    expect(req?.headers['content-type']).toBe('application/json');
    expect(req?.headers['user-agent']).toMatch(/^rationale\/\d+\.\d+\.\d+$/);
    expect(JSON.parse(req?.body ?? '{}')).toEqual(validStatement('one'));
  });

  it('sends the normalised statement, not the raw input', async () => {
    await client().submit(validStatement('  two  ', { source_type: 'SOURCE_VOLUNTARY', source_identity: 'x', account_type: '' }));
    const sent = JSON.parse(api.calls('/api/v1/statement')[0]?.body ?? '{}') as Record<string, unknown>;
    expect(sent['puid']).toBe('two');
    expect(sent).not.toHaveProperty('source_identity');
    expect(sent).not.toHaveProperty('account_type');
  });

  it('reports a used PUID as duplicate (idempotent) after confirming it', async () => {
    api.puids.add('dup');
    const o = await client().submit(validStatement('dup'));
    expect(o.status).toBe('duplicate');
    expect(api.calls('/api/v1/statement/existing-puid/dup')).toHaveLength(1);
  });

  it('does not report "duplicate" when the PUID is reported in use but not found (lock collision)', async () => {
    api.lockedPuids.add('locked');
    const o = await client({ retry: { maxAttempts: 3 } }).submit(validStatement('locked'));
    expect(o.status).toBe('failed');
    expect(o.status === 'failed' && o.error.retryable).toBe(true);
    expect(api.calls('/api/v1/statement')).toHaveLength(3);
  });

  it('reports server-side validation errors as rejected, without retrying', async () => {
    api.rejectPuids.add('bad');
    const o = await client().submit(validStatement('bad'));
    expect(o.status).toBe('rejected');
    expect(o.status === 'rejected' && o.serverErrors['category']).toEqual(['The selected category is invalid.']);
    expect(api.calls('/api/v1/statement')).toHaveLength(1);
  });

  it('never sends invalid statements', async () => {
    const o = await client().submit({ puid: 'x' });
    expect(o.status).toBe('invalid');
    expect(api.requests).toHaveLength(0);
  });
});

describe('batch submission', () => {
  it('chunks to the API limit of 100 statements', async () => {
    const r = await client().submitBatch(many(250));
    expect(r.counts.created).toBe(250);
    const calls = api.calls('/api/v1/statements');
    expect(calls.map((c) => (JSON.parse(c.body) as { statements: unknown[] }).statements.length)).toEqual([100, 100, 50]);
    expect(r.outcomes.map((o) => o.index)).toEqual([...Array(250).keys()]);
  });

  it('respects a smaller batch size and a byte budget', async () => {
    await client({ batchSize: 30 }).submitBatch(many(70));
    expect(api.calls('/api/v1/statements').map((c) => (JSON.parse(c.body) as { statements: unknown[] }).statements.length)).toEqual([30, 30, 10]);
    api.requests.length = 0;
    const one = JSON.stringify(validStatement('p-0')).length;
    await client({ maxBatchBytes: one * 3 + 40 }).submitBatch(many(7, 'q'));
    const sizes = api.calls('/api/v1/statements').map((c) => (JSON.parse(c.body) as { statements: unknown[] }).statements.length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(7);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(3);
    for (const c of api.calls('/api/v1/statements')) expect(Buffer.byteLength(c.body)).toBeLessThanOrEqual(one * 3 + 40);
  });

  it('keeps outcomes aligned with inputs, with invalid inputs reported and not sent', async () => {
    const inputs = [validStatement('a'), { nope: true }, validStatement('b'), validStatement('a')];
    const r = await client().submitBatch(inputs);
    expect(r.outcomes.map((o) => o.status)).toEqual(['created', 'invalid', 'created', 'invalid']);
    const sent = (JSON.parse(api.calls('/api/v1/statements')[0]?.body ?? '{}') as { statements: { puid: string }[] }).statements;
    expect(sent.map((s) => s.puid)).toEqual(['a', 'b']);
  });

  it('removes already-submitted PUIDs and sends the rest again (idempotent retry)', async () => {
    api.puids.add('p-1');
    api.puids.add('p-3');
    const r = await client().submitBatch(many(5));
    expect(r.outcomes.map((o) => o.status)).toEqual(['created', 'duplicate', 'created', 'duplicate', 'created']);
    const calls = api.calls('/api/v1/statements');
    expect(calls).toHaveLength(2);
    expect((JSON.parse(calls[1]?.body ?? '{}') as { statements: { puid: string }[] }).statements.map((s) => s.puid)).toEqual(['p-0', 'p-2', 'p-4']);
  });

  it('recovers when a timed-out request was in fact stored', async () => {
    // The first request is stored by the server but the response never arrives in time.
    api.script.push({ processFirst: true, delayMs: 300, status: 201, body: { statements: [] } });
    const r = await client({ timeoutMs: 100 }).submitBatch(many(3));
    expect(r.counts.duplicate).toBe(3);
    expect(r.counts.created).toBe(0);
    expect(r.counts.failed).toBe(0);
  });

  it('marks statements the server rejects and resends the others', async () => {
    api.rejectPuids.add('p-2');
    const r = await client().submitBatch(many(4));
    expect(r.outcomes.map((o) => o.status)).toEqual(['created', 'created', 'rejected', 'created']);
    expect(api.calls('/api/v1/statements')).toHaveLength(2);
  });

  it('does not loop when the server names statement indexes that were not sent', async () => {
    api.script.push({ status: 422, body: { errors: { statement_99: { category: ['bad'] } } } });
    const r = await client().submitBatch(many(2));
    expect(r.outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);
    expect(api.calls('/api/v1/statements')).toHaveLength(1);
  });

  it('splits a batch on 413 Payload Too Large', async () => {
    api.script.push({ status: 413, raw: 'too large' });
    const r = await client().submitBatch(many(4));
    expect(r.counts.created).toBe(4);
    expect(events).toContainEqual({ type: 'split', from: 4, to: 2 });
    expect(api.calls('/api/v1/statements')).toHaveLength(3);
  });

  it('stops after an authentication error and does not retry it', async () => {
    api.token = 'something-else';
    const r = await client({ batchSize: 10 }).submitBatch(many(30));
    expect(r.counts.failed).toBe(30);
    expect(api.calls('/api/v1/statements')).toHaveLength(1);
    const o = r.outcomes[0];
    expect(o?.status === 'failed' && o.error.code).toBe('unauthorized');
  });
});

describe('retries', () => {
  it('retries 503 with exponential backoff and jitter, then succeeds', async () => {
    api.script.push({ status: 503, raw: 'down' }, { status: 503, raw: 'down' });
    const r = await client({ retry: { baseDelayMs: 100 } }).submitBatch(many(2));
    expect(r.counts.created).toBe(2);
    // random() = 0.5: half of 100 ms, then half of 200 ms.
    expect(sleeps).toEqual([50, 100]);
  });

  it('after an unknown outcome (502, 500, 504, timeout), waits out the server PUID lock before resending', async () => {
    api.script.push({ status: 502, raw: 'bad gateway' }, { status: 500, body: {} }, { status: 504, raw: 'gateway timeout' });
    const r = await client({ retry: { baseDelayMs: 100 } }).submitBatch(many(2));
    expect(r.counts.created).toBe(2);
    expect(sleeps).toEqual([31_000, 31_000, 31_000]);
  });

  it('does not wait out the lock when the connection was refused (nothing was sent)', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => { resolve(); }));
    const r = await client({ localBaseUrl: `http://127.0.0.1:${port}`, retry: { maxAttempts: 3, baseDelayMs: 100 } }).submitBatch(many(1));
    const o = r.outcomes[0];
    expect(o?.status === 'failed' && o.error.code).toBe('network');
    expect(sleeps).toEqual([50, 100]);
  });

  it('tells failures before connecting from failures that may have reached the server', async () => {
    const failWith = (cause: unknown): FetchLike => () => Promise.reject(cause === undefined ? new TypeError('fetch failed') : new TypeError('fetch failed', { cause }));
    const coded = (code: string): Error => Object.assign(new Error(code), { code });
    const notSent = [coded('ENOTFOUND'), coded('EAI_AGAIN'), coded('ECONNREFUSED'), coded('EHOSTUNREACH'), coded('ENETUNREACH'), coded('UND_ERR_CONNECT_TIMEOUT'), coded('CERT_HAS_EXPIRED'), coded('ERR_TLS_CERT_ALTNAME_INVALID'), new AggregateError([coded('ECONNREFUSED'), coded('EHOSTUNREACH')])];
    const unknown = [undefined, coded('ECONNRESET'), coded('EPIPE'), coded('UND_ERR_SOCKET'), coded('ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC'), new Error('no code'), new AggregateError([coded('ECONNREFUSED'), coded('ECONNRESET')]), new AggregateError([])];
    for (const cause of notSent) {
      sleeps = [];
      await client({ fetch: failWith(cause), retry: { maxAttempts: 2, baseDelayMs: 100 } }).submitBatch(many(1));
      expect(sleeps, (cause as { code?: string }).code ?? 'aggregate').toEqual([50]);
    }
    for (const cause of unknown) {
      sleeps = [];
      await client({ fetch: failWith(cause), retry: { maxAttempts: 2, baseDelayMs: 100 } }).submitBatch(many(1));
      expect(sleeps, (cause as { code?: string } | undefined)?.code ?? 'unknown').toEqual([31_000]);
    }
  });

  it('does not report a statement as duplicate after its own timed-out request held the server lock and failed', async () => {
    // Virtual time shared by the client and the mock's PUID locks.
    let now = 1_000_000;
    api.now = () => now;
    const clock: Clock = {
      now: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    };
    // The first request takes the server's PUID locks for 30 s, outlives the client timeout and then fails.
    api.script.push({ holdLockMs: 30_000, delayMs: 300, status: 500, body: {} });
    const r = await client({ clock, timeoutMs: 100 }).submitBatch(many(2));
    expect(r.outcomes.map((o) => o.status)).toEqual(['created', 'created']);
    expect(api.puids.has('p-0') && api.puids.has('p-1')).toBe(true);
    expect(api.cachedPuids.size).toBe(0);
  });

  it('also waits out the lock in a later call of the same client (queue worker rounds)', async () => {
    let now = 1_000_000;
    api.now = () => now;
    const waits: number[] = [];
    const clock: Clock = {
      now: () => now,
      sleep: (ms) => {
        waits.push(ms);
        now += ms;
        return Promise.resolve();
      },
    };
    api.script.push({ holdLockMs: 30_000, delayMs: 300, status: 500, body: {} });
    const c = client({ clock, timeoutMs: 100, retry: { maxAttempts: 1 } });
    const first = await c.submitBatch(many(1));
    expect(first.outcomes[0]?.status).toBe('failed');
    now += 5_000;
    const second = await c.submitBatch(many(1));
    expect(second.outcomes[0]?.status).toBe('created');
    expect(waits).toContain(26_000);
    expect(api.cachedPuids.size).toBe(0);
  });

  it('honours Retry-After on 429 and on 503', async () => {
    api.script.push({ status: 429, headers: { 'Retry-After': '3' }, raw: 'Limit Reached. Please do not overload the API' });
    const r = await client().submitBatch(many(1));
    expect(r.counts.created).toBe(1);
    expect(sleeps).toEqual([3000]);
  });

  it('gives up when Retry-After is longer than the allowed wait, as a retryable failure', async () => {
    api.script.push({ status: 429, headers: { 'Retry-After': '3600' }, raw: 'Limit Reached.' });
    const r = await client().submitBatch(many(1));
    const o = r.outcomes[0];
    expect(o?.status).toBe('failed');
    expect(o?.status === 'failed' && o.error).toMatchObject({ code: 'rate_limited', retryable: true, status: 429 });
    expect(sleeps).toEqual([]);
  });

  it('stops after maxAttempts', async () => {
    for (let i = 0; i < 10; i++) api.script.push({ status: 500, body: { message: 'Server Error' } });
    const r = await client({ retry: { maxAttempts: 3 } }).submitBatch(many(1));
    expect(api.calls('/api/v1/statements')).toHaveLength(3);
    const o = r.outcomes[0];
    expect(o?.status === 'failed' && o.error).toMatchObject({ code: 'http', retryable: true, status: 500 });
  });

  it('does not retry non-retryable statuses', async () => {
    for (const status of [400, 403, 404, 405]) {
      api.script.push({ status, body: { message: 'no' } });
      const r = await client().submitBatch(many(1, `s${status}`));
      expect(r.outcomes[0]?.status).toBe('failed');
    }
    expect(api.calls('/api/v1/statements')).toHaveLength(4);
    expect(sleeps).toEqual([]);
  });

  it('retries network errors and timeouts', async () => {
    api.script.push({ destroy: true }, { delayMs: 300, status: 201, body: {} });
    const r = await client({ timeoutMs: 100 }).submitBatch(many(1));
    expect(r.counts.created).toBe(1);
    expect(events.flatMap((e) => (e.type === 'retry' ? [e.reason] : []))).toEqual(['network', 'timeout']);
  });

  it('stops sending further chunks after a connection-level failure', async () => {
    for (let i = 0; i < 2; i++) api.script.push({ destroy: true });
    const r = await client({ batchSize: 1, retry: { maxAttempts: 2 } }).submitBatch(many(3));
    expect(r.outcomes.map((o) => (o.status === 'failed' ? o.error.code : o.status))).toEqual(['network', 'network', 'network']);
    expect(api.calls('/api/v1/statements')).toHaveLength(2);
  });

  it('caps the total time of a slowly dripping response', async () => {
    api.script.push({ status: 201, raw: JSON.stringify({ statements: [], pad: 'x'.repeat(100) }), dripMs: 20 });
    const t0 = Date.now();
    const r = await client({ timeoutMs: 150, retry: { maxAttempts: 1 } }).submitBatch(many(1));
    expect(Date.now() - t0).toBeLessThan(1000);
    const o = r.outcomes[0];
    expect(o?.status === 'failed' && o.error.code).toBe('timeout');
  });

  it('never follows redirects', async () => {
    api.script.push({ status: 302, headers: { Location: 'https://attacker.example/steal' }, raw: '' });
    const r = await client().submitBatch(many(1));
    const o = r.outcomes[0];
    expect(o?.status === 'failed' && o.error.code).toBe('http');
    expect(api.requests).toHaveLength(1);
  });
});

describe('rate limiting', () => {
  it('limits batch calls per second on the client, shared by concurrent calls', async () => {
    let now = 1_000_000;
    const waits: number[] = [];
    const clock: Clock = {
      now: () => now,
      sleep: (ms) => {
        waits.push(ms);
        now += ms;
        return Promise.resolve();
      },
    };
    const c = client({ clock, batchSize: 1 });
    await Promise.all([c.submitBatch(many(3, 'a')), c.submitBatch(many(3, 'b'))]);
    // 6 batch calls, 4 per second allowed: the 5th and 6th wait for the window.
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1000);
    expect(api.calls('/api/v1/statements')).toHaveLength(6);
  });

  it('can be turned off', async () => {
    const c = client({ rateLimit: false, batchSize: 1 });
    await c.submitBatch(many(6));
    expect(sleeps).toEqual([]);
  });
});

describe('dry run', () => {
  it('validates and sends nothing, and needs no token', async () => {
    const c = new TransparencyClient({ environment: 'local', localBaseUrl: url, dryRun: true, env: {} });
    const r = await c.submitBatch([validStatement('d1'), { puid: 'x' }]);
    expect(r.dryRun).toBe(true);
    expect(r.outcomes.map((o) => o.status)).toEqual(['validated', 'invalid']);
    expect(api.requests).toHaveLength(0);
    await expect(c.puidExists('d1')).rejects.toThrow(RationaleError);
  });

  it('still checks the environment configuration', () => {
    expect(() => new TransparencyClient({ environment: 'production', dryRun: true })).toThrow(/allowProduction/);
  });
});

describe('existing PUID lookup', () => {
  it('maps 302 to true and 404 to false', async () => {
    api.puids.add('here');
    const c = client();
    expect(await c.puidExists('here')).toBe(true);
    expect(await c.puidExists('gone')).toBe(false);
  });

  it('refuses PUIDs that could change the request path', async () => {
    await expect(client().puidExists('../../admin')).rejects.toThrow(/Invalid PUID/);
    await expect(client().puidExists('a/b')).rejects.toThrow(/Invalid PUID/);
    expect(api.requests).toHaveLength(0);
  });
});

describe('token secrecy', () => {
  it('never puts the token into outcomes, events, errors or their string forms', async () => {
    api.script.push(
      { status: 500, body: { message: `boom ${MOCK_TOKEN} Bearer ${MOCK_TOKEN}` } },
      { status: 500, raw: `plain ${MOCK_TOKEN}`, headers: { 'Content-Type': 'text/plain' } },
      { status: 422, body: { errors: { statement_0: { category: [`bad ${MOCK_TOKEN}`] } } } },
    );
    const c = client({ retry: { maxAttempts: 1 } });
    const r1 = await c.submitBatch(many(1, 'x'));
    const r1b = await c.submitBatch(many(1, 'x2'));
    const r2 = await c.submitBatch(many(1, 'y'));
    expect(JSON.stringify(r1.outcomes)).toContain('boom [REDACTED]');
    expect(JSON.stringify(r1b.outcomes)).toContain('plain [REDACTED]');
    expect(JSON.stringify(r2.outcomes)).toContain('bad [REDACTED]');
    api.token = 'other';
    const r3 = await c.submitBatch(many(1, 'z'));
    let thrown: unknown;
    try {
      await c.puidExists('z-0');
    } catch (e) {
      thrown = e;
    }
    const everything = [JSON.stringify([r1, r1b, r2, r3].map((r) => r.outcomes)), JSON.stringify(events), inspect([r1, r2, r3], { depth: 10 }), inspect(c, { depth: 10 }), String(thrown), inspect(thrown), JSON.stringify(thrown), (thrown as Error).stack ?? ''].join('\n');
    expect(everything).not.toContain(MOCK_TOKEN);
    expect(everything).not.toContain('mockTokenValue');
    expect(everything).toContain('[REDACTED]');
  });

  it('rejects a token passed as a plain string', () => {
    expect(() => client({ token: MOCK_TOKEN as never })).toThrow(/not as a string/);
  });

  it('reports a missing token without sending', async () => {
    const r = await client({ env: {} }).submitBatch(many(1));
    const o = r.outcomes[0];
    expect(o?.status === 'failed' && o.error.code).toBe('token');
    expect(api.requests).toHaveLength(0);
  });

  it('rejects tokens that could inject headers', async () => {
    const r = await client({ env: { TDB_TOKEN: 'abc\r\nX-Evil: 1' } }).submitBatch(many(1));
    const o = r.outcomes[0];
    expect(o?.status === 'failed' && o.error.code).toBe('token');
    expect(api.requests).toHaveLength(0);
  });

  it('reads the token from a function (secret store)', async () => {
    const o = await client({ token: () => Promise.resolve(MOCK_TOKEN) }).submit(validStatement('fn'));
    expect(o.status).toBe('created');
  });
});

describe('hostile responses', () => {
  it('caps the response size', async () => {
    api.script.push({ status: 201, raw: JSON.stringify({ statements: [], pad: 'x'.repeat(5000) }) });
    const r = await client({ maxResponseBytes: 1000 }).submitBatch(many(1));
    const o = r.outcomes[0];
    expect(o?.status === 'failed' && o.error.code).toBe('response_too_large');
  });

  it('ignores prototype-polluting keys and malformed fields in responses', async () => {
    api.script.push({
      status: 201,
      raw: '{"statements":[{"puid":"p-0","uuid":"not-a-uuid","permalink":"javascript:alert(1)","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}]}',
    });
    const r = await client().submitBatch(many(1));
    const o = r.outcomes[0];
    expect(o).toEqual({ status: 'created', index: 0, puid: 'p-0' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('removes control characters and terminal escapes from server text', async () => {
    const esc = String.fromCharCode(27);
    api.script.push({ status: 422, body: { errors: { statement_0: { category: [`bad${esc}[2J${esc}]0;title${String.fromCharCode(7)}\nmore`] } } } });
    const r = await client().submitBatch(many(1));
    const o = r.outcomes[0];
    const msg = o?.status === 'rejected' ? (o.serverErrors['category']?.[0] ?? '') : '';
    expect(msg.startsWith('bad')).toBe(true);
    for (let c = 0; c < 32; c++) expect(msg.includes(String.fromCharCode(c)), String(c)).toBe(false);
  });

  it('treats a non-JSON 201 as created (the status is what counts, per the documentation)', async () => {
    api.script.push({ status: 201, raw: '<html>ok</html>', headers: { 'Content-Type': 'text/html' } });
    const r = await client().submitBatch(many(2));
    expect(r.counts.created).toBe(2);
  });
});

describe('configuration', () => {
  it('rejects unsafe numbers', () => {
    expect(() => client({ batchSize: 101 })).toThrow(/batchSize/);
    expect(() => client({ batchSize: 0 })).toThrow(/batchSize/);
    expect(() => client({ timeoutMs: -1 })).toThrow(/timeoutMs/);
    expect(() => client({ retry: { maxAttempts: 0 } })).toThrow(/maxAttempts/);
  });

  it('aborts on signal', async () => {
    const ctl = new AbortController();
    api.script.push({ delayMs: 500, status: 201, body: {} });
    const p = client().submitBatch(many(1), { signal: ctl.signal });
    setTimeout(() => { ctl.abort(); }, 50);
    const r = await p;
    const o = r.outcomes[0];
    expect(o?.status === 'failed' && o.error.code).toBe('aborted');
  });
});
