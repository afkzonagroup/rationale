# Copyright 2026 MB AFKzona Group
# SPDX-License-Identifier: Apache-2.0
"""Validation of statements of reasons, mirroring the TypeScript package.

Both implementations are checked against the same JSON test vectors
(test-vectors/statements.json).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from ._personal_data import find_personal_data
from ._schema import ATTRIBUTES, DECISION_GROUP, AttributeSpec, Condition
from ._text import code_point_length, is_iso_date, is_server_url, quote, server_trim

FREE_TEXT = (
    "decision_visibility_other",
    "decision_monetary_other",
    "decision_facts",
    "decision_ground_reference_url",
    "illegal_content_legal_ground",
    "illegal_content_explanation",
    "incompatible_content_ground",
    "incompatible_content_explanation",
    "content_type_other",
    "category_specification_other",
    "source_identity",
)

END_DATES = (
    "end_date_account_restriction",
    "end_date_monetary_restriction",
    "end_date_service_restriction",
    "end_date_visibility_restriction",
)

_PD_NAMES = {"email": "an email address", "phone": "a phone number", "ipv4": "an IP address", "iban": "a bank account number"}


@dataclass(frozen=True)
class Issue:
    """One finding about one attribute. Messages never repeat free-text values; at most 60 characters of an invalid enumeration value."""

    code: str
    attribute: str
    message: str


@dataclass(frozen=True)
class ValidationResult:
    """Result of validating one statement."""

    ok: bool
    errors: Tuple[Issue, ...]
    warnings: Tuple[Issue, ...]
    statement: Optional[Dict[str, Any]] = None


@dataclass
class _Ctx:
    errors: List[Issue] = field(default_factory=list)
    warnings: List[Issue] = field(default_factory=list)

    def err(self, code: str, attribute: str, message: str) -> None:
        self.errors.append(Issue(code, attribute, message))

    def warn(self, code: str, attribute: str, message: str) -> None:
        self.warnings.append(Issue(code, attribute, message))


def _normalize(value: Any) -> Any:
    if isinstance(value, str):
        t = server_trim(value)
        return None if t == "" else t
    if isinstance(value, list):
        return [server_trim(v) if isinstance(v, str) else v for v in value]
    return value


def _holds(cond: Condition, values: Mapping[str, Any]) -> bool:
    v = values.get(cond.attribute)
    if cond.equals is not None:
        return v == cond.equals
    if cond.contains is not None:
        return isinstance(v, list) and cond.contains in v
    return False


def _describe(cond: Condition) -> str:
    if cond.equals is not None:
        return f"{cond.attribute} is {cond.equals}"
    return f"{cond.attribute} contains {cond.contains or ''}"


def _check(name: str, spec: AttributeSpec, value: Any, ctx: _Ctx) -> Any:
    """Check one present value; return the normalised value or None."""
    kind = spec.kind
    if kind in ("text", "url"):
        if not isinstance(value, str):
            ctx.err("invalid_type", name, f"{name} must be a string.")
            return None
        if any(0xD800 <= ord(c) <= 0xDFFF for c in value):
            ctx.err("invalid_format", name, f"{name} contains an invalid Unicode sequence (a lone surrogate).")
            return None
        if spec.max is not None and code_point_length(value) > spec.max:
            ctx.err("too_long", name, f"{name} is longer than {spec.max} characters.")
            return None
        if kind == "url" and not is_server_url(value):
            ctx.err("invalid_format", name, f"{name} must be an http or https URL (ASCII; percent-encode other characters).")
            return None
        if spec.pattern is not None and re.fullmatch(spec.pattern, value) is None:
            ctx.err("invalid_format", name, f"{name} has an invalid format (allowed: {spec.pattern}).")
            return None
        return value
    if kind == "date":
        if not isinstance(value, str):
            ctx.err("invalid_type", name, f"{name} must be a string in the form YYYY-MM-DD.")
            return None
        if not is_iso_date(value):
            ctx.err("invalid_date", name, f"{name} must be a real date in the form YYYY-MM-DD.")
            return None
        if (spec.earliest is not None and value < spec.earliest) or (spec.latest is not None and value > spec.latest):
            ctx.err("date_out_of_range", name, f"{name} must be between {spec.earliest or 'any date'} and {spec.latest or 'any date'}.")
            return None
        return value
    if kind == "enum":
        if not isinstance(value, str):
            ctx.err("invalid_type", name, f"{name} must be a string.")
            return None
        if value not in (spec.values or ()):
            ctx.err("invalid_value", name, f"{quote(value)} is not an allowed value of {name}.")
            return None
        return value
    if kind == "enum-list":
        if not isinstance(value, list):
            ctx.err("invalid_type", name, f"{name} must be an array.")
            return None
        if any(not isinstance(v, str) for v in value):
            ctx.err("invalid_type", name, f"{name} must contain only strings.")
            return None
        bad = [v for v in value if v not in (spec.values or ())]
        if bad:
            shown = ", ".join(quote(b) for b in bad[:5])
            ctx.err("invalid_value", name, f"{name} contains values that are not allowed: {shown}{', ...' if len(bad) > 5 else ''}.")
            return None
        unique = list(dict.fromkeys(value))
        if len(unique) != len(value):
            ctx.warn("duplicate_value", name, f"{name} listed a value more than once; duplicates were removed.")
        return unique or None
    if kind == "content-id":
        if not isinstance(value, dict):
            ctx.err("invalid_type", name, f'{name} must be an object such as {{"EAN-13": "..."}}.')
            return None
        out: Dict[str, str] = {}
        failed = False
        for key in sorted(value):
            attr = f"{name}.{key}"
            pattern = (spec.keys or {}).get(key)
            if pattern is None:
                ctx.err("unknown_attribute", attr, f'Unknown {name} key {quote(key)}. Only "EAN-13" is accepted.')
                failed = True
                continue
            raw = _normalize(value[key])
            if raw is None:
                continue
            if not isinstance(raw, str):
                ctx.err("invalid_type", attr, f"{attr} must be a string.")
                failed = True
            elif re.fullmatch(pattern, raw) is None:
                ctx.err("invalid_format", attr, f"{attr} must be 13 digits.")
                failed = True
            else:
                out[key] = raw
        if failed:
            return None
        return out or None
    raise AssertionError(f"unknown kind {kind}")


def validate_statement(value: Any, personal_data: str = "warn") -> ValidationResult:
    """Validate one statement of reasons and return its normalised form.

    ``personal_data`` is "warn" (default), "error" or "off".
    """
    if personal_data not in ("warn", "error", "off"):
        raise ValueError("personal_data must be warn, error or off")
    ctx = _Ctx()
    # bool is a subclass of int, and JSON objects are dicts: anything else is not a statement.
    if not isinstance(value, dict):
        ctx.err("not_an_object", "", "A statement must be a JSON object.")
        return ValidationResult(False, tuple(ctx.errors), tuple(ctx.warnings))

    values: Dict[str, Any] = {}
    for key in sorted(k for k in value if not isinstance(k, str) or k not in ATTRIBUTES):
        ctx.err("unknown_attribute", str(key), f"Unknown attribute {quote(str(key))}. The API accepts only documented attributes.")

    for name, spec in ATTRIBUTES.items():
        raw = _normalize(value.get(name))
        if raw is None:
            continue
        checked = _check(name, spec, raw, ctx)
        if checked is not None:
            values[name] = checked

    def invalid(n: str) -> bool:
        return any(e.attribute == n or e.attribute.startswith(n + ".") for e in ctx.errors)

    for name, spec in ATTRIBUTES.items():
        present = name in values or invalid(name)
        if spec.required and not present:
            ctx.err("required", name, f"{name} is required.")
        if spec.required_when is not None and not present and _holds(spec.required_when, values):
            ctx.err("required", name, f"{name} is required when {_describe(spec.required_when)}.")
    if not any(n in values or invalid(n) for n in DECISION_GROUP):
        ctx.err("decision_required", DECISION_GROUP[0], f"At least one of {', '.join(DECISION_GROUP)} is required (Article 17(1) DSA).")

    for name, spec in ATTRIBUTES.items():
        if name not in values:
            continue
        if spec.excluded_unless is not None and not _holds(spec.excluded_unless, values):
            del values[name]
            ctx.warn("excluded_attribute", name, f"{name} is ignored by the server unless {_describe(spec.excluded_unless)}; it was removed.")
        elif spec.excluded_when is not None and _holds(spec.excluded_when, values):
            del values[name]
            ctx.warn("excluded_attribute", name, f"{name} is ignored by the server when {_describe(spec.excluded_when)}; it was removed.")

    category = values.get("category")
    additions = values.get("category_addition")
    if isinstance(category, str) and isinstance(additions, list) and category in additions:
        rest = [c for c in additions if c != category]
        if rest:
            values["category_addition"] = rest
        else:
            del values["category_addition"]
        ctx.warn("category_in_addition", "category_addition", "category_addition repeated the main category; it was removed from the list.")

    application = values.get("application_date")
    if isinstance(application, str):
        for name in END_DATES:
            end = values.get(name)
            if isinstance(end, str) and end < application:
                ctx.warn(
                    "end_date_before_application_date",
                    name,
                    f"{name} is before application_date. The API documentation asks for an end date on or after the application date.",
                )

    if personal_data != "off":
        for name in FREE_TEXT:
            v = values.get(name)
            if not isinstance(v, str):
                continue
            kinds = find_personal_data(v)
            if not kinds:
                continue
            msg = (
                f"{name} may contain personal data ({', '.join(_PD_NAMES[k] for k in kinds)}). "
                "Article 24(5) DSA requires that submissions contain no personal data."
            )
            if personal_data == "error":
                ctx.err("possible_personal_data", name, msg)
            else:
                ctx.warn("possible_personal_data", name, msg)

    if ctx.errors:
        return ValidationResult(False, tuple(ctx.errors), tuple(ctx.warnings))
    statement = {name: values[name] for name in ATTRIBUTES if name in values}
    return ValidationResult(True, tuple(ctx.errors), tuple(ctx.warnings), statement)


def validate_statements(values: Sequence[Any], personal_data: str = "warn") -> List[ValidationResult]:
    """Validate several statements; a repeated PUID is an error on every later occurrence."""
    seen: set[str] = set()
    out: List[ValidationResult] = []
    for v in values:
        r = validate_statement(v, personal_data)
        if r.ok and r.statement is not None:
            puid = str(r.statement["puid"])
            if puid in seen:
                r = ValidationResult(False, (Issue("duplicate_puid", "puid", "This PUID already appears earlier in the same input."),), r.warnings)
            else:
                seen.add(puid)
        out.append(r)
    return out
