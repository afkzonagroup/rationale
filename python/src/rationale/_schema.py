# Copyright 2026 MB AFKzona Group
# SPDX-License-Identifier: Apache-2.0
"""The statement of reasons schema, loaded from the bundled schema.json.

schema.json is generated from the official DSA Transparency Database source
code by the TypeScript package's scripts/generate.ts and is identical to
schema/statement-schema.json at the repository root.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from importlib import resources
from typing import Any, Dict, FrozenSet, Mapping, Optional, Tuple


@dataclass(frozen=True)
class Condition:
    """A condition on another attribute."""

    attribute: str
    equals: Optional[str] = None
    contains: Optional[str] = None


@dataclass(frozen=True)
class AttributeSpec:
    """How one attribute is checked."""

    name: str
    kind: str
    label: str
    law: Tuple[str, ...]
    required: bool = False
    max: Optional[int] = None
    pattern: Optional[str] = None
    earliest: Optional[str] = None
    latest: Optional[str] = None
    values: Optional[Tuple[str, ...]] = None
    required_when: Optional[Condition] = None
    excluded_unless: Optional[Condition] = None
    excluded_when: Optional[Condition] = None
    keys: Optional[Mapping[str, str]] = None


def _load() -> Dict[str, Any]:
    text = resources.files("rationale").joinpath("schema.json").read_text(encoding="utf-8")
    data = json.loads(text)
    if not isinstance(data, dict):
        raise RuntimeError("schema.json is not an object")
    return data


def _cond(v: Any) -> Optional[Condition]:
    if v is None:
        return None
    return Condition(attribute=str(v["attribute"]), equals=v.get("equals"), contains=v.get("contains"))


SCHEMA: Dict[str, Any] = _load()
SCHEMA_VERSION: str = str(SCHEMA["schemaVersion"])
SCHEMA_SOURCE: Mapping[str, str] = {k: str(SCHEMA["source"][k]) for k in ("repository", "commit", "fetched", "documentation")}
PRODUCTION_BASE_URL: str = str(SCHEMA["api"]["productionBaseUrl"])
ENDPOINT_SINGLE: str = str(SCHEMA["api"]["single"])
ENDPOINT_BATCH: str = str(SCHEMA["api"]["batch"])
ENDPOINT_EXISTING_PUID: str = str(SCHEMA["api"]["existingPuid"])
BATCH_LIMIT: int = int(SCHEMA["api"]["batchSize"]["max"])
SERVER_RATE_LIMITS: Mapping[str, Mapping[str, int]] = SCHEMA["api"]["rateLimits"]
SERVER_PUID_LOCK_SECONDS: int = int(SCHEMA["api"]["puidLockSeconds"])
DECISION_GROUP: Tuple[str, ...] = tuple(SCHEMA["decisionGroup"])
TERRITORIAL_PRESETS: Mapping[str, Tuple[str, ...]] = {k: tuple(v) for k, v in SCHEMA["territorialPresets"].items()}
TRIM_CODE_POINTS: FrozenSet[int] = frozenset(int(h, 16) for h in SCHEMA["trim"])

ATTRIBUTES: Dict[str, AttributeSpec] = {}
for _name, _s in SCHEMA["attributes"].items():
    _keys = _s.get("keys")
    ATTRIBUTES[_name] = AttributeSpec(
        name=_name,
        kind=str(_s["kind"]),
        label=str(_s["label"]),
        law=tuple(_s["law"]),
        required=bool(_s.get("required", False)),
        max=_s.get("max"),
        pattern=_s.get("pattern"),
        earliest=_s.get("earliest"),
        latest=_s.get("latest"),
        values=tuple(_s["values"]) if "values" in _s else None,
        required_when=_cond(_s.get("requiredWhen")),
        excluded_unless=_cond(_s.get("excludedUnless")),
        excluded_when=_cond(_s.get("excludedWhen")),
        keys={k: str(v["pattern"]) for k, v in _keys.items()} if _keys else None,
    )

ATTRIBUTE_NAMES: Tuple[str, ...] = tuple(ATTRIBUTES)
