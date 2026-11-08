// Copyright 2026 MB AFKzona Group
// SPDX-License-Identifier: Apache-2.0

// Checks the output of `npm pack --dry-run --json` (file given as argument): the tarball must contain every
// file that package.json points to (main, types, bin, exports) and the licence. Run `npm run build` first:
// a package published without its compiled code installs but does nothing.

import { readFileSync } from 'node:fs';
import process from 'node:process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [info] = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8'));
const files = new Set((info?.files ?? []).map((f) => f.path));

const required = new Set(['LICENSE', 'package.json']);
const add = (value) => {
  if (typeof value === 'string') {
    if (!value.includes('*')) required.add(value.replace(/^\.\//, ''));
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) add(v);
  }
};
add(pkg.main);
add(pkg.types);
add(pkg.bin);
add(pkg.exports);

const missing = [...required].filter((p) => !files.has(p));
if (missing.length > 0) {
  process.stderr.write(`The package would miss: ${missing.join(', ')}. Run npm run build first.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Package contents OK: ${String(files.size)} files, all ${String(required.size)} entry points present.\n`);
}
