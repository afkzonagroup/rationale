# Copyright 2026 MB AFKzona Group
# SPDX-License-Identifier: Apache-2.0
"""Submission client, mirroring the TypeScript TransparencyClient.

Standard library only (urllib). Never follows redirects, caps response size
and time, parses JSON without object hooks, retries only transient errors,
treats an already-used PUID as success ("duplicate") after confirming it.
"""

from __future__ import annotations

import errno
import functools
import json
import re
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple, Union

from ._core import (
    DEFAULT_TOKEN_ENV,
    RETRYABLE_STATUS,
    Clock,
    ConfigError,
    RateLimiter,
    RationaleError,
    RetryPolicy,
    Secret,
    TokenSource,
    check_token_source,
    default_random,
    parse_retry_after,
    read_token,
    redact,
    resolve_base_url,
)
from ._schema import BATCH_LIMIT, ENDPOINT_BATCH, ENDPOINT_EXISTING_PUID, ENDPOINT_SINGLE, SERVER_PUID_LOCK_SECONDS, SERVER_RATE_LIMITS
from ._validate import Issue, validate_statements

_VERSION = "0.1.0"
_FORBIDDEN_KEYS = frozenset({"__proto__", "constructor", "prototype"})
_MAX_DEPTH = 64
# Field names accepted from server error objects (same rule as the TypeScript package); others are dropped.
_FIELD_KEY = re.compile(r"[a-z_.0-9-]{1,100}", re.ASCII | re.IGNORECASE)
_STATEMENT_KEY = re.compile(r"statement_([0-9]{1,3})", re.ASCII)
# The server's PUID lock time plus one second of margin.
_PUID_LOCK_SECONDS = float(SERVER_PUID_LOCK_SECONDS + 1)
# Failures after which the request may still be running on the server, or may have died holding its locks.
_AMBIGUOUS_CODES = frozenset({"timeout", "network", "aborted"})
_AMBIGUOUS_STATUS = frozenset({500, 502, 504})


@dataclass(frozen=True)
class HttpResponse:
    status: int
    retry_after: Optional[str]
    json: Any
    text: str


def sanitize_json(value: Any, depth: int = 0) -> Any:
    """Drop prototype keys and cap nesting (mirrors the TypeScript package)."""
    if depth > _MAX_DEPTH:
        raise RationaleError("bad_response", "The response is nested too deeply.")
    if isinstance(value, list):
        return [sanitize_json(v, depth + 1) for v in value]
    if isinstance(value, dict):
        return {k: sanitize_json(v, depth + 1) for k, v in value.items() if k not in _FORBIDDEN_KEYS}
    return value


def clean_server_text(text: str, secrets: Sequence[str]) -> str:
    """Redact secrets and replace control characters (including terminal escapes) with spaces."""
    return "".join(" " if ord(c) < 0x20 or 0x7F <= ord(c) <= 0x9F else c for c in redact(text, secrets))


def parse_json_safe(text: str) -> Any:
    """Parse JSON; return None on errors (including excessive nesting)."""
    try:
        return sanitize_json(json.loads(text))
    except (ValueError, RecursionError, RationaleError):
        return None


def failed_before_sending(error: BaseException) -> bool:
    """True when a urllib failure certainly happened before any request bytes were sent.

    DNS failures, refused connections, unreachable hosts or networks, and
    certificate errors in the TLS handshake (http.client connects and
    completes the handshake before it writes the request). Everything else,
    including timeouts and resets, counts as "may have been sent".
    """
    reason: object = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(reason, (socket.gaierror, ConnectionRefusedError, ssl.SSLCertVerificationError)):
        return True
    return isinstance(reason, OSError) and not isinstance(reason, TimeoutError) and reason.errno in (errno.EHOSTUNREACH, errno.ENETUNREACH)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


Transport = Callable[[str, str, Dict[str, str], Optional[bytes], float, int], HttpResponse]
"""(method, url, headers, body, timeout seconds, max response bytes) -> HttpResponse."""


def urllib_transport(method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float, max_bytes: int) -> HttpResponse:
    """The default transport: urllib with certificate checks, no redirects, no proxies from the environment."""
    opener = urllib.request.build_opener(
        _NoRedirect(),
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
    )
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    # urllib's timeout applies to each socket operation; this deadline caps the whole exchange.
    deadline = time.monotonic() + timeout
    try:
        resp = opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        resp = e
    except (socket.timeout, TimeoutError):
        raise RationaleError("timeout", f"No response within {timeout} s.", retryable=True) from None
    except (urllib.error.URLError, OSError) as e:
        if failed_before_sending(e):
            raise RationaleError("network", "Could not connect to the server; nothing was sent (network error).", retryable=True, not_sent=True) from None
        raise RationaleError("network", "The request failed before a response arrived (network error).", retryable=True) from None
    try:
        declared = resp.headers.get("Content-Length")
        if declared is not None and declared.isdigit() and int(declared) > max_bytes:
            raise RationaleError("response_too_large", f"The response is larger than {max_bytes} bytes.", status=resp.status)
        chunks: List[bytes] = []
        total = 0
        # read1 returns what has arrived instead of waiting for the full amount, so the deadline is checked as data trickles in.
        read = getattr(resp, "read1", None) or resp.read
        while True:
            try:
                chunk = read(65536)
            except (socket.timeout, TimeoutError):
                raise RationaleError("timeout", f"The response did not complete within {timeout} s.", retryable=True) from None
            except OSError:
                raise RationaleError("network", "The connection failed while reading the response.", retryable=True) from None
            if not chunk:
                break
            if time.monotonic() > deadline:
                raise RationaleError("timeout", f"The response did not complete within {timeout} s.", retryable=True)
            total += len(chunk)
            if total > max_bytes:
                raise RationaleError("response_too_large", f"The response is larger than {max_bytes} bytes.", status=resp.status)
            chunks.append(chunk)
        text = b"".join(chunks).decode("utf-8", errors="replace")
        ctype = resp.headers.get("Content-Type", "") or ""
        status = int(resp.status)
        retry_after = resp.headers.get("Retry-After")
    finally:
        resp.close()
    is_json = ctype.lower().startswith("application/json") or "+json" in ctype.lower()
    parsed = parse_json_safe(text) if is_json else None
    return HttpResponse(status, retry_after, parsed, "" if parsed is not None else clean_server_text(text[:500], [headers.get("Authorization", "")[7:]]))


@dataclass(frozen=True)
class Outcome:
    """Outcome of one statement: status is created, duplicate, invalid, rejected, failed or validated."""

    status: str
    index: int
    puid: Optional[str] = None
    uuid: Optional[str] = None
    errors: Tuple[Issue, ...] = ()
    server_errors: Mapping[str, Tuple[str, ...]] = field(default_factory=dict)
    error: Optional[Dict[str, object]] = None
    statement: Optional[Dict[str, Any]] = None


@dataclass(frozen=True)
class Report:
    outcomes: Tuple[Outcome, ...]
    dry_run: bool

    def count(self, status: str) -> int:
        return sum(1 for o in self.outcomes if o.status == status)


class TransparencyClient:
    """Client for the DSA Transparency Database submission API."""

    def __init__(
        self,
        environment: str,
        *,
        sandbox_base_url: Optional[str] = None,
        allow_production: bool = False,
        local_base_url: Optional[str] = None,
        token: Optional[TokenSource] = None,
        dry_run: bool = False,
        timeout: float = 30.0,
        max_response_bytes: int = 8 * 1024 * 1024,
        batch_size: int = BATCH_LIMIT,
        max_batch_bytes: int = 4 * 1024 * 1024,
        retry: Optional[RetryPolicy] = None,
        rate_limit: bool = True,
        confirm_duplicates: bool = True,
        personal_data: str = "warn",
        transport: Optional[Transport] = None,
        clock: Optional[Clock] = None,
        rnd: Optional[Callable[[], float]] = None,
        env: Optional[Mapping[str, str]] = None,
        on_event: Optional[Callable[[Dict[str, object]], None]] = None,
    ) -> None:
        self._base = resolve_base_url(environment, sandbox_base_url, allow_production, local_base_url)
        self._dry_run = dry_run is True
        self._token: Optional[TokenSource] = None
        if not self._dry_run:
            src: TokenSource = token if token is not None else {"env": DEFAULT_TOKEN_ENV}
            check_token_source(src)
            self._token = src
        if not isinstance(batch_size, int) or not 1 <= batch_size <= BATCH_LIMIT:
            raise ConfigError(f"batch_size must be an integer from 1 to {BATCH_LIMIT}.")
        if not 0 < timeout <= 600:
            raise ConfigError("timeout must be between 0 and 600 seconds.")
        if not isinstance(max_response_bytes, int) or max_response_bytes < 1:
            raise ConfigError("max_response_bytes must be a positive integer.")
        if not isinstance(max_batch_bytes, int) or max_batch_bytes < 1:
            raise ConfigError("max_batch_bytes must be a positive integer.")
        self._timeout = float(timeout)
        self._max_response = max_response_bytes
        self._batch_size = batch_size
        self._max_batch_bytes = max_batch_bytes
        self._retry = retry or RetryPolicy()
        self._confirm = confirm_duplicates
        self._personal_data = personal_data
        self._transport = transport or urllib_transport
        self._clock = clock or Clock()
        self._rnd = rnd or default_random
        self._env = env
        self._on_event = on_event
        self._api_limiter: Optional[RateLimiter] = None
        self._batch_limiter: Optional[RateLimiter] = None
        self._puid_locked_until: Dict[str, float] = {}
        if rate_limit:
            api, multi = SERVER_RATE_LIMITS["api"], SERVER_RATE_LIMITS["apiMultiple"]
            self._api_limiter = RateLimiter([(int(api["perSecond"]), 1.0), (int(api["perMinute"]), 60.0)], self._clock)
            self._batch_limiter = RateLimiter([(int(multi["perSecond"]), 1.0), (int(multi["perMinute"]), 60.0)], self._clock)

    @property
    def dry_run(self) -> bool:
        return self._dry_run

    def __repr__(self) -> str:
        return f"TransparencyClient(base={self._base!r}, dry_run={self._dry_run})"

    # -- public API ---------------------------------------------------------

    def submit(self, statement: Any) -> Outcome:
        """Submit one statement through the single-statement endpoint."""
        return self._run([statement], "single").outcomes[0]

    def submit_batch(self, statements: Sequence[Any]) -> Report:
        """Submit statements through the batch endpoint in chunks of at most batch_size."""
        if not isinstance(statements, (list, tuple)):
            raise RationaleError("input", "submit_batch expects a list.")
        return self._run(list(statements), "batch")

    def puid_exists(self, puid: str) -> bool:
        """GET /api/v1/statement/existing-puid/{puid}: True on 302, False on 404."""
        if self._dry_run:
            raise RationaleError("config", "puid_exists sends a request and is not available in dry-run mode.")
        if not isinstance(puid, str) or len(puid) > 500 or not puid or not all(c.isascii() and (c.isalnum() or c in "-_") for c in puid):
            raise RationaleError("input", "Invalid PUID.")
        token = self._read_token()
        res = self._with_retry(lambda: self._send("GET", ENDPOINT_EXISTING_PUID.replace("{puid}", urllib.parse.quote(puid, safe="")), token, None, False))
        if isinstance(res, RationaleError):
            raise res
        if res.status == 302:
            return True
        if res.status == 404:
            return False
        raise self._http_error(res, token)

    # -- internals ----------------------------------------------------------

    def _emit(self, event: Dict[str, object]) -> None:
        if self._on_event is not None:
            try:
                self._on_event(event)
            except Exception:
                pass

    def _read_token(self) -> Secret:
        if self._token is None:
            raise RationaleError("token", "No token source.")
        return read_token(self._token, self._env)

    def _send(self, method: str, path: str, token: Secret, body: Optional[bytes], batch: bool) -> HttpResponse:
        if self._api_limiter is not None:
            self._api_limiter.acquire()
        if batch and self._batch_limiter is not None:
            self._batch_limiter.acquire()
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token.reveal()}",
            "User-Agent": f"rationale-python/{_VERSION}",
        }
        return self._transport(method, self._base + path, headers, body, self._timeout, self._max_response)

    def _wait_for_puid_locks(self, puids: Sequence[str]) -> None:
        """Wait once until no PUID may still be locked by an earlier request of this client whose outcome is unknown."""
        if not puids or not self._puid_locked_until:
            return
        until = max(self._puid_locked_until.get(p, 0.0) for p in puids)
        wait = until - self._clock.monotonic()
        if wait > 0:
            self._emit({"type": "retry", "delay": wait, "reason": "puid_lock", "attempt": 0})
            self._clock.sleep(wait)

    def _note_puid_outcome(self, puids: Sequence[str], ambiguous: bool) -> None:
        if ambiguous:
            now = self._clock.monotonic()
            if len(self._puid_locked_until) > 100_000:
                for p in [p for p, t in self._puid_locked_until.items() if t <= now]:
                    del self._puid_locked_until[p]
            for p in puids:
                self._puid_locked_until[p] = now + _PUID_LOCK_SECONDS
        else:
            for p in puids:
                self._puid_locked_until.pop(p, None)

    def _with_retry(self, attempt_fn: Callable[[], HttpResponse], puids: Sequence[str] = ()) -> Union[HttpResponse, RationaleError]:
        """Run a request with retries.

        For submissions (``puids`` given), an attempt with an unknown outcome
        (timeout, connection failure, 500, 502, 504) may still hold the
        server's PUID locks. Resending the PUIDs while they are locked makes
        the batch endpoint record them as existing for two days even if the
        first request fails, so the next attempt waits out the lock.
        """
        self._wait_for_puid_locks(puids)
        attempt = 1
        while True:
            result: Union[HttpResponse, RationaleError]
            try:
                result = attempt_fn()
                self._emit({"type": "response", "status": result.status})
            except RationaleError as e:
                result = e
            ambiguous = result.code in _AMBIGUOUS_CODES if isinstance(result, RationaleError) else result.status in _AMBIGUOUS_STATUS
            ambiguous = ambiguous and not (isinstance(result, RationaleError) and result.not_sent)
            # A request that never reached the server changes nothing about the server's locks.
            if puids and not (isinstance(result, RationaleError) and result.not_sent):
                self._note_puid_outcome(puids, ambiguous)
            retryable = result.retryable if isinstance(result, RationaleError) else result.status in RETRYABLE_STATUS
            if not retryable or attempt >= self._retry.max_attempts:
                return result
            delay = self._retry.backoff(attempt, self._rnd)
            if isinstance(result, HttpResponse):
                after = parse_retry_after(result.retry_after, self._clock.wall())
                if after is not None:
                    if after > self._retry.max_retry_after:
                        return result
                    delay = max(delay, after)
            if puids and ambiguous:
                delay = max(delay, _PUID_LOCK_SECONDS)
            self._emit({"type": "retry", "delay": delay, "reason": result.code if isinstance(result, RationaleError) else f"HTTP {result.status}", "attempt": attempt})
            self._clock.sleep(delay)
            attempt += 1

    def _http_error(self, res: HttpResponse, token: Secret) -> RationaleError:
        s = res.status
        if s == 401:
            return RationaleError("unauthorized", "The API token was not accepted (HTTP 401). Generate a new token in your profile.", status=s)
        if s == 403:
            return RationaleError("forbidden", "The account may not create statements (HTTP 403).", status=s)
        if s == 413:
            return RationaleError("payload_too_large", "The request body is too large for the server (HTTP 413).", status=s)
        if s == 429:
            return RationaleError("rate_limited", "Rate limit reached (HTTP 429).", retryable=True, status=s)
        if 300 <= s < 400:
            return RationaleError("http", f"Unexpected redirect (HTTP {s}); redirects are never followed.", status=s)
        msg = res.json.get("message") if isinstance(res.json, dict) and isinstance(res.json.get("message"), str) else res.text
        msg = clean_server_text(str(msg)[:300], [token.reveal()])
        return RationaleError("http", f"HTTP {s}: {msg}" if msg else f"HTTP {s}", retryable=s in RETRYABLE_STATUS, status=s)

    @staticmethod
    def _failed(index: int, puid: str, e: RationaleError) -> Outcome:
        return Outcome("failed", index, puid, error=e.to_dict())

    def _messages(self, v: Any, token: Secret) -> Tuple[str, ...]:
        if not isinstance(v, list):
            return ()
        return tuple(clean_server_text(m[:500], [token.reveal()]) for m in v[:20] if isinstance(m, str))

    def _server_errors(self, body: Any, token: Secret) -> Dict[str, Tuple[str, ...]]:
        if not isinstance(body, dict) or not isinstance(body.get("errors"), dict):
            return {"": ("The server rejected the request (HTTP 422) without details.",)}
        return {k: self._messages(v, token) for k, v in list(body["errors"].items())[:100] if isinstance(k, str) and _FIELD_KEY.fullmatch(k)}

    @staticmethod
    def _is_conflict(body: Any) -> bool:
        if not isinstance(body, dict) or not isinstance(body.get("errors"), dict):
            return False
        errs = body["errors"]
        msgs = errs.get("puid")
        if not isinstance(msgs, list) or not any(isinstance(m, str) and ("not unique" in m or "not all unique" in m) for m in msgs):
            return False
        return isinstance(errs.get("existing_puids"), list) or isinstance(body.get("existing"), dict) or len(errs) == 1

    def _confirm_puids(self, puids: Sequence[str], token: Secret) -> set[str]:
        if not self._confirm:
            return set(puids)
        found: set[str] = set()
        for p in puids:
            path = ENDPOINT_EXISTING_PUID.replace("{puid}", urllib.parse.quote(p, safe=""))
            res = self._with_retry(functools.partial(self._send, "GET", path, token, None, False))
            if isinstance(res, HttpResponse) and res.status == 302:
                found.add(p)
        return found

    def _run(self, inputs: List[Any], mode: str) -> Report:
        outcomes: List[Optional[Outcome]] = [None] * len(inputs)
        pending: List[Tuple[int, Dict[str, Any], bytes]] = []
        for i, r in enumerate(validate_statements(inputs, self._personal_data)):
            if not r.ok or r.statement is None:
                raw = inputs[i]
                puid = raw.get("puid") if isinstance(raw, dict) and isinstance(raw.get("puid"), str) else None
                outcomes[i] = Outcome("invalid", i, puid, errors=r.errors)
            elif self._dry_run:
                outcomes[i] = Outcome("validated", i, str(r.statement["puid"]), statement=r.statement)
            else:
                pending.append((i, r.statement, json.dumps(r.statement, ensure_ascii=False, separators=(",", ":")).encode("utf-8")))
        if pending:
            try:
                token = self._read_token()
            except RationaleError as e:
                for i, s, _ in pending:
                    outcomes[i] = self._failed(i, str(s["puid"]), e)
            else:
                if mode == "single":
                    for item in pending:
                        stop = self._single(item, token, outcomes)
                        if stop is not None:
                            for i, s, _ in pending:
                                if outcomes[i] is None:
                                    outcomes[i] = self._failed(i, str(s["puid"]), stop)
                            break
                else:
                    for chunk in self._chunks(pending):
                        stop = self._batch(chunk, token, outcomes)
                        if stop is not None:
                            for i, s, _ in pending:
                                if outcomes[i] is None:
                                    outcomes[i] = self._failed(i, str(s["puid"]), stop)
                            break
        final = tuple(o if o is not None else Outcome("failed", i, "", error={"code": "input", "message": "Not processed.", "retryable": True}) for i, o in enumerate(outcomes))
        return Report(final, self._dry_run)

    def _chunks(self, pending: List[Tuple[int, Dict[str, Any], bytes]]) -> List[List[Tuple[int, Dict[str, Any], bytes]]]:
        overhead = len(b'{"statements":[]}')
        chunks: List[List[Tuple[int, Dict[str, Any], bytes]]] = []
        cur: List[Tuple[int, Dict[str, Any], bytes]] = []
        size = overhead
        for item in pending:
            n = len(item[2]) + 1
            if cur and (len(cur) >= self._batch_size or size + n > self._max_batch_bytes):
                chunks.append(cur)
                cur, size = [], overhead
            cur.append(item)
            size += n
        if cur:
            chunks.append(cur)
        return chunks

    @staticmethod
    def _created(i: int, s: Dict[str, Any], body: Any) -> Outcome:
        uuid = body.get("uuid") if isinstance(body, dict) else None
        ok = isinstance(uuid, str) and len(uuid) == 36 and all(c in "0123456789abcdefABCDEF-" for c in uuid)
        return Outcome("created", i, str(s["puid"]), uuid=uuid if ok else None)

    def _single(self, item: Tuple[int, Dict[str, Any], bytes], token: Secret, outcomes: List[Optional[Outcome]]) -> Optional[RationaleError]:
        i, s, body = item
        puid = str(s["puid"])
        for rnd in range(self._retry.max_attempts):
            res = self._with_retry(lambda: self._send("POST", ENDPOINT_SINGLE, token, body, False), [puid])
            if isinstance(res, RationaleError):
                outcomes[i] = self._failed(i, puid, res)
                return res if res.code in ("network", "timeout") else None
            if res.status == 201:
                outcomes[i] = self._created(i, s, res.json)
                return None
            if res.status == 422:
                if self._is_conflict(res.json):
                    if puid in self._confirm_puids([puid], token):
                        outcomes[i] = Outcome("duplicate", i, puid)
                        return None
                    self._clock.sleep(self._retry.backoff(rnd + 1, self._rnd))
                    continue
                outcomes[i] = Outcome("rejected", i, puid, server_errors=self._server_errors(res.json, token))
                return None
            e = self._http_error(res, token)
            outcomes[i] = self._failed(i, puid, e)
            return e if e.code in ("unauthorized", "forbidden") else None
        outcomes[i] = self._failed(i, puid, RationaleError("http", "The server reported the PUID as in use, but it was not found. Try again later.", retryable=True, status=422))
        return None

    def _batch(self, chunk: List[Tuple[int, Dict[str, Any], bytes]], token: Secret, outcomes: List[Optional[Outcome]]) -> Optional[RationaleError]:
        rest = list(chunk)
        conflict_rounds = 0
        while rest:
            sent = rest
            body = b'{"statements":[' + b",".join(x[2] for x in sent) + b"]}"
            res = self._with_retry(lambda: self._send("POST", ENDPOINT_BATCH, token, body, True), [str(x[1]["puid"]) for x in sent])
            if isinstance(res, RationaleError):
                for i, s, _ in sent:
                    outcomes[i] = self._failed(i, str(s["puid"]), res)
                # Connection-level failures affect every chunk: stop instead of waiting through each one.
                return res if res.code in ("network", "timeout") else None
            if res.status == 201:
                listed = res.json.get("statements") if isinstance(res.json, dict) else None
                by_puid = {x["puid"]: x for x in listed if isinstance(x, dict) and isinstance(x.get("puid"), str)} if isinstance(listed, list) else {}
                for i, s, _ in sent:
                    outcomes[i] = self._created(i, s, by_puid.get(s["puid"]))
                return None
            if res.status == 413 and len(sent) > 1:
                half = (len(sent) + 1) // 2
                self._emit({"type": "split", "from": len(sent), "to": half})
                first = self._batch(sent[:half], token, outcomes)
                if first is not None:
                    return first
                return self._batch(sent[half:], token, outcomes)
            if res.status == 422:
                body_json = res.json
                if self._is_conflict(body_json):
                    reported = [p for p in body_json["errors"]["existing_puids"] if isinstance(p, str)][:1000] if isinstance(body_json["errors"].get("existing_puids"), list) else []
                    known = {str(s["puid"]) for _, s, _ in sent}
                    confirmed = self._confirm_puids([p for p in reported if p in known], token)
                    if confirmed:
                        for i, s, _ in sent:
                            if s["puid"] in confirmed:
                                outcomes[i] = Outcome("duplicate", i, str(s["puid"]))
                        rest = [x for x in sent if x[1]["puid"] not in confirmed]
                        continue
                    conflict_rounds += 1
                    if conflict_rounds >= self._retry.max_attempts:
                        e = RationaleError("http", "The server reported PUIDs as in use, but they were not found. Try again later.", retryable=True, status=422)
                        for i, s, _ in sent:
                            outcomes[i] = self._failed(i, str(s["puid"]), e)
                        return None
                    self._clock.sleep(self._retry.backoff(conflict_rounds, self._rnd))
                    continue
                per: Dict[int, Dict[str, Tuple[str, ...]]] = {}
                if isinstance(body_json, dict) and isinstance(body_json.get("errors"), dict):
                    for k, v in body_json["errors"].items():
                        km = _STATEMENT_KEY.fullmatch(k) if isinstance(k, str) else None
                        if km is not None and isinstance(v, dict):
                            idx = int(km.group(1))
                            if idx < len(sent):
                                per[idx] = {f: self._messages(m, token) for f, m in list(v.items())[:100] if isinstance(f, str) and _FIELD_KEY.fullmatch(f)}
                if per:
                    for idx, errs in per.items():
                        i, s, _ = sent[idx]
                        outcomes[i] = Outcome("rejected", i, str(s["puid"]), server_errors=errs)
                    rest = [x for n, x in enumerate(sent) if n not in per]
                    continue
                errs = self._server_errors(body_json, token)
                for i, s, _ in sent:
                    outcomes[i] = Outcome("rejected", i, str(s["puid"]), server_errors=errs)
                return None
            e = self._http_error(res, token)
            for i, s, _ in sent:
                outcomes[i] = self._failed(i, str(s["puid"]), e)
            return e if e.code in ("unauthorized", "forbidden") else None
        return None
