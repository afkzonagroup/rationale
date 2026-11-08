/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Stats } from 'node:fs';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { resolveBaseUrl } from '../src/config.js';
import { redact } from '../src/errors.js';
import { parseJsonSafe, sanitizeJson, sendRequest } from '../src/http.js';
import { checkExisting } from '../src/node/safe-file.js';
import { findPersonalData } from '../src/personal-data.js';
import { RateLimiter, systemClock, type Clock } from '../src/rate-limit.js';
import { backoffDelay, isRetryableStatus, parseRetryAfter, resolveRetry } from '../src/retry.js';
import { codePointLength, isIsoDate, isServerUrl, quote, serverTrim, toIsoDate } from '../src/text.js';
import { Secret, assertTokenSource, readToken } from '../src/token.js';

describe('base URL allow-list', () => {
  it('fixes production and requires explicit opt-in', () => {
    expect(() => resolveBaseUrl({ environment: 'production' })).toThrow(/allowProduction/);
    expect(resolveBaseUrl({ environment: 'production', allowProduction: true })).toBe('https://transparency.dsa.ec.europa.eu');
    expect(() => resolveBaseUrl({ environment: 'production', allowProduction: true, sandboxBaseUrl: 'https://x.europa.eu' })).toThrow();
  });

  it('accepts only HTTPS hosts under europa.eu for the sandbox', () => {
    expect(resolveBaseUrl({ environment: 'sandbox', sandboxBaseUrl: 'https://Sandbox.Transparency.Example.europa.eu/' })).toBe('https://sandbox.transparency.example.europa.eu');
    for (const bad of [
      'http://sandbox.europa.eu',
      'https://europa.eu.attacker.example',
      'https://attacker.example/europa.eu',
      'https://sandbox.europa.eu.',
      'https://evil-europa.eu',
      'https://sandbox.europa.eu:8443',
      'https://user:pw@sandbox.europa.eu',
      'https://sandbox.europa.eu/api',
      'https://sandbox.europa.eu?x=1',
      'https://sandbox.europa.eu#x',
      'https://10.0.0.1',
      'https://[::1]',
      'https://transparency.dsa.ec.europa.eu',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(() => resolveBaseUrl({ environment: 'sandbox', sandboxBaseUrl: bad }), bad).toThrow();
    }
    expect(() => resolveBaseUrl({ environment: 'sandbox' })).toThrow(/required/);
  });

  it('accepts only loopback literals for local mode', () => {
    expect(resolveBaseUrl({ environment: 'local', localBaseUrl: 'http://127.0.0.1:8080' })).toBe('http://127.0.0.1:8080');
    expect(resolveBaseUrl({ environment: 'local', localBaseUrl: 'http://[::1]:8080/' })).toBe('http://[::1]:8080');
    for (const bad of ['http://localhost:8080', 'http://127.0.0.2', 'http://169.254.169.254', 'http://example.com', 'http://0.0.0.0:80', 'ftp://127.0.0.1']) {
      expect(() => resolveBaseUrl({ environment: 'local', localBaseUrl: bad }), bad).toThrow();
    }
  });

  it('rejects unknown environments', () => {
    expect(() => resolveBaseUrl({ environment: 'staging' as 'sandbox' })).toThrow(/environment/);
  });
});

describe('token handling', () => {
  it('accepts env and function sources only', () => {
    expect(() => { assertTokenSource({ env: 'TOKEN' }); }).not.toThrow();
    expect(() => { assertTokenSource(() => 'x'); }).not.toThrow();
    expect(() => { assertTokenSource('secret'); }).toThrow(/not as a string/);
    expect(() => { assertTokenSource({ env: 'bad name' }); }).toThrow();
    expect(() => { assertTokenSource(null); }).toThrow();
  });

  it('never prints a Secret', () => {
    const s = new Secret('topsecret');
    expect(String(s)).toBe('[REDACTED]');
    expect(JSON.stringify({ s })).toBe('{"s":"[REDACTED]"}');
    expect(inspect(s)).not.toContain('topsecret');
    expect(s.reveal()).toBe('topsecret');
  });

  it('validates token content', async () => {
    await expect(readToken({ env: 'T' }, { T: '  abc|123  ' })).resolves.toBeInstanceOf(Secret);
    await expect(readToken({ env: 'T' }, {})).rejects.toThrow(/not set/);
    await expect(readToken({ env: 'T' }, { T: 'a b' })).rejects.toThrow(/not allowed/);
    await expect(readToken({ env: 'T' }, { T: `a${String.fromCodePoint(0xe9)}` })).rejects.toThrow(/not allowed/);
    await expect(readToken({ env: 'T' }, { T: 'x'.repeat(5000) })).rejects.toThrow(/too long/);
    await expect(readToken(() => Promise.reject(new Error('vault down: secret=abc')), {})).rejects.toThrow('The token function failed.');
    await expect(readToken(() => 42 as unknown as string, {})).rejects.toThrow(/string/);
  });

  it('redacts secrets and bearer values from text', () => {
    expect(redact('a abcd1234 b', ['abcd1234'])).toBe('a [REDACTED] b');
    expect(redact('Authorization: Bearer xyz.123')).toBe('Authorization: Bearer [REDACTED]');
    expect(redact('short ab', ['ab'])).toBe('short ab');
  });
});

describe('safe JSON parsing', () => {
  it('drops prototype keys and creates prototype-free objects', () => {
    const v = parseJsonSafe('{"a":{"__proto__":{"x":1},"constructor":{"prototype":{"y":1}},"ok":[{"prototype":1,"z":2}]}}') as Record<string, Record<string, unknown>>;
    expect(Object.getPrototypeOf(v)).toBeNull();
    expect(Object.keys(v['a'] ?? {})).toEqual(['ok']);
    expect((v['a']?.['ok'] as Record<string, unknown>[])[0]).toEqual(Object.assign(Object.create(null) as object, { z: 2 }));
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });

  it('returns undefined for invalid JSON and rejects deep nesting', () => {
    expect(parseJsonSafe('{')).toBeUndefined();
    expect(() => sanitizeJson(JSON.parse(`${'['.repeat(100)}${']'.repeat(100)}`))).toThrow(/nested/);
  });
});

describe('retry policy', () => {
  const r = resolveRetry();
  it('has documented defaults and bounds', () => {
    expect(r).toEqual({ maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 30_000, maxRetryAfterMs: 120_000 });
    expect(() => resolveRetry({ maxAttempts: 21 })).toThrow();
    expect(() => resolveRetry({ baseDelayMs: Number.NaN })).toThrow();
  });

  it('retries only transient statuses', () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true);
    for (const s of [200, 201, 301, 302, 400, 401, 403, 404, 405, 413, 415, 422, 501]) expect(isRetryableStatus(s)).toBe(false);
  });

  it('uses exponential backoff with full jitter, capped', () => {
    expect([1, 2, 3, 4].map((a) => backoffDelay(a, r, () => 0.999999))).toEqual([499, 999, 1999, 3999]);
    expect(backoffDelay(30, r, () => 0.999999)).toBe(29_999);
    expect(backoffDelay(3, r, () => 0)).toBe(0);
    expect(backoffDelay(2, r, () => 2)).toBe(1000);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    const now = Date.parse('Sun, 08 Nov 2026 10:00:00 GMT');
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
    expect(parseRetryAfter('Sun, 08 Nov 2026 10:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Sun, 08 Nov 2026 09:00:00 GMT', now)).toBe(0);
    for (const bad of [undefined, '', '-1', '1.5', 'soon', '12345678901', 'Sun, 08 Nov 2026']) expect(parseRetryAfter(bad, now)).toBeUndefined();
  });
});

describe('system clock', () => {
  it('sleeps and can be aborted', async () => {
    const t0 = Date.now();
    await systemClock.sleep(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
    const ctl = new AbortController();
    const p = systemClock.sleep(10_000, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toThrow('aborted');
    await expect(systemClock.sleep(10, ctl.signal)).rejects.toThrow('aborted');
  });
});

describe('rate limiter', () => {
  it('allows the limit per window and waits for the oldest request to expire', async () => {
    let now = 0;
    const waits: number[] = [];
    const clock: Clock = { now: () => now, sleep: (ms) => ((now += ms), waits.push(ms), Promise.resolve()) };
    const l = new RateLimiter([{ limit: 2, intervalMs: 1000 }, { limit: 3, intervalMs: 60_000 }], clock);
    await l.acquire();
    await l.acquire();
    expect(waits).toEqual([]);
    await l.acquire();
    expect(waits).toEqual([1000]);
    await l.acquire();
    expect(now).toBe(60_000);
    expect(() => new RateLimiter([{ limit: 0, intervalMs: 1 }])).toThrow();
  });
});

describe('text helpers', () => {
  it('trims like the server, including astral and invisible characters', () => {
    expect(serverTrim(`${String.fromCodePoint(0x1d159, 0xa0)}x y${String.fromCodePoint(0x3000, 0xe0020)}`)).toBe('x y');
    expect(serverTrim(`${String.fromCodePoint(0x1f600)} `)).toBe(String.fromCodePoint(0x1f600));
    expect(serverTrim('')).toBe('');
    expect(serverTrim(String.fromCodePoint(0x200b, 0x200b))).toBe('');
  });

  it('counts code points like mb_strlen', () => {
    expect(codePointLength('abc')).toBe(3);
    expect(codePointLength(String.fromCodePoint(0x1f600, 0x1f600))).toBe(2);
    expect(codePointLength('\ud800x')).toBe(2);
  });

  it('checks real calendar dates', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2000-02-29')).toBe(true);
    expect(isIsoDate('1900-02-29')).toBe(false);
    expect(isIsoDate('2026-04-31')).toBe(false);
    expect(toIsoDate(new Date('2026-11-08T23:30:00Z'))).toBe('2026-11-08');
    expect(() => toIsoDate(new Date('x'))).toThrow();
  });

  it('accepts only server-acceptable http(s) URLs', () => {
    expect(isServerUrl('https://a')).toBe(true);
    expect(isServerUrl('HTTPS://EXAMPLE.COM/A')).toBe(true);
    expect(isServerUrl('https://1.2.3.4:8080/x')).toBe(true);
    expect(isServerUrl('https://example.com/a b')).toBe(false);
    expect(isServerUrl('https://example.com\\@evil')).toBe(false);
    expect(isServerUrl('https://[::1]/')).toBe(false);
  });

  it('quotes values safely and briefly', () => {
    expect(quote('a"b')).toBe('"a\\"b"');
    expect(quote('x'.repeat(100))).toBe(`"${'x'.repeat(60)}..."`);
    expect(quote(undefined)).toBe('"undefined"');
    expect(quote({ a: 1 })).toBe('"{\\"a\\":1}"');
  });

  it('escapes terminal and bidirectional control characters when quoting', () => {
    const hostile = `a${String.fromCharCode(0x1b)}[2J${String.fromCharCode(0x9b)}31m${String.fromCharCode(0x202e)}b${String.fromCharCode(0x2066)}${String.fromCharCode(0x200b)}`;
    const q = quote(hostile, 100);
    // eslint-disable-next-line no-control-regex -- the test checks that no control characters remain
    expect(q).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/);
    expect(q).toContain('\\u009b');
    expect(q).toContain('\\u202e');
  });
});

describe('safe files and responses', () => {
  it('refuses files owned by another user or writable by others', () => {
    const me = process.getuid?.() ?? 0;
    const fake = (uid: number, mode: number): Stats => ({ isSymbolicLink: () => false, isFile: () => true, uid, mode }) as unknown as Stats;
    expect(() => {
      checkExisting(fake(me, 0o100600));
    }).not.toThrow();
    expect(() => {
      checkExisting(fake(me + 1, 0o100600));
    }).toThrow(/another user/);
    expect(() => {
      checkExisting(fake(me, 0o100620));
    }).toThrow(/writable by other users/);
  });

  it('refuses a declared oversize response without reading its body', async () => {
    const neverEnds = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
    const fetchFn = (): Promise<Response> => Promise.resolve(new Response(neverEnds, { status: 201, headers: { 'content-length': '100000000', 'content-type': 'application/json' } }));
    const req = { method: 'POST' as const, url: 'http://127.0.0.1:1/x', token: new Secret('tok-1234'), body: '{}', timeoutMs: 2000, maxResponseBytes: 1000 };
    await expect(sendRequest(fetchFn, req)).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('never sends cookies or follows redirects, and asks for no caching', async () => {
    let init: RequestInit | undefined;
    const fetchFn = (_u: string, i: RequestInit): Promise<Response> => {
      init = i;
      return Promise.resolve(new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } }));
    };
    await sendRequest(fetchFn, { method: 'GET', url: 'http://127.0.0.1:1/x', token: new Secret('tok-1234'), timeoutMs: 1000, maxResponseBytes: 1000 });
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual', cache: 'no-store' });
  });
});

describe('personal data heuristic', () => {
  it('finds common forms', () => {
    expect(findPersonalData('mail a.b+c@sub.example.co.uk now')).toEqual(['email']);
    expect(findPersonalData('call +44 20 7946 0958')).toEqual(['phone']);
    expect(findPersonalData('from 10.0.0.1')).toEqual(['ipv4']);
    expect(findPersonalData('DE89 3704 0044 0532 0130 00')).toEqual(['iban']);
  });

  it('avoids common false positives', () => {
    for (const t of ['Article 17(3)(b)', 'version 1.2.3.4.5', 'score 999.1.1.1', '@handle', 'price +5', 'ISO 3166-1', 'a@b']) expect(findPersonalData(t), t).toEqual([]);
  });

  it('stays fast on long hostile input', () => {
    const t0 = performance.now();
    findPersonalData(`${'a'.repeat(5000)}@`);
    findPersonalData('+1'.repeat(2500));
    findPersonalData('1.'.repeat(2500));
    findPersonalData('AB12 '.repeat(1000));
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
