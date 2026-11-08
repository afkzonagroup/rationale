/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client-side rate limiting with sliding windows. One limiter belongs to one
 * client instance (one application), never to one request, so concurrent
 * calls share the budget.
 */

/** A limit of `limit` requests per `intervalMs`. */
export interface RateWindow {
  readonly limit: number;
  readonly intervalMs: number;
}

/** Time functions, replaceable in tests. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Real time. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error('aborted'));
        return;
      }
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(t);
        reject(new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

/** Sliding-window limiter over one or more windows. */
export class RateLimiter {
  readonly #windows: readonly RateWindow[];
  readonly #clock: Clock;
  readonly #stamps: number[] = [];
  #queue: Promise<void> = Promise.resolve();

  constructor(windows: readonly RateWindow[], clock: Clock = systemClock) {
    for (const w of windows) {
      if (!Number.isInteger(w.limit) || w.limit < 1 || !Number.isFinite(w.intervalMs) || w.intervalMs <= 0) {
        throw new RangeError('Rate windows need a positive integer limit and a positive interval.');
      }
    }
    this.#windows = windows;
    this.#clock = clock;
  }

  /** Milliseconds to wait before one more request fits all windows. */
  delay(): number {
    const now = this.#clock.now();
    let wait = 0;
    for (const w of this.#windows) {
      const inWindow = this.#stamps.filter((t) => t > now - w.intervalMs);
      if (inWindow.length >= w.limit) {
        const oldest = inWindow[inWindow.length - w.limit] ?? now;
        wait = Math.max(wait, oldest + w.intervalMs - now);
      }
    }
    return wait;
  }

  /** Waits until one more request is allowed, then records it. Calls are served in order. */
  acquire(signal?: AbortSignal): Promise<void> {
    const run = this.#queue.then(async () => {
      for (;;) {
        const wait = this.delay();
        if (wait <= 0) break;
        await this.#clock.sleep(wait, signal);
      }
      const now = this.#clock.now();
      this.#stamps.push(now);
      const longest = Math.max(0, ...this.#windows.map((w) => w.intervalMs));
      while (this.#stamps.length > 0 && (this.#stamps[0] ?? now) <= now - longest) this.#stamps.shift();
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
