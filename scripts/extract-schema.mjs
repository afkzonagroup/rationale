// Copyright 2026 MB AFKzona Group
// SPDX-License-Identifier: Apache-2.0
//
// Extracts the submission schema facts (validation rules, enumerations,
// batch limit, rate limits) from a local checkout of the official DSA
// Transparency Database source code and writes schema/source-rules.json.
//
// The output is a fixture of facts, not copied code: every rule is kept as a
// short token so that the tests can compare our schema with the official one.
//
// Usage:
//   git clone https://github.com/digital-services-act/transparency-database /path/tdb
//   git -C /path/tdb checkout <commit>
//   node scripts/extract-schema.mjs /path/tdb [--fetched YYYY-MM-DD]
//
// It reads files only. It does not run any code from the checkout.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'https://github.com/digital-services-act/transparency-database';
const FILES = {
  request: 'app/Http/Requests/StatementStoreRequest.php',
  multi: 'app/Services/GroupedSubmissionsService.php',
  multiController: 'app/Http/Controllers/Api/v1/StatementMultipleAPIController.php',
  model: 'app/Models/Statement.php',
  countries: 'app/Services/EuropeanCountriesService.php',
  languages: 'app/Services/EuropeanLanguagesService.php',
  routes: 'routes/api_v1.php',
  limits: 'app/Providers/RouteServiceProvider.php',
  kernel: 'app/Http/Kernel.php',
  puid: 'app/Services/PlatformUniqueIdService.php',
  puidSingle: 'app/Exceptions/PuidNotUniqueSingleException.php',
  puidMulti: 'app/Exceptions/PuidNotUniqueMultipleException.php',
  docs: 'resources/markdown/api-documentation.md',
};

const args = process.argv.slice(2);
const checkout = args[0];
if (!checkout) {
  console.error('usage: node scripts/extract-schema.mjs <path-to-checkout> [--fetched YYYY-MM-DD]');
  process.exit(2);
}
const fetchedIdx = args.indexOf('--fetched');
const fetched = fetchedIdx >= 0 ? args[fetchedIdx + 1] : new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(fetched ?? '')) throw new Error('--fetched must be YYYY-MM-DD');

const root = resolve(checkout);
const read = (rel) => readFileSync(join(root, rel), 'utf8');

/** Resolves HEAD to a commit id by reading .git files (no git process). */
function headCommit() {
  const gitDir = join(root, '.git');
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  if (/^[0-9a-f]{40}$/.test(head)) return head;
  const ref = /^ref: (refs\/[\w./-]+)$/.exec(head)?.[1];
  if (!ref) throw new Error('cannot read HEAD');
  if (existsSync(join(gitDir, ref))) return readFileSync(join(gitDir, ref), 'utf8').trim();
  const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8');
  for (const line of packed.split('\n')) {
    const [sha, name] = line.split(' ');
    if (name === ref && /^[0-9a-f]{40}$/.test(sha ?? '')) return sha;
  }
  throw new Error(`cannot resolve ${ref}`);
}

// ---------------------------------------------------------------------------
// A small reader for the PHP literals used in these files.

/** Returns the text between the bracket at `open` and its matching close. */
function balanced(text, open) {
  const pairs = { '[': ']', '(': ')', '{': '}' };
  const stack = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ']' || c === ')' || c === '}') {
      if (stack.pop() !== c) throw new Error(`unbalanced at ${i}`);
      if (stack.length === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error('unterminated');
}

/** Splits a PHP array body into top-level items. */
function splitItems(body) {
  const items = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < body.length && body[j] !== c) {
        if (body[j] === '\\') j++;
        j++;
      }
      cur += body.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '/' && body[i + 1] === '/') {
      while (i < body.length && body[i] !== '\n') i++;
      continue;
    }
    if ('[({'.includes(c)) depth++;
    if ('])}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      if (cur.trim()) items.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) items.push(cur.trim());
  return items;
}

/** Decodes a single-quoted PHP string literal. */
function phpString(lit) {
  const m = /^'((?:[^'\\]|\\.)*)'$/s.exec(lit.trim());
  if (!m) throw new Error(`not a string literal: ${lit}`);
  return m[1].replace(/\\(['\\])/g, '$1');
}

/** Reads `const NAME = 'value';` constants of a class. */
function scalarConstants(src) {
  const out = {};
  for (const m of src.matchAll(/const\s+([A-Z0-9_]+)\s*=\s*('(?:[^'\\]|\\.)*'|\d+)\s*;/g)) {
    out[m[1]] = m[2].startsWith("'") ? phpString(m[2]) : Number(m[2]);
  }
  return out;
}

/** Reads `const NAME = [ ... ];` array constants, resolving self:: references. */
function arrayConstant(src, name, scalars) {
  const at = src.search(new RegExp(`const\\s+${name}\\s*=\\s*\\[`));
  if (at < 0) throw new Error(`missing constant ${name}`);
  const body = balanced(src, src.indexOf('[', at));
  const value = (v) => {
    const ref = /^self::([A-Z0-9_]+)$/.exec(v);
    if (ref) {
      if (!(ref[1] in scalars)) throw new Error(`unknown constant ${ref[1]}`);
      return scalars[ref[1]];
    }
    return phpString(v);
  };
  const items = splitItems(body);
  if (items.every((i) => i.includes('=>'))) {
    return Object.fromEntries(
      items.map((i) => {
        const [k, v] = i.split(/\s*=>\s*/);
        return [phpString(k), value(v)];
      }),
    );
  }
  return items.map(value);
}

/** Turns one PHP rule expression into a stable token. */
function ruleToken(expr) {
  const e = expr.replace(/\s+/g, ' ').trim();
  if (e.startsWith("'")) return phpString(e);
  let m = /^\$this->(?:in|rule_in)\(array_keys\((\w+)::([A-Z0-9_]+)\)(, true)?\)$/.exec(e);
  if (m) return `in:${m[3] ? 'null,' : ''}@${m[1]}::${m[2]}.keys`;
  m = /^\$this->(?:in|rule_in)\((\w+)::([A-Z0-9_]+)(, true)?\)$/.exec(e);
  if (m) return `in:${m[3] ? 'null,' : ''}@${m[1]}::${m[2]}.values`;
  m = /^Rule::requiredIf\(\$this->(\w+)\(\)\)$/.exec(e);
  if (m) return `required_if_fn:${m[1]}`;
  m = /^Rule::excludeIf\(! ?\$this->(\w+)\(\)\)$/.exec(e);
  if (m) return `exclude_unless_fn:${m[1]}`;
  m = /^Rule::excludeIf\(\$this->(\w+)\(\)\)$/.exec(e);
  if (m) return `exclude_if_fn:${m[1]}`;
  m = /^Rule::requiredIf\(\$(\w+)\)$/.exec(e);
  if (m) return `required_if_var:${m[1]}`;
  m = /^Rule::excludeIf\(! ?\$(\w+)\)$/.exec(e);
  if (m) return `exclude_unless_var:${m[1]}`;
  throw new Error(`unknown rule expression: ${e}`);
}

/** Reads the array returned by a rules method. */
function rulesOf(src, method) {
  const at = src.search(new RegExp(`function\\s+${method}\\s*\\(`));
  if (at < 0) throw new Error(`missing ${method}`);
  const ret = src.indexOf('return [', at);
  const body = balanced(src, src.indexOf('[', ret));
  const out = {};
  for (const item of splitItems(body)) {
    const [k, ...rest] = item.split(/\s*=>\s*/);
    const v = rest.join(' => ').trim();
    const list = v.startsWith('[') ? splitItems(balanced(v, 0)) : [v];
    out[phpString(k)] = list.map(ruleToken);
  }
  return out;
}

/** Reads `checkForX()` helpers: which attribute they read and which value they look for. */
function conditionHelpers(src) {
  const out = {};
  for (const m of src.matchAll(/function\s+(checkFor\w+)\(\)[^{]*\{([^}]*)\}/g)) {
    const attr = /\$this->get\('([a-z_]+)'/.exec(m[2])?.[1];
    const needle = /in_array\('([A-Z_]+)'/.exec(m[2])?.[1];
    if (!attr || !needle) throw new Error(`cannot read ${m[1]}`);
    out[m[1]] = { attribute: attr, contains: needle };
  }
  return out;
}

/** Reads the variables passed to multi_rules() in sanitizePayload(). */
function multiConditionVars(src) {
  const out = {};
  for (const m of src.matchAll(/\$(\w+_required) = in_array\('([A-Z_]+)', \$(\w+), true\)/g)) {
    out[m[1]] = { attribute: m[3], contains: m[2] };
  }
  return out;
}

/** Reads the post-validation clean-up calls in sanitizePayloadStatement(). */
function multiSanitizers(src) {
  const at = src.indexOf('function sanitizePayloadStatement');
  const body = balanced(src, src.indexOf('{', at));
  const out = [];
  for (const m of body.matchAll(/\$this->(handleOtherField\w+)\(\$payload_statement,\s*'(\w+)',\s*(?:'(\w+)',\s*)?\n?\s*'([A-Z_]+)'\)/g)) {
    out.push({ helper: m[1], field: m[2], other: m[3] ?? `${m[2]}_other`, value: m[4] });
  }
  return out;
}

// ---------------------------------------------------------------------------

const sources = Object.fromEntries(Object.entries(FILES).map(([k, rel]) => [k, read(rel)]));
const model = sources.model;
const scalars = scalarConstants(model);

const enumNames = [
  'DECISION_VISIBILITIES',
  'DECISION_MONETARIES',
  'DECISION_PROVISIONS',
  'DECISION_ACCOUNTS',
  'ACCOUNT_TYPES',
  'DECISION_GROUNDS',
  'CONTENT_TYPES',
  'STATEMENT_CATEGORIES',
  'KEYWORDS',
  'SOURCE_TYPES',
  'AUTOMATED_DECISIONS',
  'AUTOMATED_DETECTIONS',
  'INCOMPATIBLE_CONTENT_ILLEGALS',
];
const enums = Object.fromEntries(enumNames.map((n) => [n, arrayConstant(model, n, scalars)]));

const countries = sources.countries;
const languages = sources.languages;
const langScalars = scalarConstants(languages);
const lists = {
  'EuropeanCountriesService::EUROPEAN_COUNTRY_CODES': arrayConstant(countries, 'EUROPEAN_COUNTRY_CODES', {}),
  'EuropeanCountriesService::EUROPEAN_UNION_COUNTRY_CODES': arrayConstant(countries, 'EUROPEAN_UNION_COUNTRY_CODES', {}),
  'EuropeanCountriesService::EUROPEAN_ECONOMIC_AREA_COUNTRY_CODES': arrayConstant(countries, 'EUROPEAN_ECONOMIC_AREA_COUNTRY_CODES', {}),
  'EuropeanLanguagesService::ALL_LANGUAGES': Object.keys(arrayConstant(languages, 'ALL_LANGUAGES', langScalars)),
  'EuropeanLanguagesService::EUROPEAN_LANGUAGE_CODES': arrayConstant(languages, 'EUROPEAN_LANGUAGE_CODES', langScalars),
};

const limitScalars = scalarConstants(sources.limits);
const between = /'statements' => 'required\|array\|between:(\d+),(\d+)'/.exec(sources.multiController);
if (!between) throw new Error('batch limit not found');

const routes = [...sources.routes.matchAll(/Route::(get|post)\('(statement[^']*)'/g)].map((m) => ({ method: m[1].toUpperCase(), path: `/api/v1/${m[2]}` }));
const kernel = sources.kernel;
const middleware = ['TrimStrings', 'ConvertEmptyStringsToNull', 'ValidatePostSize'].filter((n) => kernel.includes(`\\${n}::class`));

const out = {
  $comment:
    'Facts extracted from the official DSA Transparency Database source code by scripts/extract-schema.mjs. Do not edit by hand. Rule tokens mirror the Laravel validation rules; "@Class::CONST.keys|values" refers to the enumerations below.',
  source: {
    repository: REPOSITORY,
    commit: headCommit(),
    fetched,
    files: Object.fromEntries(Object.values(FILES).map((rel) => [rel, { sha256: createHash('sha256').update(read(rel)).digest('hex') }])),
  },
  endpoints: routes,
  globalMiddleware: middleware,
  batch: { min: Number(between[1]), max: Number(between[2]) },
  rateLimits: {
    api: { perSecond: limitScalars.AUTHENTICATED_API_REQUESTS_PER_SECOND, perMinute: limitScalars.AUTHENTICATED_API_REQUESTS_PER_MINUTE },
    apiMultiple: { perSecond: limitScalars.AUTHENTICATED_MULTI_API_REQUESTS_PER_SECOND, perMinute: limitScalars.AUTHENTICATED_MULTI_API_REQUESTS_PER_MINUTE },
  },
  enums,
  lists,
  rules: {
    single: rulesOf(sources.request, 'rules'),
    multi: rulesOf(sources.multi, 'multi_rules'),
  },
  conditions: {
    single: conditionHelpers(sources.request),
    multi: multiConditionVars(sources.multi),
  },
  multiSanitizers: multiSanitizers(sources.multi),
  puid: {
    singleMessage: /parent::__construct\('([^']+)'\)/.exec(sources.puidSingle)?.[1],
    multiMessage: /parent::__construct\('([^']+)'\)/.exec(sources.puidMulti)?.[1],
    lockSeconds: Number(/\$lock_valid_seconds = (\d+);/.exec(sources.puid)?.[1]),
  },
};

const target = fileURLToPath(new URL('../schema/source-rules.json', import.meta.url));
// Non-ASCII characters are escaped so the file holds no invisible characters.
const text = JSON.stringify(out, null, 2).replace(/[^\x00-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
writeFileSync(target, `${text}\n`);
console.error(`wrote ${target} from commit ${out.source.commit}`);
