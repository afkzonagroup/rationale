/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, validateStatement, validateStatements } from '../src/index.js';
import { VECTORS, caseInput, sortPairs, type Pair } from './helpers/vectors.js';

describe('shared test vectors', () => {
  it('match the current schema version', () => {
    expect(VECTORS.schemaVersion).toBe(SCHEMA_VERSION);
    expect(VECTORS.cases.length).toBeGreaterThan(400);
  });

  for (const c of VECTORS.cases) {
    it(c.id, () => {
      const r = validateStatement(caseInput(c), c.options);
      const errors = r.errors.map((e): Pair => [e.code, e.attribute]);
      expect(r.ok, JSON.stringify(r.errors)).toBe(c.expect.ok);
      expect(sortPairs(errors)).toEqual(sortPairs(c.expect.errors ?? []));
      if (c.expect.warnings !== undefined) {
        expect(sortPairs(r.warnings.map((w): Pair => [w.code, w.attribute]))).toEqual(sortPairs(c.expect.warnings));
      }
      if (r.ok) {
        expect(r.statement).toBeDefined();
        const out = r.statement as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(c.expect.normalized ?? {})) {
          if (v === null) expect(Object.prototype.hasOwnProperty.call(out, k), k).toBe(false);
          else expect(out[k], k).toEqual(v);
        }
        // A normalised statement is a fixed point: validating it again changes nothing.
        const again = validateStatement(out, { personalData: 'off' });
        expect(again.ok).toBe(true);
        expect(again.statement).toEqual(out);
      } else {
        expect(r.statement).toBeUndefined();
      }
    });
  }

  for (const b of VECTORS.batches) {
    it(`batch: ${b.id}`, () => {
      const { results, valid } = validateStatements(b.inputs);
      expect(valid).toBe(b.expect.filter((e) => e.ok).length);
      results.forEach((r, i) => {
        const e = b.expect[i];
        expect(r.ok).toBe(e?.ok);
        expect(sortPairs(r.errors.map((x): Pair => [x.code, x.attribute]))).toEqual(sortPairs(e?.errors ?? []));
      });
    });
  }
});
