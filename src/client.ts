/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The submission client for the DSA Transparency Database API.
 *
 * - Validates every statement before anything is sent.
 * - Sends batches of up to 100 statements (the server limit), split further
 *   by a byte budget.
 * - Uses the PUID as idempotency key: a statement the server already holds
 *   is reported as "duplicate", not as a failure, so retries are safe.
 * - Retries only network errors, timeouts, 408, 425, 429 and 5xx, with
 *   exponential backoff, full jitter and Retry-After.
 * - Limits its own request rate to the server's published limits.
 */

import { resolveBaseUrl, type EndpointOptions } from './config.js';
import { ConfigError, RationaleError, type RationaleErrorCode } from './errors.js';
import type { Statement } from './generated/openapi-types.js';
import { cleanServerText, sendRequest, type FetchLike, type HttpResponse } from './http.js';
import { RateLimiter, systemClock, type Clock } from './rate-limit.js';
import { backoffDelay, isRetryableStatus, parseRetryAfter, resolveRetry, type ResolvedRetry, type RetryOptions } from './retry.js';
import { BATCH_LIMIT, ENDPOINTS, SERVER_PUID_LOCK_SECONDS, SERVER_RATE_LIMITS } from './schema.js';
import { isPlainObject } from './text.js';
import { assertTokenSource, readToken, DEFAULT_TOKEN_ENV, type Secret, type TokenSource } from './token.js';
import { validateStatements, type ValidateOptions, type ValidationIssue, type ValidationWarning } from './validate.js';

/** Events for logging and metrics. They never contain the token or statement text. */
export type ClientEvent =
  | { readonly type: 'request'; readonly endpoint: 'single' | 'batch' | 'existing-puid'; readonly statements: number; readonly attempt: number }
  | { readonly type: 'response'; readonly endpoint: 'single' | 'batch' | 'existing-puid'; readonly status: number }
  | { readonly type: 'retry'; readonly delayMs: number; readonly reason: string; readonly attempt: number }
  | { readonly type: 'split'; readonly from: number; readonly to: number };

/** Client options. */
export interface ClientOptions extends EndpointOptions {
  /** Where the API token comes from. Default `{ env: "RATIONALE_API_TOKEN" }`. Not needed in dry-run mode. */
  readonly token?: TokenSource;
  /** Validate and report, but send nothing. */
  readonly dryRun?: boolean;
  /** Per-request timeout. Default 30 s. */
  readonly timeoutMs?: number;
  /** Largest response body read. Default 8 MiB. */
  readonly maxResponseBytes?: number;
  /** Statements per batch request, 1 to 100. Default 100. */
  readonly batchSize?: number;
  /** Largest batch request body in bytes; batches are split to stay below it. Default 4 MiB. */
  readonly maxBatchBytes?: number;
  readonly retry?: RetryOptions;
  /**
   * Client-side rate limit. Default: the server's limits (200/s and
   * 12,000/min for all calls, 4/s and 240/min for batch calls). `false`
   * turns it off.
   */
  readonly rateLimit?: false | { readonly perSecond?: number; readonly perMinute?: number; readonly batchPerSecond?: number; readonly batchPerMinute?: number };
  /**
   * When the server reports a PUID as already used, confirm it with the
   * existing-PUID endpoint before reporting "duplicate". Default true.
   */
  readonly confirmDuplicates?: boolean;
  /** Validation options (personal-data heuristic). */
  readonly validation?: ValidateOptions;
  /** Event callback for logs and metrics. */
  readonly onEvent?: (event: ClientEvent) => void;
  /** Custom fetch (defaults to the global fetch). */
  readonly fetch?: FetchLike;
  /** Time source, for tests. */
  readonly clock?: Clock;
  /** Random source in [0, 1), for tests. */
  readonly random?: () => number;
  /** Environment variables used for `{ env }` token sources. Default process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Outcome of one statement. */
export type SubmissionOutcome =
  /** Created in the database. */
  | { readonly status: 'created'; readonly index: number; readonly puid: string; readonly uuid?: string; readonly permalink?: string }
  /** The database already holds a statement with this PUID (idempotent success). */
  | { readonly status: 'duplicate'; readonly index: number; readonly puid: string }
  /** Failed local validation; nothing was sent. */
  | { readonly status: 'invalid'; readonly index: number; readonly puid?: string; readonly errors: readonly ValidationIssue[] }
  /** The server rejected the statement as invalid (HTTP 422). Do not resend unchanged. */
  | { readonly status: 'rejected'; readonly index: number; readonly puid: string; readonly serverErrors: Readonly<Record<string, readonly string[]>> }
  /** Could not be submitted. `error.retryable` tells whether a later attempt may succeed. */
  | { readonly status: 'failed'; readonly index: number; readonly puid: string; readonly error: { readonly code: RationaleErrorCode; readonly message: string; readonly retryable: boolean; readonly status?: number } }
  /** Dry run: valid, not sent. */
  | { readonly status: 'validated'; readonly index: number; readonly puid: string; readonly statement: Statement };

/** Result of a submission, one outcome per input in input order. */
export interface SubmissionReport {
  readonly outcomes: readonly SubmissionOutcome[];
  /** Warnings from validation, by input index. */
  readonly warnings: ReadonlyMap<number, readonly ValidationWarning[]>;
  readonly counts: Readonly<Record<SubmissionOutcome['status'], number>>;
  readonly dryRun: boolean;
}

interface Pending {
  readonly index: number;
  readonly statement: Statement;
  readonly json: string;
}

type Finish = (outcome: SubmissionOutcome) => void;

/** The server's PUID lock time plus one second of margin. */
const PUID_LOCK_MS = (SERVER_PUID_LOCK_SECONDS + 1) * 1000;
/** Transport failures after which the request may still be running on the server. */
const AMBIGUOUS_CODES: ReadonlySet<RationaleErrorCode> = new Set(['timeout', 'network', 'aborted']);
/** Statuses after which the request may still be running, or may have died holding its locks. */
const AMBIGUOUS_STATUS: ReadonlySet<number> = new Set([500, 502, 504]);

const DEFAULTS = { timeoutMs: 30_000, maxResponseBytes: 8 * 1024 * 1024, maxBatchBytes: 4 * 1024 * 1024 };

function positiveInt(v: number, name: string, max: number): number {
  if (!Number.isInteger(v) || v < 1 || v > max) throw new ConfigError(`${name} must be an integer from 1 to ${max}.`);
  return v;
}

/** Client for the DSA Transparency Database submission API. */
export class TransparencyClient {
  readonly #base: string | undefined;
  readonly #dryRun: boolean;
  readonly #token: TokenSource | undefined;
  readonly #fetch: FetchLike;
  readonly #clock: Clock;
  readonly #random: () => number;
  readonly #retry: ResolvedRetry;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #batchSize: number;
  readonly #maxBatchBytes: number;
  readonly #confirmDuplicates: boolean;
  readonly #validation: ValidateOptions;
  readonly #onEvent: ((e: ClientEvent) => void) | undefined;
  readonly #env: Readonly<Record<string, string | undefined>> | undefined;
  readonly #apiLimiter: RateLimiter | undefined;
  readonly #batchLimiter: RateLimiter | undefined;
  /** PUIDs sent in a request whose outcome is unknown, with the time until which the server may still lock them. */
  readonly #puidLockedUntil = new Map<string, number>();

  /** Creates a client. Throws ConfigError for unsafe or incomplete configuration. */
  constructor(options: ClientOptions) {
    if (!isPlainObject(options)) throw new ConfigError('Options must be an object.');
    this.#dryRun = options.dryRun === true;
    // The base URL is checked even in dry-run mode, so a dry run proves the configuration.
    this.#base = resolveBaseUrl(options);
    if (!this.#dryRun) {
      const token = options.token ?? { env: DEFAULT_TOKEN_ENV };
      assertTokenSource(token);
      this.#token = token;
    }
    const f: FetchLike | undefined = options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (typeof f !== 'function') throw new ConfigError('No fetch function available. Use Node.js 22 or newer, or pass options.fetch.');
    this.#fetch = f;
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? Math.random;
    this.#retry = resolveRetry(options.retry);
    this.#timeoutMs = positiveInt(options.timeoutMs ?? DEFAULTS.timeoutMs, 'timeoutMs', 600_000);
    this.#maxResponseBytes = positiveInt(options.maxResponseBytes ?? DEFAULTS.maxResponseBytes, 'maxResponseBytes', 256 * 1024 * 1024);
    this.#batchSize = positiveInt(options.batchSize ?? BATCH_LIMIT, 'batchSize', BATCH_LIMIT);
    this.#maxBatchBytes = positiveInt(options.maxBatchBytes ?? DEFAULTS.maxBatchBytes, 'maxBatchBytes', 256 * 1024 * 1024);
    this.#confirmDuplicates = options.confirmDuplicates !== false;
    this.#validation = options.validation ?? {};
    this.#onEvent = options.onEvent;
    this.#env = options.env;
    if (options.rateLimit !== false) {
      const rl = options.rateLimit ?? {};
      this.#apiLimiter = new RateLimiter(
        [
          { limit: positiveInt(rl.perSecond ?? SERVER_RATE_LIMITS.api.perSecond, 'rateLimit.perSecond', 100_000), intervalMs: 1000 },
          { limit: positiveInt(rl.perMinute ?? SERVER_RATE_LIMITS.api.perMinute, 'rateLimit.perMinute', 10_000_000), intervalMs: 60_000 },
        ],
        this.#clock,
      );
      this.#batchLimiter = new RateLimiter(
        [
          { limit: positiveInt(rl.batchPerSecond ?? SERVER_RATE_LIMITS.apiMultiple.perSecond, 'rateLimit.batchPerSecond', 100_000), intervalMs: 1000 },
          { limit: positiveInt(rl.batchPerMinute ?? SERVER_RATE_LIMITS.apiMultiple.perMinute, 'rateLimit.batchPerMinute', 10_000_000), intervalMs: 60_000 },
        ],
        this.#clock,
      );
    }
  }

  /** True when the client never sends anything. */
  get dryRun(): boolean {
    return this.#dryRun;
  }

  /** Submits one statement through the single-statement endpoint. */
  async submit(input: unknown, options: { signal?: AbortSignal } = {}): Promise<SubmissionOutcome> {
    const report = await this.#run([input], 'single', options.signal);
    const outcome = report.outcomes[0];
    if (outcome === undefined) throw new RationaleError('input', 'No outcome.');
    return outcome;
  }

  /**
   * Submits any number of statements through the batch endpoint, in
   * chunks of at most `batchSize` statements and `maxBatchBytes` bytes.
   */
  async submitBatch(inputs: readonly unknown[], options: { signal?: AbortSignal } = {}): Promise<SubmissionReport> {
    if (!Array.isArray(inputs)) throw new RationaleError('input', 'submitBatch expects an array.');
    return this.#run(inputs, 'batch', options.signal);
  }

  /**
   * Asks the server whether a statement with this PUID exists for your
   * platform (GET /api/v1/statement/existing-puid/{puid}).
   */
  async puidExists(puid: string, options: { signal?: AbortSignal } = {}): Promise<boolean> {
    if (this.#dryRun) throw new RationaleError('config', 'puidExists sends a request and is not available in dry-run mode.');
    if (typeof puid !== 'string' || puid.length > 500 || !/^[a-zA-Z0-9_-]+$/.test(puid)) throw new RationaleError('input', 'Invalid PUID.');
    const token = await this.#readToken();
    const res = await this.#withRetry('existing-puid', 0, async () => {
      await this.#apiLimiter?.acquire(options.signal);
      return this.#send('GET', ENDPOINTS.existingPuid.replace('{puid}', encodeURIComponent(puid)), token, undefined, options.signal);
    }, options.signal);
    if (res instanceof RationaleError) throw res;
    if (res.status === 302) return true;
    if (res.status === 404) return false;
    throw this.#httpError(res, token);
  }

  async #readToken(): Promise<Secret> {
    if (this.#token === undefined) throw new RationaleError('token', 'No token source.');
    return readToken(this.#token, this.#env ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {});
  }

  async #run(inputs: readonly unknown[], mode: 'single' | 'batch', signal: AbortSignal | undefined): Promise<SubmissionReport> {
    const outcomes: (SubmissionOutcome | undefined)[] = new Array<SubmissionOutcome | undefined>(inputs.length);
    const warnings = new Map<number, readonly ValidationWarning[]>();
    const pending: Pending[] = [];
    const { results } = validateStatements(inputs, this.#validation);
    results.forEach((r, index) => {
      if (r.warnings.length > 0) warnings.set(index, r.warnings);
      if (!r.ok || r.statement === undefined) {
        const raw = inputs[index];
        const puid = isPlainObject(raw) && typeof raw['puid'] === 'string' ? raw['puid'] : undefined;
        outcomes[index] = { status: 'invalid', index, ...(puid !== undefined ? { puid } : {}), errors: r.errors };
        return;
      }
      if (this.#dryRun) {
        outcomes[index] = { status: 'validated', index, puid: r.statement.puid, statement: r.statement };
        return;
      }
      pending.push({ index, statement: r.statement, json: JSON.stringify(r.statement) });
    });

    if (pending.length > 0) {
      const finish: Finish = (o) => {
        outcomes[o.index] = o;
      };
      let token: Secret | undefined;
      try {
        token = await this.#readToken();
      } catch (e) {
        const error = e instanceof RationaleError ? e : new RationaleError('token', 'Could not read the token.');
        for (const p of pending) finish(this.#failed(p, error));
      }
      if (token !== undefined) {
        if (mode === 'single') {
          for (const p of pending) {
            const stop = await this.#single(p, token, finish, signal);
            if (stop) {
              for (const q of pending) if (outcomes[q.index] === undefined) finish(this.#failed(q, stop));
              break;
            }
          }
        } else {
          for (const chunk of this.#chunks(pending)) {
            const stop = await this.#batch(chunk, token, finish, signal);
            if (stop) {
              for (const p of pending) if (outcomes[p.index] === undefined) finish(this.#failed(p, stop));
              break;
            }
          }
        }
      }
    }

    const final = outcomes.map((o, index): SubmissionOutcome => o ?? { status: 'failed', index, puid: '', error: { code: 'input', message: 'Not processed.', retryable: true } });
    const counts = { created: 0, duplicate: 0, invalid: 0, rejected: 0, failed: 0, validated: 0 };
    for (const o of final) counts[o.status]++;
    return { outcomes: final, warnings, counts, dryRun: this.#dryRun };
  }

  /** Splits pending statements by count and by request size. */
  *#chunks(pending: readonly Pending[]): Generator<Pending[]> {
    const overhead = '{"statements":[]}'.length;
    let chunk: Pending[] = [];
    let bytes = overhead;
    for (const p of pending) {
      const size = new TextEncoder().encode(p.json).byteLength + 1;
      if (chunk.length > 0 && (chunk.length >= this.#batchSize || bytes + size > this.#maxBatchBytes)) {
        yield chunk;
        chunk = [];
        bytes = overhead;
      }
      chunk.push(p);
      bytes += size;
    }
    if (chunk.length > 0) yield chunk;
  }

  #failed(p: Pending, e: RationaleError): SubmissionOutcome {
    return {
      status: 'failed',
      index: p.index,
      puid: p.statement.puid,
      error: { code: e.code, message: e.message, retryable: e.retryable, ...(e.status !== undefined ? { status: e.status } : {}) },
    };
  }

  #emit(e: ClientEvent): void {
    try {
      this.#onEvent?.(e);
    } catch {
      // A failing event handler must not break submission.
    }
  }

  async #send(method: 'GET' | 'POST', path: string, token: Secret, body: string | undefined, signal: AbortSignal | undefined): Promise<HttpResponse> {
    return sendRequest(this.#fetch, {
      method,
      url: `${this.#base ?? ''}${path}`,
      token,
      ...(body !== undefined ? { body } : {}),
      timeoutMs: this.#timeoutMs,
      maxResponseBytes: this.#maxResponseBytes,
      signal,
    });
  }

  /**
   * Waits, once, until no PUID of a new request may still be locked on the
   * server by an earlier request of this client whose outcome is unknown.
   */
  async #waitForPuidLocks(puids: readonly string[], signal: AbortSignal | undefined): Promise<void> {
    if (puids.length === 0 || this.#puidLockedUntil.size === 0) return;
    const now = this.#clock.now();
    let until = 0;
    for (const p of puids) until = Math.max(until, this.#puidLockedUntil.get(p) ?? 0);
    const wait = until - now;
    if (wait <= 0) return;
    this.#emit({ type: 'retry', delayMs: wait, reason: 'puid_lock', attempt: 0 });
    await this.#clock.sleep(wait, signal);
  }

  /** Records the outcome of a POST for its PUIDs: an unknown outcome blocks them for the server's lock time. */
  #notePuidOutcome(puids: readonly string[], ambiguous: boolean): void {
    if (ambiguous) {
      const now = this.#clock.now();
      if (this.#puidLockedUntil.size > 100_000) {
        for (const [p, t] of this.#puidLockedUntil) if (t <= now) this.#puidLockedUntil.delete(p);
      }
      for (const p of puids) this.#puidLockedUntil.set(p, now + PUID_LOCK_MS);
    } else {
      for (const p of puids) this.#puidLockedUntil.delete(p);
    }
  }

  /**
   * Runs a request with retries. Returns the final response (any status
   * that is not retryable, or the last retryable one), or the final
   * transport error.
   *
   * For statement submissions (`puids` given), an attempt whose outcome is
   * unknown (timeout, connection failure after connecting, abort, 500, 502,
   * 504) may still be
   * running on the server and holding its PUID locks. Sending the same PUIDs
   * again while the lock is held makes the batch endpoint record them as
   * existing for two days even if the first request then fails, so the
   * next attempt waits until the server's lock has expired.
   */
  async #withRetry(
    endpoint: 'single' | 'batch' | 'existing-puid',
    statements: number,
    attemptFn: () => Promise<HttpResponse>,
    signal: AbortSignal | undefined,
    puids: readonly string[] = [],
  ): Promise<HttpResponse | RationaleError> {
    try {
      await this.#waitForPuidLocks(puids, signal);
    } catch {
      return new RationaleError('aborted', 'The request was aborted.');
    }
    for (let attempt = 1; ; attempt++) {
      this.#emit({ type: 'request', endpoint, statements, attempt });
      let result: HttpResponse | RationaleError;
      try {
        result = await attemptFn();
        this.#emit({ type: 'response', endpoint, status: result.status });
      } catch (e) {
        if (e instanceof RationaleError) result = e;
        else if (signal?.aborted === true) result = new RationaleError('aborted', 'The request was aborted.');
        else result = new RationaleError('network', 'Unexpected transport error.', { retryable: true });
      }
      const ambiguous = result instanceof RationaleError ? AMBIGUOUS_CODES.has(result.code) && !result.notSent : AMBIGUOUS_STATUS.has(result.status);
      // A request that never reached the server changes nothing about the server's locks.
      if (puids.length > 0 && !(result instanceof RationaleError && result.notSent)) this.#notePuidOutcome(puids, ambiguous);
      const retryable = result instanceof RationaleError ? result.retryable : isRetryableStatus(result.status);
      if (!retryable || attempt >= this.#retry.maxAttempts || signal?.aborted === true) return result;
      let delay = backoffDelay(attempt, this.#retry, this.#random);
      if (!(result instanceof RationaleError)) {
        const after = parseRetryAfter(result.retryAfter, this.#clock.now());
        if (after !== undefined) {
          if (after > this.#retry.maxRetryAfterMs) return result;
          delay = Math.max(delay, after);
        }
      }
      if (puids.length > 0 && ambiguous) delay = Math.max(delay, PUID_LOCK_MS);
      this.#emit({ type: 'retry', delayMs: delay, reason: result instanceof RationaleError ? result.code : `HTTP ${result.status}`, attempt });
      try {
        await this.#clock.sleep(delay, signal);
      } catch {
        return new RationaleError('aborted', 'The request was aborted.');
      }
    }
  }

  #httpError(res: HttpResponse, token: Secret): RationaleError {
    const status = res.status;
    const message = this.#serverMessage(res, token);
    if (status === 401) return new RationaleError('unauthorized', 'The API token was not accepted (HTTP 401). Generate a new token in your profile.', { status });
    if (status === 403) return new RationaleError('forbidden', 'The account may not create statements (HTTP 403).', { status });
    if (status === 413) return new RationaleError('payload_too_large', 'The request body is too large for the server (HTTP 413).', { status });
    if (status === 429) return new RationaleError('rate_limited', 'Rate limit reached (HTTP 429).', { status, retryable: true });
    if (status >= 300 && status < 400) return new RationaleError('http', `Unexpected redirect (HTTP ${status}); redirects are never followed.`, { status });
    return new RationaleError('http', `HTTP ${status}${message ? `: ${message}` : ''}`, { status, retryable: isRetryableStatus(status) });
  }

  #serverMessage(res: HttpResponse, token: Secret): string {
    const m = isRecord(res.json) && typeof res.json['message'] === 'string' ? res.json['message'] : res.text;
    return cleanServerText(m.slice(0, 300), [token.reveal()]);
  }

  /** Confirms server-reported duplicates; returns the PUIDs that really exist. */
  async #confirm(puids: readonly string[], token: Secret, signal: AbortSignal | undefined): Promise<Set<string>> {
    if (!this.#confirmDuplicates) return new Set(puids);
    const confirmed = new Set<string>();
    for (const puid of puids) {
      const res = await this.#withRetry('existing-puid', 0, async () => {
        await this.#apiLimiter?.acquire(signal);
        return this.#send('GET', ENDPOINTS.existingPuid.replace('{puid}', encodeURIComponent(puid)), token, undefined, signal);
      }, signal);
      if (!(res instanceof RationaleError) && res.status === 302) confirmed.add(puid);
    }
    return confirmed;
  }

  /** Sends one statement. Returns an error when further statements should not be tried. */
  async #single(p: Pending, token: Secret, finish: Finish, signal: AbortSignal | undefined): Promise<RationaleError | undefined> {
    for (let round = 0; round < this.#retry.maxAttempts; round++) {
      const res = await this.#withRetry('single', 1, async () => {
        await this.#apiLimiter?.acquire(signal);
        return this.#send('POST', ENDPOINTS.single, token, p.json, signal);
      }, signal, [p.statement.puid]);
      if (res instanceof RationaleError) {
        finish(this.#failed(p, res));
        return res.code === 'aborted' || res.code === 'network' || res.code === 'timeout' ? res : undefined;
      }
      if (res.status === 201) {
        finish(created(p, isRecord(res.json) ? res.json : undefined));
        return undefined;
      }
      if (res.status === 422) {
        if (isPuidConflict(res.json)) {
          const ok = await this.#confirm([p.statement.puid], token, signal);
          if (ok.has(p.statement.puid)) {
            finish({ status: 'duplicate', index: p.index, puid: p.statement.puid });
            return undefined;
          }
          // Reported as in use but not found: another request may hold the PUID lock. Try again.
          await this.#pause(round + 1, signal);
          continue;
        }
        finish({ status: 'rejected', index: p.index, puid: p.statement.puid, serverErrors: serverErrors(res.json, token) });
        return undefined;
      }
      const e = this.#httpError(res, token);
      finish(this.#failed(p, e));
      return e.code === 'unauthorized' || e.code === 'forbidden' ? e : undefined;
    }
    finish(this.#failed(p, new RationaleError('http', 'The server reported the PUID as in use, but it was not found. Try again later.', { retryable: true, status: 422 })));
    return undefined;
  }

  async #pause(attempt: number, signal: AbortSignal | undefined): Promise<void> {
    const delay = backoffDelay(attempt, this.#retry, this.#random);
    this.#emit({ type: 'retry', delayMs: delay, reason: 'puid_conflict', attempt });
    await this.#clock.sleep(delay, signal).catch(() => undefined);
  }

  /**
   * Sends one chunk. Removes duplicates and server-rejected statements and
   * resends the rest, because the server creates none of a batch when any
   * statement fails. Returns an error when further chunks should not be
   * tried (authentication, permission).
   */
  async #batch(chunk: readonly Pending[], token: Secret, finish: Finish, signal: AbortSignal | undefined): Promise<RationaleError | undefined> {
    let rest = [...chunk];
    let conflictRounds = 0;
    while (rest.length > 0) {
      const body = `{"statements":[${rest.map((p) => p.json).join(',')}]}`;
      const sent = rest;
      const res = await this.#withRetry('batch', sent.length, async () => {
        await this.#apiLimiter?.acquire(signal);
        await this.#batchLimiter?.acquire(signal);
        return this.#send('POST', ENDPOINTS.batch, token, body, signal);
      }, signal, sent.map((p) => p.statement.puid));
      if (res instanceof RationaleError) {
        for (const p of sent) finish(this.#failed(p, res));
        // Connection-level failures affect every chunk: stop instead of waiting through each one.
        return res.code === 'aborted' || res.code === 'network' || res.code === 'timeout' ? res : undefined;
      }
      if (res.status === 201) {
        const list = isRecord(res.json) && Array.isArray(res.json['statements']) ? res.json['statements'] : [];
        const byPuid = new Map<string, Record<string, unknown>>();
        for (const s of list) if (isRecord(s) && typeof s['puid'] === 'string') byPuid.set(s['puid'], s);
        for (const p of sent) finish(created(p, byPuid.get(p.statement.puid)));
        return undefined;
      }
      if (res.status === 413 && sent.length > 1) {
        const half = Math.ceil(sent.length / 2);
        this.#emit({ type: 'split', from: sent.length, to: half });
        const first = await this.#batch(sent.slice(0, half), token, finish, signal);
        if (first) return first;
        return this.#batch(sent.slice(half), token, finish, signal);
      }
      if (res.status === 422) {
        const json = res.json;
        if (isPuidConflict(json)) {
          const reported = existingPuids(json);
          const known = new Set(sent.map((p) => p.statement.puid));
          const confirmed = await this.#confirm(reported.filter((x) => known.has(x)), token, signal);
          if (confirmed.size > 0) {
            for (const p of sent) if (confirmed.has(p.statement.puid)) finish({ status: 'duplicate', index: p.index, puid: p.statement.puid });
            rest = sent.filter((p) => !confirmed.has(p.statement.puid));
            continue;
          }
          if (++conflictRounds >= this.#retry.maxAttempts) {
            const e = new RationaleError('http', 'The server reported PUIDs as in use, but they were not found. Try again later.', { retryable: true, status: 422 });
            for (const p of sent) finish(this.#failed(p, e));
            return undefined;
          }
          await this.#pause(conflictRounds, signal);
          continue;
        }
        const perStatement = batchErrors(json, token);
        const matched = [...perStatement.keys()].filter((i) => i < sent.length);
        if (matched.length > 0) {
          for (const i of matched) {
            const p = sent[i];
            const errors = perStatement.get(i);
            if (p && errors) finish({ status: 'rejected', index: p.index, puid: p.statement.puid, serverErrors: errors });
          }
          // The others were not created either; send them again without the rejected ones.
          rest = sent.filter((_, i) => !perStatement.has(i));
          continue;
        }
        const errors = serverErrors(json, token);
        for (const p of sent) finish({ status: 'rejected', index: p.index, puid: p.statement.puid, serverErrors: errors });
        return undefined;
      }
      const e = this.#httpError(res, token);
      for (const p of sent) finish(this.#failed(p, e));
      return e.code === 'unauthorized' || e.code === 'forbidden' ? e : undefined;
    }
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function created(p: Pending, body: Record<string, unknown> | undefined): SubmissionOutcome {
  const uuid = body && typeof body['uuid'] === 'string' && /^[0-9a-f-]{36}$/i.test(body['uuid']) ? body['uuid'] : undefined;
  const permalink = body && typeof body['permalink'] === 'string' && body['permalink'].length <= 2048 && /^https?:\/\//.test(body['permalink']) ? body['permalink'] : undefined;
  return { status: 'created', index: p.index, puid: p.statement.puid, ...(uuid !== undefined ? { uuid } : {}), ...(permalink !== undefined ? { permalink } : {}) };
}

/** True for the server's "PUID not unique" responses (single and batch). */
function isPuidConflict(json: unknown): boolean {
  if (!isRecord(json) || !isRecord(json['errors'])) return false;
  const puid = json['errors']['puid'];
  if (!Array.isArray(puid)) return false;
  return puid.some((m) => typeof m === 'string' && /not (all )?unique/i.test(m)) && (Array.isArray(json['errors']['existing_puids']) || isRecord(json['existing']) || Object.keys(json['errors']).length === 1);
}

function existingPuids(json: unknown): string[] {
  if (!isRecord(json) || !isRecord(json['errors']) || !Array.isArray(json['errors']['existing_puids'])) return [];
  return json['errors']['existing_puids'].filter((x): x is string => typeof x === 'string').slice(0, 1000);
}

function messages(v: unknown, token: Secret): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((m): m is string => typeof m === 'string')
    .slice(0, 20)
    .map((m) => cleanServerText(m.slice(0, 500), [token.reveal()]));
}

/** Field errors of a single-statement 422 response. */
function serverErrors(json: unknown, token: Secret): Record<string, readonly string[]> {
  const out = Object.create(null) as Record<string, readonly string[]>;
  if (!isRecord(json) || !isRecord(json['errors'])) {
    out[''] = ['The server rejected the request (HTTP 422) without details.'];
    return out;
  }
  for (const [k, v] of Object.entries(json['errors']).slice(0, 100)) {
    if (/^[a-z_.0-9-]{1,100}$/i.test(k)) out[k] = messages(v, token);
  }
  return out;
}

/** Per-statement errors of a batch 422 response (`errors.statement_N`). */
function batchErrors(json: unknown, token: Secret): Map<number, Record<string, readonly string[]>> {
  const out = new Map<number, Record<string, readonly string[]>>();
  if (!isRecord(json) || !isRecord(json['errors'])) return out;
  for (const [k, v] of Object.entries(json['errors'])) {
    const m = /^statement_(\d{1,3})$/.exec(k);
    if (!m || !isRecord(v)) continue;
    const fields = Object.create(null) as Record<string, readonly string[]>;
    for (const [f, msgs] of Object.entries(v).slice(0, 100)) {
      if (/^[a-z_.0-9-]{1,100}$/i.test(f)) fields[f] = messages(msgs, token);
    }
    out.set(Number(m[1]), fields);
  }
  return out;
}
