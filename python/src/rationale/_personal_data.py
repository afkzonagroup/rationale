# Copyright 2026 MB AFKzona Group
# SPDX-License-Identifier: Apache-2.0
"""Heuristic check for obvious personal data (Article 24(5) DSA).

The same patterns as the TypeScript package (src/personal-data.ts). They
catch only common forms; a clean result does not mean a text contains no
personal data.
"""

from __future__ import annotations

import re
from typing import List, Tuple

_OCTET = r"(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])"

PERSONAL_DATA_PATTERNS: Tuple[Tuple[str, "re.Pattern[str]"], ...] = (
    ("email", re.compile(r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z0-9-])")),
    ("phone", re.compile(r"(?<![A-Za-z0-9+])\+[0-9](?:[ ./()-]?[0-9]){7,14}(?![0-9])")),
    ("ipv4", re.compile(r"(?<![0-9.])" + _OCTET + r"(?:\." + _OCTET + r"){3}(?![0-9]|\.[0-9])")),
    ("iban", re.compile(r"(?<![A-Za-z0-9])[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?(?![A-Za-z0-9])")),
)


def find_personal_data(text: str) -> List[str]:
    """Kinds of personal data the heuristic finds, in pattern order."""
    return [kind for kind, rx in PERSONAL_DATA_PATTERNS if rx.search(text)]
