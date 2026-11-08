/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Schema parity: the curated attribute specification (schema/attributes.json,
 * resolved into schema/statement-schema.json and src/generated) must say
 * exactly what the official validation rules say. The rules are read from
 * schema/source-rules.json, which scripts/extract-schema.mjs extracts from
 * the official source code (StatementStoreRequest::rules() for the single
 * endpoint and GroupedSubmissionsService::multi_rules() for the batch
 * endpoint).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAll } from '../scripts/generate.ts';
import { ATTRIBUTES, ATTRIBUTE_NAMES, BATCH_LIMIT, DECISION_GROUP, ENDPOINTS, SCHEMA_SOURCE, SCHEMA_VERSION, SERVER_PUID_LOCK_SECONDS, SERVER_RATE_LIMITS, TERRITORIAL_PRESETS, TRIM_CODE_POINTS, type AttributeSpec } from '../src/schema.js';
import { ROOT } from './helpers/vectors.js';

interface SourceRules {
  source: { repository: string; commit: string; fetched: string; files: Record<string, { sha256: string }> };
  endpoints: { method: string; path: string }[];
  globalMiddleware: string[];
  batch: { min: number; max: number };
  rateLimits: { api: { perSecond: number; perMinute: number }; apiMultiple: { perSecond: number; perMinute: number } };
  enums: Record<string, Record<string, string> | string[]>;
  lists: Record<string, string[]>;
  rules: { single: Record<string, string[]>; multi: Record<string, string[]> };
  conditions: { single: Record<string, { attribute: string; contains: string }>; multi: Record<string, { attribute: string; contains: string }> };
  multiSanitizers: { helper: string; field: string; other: string; value: string }[];
  puid: { lockSeconds: number };
}

const rules = JSON.parse(readFileSync(`${ROOT}schema/source-rules.json`, 'utf8')) as SourceRules;

/** Attributes the server accepts that Rationale deliberately does not send (documented in schema/attributes.json). */
const NOT_ACCEPTED = new Set(['content_id_ean']);

/** Resolves an "in:" token to the list of allowed values. */
function inValues(token: string): string[] {
  const m = /^in:(?:null,)?@(\w+)::(\w+)\.(keys|values)$/.exec(token);
  if (!m) throw new Error(`unexpected in-token ${token}`);
  const [, cls, name, part] = m;
  if (cls === 'Statement') {
    const e = rules.enums[name ?? ''];
    if (e === undefined) throw new Error(`unknown enum ${name ?? ''}`);
    return Array.isArray(e) ? e : part === 'keys' ? Object.keys(e) : Object.values(e);
  }
  const list = rules.lists[`${cls ?? ''}::${name ?? ''}`];
  if (!list) throw new Error(`unknown list ${token}`);
  return list;
}

/** What the official tokens of one attribute imply, in Rationale's terms. */
function expectedFrom(tokens: readonly string[], endpoint: 'single' | 'multi'): Partial<AttributeSpec> & { kindHint: string } {
  const out: Partial<{ -readonly [K in keyof AttributeSpec]: AttributeSpec[K] }> & { kindHint: string } = { kindHint: 'text' };
  const isArray = tokens.includes('array');
  for (const t of tokens) {
    if (t === 'required') out.required = true;
    else if (t.startsWith('max:')) out.max = Number(t.slice(4));
    else if (t.startsWith('in:')) {
      out.values = inValues(t);
      out.kindHint = isArray ? 'enum-list' : 'enum';
    } else if (t === 'date_format:Y-m-d') out.kindHint = 'date';
    else if (t.startsWith('after_or_equal:')) out.earliest = t.slice('after_or_equal:'.length);
    else if (t.startsWith('before_or_equal:')) out.latest = t.slice('before_or_equal:'.length);
    else if (t === 'url') out.kindHint = 'url';
    else if (t.startsWith('regex:')) out.pattern = t.slice('regex:'.length);
    else if (t.startsWith('required_if:')) {
      const [attribute, equals] = t.slice('required_if:'.length).split(',');
      out.requiredWhen = { attribute: attribute ?? '', equals: equals ?? '' };
    } else if (t.startsWith('exclude_unless:')) {
      const [attribute, equals] = t.slice('exclude_unless:'.length).split(',');
      out.excludedUnless = { attribute: attribute ?? '', equals: equals ?? '' };
    } else if (t.startsWith('required_if_fn:') || t.startsWith('required_if_var:')) {
      const key = t.slice(t.indexOf(':') + 1);
      const c = endpoint === 'single' ? rules.conditions.single[key] : rules.conditions.multi[key];
      if (!c) throw new Error(`unknown condition ${key}`);
      out.requiredWhen = { attribute: c.attribute, contains: c.contains };
    } else if (t.startsWith('exclude_unless_fn:') || t.startsWith('exclude_unless_var:')) {
      const key = t.slice(t.indexOf(':') + 1);
      const c = endpoint === 'single' ? rules.conditions.single[key] : rules.conditions.multi[key];
      if (!c) throw new Error(`unknown condition ${key}`);
      out.excludedUnless = { attribute: c.attribute, contains: c.contains };
    } else if (t.startsWith('exclude_if_fn:')) {
      const c = rules.conditions.single[t.slice('exclude_if_fn:'.length)];
      if (!c) throw new Error(`unknown condition ${t}`);
      out.excludedWhen = { attribute: c.attribute, equals: c.contains };
    } else if (t.startsWith('required_without_all:')) {
      out.kindHint = `${out.kindHint}|group`;
    } else if (!['array', 'nullable', 'string'].includes(t)) {
      throw new Error(`token not handled by the parity test: ${t}`);
    }
  }
  return out;
}

/** Converts a PHP regex literal like /^[a-zA-Z0-9-_]+$/D to the set of strings it accepts, sampled. */
function phpRegexToJs(lit: string): RegExp {
  const m = /^\/(.*)\/([a-zA-Z]*)$/.exec(lit);
  if (!m) throw new Error(`bad regex ${lit}`);
  // D (dollar end only) is the default behaviour of $ in JavaScript without the m flag.
  return new RegExp(m[1] ?? '', (m[2] ?? '').replace('D', ''));
}

describe('schema source', () => {
  it('records the official repository, commit and fetch date', () => {
    expect(SCHEMA_SOURCE.repository).toBe('https://github.com/digital-services-act/transparency-database');
    expect(SCHEMA_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(SCHEMA_SOURCE.commit).toBe(rules.source.commit);
    expect(SCHEMA_SOURCE.fetched).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(SCHEMA_VERSION).toBe(`2025-07-01+${rules.source.commit.slice(0, 8)}`);
    for (const f of ['app/Http/Requests/StatementStoreRequest.php', 'app/Services/GroupedSubmissionsService.php', 'app/Models/Statement.php']) {
      expect(rules.source.files[f]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('generated files are up to date (npm run generate)', () => {
    for (const [rel, content] of Object.entries(buildAll(ROOT))) {
      expect(readFileSync(`${ROOT}${rel}`, 'utf8'), rel).toBe(content);
    }
  });
});

describe('schema parity with the official validation rules', () => {
  const single = rules.rules.single;
  const multi = rules.rules.multi;

  it('accepts exactly the attributes of the official rules (minus documented exclusions)', () => {
    const official = new Set(Object.keys(single).filter((k) => !k.includes('.')));
    for (const k of NOT_ACCEPTED) official.delete(k);
    expect(new Set(ATTRIBUTE_NAMES)).toEqual(official);
    // The batch endpoint has the same attributes, except the single-only content_id_ean.
    const multiNames = new Set(Object.keys(multi).filter((k) => !k.includes('.')));
    expect(multiNames).toEqual(official);
  });

  for (const name of Object.keys(single).filter((k) => !k.includes('.') && !NOT_ACCEPTED.has(k))) {
    it(`${name} matches the single-endpoint rules`, () => {
      const spec = ATTRIBUTES.get(name);
      expect(spec).toBeDefined();
      if (!spec) return;
      const e = expectedFrom(single[name] ?? [], 'single');
      expect(spec.required === true, 'required').toBe(e.required === true);
      expect(spec.max, 'max').toBe(e.max);
      if (e.values) expect(spec.values, 'values').toEqual(e.values);
      else expect(spec.values).toBeUndefined();
      const kind = e.kindHint.replace('|group', '');
      if (name === 'content_id') expect(spec.kind).toBe('content-id');
      else expect(spec.kind, 'kind').toBe(kind === 'text' ? 'text' : kind);
      expect(spec.earliest, 'earliest').toBe(e.earliest);
      expect(spec.latest, 'latest').toBe(e.latest);
      expect(spec.requiredWhen, 'requiredWhen').toEqual(e.requiredWhen);
      if (name === 'category_specification_other') {
        // Single endpoint keeps it; the batch endpoint drops it unless KEYWORD_OTHER is selected (checked below).
        expect(e.excludedUnless).toBeUndefined();
      } else {
        expect(spec.excludedUnless, 'excludedUnless').toEqual(e.excludedUnless);
      }
      expect(spec.excludedWhen, 'excludedWhen').toEqual(e.excludedWhen);
      expect(DECISION_GROUP.includes(name), 'decision group').toBe(e.kindHint.endsWith('|group'));
    });
  }

  it('the PUID pattern accepts and rejects the same strings as the official regex', () => {
    const official = phpRegexToJs(single['puid']?.find((t) => t.startsWith('regex:'))?.slice(6) ?? '');
    const ours = new RegExp(ATTRIBUTES.get('puid')?.pattern ?? '');
    const samples = ['a', 'A-z_0', '-', '_', 'a b', 'a.b', 'a/b', 'a\n', '\nb', `ab${String.fromCodePoint(0xfc)}`, '', 'x'.repeat(500), 'a%b', 'a+b'];
    for (const s of samples) expect(ours.test(s), JSON.stringify(s)).toBe(official.test(s));
  });

  it('the EAN-13 pattern matches the official rule', () => {
    expect(single['content_id.EAN-13']).toEqual(['string', 'regex:/^[0-9]{13}$/']);
    expect(multi['content_id.EAN-13']).toEqual(['string', 'regex:/^[0-9]{13}$/']);
    expect(ATTRIBUTES.get('content_id')?.keys).toEqual({ 'EAN-13': { pattern: '^[0-9]{13}$' } });
  });

  it('the batch endpoint rules equal the single endpoint rules, apart from documented differences', () => {
    const differences: string[] = [];
    for (const name of Object.keys(multi)) {
      const a = expectedFrom(multi[name] ?? [], 'multi');
      const b = expectedFrom(single[name] ?? [], 'single');
      if (JSON.stringify(a) !== JSON.stringify(b)) differences.push(name);
    }
    // source_identity: single excludes it when SOURCE_VOLUNTARY; batch accepts it, then sets it to null (see multiSanitizers).
    expect(differences.sort()).toEqual(['source_identity']);
    const sanitizer = rules.multiSanitizers.find((m) => m.other === 'source_identity');
    expect(sanitizer).toEqual({ helper: 'handleOtherFieldWhenEqual', field: 'source_type', other: 'source_identity', value: 'SOURCE_VOLUNTARY' });
  });

  it('every batch post-processing step is reflected as an exclusion', () => {
    for (const m of rules.multiSanitizers) {
      const spec = ATTRIBUTES.get(m.other);
      if (m.helper === 'handleOtherFieldWithinArray') expect(spec?.excludedUnless, m.other).toEqual({ attribute: m.field, contains: m.value });
      else if (m.helper === 'handleOtherFieldWhenNotEqual') expect(spec?.excludedUnless, m.other).toEqual({ attribute: m.field, equals: m.value });
      else expect(spec?.excludedWhen, m.other).toEqual({ attribute: m.field, equals: m.value });
    }
  });

  it('keeps the removed pre-July-2025 values out', () => {
    expect(ATTRIBUTES.get('category')?.values).not.toContain('STATEMENT_CATEGORY_PORNOGRAPHY_OR_SEXUALIZED_CONTENT');
    expect(ATTRIBUTES.get('category_specification')?.values).not.toContain('KEYWORD_DANGEROUS_TOYS');
    expect(ATTRIBUTES.get('category')?.values).toHaveLength(16);
    expect(ATTRIBUTES.get('category_specification')?.values).toHaveLength(69);
  });

  it('mirrors the endpoints, batch size, rate limits and middleware', () => {
    expect(ENDPOINTS).toEqual({ single: '/api/v1/statement', batch: '/api/v1/statements', existingPuid: '/api/v1/statement/existing-puid/{puid}' });
    expect(rules.endpoints).toContainEqual({ method: 'POST', path: '/api/v1/statement' });
    expect(rules.endpoints).toContainEqual({ method: 'POST', path: '/api/v1/statements' });
    expect(BATCH_LIMIT).toBe(rules.batch.max);
    expect(rules.batch).toEqual({ min: 1, max: 100 });
    expect(SERVER_RATE_LIMITS).toEqual(rules.rateLimits);
    expect(SERVER_PUID_LOCK_SECONDS).toBe(rules.puid.lockSeconds);
    expect(rules.puid.lockSeconds).toBe(30);
    expect(rules.globalMiddleware).toEqual(['TrimStrings', 'ConvertEmptyStringsToNull', 'ValidatePostSize']);
  });

  it('offers the EU and EEA presets from the official lists', () => {
    expect(TERRITORIAL_PRESETS.EU).toEqual(rules.lists['EuropeanCountriesService::EUROPEAN_UNION_COUNTRY_CODES']);
    expect(TERRITORIAL_PRESETS.EEA).toEqual(rules.lists['EuropeanCountriesService::EUROPEAN_ECONOMIC_AREA_COUNTRY_CODES']);
    expect(TERRITORIAL_PRESETS.EU).toHaveLength(27);
    expect(TERRITORIAL_PRESETS.EEA).toHaveLength(30);
  });

  it('trims the characters Laravel Str::trim removes', () => {
    for (const cp of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x00, 0x85, 0xa0, 0x1680, 0x2000, 0x200a, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff, 0x1d159, 0xe0020]) {
      expect(TRIM_CODE_POINTS.has(cp), cp.toString(16)).toBe(true);
    }
    expect(TRIM_CODE_POINTS.has(0x41)).toBe(false);
    expect(TRIM_CODE_POINTS.has(0x2010)).toBe(false);
  });
});
