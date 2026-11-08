/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A framework-agnostic intake: takes a parsed request body with one
 * statement or `{ "statements": [...] }`, validates it and puts the valid
 * statements into a queue store. A worker sends them later, so a moderation
 * system never waits for, or depends on, the Commission's API.
 */

import { enqueueStatements } from '../queue/drain.js';
import type { QueueStore } from '../queue/state.js';
import { isPlainObject } from '../text.js';
import type { ValidateOptions, ValidationIssue, ValidationWarning } from '../validate.js';

/** Response produced by the intake: an HTTP status and a JSON body. */
export interface IntakeResponse {
  readonly status: 200 | 202 | 400 | 422;
  readonly body: Readonly<Record<string, unknown>>;
}

/** Options for the intake. */
export interface IntakeOptions {
  readonly store: QueueStore;
  readonly validation?: ValidateOptions;
  /** Most statements per request. Default 1000. */
  readonly maxStatements?: number;
}

/** The intake function. */
export type Intake = (body: unknown) => Promise<IntakeResponse>;

/** Creates an intake bound to a queue store. */
export function createIntake(options: IntakeOptions): Intake {
  const max = options.maxStatements ?? 1000;
  if (!Number.isInteger(max) || max < 1 || max > 100_000) throw new RangeError('maxStatements must be an integer from 1 to 100000.');
  return async (body: unknown): Promise<IntakeResponse> => {
    let inputs: unknown[];
    if (isPlainObject(body) && Object.keys(body).length === 1 && Array.isArray(body['statements'])) inputs = body['statements'] as unknown[];
    else if (isPlainObject(body)) inputs = [body];
    else return { status: 400, body: { error: 'The body must be a statement object or {"statements": [...]}.' } };
    if (inputs.length === 0 || inputs.length > max) return { status: 400, body: { error: `Send between 1 and ${max} statements.` } };
    const report = await enqueueStatements(options.store, inputs, options.validation);
    const invalid: { index: number; errors: readonly ValidationIssue[]; warnings: readonly ValidationWarning[] }[] = [];
    for (const [index, r] of report.invalid) invalid.push({ index, errors: r.errors, warnings: r.warnings });
    const accepted = report.added.length + report.skipped.length;
    const status = invalid.length === 0 ? 202 : accepted > 0 ? 200 : 422;
    return { status, body: { queued: report.added, alreadyKnown: report.skipped, invalid } };
  };
}
