/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A heuristic check for obvious personal data in free text. Article 24(5)
 * DSA requires providers to ensure that the information they submit does
 * not contain personal data. These patterns catch only common, obvious
 * forms (email addresses, international phone numbers, IPv4 addresses,
 * IBAN-like account numbers). A clean result does not mean a text contains
 * no personal data.
 *
 * Every pattern has bounded repetition so the scan stays linear in the
 * input length. The Python package uses the same patterns.
 */

/** Kinds of personal data the heuristic looks for. */
export type PersonalDataKind = 'email' | 'phone' | 'ipv4' | 'iban';

const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';

/** Patterns, shared verbatim with the Python package (rationale/_personal_data.py). */
export const PERSONAL_DATA_PATTERNS: readonly (readonly [PersonalDataKind, RegExp])[] = [
  ['email', /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/],
  ['phone', /(?<![A-Za-z0-9+])\+[0-9](?:[ ./()-]?[0-9]){7,14}(?![0-9])/],
  ['ipv4', new RegExp(`(?<![0-9.])${OCTET}(?:\\.${OCTET}){3}(?![0-9]|\\.[0-9])`)],
  ['iban', /(?<![A-Za-z0-9])[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?(?![A-Za-z0-9])/],
];

/** Returns the kinds of personal data the heuristic finds in a text, in pattern order. */
export function findPersonalData(text: string): PersonalDataKind[] {
  return PERSONAL_DATA_PATTERNS.filter(([, re]) => re.test(text)).map(([kind]) => kind);
}
