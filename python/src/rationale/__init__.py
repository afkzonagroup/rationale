# Copyright 2026 MB AFKzona Group
# SPDX-License-Identifier: Apache-2.0
"""Rationale for Python: submit statements of reasons to the DSA Transparency Database.

Article 24(5) of Regulation (EU) 2022/2065 (Digital Services Act) requires
providers of online platforms to submit the decisions and statements of
reasons referred to in Article 17(1) to the Commission's database. This
package validates statements against the database's rules (mirrored from the
official source code), submits them with retries and idempotency by PUID,
and keeps a durable local queue. Standard library only.

Not legal advice. Using this package does not by itself make anyone compliant.
"""

from __future__ import annotations

from ._client import HttpResponse, Outcome, Report, TransparencyClient, parse_json_safe, sanitize_json, urllib_transport
from ._core import (
    DEFAULT_TOKEN_ENV,
    Clock,
    ConfigError,
    RateLimiter,
    RationaleError,
    RetryPolicy,
    Secret,
    parse_retry_after,
    read_token,
    redact,
    resolve_base_url,
)
from ._personal_data import find_personal_data
from ._queue import DrainReport, EnqueueReport, JsonlQueueStore, MemoryQueueStore, QueueEntry, drain_queue, enqueue_statements
from ._schema import (
    ATTRIBUTE_NAMES,
    ATTRIBUTES,
    BATCH_LIMIT,
    DECISION_GROUP,
    PRODUCTION_BASE_URL,
    SCHEMA_SOURCE,
    SCHEMA_VERSION,
    TERRITORIAL_PRESETS,
    AttributeSpec,
)
from ._text import to_iso_date
from ._validate import Issue, ValidationResult, validate_statement, validate_statements

__version__ = "0.1.0"

__all__ = [
    "ATTRIBUTES",
    "ATTRIBUTE_NAMES",
    "AttributeSpec",
    "BATCH_LIMIT",
    "Clock",
    "ConfigError",
    "DECISION_GROUP",
    "DEFAULT_TOKEN_ENV",
    "DrainReport",
    "EnqueueReport",
    "HttpResponse",
    "Issue",
    "JsonlQueueStore",
    "MemoryQueueStore",
    "Outcome",
    "PRODUCTION_BASE_URL",
    "QueueEntry",
    "RateLimiter",
    "RationaleError",
    "Report",
    "RetryPolicy",
    "SCHEMA_SOURCE",
    "SCHEMA_VERSION",
    "Secret",
    "TERRITORIAL_PRESETS",
    "TransparencyClient",
    "ValidationResult",
    "__version__",
    "drain_queue",
    "enqueue_statements",
    "find_personal_data",
    "parse_json_safe",
    "parse_retry_after",
    "read_token",
    "redact",
    "resolve_base_url",
    "sanitize_json",
    "to_iso_date",
    "urllib_transport",
    "validate_statement",
    "validate_statements",
]
