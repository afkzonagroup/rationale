# Copyright 2026 MB AFKzona Group
# SPDX-License-Identifier: Apache-2.0
"""Client tests against the local mock API."""

from __future__ import annotations

import errno
import json
import socket
import ssl
import unittest
import urllib.error
from unittest import mock
from typing import Any, Dict, List

from rationale import RationaleError, RetryPolicy, TransparencyClient
from rationale._client import failed_before_sending

from .helpers import MOCK_TOKEN, MockApi, fast_clock, valid_statement


def many(n: int, prefix: str = "p") -> List[Dict[str, Any]]:
    return [valid_statement(f"{prefix}-{i}") for i in range(n)]


class ClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.api = MockApi()
        self.sleeps: List[float] = []
        self.events: List[Dict[str, object]] = []

    def tearDown(self) -> None:
        self.api.stop()

    def client(self, **kw: Any) -> TransparencyClient:
        opts: Dict[str, Any] = dict(
            local_base_url=self.api.url,
            token={"env": "T"},
            env={"T": MOCK_TOKEN},
            clock=fast_clock(self.sleeps),
            rnd=lambda: 0.5,
            on_event=self.events.append,
        )
        opts.update(kw)
        return TransparencyClient("local", **opts)

    def test_single_created_with_headers(self) -> None:
        o = self.client().submit(valid_statement("one"))
        self.assertEqual(o.status, "created")
        self.assertIsNotNone(o.uuid)
        req = self.api.calls("/api/v1/statement")[0]
        h = {k.lower(): v for k, v in req["headers"].items()}
        self.assertEqual(h["authorization"], f"Bearer {MOCK_TOKEN}")
        self.assertEqual(h["accept"], "application/json")
        self.assertEqual(h["content-type"], "application/json")
        self.assertEqual(json.loads(req["body"]), valid_statement("one"))

    def test_chunks_to_100(self) -> None:
        r = self.client().submit_batch(many(250))
        self.assertEqual(r.count("created"), 250)
        sizes = [len(json.loads(c["body"])["statements"]) for c in self.api.calls("/api/v1/statements")]
        self.assertEqual(sizes, [100, 100, 50])

    def test_byte_budget(self) -> None:
        one = len(json.dumps(valid_statement("p-0"), separators=(",", ":")))
        self.client(max_batch_bytes=one * 3 + 40).submit_batch(many(7))
        for c in self.api.calls("/api/v1/statements"):
            self.assertLessEqual(len(c["body"].encode()), one * 3 + 40)

    def test_duplicates_are_idempotent(self) -> None:
        self.api.puids.update({"p-1", "p-3"})
        r = self.client().submit_batch(many(5))
        self.assertEqual([o.status for o in r.outcomes], ["created", "duplicate", "created", "duplicate", "created"])
        self.api.puids.add("dup")
        self.assertEqual(self.client().submit(valid_statement("dup")).status, "duplicate")

    def test_lock_collision_is_not_duplicate(self) -> None:
        self.api.locked_puids.add("locked")
        o = self.client(retry=RetryPolicy(max_attempts=3)).submit(valid_statement("locked"))
        self.assertEqual(o.status, "failed")
        assert o.error is not None
        self.assertTrue(o.error["retryable"])

    def test_rejected_are_removed_and_rest_resent(self) -> None:
        self.api.reject_puids.add("p-2")
        r = self.client().submit_batch(many(4))
        self.assertEqual([o.status for o in r.outcomes], ["created", "created", "rejected", "created"])
        self.assertEqual(len(self.api.calls("/api/v1/statements")), 2)

    def test_out_of_range_statement_index_does_not_loop(self) -> None:
        self.api.script.append({"status": 422, "body": {"errors": {"statement_99": {"category": ["bad"]}}}})
        r = self.client().submit_batch(many(2))
        self.assertEqual([o.status for o in r.outcomes], ["rejected", "rejected"])

    def test_retries_with_backoff_and_retry_after(self) -> None:
        self.api.script += [{"status": 503, "raw": "down"}, {"status": 429, "raw": "Limit", "headers": {"Retry-After": "3"}}]
        r = self.client(retry=RetryPolicy(base_delay=0.1)).submit_batch(many(1))
        self.assertEqual(r.count("created"), 1)
        self.assertEqual(self.sleeps, [0.05, 3.0])

    def test_gives_up_on_long_retry_after(self) -> None:
        self.api.script.append({"status": 429, "raw": "Limit", "headers": {"Retry-After": "3600"}})
        o = self.client().submit_batch(many(1)).outcomes[0]
        self.assertEqual(o.status, "failed")
        assert o.error is not None
        self.assertEqual(o.error["code"], "rate_limited")

    def test_no_retry_for_client_errors_and_auth_stops(self) -> None:
        self.api.script.append({"status": 400, "body": {"message": "no"}})
        self.client().submit_batch(many(1))
        self.assertEqual(self.sleeps, [])
        self.api.token = "other"
        r = self.client(batch_size=10).submit_batch(many(30, "a"))
        self.assertEqual(r.count("failed"), 30)
        self.assertEqual(len(self.api.calls("/api/v1/statements")), 2)

    def test_network_error_and_timeout_are_retried(self) -> None:
        self.api.script += [{"destroy": True}, {"delay": 0.5, "status": 201, "body": {}}]
        r = self.client(timeout=0.2).submit_batch(many(1))
        self.assertEqual(r.count("created"), 1)
        reasons = [e["reason"] for e in self.events if e.get("type") == "retry"]
        self.assertEqual(reasons, ["network", "timeout"])

    def test_hostile_error_keys(self) -> None:
        # A non-ASCII digit must not crash the client; keys with control characters are dropped.
        self.api.script.append({"status": 422, "body": {"errors": {"statement_\u00b2": {"category": ["x"]}, "statement_\u0661": {"x": ["y"]}}}})
        r = self.client().submit_batch(many(2))
        self.assertEqual([o.status for o in r.outcomes], ["rejected", "rejected"])
        self.assertEqual(len(self.api.calls("/api/v1/statements")), 1)
        self.api.script.append({"status": 422, "body": {"errors": {"\u001b[31mevil": ["m"], "category": ["\u001b]0;t\u0007"]}}})
        o = self.client().submit(valid_statement("keys"))
        self.assertEqual(dict(o.server_errors), {"category": (" ]0;t ",)})
        self.api.script.append({"status": 422, "body": {"errors": {"statement_0": {"\u001b[2J": ["m"], "category": ["c"]}}}})
        o = self.client().submit_batch([valid_statement("keys2")]).outcomes[0]
        self.assertEqual(dict(o.server_errors), {"category": ("c",)})

    def test_unknown_outcome_waits_out_the_puid_lock(self) -> None:
        self.api.script += [{"status": 502, "raw": "bad gateway"}, {"status": 500, "body": {}}]
        r = self.client(retry=RetryPolicy(base_delay=0.1)).submit_batch(many(1))
        self.assertEqual(r.count("created"), 1)
        self.assertEqual(self.sleeps, [31.0, 31.0])

    def test_refused_connection_does_not_wait_out_the_lock(self) -> None:
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        r = self.client(local_base_url=f"http://127.0.0.1:{port}", retry=RetryPolicy(max_attempts=3, base_delay=0.1)).submit_batch(many(1))
        o = r.outcomes[0]
        assert o.error is not None
        self.assertEqual(o.error["code"], "network")
        self.assertEqual(self.sleeps, [0.05, 0.1])

    def test_tells_failures_before_connecting_from_unknown_outcomes(self) -> None:
        not_sent: List[BaseException] = [
            socket.gaierror(socket.EAI_NONAME, "no such host"),
            ConnectionRefusedError(errno.ECONNREFUSED, "refused"),
            OSError(errno.EHOSTUNREACH, "no route"),
            OSError(errno.ENETUNREACH, "network unreachable"),
            ssl.SSLCertVerificationError("certificate verify failed"),
        ]
        unknown: List[BaseException] = [
            ConnectionResetError(errno.ECONNRESET, "reset"),
            BrokenPipeError(errno.EPIPE, "pipe"),
            ssl.SSLError("bad record mac"),
            OSError("no errno"),
        ]
        for exc, expected in [(e, [0.05]) for e in not_sent] + [(e, [31.0]) for e in unknown]:
            self.sleeps.clear()
            with mock.patch("socket.create_connection", side_effect=exc):
                self.client(retry=RetryPolicy(max_attempts=2, base_delay=0.1)).submit_batch(many(1))
            self.assertEqual(self.sleeps, expected, repr(exc))
        self.assertTrue(failed_before_sending(urllib.error.URLError(socket.gaierror(-2, "x"))))
        self.assertFalse(failed_before_sending(urllib.error.URLError(TimeoutError())))

    def test_own_timed_out_request_holding_the_lock_is_not_a_duplicate(self) -> None:
        clock = fast_clock(self.sleeps)
        self.api.now = clock.monotonic
        # The first request takes the PUID locks for 30 s, outlives the client timeout and then fails.
        self.api.script.append({"hold_lock": 30.0, "delay": 0.4, "status": 500, "body": {}})
        r = self.client(clock=clock, timeout=0.2).submit_batch(many(2))
        self.assertEqual([o.status for o in r.outcomes], ["created", "created"])
        self.assertEqual(self.api.cached_puids, set())

    def test_lock_wait_spans_calls_of_one_client(self) -> None:
        clock = fast_clock(self.sleeps)
        self.api.now = clock.monotonic
        self.api.script.append({"hold_lock": 30.0, "delay": 0.4, "status": 500, "body": {}})
        c = self.client(clock=clock, timeout=0.2, retry=RetryPolicy(max_attempts=1))
        self.assertEqual(c.submit_batch(many(1)).outcomes[0].status, "failed")
        self.assertEqual(c.submit_batch(many(1)).outcomes[0].status, "created")
        self.assertTrue(any(s > 29 for s in self.sleeps))
        self.assertEqual(self.api.cached_puids, set())

    def test_timeout_after_store_turns_into_duplicate(self) -> None:
        self.api.script.append({"process_first": True, "delay": 0.5, "status": 201, "body": {}})
        r = self.client(timeout=0.2).submit_batch(many(3))
        self.assertEqual(r.count("duplicate"), 3)

    def test_stops_after_connection_failure(self) -> None:
        self.api.script += [{"destroy": True}, {"destroy": True}]
        r = self.client(batch_size=1, retry=RetryPolicy(max_attempts=2)).submit_batch(many(3))
        self.assertEqual([o.error["code"] if o.error else o.status for o in r.outcomes], ["network"] * 3)
        self.assertEqual(len(self.api.calls("/api/v1/statements")), 2)

    def test_redirects_not_followed(self) -> None:
        self.api.script.append({"status": 302, "headers": {"Location": "https://attacker.example/"}, "raw": ""})
        o = self.client().submit_batch(many(1)).outcomes[0]
        self.assertEqual(o.status, "failed")
        self.assertEqual(len(self.api.requests), 1)

    def test_split_on_413(self) -> None:
        self.api.script.append({"status": 413, "raw": "too large"})
        r = self.client().submit_batch(many(4))
        self.assertEqual(r.count("created"), 4)

    def test_dry_run_sends_nothing(self) -> None:
        c = TransparencyClient("local", local_base_url=self.api.url, dry_run=True, env={})
        r = c.submit_batch([valid_statement("d"), {"puid": "x"}])
        self.assertEqual([o.status for o in r.outcomes], ["validated", "invalid"])
        self.assertEqual(self.api.requests, [])
        with self.assertRaises(RationaleError):
            c.puid_exists("d")

    def test_response_size_cap_and_prototype_keys(self) -> None:
        self.api.script.append({"status": 201, "raw": json.dumps({"statements": [], "pad": "x" * 5000})})
        o = self.client(max_response_bytes=1000).submit_batch(many(1)).outcomes[0]
        assert o.error is not None
        self.assertEqual(o.error["code"], "response_too_large")
        self.api.script.append({"status": 201, "raw": '{"statements":[{"puid":"q-0","uuid":"x","__proto__":{"a":1}}]}'})
        o2 = self.client().submit_batch(many(1, "q")).outcomes[0]
        self.assertEqual((o2.status, o2.uuid), ("created", None))

    def test_streamed_response_size_cap(self) -> None:
        self.api.script.append({"status": 201, "raw": json.dumps({"statements": [], "pad": "x" * 5000}), "no_length": True})
        o = self.client(max_response_bytes=1000).submit_batch(many(1)).outcomes[0]
        assert o.error is not None
        self.assertEqual(o.error["code"], "response_too_large")

    def test_slow_drip_response_hits_the_total_deadline(self) -> None:
        import time

        self.api.script.append({"drip": 0.15, "status": 201, "raw": json.dumps({"statements": [], "pad": "x" * 40})})
        t0 = time.monotonic()
        o = self.client(timeout=0.4, retry=RetryPolicy(max_attempts=1)).submit_batch(many(1)).outcomes[0]
        self.assertLess(time.monotonic() - t0, 2.0)
        assert o.error is not None
        self.assertEqual(o.error["code"], "timeout")

    def test_control_characters_removed(self) -> None:
        self.api.script.append({"status": 422, "body": {"errors": {"statement_0": {"category": ["bad\x1b[2J\x07\nmore"]}}}})
        o = self.client().submit_batch(many(1)).outcomes[0]
        msg = o.server_errors["category"][0]
        self.assertTrue(msg.startswith("bad"))
        self.assertFalse(any(ord(c) < 0x20 for c in msg))

    def test_puid_exists(self) -> None:
        self.api.puids.add("here")
        c = self.client()
        self.assertTrue(c.puid_exists("here"))
        self.assertFalse(c.puid_exists("gone"))
        for bad in ("../x", "a/b", "", "a b"):
            with self.assertRaises(RationaleError):
                c.puid_exists(bad)

    def test_token_never_leaks(self) -> None:
        self.api.script += [
            {"status": 500, "body": {"message": f"boom {MOCK_TOKEN} Bearer {MOCK_TOKEN}"}},
            {"status": 500, "raw": f"plain {MOCK_TOKEN}", "headers": {"Content-Type": "text/plain"}},
            {"status": 422, "body": {"errors": {"statement_0": {"category": [f"bad {MOCK_TOKEN}"]}}}},
        ]
        c = self.client(retry=RetryPolicy(max_attempts=2))
        r1 = c.submit_batch(many(1, "x"))
        r2 = c.submit_batch(many(1, "y"))
        text = repr([r1, r2, c, self.events])
        self.assertNotIn(MOCK_TOKEN, text)
        self.assertNotIn("mockTokenValue", text)

    def test_token_sources(self) -> None:
        with self.assertRaisesRegex(RationaleError, "not as a string"):
            self.client(token=MOCK_TOKEN)
        o = self.client(env={}).submit_batch(many(1)).outcomes[0]
        assert o.error is not None
        self.assertEqual(o.error["code"], "token")
        o = self.client(env={"T": "a\r\nX-Evil: 1"}).submit_batch(many(1)).outcomes[0]
        assert o.error is not None
        self.assertEqual(o.error["code"], "token")
        self.assertEqual(self.api.requests, [])
        self.assertEqual(self.client(token=lambda: MOCK_TOKEN).submit(valid_statement("fn")).status, "created")


if __name__ == "__main__":
    unittest.main()
