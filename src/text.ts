/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/** Small pure helpers shared by validation, the CLI and the client. */

import { TRIM_CODE_POINTS } from './schema.js';

/**
 * Strips the characters the server strips (Laravel TrimStrings with
 * Str::trim) from both ends of a string.
 */
export function serverTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end) {
    const cp = value.codePointAt(start) ?? 0;
    if (!TRIM_CODE_POINTS.has(cp)) break;
    start += cp > 0xffff ? 2 : 1;
  }
  while (end > start) {
    // Step back over a surrogate pair as one code point.
    const low = value.charCodeAt(end - 1);
    const pair = low >= 0xdc00 && low <= 0xdfff && end - 2 >= start;
    const cp = pair ? (value.codePointAt(end - 2) ?? low) : low;
    const width = pair && cp > 0xffff ? 2 : 1;
    if (!TRIM_CODE_POINTS.has(cp)) break;
    end -= width;
  }
  return value.slice(start, end);
}

/**
 * True if the string has no lone UTF-16 surrogates. A lone surrogate cannot
 * be encoded as UTF-8, and the server fails to decode the whole request body
 * (so every statement in the batch would be rejected).
 */
export function isWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = value.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Length in Unicode code points, as PHP's mb_strlen counts it. */
export function codePointLength(value: string): number {
  let n = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length) {
      const d = value.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** True for objects created by JSON.parse or object literals (no class instances, no arrays). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Own enumerable property, read without touching the prototype chain. */
export function ownValue(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written as YYYY-MM-DD (PHP date_format:Y-m-d). */
export function isIsoDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] ?? 0;
  return d <= days;
}

/** Formats a Date as YYYY-MM-DD in UTC. */
export function toIsoDate(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid date');
  return date.toISOString().slice(0, 10);
}

/**
 * HTTP(S) URLs in the subset of the server's `url` rule (Laravel Str::isUrl,
 * derived from Symfony's UrlValidator) that uses ASCII only: no user info,
 * no IPv6 literals, no raw non-ASCII characters (percent-encode them).
 * Every URL accepted here is accepted by the server.
 */
const URL_RE =
  /^https?:\/\/(?:(?:(?:[a-z0-9_-]+\.)+(?:xn--[a-z0-9-]+|[a-z0-9]+)|[a-z0-9_-]+)\.?|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::[0-9]+)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*(?:\?(?:[a-z0-9\-._~!$&'[\]()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;

/** True if the server's `url` rule accepts the value (see URL_RE). */
export function isServerUrl(value: string): boolean {
  return URL_RE.test(value);
}

/** Quotes a value for an error message, shortened, without control characters. */
export function quote(value: unknown, max = 60): string {
  const s = typeof value === 'string' ? value : value === undefined || typeof value === 'function' || typeof value === 'symbol' ? String(value) : JSON.stringify(value);
  const cut = codePointLength(s) > max ? `${Array.from(s).slice(0, max).join('')}...` : s;
  // JSON.stringify escapes C0 controls only; also escape C1 controls (U+009B starts a terminal
  // control sequence), bidirectional controls, zero-width characters and line separators.
  return JSON.stringify(cut).replace(UNSAFE_DISPLAY, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const UNSAFE_DISPLAY = /[\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;
