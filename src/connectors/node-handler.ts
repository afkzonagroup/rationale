/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A Node.js request handler around the intake, usable with node:http,
 * Express (mount it without a body parser) and Fastify (via reply.hijack
 * or the raw request). It is meant for internal, server-to-server calls
 * from your moderation system:
 *
 * - POST only; `Content-Type: application/json` only (415 otherwise).
 * - Bearer authentication with a secret from the environment, compared in
 *   constant time. Browsers cannot send this header cross-site without a
 *   CORS preflight, which this handler never approves, so it is not open
 *   to cross-site request forgery.
 * - Body size limit (413), optional rate-limit hook (429).
 * - Security headers on every response; errors never include stack traces.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonSafe } from '../http.js';
import { readToken, type TokenSource } from '../token.js';
import type { Intake } from './intake.js';

/** Options for {@link createNodeHandler}. */
export interface NodeHandlerOptions {
  readonly intake: Intake;
  /** Secret that callers send as `Authorization: Bearer <secret>`. Read from the environment or a secret store. */
  readonly secret: TokenSource;
  /** Largest accepted body. Default 1 MiB. */
  readonly maxBodyBytes?: number;
  /** Return false to answer 429. Called before the body is read. */
  readonly rateLimit?: (req: IncomingMessage) => boolean | Promise<boolean>;
  /** Environment for `{ env }` secret sources. Default process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): undefined {
  if (res.headersSent) return undefined;
  const text = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, ...extra, 'Content-Length': String(Buffer.byteLength(text)) });
  res.end(text);
  return undefined;
}

/** Compares two strings in constant time (hashing first so lengths do not leak). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/**
 * Reads the body up to `max` bytes. A larger body is read on and discarded
 * up to a hard cap (so the client receives the 413 instead of a connection
 * reset); beyond that cap the connection is closed.
 */
function readBody(req: IncomingMessage, max: number): Promise<{ readonly text: string } | 'too_large'> {
  const hardCap = max * 4 + 1024 * 1024;
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 'NaN');
    if (Number.isFinite(declared) && declared > hardCap) {
      req.socket.destroy();
      resolve('too_large');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > hardCap) {
        req.socket.destroy();
        resolve('too_large');
        return;
      }
      if (size <= max) chunks.push(c);
    });
    req.on('end', () => {
      resolve(size > max ? 'too_large' : { text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', reject);
  });
}

/** Creates a `(req, res) => Promise<void>` handler. */
export function createNodeHandler(options: NodeHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const max = options.maxBodyBytes ?? 1024 * 1024;
  if (!Number.isInteger(max) || max < 1 || max > 64 * 1024 * 1024) throw new RangeError('maxBodyBytes must be between 1 and 64 MiB.');
  return async (req, res) => {
    try {
      if (req.method !== 'POST') {
        send(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' });
        return;
      }
      const contentType = (req.headers['content-type'] ?? '').toLowerCase();
      if (!/^application\/json\s*(?:;\s*charset=utf-8\s*)?$/.test(contentType)) {
        send(res, 415, { error: 'Content-Type must be application/json.' });
        return;
      }
      let expected: string;
      try {
        expected = (await readToken(options.secret, options.env ?? process.env)).reveal();
      } catch {
        send(res, 500, { error: 'The intake is not configured.' });
        return;
      }
      const auth = req.headers.authorization ?? '';
      const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!constantTimeEqual(given, expected)) {
        send(res, 401, { error: 'Unauthorized.' }, { 'WWW-Authenticate': 'Bearer' });
        return;
      }
      if (options.rateLimit && !(await options.rateLimit(req))) {
        send(res, 429, { error: 'Too many requests.' }, { 'Retry-After': '1' });
        return;
      }
      const body = await readBody(req, max);
      if (body === 'too_large') {
        send(res, 413, { error: 'Request body too large.' }, { Connection: 'close' });
        return;
      }
      const parsed = parseJsonSafe(body.text);
      if (parsed === undefined) {
        send(res, 400, { error: 'The body is not valid JSON.' });
        return;
      }
      const result = await options.intake(parsed);
      send(res, result.status, result.body);
    } catch {
      send(res, 500, { error: 'Internal error.' });
    }
  };
}
