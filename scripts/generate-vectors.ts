/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

// Writes test-vectors/statements.json: statements with the expected result
// (valid or not, error and warning codes, normalised values). Both the
// TypeScript and the Python test suites run every case.
//
// Expectations are written by hand from the official rules, or derived from
// the rule kind (every allowed value of an enumeration is valid). They are
// never produced by running the validator.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Pair = [string, string];

interface Case {
  id: string;
  input?: Json;
  patch?: Record<string, Json>;
  unset?: string[];
  options?: { personalData: 'warn' | 'error' | 'off' };
  expect: { ok: boolean; errors?: Pair[]; warnings?: Pair[]; normalized?: Record<string, Json> };
}

const root = fileURLToPath(new URL('..', import.meta.url));
const schema = JSON.parse(readFileSync(`${root}schema/statement-schema.json`, 'utf8')) as {
  schemaVersion: string;
  attributes: Record<string, { kind: string; values?: string[] }>;
};

const base: Record<string, Json> = {
  decision_visibility: ['DECISION_VISIBILITY_CONTENT_REMOVED'],
  decision_ground: 'DECISION_GROUND_ILLEGAL_CONTENT',
  illegal_content_legal_ground: 'Article 5 of the Example Product Safety Act',
  illegal_content_explanation: 'The listing offers a product that this provision prohibits.',
  content_type: ['CONTENT_TYPE_PRODUCT'],
  category: 'STATEMENT_CATEGORY_UNSAFE_AND_PROHIBITED_PRODUCTS',
  territorial_scope: ['LT', 'LV'],
  content_date: '2026-10-01',
  application_date: '2026-10-02',
  decision_facts: 'A notice reported the listing. A review confirmed that the product is prohibited.',
  source_type: 'SOURCE_ARTICLE_16',
  automated_detection: 'No',
  automated_decision: 'AUTOMATED_DECISION_NOT_AUTOMATED',
  puid: 'listing-1001',
};

const incompatible: Record<string, Json> = {
  decision_ground: 'DECISION_GROUND_INCOMPATIBLE_CONTENT',
  illegal_content_legal_ground: null,
  illegal_content_explanation: null,
  incompatible_content_ground: 'Section 4.2 of the terms of service',
  incompatible_content_explanation: 'The listing sells an item the terms do not allow.',
};

const ok = (id: string, patch: Record<string, Json> = {}, more: Partial<Case> = {}): Case => ({ id, patch, expect: { ok: true }, ...more });
const bad = (id: string, patch: Record<string, Json>, errors: Pair[], more: Partial<Case> = {}): Case => ({ id, patch, expect: { ok: false, errors }, ...more });
const warnOnly = (id: string, patch: Record<string, Json>, warnings: Pair[], normalized?: Record<string, Json>): Case => ({
  id,
  patch,
  expect: { ok: true, warnings, ...(normalized ? { normalized } : {}) },
});

const s = (n: number, ch = 'a'): string => ch.repeat(n);
const allEu = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];
// U+1F600 as a surrogate pair: one code point, two UTF-16 units.
const emoji = String.fromCodePoint(0x1f600);

const cases: Case[] = [
  // Valid statements
  ok('base'),
  ok('incompatible-ground', { ...incompatible, incompatible_content_illegal: 'Yes' }),
  ok('monetary-only', { decision_visibility: null, decision_monetary: 'DECISION_MONETARY_OTHER', decision_monetary_other: 'Withheld payouts for 30 days' }),
  ok('provision-only', { decision_visibility: null, decision_provision: 'DECISION_PROVISION_PARTIAL_SUSPENSION' }),
  ok('account-only', { decision_visibility: null, decision_account: 'DECISION_ACCOUNT_SUSPENDED', account_type: 'ACCOUNT_TYPE_BUSINESS' }),
  ok('all-four-decisions', {
    decision_monetary: 'DECISION_MONETARY_SUSPENSION',
    decision_provision: 'DECISION_PROVISION_TOTAL_TERMINATION',
    decision_account: 'DECISION_ACCOUNT_TERMINATED',
  }),
  ok('visibility-other', { decision_visibility: ['DECISION_VISIBILITY_OTHER', 'DECISION_VISIBILITY_CONTENT_DEMOTED'], decision_visibility_other: 'Hidden from search' }),
  ok('content-type-other', { content_type: ['CONTENT_TYPE_OTHER'], content_type_other: '3D model file' }),
  ok('keyword-other', { category_specification: ['KEYWORD_OTHER'], category_specification_other: 'Counterfeit spare parts' }),
  ok('ean13', { content_id: { 'EAN-13': '4006381333931' } }, { expect: { ok: true, normalized: { content_id: { 'EAN-13': '4006381333931' } } } }),
  ok('territorial-eu', { territorial_scope: allEu }),
  ok('content-language', { content_language: 'LT' }),
  ok('content-language-non-eu', { content_language: 'UK' }),
  ok('date-lower-bounds', { content_date: '2000-01-01', application_date: '2020-01-01' }),
  ok('date-upper-bounds', { content_date: '2038-01-01', application_date: '2038-01-01', end_date_account_restriction: '2038-01-01' }),
  ok('leap-day', { content_date: '2024-02-29', application_date: '2024-03-01' }),
  ok('end-dates', {
    end_date_visibility_restriction: '2027-01-01',
    end_date_monetary_restriction: '2027-01-01',
    end_date_service_restriction: '2027-01-01',
    end_date_account_restriction: '2027-01-01',
  }),
  ok('puid-500', { puid: s(500, 'x') }),
  ok('puid-charset', { puid: 'Az09-_' }),
  ok('facts-5000', { decision_facts: s(5000) }),
  ok('facts-5000-code-points', { decision_facts: emoji.repeat(5000) }),
  ok('url-full', { decision_ground_reference_url: 'https://example.com/terms/v2?section=4.2&lang=en#prohibited' }),
  ok('url-http-port', { decision_ground_reference_url: 'http://example.co.uk:8080/a/b' }),
  ok('url-percent', { decision_ground_reference_url: 'https://xn--bcher-kva.example/%C3%BC' }),
  ok('url-500', { decision_ground_reference_url: `https://example.com/${s(480)}` }),
  ok('source-voluntary', { source_type: 'SOURCE_VOLUNTARY' }),
  ok('incompatible-illegal-no', { ...incompatible, incompatible_content_illegal: 'No' }),
  ok('optional-null-is-absent', { account_type: null, content_language: null, territorial_scope: null, category_addition: null }, {
    expect: { ok: true, normalized: { account_type: null, content_language: null, territorial_scope: null, category_addition: null } },
  }),
  ok('optional-empty-string-is-absent', { account_type: '', source_identity: '   ' }, { expect: { ok: true, normalized: { account_type: null, source_identity: null } } }),
  ok('optional-empty-list-is-absent', { category_specification: [], territorial_scope: [] }, { expect: { ok: true, normalized: { category_specification: null, territorial_scope: null } } }),
  ok('trim-puid', { puid: '  listing-1001\n' }, { expect: { ok: true, normalized: { puid: 'listing-1001' } } }),
  ok('trim-unicode', { decision_facts: `${String.fromCodePoint(0xa0, 0x3000, 0xfeff, 0x200b)}Facts.${String.fromCodePoint(0x200e, 0x2028)}\t` }, { expect: { ok: true, normalized: { decision_facts: 'Facts.' } } }),
  ok('trim-list-elements', { content_type: [' CONTENT_TYPE_TEXT '] }, { expect: { ok: true, normalized: { content_type: ['CONTENT_TYPE_TEXT'] } } }),
  ok('no-personal-data-false-positive', { decision_facts: 'Rule 4@section, version 1.2.3, see article 17(3)(b).' }, { expect: { ok: true, warnings: [] } }),
  ok('personal-data-off', { decision_facts: 'Contact jane.doe@example.com' }, { options: { personalData: 'off' }, expect: { ok: true, warnings: [] } }),

  // Warnings: valid, but the normalised statement differs from the input
  warnOnly('source-identity-voluntary', { source_type: 'SOURCE_VOLUNTARY', source_identity: 'Internal review team' }, [['excluded_attribute', 'source_identity']], { source_identity: null }),
  warnOnly('illegal-fields-with-incompatible', { ...incompatible, illegal_content_legal_ground: 'Act', illegal_content_explanation: 'Text' }, [
    ['excluded_attribute', 'illegal_content_legal_ground'],
    ['excluded_attribute', 'illegal_content_explanation'],
  ]),
  warnOnly('incompatible-fields-with-illegal', { incompatible_content_ground: 'T&C 4', incompatible_content_explanation: 'Text', incompatible_content_illegal: 'Yes' }, [
    ['excluded_attribute', 'incompatible_content_ground'],
    ['excluded_attribute', 'incompatible_content_explanation'],
    ['excluded_attribute', 'incompatible_content_illegal'],
  ]),
  warnOnly('visibility-other-without-other', { decision_visibility_other: 'Text' }, [['excluded_attribute', 'decision_visibility_other']], { decision_visibility_other: null }),
  warnOnly('monetary-other-without-other', { decision_monetary: 'DECISION_MONETARY_SUSPENSION', decision_monetary_other: 'Text' }, [['excluded_attribute', 'decision_monetary_other']]),
  warnOnly('content-type-other-without-other', { content_type_other: 'Text' }, [['excluded_attribute', 'content_type_other']]),
  warnOnly('keyword-other-without-other', { category_specification: ['KEYWORD_PHISHING'], category_specification_other: 'Text' }, [['excluded_attribute', 'category_specification_other']]),
  warnOnly('duplicate-values', { territorial_scope: ['LT', 'LV', 'LT'] }, [['duplicate_value', 'territorial_scope']], { territorial_scope: ['LT', 'LV'] }),
  warnOnly('category-in-addition', { category_addition: ['STATEMENT_CATEGORY_UNSAFE_AND_PROHIBITED_PRODUCTS', 'STATEMENT_CATEGORY_SCAMS_AND_FRAUD'] }, [['category_in_addition', 'category_addition']], {
    category_addition: ['STATEMENT_CATEGORY_SCAMS_AND_FRAUD'],
  }),
  warnOnly('category-only-addition', { category_addition: ['STATEMENT_CATEGORY_UNSAFE_AND_PROHIBITED_PRODUCTS'] }, [['category_in_addition', 'category_addition']], { category_addition: null }),
  warnOnly('end-before-application', { end_date_account_restriction: '2026-10-01', decision_account: 'DECISION_ACCOUNT_SUSPENDED' }, [['end_date_before_application_date', 'end_date_account_restriction']]),
  warnOnly('end-date-no-lower-bound', { end_date_service_restriction: '1990-01-01' }, [['end_date_before_application_date', 'end_date_service_restriction']]),
  warnOnly('pii-email', { decision_facts: 'Reported by jane.doe@example.com.' }, [['possible_personal_data', 'decision_facts']]),
  warnOnly('pii-phone', { decision_facts: 'Call +370 612 34567 for details.' }, [['possible_personal_data', 'decision_facts']]),
  warnOnly('pii-ipv4', { decision_facts: 'Uploaded from 192.168.10.25.' }, [['possible_personal_data', 'decision_facts']]),
  warnOnly('pii-iban', { decision_facts: 'Payout account LT12 1000 0111 0100 1000.' }, [['possible_personal_data', 'decision_facts']]),
  warnOnly('pii-source-identity', { source_identity: 'notifier@example.org' }, [['possible_personal_data', 'source_identity']]),
  bad('pii-error-mode', { decision_facts: 'Reported by jane.doe@example.com.' }, [['possible_personal_data', 'decision_facts']], { options: { personalData: 'error' } }),

  // Shape errors
  { id: 'not-object-string', input: 'statement', expect: { ok: false, errors: [['not_an_object', '']] } },
  { id: 'not-object-array', input: [base], expect: { ok: false, errors: [['not_an_object', '']] } },
  { id: 'not-object-null', input: null, expect: { ok: false, errors: [['not_an_object', '']] } },
  { id: 'not-object-number', input: 42, expect: { ok: false, errors: [['not_an_object', '']] } },
  bad('unknown-attribute', { decision_ground_url: 'https://example.com' }, [['unknown_attribute', 'decision_ground_url']]),
  bad('unknown-content-id-ean', { content_id_ean: '4006381333931' }, [['unknown_attribute', 'content_id_ean']]),
  bad('unknown-content-language-other', { content_language_other: 'Klingon' }, [['unknown_attribute', 'content_language_other']]),
  bad('unknown-proto', { ['__proto__']: { x: 1 } }, [['unknown_attribute', '__proto__']]),

  // Required attributes
  ...['puid', 'decision_ground', 'content_type', 'category', 'content_date', 'application_date', 'decision_facts', 'source_type', 'automated_detection', 'automated_decision'].map(
    (a): Case => ({ id: `missing-${a}`, unset: [a, ...(a === 'decision_ground' ? ['illegal_content_legal_ground', 'illegal_content_explanation'] : [])], expect: { ok: false, errors: [['required', a]] } }),
  ),
  bad('required-blank', { decision_facts: ' \t\n' }, [['required', 'decision_facts']]),
  bad('no-decision', { decision_visibility: null }, [['decision_required', 'decision_visibility']]),
  bad('empty-decision-list', { decision_visibility: [] }, [['decision_required', 'decision_visibility']]),
  bad('visibility-other-missing', { decision_visibility: ['DECISION_VISIBILITY_OTHER'] }, [['required', 'decision_visibility_other']]),
  bad('monetary-other-missing', { decision_monetary: 'DECISION_MONETARY_OTHER' }, [['required', 'decision_monetary_other']]),
  bad('content-type-other-missing', { content_type: ['CONTENT_TYPE_OTHER'] }, [['required', 'content_type_other']]),
  bad('illegal-ground-missing', { illegal_content_legal_ground: null }, [['required', 'illegal_content_legal_ground']]),
  bad('illegal-explanation-missing', { illegal_content_explanation: '' }, [['required', 'illegal_content_explanation']]),
  bad('incompatible-fields-missing', { ...incompatible, incompatible_content_ground: null, incompatible_content_explanation: null }, [
    ['required', 'incompatible_content_ground'],
    ['required', 'incompatible_content_explanation'],
  ]),

  // PUID
  bad('puid-space', { puid: 'listing 1001' }, [['invalid_format', 'puid']]),
  bad('puid-dot', { puid: 'listing.1001' }, [['invalid_format', 'puid']]),
  bad('puid-non-ascii', { puid: `listing-${String.fromCodePoint(0xfc)}` }, [['invalid_format', 'puid']]),
  bad('puid-inner-newline', { puid: 'a\nb' }, [['invalid_format', 'puid']]),
  bad('puid-501', { puid: s(501, 'x') }, [['too_long', 'puid']]),
  bad('puid-number', { puid: 1001 }, [['invalid_type', 'puid']]),

  // Lengths
  bad('facts-5001', { decision_facts: s(5001) }, [['too_long', 'decision_facts']]),
  bad('facts-5001-code-points', { decision_facts: emoji.repeat(5001) }, [['too_long', 'decision_facts']]),
  bad('legal-ground-501', { illegal_content_legal_ground: s(501) }, [['too_long', 'illegal_content_legal_ground']]),
  bad('explanation-2001', { illegal_content_explanation: s(2001) }, [['too_long', 'illegal_content_explanation']]),
  bad('visibility-other-501', { decision_visibility: ['DECISION_VISIBILITY_OTHER'], decision_visibility_other: s(501) }, [['too_long', 'decision_visibility_other']]),
  bad('source-identity-501', { source_identity: s(501) }, [['too_long', 'source_identity']]),
  bad('keyword-other-501', { category_specification: ['KEYWORD_OTHER'], category_specification_other: s(501) }, [['too_long', 'category_specification_other']]),
  bad('url-501', { decision_ground_reference_url: `https://example.com/${s(481)}` }, [['too_long', 'decision_ground_reference_url']]),
  bad('facts-number', { decision_facts: 12345 }, [['invalid_type', 'decision_facts']]),
  bad('facts-lone-surrogate', { decision_facts: `Facts ${String.fromCharCode(0xd800)} more` }, [['invalid_format', 'decision_facts']]),
  bad('facts-lone-low-surrogate', { decision_facts: `${String.fromCharCode(0xdc00)}x` }, [['invalid_format', 'decision_facts']]),

  // Enumerations
  bad('ground-label-not-key', { decision_ground: 'Illegal content' }, [['invalid_value', 'decision_ground']]),
  bad('ground-lowercase', { decision_ground: 'decision_ground_illegal_content' }, [['invalid_value', 'decision_ground']]),
  bad('detection-lowercase', { automated_detection: 'yes' }, [['invalid_value', 'automated_detection']]),
  bad('detection-boolean', { automated_detection: true }, [['invalid_type', 'automated_detection']]),
  bad('decision-string-null', { decision_monetary: 'null' }, [['invalid_value', 'decision_monetary']]),
  bad('content-type-not-list', { content_type: 'CONTENT_TYPE_TEXT' }, [['invalid_type', 'content_type']]),
  bad('content-type-number', { content_type: [1] }, [['invalid_type', 'content_type']]),
  bad('content-type-unknown', { content_type: ['CONTENT_TYPE_GIF'] }, [['invalid_value', 'content_type']]),
  bad('content-type-object', { content_type: { a: 'CONTENT_TYPE_TEXT' } }, [['invalid_type', 'content_type']]),
  bad('list-empty-element', { content_type: ['CONTENT_TYPE_TEXT', ''] }, [['invalid_value', 'content_type']]),
  bad('territory-lowercase', { territorial_scope: ['lt'] }, [['invalid_value', 'territorial_scope']]),
  bad('territory-gb', { territorial_scope: ['GB'] }, [['invalid_value', 'territorial_scope']]),
  bad('territory-ch', { territorial_scope: ['CH'] }, [['invalid_value', 'territorial_scope']]),
  bad('territory-el', { territorial_scope: ['EL'] }, [['invalid_value', 'territorial_scope']]),
  bad('language-lowercase', { content_language: 'lt' }, [['invalid_value', 'content_language']]),
  bad('language-three-letter', { content_language: 'LIT' }, [['invalid_value', 'content_language']]),
  bad('removed-v1-category', { category: 'STATEMENT_CATEGORY_PORNOGRAPHY_OR_SEXUALIZED_CONTENT' }, [['invalid_value', 'category']]),
  bad('removed-v1-keyword', { category_specification: ['KEYWORD_DANGEROUS_TOYS'] }, [['invalid_value', 'category_specification']]),
  bad('incompatible-illegal-invalid', { ...incompatible, incompatible_content_illegal: 'Maybe' }, [['invalid_value', 'incompatible_content_illegal']]),

  // Dates
  bad('date-no-padding', { content_date: '2026-1-01' }, [['invalid_date', 'content_date']]),
  bad('date-feb-30', { content_date: '2026-02-30' }, [['invalid_date', 'content_date']]),
  bad('date-not-leap', { content_date: '2023-02-29' }, [['invalid_date', 'content_date']]),
  bad('date-month-13', { content_date: '2026-13-01' }, [['invalid_date', 'content_date']]),
  bad('date-day-0', { content_date: '2026-01-00' }, [['invalid_date', 'content_date']]),
  bad('date-two-digit-year', { content_date: '26-01-01' }, [['invalid_date', 'content_date']]),
  bad('date-with-time', { application_date: '2026-10-02T00:00:00Z' }, [['invalid_date', 'application_date']]),
  bad('date-number', { content_date: 20261001 }, [['invalid_type', 'content_date']]),
  bad('content-date-too-early', { content_date: '1999-12-31' }, [['date_out_of_range', 'content_date']]),
  bad('application-date-too-early', { application_date: '2019-12-31' }, [['date_out_of_range', 'application_date']]),
  bad('application-date-too-late', { application_date: '2038-01-02' }, [['date_out_of_range', 'application_date']]),
  bad('end-date-too-late', { end_date_visibility_restriction: '2038-01-02' }, [['date_out_of_range', 'end_date_visibility_restriction']]),

  // URLs (Rationale accepts a subset of the server's url rule)
  bad('url-ftp', { decision_ground_reference_url: 'ftp://example.com/terms' }, [['invalid_format', 'decision_ground_reference_url']]),
  bad('url-space', { decision_ground_reference_url: 'https://exa mple.com' }, [['invalid_format', 'decision_ground_reference_url']]),
  bad('url-javascript', { decision_ground_reference_url: ['java', 'script:alert(1)'].join('') }, [['invalid_format', 'decision_ground_reference_url']]),
  bad('url-credentials', { decision_ground_reference_url: 'https://user:pass@example.com/' }, [['invalid_format', 'decision_ground_reference_url']]),
  bad('url-raw-unicode', { decision_ground_reference_url: `https://example.com/${String.fromCodePoint(0xfc)}` }, [['invalid_format', 'decision_ground_reference_url']]),
  bad('url-bad-tld', { decision_ground_reference_url: 'https://example.b-c' }, [['invalid_format', 'decision_ground_reference_url']]),
  bad('url-relative', { decision_ground_reference_url: '/terms' }, [['invalid_format', 'decision_ground_reference_url']]),

  // Content identifier
  bad('ean-short', { content_id: { 'EAN-13': '123' } }, [['invalid_format', 'content_id.EAN-13']]),
  bad('ean-number', { content_id: { 'EAN-13': 4006381333931 } }, [['invalid_type', 'content_id.EAN-13']]),
  bad('ean-letters', { content_id: { 'EAN-13': '400638133393X' } }, [['invalid_format', 'content_id.EAN-13']]),
  bad('content-id-other-key', { content_id: { UPC: '036000291452' } }, [['unknown_attribute', 'content_id.UPC']]),
  bad('content-id-string', { content_id: '4006381333931' }, [['invalid_type', 'content_id']]),
  bad('content-id-list', { content_id: ['4006381333931'] }, [['invalid_type', 'content_id']]),
  ok('content-id-empty', { content_id: {} }, { expect: { ok: true, normalized: { content_id: null } } }),

  // Several errors at once
  {
    id: 'empty-object',
    input: {},
    expect: {
      ok: false,
      errors: [
        ['required', 'decision_ground'],
        ['required', 'content_type'],
        ['required', 'category'],
        ['required', 'content_date'],
        ['required', 'application_date'],
        ['required', 'decision_facts'],
        ['required', 'source_type'],
        ['required', 'automated_detection'],
        ['required', 'automated_decision'],
        ['required', 'puid'],
        ['decision_required', 'decision_visibility'],
      ],
    },
  },
];

// Edge cases checked against the server's own rules: each statement below was
// run through StatementStoreRequest and GroupedSubmissionsService (Laravel
// v12.68.0 with the TrimStrings and ConvertEmptyStringsToNull middleware) at
// the pinned commit. "ok" cases pass both endpoints in their normalised form;
// error cases fail on the server too, or (marked) Rationale is stricter.
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
const voluntary: Record<string, Json> = { source_type: 'SOURCE_VOLUNTARY' };
cases.push(
  // Laravel's url rule (Str::isUrl): single labels, trailing dots and unchecked IPv4 octets pass.
  ok('server-url-single-label', { decision_ground_reference_url: 'http://a' }),
  ok('server-url-trailing-dot', { decision_ground_reference_url: 'http://example.com.' }),
  ok('server-url-ipv4-octets-unchecked', { decision_ground_reference_url: 'http://999.999.999.999' }),
  ok('server-url-query-brackets', { decision_ground_reference_url: 'https://example.com/?q=[1]' }),
  ok('server-url-idn-tld', { decision_ground_reference_url: 'https://a.xn--p1ai' }),
  bad('server-url-empty-label', { decision_ground_reference_url: 'http://example..com' }, [['invalid_format', 'decision_ground_reference_url']]),
  bad('server-url-leading-dot', { decision_ground_reference_url: 'http://.example.com' }, [['invalid_format', 'decision_ground_reference_url']]),
  bad('server-url-hyphen-tld', { decision_ground_reference_url: 'https://a.b-' }, [['invalid_format', 'decision_ground_reference_url']]),
  bad('server-url-two-fragments', { decision_ground_reference_url: 'https://example.com/#a#b' }, [['invalid_format', 'decision_ground_reference_url']]),
  bad('server-url-bad-percent', { decision_ground_reference_url: 'https://example.com/%zz' }, [['invalid_format', 'decision_ground_reference_url']]),
  bad('server-url-percent-in-host', { decision_ground_reference_url: 'https://ex%41mple.com/' }, [['invalid_format', 'decision_ground_reference_url']]),
  bad('server-url-empty-port', { decision_ground_reference_url: 'https://example.com:/' }, [['invalid_format', 'decision_ground_reference_url']]),
  // PUID regex /^[a-zA-Z0-9-_]+$/D: ASCII only, no line break before the end; trimmed first.
  ok('server-puid-dash-only', { puid: '-' }),
  ok('server-puid-underscore-only', { puid: '_' }),
  ok('server-puid-trailing-nul-trimmed', { puid: `abc${cp(0)}` }, { expect: { ok: true, normalized: { puid: 'abc' } } }),
  ok('server-puid-bom-trimmed', { puid: `${cp(0xfeff)}abc` }, { expect: { ok: true, normalized: { puid: 'abc' } } }),
  bad('server-puid-non-ascii-letter', { puid: `${cp(0xc4)}BC` }, [['invalid_format', 'puid']]),
  bad('server-puid-non-ascii-digits', { puid: cp(0x661, 0x662, 0x663) }, [['invalid_format', 'puid']]),
  bad('server-puid-inner-line-break', { puid: 'a\nb' }, [['invalid_format', 'puid']]),
  // date_format:Y-m-d plus the inclusive bounds.
  bad('server-date-1900-not-leap', { content_date: '1900-02-29' }, [['invalid_date', 'content_date']]),
  bad('server-date-fullwidth-digits', { content_date: `${cp(0xff12, 0xff10, 0xff12, 0xff14)}-01-01` }, [['invalid_date', 'content_date']]),
  bad('server-application-date-2000', { content_date: '2000-02-29', application_date: '2000-02-29' }, [['date_out_of_range', 'application_date']]),
  ok('server-end-date-year-zero', { end_date_service_restriction: '0000-01-01' }, { expect: { ok: true, warnings: [['end_date_before_application_date', 'end_date_service_restriction']] } }),
  // max counts code points after trimming; combining marks count, C0 separators are not trimmed.
  ok('server-length-combining-5000', { decision_facts: `e${cp(0x301)}`.repeat(2500) }),
  bad('server-length-combining-5002', { decision_facts: `e${cp(0x301)}`.repeat(2501) }, [['too_long', 'decision_facts']]),
  ok('server-trim-nel', { decision_facts: `${cp(0x85)}${s(5000)}` }, { expect: { ok: true, normalized: { decision_facts: s(5000) } } }),
  ok('server-trim-soft-hyphen', { decision_facts: `${cp(0xad)}${s(5000)}` }, { expect: { ok: true, normalized: { decision_facts: s(5000) } } }),
  ok('server-trim-mongolian-vowel-separator', { decision_facts: `${cp(0x180e)}${s(5000)}` }, { expect: { ok: true, normalized: { decision_facts: s(5000) } } }),
  bad('server-no-trim-file-separator', { decision_facts: `${cp(0x1c)}${s(5000)}` }, [['too_long', 'decision_facts']]),
  bad('server-no-trim-unit-separator', { decision_facts: `${cp(0x1f)}${s(5000)}` }, [['too_long', 'decision_facts']]),
  // max:500 runs before the exclusion for these attributes, so the server rejects them although it would drop them.
  bad('server-visibility-other-too-long-when-excluded', { decision_visibility_other: s(501) }, [['too_long', 'decision_visibility_other']]),
  bad('server-source-identity-too-long-when-voluntary', { ...voluntary, source_identity: s(501) }, [['too_long', 'source_identity']]),
  bad('server-keyword-other-too-long-when-excluded', { category_specification_other: s(501) }, [['too_long', 'category_specification_other']]),
  // The server rejects explicit nulls here; Rationale drops them, and the normalised statement passes.
  ok('server-null-incompatible-illegal-dropped', { incompatible_content_illegal: null }, { expect: { ok: true, normalized: { incompatible_content_illegal: null } } }),
  ok('server-empty-ean-dropped', { content_id: { 'EAN-13': '' } }, { expect: { ok: true, normalized: { content_id: null } } }),
  // Territorial scope accepts EEA codes, trims elements, nothing else.
  ok('server-territorial-eea', { territorial_scope: ['IS', 'LI', 'NO'] }),
  ok('server-territorial-trimmed', { territorial_scope: [' LT '] }, { expect: { ok: true, normalized: { territorial_scope: ['LT'] } } }),
  bad('server-territorial-switzerland', { territorial_scope: ['CH'] }, [['invalid_value', 'territorial_scope']]),
  bad('server-territorial-lower-case', { territorial_scope: ['lt'] }, [['invalid_value', 'territorial_scope']]),
  bad('server-territorial-empty-element', { territorial_scope: [''] }, [['invalid_value', 'territorial_scope']]),
  bad('server-language-lower-case', { content_language: 'en' }, [['invalid_value', 'content_language']]),
  bad('server-detection-lower-case', { automated_detection: 'yes' }, [['invalid_value', 'automated_detection']]),
  // Rationale is stricter: the server accepts the string "null" in these in: rules.
  bad('stricter-null-string-in-list', { decision_visibility: ['null'] }, [['invalid_value', 'decision_visibility']]),
);

// Every allowed value of every enumeration is accepted (with the companion
// attributes the rules require), and its lower-case form is not.
const companions: Record<string, Record<string, Json>> = {
  DECISION_VISIBILITY_OTHER: { decision_visibility_other: 'Other restriction' },
  DECISION_MONETARY_OTHER: { decision_monetary_other: 'Other restriction' },
  CONTENT_TYPE_OTHER: { content_type_other: 'Other type' },
  DECISION_GROUND_INCOMPATIBLE_CONTENT: incompatible,
};
for (const [name, spec] of Object.entries(schema.attributes)) {
  if (spec.values === undefined) continue;
  for (const v of spec.values) {
    const value: Json = spec.kind === 'enum-list' ? [v] : v;
    const extra = companions[v] ?? {};
    const patch: Record<string, Json> = { ...extra, [name]: value };
    if (name === 'incompatible_content_illegal') Object.assign(patch, incompatible, { [name]: value });
    cases.push({ id: `enum-${name}-${v}`, patch, expect: { ok: true } });
  }
  const first = spec.values[0];
  if (first !== undefined && first.toLowerCase() !== first) {
    const patch: Record<string, Json> = { [name]: spec.kind === 'enum-list' ? [first.toLowerCase()] : first.toLowerCase() };
    if (name === 'incompatible_content_illegal') Object.assign(patch, incompatible, { [name]: first.toLowerCase() });
    cases.push({ id: `enum-${name}-lowercase`, patch, expect: { ok: false, errors: [['invalid_value', name]] } });
  }
}

const batches = [
  {
    id: 'duplicate-puid-in-batch',
    inputs: [base, { ...base }, { ...base, puid: 'listing-1002' }],
    expect: [{ ok: true }, { ok: false, errors: [['duplicate_puid', 'puid']] }, { ok: true }],
  },
  {
    id: 'duplicate-after-trim',
    inputs: [base, { ...base, puid: ' listing-1001 ' }],
    expect: [{ ok: true }, { ok: false, errors: [['duplicate_puid', 'puid']] }],
  },
];

/** JSON with every non-ASCII character escaped, so the file holds no invisible characters. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value, null, 1).replace(/[^\x20-\x7e\n]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const out = {
  $comment: 'Shared test vectors for the TypeScript and Python validators. Generated by scripts/generate-vectors.ts. Each case is the base statement with "patch" applied (null means: set to null) and "unset" removed, or "input" as is. Errors and warnings are [code, attribute] pairs, compared as sorted lists. In "normalized", null means the attribute must be absent.',
  schemaVersion: schema.schemaVersion,
  base,
  cases,
  batches,
};
writeFileSync(`${root}test-vectors/statements.json`, `${asciiJson(out)}\n`);
console.error(`wrote ${cases.length} cases and ${batches.length} batches`);
