# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-08

### Added

- Statement of reasons schema mirrored from the official DSA Transparency
  Database source code (commit a3444a9c, fetched 8 November 2026; schema
  effective 1 July 2025), with a parity test against the extracted rules.
- Validator for every attribute, enumeration, length, date and conditional
  rule, with normalisation that matches the server's input handling.
- Typed statement builder.
- `TransparencyClient`: single and batch submission, chunking to 100
  statements and a byte budget, PUID idempotency with confirmation, a wait
  for the server's PUID lock after unknown outcomes, retries
  with backoff, jitter and `Retry-After`, client-side rate limits, timeouts,
  response size caps, dry-run mode, base URL allow-list.
- Queue stores (memory and append-only JSONL file), `enqueueStatements`,
  `drainQueue`.
- Connectors: framework-agnostic intake, Node.js HTTP handler (works with
  Express and Fastify), background queue worker.
- `rationale` CLI: `validate`, `submit`, `queue status|drain|compact`, JSONL
  and CSV input with mapping files.
- Unofficial OpenAPI description and TypeScript types derived from it.
- Python package `afkzona-rationale` with the same validator, client and
  queue format, tested with the shared JSON test vectors.
