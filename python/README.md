# Rationale for Python

Submit statements of reasons to the European Commission's DSA Transparency
Database (Article 24(5) of Regulation (EU) 2022/2065). Standard library only,
Python 3.10 or newer.

Not legal advice. Using this package does not by itself make anyone compliant.

```python
import json
import os

from rationale import JsonlQueueStore, TransparencyClient, drain_queue, enqueue_statements, validate_statement

result = validate_statement({"puid": "x"})
print(result.ok, [(e.code, e.attribute) for e in result.errors][:2])

client = TransparencyClient(
    "sandbox",
    sandbox_base_url=os.environ["TDB_SANDBOX_URL"],  # from your onboarding email
    token={"env": "RATIONALE_API_TOKEN"},  # never a plain string
)

with open("statements.jsonl", encoding="utf-8") as f:
    statements = [json.loads(line) for line in f if line.strip()]

store = JsonlQueueStore("rationale-queue.jsonl")
enqueue_statements(store, statements)
report = drain_queue(client, store)
print(report.created, report.duplicate, report.stopped_because)
store.close()
```

The validator, the retry and rate-limit rules, the base URL allow-list and
the queue file format are the same as in the TypeScript package. Both are
tested with the same JSON test vectors. The full documentation, the schema
source and the legal mapping are in the
[main README](https://github.com/afkzonagroup/rationale#readme).

Licence: Apache-2.0. Copyright 2026 MB AFKzona Group.
