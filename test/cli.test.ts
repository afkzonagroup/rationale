/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/cli/csv.js';
import { main, type CliIo } from '../src/cli/main.js';
import { applyMapping, identityMapping, parseMapping } from '../src/cli/mapping.js';
import { MOCK_TOKEN, startMock, type MockApi } from './helpers/mock-server.js';
import { validStatement, VECTORS } from './helpers/vectors.js';

let dir: string;
let api: MockApi;
let url: string;
let out: string;
let err: string;

const io = (env: Record<string, string> = { RATIONALE_API_TOKEN: MOCK_TOKEN }): CliIo => ({
  stdout: (t) => (out += t),
  stderr: (t) => (err += t),
  env,
  clientOverrides: { clock: { now: () => Date.now(), sleep: () => Promise.resolve() }, retry: { maxAttempts: 2 } },
});
const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const write = (name: string, text: string): string => {
  const p = join(dir, name);
  writeFileSync(p, text, { mode: 0o600 });
  return p;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rationale-cli-'));
  chmodSync(dir, 0o700);
  ({ api, url } = await startMock());
  out = '';
  err = '';
});
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await api.stop();
});

describe('rationale validate', () => {
  it('reports invalid lines and exits 1', async () => {
    const f = write('in.jsonl', jsonl([validStatement('a'), { puid: 'b' }]) + 'not json\n');
    expect(await main(['validate', f], io())).toBe(1);
    expect(out).toContain('line 2: error required decision_ground');
    expect(out).toContain('line 3: error invalid_input: not valid JSON');
    expect(err).toContain('3 statements, 1 valid, 2 invalid');
  });

  it('never prints terminal or bidirectional control characters from the input', async () => {
    const esc = String.fromCharCode(0x1b);
    const key = `x${esc}]0;owned${String.fromCharCode(7)}${String.fromCharCode(0x9b)}2J${String.fromCharCode(0x202e)}`;
    const f = write('in.jsonl', jsonl([{ ...validStatement('a'), [key]: 1, content_id: { [key]: '1' } }, { ...validStatement('b'), puid: `p${esc}[2J${String.fromCharCode(0x2067)}` }]));
    expect(await main(['validate', f], io())).toBe(1);
    expect(await main(['submit', f, '--env', 'local', '--local-url', url], io())).toBe(1);
    // eslint-disable-next-line no-control-regex -- the test checks that no control characters remain
    expect(out.replace(/\n/g, '')).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/);
    expect(out).toContain('unknown_attribute "x');
  });

  it('exits 0 for valid input, and --strict turns warnings into errors', async () => {
    const f = write('in.jsonl', jsonl([validStatement('a', { source_identity: 'x', source_type: 'SOURCE_VOLUNTARY' })]));
    expect(await main(['validate', f], io())).toBe(0);
    expect(out).toContain('warning excluded_attribute source_identity');
    out = '';
    expect(await main(['validate', f, '--strict'], io())).toBe(1);
    expect(out).toContain('error excluded_attribute source_identity');
  });

  it('prints JSON lines with --json', async () => {
    const f = write('in.jsonl', jsonl([{ puid: 'b' }]));
    await main(['validate', f, '--json'], io());
    const line = JSON.parse(out.trim()) as { line: number; ok: boolean; errors: unknown[] };
    expect(line.line).toBe(1);
    expect(line.ok).toBe(false);
    expect(line.errors.length).toBeGreaterThan(0);
  });

  it('reads CSV with a mapping file', async () => {
    const csv = [
      'id,action,ground,law,why,kind,cat,posted,applied,facts,src,auto_detect,auto_decide,ean',
      'c-1,removed|demoted,illegal,"Act, art. 5","Prohibited ""product""",product,unsafe,2026-10-01,2026-10-02,A notice was checked.,notice,No,none,4006381333931',
      'c-2,removed,illegal,Act,Why,product,unsafe,2026-10-01,2026-10-02,Facts,notice,No,none,',
    ].join('\r\n');
    const mapping = {
      version: 1,
      fields: {
        puid: { column: 'id' },
        decision_visibility: { column: 'action', split: '|', map: { removed: 'DECISION_VISIBILITY_CONTENT_REMOVED', demoted: 'DECISION_VISIBILITY_CONTENT_DEMOTED' } },
        decision_ground: { column: 'ground', map: { illegal: 'DECISION_GROUND_ILLEGAL_CONTENT' } },
        illegal_content_legal_ground: { column: 'law' },
        illegal_content_explanation: { column: 'why' },
        content_type: { column: 'kind', map: { product: 'CONTENT_TYPE_PRODUCT' } },
        category: { column: 'cat', map: { unsafe: 'STATEMENT_CATEGORY_UNSAFE_AND_PROHIBITED_PRODUCTS' } },
        content_date: { column: 'posted' },
        application_date: { column: 'applied' },
        decision_facts: { column: 'facts' },
        source_type: { column: 'src', map: { notice: 'SOURCE_ARTICLE_16' } },
        automated_detection: { column: 'auto_detect' },
        automated_decision: { column: 'auto_decide', map: { none: 'AUTOMATED_DECISION_NOT_AUTOMATED' } },
        territorial_scope: { value: ['LT'] },
        'content_id.EAN-13': { column: 'ean' },
      },
    };
    const f = write('in.csv', csv);
    const m = write('map.json', JSON.stringify(mapping));
    expect(await main(['validate', f, '--mapping', m], io())).toBe(0);
    expect(err).toContain('2 statements, 2 valid');
  });

  it('reads CSV without a mapping when the header names attributes', async () => {
    const s = VECTORS.base;
    const cols = Object.keys(s);
    const cell = (v: unknown): string => (Array.isArray(v) ? v.join('|') : String(v));
    const f = write('plain.csv', `${cols.join(',')}\n${cols.map((c) => `"${cell(s[c])}"`).join(',')}\n`);
    expect(await main(['validate', f], io())).toBe(0);
    const bad = write('bad.csv', 'puid,unknown_column\nx,y\n');
    expect(await main(['validate', bad], io())).toBe(1);
    expect(err).toContain('not a statement attribute');
  });
});

describe('rationale submit', () => {
  const env = (): string[] => ['--env', 'local', '--local-url', url];

  it('submits through the batch endpoint and reports each line', async () => {
    const f = write('in.jsonl', jsonl([validStatement('s1'), validStatement('s2')]));
    expect(await main(['submit', f, ...env()], io())).toBe(0);
    expect(out).toMatch(/line 1: puid "s1" created [0-9a-f-]{36}/);
    expect(err).toContain('created 2, duplicate 0');
    expect(api.calls('/api/v1/statements')).toHaveLength(1);
  });

  it('dry run sends nothing and needs no token', async () => {
    const f = write('in.jsonl', jsonl([validStatement('s1')]));
    expect(await main(['submit', f, ...env(), '--dry-run'], io({}))).toBe(0);
    expect(out).toContain('valid (dry run, not sent)');
    expect(api.requests).toHaveLength(0);
  });

  it('uses a durable queue with --queue and keeps unsent statements', async () => {
    const f = write('in.jsonl', jsonl([validStatement('q1'), validStatement('q2')]));
    const q = join(dir, 'queue.jsonl');
    api.script.push({ status: 503, raw: 'down' }, { status: 503, raw: 'down' });
    expect(await main(['submit', f, ...env(), '--queue', q], io())).toBe(1);
    expect(err).toContain('pending 2');
    out = '';
    expect(await main(['queue', 'status', '--queue', q], io())).toBe(0);
    expect(out).toContain('pending 2, done 0');
    out = '';
    expect(await main(['queue', 'drain', '--queue', q, ...env()], io())).toBe(0);
    expect(out).toContain('created 2');
    out = '';
    expect(await main(['queue', 'compact', '--queue', q], io())).toBe(0);
    expect(out).toContain('kept 0 pending, dropped 2 settled');
  });

  it('requires explicit confirmation for production and never takes a token argument', async () => {
    const f = write('in.jsonl', jsonl([validStatement('p1')]));
    expect(await main(['submit', f, '--env', 'production'], io())).toBe(2);
    expect(err).toContain('--confirm-production');
    expect(await main(['submit', f, '--env', 'local', '--local-url', url, '--token', MOCK_TOKEN], io())).toBe(2);
    expect(await main(['submit', f, '--env', 'local', '--local-url', url, `--token=${MOCK_TOKEN}`], io())).toBe(2);
    expect(err).toContain('environment variable only');
    expect(out + err).not.toContain(MOCK_TOKEN);
    expect(api.requests).toHaveLength(0);
  });

  it('refuses non-allow-listed base URLs', async () => {
    const f = write('in.jsonl', jsonl([validStatement('p1')]));
    expect(await main(['submit', f, '--env', 'sandbox', '--sandbox-url', 'https://attacker.example'], io())).toBe(2);
    expect(await main(['submit', f, '--env', 'local', '--local-url', 'http://169.254.169.254'], io())).toBe(2);
    expect(api.requests).toHaveLength(0);
  });

  it('prints JSON outcomes, refuses warnings with --strict, and reports invalid lines with --queue', async () => {
    const f = write('in.jsonl', jsonl([validStatement('j1'), { puid: 'bad' }]));
    expect(await main(['submit', f, ...env(), '--json'], io())).toBe(1);
    const rows = out.trim().split('\n').map((l) => JSON.parse(l) as { line: number; status: string });
    expect(rows.map((r) => [r.line, r.status])).toEqual([
      [1, 'created'],
      [2, 'invalid'],
    ]);
    out = '';
    const w = write('warn.jsonl', jsonl([validStatement('j2', { source_type: 'SOURCE_VOLUNTARY', source_identity: 'x' })]));
    expect(await main(['submit', w, ...env(), '--strict'], io())).toBe(1);
    expect(err).toContain('nothing was sent');
    expect(api.calls('/api/v1/statements')).toHaveLength(1);
    out = '';
    const q = join(dir, 'q2.jsonl');
    const mixed = write('mixed.jsonl', `${jsonl([validStatement('j3'), { puid: 'bad' }])}{oops\n`);
    expect(await main(['submit', mixed, ...env(), '--queue', q], io())).toBe(1);
    expect(out).toContain('line 2: error required');
    expect(out).toContain('line 3: error invalid_input');
  });

  it('reads the token from a named variable', async () => {
    const f = write('in.jsonl', jsonl([validStatement('t1')]));
    expect(await main(['submit', f, ...env(), '--token-env', 'MY_TDB_TOKEN'], io({ MY_TDB_TOKEN: MOCK_TOKEN }))).toBe(0);
  });

  it('stops with a clear configuration error when the token is missing, before queueing or sending', async () => {
    const f = write('in.jsonl', jsonl([validStatement('t2')]));
    const q = join(dir, 'q.jsonl');
    expect(await main(['submit', f, ...env(), '--queue', q], io({}))).toBe(2);
    expect(err).toContain('Environment variable RATIONALE_API_TOKEN is not set');
    expect(existsSync(q)).toBe(false);
    expect(await main(['queue', 'drain', '--queue', q, ...env()], io({}))).toBe(2);
    expect(api.requests).toHaveLength(0);
  });
});

describe('usage', () => {
  it('prints help and rejects unknown commands and options', async () => {
    expect(await main(['--help'], io())).toBe(0);
    expect(out).toContain('Usage:');
    expect(await main([], io())).toBe(2);
    expect(await main(['frobnicate'], io())).toBe(2);
    expect(await main(['validate', 'x', '--nope'], io())).toBe(2);
    expect(await main(['validate'], io())).toBe(2);
    expect(await main(['validate', join(dir, 'missing.jsonl')], io())).toBe(1);
    expect(await main(['queue', 'status'], io())).toBe(2);
    expect(await main(['validate', 'x', '--strict=yes'], io())).toBe(2);
    expect(await main(['validate', 'x', '--format'], io())).toBe(2);
    expect(err).not.toMatch(/\n\s+at /);
  });

  it('enforces the input size limit', async () => {
    const f = write('big.jsonl', jsonl([validStatement('a')]));
    expect(await main(['validate', f, '--max-bytes', '10'], io())).toBe(1);
    expect(err).toContain('larger than 10 bytes');
  });
});

describe('CSV reader', () => {
  it('parses quotes, escaped quotes, line breaks in fields, CRLF and a BOM', () => {
    const rows = parseCsv(`${String.fromCodePoint(0xfeff)}a,b\r\n"x, y","he said ""hi"""\r\n"multi\nline",z\n\n`);
    expect(rows).toEqual([
      { line: 1, values: ['a', 'b'] },
      { line: 2, values: ['x, y', 'he said "hi"'] },
      { line: 3, values: ['multi\nline', 'z'] },
    ]);
    expect(parseCsv('a;b\n1;2', ';')[1]?.values).toEqual(['1', '2']);
    expect(parseCsv('a,b')).toEqual([{ line: 1, values: ['a', 'b'] }]);
  });

  it('rejects malformed input and enforces limits', () => {
    expect(() => parseCsv('"open')).toThrow(/Unterminated/);
    expect(() => parseCsv('"a"b')).toThrow(/closing quote/);
    expect(() => parseCsv('a"b')).toThrow(/quote inside/);
    expect(() => parseCsv('a,b,c', ',', { maxColumns: 2 })).toThrow(/columns/);
    expect(() => parseCsv('abcdef', ',', { maxFieldLength: 3 })).toThrow(/too long/);
    expect(() => parseCsv('"abcdef"', ',', { maxFieldLength: 3 })).toThrow(/too long/);
    expect(() => parseCsv('a\nb\nc', ',', { maxRows: 2 })).toThrow(/rows/);
    expect(() => parseCsv('a', '"')).toThrow(/delimiter/);
  });
});

describe('mapping files', () => {
  it('validates mapping files strictly', () => {
    const bad = [
      null,
      [],
      { version: 2, fields: {} },
      { version: 1 },
      { version: 1, fields: { nope: { column: 'x' } } },
      { version: 1, fields: { puid: { column: 'x', value: 'y' } } },
      { version: 1, fields: { puid: {} } },
      { version: 1, fields: { puid: { column: '' } } },
      { version: 1, fields: { puid: { column: 'x', extra: 1 } } },
      { version: 1, fields: { puid: { column: 'x', split: '|' } } },
      { version: 1, fields: { content_type: { value: 'CONTENT_TYPE_TEXT' } } },
      { version: 1, fields: { puid: { value: ['a'] } } },
      { version: 1, fields: { puid: { column: 'x', map: { a: 1 } } } },
      { version: 1, delimiter: '"', fields: {} },
      { version: 1, other: 1, fields: {} },
      JSON.parse('{"version":1,"fields":{"__proto__":{"column":"x"}}}') as unknown,
    ];
    for (const b of bad) expect(() => parseMapping(b), JSON.stringify(b)).toThrow(/Mapping file/);
  });

  it('applies columns, constants, splitting and value maps, skipping empty cells', () => {
    const m = parseMapping({
      version: 1,
      fields: {
        puid: { column: 'id' },
        content_type: { column: 'types', split: ';', map: { t: 'CONTENT_TYPE_TEXT' } },
        territorial_scope: { value: ['LT', 'LV'] },
        account_type: { column: 'acct' },
        'content_id.EAN-13': { column: 'ean' },
      },
    });
    expect(applyMapping({ id: 'x', types: 't; CONTENT_TYPE_IMAGE;', acct: '', ean: '4006381333931' }, m)).toEqual({
      puid: 'x',
      content_type: ['CONTENT_TYPE_TEXT', 'CONTENT_TYPE_IMAGE'],
      territorial_scope: ['LT', 'LV'],
      content_id: { 'EAN-13': '4006381333931' },
    });
    expect(identityMapping(['puid', 'content_type']).fields.get('content_type')).toEqual({ column: 'content_type', split: '|' });
    expect(() => identityMapping(['puid', 'evil'])).toThrow();
  });
});
