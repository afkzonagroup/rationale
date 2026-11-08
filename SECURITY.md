# Security

## Reporting a vulnerability

Report privately through GitHub Security Advisories ("Report a
vulnerability" on the repository's Security tab). Do not open a public issue.
If that is not possible, email info@afkzonagroup.lt. We acknowledge reports
within 5 working days.

Supported: the latest 0.x release.

## Threat model

### Assets

1. **The API token.** It identifies your platform to the Commission's
   database. Anyone holding it can submit statements in your platform's name.
2. **Completeness of submissions.** Article 24(5) DSA requires every decision
   to reach the database. A lost statement is a compliance failure; a
   duplicate is noise in a public database.
3. **Correctness of submissions.** Statements are published. A wrong value,
   or personal data in a free-text field, becomes public.
4. **The queue file**, which holds statements until they are sent.
5. **The host running Rationale** (files, network position).

### Actors

- A network attacker between Rationale and the API.
- A hostile or compromised server, or anything answering at a configured
  address (it may return huge, malformed or prototype-polluting responses,
  redirects, or echo the token).
- Someone who can change configuration (environment variables, CLI flags,
  mapping files) but should not be able to send the token elsewhere.
- Another local user on a shared host (symlinks, world-writable directories).
- A caller of the intake HTTP handler without the shared secret.
- A hostile contributor or a compromised dependency.

### Trust boundaries

- Statement input (JSON, CSV, mapping files, intake request bodies):
  untrusted, validated at the boundary.
- HTTP responses from the API: untrusted.
- The queue file when read back: untrusted, every line re-validated.
- Configuration: partly trusted; base URLs are allow-listed.

### Mitigations

**Token**

- Read only from an environment variable or a function (secret store). A
  token passed as a plain string option or as a CLI argument is refused.
- Held in a `Secret` object whose string, JSON and inspect forms are
  `[REDACTED]`. Only the HTTP layer reveals it, to set the header.
- Checked for printable ASCII only, so it cannot inject HTTP headers.
- Every server-provided text that ends up in an error, outcome, event or
  queue record passes through `redact()`, which removes the token and any
  `Bearer ...` value. Transport errors are replaced by fixed messages, so
  request details from the underlying library never leak.
- Tests send the token back from a hostile mock server and check every
  outcome, event, error, stack and `inspect` output for it.

**Where requests go (no SSRF through configuration)**

- Production: the fixed URL `https://transparency.dsa.ec.europa.eu`, and only
  with `allowProduction: true` (CLI: `--confirm-production`).
- Sandbox: `https://` only, default port, a DNS host name ending in
  `.europa.eu`, no user info, path, query or fragment, not the production
  host.
- Local (tests and mock servers): `127.0.0.1` or `[::1]` only, never
  `localhost` (which DNS could point anywhere).
- Paths are fixed. The only variable path part, the PUID in the existing-PUID
  lookup, is checked against the PUID pattern and percent-encoded.
- Redirects are never followed (`redirect: "manual"`; in Python a redirect
  handler that refuses). A 3xx is reported as an error. Cookies and
  credentials modes are off. Rationale configures no proxy (Python ignores
  proxy environment variables).

**Responses**

- Size cap (default 8 MiB) checked against `Content-Length` and while
  streaming. Time cap per request (default 30 s) covering the whole
  exchange, so a server that drips its answer byte by byte is cut off.
- Server-provided text that reaches an outcome, error or the terminal is
  redacted and stripped of control characters (no terminal escape
  sequences).
- JSON is parsed into prototype-free objects; `__proto__`, `constructor`
  and `prototype` keys are dropped; nesting is capped at 64 levels.
- Only expected fields are read, each type-checked (`uuid` must look like a
  UUID, `permalink` must be http(s)). Indexes in `errors.statement_N` are
  bounded by the batch that was sent, so a hostile server cannot cause an
  endless resend loop.

**Retries and rate limits**

- Only network errors, timeouts, 408, 425, 429 and 5xx are retried, at most
  `maxAttempts` times, with exponential backoff and full jitter, and
  `Retry-After` up to a cap (longer waits end the attempt as a retryable
  failure instead of blocking).
- Rate limiters belong to the client instance (one per application), so
  concurrent calls share the budget. Defaults are the server's own limits.
- Idempotency: the PUID is unique per platform on the server. A timeout
  followed by a retry ends as `duplicate`, after the existing-PUID endpoint
  confirms the PUID exists. An unconfirmed "PUID in use" answer is retried,
  never reported as done.
- The server locks each PUID for 30 seconds while it stores a statement, and
  its batch endpoint caches a PUID as in use for two days when a request
  collides with that lock, even if the lock holder then fails. After an
  attempt with an unknown outcome (timeout, network error, abort, 500, 502,
  504) the client therefore waits 31 seconds before it sends any of those
  PUIDs again, so its own retries never collide with its own locks. Errors
  where the request certainly never reached the server (DNS failure,
  connection refused, host or network unreachable, connect timeout,
  certificate failure in the TLS handshake) are retried without that wait.
  The decision uses the error cause from Node.js fetch or Python's urllib;
  when the cause is missing or unknown, the wait applies.

**Queue file**

- Plain file names only; the directory must exist and must not be
  world-writable without the sticky bit.
- Opened with `O_NOFOLLOW`; symlinks, non-regular files, files owned by
  another user and files writable by group or others are refused.
- Created with mode 0600; appends are synced to disk (`fdatasync`) before a
  call returns. Compaction writes a new file with `O_EXCL`, syncs it and
  renames it over the old one.
- A lock file (`O_EXCL`, mode 0600) allows one process at a time. A lock
  left by a process that no longer exists is taken over, under an exclusive
  `.lock.takeover` guard file and after reading the lock again, so two
  processes cannot both take over the same stale lock.
- Files are opened with `O_NONBLOCK`, so a FIFO put in place of the queue or
  lock file cannot make the process hang.
- On open, every line is parsed with a strict allow-list of fields and every
  statement is validated again. A damaged file is refused. A last line
  without a newline (an interrupted write) is cut off.
- Stored failure reasons are redacted, stripped of control characters and
  limited to 500 characters.

**Intake HTTP handler**

- `POST` only; `Content-Type: application/json` only. Browsers cannot send
  such a request cross-site without a CORS preflight, which the handler
  never approves; together with the bearer secret this prevents cross-site
  request forgery.
- Bearer secret from the environment or a secret store, compared in constant
  time (SHA-256 of both values, then `timingSafeEqual`).
- Body size limit (default 1 MiB) checked against `Content-Length` and while
  reading. Optional rate-limit hook.
- Security headers on every response (`nosniff`, `no-store`, a CSP of
  `default-src 'none'`, `no-referrer`). Errors return fixed messages, never
  stack traces.

**Input files (CLI)**

- File size cap (default 256 MiB, `--max-bytes`), mapping files at most
  1 MiB. The CSV reader caps columns, field length and rows, and rejects
  malformed quoting.
- Mapping files are checked against an allow-list of keys and target
  attributes; values are copied into fresh objects keyed only by known
  attribute names.

**Code and supply chain**

- No `eval`, `new Function`, dynamic `import()` of user input or child
  processes (enforced by ESLint and a repository test).
- Zero runtime dependencies. Development dependencies are pinned and locked.
  `npm audit --omit=dev` is clean. No install scripts. A `files` allow-list.
- CI runs only on pull requests and by hand, with pinned action SHAs and
  read-only permissions.

**Statement content**

- Every statement is validated before it is sent or queued; only the
  normalised form (known attributes only, built into a fresh object) is
  sent.
- Statement text must be well-formed Unicode: a lone surrogate would make
  the server fail to decode the whole batch.

## Data flows and personal data

- Statements go from your system to the Rationale process, optionally into
  the local queue file, and then only to the configured API base URL.
  Nothing else is sent anywhere. There is no telemetry.
- Article 24(5) DSA requires that submitted information contains no personal
  data. Rationale warns about obvious personal data in free-text attributes
  (or refuses it with `personalData: "error"`). The check is a heuristic. You
  remain responsible for what you submit.
- The queue file holds statements until they are sent, and the outcome of
  each (PUID, database UUID, short failure reason). Run `rationale queue
  compact` to remove settled entries, and set a retention period for the file.
