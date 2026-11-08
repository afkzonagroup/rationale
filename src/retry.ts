/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/** Retry policy: which failures are retried and how long to wait. Pure functions. */

/** Retry settings. */
export interface RetryOptions {
  /** Total attempts per request, including the first. Default 5. */
  readonly maxAttempts?: number;
  /** Base delay for exponential backoff. Default 500 ms. */
  readonly baseDelayMs?: number;
  /** Upper bound of one backoff delay. Default 30 s. */
  readonly maxDelayMs?: number;
  /** Longest Retry-After the client waits for; longer means give up for now. Default 120 s. */
  readonly maxRetryAfterMs?: number;
}

/** Retry settings with defaults applied. */
export type ResolvedRetry = Required<RetryOptions>;

/** Applies defaults and checks bounds. */
export function resolveRetry(o: RetryOptions = {}): ResolvedRetry {
  const r = {
    maxAttempts: o.maxAttempts ?? 5,
    baseDelayMs: o.baseDelayMs ?? 500,
    maxDelayMs: o.maxDelayMs ?? 30_000,
    maxRetryAfterMs: o.maxRetryAfterMs ?? 120_000,
  };
  if (!Number.isInteger(r.maxAttempts) || r.maxAttempts < 1 || r.maxAttempts > 20) throw new RangeError('retry.maxAttempts must be an integer from 1 to 20.');
  for (const [k, v] of Object.entries(r)) {
    if (!Number.isFinite(v) || v < 0 || v > 3_600_000) throw new RangeError(`retry.${k} must be between 0 and 3600000.`);
  }
  return r;
}

/** HTTP statuses that may succeed when sent again. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** True if a request that ended with this status may be sent again. */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/**
 * Exponential backoff with full jitter: a random delay between 0 and
 * min(maxDelay, base * 2^(attempt-1)). `attempt` starts at 1.
 */
export function backoffDelay(attempt: number, retry: ResolvedRetry, random: () => number): number {
  const cap = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.floor(cap * r);
}

/**
 * Parses a Retry-After header (seconds or an HTTP date) into milliseconds
 * from now. Returns undefined for missing or malformed values.
 */
export function parseRetryAfter(value: string | undefined, nowMs: number): number | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (/^\d{1,10}$/.test(v)) return Number(v) * 1000;
  if (v.length > 64 || !/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(v)) return undefined;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}
