# Copyright 2026 MB AFKzona Group
# SPDX-License-Identifier: Apache-2.0
"""Shared test helpers: the JSON test vectors and a local mock API."""

from __future__ import annotations

import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Union

from rationale import Clock, validate_statement

ROOT = Path(__file__).resolve().parents[2]
VECTORS: Dict[str, Any] = json.loads((ROOT / "test-vectors" / "statements.json").read_text(encoding="utf-8"))
MOCK_TOKEN = "X|mockTokenValue1234567890abcdef"


def case_input(c: Dict[str, Any]) -> Any:
    if "input" in c:
        return c["input"]
    out = dict(VECTORS["base"])
    out.update(c.get("patch", {}))
    for k in c.get("unset", []):
        out.pop(k, None)
    return out


def valid_statement(puid: str, **extra: Any) -> Dict[str, Any]:
    s = dict(VECTORS["base"])
    s["puid"] = puid
    s.update(extra)
    return s


def fast_clock(sleeps: Optional[List[float]] = None) -> Clock:
    """A clock whose sleep returns at once and moves virtual time forward."""
    record = sleeps if sleeps is not None else []
    offset = [0.0]

    def sleep(s: float) -> None:
        record.append(s)
        offset[0] += s

    return Clock(monotonic=lambda: time.monotonic() + offset[0], wall=lambda: time.time() + offset[0], sleep=sleep)


Scripted = Dict[str, Any]


class MockApi:
    """Local stand-in for the DSA Transparency Database API (see test/helpers/mock-server.ts)."""

    def __init__(self) -> None:
        self.requests: List[Dict[str, Any]] = []
        self.script: List[Scripted] = []
        self.puids: Set[str] = set()
        self.reject_puids: Set[str] = set()
        self.locked_puids: Set[str] = set()
        # PUIDs in the server's PUID cache without a stored statement (the batch endpoint caches the PUIDs it reports).
        self.cached_puids: Set[str] = set()
        # Per-PUID locks held by requests in progress: PUID to mock time of expiry.
        self.locks: Dict[str, float] = {}
        self.now: Callable[[], float] = time.monotonic
        self.token = MOCK_TOKEN
        api = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                return

            def _go(self) -> None:
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n).decode("utf-8") if n else ""
                rec = {"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body}
                api.requests.append(rec)
                scripted = api.script.pop(0) if api.script else None
                if scripted is not None:
                    if scripted.get("process_first"):
                        api.process(rec)
                    if scripted.get("hold_lock") is not None:
                        parsed = json.loads(body)
                        for p in [x["puid"] for x in parsed.get("statements", [])] or [parsed.get("puid", "")]:
                            api.locks[p] = api.now() + float(scripted["hold_lock"])
                    if scripted.get("delay"):
                        time.sleep(scripted["delay"])
                    if scripted.get("destroy"):
                        self.close_connection = True
                        self.connection.close()
                        return
                    raw = scripted.get("raw")
                    text = raw if raw is not None else json.dumps(scripted.get("body", {}))
                    if scripted.get("drip"):
                        # Send the body one byte at a time, each just under the socket timeout.
                        data = text.encode("utf-8")
                        self.send_response(int(scripted.get("status", 200)))
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.flush()
                        try:
                            for i in range(len(data)):
                                time.sleep(float(scripted["drip"]))
                                self.wfile.write(data[i : i + 1])
                                self.wfile.flush()
                        except OSError:
                            pass
                        return
                    if scripted.get("no_length"):
                        # No Content-Length: the body ends when the connection closes.
                        self.send_response(int(scripted.get("status", 200)))
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Connection", "close")
                        self.end_headers()
                        self.wfile.write(text.encode("utf-8"))
                        self.close_connection = True
                        return
                    self._send(int(scripted.get("status", 200)), text, scripted.get("headers", {}))
                    return
                status, out = api.process(rec)
                self._send(status, json.dumps(out), {})

            def _send(self, status: int, text: str, headers: Dict[str, str]) -> None:
                data = text.encode("utf-8")
                self.send_response(status)
                h = {"Content-Type": "application/json", **headers}
                for k, v in h.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = _go
            do_POST = _go

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def calls(self, path: str) -> List[Dict[str, Any]]:
        return [r for r in self.requests if r["path"] == path]

    def _locked(self, puid: str) -> bool:
        until = self.locks.get(puid)
        return until is not None and until > self.now()

    def process(self, rec: Dict[str, Any]) -> Any:
        h = {k.lower(): v for k, v in rec["headers"].items()}
        if h.get("authorization") != f"Bearer {self.token}":
            return 401, {"message": "Unauthenticated."}
        path = rec["path"]
        if rec["method"] == "GET" and path.startswith("/api/v1/statement/existing-puid/"):
            puid = path.rsplit("/", 1)[1]
            if puid in self.puids or puid in self.cached_puids:
                return 302, {"message": "statement of reason found", "puid": puid}
            return 404, {"message": "statement of reason not found", "puid": puid}
        body = json.loads(rec["body"])
        if path == "/api/v1/statement":
            r = validate_statement(body, "off")
            if not r.ok or r.statement is None:
                return 422, {"errors": {e.attribute: [e.message] for e in r.errors}}
            p = r.statement["puid"]
            if p in self.puids or p in self.cached_puids or p in self.locked_puids or self._locked(p):
                m = "The identifier given is not unique within this platform."
                return 422, {"message": m, "errors": {"puid": [m]}, "existing": {"puid": p}}
            if p in self.reject_puids:
                return 422, {"message": "x", "errors": {"category": ["The selected category is invalid."]}}
            self.puids.add(p)
            return 201, {**r.statement, "uuid": str(uuid.uuid4())}
        if path == "/api/v1/statements":
            items = body.get("statements")
            if not isinstance(items, list) or not 1 <= len(items) <= 100:
                return 422, {"errors": {"statements": ["between 1 and 100"]}}
            errors: Dict[str, Any] = {}
            valid: List[Dict[str, Any]] = []
            for i, s in enumerate(items):
                r = validate_statement(s, "off")
                if not r.ok or r.statement is None:
                    errors[f"statement_{i}"] = {e.attribute or "statement": [e.message] for e in r.errors}
                elif r.statement["puid"] in self.reject_puids:
                    errors[f"statement_{i}"] = {"category": ["The selected category is invalid."]}
                else:
                    valid.append(r.statement)
            if errors:
                return 422, {"errors": errors}
            puids = [s["puid"] for s in valid]
            # Order of the real service: duplicates in the request, then the PUID locks (first locked PUID in
            # sorted order), then the cache and the database. Reported PUIDs are cached.
            dups = sorted({p for p in puids if puids.count(p) > 1})
            locked = [p for p in sorted(puids) if p in self.locked_puids or self._locked(p)][:1]
            existing = dups or locked or sorted({p for p in puids if p in self.puids or p in self.cached_puids})
            if existing:
                self.cached_puids.update(existing)
                m = "The platform identifier(s) are not all unique within this call."
                return 422, {"message": m, "errors": {"puid": [m], "existing_puids": existing}}
            self.puids.update(puids)
            return 201, {"statements": [{**s, "uuid": str(uuid.uuid4())} for s in valid]}
        return 404, {"message": "Not found"}
