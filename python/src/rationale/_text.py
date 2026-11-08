# Copyright 2026 MB AFKzona Group
# SPDX-License-Identifier: Apache-2.0
"""Pure helpers shared by validation and the client."""

from __future__ import annotations

import datetime
import json
import re
from typing import Any

from ._schema import TRIM_CODE_POINTS


def server_trim(value: str) -> str:
    """Strip the characters the server strips (Laravel TrimStrings, Str::trim) from both ends."""
    start = 0
    end = len(value)
    while start < end and ord(value[start]) in TRIM_CODE_POINTS:
        start += 1
    while end > start and ord(value[end - 1]) in TRIM_CODE_POINTS:
        end -= 1
    return value[start:end]


def code_point_length(value: str) -> int:
    """Length in Unicode code points, as PHP's mb_strlen counts it."""
    return len(value)


_DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2})", re.ASCII)


def is_iso_date(value: str) -> bool:
    """True for a real calendar date written as YYYY-MM-DD (PHP date_format:Y-m-d)."""
    m = _DATE.fullmatch(value)
    if not m:
        return False
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if mo < 1 or mo > 12 or d < 1:
        return False
    leap = (y % 4 == 0 and y % 100 != 0) or y % 400 == 0
    days = (31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)[mo - 1]
    return d <= days


def to_iso_date(d: datetime.date) -> str:
    """Format a date (or a datetime, converted to UTC) as YYYY-MM-DD."""
    if isinstance(d, datetime.datetime):
        if d.tzinfo is not None:
            d = d.astimezone(datetime.timezone.utc)
        return d.date().isoformat()
    return d.isoformat()


# The ASCII subset of the server's url rule (Laravel Str::isUrl, derived from
# Symfony's UrlValidator): http/https, no user info, no IPv6 literals, no raw
# non-ASCII characters. Same pattern as the TypeScript package (src/text.ts).
_URL = re.compile(
    r"https?://(?:(?:(?:[a-z0-9_-]+\.)+(?:xn--[a-z0-9-]+|[a-z0-9]+)|[a-z0-9_-]+)\.?|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})"
    r"(?::[0-9]+)?"
    r"(?:/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*"
    r"(?:\?(?:[a-z0-9\-._~!$&'\[\]()*+,;=:@/?]|%[0-9a-f]{2})*)?"
    r"(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?",
    re.IGNORECASE | re.ASCII,
)


def is_server_url(value: str) -> bool:
    """True if the server's url rule accepts the value."""
    return _URL.fullmatch(value) is not None


def quote(value: Any, limit: int = 60) -> str:
    """Quote a value for an error message, shortened."""
    s = value if isinstance(value, str) else json.dumps(value, default=str)
    if len(s) > limit:
        s = s[:limit] + "..."
    return json.dumps(s)
