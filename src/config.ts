/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Environment and base URL selection. The base URL is never taken from
 * free-form configuration: production is fixed, the sandbox must be an
 * HTTPS host under europa.eu, and the local mode accepts only loopback
 * addresses (for tests against a mock server). This prevents a
 * configuration value from sending the API token to another host.
 */

import { ConfigError } from './errors.js';
import { PRODUCTION_BASE_URL } from './schema.js';

/** Target environment. */
export type Environment = 'sandbox' | 'production' | 'local';

/** Options that select where requests go. */
export interface EndpointOptions {
  /** Target environment. Required: there is no default, so nothing reaches production by accident. */
  readonly environment: Environment;
  /** Sandbox base URL from the onboarding email, e.g. `https://<sandbox host>.europa.eu`. Required for "sandbox". */
  readonly sandboxBaseUrl?: string;
  /** Must be true for "production". */
  readonly allowProduction?: boolean;
  /** Base URL of a local mock server (`http://127.0.0.1:<port>` or `http://[::1]:<port>`). Only for "local". */
  readonly localBaseUrl?: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function parse(url: string, what: string): URL {
  if (typeof url !== 'string' || url.length > 2048) throw new ConfigError(`${what} must be a URL string.`);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ConfigError(`${what} is not a valid URL.`);
  }
  if (u.username !== '' || u.password !== '') throw new ConfigError(`${what} must not contain credentials.`);
  if (u.search !== '' || u.hash !== '') throw new ConfigError(`${what} must not contain a query or fragment.`);
  if (u.pathname !== '/' && u.pathname !== '') throw new ConfigError(`${what} must be a bare origin without a path.`);
  return u;
}

/** Resolves and checks the base URL (origin) for an environment. Throws ConfigError. */
export function resolveBaseUrl(options: EndpointOptions): string {
  switch (options.environment) {
    case 'production': {
      if (options.allowProduction !== true) {
        throw new ConfigError('Production requires allowProduction: true. Test in the sandbox first.');
      }
      if (options.sandboxBaseUrl !== undefined || options.localBaseUrl !== undefined) {
        throw new ConfigError('Do not combine production with a sandbox or local base URL.');
      }
      return PRODUCTION_BASE_URL;
    }
    case 'sandbox': {
      if (options.sandboxBaseUrl === undefined) throw new ConfigError('sandboxBaseUrl is required for the sandbox environment (see your onboarding email).');
      const u = parse(options.sandboxBaseUrl, 'sandboxBaseUrl');
      const host = u.hostname.toLowerCase();
      if (u.protocol !== 'https:') throw new ConfigError('sandboxBaseUrl must use https.');
      if (u.port !== '') throw new ConfigError('sandboxBaseUrl must use the default HTTPS port.');
      if (!DNS_NAME.test(host) || !host.endsWith('.europa.eu')) throw new ConfigError('sandboxBaseUrl must be a host name under europa.eu.');
      if (`https://${host}` === PRODUCTION_BASE_URL) throw new ConfigError('sandboxBaseUrl points to production. Use environment "production" with allowProduction instead.');
      return `https://${host}`;
    }
    case 'local': {
      if (options.localBaseUrl === undefined) throw new ConfigError('localBaseUrl is required for the local environment.');
      const u = parse(options.localBaseUrl, 'localBaseUrl');
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError('localBaseUrl must use http or https.');
      if (!LOOPBACK_HOSTS.has(u.hostname)) throw new ConfigError('localBaseUrl must be 127.0.0.1 or [::1].');
      return u.origin;
    }
    default:
      throw new ConfigError('environment must be "sandbox", "production" or "local".');
  }
}
