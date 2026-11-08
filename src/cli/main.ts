/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `rationale` command line tool.
 *
 *   rationale validate <file> [--format jsonl|csv] [--mapping <file>] [--strict] [--json]
 *   rationale submit <file> --env sandbox|production|local [...]
 *   rationale queue status|drain|compact --queue <file> [...]
 *
 * The API token is read from an environment variable only
 * (RATIONALE_API_TOKEN, or the name given with --token-env).
 */

import { readFile, stat } from 'node:fs/promises';
import { TransparencyClient, type ClientOptions, type SubmissionOutcome } from '../client.js';
import { RationaleError } from '../errors.js';
import { parseJsonSafe } from '../http.js';
import { JsonlQueueStore } from '../node/jsonl-store.js';
import { drainQueue, enqueueStatements } from '../queue/drain.js';
import { SCHEMA_VERSION } from '../schema.js';
import { isPlainObject, quote } from '../text.js';
import { DEFAULT_TOKEN_ENV, readToken } from '../token.js';
import { validateStatements, type ValidateOptions, type ValidationResult } from '../validate.js';
import { VERSION } from '../version.js';
import { parseCsv } from './csv.js';
import { applyMapping, identityMapping, parseMapping, type Mapping } from './mapping.js';

/** Where the CLI writes and what it reads from the environment. Replaceable in tests. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Extra client options (tests pass a fetch here). */
  readonly clientOverrides?: Partial<ClientOptions>;
}

const USAGE = `rationale ${VERSION} (schema ${SCHEMA_VERSION})

Usage:
  rationale validate <file> [--format jsonl|csv] [--mapping <file>] [--strict]
                            [--personal-data warn|error|off] [--json]
  rationale submit <file> --env sandbox|production|local [--sandbox-url <url>]
                            [--local-url <url>] [--confirm-production] [--dry-run]
                            [--queue <file>] [--batch-size <n>] [--token-env <name>]
                            [--format ...] [--mapping ...] [--strict] [--json]
  rationale queue status  --queue <file>
  rationale queue drain   --queue <file> --env ... (as for submit)
  rationale queue compact --queue <file>

The API token is read from the environment variable ${DEFAULT_TOKEN_ENV}
(or the one named by --token-env). It is never accepted as an argument.
Exit codes: 0 success, 1 invalid or unsent statements, 2 usage or configuration error.
`;

const FLAGS_WITH_VALUE = new Set(['--format', '--mapping', '--personal-data', '--env', '--sandbox-url', '--local-url', '--queue', '--batch-size', '--token-env', '--max-bytes']);
const BOOLEAN_FLAGS = new Set(['--strict', '--json', '--confirm-production', '--dry-run', '--help']);

interface Args {
  readonly positional: string[];
  readonly flags: Map<string, string | true>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--token' || a.startsWith('--token=')) throw new RationaleError('config', 'The token is read from an environment variable only. Use --token-env <NAME>.');
    if (a.startsWith('--')) {
      const [name, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
      if (BOOLEAN_FLAGS.has(name)) {
        if (inline !== undefined) throw new RationaleError('config', `${name} takes no value.`);
        flags.set(name, true);
      } else if (FLAGS_WITH_VALUE.has(name)) {
        const v = inline ?? argv[++i];
        if (v === undefined || v === '') throw new RationaleError('config', `${name} needs a value.`);
        flags.set(name, v);
      } else {
        throw new RationaleError('config', `Unknown option ${JSON.stringify(a.slice(0, 50))}.`);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function flag(args: Args, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

interface InputRecord {
  readonly line: number;
  readonly value: unknown;
  readonly parseError?: string;
}

async function readInput(path: string, args: Args): Promise<InputRecord[]> {
  const maxBytes = Number(flag(args, '--max-bytes') ?? 256 * 1024 * 1024);
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RationaleError('config', '--max-bytes must be a positive integer.');
  const info = await stat(path).catch(() => {
    throw new RationaleError('input', 'Cannot read the input file.');
  });
  if (!info.isFile()) throw new RationaleError('input', 'The input is not a regular file.');
  if (info.size > maxBytes) throw new RationaleError('input', `The input file is larger than ${maxBytes} bytes (--max-bytes).`);
  const text = await readFile(path, 'utf8');
  const format = flag(args, '--format') ?? (path.toLowerCase().endsWith('.csv') ? 'csv' : 'jsonl');
  let mapping: Mapping | undefined;
  const mappingPath = flag(args, '--mapping');
  if (mappingPath !== undefined) {
    const mInfo = await stat(mappingPath).catch(() => {
      throw new RationaleError('input', 'Cannot read the mapping file.');
    });
    if (!mInfo.isFile() || mInfo.size > 1024 * 1024) throw new RationaleError('input', 'The mapping file must be a regular file of at most 1 MiB.');
    const parsed = parseJsonSafe(await readFile(mappingPath, 'utf8'));
    if (parsed === undefined) throw new RationaleError('input', 'The mapping file is not valid JSON.');
    mapping = parseMapping(parsed);
  }
  if (format === 'csv') {
    const rows = parseCsv(text, mapping?.delimiter ?? ',');
    const header = rows.shift();
    if (!header) return [];
    const names = header.values.map((h) => h.trim());
    if (new Set(names).size !== names.length) throw new RationaleError('input', 'The CSV header repeats a column name.');
    const m = mapping ?? identityMapping(names);
    return rows.map((r) => {
      if (r.values.length !== names.length) return { line: r.line, value: undefined, parseError: `expected ${names.length} columns, found ${r.values.length}` };
      const rec = Object.create(null) as Record<string, string>;
      names.forEach((n, i) => {
        rec[n] = r.values[i] ?? '';
      });
      return { line: r.line, value: applyMapping(rec, m) };
    });
  }
  if (format !== 'jsonl') throw new RationaleError('config', '--format must be jsonl or csv.');
  const out: InputRecord[] = [];
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split('\n');
  lines.forEach((raw, i) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') return;
    const parsed = parseJsonSafe(line);
    if (parsed === undefined) out.push({ line: i + 1, value: undefined, parseError: 'not valid JSON' });
    else if (mapping && !isPlainObject(parsed)) out.push({ line: i + 1, value: undefined, parseError: 'not a JSON object' });
    else out.push({ line: i + 1, value: mapping && isPlainObject(parsed) ? applyMapping(parsed, mapping) : parsed });
  });
  return out;
}

function validateOptions(args: Args): ValidateOptions {
  const pd = flag(args, '--personal-data') ?? 'warn';
  if (pd !== 'warn' && pd !== 'error' && pd !== 'off') throw new RationaleError('config', '--personal-data must be warn, error or off.');
  return { personalData: pd };
}

function clientOptions(args: Args, io: CliIo, dryRun: boolean): ClientOptions {
  const env = flag(args, '--env');
  if (env !== 'sandbox' && env !== 'production' && env !== 'local') throw new RationaleError('config', '--env must be sandbox, production or local.');
  if (env === 'production' && args.flags.get('--confirm-production') !== true) {
    throw new RationaleError('config', 'Production needs --confirm-production. Test in the sandbox first.');
  }
  const batch = flag(args, '--batch-size');
  const sandbox = flag(args, '--sandbox-url');
  const local = flag(args, '--local-url');
  return {
    environment: env,
    ...(sandbox !== undefined ? { sandboxBaseUrl: sandbox } : {}),
    ...(local !== undefined ? { localBaseUrl: local } : {}),
    allowProduction: args.flags.get('--confirm-production') === true,
    token: { env: flag(args, '--token-env') ?? DEFAULT_TOKEN_ENV },
    dryRun,
    env: io.env,
    validation: validateOptions(args),
    ...(batch !== undefined ? { batchSize: Number(batch) } : {}),
    ...io.clientOverrides,
  };
}

/** An attribute name for terminal output: names from the input file are quoted unless they are plain. */
function attr(name: string): string {
  if (name === '') return '-';
  return /^[A-Za-z0-9_.-]{1,200}$/.test(name) ? name : quote(name, 100);
}

function describe(r: ValidationResult, strict: boolean): string[] {
  const out = r.errors.map((e) => `error ${e.code} ${attr(e.attribute)}: ${e.message}`);
  for (const w of r.warnings) out.push(`${strict ? 'error' : 'warning'} ${w.code} ${attr(w.attribute)}: ${w.message}`);
  return out;
}

async function cmdValidate(args: Args, io: CliIo): Promise<number> {
  const file = args.positional[1];
  if (file === undefined) throw new RationaleError('config', 'validate needs an input file.');
  const records = await readInput(file, args);
  const strict = args.flags.get('--strict') === true;
  const json = args.flags.get('--json') === true;
  const { results } = validateStatements(records.map((r) => r.value), validateOptions(args));
  let bad = 0;
  records.forEach((rec, i) => {
    const r = results[i];
    if (!r) return;
    const failed = rec.parseError !== undefined || !r.ok || (strict && r.warnings.length > 0);
    if (failed) bad++;
    if (json) {
      io.stdout(`${JSON.stringify({ line: rec.line, ok: !failed, errors: rec.parseError ? [{ code: 'invalid_input', attribute: '', message: rec.parseError }] : r.errors, warnings: r.warnings })}\n`);
    } else if (rec.parseError !== undefined) {
      io.stdout(`line ${rec.line}: error invalid_input: ${rec.parseError}\n`);
    } else {
      for (const d of describe(r, strict)) io.stdout(`line ${rec.line}: ${d}\n`);
    }
  });
  io.stderr(`${records.length} statements, ${records.length - bad} valid, ${bad} invalid (schema ${SCHEMA_VERSION})\n`);
  return bad > 0 ? 1 : 0;
}

function printOutcome(io: CliIo, line: number, o: SubmissionOutcome, json: boolean): void {
  if (json) {
    io.stdout(`${JSON.stringify({ line, ...o })}\n`);
    return;
  }
  const puid = o.puid !== undefined ? ` puid ${quote(o.puid, 500)}` : '';
  switch (o.status) {
    case 'created':
      io.stdout(`line ${line}:${puid} created${o.uuid !== undefined ? ` ${o.uuid}` : ''}\n`);
      break;
    case 'duplicate':
      io.stdout(`line ${line}:${puid} already in the database\n`);
      break;
    case 'validated':
      io.stdout(`line ${line}:${puid} valid (dry run, not sent)\n`);
      break;
    case 'invalid':
      for (const e of o.errors) io.stdout(`line ${line}:${puid} error ${e.code} ${attr(e.attribute)}: ${e.message}\n`);
      break;
    case 'rejected':
      for (const [k, v] of Object.entries(o.serverErrors)) io.stdout(`line ${line}:${puid} rejected ${k || '-'}: ${v.join(' ')}\n`);
      break;
    case 'failed':
      io.stdout(`line ${line}:${puid} failed ${o.error.code}${o.error.retryable ? ' (retryable)' : ''}: ${o.error.message}\n`);
      break;
  }
}

/** Reads the token once before anything is queued or sent, so a missing token is a clear configuration error. */
async function checkToken(args: Args, io: CliIo): Promise<void> {
  await readToken({ env: flag(args, '--token-env') ?? DEFAULT_TOKEN_ENV }, io.env);
}

async function cmdSubmit(args: Args, io: CliIo): Promise<number> {
  const file = args.positional[1];
  if (file === undefined) throw new RationaleError('config', 'submit needs an input file.');
  const dryRun = args.flags.get('--dry-run') === true;
  const client = new TransparencyClient(clientOptions(args, io, dryRun));
  if (!dryRun) await checkToken(args, io);
  const records = await readInput(file, args);
  const strict = args.flags.get('--strict') === true;
  const json = args.flags.get('--json') === true;
  const usable = records.filter((r) => r.parseError === undefined);
  for (const r of records) if (r.parseError !== undefined) io.stdout(`line ${r.line}: error invalid_input: ${r.parseError}\n`);
  let bad = records.length - usable.length;

  if (strict) {
    const { results } = validateStatements(usable.map((r) => r.value), validateOptions(args));
    const withWarnings = results.filter((r) => r.warnings.length > 0).length;
    if (withWarnings > 0) {
      results.forEach((r, i) => {
        for (const w of r.warnings) io.stdout(`line ${usable[i]?.line ?? 0}: error ${w.code} ${attr(w.attribute)}: ${w.message}\n`);
      });
      io.stderr(`--strict: ${withWarnings} statements have warnings; nothing was sent.\n`);
      return 1;
    }
  }

  const queuePath = flag(args, '--queue');
  if (queuePath !== undefined && !dryRun) {
    const store = await JsonlQueueStore.open(queuePath);
    try {
      const enq = await enqueueStatements(store, usable.map((r) => r.value), validateOptions(args));
      for (const [i, r] of enq.invalid) {
        bad++;
        for (const d of describe(r, false).filter((x) => x.startsWith('error'))) io.stdout(`line ${usable[i]?.line ?? 0}: ${d}\n`);
      }
      io.stderr(`queued ${enq.added.length}, already known ${enq.skipped.length}\n`);
      const report = await drainQueue(client, store);
      const stats = await store.stats();
      io.stderr(`created ${report.created}, duplicate ${report.duplicate}, rejected ${report.rejected}, failed ${report.failed}; pending ${stats.pending} (${report.stoppedBecause})\n`);
      return bad > 0 || report.rejected > 0 || stats.pending > 0 ? 1 : 0;
    } finally {
      await store.close();
    }
  }

  const report = await client.submitBatch(usable.map((r) => r.value));
  report.outcomes.forEach((o, i) => {
    printOutcome(io, usable[i]?.line ?? 0, o, json);
  });
  const c = report.counts;
  io.stderr(`created ${c.created}, duplicate ${c.duplicate}, invalid ${c.invalid}, rejected ${c.rejected}, failed ${c.failed}${dryRun ? `, valid (dry run) ${c.validated}` : ''}\n`);
  return bad + c.invalid + c.rejected + c.failed > 0 ? 1 : 0;
}

async function cmdQueue(args: Args, io: CliIo): Promise<number> {
  const sub = args.positional[1];
  const path = flag(args, '--queue');
  if (path === undefined) throw new RationaleError('config', 'queue commands need --queue <file>.');
  if (sub !== 'status' && sub !== 'drain' && sub !== 'compact') throw new RationaleError('config', 'queue needs status, drain or compact.');
  const client = sub === 'drain' ? new TransparencyClient(clientOptions(args, io, args.flags.get('--dry-run') === true)) : undefined;
  if (client !== undefined && !client.dryRun) await checkToken(args, io);
  const store = await JsonlQueueStore.open(path);
  try {
    if (sub === 'status') {
      const s = await store.stats();
      io.stdout(`pending ${s.pending}, done ${s.done}, rejected ${s.rejected}\n`);
      return 0;
    }
    if (sub === 'compact') {
      const r = await store.compact();
      io.stdout(`kept ${r.kept} pending, dropped ${r.dropped} settled\n`);
      return 0;
    }
    if (!client) throw new RationaleError('config', 'queue drain needs --env.');
    const report = await drainQueue(client, store);
    const s = await store.stats();
    io.stdout(`created ${report.created}, duplicate ${report.duplicate}, rejected ${report.rejected}, failed ${report.failed}; pending ${s.pending} (${report.stoppedBecause})\n`);
    return report.rejected > 0 || s.pending > 0 ? 1 : 0;
  } finally {
    await store.close();
  }
}

/** Runs the CLI. Returns the exit code. Never prints stack traces. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const args = parseArgs(argv);
    const cmd = args.positional[0];
    if (cmd === undefined || args.flags.get('--help') === true) {
      io.stdout(USAGE);
      return cmd === undefined && args.flags.get('--help') !== true ? 2 : 0;
    }
    if (cmd === 'validate') return await cmdValidate(args, io);
    if (cmd === 'submit') return await cmdSubmit(args, io);
    if (cmd === 'queue') return await cmdQueue(args, io);
    io.stderr(`Unknown command. Run "rationale --help".\n`);
    return 2;
  } catch (e) {
    if (e instanceof RationaleError) {
      io.stderr(`rationale: ${e.code}: ${e.message}\n`);
      return e.code === 'config' || e.code === 'token' ? 2 : 1;
    }
    io.stderr('rationale: unexpected error.\n');
    return 1;
  }
}
