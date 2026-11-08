/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A local stand-in for the DSA Transparency Database API, for integration
 * tests. It follows the documented behaviour: bearer authentication, 201 on
 * success, 422 with `errors.statement_N` for invalid batch statements, 422
 * with `errors.puid` / `existing_puids` for PUIDs already used, 302/404 on
 * the existing-PUID endpoint. Responses can be scripted to simulate
 * outages, rate limits, slow and hostile servers.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { validateStatement } from '../../src/validate.js';

export const MOCK_TOKEN = 'X|mockTokenValue1234567890abcdef';

/** A scripted response for the next request. */
export interface Scripted {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Raw body text (sent as is). */
  raw?: string;
  delayMs?: number;
  /** Close the connection without a response. */
  destroy?: boolean;
  /** Still process the request normally (store statements) before sending this response. */
  processFirst?: boolean;
  /** Send the body one byte at a time with this pause (ms) between bytes. */
  dripMs?: number;
  /** Take the server's per-PUID locks of this request for this long (mock time), without storing anything. */
  holdLockMs?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export class MockApi {
  readonly server: Server;
  readonly requests: RecordedRequest[] = [];
  readonly script: (Scripted | ((req: RecordedRequest) => Scripted | undefined))[] = [];
  /** PUIDs stored, per platform (one platform here). */
  readonly puids = new Set<string>();
  /** PUIDs the server rejects with a field error even though they are valid (simulates rule drift). */
  readonly rejectPuids = new Set<string>();
  /** PUIDs reported as "not unique" although not stored (simulates a lock collision). */
  readonly lockedPuids = new Set<string>();
  /**
   * PUIDs in the server's PUID cache without a stored statement. The real
   * batch endpoint caches the PUIDs it reports as not unique, including
   * after a lock collision; the existing-PUID endpoint then reports them.
   */
  readonly cachedPuids = new Set<string>();
  /** Per-PUID locks held by requests in progress: PUID to mock time of expiry. */
  readonly locks = new Map<string, number>();
  /** Mock time for locks (tests with a virtual clock replace it). */
  now: () => number = () => Date.now();
  token = MOCK_TOKEN;
  #sockets = new Set<import('node:net').Socket>();

  constructor() {
    this.server = createServer((req, res) => void this.#handle(req, res));
    this.server.on('connection', (s) => {
      this.#sockets.add(s);
      s.on('close', () => this.#sockets.delete(s));
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => { resolve(); }));
  }

  /** Requests to a path. */
  calls(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === path);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rec: RecordedRequest = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
    this.requests.push(rec);
    const next = this.script.shift();
    const scripted = typeof next === 'function' ? next(rec) : next;
    if (scripted) {
      if (scripted.processFirst === true) this.#process(rec);
      if (scripted.holdLockMs !== undefined) {
        const list = (JSON.parse(rec.body) as { statements?: { puid: string }[]; puid?: string });
        for (const p of list.statements?.map((x) => x.puid) ?? [list.puid ?? '']) this.locks.set(p, this.now() + scripted.holdLockMs);
      }
      if (scripted.delayMs) await new Promise((r) => setTimeout(r, scripted.delayMs));
      if (scripted.destroy === true) {
        req.socket.destroy();
        return;
      }
      const text = scripted.raw ?? (scripted.body === undefined ? '' : JSON.stringify(scripted.body));
      res.writeHead(scripted.status ?? 200, { 'Content-Type': 'application/json', ...scripted.headers });
      if (scripted.dripMs !== undefined) {
        for (const ch of text) {
          if (res.destroyed) return;
          res.write(ch);
          await new Promise((r) => setTimeout(r, scripted.dripMs));
        }
      }
      res.end(scripted.dripMs !== undefined ? '' : text);
      return;
    }
    const out = this.#process(rec);
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  }

  #process(rec: RecordedRequest): { status: number; body: unknown } {
    if (rec.headers.authorization !== `Bearer ${this.token}`) return { status: 401, body: { message: 'Unauthenticated.' } };
    if (rec.headers.accept !== 'application/json') return { status: 302, body: {} };
    const existing = /^\/api\/v1\/statement\/existing-puid\/([^/]+)$/.exec(rec.path);
    if (rec.method === 'GET' && existing) {
      const puid = decodeURIComponent(existing[1] ?? '');
      return this.puids.has(puid) || this.cachedPuids.has(puid)
        ? { status: 302, body: { message: 'statement of reason found', puid } }
        : { status: 404, body: { message: 'statement of reason not found', puid } };
    }
    let body: unknown;
    try {
      body = JSON.parse(rec.body);
    } catch {
      return { status: 400, body: { message: 'Bad JSON' } };
    }
    if (rec.method === 'POST' && rec.path === '/api/v1/statement') return this.#single(body);
    if (rec.method === 'POST' && rec.path === '/api/v1/statements') return this.#multi(body);
    return { status: 404, body: { message: 'Not found' } };
  }

  #locked(puid: string): boolean {
    const until = this.locks.get(puid);
    return until !== undefined && until > this.now();
  }

  #single(body: unknown): { status: number; body: unknown } {
    const r = validateStatement(body, { personalData: 'off' });
    if (!r.ok || !r.statement) return { status: 422, body: { message: 'invalid', errors: Object.fromEntries(r.errors.map((e) => [e.attribute, [e.message]])) } };
    const puid = r.statement.puid;
    if (this.puids.has(puid) || this.cachedPuids.has(puid) || this.lockedPuids.has(puid) || this.#locked(puid)) {
      return { status: 422, body: { message: 'The identifier given is not unique within this platform.', errors: { puid: ['The identifier given is not unique within this platform.'] }, existing: { puid } } };
    }
    if (this.rejectPuids.has(puid)) return { status: 422, body: { message: 'The selected category is invalid.', errors: { category: ['The selected category is invalid.'] } } };
    this.puids.add(puid);
    const uuid = randomUUID();
    return { status: 201, body: { ...r.statement, uuid, created_at: '2026-11-08 10:00:00', permalink: `https://example.test/statement/${uuid}`, self: `https://example.test/api/v1/statement/${uuid}`, platform_name: 'Test', id: 1 } };
  }

  #multi(body: unknown): { status: number; body: unknown } {
    const list = (body as { statements?: unknown }).statements;
    if (!Array.isArray(list) || list.length < 1 || list.length > 100) {
      return { status: 422, body: { message: 'The statements field must have between 1 and 100 items.', errors: { statements: ['The statements field must have between 1 and 100 items.'] } } };
    }
    const errors: Record<string, Record<string, string[]>> = {};
    const valid: Record<string, unknown>[] = [];
    list.forEach((s, i) => {
      const r = validateStatement(s, { personalData: 'off' });
      if (!r.ok || !r.statement) errors[`statement_${i}`] = Object.fromEntries(r.errors.map((e) => [e.attribute || 'statement', [e.message]]));
      else if (this.rejectPuids.has(r.statement.puid)) errors[`statement_${i}`] = { category: ['The selected category is invalid.'] };
      else valid.push(r.statement as unknown as Record<string, unknown>);
    });
    if (Object.keys(errors).length > 0) return { status: 422, body: { errors } };
    const puids = valid.map((s) => String(s['puid']));
    const dupInRequest = puids.filter((p, i) => puids.indexOf(p) !== i);
    // Order of the real service: duplicates in the request, then the PUID locks (only the first locked
    // PUID in sorted order is reported), then the cache and the database. Reported PUIDs are cached.
    const firstLocked = [...puids].sort().find((p) => this.lockedPuids.has(p) || this.#locked(p));
    const existing =
      dupInRequest.length > 0 ? [...new Set(dupInRequest)] : firstLocked !== undefined ? [firstLocked] : puids.filter((p) => this.puids.has(p) || this.cachedPuids.has(p));
    if (existing.length > 0) {
      for (const p of existing) this.cachedPuids.add(p);
      const message = 'The platform identifier(s) are not all unique within this call.';
      return { status: 422, body: { message, errors: { puid: [message], existing_puids: existing } } };
    }
    for (const p of puids) this.puids.add(p);
    return {
      status: 201,
      body: { statements: valid.map((s) => ({ ...s, uuid: randomUUID(), created_at: '2026-11-08 10:00:00', platform_name: 'Test' })) },
    };
  }
}

/** Starts a mock API and returns it with its base URL. */
export async function startMock(): Promise<{ api: MockApi; url: string }> {
  const api = new MockApi();
  const url = await api.start();
  return { api, url };
}
