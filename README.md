# Rationale

An SDK for providers of online platforms to submit statements of reasons to the
European Commission's DSA Transparency Database. TypeScript and Python. No
runtime dependencies.

Not legal advice. Using Rationale does not by itself make anyone compliant.

## Why it exists

The Digital Services Act, Regulation (EU) 2022/2065
([EUR-Lex](https://eur-lex.europa.eu/eli/reg/2022/2065/oj), OJ L 277,
27.10.2022, p. 1), requires two things that meet here:

- [Article 17(1)](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32022R2065#art_17):
  providers of hosting services give a statement of reasons to the affected
  user for every restriction of visibility, monetary payments, the service or
  the account, imposed because content is illegal or against their terms.
  Article 17(3) lists what the statement must contain.
- [Article 24(5)](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32022R2065#art_24):
  providers of online platforms submit those decisions and statements of
  reasons to the Commission, "without undue delay", for a public database.
  The information must not contain personal data.

An online platform is a hosting service that stores and disseminates
information to the public at the request of its users
([Article 3(i)](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32022R2065#art_3)).
Article 17(2) limits the duty to inform the user: it applies where the
user's electronic contact details are known, and not to deceptive
high-volume commercial content.

The Regulation applies from 17 February 2024
([Article 93(2)](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32022R2065#art_93));
for very large online platforms designated earlier, from four months after
their designation (Article 92).
Article 24(5) is in Section 3 of Chapter III, which
[Article 19](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32022R2065#art_19)
does not apply to micro and small enterprises (Recommendation 2003/361/EC),
nor during the 12 months after a provider loses that status, unless they are
designated very large online platforms.

The Commission runs the database at
[transparency.dsa.ec.europa.eu](https://transparency.dsa.ec.europa.eu/) and
publishes its [API documentation](https://transparency.dsa.ec.europa.eu/page/api-documentation)
and [source code](https://github.com/digital-services-act/transparency-database).
It publishes analysis tools, but no submission SDK. Rationale fills that gap:
it validates statements with the same rules as the server, sends them in
batches with safe retries, and keeps them in a local queue when the API is
down.

No implementing act prescribes the database schema. The Commission sets it in
the API documentation. Since 1 July 2025 the categories and keywords follow
the templates of Commission Implementing Regulation (EU)
[2024/2835](https://eur-lex.europa.eu/eli/reg_impl/2024/2835/oj) (transparency
reports), as the Commission's
[announcements](https://transparency.dsa.ec.europa.eu/page/announcements)
explain.

## What it does and does not do

It does:

- build statements with a typed builder, one method per Article 17(3) element;
- validate every attribute, enumeration, length, date and conditional rule of
  the server, before anything is sent;
- submit single statements or batches (split to the server's 100-per-call
  limit and a byte budget);
- use the platform unique identifier (PUID) as an idempotency key, so a retry
  after a timeout does not create a duplicate; after an unknown outcome it
  waits out the server's 30-second PUID lock before sending the PUID again;
- retry only transient failures, with exponential backoff, jitter and
  `Retry-After`, and keep to the server's published rate limits;
- keep statements in a durable, append-only queue file until the API accepts
  them;
- read JSON Lines and CSV files (with a column mapping) from the command line;
- warn about obvious personal data (emails, phone numbers, IP addresses,
  IBANs) in free text.

It does not:

- write the statement you send to the affected user. Article 17(3)(f)
  (information on redress), the user notification and the internal
  complaint-handling system of
  [Article 20](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32022R2065#art_20)
  are not part of the database and are not covered;
- decide whether a decision needs a statement, which category fits, or
  whether your platform is in scope;
- find all personal data. The check is a heuristic for obvious cases;
- talk to the real API in its tests. It was tested against a local mock of the
  documented behaviour. Test with your own sandbox account before production.

## Quick start

```sh
npm install @afkzona/rationale
```

Validate a file without sending anything:

```sh
npx rationale validate statements.jsonl
```

Send it to your sandbox (address from the onboarding email, token from your
profile page on the database site):

```sh
export RATIONALE_API_TOKEN='...'
npx rationale submit statements.jsonl --env sandbox --sandbox-url "$TDB_SANDBOX_URL" --queue rationale-queue.jsonl
```

Production needs both `--env production` and `--confirm-production`.

## Build and validate a statement

```ts
import { statement, validateStatement } from '@afkzona/rationale';

const sor = statement()
  .puid('listing-48213')
  .visibility(['DECISION_VISIBILITY_CONTENT_REMOVED'])
  .illegalContent({
    legalGround: 'Article 5 of the national product safety act',
    explanation: 'The listing offers a product that this provision prohibits.',
  })
  .facts('A notice reported the listing. A review confirmed that the product is prohibited.')
  .source('SOURCE_ARTICLE_16')
  .automation({ detection: 'No', decision: 'AUTOMATED_DECISION_NOT_AUTOMATED' })
  .contentType(['CONTENT_TYPE_PRODUCT'])
  .category('STATEMENT_CATEGORY_UNSAFE_AND_PROHIBITED_PRODUCTS')
  .territorialScope('EU')
  .contentDate('2026-10-01')
  .applicationDate('2026-10-02')
  .build();

console.log(sor.puid, sor.territorial_scope?.length);
// listing-48213 27

const check = validateStatement({ ...sor, decision_facts: 'Reported by jane@example.com.' });
console.log(check.ok, JSON.stringify(check.warnings.map((w) => w.code)));
// true ["possible_personal_data"]

const bad = validateStatement({ ...sor, decision_ground: 'Illegal content', puid: 'listing 48213' });
console.log(JSON.stringify(bad.errors.map((e) => `${e.attribute}: ${e.code}`)));
// ["decision_ground: invalid_value","puid: invalid_format"]
```

`validateStatement` returns `ok`, `errors`, `warnings` and the normalised
`statement`. Normalised means: strings trimmed the way the server trims them,
empty values dropped, duplicates removed from lists, and attributes the
server would ignore removed (each with a warning). The client always sends
the normalised form.

## Submit statements

```ts
import { readFile } from 'node:fs/promises';
import { TransparencyClient } from '@afkzona/rationale';

// The sandbox address comes with your onboarding email; the token from your profile page.
const client = new TransparencyClient({
  environment: 'sandbox',
  sandboxBaseUrl: process.env['TDB_SANDBOX_URL'] ?? '',
  token: { env: 'RATIONALE_API_TOKEN' },
});

const lines = (await readFile('statements.jsonl', 'utf8')).split('\n').filter((l) => l.trim() !== '');
const report = await client.submitBatch(lines.map((l): unknown => JSON.parse(l)));

console.log(JSON.stringify(report.counts));
// {"created":2,"duplicate":0,"invalid":0,"rejected":0,"failed":0,"validated":0}

// Sending the same file again is safe: the PUIDs are already in the database.
const again = await client.submitBatch(lines.map((l): unknown => JSON.parse(l)));
console.log(again.counts.duplicate);
// 2
```

Each input gets one outcome, in input order:

| Status | Meaning |
|---|---|
| `created` | Stored. `uuid` is the database identifier. |
| `duplicate` | The database already holds this PUID for your platform. Treat as success. |
| `invalid` | Failed local validation. Nothing was sent. |
| `rejected` | The server answered 422 for this statement. Fix it; do not resend unchanged. |
| `failed` | Not sent successfully. `error.retryable` says whether a later attempt may work. |
| `validated` | Dry run: valid, not sent. |

`submit()` uses the single-statement endpoint. `submitBatch()` uses the batch
endpoint, which the Commission recommends. When the server rejects a batch,
it creates none of it; Rationale then removes the rejected or already stored
statements and sends the rest again.

When the server reports a PUID as already used, Rationale checks it with the
existing-PUID endpoint before it reports `duplicate`. If the PUID is not
found (the server holds a short lock while another request with the same
PUID runs), the statement is tried again later instead.

The server locks each PUID for up to 30 seconds while it stores a statement.
A batch request that hits such a lock is refused, and the server then
records the PUID as in use for two days, even if the request holding the
lock fails. So after a request whose outcome is unknown (timeout, broken
connection, abort, HTTP 500, 502 or 504), the same client waits 31 seconds
before it sends any of its PUIDs again, in retries and in later calls.

There is no wait when the request certainly never reached the server: the
host name did not resolve, the connection was refused, the host or network
was unreachable, the connection attempt timed out, or the server's
certificate failed the TLS checks. Those are retried with the normal
backoff. Rationale reads this from the error cause that Node.js fetch and
Python's urllib report; with a custom `fetch` or transport that hides the
cause, every network error counts as unknown and the wait applies.

## Durable queue and webhook-style worker

Your moderation system should not wait for, or depend on, the Commission's
API. Put statements into a queue and let a worker send them:

```ts
import { createServer } from 'node:http';
import { TransparencyClient } from '@afkzona/rationale';
import { createIntake, createNodeHandler, startQueueWorker } from '@afkzona/rationale/connectors';
import { JsonlQueueStore } from '@afkzona/rationale/node';

// Your moderation system POSTs each decision here. Statements are validated
// and written to a durable queue; a worker sends them to the database.
export const store = await JsonlQueueStore.open('rationale-queue.jsonl');

const client = new TransparencyClient({
  environment: 'sandbox',
  sandboxBaseUrl: process.env['TDB_SANDBOX_URL'] ?? '',
  token: { env: 'RATIONALE_API_TOKEN' },
});

const handler = createNodeHandler({
  intake: createIntake({ store }),
  secret: { env: 'INTAKE_SECRET' },
});

export const server = createServer((req, res) => void handler(req, res));
server.listen(Number(process.env['PORT'] ?? 8787), '127.0.0.1');

export const worker = startQueueWorker({
  client,
  store,
  intervalMs: 10_000,
  onReport: (r) => {
    console.log(`sent: created ${r.created}, duplicate ${r.duplicate}, rejected ${r.rejected}, failed ${r.failed}`);
  },
});

process.once('SIGTERM', () => {
  server.close();
  void worker.stop().then(() => store.close());
});
```

The queue file is append-only JSON Lines, created with mode 0600 and synced to
disk on every write. A lock file stops two processes from using it at once.
`compact()` rewrites it with only the pending statements. The Python package
reads and writes the same format.

## Express and Fastify

The handler from `createNodeHandler` works with `node:http`, Express and
Fastify. It reads and limits the body itself, so mount it without a body
parser.

Express:

```ts
import express from 'express';
import { createIntake, createNodeHandler } from '@afkzona/rationale/connectors';
import { JsonlQueueStore } from '@afkzona/rationale/node';

const store = await JsonlQueueStore.open('rationale-queue.jsonl');
const handler = createNodeHandler({ intake: createIntake({ store }), secret: { env: 'INTAKE_SECRET' } });

export const app = express();
// No body parser on this route: the handler reads and limits the body itself.
app.post('/dsa/statements', (req, res) => void handler(req, res));
```

Fastify:

```ts
import Fastify from 'fastify';
import { createIntake, createNodeHandler } from '@afkzona/rationale/connectors';
import { JsonlQueueStore } from '@afkzona/rationale/node';

const store = await JsonlQueueStore.open('rationale-queue.jsonl');
const handler = createNodeHandler({ intake: createIntake({ store }), secret: { env: 'INTAKE_SECRET' } });

export const app = Fastify();
await app.register((scope, _opts, done) => {
  // Leave the body unread so the handler can check its size and type itself.
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser('*', (_req, _payload, next) => {
    next(null);
  });
  scope.post('/dsa/statements', (req, reply) => {
    reply.hijack();
    void handler(req.raw, reply.raw);
  });
  done();
});
```

The handler accepts `POST` with `Content-Type: application/json` and a bearer
secret (compared in constant time), limits the body to 1 MiB by default,
takes an optional rate-limit hook, sets security headers and never returns
stack traces. It is meant for calls from your own systems, not from browsers.

## Command line

```text
rationale validate <file> [--format jsonl|csv] [--mapping <file>] [--strict]
                          [--personal-data warn|error|off] [--json]
rationale submit <file> --env sandbox|production|local [--sandbox-url <url>]
                          [--confirm-production] [--dry-run] [--queue <file>]
                          [--batch-size <n>] [--token-env <name>]
rationale queue status|drain|compact --queue <file>
```

- The token is read from `RATIONALE_API_TOKEN` (or `--token-env NAME`). It is
  never accepted as an argument.
- `--strict` treats warnings as errors.
- Exit codes: 0 success, 1 invalid or unsent statements, 2 usage or
  configuration error.

CSV files without a mapping need a header row with attribute names; list
attributes are split on `|`, and the column `content_id.EAN-13` fills
`content_id`. A mapping file maps your own columns:

```json
{
  "version": 1,
  "delimiter": ",",
  "fields": {
    "puid": { "column": "decision_id" },
    "decision_visibility": { "column": "action", "split": "|", "map": { "removed": "DECISION_VISIBILITY_CONTENT_REMOVED" } },
    "source_type": { "value": "SOURCE_VOLUNTARY" },
    "territorial_scope": { "value": ["LT", "LV", "EE"] },
    "content_id.EAN-13": { "column": "ean" }
  }
}
```

Each field has exactly one of `column` (a CSV column, or a key of a JSONL
object) or `value` (a constant). `split` is for list attributes. `map`
translates values. Empty cells are left out.

## Python

The Python package `afkzona-rationale` (module `rationale`, Python 3.10+,
standard library only) has the same validator, client, retry and rate-limit
rules, and queue format. Both implementations run the same JSON test vectors
(`test-vectors/statements.json`).

```python
import json
import os

from rationale import TransparencyClient

with open("statements.jsonl", encoding="utf-8") as f:
    statements = [json.loads(line) for line in f if line.strip()]

client = TransparencyClient(
    "sandbox",
    sandbox_base_url=os.environ["TDB_SANDBOX_URL"],
    token={"env": "RATIONALE_API_TOKEN"},
)
report = client.submit_batch(statements)
print(report.count("created"), report.count("duplicate"))
```

See [python/README.md](python/README.md).

## Configuration

`new TransparencyClient(options)`:

| Option | Default | Notes |
|---|---|---|
| `environment` | required | `"sandbox"`, `"production"` or `"local"` (a mock server on 127.0.0.1 or [::1], for tests). |
| `sandboxBaseUrl` | none | Required for the sandbox. Must be `https://` and a host under `europa.eu`. |
| `allowProduction` | `false` | Must be `true` with `"production"`. The production URL is fixed. |
| `token` | `{ env: "RATIONALE_API_TOKEN" }` | `{ env: NAME }` or a function (secret store). Plain strings are refused. |
| `dryRun` | `false` | Validate and report, send nothing. |
| `batchSize` | `100` | 1 to 100. |
| `maxBatchBytes` | 4 MiB | Batches are split to stay below this. The server's limit is not documented. |
| `timeoutMs` | 30,000 | Per request. |
| `maxResponseBytes` | 8 MiB | Larger responses are refused. |
| `retry` | 5 attempts, 500 ms base, 30 s cap, 120 s max `Retry-After` | Only network errors, timeouts, 408, 425, 429 and 5xx are retried. After an unknown outcome (timeout, network error after connecting, 500, 502, 504) the next attempt waits at least 31 s (the server's PUID lock); not when the connection was never established. |
| `rateLimit` | server limits | 200/s and 12,000/min per user for all calls, plus 4/s and 240/min for batch calls. `false` turns it off. |
| `confirmDuplicates` | `true` | Confirm "PUID in use" answers with the existing-PUID endpoint. |
| `validation.personalData` | `"warn"` | `"error"` makes suspected personal data an error; `"off"` skips the check. |
| `onEvent` | none | Request, response, retry and split events. They never contain the token or statement text. |
| `fetch` | global `fetch` | Replace it to add a proxy or custom TLS settings. |

## The schema

The schema is mirrored from the official source code, not written by hand:

| | |
|---|---|
| Repository | https://github.com/digital-services-act/transparency-database |
| Commit | `a3444a9c5ae96640ff0978e92205c9c654909a37` |
| Fetched | 2026-11-08 |
| Version identifier | `2025-07-01+a3444a9c` (`SCHEMA_VERSION`) |
| Files read | `app/Http/Requests/StatementStoreRequest.php` (single endpoint rules), `app/Services/GroupedSubmissionsService.php` (batch endpoint rules and post-processing), `app/Models/Statement.php` (enumerations), `app/Services/EuropeanCountriesService.php`, `app/Services/EuropeanLanguagesService.php`, `routes/api_v1.php`, `app/Providers/RouteServiceProvider.php` (rate limits), `app/Http/Kernel.php` (middleware), `app/Services/PlatformUniqueIdService.php` and `app/Exceptions/PuidNotUnique*.php` (PUID handling), `resources/markdown/api-documentation.md` |

Files in this repository:

- `schema/source-rules.json`: facts extracted from those files (rules as
  tokens, enumerations, limits, file hashes). Made by
  `scripts/extract-schema.mjs`, which only reads files.
- `schema/attributes.json`: the curated attribute specification. A test
  (`test/schema-parity.test.ts`) checks every rule in it against
  `source-rules.json`: required attributes, lengths, enumerations, date
  bounds, patterns, conditions, exclusions and the differences between the
  single and batch endpoints.
- `schema/statement-schema.json` (published with the package as
  `@afkzona/rationale/schema.json`), `openapi/transparency-database.openapi.json`,
  `src/generated/schema.ts` and `src/generated/openapi-types.ts`: generated by
  `scripts/generate.ts`. The Commission publishes no OpenAPI document; this one
  is derived and unofficial. The TypeScript types are derived from it.

To follow a new version of the official schema:

```sh
git clone https://github.com/digital-services-act/transparency-database /tmp/tdb
npm run schema:extract -- /tmp/tdb --fetched "$(date +%F)"
# update schema/attributes.json until the parity test passes, then:
npm run generate
node scripts/generate-vectors.ts
npm run check
```

### Where the documentation and the code differ

The server's validation code is followed, and the difference is documented:

- `territorial_scope` is called required in the documentation; the code
  accepts it missing. Rationale accepts it missing.
- End dates "must be after or equal to the application date" in the
  documentation; the code does not check it. Rationale warns
  (`end_date_before_application_date`).
- `content_language_other` appears on the attribute explanation page but is
  not in the validation rules (the server drops it). Rationale refuses it as
  unknown.
- `content_id_ean` is accepted by the single endpoint only and is not
  documented. Rationale refuses it; use `content_id: {"EAN-13": "..."}`.
- `category_specification_other` is kept by the single endpoint but dropped
  by the batch endpoint unless `KEYWORD_OTHER` is selected. Rationale drops it
  (with a warning) in both cases.

### Where Rationale is stricter than the server

Every statement Rationale accepts, in its normalised form, passes the
server's rules. In these cases it refuses input the server would accept:

- Unknown attributes are errors (the server drops them silently, which hides
  typos).
- Text attributes must be JSON strings; list attributes JSON arrays;
  `content_id` a JSON object with only the `EAN-13` key.
- The string `"null"` is not accepted as an enumeration value.
- `decision_ground_reference_url` must be an ASCII `http` or `https` URL
  without user info or IPv6 literal (the server's `url` rule allows many more
  schemes and raw Unicode).
- Attributes the server would ignore are still type- and length-checked
  before they are removed.
- A PUID that appears twice in one input is an error on the second
  occurrence (the server would reject the whole batch).

## How it maps to the law

| DSA provision | What it requires | Attributes / feature |
|---|---|---|
| [Art. 17(1)(a)](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32022R2065#art_17) | Restrictions of visibility | `decision_visibility`, `decision_visibility_other` |
| Art. 17(1)(b) | Restriction of monetary payments | `decision_monetary`, `decision_monetary_other` |
| Art. 17(1)(c) | Suspension or termination of the service | `decision_provision` |
| Art. 17(1)(d) | Suspension or termination of the account | `decision_account` (`account_type` is optional context) |
| Art. 17(1) | Ground: illegal content or incompatible with terms | `decision_ground` |
| Art. 17(2) | Applies at the latest from the date the restriction is imposed | `application_date` |
| Art. 17(3)(a) | Type of decision, territorial scope and duration | decision attributes, `territorial_scope`, `end_date_*` |
| Art. 17(3)(b) | Facts and circumstances; notice under Art. 16 or own initiative; identity of the notifier where strictly necessary | `decision_facts`, `source_type`, `source_identity` |
| Art. 17(3)(c) | Use of automated means, including automated detection | `automated_detection`, `automated_decision` |
| Art. 17(3)(d) | Legal ground and explanation for illegal content | `illegal_content_legal_ground`, `illegal_content_explanation`, `decision_ground_reference_url` |
| Art. 17(3)(e) | Contractual ground and explanation for incompatible content | `incompatible_content_ground`, `incompatible_content_explanation`, `incompatible_content_illegal` |
| Art. 17(3)(f) | Information on redress | Not part of the database. Not covered. |
| Art. 17(4) | Clear, specific, as precise as possible | `content_type`, `content_date`, `content_language`, `content_id` (the Commission's explanation page ties these to Art. 17(1) and (4)) |
| [Art. 24(5)](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32022R2065#art_24) | Submit decisions and statements without undue delay; no personal data | The client, queue and worker; `puid`; the personal-data heuristic |
| Recital 66 | Standard format, real-time updates where possible | Batch submission, durable queue, worker |
| IR (EU) [2024/2835](https://eur-lex.europa.eu/eli/reg_impl/2024/2835/oj), Annex | Categories and keywords of transparency reports | `category`, `category_addition`, `category_specification` (the database uses the same taxonomy since 1 July 2025) |

## Validation codes

Errors (the statement is not sent): `not_an_object`, `unknown_attribute`,
`required`, `decision_required` (none of the four Article 17(1) decisions),
`invalid_type`, `invalid_value`, `too_long` (in Unicode code points, as the
server counts), `invalid_format`, `invalid_date`, `date_out_of_range`,
`duplicate_puid`, and `possible_personal_data` with `personalData: "error"`.

Warnings: `excluded_attribute`, `duplicate_value`, `category_in_addition`,
`end_date_before_application_date`, `possible_personal_data`.

## Limitations

- Tested against a mock of the documented API, not against the real service.
  The sandbox host name is not public; you get it during onboarding.
- The server's request size limit is not documented. Batches are split at
  4 MiB by default and halved on HTTP 413.
- If a batch request hits the server's lock on a PUID while another request
  still holds it, and that other request then fails, the server reports the
  PUID as in use for up to two days (its PUID cache), and the existing-PUID
  endpoint confirms it. Rationale then reports the statement as `duplicate`
  although nothing was stored; it cannot tell the two cases apart. Rationale
  avoids this for its own requests (see "Submit statements"), but not for
  requests from other processes or clients: do not send the same PUID from
  two processes at once, and wait at least 31 seconds before resending a
  PUID from a new process after a request with an unknown outcome.
- The personal-data check is a heuristic. It does not replace your own review.
- Rationale configures no proxy. The Python package ignores proxy
  environment variables; Node.js uses them only if you enable
  `NODE_USE_ENV_PROXY`. Pass a custom `fetch` (TypeScript) or `transport`
  (Python) if you need a proxy.
- One process at a time per queue file. A lock left by a crashed process is
  taken over only if no process with that ID is running; otherwise remove
  the `.lock` file by hand.
- The queue file grows with every outcome. Run `rationale queue compact`
  (or `compact()`) from time to time.

## Roadmap

Before 1.0:

- Run the full flow (single and batch submission, duplicates, the
  existing-PUID check, rate limits, the PUID lock behaviour) against a real
  sandbox account of the DSA Transparency Database. Until then Rationale is
  tested only against a local mock built from the published source code.

## Security

See [SECURITY.md](SECURITY.md) for the threat model. In short: the token comes
only from the environment or a function and is redacted from every message;
requests go only to the fixed production URL, an HTTPS `europa.eu` sandbox
host, or loopback; redirects are never followed; responses are size-capped and
parsed without prototype pollution; queue files refuse symlinks and are created
with mode 0600.

## Dependencies

Runtime: none. The TypeScript package uses the global `fetch` and Node.js
built-ins (Node.js 22 or newer). The Python package uses the standard library
(Python 3.10 or newer).

Development only (pinned in `package-lock.json`): TypeScript, ESLint with
typescript-eslint, Vitest with V8 coverage, `@types/node`, and Express,
Fastify and `@types/express` to test the connector examples for real. The
Python tests use `unittest` and mypy.

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
"Rationale" is a trademark of MB AFKzona Group; see [TRADEMARKS.md](TRADEMARKS.md).

The schema facts in `schema/source-rules.json` (attribute names, enumeration
values and labels, limits) are taken from the Commission's
transparency-database repository (published under the GNU General Public
License v2.0) to describe its public interface. No code from that repository
is included: only the interoperable attribute names, enumeration values and
their labels, and limits.

## Enterprise

MB AFKzona Group offers integration into your systems, custom connectors and
features, and support agreements. Contact info@afkzonagroup.lt.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Pull requests need a signed
[Contributor Licence Agreement](CLA.md).

## Disclaimer

This software is provided as is, without warranty. It is not legal advice and
does not establish that a provider meets its obligations under Regulation (EU)
2022/2065. The DSA Transparency Database, its API and its schema belong to
the European Commission, which may change them at any time. Rationale is not
affiliated with or endorsed by the European Commission.

Maintained by AFKzona Group.
