# Copyright 2026 MB AFKzona Group
# SPDX-License-Identifier: Apache-2.0
"""Configuration and helper security controls."""

from __future__ import annotations

import unittest

from rationale import (
    ConfigError,
    RateLimiter,
    RetryPolicy,
    Secret,
    find_personal_data,
    parse_json_safe,
    parse_retry_after,
    read_token,
    redact,
    resolve_base_url,
)
from rationale._core import Clock


class AllowListTests(unittest.TestCase):
    def test_production_needs_opt_in(self) -> None:
        with self.assertRaises(ConfigError):
            resolve_base_url("production")
        self.assertEqual(resolve_base_url("production", allow_production=True), "https://transparency.dsa.ec.europa.eu")

    def test_sandbox_hosts(self) -> None:
        self.assertEqual(resolve_base_url("sandbox", "https://Sandbox.Example.europa.eu/"), "https://sandbox.example.europa.eu")
        for bad in [
            "http://sandbox.europa.eu",
            "https://europa.eu.attacker.example",
            "https://attacker.example/europa.eu",
            "https://evil-europa.eu",
            "https://sandbox.europa.eu:8443",
            "https://user:pw@sandbox.europa.eu",
            "https://sandbox.europa.eu/api",
            "https://sandbox.europa.eu?x",
            "https://sandbox.europa.eu#x",
            "https://10.0.0.1",
            "https://transparency.dsa.ec.europa.eu",
            "https://sandbox.europa.eu\\@evil.example",
            "https://sandbox.europa.eu x",
            "file:///etc/passwd",
        ]:
            with self.subTest(bad), self.assertRaises(ConfigError):
                resolve_base_url("sandbox", bad)

    def test_unparsable_urls_are_config_errors(self) -> None:
        for u in ["https://evil.com\uff03.europa.eu", "https://[x.europa.eu", "https://x.europa.eu]"]:
            with self.assertRaises(ConfigError, msg=u):
                resolve_base_url("sandbox", u)

    def test_local_loopback_only(self) -> None:
        self.assertEqual(resolve_base_url("local", local_base_url="http://127.0.0.1:8080"), "http://127.0.0.1:8080")
        self.assertEqual(resolve_base_url("local", local_base_url="http://[::1]:8080"), "http://[::1]:8080")
        for bad in ["http://localhost:8080", "http://169.254.169.254", "http://127.0.0.2", "ftp://127.0.0.1"]:
            with self.subTest(bad), self.assertRaises(ConfigError):
                resolve_base_url("local", local_base_url=bad)
        with self.assertRaises(ConfigError):
            resolve_base_url("staging")


class HelperTests(unittest.TestCase):
    def test_secret_and_redaction(self) -> None:
        self.assertEqual(repr(Secret("topsecret")), "Secret([REDACTED])")
        self.assertEqual(redact("a abcd1234 Bearer x.y", ["abcd1234"]), "a [REDACTED] Bearer [REDACTED]")
        with self.assertRaises(Exception):
            read_token({"env": "T"}, {"T": "a b"})

    def test_json(self) -> None:
        v = parse_json_safe('{"a":{"__proto__":{"x":1},"constructor":1,"ok":2}}')
        self.assertEqual(v, {"a": {"ok": 2}})
        self.assertIsNone(parse_json_safe("{"))
        self.assertIsNone(parse_json_safe("[" * 100 + "]" * 100))

    def test_retry_policy(self) -> None:
        p = RetryPolicy()
        self.assertAlmostEqual(p.backoff(1, lambda: 1.0), 0.5)
        self.assertAlmostEqual(p.backoff(30, lambda: 1.0), 30.0)
        self.assertEqual(parse_retry_after("120", 0), 120.0)
        self.assertIsNone(parse_retry_after("soon", 0))
        with self.assertRaises(ConfigError):
            RetryPolicy(max_attempts=0)

    def test_rate_limiter(self) -> None:
        now = [0.0]
        waits: list[float] = []

        def sleep(s: float) -> None:
            waits.append(s)
            now[0] += s

        lim = RateLimiter([(2, 1.0)], Clock(monotonic=lambda: now[0], sleep=sleep))
        lim.acquire()
        lim.acquire()
        lim.acquire()
        self.assertEqual(waits, [1.0])

    def test_personal_data(self) -> None:
        self.assertEqual(find_personal_data("x a@b.example y"), ["email"])
        self.assertEqual(find_personal_data("Article 17(3)(b)"), [])

    def test_personal_data_is_fast_on_hostile_input(self) -> None:
        import time

        t0 = time.monotonic()
        for text in ("a" * 5000 + "@", "+1" * 2500, "1." * 2500, "AB12 " * 1000):
            find_personal_data(text)
        self.assertLess(time.monotonic() - t0, 1.0)


if __name__ == "__main__":
    unittest.main()
