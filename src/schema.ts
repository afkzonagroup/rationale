/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Typed access to the statement of reasons schema of the DSA Transparency
 * Database. The data is generated from the official source code; see
 * `schema/statement-schema.json` and `scripts/generate.ts`.
 *
 * @packageDocumentation
 */

import { SCHEMA } from './generated/schema.js';

/** A condition on another attribute: equal to a value, or a list containing a value. */
export interface AttributeCondition {
  readonly attribute: string;
  readonly equals?: string;
  readonly contains?: string;
}

/** How one attribute is checked. */
export interface AttributeSpec {
  readonly kind: 'text' | 'url' | 'date' | 'enum' | 'enum-list' | 'content-id';
  readonly label: string;
  /** DSA provisions (Regulation (EU) 2022/2065) the attribute serves, e.g. "17(3)(b)". */
  readonly law: readonly string[];
  readonly required?: boolean;
  /** Maximum length in Unicode code points (text and URL attributes). */
  readonly max?: number;
  readonly pattern?: string;
  /** Earliest allowed date, inclusive (date attributes). */
  readonly earliest?: string;
  /** Latest allowed date, inclusive (date attributes). */
  readonly latest?: string;
  /** Allowed values (enumerations). */
  readonly values?: readonly string[];
  /** Human labels of enumeration values, as shown in the Commission's webform. */
  readonly labels?: Readonly<Record<string, string>>;
  readonly requiredWhen?: AttributeCondition;
  readonly excludedUnless?: AttributeCondition;
  readonly excludedWhen?: AttributeCondition;
  readonly keys?: Readonly<Record<string, { readonly pattern: string }>>;
}

/** Version of the mirrored schema: effective date plus the source commit. */
export const SCHEMA_VERSION: string = SCHEMA.schemaVersion;

/** Where the schema was taken from. */
export const SCHEMA_SOURCE: { readonly repository: string; readonly commit: string; readonly fetched: string; readonly documentation: string } = {
  repository: SCHEMA.source.repository,
  commit: SCHEMA.source.commit,
  fetched: SCHEMA.source.fetched,
  documentation: SCHEMA.source.documentation,
};

/** Production base URL of the DSA Transparency Database. */
export const PRODUCTION_BASE_URL: string = SCHEMA.api.productionBaseUrl;

/** Endpoint paths. */
export const ENDPOINTS: { readonly single: string; readonly batch: string; readonly existingPuid: string } = {
  single: SCHEMA.api.single,
  batch: SCHEMA.api.batch,
  existingPuid: SCHEMA.api.existingPuid,
};

/** Statements per call accepted by the batch endpoint. */
export const BATCH_LIMIT: number = SCHEMA.api.batchSize.max;

/** Rate limits configured on the server, per user. */
export const SERVER_RATE_LIMITS: {
  readonly api: { readonly perSecond: number; readonly perMinute: number };
  readonly apiMultiple: { readonly perSecond: number; readonly perMinute: number };
} = { api: { ...SCHEMA.api.rateLimits.api }, apiMultiple: { ...SCHEMA.api.rateLimits.apiMultiple } };

/**
 * Seconds the server holds its per-PUID lock while it stores a statement
 * (PlatformUniqueIdService::$lock_valid_seconds). A request that collides
 * with this lock is answered as "PUID not unique".
 */
export const SERVER_PUID_LOCK_SECONDS: number = SCHEMA.api.puidLockSeconds;

/** The four decision attributes of which at least one is required. */
export const DECISION_GROUP: readonly string[] = SCHEMA.decisionGroup;

/** Member State and EEA country codes accepted in `territorial_scope`, as presets. */
export const TERRITORIAL_PRESETS: { readonly EU: readonly string[]; readonly EEA: readonly string[] } = SCHEMA.territorialPresets;

const attributeTable: Readonly<Record<string, AttributeSpec>> = SCHEMA.attributes;

/** Attribute specifications, in schema order. */
export const ATTRIBUTES: ReadonlyMap<string, AttributeSpec> = new Map(Object.entries(attributeTable));

/** Names of all accepted attributes, in schema order. */
export const ATTRIBUTE_NAMES: readonly string[] = [...ATTRIBUTES.keys()];

/** Code points the server strips from both ends of every string. */
export const TRIM_CODE_POINTS: ReadonlySet<number> = new Set(SCHEMA.trim.map((h) => Number.parseInt(h, 16)));

/** Returns the specification of an attribute, or undefined for unknown names. */
export function attributeSpec(name: string): AttributeSpec | undefined {
  return ATTRIBUTES.get(name);
}
