/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Validation of statements of reasons against the rules of the DSA
 * Transparency Database API. Pure functions, no I/O.
 *
 * The rules mirror the server's Laravel validation (StatementStoreRequest and
 * GroupedSubmissionsService::multi_rules at the commit in SCHEMA_SOURCE).
 * Every statement this module accepts, in its normalised form, is accepted
 * by the server. Where this module is stricter than the server, README.md
 * ("Where Rationale is stricter than the server") lists the cases.
 */

import type { Statement } from './generated/openapi-types.js';
import { findPersonalData, type PersonalDataKind } from './personal-data.js';
import { ATTRIBUTES, ATTRIBUTE_NAMES, DECISION_GROUP, type AttributeCondition, type AttributeSpec } from './schema.js';
import { codePointLength, isIsoDate, isPlainObject, isServerUrl, isWellFormed, ownValue, quote, serverTrim } from './text.js';

/** Codes of validation errors. A statement with any error is not sent. */
export type ErrorCode =
  | 'not_an_object'
  | 'unknown_attribute'
  | 'required'
  | 'decision_required'
  | 'invalid_type'
  | 'invalid_value'
  | 'too_long'
  | 'invalid_format'
  | 'invalid_date'
  | 'date_out_of_range'
  | 'duplicate_puid'
  | 'possible_personal_data';

/** Codes of warnings. The statement is still valid; the normalised form differs from the input or deserves a look. */
export type WarningCode =
  | 'excluded_attribute'
  | 'duplicate_value'
  | 'category_in_addition'
  | 'end_date_before_application_date'
  | 'possible_personal_data';

/**
 * One finding about one attribute. Messages never repeat free-text values;
 * they quote at most 60 characters of an invalid enumeration value.
 */
export interface Issue<C extends string> {
  readonly code: C;
  /** Attribute name, `content_id.<key>` for content identifiers, or "" for the whole statement. */
  readonly attribute: string;
  readonly message: string;
}

/** A validation error. */
export type ValidationIssue = Issue<ErrorCode>;
/** A validation warning. */
export type ValidationWarning = Issue<WarningCode>;

/** Result of validating one statement. */
export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly ValidationIssue[];
  readonly warnings: readonly ValidationWarning[];
  /** The normalised statement to send. Present only when `ok` is true. */
  readonly statement?: Statement;
}

/** Options for validation. */
export interface ValidateOptions {
  /**
   * What to do when a free-text attribute looks like it contains personal
   * data (Article 24(5) DSA). "warn" (default) adds a warning, "error"
   * makes the statement invalid, "off" skips the check.
   */
  readonly personalData?: 'warn' | 'error' | 'off';
}

/** Free-text attributes scanned for personal data. */
const FREE_TEXT = [
  'decision_visibility_other',
  'decision_monetary_other',
  'decision_facts',
  'decision_ground_reference_url',
  'illegal_content_legal_ground',
  'illegal_content_explanation',
  'incompatible_content_ground',
  'incompatible_content_explanation',
  'content_type_other',
  'category_specification_other',
  'source_identity',
];

const END_DATES = ['end_date_account_restriction', 'end_date_monetary_restriction', 'end_date_service_restriction', 'end_date_visibility_restriction'];

const PERSONAL_DATA_NAMES: Readonly<Record<PersonalDataKind, string>> = {
  email: 'an email address',
  phone: 'a phone number',
  ipv4: 'an IP address',
  iban: 'a bank account number',
};

/** Normalises one raw value the way the server's middleware does: trim strings, empty string becomes null. */
function normalizeRaw(value: unknown): unknown {
  if (typeof value === 'string') {
    const t = serverTrim(value);
    return t === '' ? null : t;
  }
  if (Array.isArray(value)) return value.map((v: unknown) => (typeof v === 'string' ? serverTrim(v) : v));
  return value;
}

function conditionHolds(cond: AttributeCondition, values: ReadonlyMap<string, unknown>): boolean {
  const v = values.get(cond.attribute);
  if (cond.equals !== undefined) return v === cond.equals;
  if (cond.contains !== undefined) return Array.isArray(v) && v.includes(cond.contains);
  return false;
}

function describeCondition(cond: AttributeCondition): string {
  return cond.equals !== undefined ? `${cond.attribute} is ${cond.equals}` : `${cond.attribute} contains ${cond.contains ?? ''}`;
}

/**
 * Validates one statement of reasons and returns its normalised form.
 *
 * @example
 * ```ts
 * const result = validateStatement(JSON.parse(line));
 * if (!result.ok) console.error(result.errors);
 * ```
 */
export function validateStatement(input: unknown, options: ValidateOptions = {}): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationWarning[] = [];
  const err = (code: ErrorCode, attribute: string, message: string): undefined => {
    errors.push({ code, attribute, message });
    return undefined;
  };
  const warn = (code: WarningCode, attribute: string, message: string): void => {
    warnings.push({ code, attribute, message });
  };

  if (!isPlainObject(input)) {
    err('not_an_object', '', 'A statement must be a JSON object.');
    return { ok: false, errors, warnings };
  }

  const values = new Map<string, unknown>();
  for (const key of Object.keys(input).sort()) {
    if (!ATTRIBUTES.has(key)) err('unknown_attribute', key, `Unknown attribute ${quote(key)}. The API accepts only documented attributes.`);
  }

  for (const [name, spec] of ATTRIBUTES) {
    const raw = normalizeRaw(ownValue(input, name));
    if (raw === null || raw === undefined) continue;
    const checked = checkValue(name, spec, raw, err, warn);
    if (checked !== undefined) values.set(name, checked);
  }

  // Presence rules, evaluated on the normalised values.
  for (const [name, spec] of ATTRIBUTES) {
    const present = values.has(name) || hasInvalidValue(errors, name);
    if (spec.required === true && !present) err('required', name, `${name} is required.`);
    if (spec.requiredWhen && !present && conditionHolds(spec.requiredWhen, values)) {
      err('required', name, `${name} is required when ${describeCondition(spec.requiredWhen)}.`);
    }
  }
  if (!DECISION_GROUP.some((n) => values.has(n) || hasInvalidValue(errors, n))) {
    err('decision_required', DECISION_GROUP[0] ?? '', `At least one of ${DECISION_GROUP.join(', ')} is required (Article 17(1) DSA).`);
  }

  // Attributes the server would ignore are removed, with a warning.
  for (const [name, spec] of ATTRIBUTES) {
    if (!values.has(name)) continue;
    if (spec.excludedUnless && !conditionHolds(spec.excludedUnless, values)) {
      values.delete(name);
      warn('excluded_attribute', name, `${name} is ignored by the server unless ${describeCondition(spec.excludedUnless)}; it was removed.`);
    } else if (spec.excludedWhen && conditionHolds(spec.excludedWhen, values)) {
      values.delete(name);
      warn('excluded_attribute', name, `${name} is ignored by the server when ${describeCondition(spec.excludedWhen)}; it was removed.`);
    }
  }

  const category = values.get('category');
  const additions = values.get('category_addition');
  if (typeof category === 'string' && Array.isArray(additions) && additions.includes(category)) {
    const rest = additions.filter((c) => c !== category);
    if (rest.length > 0) values.set('category_addition', rest);
    else values.delete('category_addition');
    warn('category_in_addition', 'category_addition', 'category_addition repeated the main category; it was removed from the list.');
  }

  const application = values.get('application_date');
  if (typeof application === 'string') {
    for (const name of END_DATES) {
      const end = values.get(name);
      if (typeof end === 'string' && end < application) {
        warn('end_date_before_application_date', name, `${name} is before application_date. The API documentation asks for an end date on or after the application date.`);
      }
    }
  }

  const mode = options.personalData ?? 'warn';
  if (mode !== 'off') {
    for (const name of FREE_TEXT) {
      const v = values.get(name);
      if (typeof v !== 'string') continue;
      const kinds = findPersonalData(v);
      if (kinds.length === 0) continue;
      const message = `${name} may contain personal data (${kinds.map((k) => PERSONAL_DATA_NAMES[k]).join(', ')}). Article 24(5) DSA requires that submissions contain no personal data.`;
      if (mode === 'error') err('possible_personal_data', name, message);
      else warn('possible_personal_data', name, message);
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  const statement: Record<string, unknown> = {};
  for (const name of ATTRIBUTE_NAMES) {
    if (values.has(name)) statement[name] = values.get(name);
  }
  return { ok: true, errors, warnings, statement: statement as unknown as Statement };
}

function hasInvalidValue(errors: readonly ValidationIssue[], name: string): boolean {
  return errors.some((e) => e.attribute === name || e.attribute.startsWith(`${name}.`));
}

type ErrFn = (code: ErrorCode, attribute: string, message: string) => undefined;
type WarnFn = (code: WarningCode, attribute: string, message: string) => void;

/**
 * Checks one present value. Returns the normalised value, or undefined when
 * the value is invalid or empty (an empty optional list counts as absent).
 */
function checkValue(name: string, spec: AttributeSpec, value: unknown, err: ErrFn, warn: WarnFn): unknown {
  switch (spec.kind) {
    case 'text':
    case 'url': {
      if (typeof value !== 'string') {
        err('invalid_type', name, `${name} must be a string.`);
        return;
      }
      if (!isWellFormed(value)) {
        err('invalid_format', name, `${name} contains an invalid Unicode sequence (a lone surrogate).`);
        return;
      }
      if (spec.max !== undefined && codePointLength(value) > spec.max) {
        err('too_long', name, `${name} is longer than ${spec.max} characters.`);
        return;
      }
      if (spec.kind === 'url' && !isServerUrl(value)) {
        err('invalid_format', name, `${name} must be an http or https URL (ASCII; percent-encode other characters).`);
        return;
      }
      if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(value)) {
        err('invalid_format', name, `${name} has an invalid format (allowed: ${spec.pattern}).`);
        return;
      }
      return value;
    }
    case 'date': {
      if (typeof value !== 'string') {
        err('invalid_type', name, `${name} must be a string in the form YYYY-MM-DD.`);
        return;
      }
      if (!isIsoDate(value)) {
        err('invalid_date', name, `${name} must be a real date in the form YYYY-MM-DD.`);
        return;
      }
      if ((spec.earliest !== undefined && value < spec.earliest) || (spec.latest !== undefined && value > spec.latest)) {
        err('date_out_of_range', name, `${name} must be between ${spec.earliest ?? 'any date'} and ${spec.latest ?? 'any date'}.`);
        return;
      }
      return value;
    }
    case 'enum': {
      if (typeof value !== 'string') {
        err('invalid_type', name, `${name} must be a string.`);
        return;
      }
      if (!(spec.values ?? []).includes(value)) {
        err('invalid_value', name, `${quote(value)} is not an allowed value of ${name}.`);
        return;
      }
      return value;
    }
    case 'enum-list': {
      if (!Array.isArray(value)) {
        err('invalid_type', name, `${name} must be an array.`);
        return;
      }
      if (value.some((v) => typeof v !== 'string')) {
        err('invalid_type', name, `${name} must contain only strings.`);
        return;
      }
      const list = value as string[];
      const bad = list.filter((v) => !(spec.values ?? []).includes(v));
      if (bad.length > 0) {
        err('invalid_value', name, `${name} contains values that are not allowed: ${bad.slice(0, 5).map((b) => quote(b)).join(', ')}${bad.length > 5 ? ', ...' : ''}.`);
        return;
      }
      const unique = [...new Set(list)];
      if (unique.length !== list.length) warn('duplicate_value', name, `${name} listed a value more than once; duplicates were removed.`);
      return unique.length > 0 ? unique : undefined;
    }
    case 'content-id': {
      if (!isPlainObject(value)) {
        err('invalid_type', name, `${name} must be an object such as {"EAN-13": "..."}.`);
        return;
      }
      const out: Record<string, string> = {};
      let failed = false;
      for (const key of Object.keys(value).sort()) {
        const keySpec = spec.keys !== undefined && Object.prototype.hasOwnProperty.call(spec.keys, key) ? spec.keys[key] : undefined;
        const attr = `${name}.${key}`;
        if (keySpec === undefined) {
          err('unknown_attribute', attr, `Unknown ${name} key ${quote(key)}. Only "EAN-13" is accepted.`);
          failed = true;
          continue;
        }
        const raw = normalizeRaw(ownValue(value, key));
        if (raw === null || raw === undefined) continue;
        if (typeof raw !== 'string') {
          err('invalid_type', attr, `${attr} must be a string.`);
          failed = true;
        } else if (!new RegExp(keySpec.pattern).test(raw)) {
          err('invalid_format', attr, `${attr} must be 13 digits.`);
          failed = true;
        } else {
          out[key] = raw;
        }
      }
      if (failed) return undefined;
      return Object.keys(out).length > 0 ? out : undefined;
    }
  }
}

/** Result of validating a list of statements. */
export interface BatchValidationResult {
  /** One result per input, in input order. */
  readonly results: readonly ValidationResult[];
  /** Number of valid statements. */
  readonly valid: number;
}

/**
 * Validates several statements. In addition to the per-statement rules,
 * a PUID that appears more than once is an error on every later
 * occurrence, because the server rejects the whole batch in that case.
 */
export function validateStatements(inputs: readonly unknown[], options: ValidateOptions = {}): BatchValidationResult {
  const seen = new Set<string>();
  let valid = 0;
  const results = inputs.map((input): ValidationResult => {
    const r = validateStatement(input, options);
    if (!r.ok || r.statement === undefined) return r;
    const puid = r.statement.puid;
    if (seen.has(puid)) {
      return {
        ok: false,
        errors: [{ code: 'duplicate_puid', attribute: 'puid', message: 'This PUID already appears earlier in the same input.' }],
        warnings: r.warnings,
      };
    }
    seen.add(puid);
    valid++;
    return r;
  });
  return { results, valid };
}
