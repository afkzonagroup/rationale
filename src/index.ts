/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rationale: submit statements of reasons to the DSA Transparency Database
 * (Article 24(5) of Regulation (EU) 2022/2065). Zero runtime dependencies;
 * uses the global fetch.
 *
 * @packageDocumentation
 */

export { StatementBuilder, statement, type DateInput } from './builder.js';
export { TransparencyClient, type ClientEvent, type ClientOptions, type SubmissionOutcome, type SubmissionReport } from './client.js';
export { resolveBaseUrl, type EndpointOptions, type Environment } from './config.js';
export { ConfigError, RationaleError, StatementValidationError, redact, type RationaleErrorCode } from './errors.js';
export type * from './generated/openapi-types.js';
export { findPersonalData, type PersonalDataKind } from './personal-data.js';
export { drainQueue, enqueueStatements, type DrainOptions, type DrainReport, type EnqueueReport } from './queue/drain.js';
export { MemoryQueueStore } from './queue/memory.js';
export type { QueueEntry, QueueEntryState, QueueStats, QueueStore, QueueUpdate } from './queue/state.js';
export { RateLimiter, systemClock, type Clock, type RateWindow } from './rate-limit.js';
export { backoffDelay, isRetryableStatus, parseRetryAfter, type RetryOptions } from './retry.js';
export {
  ATTRIBUTES,
  ATTRIBUTE_NAMES,
  BATCH_LIMIT,
  DECISION_GROUP,
  ENDPOINTS,
  PRODUCTION_BASE_URL,
  SCHEMA_SOURCE,
  SCHEMA_VERSION,
  SERVER_PUID_LOCK_SECONDS,
  SERVER_RATE_LIMITS,
  TERRITORIAL_PRESETS,
  attributeSpec,
  type AttributeCondition,
  type AttributeSpec,
} from './schema.js';
export { toIsoDate } from './text.js';
export { DEFAULT_TOKEN_ENV, type TokenSource } from './token.js';
export {
  validateStatement,
  validateStatements,
  type BatchValidationResult,
  type ErrorCode,
  type ValidateOptions,
  type ValidationIssue,
  type ValidationResult,
  type ValidationWarning,
  type WarningCode,
} from './validate.js';
export { VERSION } from './version.js';
