/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/** Moving statements between a queue store and the API. */

import type { SubmissionOutcome, TransparencyClient } from '../client.js';
import { validateStatements, type ValidateOptions, type ValidationResult } from '../validate.js';
import type { QueueStore, QueueUpdate } from './state.js';

/** Result of enqueueing. */
export interface EnqueueReport {
  /** PUIDs added to the queue. */
  readonly added: readonly string[];
  /** PUIDs already known to the queue (pending, done or rejected). */
  readonly skipped: readonly string[];
  /** Inputs that failed validation, by input index. Nothing was queued for them. */
  readonly invalid: ReadonlyMap<number, ValidationResult>;
}

/** Validates inputs and adds the valid ones to the queue. */
export async function enqueueStatements(store: QueueStore, inputs: readonly unknown[], options: ValidateOptions = {}): Promise<EnqueueReport> {
  const { results } = validateStatements(inputs, options);
  const invalid = new Map<number, ValidationResult>();
  const valid = results.flatMap((r, i) => {
    if (r.ok && r.statement !== undefined) return [r.statement];
    invalid.set(i, r);
    return [];
  });
  const { added, skipped } = await store.add(valid);
  return { added, skipped, invalid };
}

/** Result of draining a queue. */
export interface DrainReport {
  readonly created: number;
  readonly duplicate: number;
  readonly rejected: number;
  readonly failed: number;
  /** Batch calls made (rounds of up to `pageSize` statements). */
  readonly rounds: number;
  /** Why draining stopped. */
  readonly stoppedBecause: 'empty' | 'only_failures' | 'fatal_error' | 'max_rounds' | 'aborted' | 'dry_run';
}

/** Options for draining. */
export interface DrainOptions {
  /** Statements read from the store per round. Default 500 (sent in chunks of the client's batch size). */
  readonly pageSize?: number;
  /** Stop after this many rounds. Default unlimited. */
  readonly maxRounds?: number;
  readonly signal?: AbortSignal;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function toUpdate(o: SubmissionOutcome, puid: string): QueueUpdate | undefined {
  switch (o.status) {
    case 'created':
      return { puid, result: 'done', ...(o.uuid !== undefined ? { uuid: o.uuid } : {}), duplicate: false };
    case 'duplicate':
      return { puid, result: 'done', duplicate: true };
    case 'rejected':
      return { puid, result: 'rejected', reason: Object.entries(o.serverErrors).map(([k, v]) => `${k}: ${v.join(' ')}`).join('; ') || 'Rejected by the server.' };
    case 'invalid':
      return { puid, result: 'rejected', reason: o.errors.map((e) => `${e.attribute}: ${e.code}`).join('; ') };
    case 'failed':
      return { puid, result: 'failed', reason: `${o.error.code}: ${o.error.message}` };
    case 'validated':
      return undefined;
  }
}

/**
 * Sends pending statements until the queue is empty or no progress is
 * possible. Each statement is tried at most once per call; failed ones stay
 * pending for the next call. Stops early on authentication or permission
 * errors.
 */
export async function drainQueue(client: TransparencyClient, store: QueueStore, options: DrainOptions = {}): Promise<DrainReport> {
  const pageSize = options.pageSize ?? 500;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10_000) throw new RangeError('pageSize must be an integer from 1 to 10000.');
  const tried = new Set<string>();
  const totals = { created: 0, duplicate: 0, rejected: 0, failed: 0 };
  let rounds = 0;
  const report = (stoppedBecause: DrainReport['stoppedBecause']): DrainReport => ({ ...totals, rounds, stoppedBecause });

  for (;;) {
    if (isAborted(options.signal)) return report('aborted');
    if (options.maxRounds !== undefined && rounds >= options.maxRounds) return report('max_rounds');
    const page = await store.pending(pageSize, tried);
    if (page.length === 0) return report('empty');
    const statements = page.flatMap((e) => (e.statement ? [e.statement] : []));
    for (const e of page) tried.add(e.puid);
    rounds++;
    const result = await client.submitBatch(statements, options.signal ? { signal: options.signal } : {});
    if (result.dryRun) return report('dry_run');
    const updates: QueueUpdate[] = [];
    let progress = false;
    let fatal = false;
    for (const [i, o] of result.outcomes.entries()) {
      const puid = statements[i]?.puid;
      if (puid === undefined) continue;
      const u = toUpdate(o, puid);
      if (!u) continue;
      updates.push(u);
      if (o.status === 'created') totals.created++;
      else if (o.status === 'duplicate') totals.duplicate++;
      else if (o.status === 'rejected' || o.status === 'invalid') totals.rejected++;
      else if (o.status === 'failed') {
        totals.failed++;
        if (o.error.code === 'unauthorized' || o.error.code === 'forbidden' || o.error.code === 'token' || o.error.code === 'aborted') fatal = true;
      }
      if (o.status !== 'failed') progress = true;
    }
    await store.settle(updates);
    if (fatal) return report(isAborted(options.signal) ? 'aborted' : 'fatal_error');
    if (!progress) return report('only_failures');
  }
}
