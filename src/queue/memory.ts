/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Statement } from '../generated/openapi-types.js';
import { RationaleError } from '../errors.js';
import { validateStatement } from '../validate.js';
import { QueueState, checkLimit, updateToEvent, type QueueEntry, type QueueStats, type QueueStore, type QueueUpdate } from './state.js';

/** Runs a synchronous function and returns its result or error as a promise. */
function settled<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * A queue store in memory. Statements are lost when the process ends; use
 * JsonlQueueStore (from "@afkzona/rationale/node") to survive restarts.
 */
export class MemoryQueueStore implements QueueStore {
  readonly #state = new QueueState();
  readonly #now: () => Date;
  #closed = false;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  #open(): void {
    if (this.#closed) throw new RationaleError('queue', 'The queue store is closed.');
  }

  add(statements: readonly Statement[]): Promise<{ added: string[]; skipped: string[] }> {
    return settled(() => this.#add(statements));
  }

  #add(statements: readonly Statement[]): { added: string[]; skipped: string[] } {
    this.#open();
    const added: string[] = [];
    const skipped: string[] = [];
    const at = this.#now().toISOString();
    for (const s of statements) {
      const r = validateStatement(s, { personalData: 'off' });
      if (!r.ok || r.statement === undefined) throw new RationaleError('queue', 'Only valid statements can be queued. Validate before adding.');
      const puid = r.statement.puid;
      if (this.#state.has(puid)) {
        skipped.push(puid);
        continue;
      }
      this.#state.apply({ v: 1, op: 'add', at, puid, statement: r.statement });
      added.push(puid);
    }
    return { added, skipped };
  }

  pending(limit: number, exclude?: ReadonlySet<string>): Promise<QueueEntry[]> {
    return settled(() => {
      this.#open();
      checkLimit(limit);
      return this.#state.pending(limit, exclude);
    });
  }

  settle(updates: readonly QueueUpdate[]): Promise<void> {
    return settled(() => {
      this.#open();
      const at = this.#now().toISOString();
      for (const u of updates) {
        const e = updateToEvent(this.#state, u, at);
        if (e) this.#state.apply(e);
      }
    });
  }

  stats(): Promise<QueueStats> {
    return settled(() => {
      this.#open();
      return this.#state.stats();
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}
