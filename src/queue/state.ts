/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The queue model shared by all stores: an append-only list of events
 * replayed into the current state. Pure, no I/O.
 */

import { RationaleError, redact } from '../errors.js';
import type { Statement } from '../generated/openapi-types.js';
import { isPlainObject } from '../text.js';
import { validateStatement } from '../validate.js';

/** State of a queued statement. */
export type QueueEntryState = 'pending' | 'done' | 'rejected';

/** One queued statement. */
export interface QueueEntry {
  readonly puid: string;
  readonly state: QueueEntryState;
  /** The statement; kept while pending, dropped once done or rejected. */
  readonly statement: Statement | undefined;
  readonly addedAt: string;
  readonly attempts: number;
  readonly lastError: string | undefined;
  readonly uuid: string | undefined;
}

/** An outcome to record. */
export type QueueUpdate =
  | { readonly puid: string; readonly result: 'done'; readonly uuid?: string; readonly duplicate?: boolean }
  | { readonly puid: string; readonly result: 'rejected'; readonly reason: string }
  | { readonly puid: string; readonly result: 'failed'; readonly reason: string };

/** Counts by state. */
export interface QueueStats {
  readonly pending: number;
  readonly done: number;
  readonly rejected: number;
}

/** One line of the event log. */
export type QueueEvent =
  | { readonly v: 1; readonly op: 'add'; readonly at: string; readonly puid: string; readonly statement: Statement }
  | { readonly v: 1; readonly op: 'done'; readonly at: string; readonly puid: string; readonly uuid?: string; readonly duplicate?: boolean }
  | { readonly v: 1; readonly op: 'rejected'; readonly at: string; readonly puid: string; readonly reason: string }
  | { readonly v: 1; readonly op: 'failed'; readonly at: string; readonly puid: string; readonly reason: string };

/** Storage interface for queued statements. Implementations: MemoryQueueStore, JsonlQueueStore. */
export interface QueueStore {
  /** Adds statements whose PUID is not in the store yet. */
  add(statements: readonly Statement[]): Promise<{ readonly added: readonly string[]; readonly skipped: readonly string[] }>;
  /** Up to `limit` pending entries, oldest first, without the PUIDs in `exclude`. */
  pending(limit: number, exclude?: ReadonlySet<string>): Promise<QueueEntry[]>;
  /** Records outcomes of submission attempts. */
  settle(updates: readonly QueueUpdate[]): Promise<void>;
  /** Counts by state. */
  stats(): Promise<QueueStats>;
  /** Releases resources (file handles, locks). */
  close(): Promise<void>;
}

const MAX_REASON = 500;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const PUID = /^[a-zA-Z0-9_-]{1,500}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shortens and redacts a failure reason before it is stored. */
export function cleanReason(reason: string): string {
  return Array.from(redact(reason), (c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c)).join('').slice(0, MAX_REASON);
}

function exactKeys(o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(o);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}

/**
 * Checks one parsed event from storage. Stored files are untrusted: every
 * field is checked and every statement is validated again.
 */
export function parseEvent(value: unknown): QueueEvent | undefined {
  if (!isPlainObject(value) || value['v'] !== 1) return undefined;
  const { op, at, puid } = value;
  if (typeof at !== 'string' || !ISO_TIME.test(at) || typeof puid !== 'string' || !PUID.test(puid)) return undefined;
  switch (op) {
    case 'add': {
      if (!exactKeys(value, ['v', 'op', 'at', 'puid', 'statement'])) return undefined;
      const r = validateStatement(value['statement'], { personalData: 'off' });
      const statement = r.ok ? r.statement : undefined;
      if (statement?.puid !== puid) return undefined;
      return { v: 1, op, at, puid, statement };
    }
    case 'done': {
      if (!exactKeys(value, ['v', 'op', 'at', 'puid'], ['uuid', 'duplicate'])) return undefined;
      const { uuid, duplicate } = value;
      if (uuid !== undefined && (typeof uuid !== 'string' || !UUID.test(uuid))) return undefined;
      if (duplicate !== undefined && typeof duplicate !== 'boolean') return undefined;
      return { v: 1, op, at, puid, ...(uuid !== undefined ? { uuid } : {}), ...(duplicate !== undefined ? { duplicate } : {}) };
    }
    case 'rejected':
    case 'failed': {
      if (!exactKeys(value, ['v', 'op', 'at', 'puid', 'reason'])) return undefined;
      const { reason } = value;
      if (typeof reason !== 'string' || reason.length > MAX_REASON) return undefined;
      return { v: 1, op, at, puid, reason };
    }
    default:
      return undefined;
  }
}

interface MutableEntry {
  puid: string;
  state: QueueEntryState;
  statement: Statement | undefined;
  addedAt: string;
  attempts: number;
  lastError: string | undefined;
  uuid: string | undefined;
}

/** In-memory state built by applying events in order. */
export class QueueState {
  readonly #entries = new Map<string, MutableEntry>();

  /** Applies one event. Throws for events that do not fit the current state. */
  apply(e: QueueEvent): void {
    const entry = this.#entries.get(e.puid);
    if (e.op === 'add') {
      if (entry) throw new RationaleError('queue_corrupt', 'A PUID was added twice.');
      this.#entries.set(e.puid, { puid: e.puid, state: 'pending', statement: e.statement, addedAt: e.at, attempts: 0, lastError: undefined, uuid: undefined });
      return;
    }
    if (!entry) throw new RationaleError('queue_corrupt', 'An outcome refers to a PUID that was never added.');
    if (entry.state !== 'pending') throw new RationaleError('queue_corrupt', 'An outcome was recorded for a statement that was already settled.');
    if (e.op === 'done') {
      entry.state = 'done';
      entry.uuid = e.uuid;
      entry.statement = undefined;
    } else if (e.op === 'rejected') {
      entry.state = 'rejected';
      entry.lastError = e.reason;
      entry.statement = undefined;
    } else {
      entry.attempts++;
      entry.lastError = e.reason;
    }
  }

  /** True if the PUID is known in any state. */
  has(puid: string): boolean {
    return this.#entries.has(puid);
  }

  /** True if the PUID is pending. */
  isPending(puid: string): boolean {
    return this.#entries.get(puid)?.state === 'pending';
  }

  /** Pending entries, oldest first. */
  pending(limit: number, exclude?: ReadonlySet<string>): QueueEntry[] {
    const out: QueueEntry[] = [];
    for (const e of this.#entries.values()) {
      if (out.length >= limit) break;
      if (e.state === 'pending' && !(exclude?.has(e.puid) ?? false)) out.push({ ...e });
    }
    return out;
  }

  /** All entries (copies). */
  entries(): QueueEntry[] {
    return [...this.#entries.values()].map((e) => ({ ...e }));
  }

  /** Counts by state. */
  stats(): QueueStats {
    let pending = 0;
    let done = 0;
    let rejected = 0;
    for (const e of this.#entries.values()) {
      if (e.state === 'pending') pending++;
      else if (e.state === 'done') done++;
      else rejected++;
    }
    return { pending, done, rejected };
  }
}

/** Turns an update into an event, or undefined when it does not apply (unknown or already settled PUID). */
export function updateToEvent(state: QueueState, u: QueueUpdate, at: string): QueueEvent | undefined {
  if (!state.isPending(u.puid)) return undefined;
  switch (u.result) {
    case 'done': {
      const uuid = u.uuid !== undefined && UUID.test(u.uuid) ? u.uuid : undefined;
      return { v: 1, op: 'done', at, puid: u.puid, ...(uuid !== undefined ? { uuid } : {}), ...(u.duplicate !== undefined ? { duplicate: u.duplicate } : {}) };
    }
    case 'rejected':
      return { v: 1, op: 'rejected', at, puid: u.puid, reason: cleanReason(u.reason) };
    case 'failed':
      return { v: 1, op: 'failed', at, puid: u.puid, reason: cleanReason(u.reason) };
  }
}

/** Checks a pending() limit. */
export function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new RangeError('limit must be an integer from 1 to 100000.');
}
