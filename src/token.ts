/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * API token handling. The token comes only from an environment variable or
 * from a function (a secret store). It is never accepted as a plain string
 * option, never logged and never included in errors.
 */

import { RationaleError } from './errors.js';

/** Where the API token comes from. */
export type TokenSource =
  /** Read from this environment variable at request time. */
  | { readonly env: string }
  /** Called at request time, e.g. to read from a secret manager. */
  | (() => string | Promise<string>);

/** Default environment variable for the API token. */
export const DEFAULT_TOKEN_ENV = 'RATIONALE_API_TOKEN';

const MAX_TOKEN_LENGTH = 4096;

/** A token value that cannot be printed by accident. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  /** The secret value. Only the HTTP layer calls this. */
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return '[REDACTED]';
  }
  toJSON(): string {
    return '[REDACTED]';
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'Secret([REDACTED])';
  }
}

/** Checks that a token source has a valid shape (without reading it). */
export function assertTokenSource(source: unknown): asserts source is TokenSource {
  if (typeof source === 'function') return;
  if (typeof source === 'object' && source !== null && !Array.isArray(source)) {
    const env = (source as { env?: unknown }).env;
    if (typeof env === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(env)) return;
  }
  if (typeof source === 'string') {
    throw new RationaleError('token', 'Pass the token as { env: "VARIABLE_NAME" } or as a function that reads a secret store, not as a string.');
  }
  throw new RationaleError('token', 'Invalid token source.');
}

/**
 * Reads the token. Rejects empty tokens and tokens with characters that
 * could break an HTTP header (control characters, non-ASCII).
 */
export async function readToken(source: TokenSource, env: Readonly<Record<string, string | undefined>> = process.env): Promise<Secret> {
  let value: unknown;
  if (typeof source === 'function') {
    try {
      value = await source();
    } catch {
      throw new RationaleError('token', 'The token function failed.');
    }
  } else {
    value = env[source.env];
    if (value === undefined || value === '') throw new RationaleError('token', `Environment variable ${source.env} is not set.`);
  }
  if (typeof value !== 'string') throw new RationaleError('token', 'The token must be a string.');
  const token = value.trim();
  if (token === '' || token.length > MAX_TOKEN_LENGTH || !/^[\x21-\x7e]+$/.test(token)) {
    throw new RationaleError('token', 'The token is empty, too long or contains characters that are not allowed in an HTTP header.');
  }
  return new Secret(token);
}
