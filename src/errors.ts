/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ValidationIssue } from './validate.js';

/** Error codes of Rationale errors. */
export type RationaleErrorCode =
  | 'config'
  | 'token'
  | 'validation'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'http'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'payload_too_large'
  | 'response_too_large'
  | 'bad_response'
  | 'queue'
  | 'queue_locked'
  | 'queue_corrupt'
  | 'unsafe_path'
  | 'input';

/**
 * Base class of every error Rationale throws or reports. Messages and
 * properties never contain the API token: errors are built from fixed text,
 * status codes and server messages that pass through {@link redact}.
 */
export class RationaleError extends Error {
  override readonly name: string = 'RationaleError';
  readonly code: RationaleErrorCode;
  /** True when sending again later may succeed. */
  readonly retryable: boolean;
  /** HTTP status, when the error came from a response. */
  readonly status: number | undefined;
  /**
   * True only when the request certainly never reached the server: the
   * connection was never established (DNS failure, connection refused,
   * unreachable host or network, connect timeout) or the TLS handshake
   * failed its certificate checks before any request bytes were sent.
   */
  readonly notSent: boolean;

  constructor(code: RationaleErrorCode, message: string, options: { retryable?: boolean; status?: number; notSent?: boolean } = {}) {
    super(message);
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.notSent = options.notSent ?? false;
  }

  /** A plain, log-safe description. */
  toJSON(): { name: string; code: RationaleErrorCode; message: string; retryable: boolean; status?: number } {
    return { name: this.name, code: this.code, message: this.message, retryable: this.retryable, ...(this.status !== undefined ? { status: this.status } : {}) };
  }
}

/** Thrown by `StatementBuilder.build()` and strict APIs when a statement is invalid. */
export class StatementValidationError extends RationaleError {
  override readonly name = 'StatementValidationError';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super('validation', `Invalid statement of reasons: ${issues.map((i) => `${i.attribute || 'statement'}: ${i.code}`).join('; ')}`);
    this.issues = issues;
  }
}

/** Thrown for invalid client configuration (base URL, environment, token source). */
export class ConfigError extends RationaleError {
  override readonly name = 'ConfigError';
  constructor(message: string) {
    super('config', message);
  }
}

/**
 * Removes every occurrence of the given secrets from a text, and anything
 * that looks like a bearer credential. Used on all server-provided text
 * before it is placed in an error, an event or an outcome.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 4) out = out.split(s).join('[REDACTED]');
  }
  return out.replace(/\b(Bearer)\s+[^\s"',;]+/gi, '$1 [REDACTED]');
}
