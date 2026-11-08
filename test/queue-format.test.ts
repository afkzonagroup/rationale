/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The JSONL queue format is shared with the Python package. This test
 * writes a queue file with the TypeScript store and compares it with
 * test-vectors/queue-from-typescript.jsonl, which the Python tests read.
 * Set UPDATE_VECTORS=1 to rewrite the fixture.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Statement } from '../src/index.js';
import { JsonlQueueStore } from '../src/node/index.js';
import { ROOT, validStatement } from './helpers/vectors.js';

it('writes the shared queue format', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rationale-format-'));
  chmodSync(dir, 0o700);
  try {
    const file = join(dir, 'q.jsonl');
    const store = await JsonlQueueStore.open(file, { now: () => new Date('2026-11-08T10:00:00.000Z') });
    await store.add(['ts-1', 'ts-2', 'ts-3'].map((p) => validStatement(p) as unknown as Statement));
    await store.settle([
      { puid: 'ts-1', result: 'done', uuid: '4b989c23-3736-4fd9-8612-a975b98d88d6', duplicate: false },
      { puid: 'ts-2', result: 'rejected', reason: 'category: The selected category is invalid.' },
      { puid: 'ts-3', result: 'failed', reason: 'network: down' },
    ]);
    await store.close();
    const text = readFileSync(file, 'utf8');
    const fixture = join(ROOT, 'test-vectors', 'queue-from-typescript.jsonl');
    if (process.env['UPDATE_VECTORS'] === '1') writeFileSync(fixture, text);
    expect(text).toBe(readFileSync(fixture, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
