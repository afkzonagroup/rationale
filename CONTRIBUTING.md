# Contributing

Thank you for helping. Please read this first.

## Before you start

- Pull requests need a signed [Contributor Licence Agreement](CLA.md). Add the
  sentence from "How to sign" to your first pull request.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report security problems privately (see [SECURITY.md](SECURITY.md)), not in issues.

## Setup

The library and the tools need Node.js 22 or newer. The Python package needs
Python 3.10 or newer.

```sh
npm ci
npm run check          # typecheck + lint + tests
npm run coverage       # coverage report (thresholds: 90 % lines)

cd python
python3 -m venv .venv
.venv/bin/python -m pip install mypy==2.4.0
.venv/bin/python -m mypy
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests -t .
```

## Rules

- TypeScript strict mode, no `any`, no `@ts-ignore`, no unexplained
  `eslint-disable`. Python: `mypy --strict`, no `type: ignore`.
- No runtime dependencies. If you think one is needed, open an issue first.
- Every rule, limit and security control has a test that fails when the
  control is removed.
- Schema changes start from the official source code. Run
  `npm run schema:extract -- <checkout>` on a checkout of
  https://github.com/digital-services-act/transparency-database, update
  `schema/attributes.json` until `test/schema-parity.test.ts` passes, then run
  `npm run generate` and `node scripts/generate-vectors.ts`. Never add an
  attribute or value that the official rules do not have.
- Changes to validation must keep the TypeScript and Python packages in step.
  Add a case to `scripts/generate-vectors.ts` (with the expected result written
  from the rules, not from running the validator), regenerate, and run both
  test suites.
- Legal statements cite the official text on EUR-Lex. Do not rely on blog
  posts for what the law says.
- Tests never call the real API. Use the mock servers in `test/helpers` and
  `python/tests/helpers.py`.
- Never write raw invisible or bidirectional control characters into files;
  use escapes or `String.fromCodePoint`. A test checks this.

## Commits

Small, focused commits with a plain description of the change.
