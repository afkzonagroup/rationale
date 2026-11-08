/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';
import { ROOT } from './helpers/vectors.js';

const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/** Generated or tool-owned directories, skipped by name. */
const GENERATED_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-check', 'coverage', 'build', '.venv', '__pycache__', '.mypy_cache']);

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = dir === '.' ? d.name : join(dir, d.name);
    if (d.isDirectory()) return GENERATED_DIRS.has(d.name) || d.name.endsWith('.egg-info') ? [] : walk(rel);
    return d.isFile() ? [rel] : [];
  });
}

interface Pkg {
  version: string;
  license: string;
  files: string[];
  engines: { node: string };
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
  exports: Record<string, unknown>;
  repository: { url: string };
  bin: Record<string, string>;
}
const pkg = JSON.parse(read('package.json')) as Pkg;

describe('repository hygiene', () => {
  it('has no runtime dependencies and only exact dev versions', () => {
    expect(pkg.dependencies).toBeUndefined();
    for (const v of Object.values(pkg.devDependencies)) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is provenance-ready: no install scripts, files allow-list, licence, engines, exports', () => {
    for (const s of ['preinstall', 'install', 'postinstall', 'prepare']) expect(pkg.scripts[s]).toBeUndefined();
    expect(pkg.files).toEqual(['dist', 'schema/statement-schema.json', 'README.md', 'LICENSE', 'NOTICE', 'TRADEMARKS.md', 'SECURITY.md', 'CHANGELOG.md']);
    expect(pkg.license).toBe('Apache-2.0');
    expect(pkg.engines.node).toBe('>=22');
    expect(pkg.repository.url).toBe('git+https://github.com/afkzonagroup/rationale.git');
    expect(Object.keys(pkg.exports)).toEqual(['.', './node', './connectors', './schema.json', './package.json']);
    expect(pkg.bin).toEqual({ rationale: './dist/cli/bin.js' });
  });

  it('keeps versions and licence files in sync across TypeScript and Python', () => {
    expect(VERSION).toBe(pkg.version);
    expect(read('python/LICENSE')).toBe(read('LICENSE'));
    expect(read('python/NOTICE')).toBe(read('NOTICE'));
    expect(read('python/pyproject.toml')).toContain(`version = "${pkg.version}"`);
    expect(read('python/src/rationale/__init__.py')).toContain(`__version__ = "${pkg.version}"`);
    expect(read('python/src/rationale/_client.py')).toContain(`_VERSION = "${pkg.version}"`);
    expect(read('NOTICE')).toContain('Copyright 2026 MB AFKzona Group');
    expect(read('LICENSE')).toContain('Apache License');
  });

  it('puts the copyright header on every source file', () => {
    const files = [...walk('src'), ...walk('python/src'), ...walk('python/tests'), ...walk('test'), ...walk('scripts')].filter((f) => /\.(ts|py|mjs)$/.test(f) && !f.endsWith('__init__.py'));
    expect(files.length).toBeGreaterThan(40);
    for (const f of files) expect(read(f), f).toContain('Copyright 2026 MB AFKzona Group');
  });

  it('uses no raw HTML sinks, eval or child processes in sources', () => {
    for (const f of [...walk('src'), ...walk('python/src')]) {
      const code = read(f);
      expect(code, f).not.toMatch(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(|child_process|subprocess|os\.system|pickle|(?<![.\w])exec\(/);
    }
  });

  it('runs CI only on pull requests and by hand, with pinned actions', () => {
    for (const f of ['.github/workflows/ci.yml', '.github/workflows/codeql.yml']) {
      const y = read(f);
      expect(y).not.toMatch(/^\s*(push|schedule):/m);
      expect(y).toMatch(/permissions:\s*\n\s*contents: read/);
      for (const m of y.matchAll(/uses:\s*(\S+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('has the required repository documents', () => {
    for (const f of ['README.md', 'LICENSE', 'NOTICE', 'CLA.md', 'TRADEMARKS.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'CHANGELOG.md', 'REVIEW.md', '.editorconfig', '.npmrc', '.github/dependabot.yml', 'python/README.md']) {
      expect(read(f).length, f).toBeGreaterThan(20);
    }
    expect(read('.npmrc')).toContain('engine-strict=true');
    const readme = read('README.md');
    for (const h of ['## Why it exists', '## Quick start', '## Configuration', '## How it maps to the law', '## Limitations', '## Security', '## Dependencies', '## Licence', '## Enterprise', '## Contributing', '## Disclaimer']) {
      expect(readme, h).toContain(h);
    }
  });

  it('names no AI tool anywhere in the repository', () => {
    // Built from character codes so this file does not contain the words itself.
    const words = [String.fromCharCode(99, 108, 97, 117, 100, 101), String.fromCharCode(97, 110, 116, 104, 114, 111, 112, 105, 99)];
    const files = walk('.');
    expect(files.length).toBeGreaterThan(60);
    for (const f of files) {
      const lower = `${f}\n${readFileSync(join(ROOT, f)).toString('latin1')}`.toLowerCase();
      for (const w of words) expect(lower.includes(w), f).toBe(false);
    }
  });
});

describe('no hidden characters', () => {
  // Bidi controls, zero-width characters, line/paragraph separators and BOMs
  // can hide code ("Trojan Source"). Sources must use escapes instead.
  const HIDDEN = new RegExp(`[${[[0x200b, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]].map(([a, b]) => `${String.fromCodePoint(a ?? 0)}-${String.fromCodePoint(b ?? 0)}`).join('')}]`);
  it('finds none in any text file of the repository', () => {
    const text = /\.(ts|js|mjs|py|md|json|jsonl|toml|yml|yaml|txt|csv)$|^(LICENSE|NOTICE|\.gitignore|\.npmrc|\.editorconfig)$/;
    const files = walk('.').filter((f) => text.test(f.split('/').pop() ?? ''));
    expect(files.length).toBeGreaterThan(60);
    for (const f of files) expect(HIDDEN.test(read(f)), f).toBe(false);
  });
});
