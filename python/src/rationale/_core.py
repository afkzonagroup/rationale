# Copyright 2026 MB AFKzona Group
# SPDX-License-Identifier: Apache-2.0
"""Errors, token handling, environment selection, retry policy and rate limiting."""

from __future__ import annotations

import email.utils
import os
import random
import re
import threading
import time
import urllib.parse
from dataclasses import dataclass
from typing import Callable, Dict, List, Mapping, Optional, Sequence, Tuple, Union

from ._schema import PRODUCTION_BASE_URL


class RationaleError(Exception):
    """Base error. Messages never contain the API token."""

    def __init__(self, code: str, message: str, retryable: bool = False, status: Optional[int] = None, not_sent: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.status = status
        # True only when the request certainly never reached the server (no connection, or a failed certificate check).
        self.not_sent = not_sent

    def to_dict(self) -> Dict[str, object]:
        d: Dict[str, object] = {"code": self.code, "message": self.message, "retryable": self.retryable}
        if self.status is not None:
            d["status"] = self.status
        return d


class ConfigError(RationaleError):
    """Invalid or unsafe configuration."""

    def __init__(self, message: str) -> None:
        super().__init__("config", message)


_BEARER = re.compile(r"\b(Bearer)\s+[^\s\"',;]+", re.IGNORECASE)


def redact(text: str, secrets: Sequence[str] = ()) -> str:
    """Remove secrets and bearer values from a text."""
    for s in secrets:
        if len(s) >= 4:
            text = text.replace(s, "[REDACTED]")
    return _BEARER.sub(r"\1 [REDACTED]", text)


# ---------------------------------------------------------------------------
# Token

TokenSource = Union[Mapping[str, str], Callable[[], str]]
"""``{"env": "NAME"}`` or a function returning the token (e.g. from a secret store)."""

DEFAULT_TOKEN_ENV = "RATIONALE_API_TOKEN"
_ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}")
_TOKEN = re.compile(r"[\x21-\x7e]{1,4096}")


class Secret:
    """A token value that does not print."""

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def reveal(self) -> str:
        return self._value

    def __repr__(self) -> str:
        return "Secret([REDACTED])"

    __str__ = __repr__


def check_token_source(source: object) -> None:
    """Check the shape of a token source without reading it."""
    if callable(source):
        return
    if isinstance(source, str):
        raise RationaleError("token", 'Pass the token as {"env": "VARIABLE_NAME"} or as a function, not as a string.')
    if isinstance(source, Mapping) and set(source) == {"env"} and isinstance(source["env"], str) and _ENV_NAME.fullmatch(source["env"]):
        return
    raise RationaleError("token", "Invalid token source.")


def read_token(source: TokenSource, env: Optional[Mapping[str, str]] = None) -> Secret:
    """Read and check the token."""
    check_token_source(source)
    if callable(source):
        try:
            value: object = source()
        except Exception:
            raise RationaleError("token", "The token function failed.") from None
    else:
        name = source["env"]
        value = (env if env is not None else os.environ).get(name)
        if not value:
            raise RationaleError("token", f"Environment variable {name} is not set.")
    if not isinstance(value, str):
        raise RationaleError("token", "The token must be a string.")
    token = value.strip()
    if not _TOKEN.fullmatch(token):
        raise RationaleError("token", "The token is empty, too long or contains characters that are not allowed in an HTTP header.")
    return Secret(token)


# ---------------------------------------------------------------------------
# Environment and base URL allow-list

_DNS = re.compile(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", re.ASCII)
_LOOPBACK = {"127.0.0.1", "[::1]"}


def resolve_base_url(environment: str, sandbox_base_url: Optional[str] = None, allow_production: bool = False, local_base_url: Optional[str] = None) -> str:
    """Return the checked origin for an environment ("sandbox", "production" or "local")."""

    def parse(url: object, what: str) -> urllib.parse.SplitResult:
        if not isinstance(url, str) or len(url) > 2048 or any(ord(c) < 0x21 for c in url):
            raise ConfigError(f"{what} must be a URL string.")
        try:
            u = urllib.parse.urlsplit(url)
        except ValueError:
            raise ConfigError(f"{what} is not a valid URL.") from None
        if not u.scheme or not u.netloc:
            raise ConfigError(f"{what} is not a valid URL.")
        if "@" in u.netloc:
            raise ConfigError(f"{what} must not contain credentials.")
        if u.query or u.fragment or "?" in url or "#" in url:
            raise ConfigError(f"{what} must not contain a query or fragment.")
        if u.path not in ("", "/"):
            raise ConfigError(f"{what} must be a bare origin without a path.")
        return u

    if environment == "production":
        if allow_production is not True:
            raise ConfigError("Production requires allow_production=True. Test in the sandbox first.")
        if sandbox_base_url is not None or local_base_url is not None:
            raise ConfigError("Do not combine production with a sandbox or local base URL.")
        return PRODUCTION_BASE_URL
    if environment == "sandbox":
        if sandbox_base_url is None:
            raise ConfigError("sandbox_base_url is required for the sandbox environment (see your onboarding email).")
        u = parse(sandbox_base_url, "sandbox_base_url")
        host = (u.hostname or "").lower()
        if u.scheme.lower() != "https":
            raise ConfigError("sandbox_base_url must use https.")
        try:
            port = u.port
        except ValueError:
            raise ConfigError("sandbox_base_url has an invalid port.") from None
        if port is not None and port != 443:
            raise ConfigError("sandbox_base_url must use the default HTTPS port.")
        if u.netloc.lower() not in (host, f"{host}:443"):
            raise ConfigError("sandbox_base_url must be a host name under europa.eu.")
        if not _DNS.fullmatch(host) or not host.endswith(".europa.eu"):
            raise ConfigError("sandbox_base_url must be a host name under europa.eu.")
        if f"https://{host}" == PRODUCTION_BASE_URL:
            raise ConfigError("sandbox_base_url points to production. Use environment production with allow_production instead.")
        return f"https://{host}"
    if environment == "local":
        if local_base_url is None:
            raise ConfigError("local_base_url is required for the local environment.")
        u = parse(local_base_url, "local_base_url")
        if u.scheme.lower() not in ("http", "https"):
            raise ConfigError("local_base_url must use http or https.")
        host_part = u.netloc.rsplit(":", 1)[0] if not u.netloc.endswith("]") else u.netloc
        if host_part not in _LOOPBACK:
            raise ConfigError("local_base_url must be 127.0.0.1 or [::1].")
        try:
            port = u.port
        except ValueError:
            raise ConfigError("local_base_url has an invalid port.") from None
        return f"{u.scheme.lower()}://{host_part}" + (f":{port}" if port is not None else "")
    raise ConfigError('environment must be "sandbox", "production" or "local".')


# ---------------------------------------------------------------------------
# Retry policy

RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


@dataclass(frozen=True)
class RetryPolicy:
    """Retry settings (same defaults as the TypeScript package)."""

    max_attempts: int = 5
    base_delay: float = 0.5
    max_delay: float = 30.0
    max_retry_after: float = 120.0

    def __post_init__(self) -> None:
        if not isinstance(self.max_attempts, int) or not 1 <= self.max_attempts <= 20:
            raise ConfigError("max_attempts must be an integer from 1 to 20.")
        for name in ("base_delay", "max_delay", "max_retry_after"):
            v = getattr(self, name)
            if not isinstance(v, (int, float)) or not 0 <= v <= 3600:
                raise ConfigError(f"{name} must be between 0 and 3600 seconds.")

    def backoff(self, attempt: int, rnd: Callable[[], float]) -> float:
        """Exponential backoff with full jitter; ``attempt`` starts at 1."""
        cap: float = min(float(self.max_delay), float(self.base_delay) * float(2 ** max(0, attempt - 1)))
        return cap * min(max(float(rnd()), 0.0), 1.0)


def parse_retry_after(value: Optional[str], now: float) -> Optional[float]:
    """Retry-After (seconds or HTTP date) in seconds from ``now`` (a Unix time)."""
    if value is None:
        return None
    v = value.strip()
    if re.fullmatch(r"\d{1,10}", v, re.ASCII):
        return float(int(v))
    if len(v) > 64 or not re.fullmatch(r"[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT", v, re.ASCII):
        return None
    try:
        at = email.utils.parsedate_to_datetime(v).timestamp()
    except (TypeError, ValueError):
        return None
    return max(0.0, at - now)


# ---------------------------------------------------------------------------
# Rate limiting


@dataclass
class Clock:
    """Time source: ``monotonic`` for intervals, ``wall`` for HTTP dates, ``sleep`` to wait."""

    monotonic: Callable[[], float] = time.monotonic
    wall: Callable[[], float] = time.time
    sleep: Callable[[float], None] = time.sleep


class RateLimiter:
    """Sliding-window limiter over one or more (limit, seconds) windows. Thread-safe; one per client."""

    def __init__(self, windows: Sequence[Tuple[int, float]], clock: Optional[Clock] = None) -> None:
        for limit, seconds in windows:
            if not isinstance(limit, int) or limit < 1 or seconds <= 0:
                raise ConfigError("Rate windows need a positive integer limit and a positive interval.")
        self._windows = list(windows)
        self._clock = clock or Clock()
        self._stamps: List[float] = []
        self._lock = threading.Lock()

    def delay(self) -> float:
        now = self._clock.monotonic()
        wait = 0.0
        for limit, seconds in self._windows:
            inside = [t for t in self._stamps if t > now - seconds]
            if len(inside) >= limit:
                wait = max(wait, inside[len(inside) - limit] + seconds - now)
        return wait

    def acquire(self) -> None:
        with self._lock:
            while True:
                wait = self.delay()
                if wait <= 0:
                    break
                self._clock.sleep(wait)
            now = self._clock.monotonic()
            self._stamps.append(now)
            longest = max(s for _, s in self._windows)
            self._stamps = [t for t in self._stamps if t > now - longest]


def default_random() -> float:
    return random.random()
