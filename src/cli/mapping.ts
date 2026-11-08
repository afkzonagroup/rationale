/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mapping files: how columns of a CSV file (or keys of a JSONL record) map
 * to statement attributes, with optional constants, list splitting and
 * value translation.
 *
 * ```json
 * {
 *   "version": 1,
 *   "delimiter": ",",
 *   "fields": {
 *     "puid": { "column": "decision_id" },
 *     "decision_visibility": { "column": "action", "split": "|", "map": { "removed": "DECISION_VISIBILITY_CONTENT_REMOVED" } },
 *     "source_type": { "value": "SOURCE_VOLUNTARY" },
 *     "content_id.EAN-13": { "column": "ean" }
 *   }
 * }
 * ```
 */

import { RationaleError } from '../errors.js';
import { ATTRIBUTES } from '../schema.js';
import { isPlainObject, ownValue } from '../text.js';

/** How one target attribute is filled. */
export interface FieldMapping {
  readonly column?: string;
  readonly value?: string | readonly string[];
  readonly split?: string;
  readonly map?: ReadonlyMap<string, string>;
}

/** A checked mapping. */
export interface Mapping {
  readonly delimiter: string;
  readonly fields: ReadonlyMap<string, FieldMapping>;
}

const EAN_TARGET = 'content_id.EAN-13';
const MAX_MAP_ENTRIES = 10_000;

function isListTarget(target: string): boolean {
  return ATTRIBUTES.get(target)?.kind === 'enum-list';
}

/** Targets a mapping may fill: every attribute except content_id, plus "content_id.EAN-13". */
export function mappingTargets(): string[] {
  return [...ATTRIBUTES.keys()].filter((k) => k !== 'content_id').concat(EAN_TARGET);
}

const fail = (msg: string): never => {
  throw new RationaleError('input', `Mapping file: ${msg}`);
};

/** Checks a parsed mapping file. Throws RationaleError("input") with a precise message. */
export function parseMapping(json: unknown): Mapping {
  if (!isPlainObject(json)) return fail('must be a JSON object.');
  for (const k of Object.keys(json)) if (!['version', 'delimiter', 'fields'].includes(k)) fail(`unknown key "${k}".`);
  if (ownValue(json, 'version') !== 1) fail('"version" must be 1.');
  const delimiter = ownValue(json, 'delimiter') ?? ',';
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || /["\r\n]/.test(delimiter)) fail('"delimiter" must be one character.');
  const fieldsJson = ownValue(json, 'fields');
  if (!isPlainObject(fieldsJson)) return fail('"fields" must be an object.');
  const targets = new Set(mappingTargets());
  const fields = new Map<string, FieldMapping>();
  for (const [target, spec] of Object.entries(fieldsJson)) {
    if (!targets.has(target)) fail(`"${target}" is not a statement attribute.`);
    if (!isPlainObject(spec)) fail(`"${target}" must be an object.`);
    const s = spec as Record<string, unknown>;
    for (const k of Object.keys(s)) if (!['column', 'value', 'split', 'map'].includes(k)) fail(`"${target}" has unknown key "${k}".`);
    const column = ownValue(s, 'column');
    const value = ownValue(s, 'value');
    const split = ownValue(s, 'split');
    const map = ownValue(s, 'map');
    if ((column === undefined) === (value === undefined)) fail(`"${target}" needs exactly one of "column" and "value".`);
    if (column !== undefined && (typeof column !== 'string' || column === '' || column.length > 500)) fail(`"${target}.column" must be a non-empty string.`);
    if (value !== undefined) {
      const ok = isListTarget(target) ? Array.isArray(value) && value.every((v) => typeof v === 'string') : typeof value === 'string';
      if (!ok) fail(`"${target}.value" must be ${isListTarget(target) ? 'an array of strings' : 'a string'}.`);
    }
    if (split !== undefined && (!isListTarget(target) || typeof split !== 'string' || split === '' || split.length > 10)) {
      fail(`"${target}.split" is only for list attributes and must be a short string.`);
    }
    let mapped: Map<string, string> | undefined;
    if (map !== undefined) {
      if (!isPlainObject(map)) return fail(`"${target}.map" must be an object.`);
      const entries = Object.entries(map);
      if (entries.length > MAX_MAP_ENTRIES) fail(`"${target}.map" has too many entries.`);
      mapped = new Map();
      for (const [from, to] of entries) {
        if (typeof to !== 'string') fail(`"${target}.map" values must be strings.`);
        mapped.set(from, to as string);
      }
    }
    fields.set(target, {
      ...(column !== undefined ? { column: column as string } : {}),
      ...(value !== undefined ? { value: value as string | string[] } : {}),
      ...(split !== undefined ? { split: split as string } : {}),
      ...(mapped ? { map: mapped } : {}),
    });
  }
  return { delimiter: delimiter as string, fields };
}

/**
 * The mapping used for CSV files without a mapping file: every column is
 * named after its attribute, list attributes are split on "|".
 */
export function identityMapping(headers: readonly string[], delimiter = ','): Mapping {
  const targets = new Set(mappingTargets());
  const fields = new Map<string, FieldMapping>();
  for (const h of headers) {
    if (!targets.has(h)) throw new RationaleError('input', `CSV column "${h.slice(0, 100)}" is not a statement attribute. Use a mapping file.`);
    fields.set(h, { column: h, ...(isListTarget(h) ? { split: '|' } : {}) });
  }
  return { delimiter, fields };
}

/** Builds a statement object from one record using a mapping. Empty cells are left out. */
export function applyMapping(record: Readonly<Record<string, unknown>>, mapping: Mapping): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [target, f] of mapping.fields) {
    const constant: unknown = f.value;
    let v: unknown = constant !== undefined ? (Array.isArray(constant) ? (constant as unknown[]).slice() : constant) : ownValue(record, f.column ?? '');
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'string' && isListTarget(target)) {
      v = v
        .split(f.split ?? '|')
        .map((x) => x.trim())
        .filter((x) => x !== '');
    }
    if (f.map) {
      const m = f.map;
      const tr = (x: unknown): unknown => (typeof x === 'string' && m.has(x.trim()) ? m.get(x.trim()) : x);
      v = Array.isArray(v) ? v.map(tr) : tr(v);
    }
    if (target === EAN_TARGET) out['content_id'] = { 'EAN-13': v };
    else out[target] = v;
  }
  return out;
}
