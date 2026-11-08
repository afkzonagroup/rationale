/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The only place that talks to the network. Uses the global fetch (or one
 * passed in), never follows redirects, caps response size and time, and
 * parses JSON into prototype-free objects.
 */

import { RationaleError, redact } from './errors.js';
import type { Secret } from './token.js';
import { VERSION } from './version.js';

/** The fetch function signature Rationale needs. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** One HTTP request. */
export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly token: Secret;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal | undefined;
}

/** A received response with a bounded, parsed body. */
export interface HttpResponse {
  readonly status: number;
  /** Retry-After header value, if any. */
  readonly retryAfter: string | undefined;
  /** Parsed JSON body (null-prototype objects), or undefined if the body was not JSON. */
  readonly json: unknown;
  /** The first 500 characters of a non-JSON body, token-redacted. */
  readonly text: string;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 64;

/**
 * Copies parsed JSON into objects without a prototype, dropping keys that
 * could pollute prototypes when a caller merges the result. Depth is capped.
 */
export function sanitizeJson(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new RationaleError('bad_response', 'The response is nested too deeply.');
  if (Array.isArray(value)) return value.map((v: unknown) => sanitizeJson(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value)) {
      if (!FORBIDDEN_KEYS.has(k)) out[k] = sanitizeJson(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Parses JSON text safely: returns undefined on syntax errors and on nesting deeper than 64 levels. */
export function parseJsonSafe(text: string): unknown {
  try {
    return sanitizeJson(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Makes server-provided text safe to log or print: removes the token and
 * bearer values, and replaces control characters (including terminal escape
 * sequences) with spaces.
 */
export function cleanServerText(text: string, secrets: readonly string[]): string {
  return Array.from(redact(text, secrets), (c) => {
    const n = c.charCodeAt(0);
    return n < 0x20 || (n >= 0x7f && n <= 0x9f) ? ' ' : c;
  }).join('');
}

async function readBounded(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    throw new RationaleError('response_too_large', `The response is larger than ${max} bytes.`, { status: response.status });
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new RationaleError('response_too_large', `The response is larger than ${max} bytes.`, { status: response.status });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Error codes of failures before a connection existed: nothing can have reached the server. */
const NOT_CONNECTED_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * Certificate checks fail during the TLS handshake, before the request is
 * written. (Other TLS errors can happen later on a connection and are not
 * listed.)
 */
const TLS_HANDSHAKE_CODES: ReadonlySet<string> = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'HOSTNAME_MISMATCH',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

function errorCode(e: unknown): string | undefined {
  if (e === null || typeof e !== 'object') return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * True when a fetch failure certainly happened before the connection was
 * established, judged from the error's cause as Node.js fetch reports it
 * (`TypeError("fetch failed", { cause })`, or an AggregateError when several
 * addresses were tried). Anything else, including a fetch that hides the
 * cause, counts as "may have been sent".
 */
export function failedBeforeSending(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const cause = (error as { cause?: unknown }).cause;
  if (cause === null || typeof cause !== 'object') return false;
  const errors = (cause as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.every((x) => {
      const c = errorCode(x);
      return c !== undefined && NOT_CONNECTED_CODES.has(c);
    });
  }
  const code = errorCode(cause);
  return code !== undefined && (NOT_CONNECTED_CODES.has(code) || TLS_HANDSHAKE_CODES.has(code));
}

/**
 * Sends one request. Throws RationaleError with code "network", "timeout",
 * "aborted" or "response_too_large"; returns every HTTP status as a response.
 */
export async function sendRequest(fetchFn: FetchLike, req: HttpRequest): Promise<HttpResponse> {
  const timeout = AbortSignal.timeout(req.timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${req.token.reveal()}`,
    'User-Agent': `rationale/${VERSION}`,
  };
  let response: Response;
  try {
    response = await fetchFn(req.url, {
      method: req.method,
      headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal,
    });
  } catch (e) {
    // The original error is dropped on purpose: it can carry request details.
    if (req.signal?.aborted === true) throw new RationaleError('aborted', 'The request was aborted.');
    if (timeout.aborted) throw new RationaleError('timeout', `No response within ${req.timeoutMs} ms.`, { retryable: true });
    if (failedBeforeSending(e)) {
      throw new RationaleError('network', 'Could not connect to the server; nothing was sent (network error).', { retryable: true, notSent: true });
    }
    throw new RationaleError('network', 'The request failed before a response arrived (network error).', { retryable: true });
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBounded(response, req.maxResponseBytes);
  } catch (e) {
    if (e instanceof RationaleError) throw e;
    if (req.signal?.aborted === true) throw new RationaleError('aborted', 'The request was aborted.');
    if (timeout.aborted) throw new RationaleError('timeout', `The response did not complete within ${req.timeoutMs} ms.`, { retryable: true });
    throw new RationaleError('network', 'The connection failed while reading the response.', { retryable: true });
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const contentType = response.headers.get('content-type') ?? '';
  const json = /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType) ? parseJsonSafe(text) : undefined;
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after') ?? undefined,
    json,
    text: json === undefined ? cleanServerText(text.slice(0, 500), [req.token.reveal()]) : '',
  };
}
