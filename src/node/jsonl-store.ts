/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A durable queue store: an append-only JSON Lines file. Every change is one
 * appended line and is synced to disk before the call returns, so queued
 * statements survive crashes and API outages. One process at a time may use
 * a file; a lock file next to it enforces this.
 */

import { open, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { RationaleError } from '../errors.js';
import type { Statement } from '../generated/openapi-types.js';
import { parseJsonSafe } from '../http.js';
import { QueueState, checkLimit, parseEvent, updateToEvent, type QueueEntry, type QueueEvent, type QueueStats, type QueueStore, type QueueUpdate } from '../queue/state.js';
import { validateStatement } from '../validate.js';
import { checkManagedPath, createExclusive, openAppend, openRead } from './safe-file.js';

/** Options for {@link JsonlQueueStore.open}. */
export interface JsonlQueueOptions {
  /** Refuse files larger than this. Default 256 MiB. */
  readonly maxFileBytes?: number;
  /** Sync every write to disk (fdatasync). Default true. */
  readonly sync?: boolean;
  readonly now?: () => Date;
}

const MAX_LINE = 2 * 1024 * 1024;

/** Decodes UTF-8 strictly: invalid bytes mean the file was not written by Rationale. */
function decodeStrict(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RationaleError('queue_corrupt', 'The queue file is not valid UTF-8.');
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLockHolder(lockPath: string): Promise<number> {
  try {
    const fh = await openRead(lockPath);
    try {
      return Number((await fh.readFile({ encoding: 'utf8' })).trim().slice(0, 20));
    } finally {
      await fh.close();
    }
  } catch {
    // An unreadable or unsafe lock file counts as held.
    return Number.NaN;
  }
}

function isStale(holder: number): boolean {
  return Number.isInteger(holder) && holder > 0 && holder !== process.pid && !pidAlive(holder);
}

async function createLock(lockPath: string): Promise<void> {
  const fh = await createExclusive(lockPath);
  try {
    await fh.writeFile(`${process.pid}\n`);
  } finally {
    await fh.close();
  }
}

/**
 * Takes the lock file. A lock left by a process that no longer runs is
 * taken over, but only by the process that also creates the takeover file
 * (`<lock>.takeover`, exclusive), and only after it has read the lock again
 * under that guard. Without the guard, two processes that both saw the same
 * stale lock could each remove the lock the other had just taken.
 *
 * Exported for tests only (not part of the package's entry points);
 * `beforeRecheck` lets a test act as another process at the racy moment.
 */
export async function acquireLock(lockPath: string, beforeRecheck?: () => Promise<void>): Promise<void> {
  try {
    await createLock(lockPath);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const locked = new RationaleError('queue_locked', 'The queue file is in use by another process (lock file exists).');
  if (!isStale(await readLockHolder(lockPath))) throw locked;
  const guardPath = `${lockPath}.takeover`;
  try {
    await (await createExclusive(guardPath)).close();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RationaleError('queue_locked', 'Another process is taking over the queue lock. If none is, remove the .lock.takeover file by hand.');
    }
    throw e;
  }
  try {
    await beforeRecheck?.();
    // Read again under the guard: another process may have taken over in the meantime.
    if (!isStale(await readLockHolder(lockPath))) throw locked;
    await unlink(lockPath);
    try {
      await createLock(lockPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw locked;
      throw e;
    }
  } finally {
    await rm(guardPath, { force: true });
  }
}

/** Syncs a directory so a rename in it survives a crash. Platforms that cannot open directories (Windows) skip it. */
async function syncDirectory(dir: string): Promise<void> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(dir, 'r');
  } catch {
    return;
  }
  try {
    await fh.sync();
  } catch {
    // Some file systems do not support syncing a directory.
  } finally {
    await fh.close();
  }
}

/** Queue store backed by an append-only JSONL file. Create it with {@link JsonlQueueStore.open}. */
export class JsonlQueueStore implements QueueStore {
  readonly #path: string;
  readonly #lockPath: string;
  #state: QueueState;
  readonly #sync: boolean;
  readonly #now: () => Date;
  #fh: FileHandle | undefined;
  #chain: Promise<unknown> = Promise.resolve();

  private constructor(path: string, lockPath: string, state: QueueState, fh: FileHandle, options: JsonlQueueOptions) {
    this.#path = path;
    this.#lockPath = lockPath;
    this.#state = state;
    this.#fh = fh;
    this.#sync = options.sync !== false;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Opens (or creates) a queue file and takes its lock. The file is read
   * and every line is checked; a damaged file is refused. A last line
   * without a newline (an interrupted write) is cut off.
   */
  static async open(path: string, options: JsonlQueueOptions = {}): Promise<JsonlQueueStore> {
    const maxFileBytes = options.maxFileBytes ?? 256 * 1024 * 1024;
    const full = await checkManagedPath(path);
    const lockPath = `${full}.lock`;
    await acquireLock(lockPath);
    try {
      const state = new QueueState();
      let validLength = 0;
      let exists = true;
      let text = '';
      try {
        const fh = await openRead(full);
        try {
          const size = (await fh.stat()).size;
          if (size > maxFileBytes) throw new RationaleError('queue', `The queue file is larger than ${maxFileBytes} bytes. Compact it.`);
          text = decodeStrict(await fh.readFile());
        } finally {
          await fh.close();
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
        else throw e;
      }
      if (exists) {
        const lines = text.split('\n');
        // The last element is "" after a final newline, or an interrupted write: never a complete record.
        const complete = lines.slice(0, -1);
        let offset = 0;
        complete.forEach((line, i) => {
          offset += Buffer.byteLength(line, 'utf8') + 1;
          if (line.length > MAX_LINE) throw new RationaleError('queue_corrupt', `Queue file line ${i + 1} is too long.`);
          if (line.trim() === '') return;
          const event = parseEvent(parseJsonSafe(line));
          if (!event) throw new RationaleError('queue_corrupt', `Queue file line ${i + 1} is not a valid queue record.`);
          try {
            state.apply(event);
          } catch (e) {
            throw new RationaleError('queue_corrupt', `Queue file line ${i + 1}: ${e instanceof Error ? e.message : 'invalid record'}`);
          }
        });
        validLength = offset;
      }
      const fh = await openAppend(full);
      if (exists && validLength < Buffer.byteLength(text, 'utf8')) await fh.truncate(validLength);
      return new JsonlQueueStore(full, lockPath, state, fh, options);
    } catch (e) {
      await rm(lockPath, { force: true });
      throw e;
    }
  }

  /** Path of the queue file. */
  get path(): string {
    return this.#path;
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #append(events: readonly QueueEvent[]): Promise<void> {
    if (events.length === 0) return;
    const fh = this.#fh;
    if (!fh) throw new RationaleError('queue', 'The queue store is closed.');
    await fh.appendFile(events.map((e) => `${JSON.stringify(e)}\n`).join(''));
    if (this.#sync) await fh.datasync();
    for (const e of events) this.#state.apply(e);
  }

  add(statements: readonly Statement[]): Promise<{ added: string[]; skipped: string[] }> {
    return this.#serial(async () => {
      const at = this.#now().toISOString();
      const added: string[] = [];
      const skipped: string[] = [];
      const events: QueueEvent[] = [];
      const inBatch = new Set<string>();
      for (const s of statements) {
        const r = validateStatement(s, { personalData: 'off' });
        if (!r.ok || r.statement === undefined) throw new RationaleError('queue', 'Only valid statements can be queued. Validate before adding.');
        const puid = r.statement.puid;
        if (this.#state.has(puid) || inBatch.has(puid)) {
          skipped.push(puid);
          continue;
        }
        inBatch.add(puid);
        events.push({ v: 1, op: 'add', at, puid, statement: r.statement });
        added.push(puid);
      }
      await this.#append(events);
      return { added, skipped };
    });
  }

  pending(limit: number, exclude?: ReadonlySet<string>): Promise<QueueEntry[]> {
    return this.#serial(() => {
      checkLimit(limit);
      if (!this.#fh) throw new RationaleError('queue', 'The queue store is closed.');
      return Promise.resolve(this.#state.pending(limit, exclude));
    });
  }

  settle(updates: readonly QueueUpdate[]): Promise<void> {
    return this.#serial(async () => {
      const at = this.#now().toISOString();
      const events: QueueEvent[] = [];
      const seen = new Set<string>();
      for (const u of updates) {
        if (seen.has(u.puid)) continue;
        const e = updateToEvent(this.#state, u, at);
        if (e) {
          events.push(e);
          seen.add(u.puid);
        }
      }
      await this.#append(events);
    });
  }

  stats(): Promise<QueueStats> {
    return this.#serial(() => {
      if (!this.#fh) throw new RationaleError('queue', 'The queue store is closed.');
      return Promise.resolve(this.#state.stats());
    });
  }

  /**
   * Rewrites the file with only the pending statements (atomically: a new
   * file is written, synced and renamed over the old one). Done and
   * rejected entries are dropped; if a dropped PUID is queued again later,
   * the server reports it as a duplicate.
   */
  compact(): Promise<{ readonly kept: number; readonly dropped: number }> {
    return this.#serial(async () => {
      const fh = this.#fh;
      if (!fh) throw new RationaleError('queue', 'The queue store is closed.');
      const entries = this.#state.entries();
      const keep = entries.filter((e) => e.state === 'pending' && e.statement !== undefined);
      const tmp = join(dirname(this.#path), `.rationale-compact-${randomBytes(8).toString('hex')}.tmp`);
      const out = await createExclusive(tmp);
      try {
        await out.writeFile(keep.map((e) => `${JSON.stringify({ v: 1, op: 'add', at: e.addedAt, puid: e.puid, statement: e.statement })}\n`).join(''));
        await out.sync();
      } catch (e) {
        await out.close();
        await rm(tmp, { force: true });
        throw e;
      }
      await out.close();
      await fh.close();
      this.#fh = undefined;
      try {
        await rename(tmp, this.#path);
      } catch (e) {
        await rm(tmp, { force: true });
        this.#fh = await openAppend(this.#path);
        throw e;
      }
      // Make the rename itself durable; otherwise a crash could bring back the old file and lose later appends.
      await syncDirectory(dirname(this.#path));
      this.#fh = await openAppend(this.#path);
      // Rebuild the state from the compacted file so memory matches disk.
      const fresh = new QueueState();
      for (const e of keep) {
        if (e.statement) fresh.apply({ v: 1, op: 'add', at: e.addedAt, puid: e.puid, statement: e.statement });
      }
      this.#state = fresh;
      return { kept: keep.length, dropped: entries.length - keep.length };
    });
  }

  /** Closes the file and releases the lock. */
  close(): Promise<void> {
    return this.#serial(async () => {
      if (this.#fh) {
        await this.#fh.close();
        this.#fh = undefined;
        await rm(this.#lockPath, { force: true });
      }
    });
  }
}

/** Reads a queue file without locking it, for inspection. Throws on damaged files. */
export async function readQueueFile(path: string): Promise<QueueEntry[]> {
  const full = await checkManagedPath(path);
  const fh = await openRead(full);
  let text: string;
  try {
    text = decodeStrict(await fh.readFile());
  } finally {
    await fh.close();
  }
  const state = new QueueState();
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    const event = parseEvent(parseJsonSafe(line));
    if (!event) throw new RationaleError('queue_corrupt', `Queue file line ${i + 1} is not a valid queue record.`);
    state.apply(event);
  }
  return state.entries();
}
