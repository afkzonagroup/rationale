# Review record

Two review passes were made before release 0.1.0 (8 November 2026). This file
records what was checked, what was found and what was fixed. An independent
review follows.

## Sources checked

Law (official texts, EUR-Lex):

- Regulation (EU) 2022/2065 (DSA), OJ L 277, 27.10.2022, p. 1, English
  version: Article 3 points (g)(iii), (h), (i) and (t); Article 16; Article
  17(1) to (5); Article 19; Article 20; Article 24(1) to (6); Article 93;
  recital 66. EUR-Lex lists no amending act, only corrigenda to other
  language versions.
- Commission Implementing Regulation (EU) 2024/2835 (transparency reporting
  templates, Articles 15(3) and 24(6) DSA): Articles 1 to 4 and Annex II
  (category list). It does not set the database schema; the Commission's
  announcement of the 1 July 2025 schema change says the database adopted its
  taxonomy.

Database (official sources):

- API documentation page (fetched 8 November 2026) and its source
  `resources/markdown/api-documentation.md`; the attribute explanation page,
  onboarding page and announcements.
- Source code at commit `a3444a9c5ae96640ff0978e92205c9c654909a37`
  (2026-11-03): request validation, batch service, model enumerations,
  country and language services, routes, rate limiter, kernel middleware,
  PUID service and exceptions. File hashes are in
  `schema/source-rules.json`. The re-extraction is reproducible (verified
  locally; the CI job `schema` repeats it).
- Laravel framework v12.68.0 (the version in the official `composer.lock`):
  `Validator::passes`, `ValidatesAttributes` (`validateIn`, `validateMax`,
  `validateRequired`, `validateDateFormat`, `compareDates`, `validateRegex`),
  `Str::trim` and `Str::isUrl`, `TrimStrings`, `ConvertEmptyStringsToNull`.
  Read to mirror exact semantics: string lengths in code points, the trimming
  set, empty strings becoming null, the order of `exclude_*` rules, `in` on
  arrays.

## Pass 1: correctness, law, API, tests

Checked:

- Every attribute, enumeration, length, date bound, pattern and conditional
  rule of both endpoints against the extracted rules (now an automated
  parity test, `test/schema-parity.test.ts`, 46 checks).
- Differences between documentation and code (documented in README):
  `territorial_scope` optional in code, end dates not checked against the
  application date, `content_language_other` and `content_id_ean`.
- Differences between the single and batch endpoints: `source_identity` and
  `category_specification_other` handling.
- Every legal statement in README against the official text (Article 19
  exemption for micro and small enterprises, Article 17(2) limits, the date
  of application, recital 66, the role of Implementing Regulation 2024/2835).
- API design: outcomes per input in input order, no exceptions for
  per-statement failures, typed builder, dry-run, schema exports.
- Tests: shared vectors (513 cases) run by both languages; every example in
  README runs.

Found and fixed:

- A statement with a lone UTF-16 surrogate would serialise to JSON the
  server cannot decode, failing the whole batch. Now an `invalid_format`
  error (TypeScript and Python, vectors added).
- After a network or timeout failure that survived all retries, the client
  went on to try every further chunk, each with its own retries. It now
  stops and reports the rest as failed (retryable).
- The intake handler answered 413 before reading an oversized body, so
  clients often saw a connection reset instead (a flaky test showed it). It
  now drains up to a hard cap (4 times the limit plus 1 MiB) and then answers
  413; beyond the cap it closes the connection.
- README additions: Article 3(i) definition, Article 17(2), Article 20 out of
  scope.
- The Python date check rejected year 0000 as an invalid date where PHP (and
  the TypeScript package) report it as out of range. Aligned.
- Python patterns now use full matches (Python's `$` also matches before a
  final newline).
- Security-control mutation check (each control removed, tests run,
  restored): 48 TypeScript and 17 Python controls. Gaps found and closed: the
  token-redaction test reached only the plain-text path (now also JSON
  messages); the intake handler's hard cap had no test for streamed bodies
  without `Content-Length`; Python had no test for a streamed response
  without `Content-Length`, for refusing a token string with the exact
  reason, or for an invalid statement inside a queue `add` record. Two
  TypeScript mutations stay uncaught by design because a second layer covers
  them: the early CSV field-length check (the check at the end of the field
  still fires) and the `lstat` symlink check (the `O_NOFOLLOW` open and
  `fstat` check still fire; removing both layers is caught).

## Pass 2: security, hostile server, hostile input, hostile contributor

Checked, line by line, against the security list in GOAL.md:

- Token: sources, header-injection check, redaction in every path that
  carries server text, `Secret` printing, no `cause` chains.
- Base URL allow-list and path construction (no SSRF through configuration
  or PUIDs), redirects, proxies.
- Responses: size, time, JSON parsing, prototype pollution, nesting, field
  validation, index bounds, loops a hostile server could cause.
- Retries and rate limits: what is retried, caps, scope of limiters.
- Idempotency: timeouts after the server stored a batch, and the server's
  PUID lock.
- Queue files: paths, symlinks, permissions, ownership, locking, crash
  recovery, tampering, encoding.
- Intake handler: method, content type, CSRF, authentication, body limit,
  headers, error output.
- CLI: arguments, input sizes, mapping files, terminal output.
- ReDoS: URL, PUID and personal-data patterns in both languages.
- Supply chain and CI: dependencies, scripts, lockfile, workflows.

Found and fixed:

- Deeply nested JSON (over 64 levels) in a CLI input line or an intake body
  raised an internal error (a misleading CLI message; HTTP 500).
  `parseJsonSafe` now treats it as "not JSON", giving `invalid_input` / 400.
- Server messages were redacted but could carry terminal escape sequences
  into CLI output and logs. Control characters are now replaced in all
  server text (TypeScript and Python).
- Queue files with invalid UTF-8 were decoded with replacement characters
  and accepted. They are now refused as damaged.
- The Python transport's timeout applied per socket operation, so a server
  dripping one byte at a time could hold a request indefinitely. A total
  deadline now covers the exchange, and reads use `read1` so it is checked
  as data arrives. Slow-drip tests in both languages.
- The CLI's production refusal named the library option; it now names
  `--confirm-production`.
- Hostile contributor: a changed `schema/source-rules.json` would pass the
  parity test. Added the CI job `schema`, which re-extracts the file from
  the official repository at the pinned commit and fails on any difference.
- README and SECURITY.md: proxy behaviour stated precisely (Node.js uses
  proxy variables only with `NODE_USE_ENV_PROXY`), stale-lock and
  queue-growth limitations.

Accepted, documented risks:

- A server that falsely reports PUIDs as existing (and confirms them on the
  lookup endpoint) can make statements count as `duplicate`. Only the
  allow-listed Commission hosts are contacted, over verified TLS.
- The server's PUID cache can report a PUID as in use for up to two days
  after a lock collision whose request then failed. Rationale reports such
  statements as retryable failures, never as done.
- One process per queue file; a lock whose process ID was reused must be
  removed by hand.
- The personal-data check is a heuristic.

## Results

- `npm run check`: typecheck, lint and 698 tests pass. Line coverage
  96.8 % (statements 93.4 %, branches 87.9 %, functions 96.7 %).
- Python: `mypy --strict` clean; 42 unittest tests pass (the 513 shared
  vectors run as subtests).
- `npm audit --omit=dev`: 0 vulnerabilities. No runtime dependencies.
- README quick start run from the packed tarball in an empty directory
  (validate, dry-run submit, production refusal, builder example, package
  exports), and the Python package installed from `python/` into a fresh
  virtual environment.

## Independent review

A third pass by a reviewer who did not build the package, made against the
code, the official repository and the law rather than this file or the
README.

### Checked

- Source of truth: the official repository fetched at the pinned commit
  `a3444a9c`. `scripts/extract-schema.mjs` reproduces
  `schema/source-rules.json` byte for byte. Every enumeration (16 lists,
  including 69 keywords, 30 country codes and 184 language codes) and every
  label were compared with the PHP constants loaded by PHP itself: all equal.
- The validator against the server's own code: the official
  `StatementStoreRequest` rules and `GroupedSubmissionsService` were run with
  Laravel v12.68.0 (the version in the official `composer.lock`) and the
  `TrimStrings` and `ConvertEmptyStringsToNull` middleware, in a throw-away
  PHP harness outside this repository. 5,520 statements went through both
  endpoints: all shared vectors, about 200 hand-written edge cases (URL rule,
  PUID pattern, date formats and bounds, trimming set, code-point lengths,
  rule order with `exclude_*`, nulls, nested values, `"null"` strings,
  content identifiers) and 4,000 random combinations. No statement that
  Rationale accepts was rejected by the server in its normalised form. Every
  case where Rationale is stricter falls under "Where Rationale is stricter
  than the server" in the README. The Laravel claims (trimming set, empty
  strings to null, code-point lengths, rule order) hold.
- Rate limits, batch limit (`between:1,100`), middleware, PUID lock time and
  the duplicate and lock responses against the PHP source.
- Law, against the official texts on EUR-Lex: Regulation (EU) 2022/2065
  Articles 3(i), 17(1) and (2), 19, 24(5), 92 and 93(2); Implementing
  Regulation (EU) 2024/2835 (legal basis Articles 15(3) and 24(6), templates
  from 1 July 2025).
- Licensing: a 12-word overlap search of every tracked file against the
  official repository's PHP, JavaScript and Markdown files. The only overlaps
  are enumeration keys, their labels and attribute name lists (interface
  facts); no code and no documentation prose.
- Security as an attacker: base-URL allow-list (suffix tricks, user info,
  IDN and punycode, full-width dots, trailing dots, ports, percent-encoding,
  backslashes, IPv6 and loopback forms) in both languages; hostile responses
  (size, slow drip, deep JSON, prototype keys, control characters, odd keys);
  queue files (symlinks, FIFOs, permissions, owner, invalid UTF-8, size and
  line limits, stale-lock takeover, compaction); CLI output of hostile input.
- Tests that must fail without their control: 35 existing TypeScript
  controls and every new control in both languages were removed one at a
  time.
- README quick start and builder example run from the packed tarball in an
  empty directory.
- Publish gate: author and committer of every commit, no tool attribution.

### Found and fixed

- High: statements could be reported as `duplicate` although never stored.
  The server locks each PUID for 30 seconds while it stores a statement. A
  batch request that hits such a lock is refused and the server caches the
  PUID as in use for two days, even if the lock holder then fails; the
  existing-PUID endpoint then confirms it. A retry after a client timeout,
  a broken connection or a 500/502/504 came within the lock time (backoff
  of 0.25 to 4 seconds), so a slow request that later failed turned into
  "duplicate" outcomes and the statements were dropped from the queue. The
  mock modelled lock collisions as "not found", which hid this, and the
  README and SECURITY.md claimed the opposite. Fixed in both languages: after
  an attempt with an unknown outcome the client waits 31 seconds (lock time
  from the extracted source, now `SERVER_PUID_LOCK_SECONDS`) before it sends
  those PUIDs again, in retries and in later calls of the same client. The
  mock now models the server's lock and cache. Documentation corrected.
- Medium: two processes could both take over the same stale queue lock (each
  could remove the lock the other had just written), leading to two writers
  on one queue file. Fixed in both languages with an exclusive takeover
  guard file and a second read of the lock under the guard. Tests in both
  languages, including the race.
- Medium: the Python client crashed with `ValueError` on a 422 body with a
  key such as `statement_²` (non-ASCII digit). Fixed with an ASCII pattern.
- Low: opening a FIFO placed as the queue or lock file blocked the process.
  Files are now opened with `O_NONBLOCK` (both languages).
- Low: after compaction the directory was not synced, so a crash could bring
  back the old file and lose later appends; a failed compaction left its
  temporary file. Both fixed (both languages).
- Low: the CLI printed attribute names and PUIDs from the input with C1
  control characters (U+009B starts terminal sequences) and bidirectional
  controls; `quote` escaped only C0. Fixed; test added.
- Low: the Python client kept server error keys with control characters
  (the TypeScript client filtered them) and raised `ValueError` instead of
  `ConfigError` for unparsable base URLs. Fixed.
- Low: `rationale submit --queue` and `queue drain` without a token queued
  the statements and ended with "failed 2 (fatal_error)" and no reason. The
  token is now checked first (exit 2 with the reason).
- Low: tests missing for controls described as done: strict UTF-8 queue
  decoding, queue size and line limits, the declared response size check,
  `credentials: 'omit'` and the file-owner check. Added; each fails when its
  control is removed.
- Low: README omitted the 12-month extension in Article 19(1) and the
  earlier application to designated very large online platforms
  (Article 92). Added. NOTICE and README now name the upstream licence
  (GPL-2.0).
- Test vectors: 47 new shared cases derived from and checked against the
  server's rules (prefix `server-` and `stricter-`), run by both languages.

### Not changed

- `constantTimeEqual` also compares lengths after comparing SHA-256 digests;
  the length check is redundant, so removing it fails no test.

### Follow-up decisions applied

- Failures where the request certainly never reached the server (DNS
  failure, connection refused, host or network unreachable, connect timeout,
  certificate failure in the TLS handshake) are retried without the
  31-second wait, in both languages. The decision uses the error cause from
  Node.js fetch and Python's urllib; a missing or unknown cause keeps the
  wait. Tests cover both paths (a real refused connection and simulated
  causes) and fail when the classification is removed or forced.
- Packaging checked from a clean clone (`npm ci --ignore-scripts`, then the
  release steps): `npm pack --dry-run` builds through `prepack` and contains
  `dist`. CI and the release workflow now run `npm run build` and
  `scripts/check-pack.mjs` on the `npm pack --dry-run --json` output, so a
  package without its compiled code cannot be published. The Python sdist and
  wheel contain the `rationale` package, `schema.json` and `py.typed`.
- NOTICE states that only interoperable attribute names, enumeration values,
  labels and limits come from the GPL-2.0 upstream repository. README has a
  roadmap item: a real sandbox run before 1.0.

### Results

- `npm run check`: typecheck, lint and 757 tests pass. Line coverage 96.8 %
  (statements 93.6 %, branches 88.4 %, functions 97.2 %).
- Python: mypy clean; 51 unittest tests pass (556 shared vectors as
  subtests).

## Coordinator review (8 Nov 2026)

No new findings. Checked: the token is held in a wrapper that only reveals it to build the `Authorization` header and is redacted from server text; the decisions on the independent review (no 31-second wait when the connection was never established, NOTICE wording, sandbox run as a pre-1.0 roadmap item) are implemented with tests; the package builds and `scripts/check-pack.mjs` passes; `npm run check`: 757 tests pass. Accepted as is: the Python sdist carries `tests/test_*.py` without their helpers (no effect on users).
