/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Pair = [string, string];

export interface VectorCase {
  id: string;
  input?: unknown;
  patch?: Record<string, unknown>;
  unset?: string[];
  options?: { personalData: 'warn' | 'error' | 'off' };
  expect: { ok: boolean; errors?: Pair[]; warnings?: Pair[]; normalized?: Record<string, unknown> };
}

export interface Vectors {
  schemaVersion: string;
  base: Record<string, unknown>;
  cases: VectorCase[];
  batches: { id: string; inputs: unknown[]; expect: { ok: boolean; errors?: Pair[] }[] }[];
}

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const VECTORS = JSON.parse(readFileSync(`${ROOT}test-vectors/statements.json`, 'utf8')) as Vectors;

/** The input of a case: "input" as is, or the base with the patch applied (spread keeps "__proto__" as a key). */
export function caseInput(c: VectorCase): unknown {
  if ('input' in c) return c.input;
  const out: Record<string, unknown> = { ...VECTORS.base, ...c.patch };
  for (const k of c.unset ?? []) Reflect.deleteProperty(out, k);
  return out;
}

export function sortPairs(pairs: readonly Pair[]): string[] {
  return pairs.map(([a, b]) => `${a}|${b}`).sort();
}

/** A valid statement with a given PUID. */
export function validStatement(puid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...VECTORS.base, puid, ...extra };
}
