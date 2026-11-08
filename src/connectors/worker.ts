/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A background worker that drains a queue store on an interval. Runs never
 * overlap; after a round that made no progress the next run waits longer
 * (up to `maxIntervalMs`), so an API outage does not turn into a busy loop.
 */

import type { TransparencyClient } from '../client.js';
import { drainQueue, type DrainReport } from '../queue/drain.js';
import type { QueueStore } from '../queue/state.js';

/** Options for {@link startQueueWorker}. */
export interface WorkerOptions {
  readonly client: TransparencyClient;
  readonly store: QueueStore;
  /** Time between runs when the queue drains normally. Default 10 s. */
  readonly intervalMs?: number;
  /** Longest wait after repeated failures. Default 5 min. */
  readonly maxIntervalMs?: number;
  readonly onReport?: (report: DrainReport) => void;
  readonly onError?: (error: unknown) => void;
}

/** A running worker. */
export interface QueueWorker {
  /** Runs one drain now (or waits for the current run) and returns its report. */
  runNow(): Promise<DrainReport | undefined>;
  /** Stops the worker and waits for a running drain to finish. */
  stop(): Promise<void>;
}

/** Starts a worker. */
export function startQueueWorker(options: WorkerOptions): QueueWorker {
  const base = options.intervalMs ?? 10_000;
  const maxInterval = options.maxIntervalMs ?? 300_000;
  if (!(base > 0) || !(maxInterval >= base)) throw new RangeError('intervalMs must be positive and maxIntervalMs at least intervalMs.');
  const controller = new AbortController();
  let delay = base;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<DrainReport | undefined> | undefined;
  let stopped = false;

  const run = (): Promise<DrainReport | undefined> => {
    if (running) return running;
    running = (async () => {
      try {
        const report = await drainQueue(options.client, options.store, { signal: controller.signal });
        delay = report.stoppedBecause === 'only_failures' || report.stoppedBecause === 'fatal_error' ? Math.min(maxInterval, delay * 2) : base;
        options.onReport?.(report);
        return report;
      } catch (e) {
        delay = Math.min(maxInterval, delay * 2);
        options.onError?.(e);
        return undefined;
      } finally {
        running = undefined;
        schedule();
      }
    })();
    return running;
  };

  const schedule = (): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), delay);
    timer.unref();
  };

  schedule();
  return {
    runNow: run,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller.abort();
      await running;
    },
  };
}
