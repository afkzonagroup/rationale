/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports -- the FIFO tests need mkfifo(1); Node.js has no API to create a FIFO
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryQueueStore, TransparencyClient, drainQueue, enqueueStatements, type QueueStore, type Statement } from '../src/index.js';
import { JsonlQueueStore, readQueueFile } from '../src/node/index.js';
import { acquireLock } from '../src/node/jsonl-store.js';
import { openAppend, openRead } from '../src/node/safe-file.js';
import { MOCK_TOKEN, startMock, type MockApi } from './helpers/mock-server.js';
import { validStatement } from './helpers/vectors.js';

let dir: string;
let api: MockApi;
let url: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rationale-queue-'));
  chmodSync(dir, 0o700);
  ({ api, url } = await startMock());
});
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await api.stop();
});

const st = (puid: string): Statement => validStatement(puid) as unknown as Statement;
const client = (extra: Record<string, unknown> = {}): TransparencyClient =>
  new TransparencyClient({
    environment: 'local',
    localBaseUrl: url,
    token: { env: 'T' },
    env: { T: MOCK_TOKEN },
    clock: { now: () => Date.now(), sleep: () => Promise.resolve() },
    retry: { maxAttempts: 2 },
    ...extra,
  });

async function contract(make: () => Promise<QueueStore>): Promise<void> {
  const s = await make();
  expect(await s.add([st('a'), st('b'), st('a')])).toEqual({ added: ['a', 'b'], skipped: ['a'] });
  expect((await s.pending(10)).map((e) => e.puid)).toEqual(['a', 'b']);
  expect((await s.pending(1)).map((e) => e.puid)).toEqual(['a']);
  expect((await s.pending(10, new Set(['a']))).map((e) => e.puid)).toEqual(['b']);
  await s.settle([{ puid: 'a', result: 'failed', reason: 'network: down' }]);
  const [a] = await s.pending(1);
  expect(a?.attempts).toBe(1);
  expect(a?.lastError).toBe('network: down');
  await s.settle([
    { puid: 'a', result: 'done', uuid: '4b989c23-3736-4fd9-8612-a975b98d88d6' },
    { puid: 'b', result: 'rejected', reason: 'category: invalid' },
    { puid: 'unknown', result: 'done' },
  ]);
  expect(await s.stats()).toEqual({ pending: 0, done: 1, rejected: 1 });
  // Settled PUIDs are known: adding them again is skipped, and settling them again does nothing.
  expect(await s.add([st('a')])).toEqual({ added: [], skipped: ['a'] });
  await s.settle([{ puid: 'a', result: 'failed', reason: 'x' }]);
  expect(await s.stats()).toEqual({ pending: 0, done: 1, rejected: 1 });
  await expect(s.add([{ puid: 'bad' } as unknown as Statement])).rejects.toThrow(/valid statements/);
  await s.close();
  await expect(s.stats()).rejects.toThrow();
}

describe('memory queue store', () => {
  it('fulfils the store contract', async () => {
    await contract(() => Promise.resolve(new MemoryQueueStore()));
  });
});

describe('JSONL queue store', () => {
  const file = (): string => join(dir, 'queue.jsonl');

  it('fulfils the store contract', async () => {
    await contract(() => JsonlQueueStore.open(file()));
  });

  it('keeps statements across restarts and creates files with mode 0600', async () => {
    const s = await JsonlQueueStore.open(file());
    await s.add([st('x1'), st('x2')]);
    await s.settle([{ puid: 'x1', result: 'done' }]);
    await s.close();
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file()}.lock`)).toBe(false);
    const again = await JsonlQueueStore.open(file());
    expect((await again.pending(10)).map((e) => e.puid)).toEqual(['x2']);
    expect(await again.stats()).toEqual({ pending: 1, done: 1, rejected: 0 });
    await again.close();
    expect((await readQueueFile(file())).map((e) => [e.puid, e.state])).toEqual([
      ['x1', 'done'],
      ['x2', 'pending'],
    ]);
  });

  it('cuts off an interrupted last line and keeps working', async () => {
    const s = await JsonlQueueStore.open(file());
    await s.add([st('k1')]);
    await s.close();
    appendFileSync(file(), '{"v":1,"op":"add","at":"2026-');
    const again = await JsonlQueueStore.open(file());
    await again.add([st('k2')]);
    await again.close();
    const lines = readFileSync(file(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => JSON.parse(l) !== null)).toBe(true);
  });

  it('refuses a damaged or tampered file', async () => {
    const cases = [
      'not json\n',
      '{"v":1,"op":"add","at":"2026-11-08T10:00:00.000Z","puid":"a","statement":{"puid":"a"}}\n',
      `${JSON.stringify({ v: 1, op: 'add', at: '2026-11-08T10:00:00.000Z', puid: 'other', statement: validStatement('a') })}\n`,
      '{"v":1,"op":"done","at":"2026-11-08T10:00:00.000Z","puid":"never-added"}\n',
      `${JSON.stringify({ v: 1, op: 'add', at: '2026-11-08T10:00:00.000Z', puid: 'a', statement: validStatement('a'), extra: 1 })}\n`,
      `${JSON.stringify({ v: 2, op: 'add', at: '2026-11-08T10:00:00.000Z', puid: 'a', statement: validStatement('a') })}\n`,
      `${JSON.stringify({ v: 1, op: 'add', at: '2026-11-08T10:00:00.000Z', puid: 'a', statement: validStatement('a') })}\n`.repeat(2),
      Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]),
    ];
    for (const text of cases) {
      writeFileSync(file(), text, { mode: 0o600 });
      await expect(JsonlQueueStore.open(file()), text.toString().slice(0, 60)).rejects.toThrow(/queue/i);
      expect(existsSync(`${file()}.lock`)).toBe(false);
    }
  });

  it('refuses symlinks, other-writable files and unsafe names', async () => {
    const target = join(dir, 'target.jsonl');
    writeFileSync(target, '', { mode: 0o600 });
    symlinkSync(target, join(dir, 'link.jsonl'));
    await expect(JsonlQueueStore.open(join(dir, 'link.jsonl'))).rejects.toThrow(/symbolic link/);
    writeFileSync(join(dir, 'open.jsonl'), '', { mode: 0o600 });
    chmodSync(join(dir, 'open.jsonl'), 0o666);
    await expect(JsonlQueueStore.open(join(dir, 'open.jsonl'))).rejects.toThrow(/writable by other users/);
    await expect(JsonlQueueStore.open(join(dir, 'bad name.jsonl'))).rejects.toThrow(/file name/);
    await expect(JsonlQueueStore.open(join(dir, 'missing-dir', 'q.jsonl'))).rejects.toThrow(/directory/);
    await expect(JsonlQueueStore.open('a\0b')).rejects.toThrow(/Invalid file path/);
    mkdirSync(join(dir, 'isdir.jsonl'));
    await expect(JsonlQueueStore.open(join(dir, 'isdir.jsonl'))).rejects.toThrow(/not a regular file/);
    const shared = join(dir, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    await expect(JsonlQueueStore.open(join(shared, 'q.jsonl'))).rejects.toThrow(/writable by everyone/);
  });

  it('allows one process at a time and takes over a stale lock', async () => {
    const s = await JsonlQueueStore.open(file());
    await expect(JsonlQueueStore.open(file())).rejects.toThrow(/in use/);
    await s.close();
    writeFileSync(`${file()}.lock`, '999999\n', { mode: 0o600 });
    const t = await JsonlQueueStore.open(file());
    await t.close();
  });

  it('lets only one of two processes take over the same stale lock', async () => {
    for (let round = 0; round < 20; round++) {
      writeFileSync(`${file()}.lock`, '999999\n', { mode: 0o600 });
      const results = await Promise.allSettled([JsonlQueueStore.open(file()), JsonlQueueStore.open(file()), JsonlQueueStore.open(file())]);
      const opened = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      expect(opened).toHaveLength(1);
      for (const r of results) if (r.status === 'rejected') expect(String(r.reason)).toMatch(/in use|taking over/);
      for (const q of opened) await q.close();
      expect(existsSync(`${file()}.lock.takeover`)).toBe(false);
    }
  });

  it('reads a stale lock again under the takeover guard', async () => {
    const lock = `${file()}.lock`;
    writeFileSync(lock, '999999\n', { mode: 0o600 });
    // Another process takes the lock over just before our second look.
    const other = (): Promise<void> => {
      rmSync(lock);
      writeFileSync(lock, `${process.ppid}\n`, { mode: 0o600 });
      return Promise.resolve();
    };
    await expect(acquireLock(lock, other)).rejects.toThrow(/in use/);
    expect(readFileSync(lock, 'utf8')).toBe(`${process.ppid}\n`);
    expect(existsSync(`${lock}.takeover`)).toBe(false);
  });

  it('refuses to take over while a takeover file exists', async () => {
    writeFileSync(`${file()}.lock`, '999999\n', { mode: 0o600 });
    writeFileSync(`${file()}.lock.takeover`, '', { mode: 0o600 });
    await expect(JsonlQueueStore.open(file())).rejects.toThrow(/taking over/);
    expect(readFileSync(`${file()}.lock`, 'utf8')).toBe('999999\n');
  });

  it('never blocks on a FIFO in place of the queue or lock file', async () => {
    execFileSync('mkfifo', [`${file()}.lock`]);
    await expect(JsonlQueueStore.open(file())).rejects.toThrow(/in use/);
    rmSync(`${file()}.lock`);
    execFileSync('mkfifo', [file()]);
    await expect(openRead(file())).rejects.toThrow(/not a regular file/);
    await expect(openAppend(file())).rejects.toThrow();
  });

  it('refuses queue files that are not valid UTF-8, too large or have an overlong line', async () => {
    const s = await JsonlQueueStore.open(file());
    await s.add([st('u1')]);
    await s.close();
    const good = readFileSync(file());
    writeFileSync(file(), Buffer.concat([good.subarray(0, 20), Buffer.from([0xff, 0xfe]), good.subarray(22)]), { mode: 0o600 });
    await expect(JsonlQueueStore.open(file())).rejects.toThrow(/not valid UTF-8/);
    await expect(readQueueFile(file())).rejects.toThrow(/not valid UTF-8/);
    writeFileSync(file(), good, { mode: 0o600 });
    await expect(JsonlQueueStore.open(file(), { maxFileBytes: good.length - 1 })).rejects.toThrow(/larger than/);
    writeFileSync(file(), `${' '.repeat(2 * 1024 * 1024 + 1)}\n`, { mode: 0o600 });
    await expect(JsonlQueueStore.open(file())).rejects.toThrow(/too long/);
    expect(existsSync(`${file()}.lock`)).toBe(false);
  });

  it('compacts to the pending statements atomically', async () => {
    const s = await JsonlQueueStore.open(file());
    await s.add([st('c1'), st('c2'), st('c3')]);
    await s.settle([
      { puid: 'c1', result: 'done' },
      { puid: 'c2', result: 'rejected', reason: 'x' },
    ]);
    expect(await s.compact()).toEqual({ kept: 1, dropped: 2 });
    await s.add([st('c4')]);
    expect((await s.pending(10)).map((e) => e.puid)).toEqual(['c3', 'c4']);
    await s.close();
    expect(readFileSync(file(), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it('stores reasons without control characters or bearer values', async () => {
    const s = await JsonlQueueStore.open(file());
    await s.add([st('r1')]);
    await s.settle([{ puid: 'r1', result: 'failed', reason: `line\nbreak Bearer abc.def ${'x'.repeat(600)}` }]);
    const [e] = await s.pending(1);
    expect(e?.lastError).not.toContain('\n');
    expect(e?.lastError).not.toContain('abc.def');
    expect(e?.lastError?.length).toBe(500);
    await s.close();
  });
});

describe('enqueue and drain', () => {
  it('queues valid statements, reports invalid ones, and drains to the API', async () => {
    const store = await JsonlQueueStore.open(join(dir, 'q.jsonl'));
    const enq = await enqueueStatements(store, [validStatement('d1'), { puid: 'bad' }, validStatement('d2'), validStatement('d1')]);
    expect(enq.added).toEqual(['d1', 'd2']);
    expect([...enq.invalid.keys()]).toEqual([1, 3]);
    const report = await drainQueue(client(), store);
    expect(report).toMatchObject({ created: 2, failed: 0, stoppedBecause: 'empty' });
    expect(await store.stats()).toEqual({ pending: 0, done: 2, rejected: 0 });
    await store.close();
  });

  it('keeps statements queued while the API is down and sends them later', async () => {
    const store = await JsonlQueueStore.open(join(dir, 'q.jsonl'));
    await enqueueStatements(store, [validStatement('o1'), validStatement('o2')]);
    // maxAttempts is 2: two failed attempts per drain.
    for (let i = 0; i < 2; i++) api.script.push({ status: 503, raw: 'maintenance' });
    const down = await drainQueue(client(), store);
    expect(down).toMatchObject({ created: 0, failed: 2, stoppedBecause: 'only_failures' });
    await store.close();
    // A restart later: the file still holds both statements.
    const again = await JsonlQueueStore.open(join(dir, 'q.jsonl'));
    expect((await again.pending(10)).map((e) => [e.puid, e.attempts])).toEqual([
      ['o1', 1],
      ['o2', 1],
    ]);
    const up = await drainQueue(client(), again);
    expect(up).toMatchObject({ created: 2, stoppedBecause: 'empty' });
    await again.close();
  });

  it('marks duplicates done and rejected statements as rejected', async () => {
    api.puids.add('m1');
    api.rejectPuids.add('m2');
    const store = new MemoryQueueStore();
    await enqueueStatements(store, [validStatement('m1'), validStatement('m2'), validStatement('m3')]);
    const r = await drainQueue(client(), store);
    expect(r).toMatchObject({ created: 1, duplicate: 1, rejected: 1, failed: 0 });
    expect(await store.stats()).toEqual({ pending: 0, done: 2, rejected: 1 });
  });

  it('stops on authentication errors', async () => {
    api.token = 'other';
    const store = new MemoryQueueStore();
    await enqueueStatements(store, [validStatement('u1')]);
    expect(await drainQueue(client(), store)).toMatchObject({ stoppedBecause: 'fatal_error', failed: 1 });
    expect(await store.stats()).toEqual({ pending: 1, done: 0, rejected: 0 });
  });

  it('honours pageSize, maxRounds, abort and dry run', async () => {
    const store = new MemoryQueueStore();
    await enqueueStatements(store, Array.from({ length: 5 }, (_, i) => validStatement(`z${i}`)));
    expect(await drainQueue(client(), store, { pageSize: 2, maxRounds: 1 })).toMatchObject({ created: 2, rounds: 1, stoppedBecause: 'max_rounds' });
    const ctl = new AbortController();
    ctl.abort();
    expect(await drainQueue(client(), store, { signal: ctl.signal })).toMatchObject({ stoppedBecause: 'aborted' });
    const dry = new TransparencyClient({ environment: 'local', localBaseUrl: url, dryRun: true });
    expect(await drainQueue(dry, store)).toMatchObject({ stoppedBecause: 'dry_run' });
    expect(await store.stats()).toMatchObject({ pending: 3 });
    await expect(drainQueue(client(), store, { pageSize: 0 })).rejects.toThrow();
  });
});
