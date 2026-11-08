# Copyright 2026 MB AFKzona Group
# SPDX-License-Identifier: Apache-2.0
"""Queue stores and draining."""

from __future__ import annotations

import json
import os
import stat
import tempfile
import unittest
from unittest import mock
from typing import Any

from rationale import JsonlQueueStore, MemoryQueueStore, RationaleError, RetryPolicy, TransparencyClient, drain_queue, enqueue_statements

from .helpers import MOCK_TOKEN, MockApi, fast_clock, valid_statement


class QueueTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        os.chmod(self.tmp.name, 0o700)
        self.file = os.path.join(self.tmp.name, "queue.jsonl")
        self.api = MockApi()

    def tearDown(self) -> None:
        self.api.stop()
        self.tmp.cleanup()

    def client(self, **kw: Any) -> TransparencyClient:
        return TransparencyClient("local", local_base_url=self.api.url, token={"env": "T"}, env={"T": MOCK_TOKEN}, clock=fast_clock(), retry=RetryPolicy(max_attempts=2), **kw)

    def test_contract_memory_and_file(self) -> None:
        for store in (MemoryQueueStore(), JsonlQueueStore(self.file)):
            with self.subTest(type(store).__name__):
                self.assertEqual(store.add([valid_statement("a"), valid_statement("b"), valid_statement("a")]), (["a", "b"], ["a"]))
                self.assertEqual([e.puid for e in store.pending(10, {"a"})], ["b"])
                store.settle([{"puid": "a", "result": "failed", "reason": "net\nwork Bearer abc.def"}])
                e = store.pending(1)[0]
                self.assertEqual(e.attempts, 1)
                assert e.last_error is not None
                self.assertNotIn("\n", e.last_error)
                self.assertNotIn("abc.def", e.last_error)
                store.settle([{"puid": "a", "result": "done"}, {"puid": "b", "result": "rejected", "reason": "x"}])
                self.assertEqual(store.stats(), {"pending": 0, "done": 1, "rejected": 1})
                with self.assertRaises(RationaleError):
                    store.add([{"puid": "bad"}])
                store.close()
                with self.assertRaises(RationaleError):
                    store.stats()

    def test_file_persistence_permissions_and_lock(self) -> None:
        s = JsonlQueueStore(self.file)
        s.add([valid_statement("x1"), valid_statement("x2")])
        s.settle([{"puid": "x1", "result": "done"}])
        with self.assertRaises(RationaleError):
            JsonlQueueStore(self.file)
        s.close()
        self.assertEqual(stat.S_IMODE(os.stat(self.file).st_mode), 0o600)
        again = JsonlQueueStore(self.file)
        self.assertEqual([e.puid for e in again.pending(10)], ["x2"])
        with open(self.file, "ab") as f:
            f.write(b'{"v":1,"op":"add"')
        again.close()
        third = JsonlQueueStore(self.file)
        third.add([valid_statement("x3")])
        third.close()
        with open(self.file, encoding="utf-8") as fh:
            lines = fh.read().strip().split("\n")
        self.assertTrue(all(json.loads(line) for line in lines))
        with open(self.file + ".lock", "w") as f:
            f.write("999999\n")
        os.chmod(self.file + ".lock", 0o600)
        JsonlQueueStore(self.file).close()

    def test_stale_lock_takeover_is_guarded(self) -> None:
        lock = self.file + ".lock"
        with open(lock, "w") as f:
            f.write("999999\n")
        os.chmod(lock, 0o600)
        guard = lock + ".takeover"
        open(guard, "w").close()
        with self.assertRaises(RationaleError) as ctx:
            JsonlQueueStore(self.file)
        self.assertIn("taking over", str(ctx.exception))
        os.unlink(guard)
        JsonlQueueStore(self.file).close()
        self.assertFalse(os.path.exists(guard))
        # A lock whose content is not an ASCII process ID counts as held (no crash on "\u00b2").
        with open(lock, "w", encoding="utf-8") as f:
            f.write("\u00b2\n")
        os.chmod(lock, 0o600)
        with self.assertRaises(RationaleError):
            JsonlQueueStore(self.file)
        os.unlink(lock)
        # A FIFO in place of the lock must not block.
        os.mkfifo(lock)
        with self.assertRaises(RationaleError):
            JsonlQueueStore(self.file)

    def test_takeover_reads_the_lock_again_under_the_guard(self) -> None:
        # Another process took over between our first look and our guard: its live lock must survive.
        lock = self.file + ".lock"
        with open(lock, "w") as f:
            f.write(f"{os.getppid()}\n")
        os.chmod(lock, 0o600)
        real = JsonlQueueStore._lock_is_stale
        calls = [0]

        def first_looks_stale(store: JsonlQueueStore) -> bool:
            calls[0] += 1
            return True if calls[0] == 1 else real(store)

        with mock.patch.object(JsonlQueueStore, "_lock_is_stale", first_looks_stale), self.assertRaises(RationaleError):
            JsonlQueueStore(self.file)
        with open(lock, encoding="ascii") as f:
            self.assertEqual(f.read().strip(), str(os.getppid()))
        self.assertFalse(os.path.exists(lock + ".takeover"))

    def test_refuses_unsafe_and_corrupt_files(self) -> None:
        target = os.path.join(self.tmp.name, "t.jsonl")
        open(target, "w").close()
        os.chmod(target, 0o600)
        os.symlink(target, os.path.join(self.tmp.name, "link.jsonl"))
        with self.assertRaises(RationaleError):
            JsonlQueueStore(os.path.join(self.tmp.name, "link.jsonl"))
        os.chmod(target, 0o666)
        with self.assertRaises(RationaleError):
            JsonlQueueStore(target)
        with self.assertRaises(RationaleError):
            JsonlQueueStore(os.path.join(self.tmp.name, "bad name.jsonl"))
        bad_add = json.dumps({"v": 1, "op": "add", "at": "2026-11-08T10:00:00.000Z", "puid": "a", "statement": {"puid": "a"}}) + "\n"
        cases: list[bytes] = [b"not json\n", b'{"v":1,"op":"done","at":"2026-11-08T10:00:00.000Z","puid":"zz"}\n', bad_add.encode("utf-8"), b"{\xff\xfe}\n"]
        for data in cases:
            with open(self.file, "wb") as f:
                f.write(data)
            os.chmod(self.file, 0o600)
            with self.assertRaises(RationaleError):
                JsonlQueueStore(self.file)
            self.assertFalse(os.path.exists(self.file + ".lock"))

    def test_reads_queue_files_written_by_the_typescript_package(self) -> None:
        from .helpers import ROOT

        src = ROOT / "test-vectors" / "queue-from-typescript.jsonl"
        with open(self.file, "wb") as f:
            f.write(src.read_bytes())
        os.chmod(self.file, 0o600)
        s = JsonlQueueStore(self.file)
        self.assertEqual(s.stats(), {"pending": 1, "done": 1, "rejected": 1})
        self.assertEqual([e.puid for e in s.pending(10)], ["ts-3"])
        s.close()

    def test_compact(self) -> None:
        s = JsonlQueueStore(self.file)
        s.add([valid_statement("c1"), valid_statement("c2")])
        s.settle([{"puid": "c1", "result": "done"}])
        self.assertEqual(s.compact(), (1, 1))
        s.add([valid_statement("c3")])
        self.assertEqual([e.puid for e in s.pending(10)], ["c2", "c3"])
        s.close()
        self.assertEqual(stat.S_IMODE(os.stat(self.file).st_mode), 0o600)

    def test_enqueue_and_drain_with_outage(self) -> None:
        store = JsonlQueueStore(self.file)
        rep = enqueue_statements(store, [valid_statement("o1"), {"puid": "bad"}, valid_statement("o2")])
        self.assertEqual(rep.added, ("o1", "o2"))
        self.assertEqual(list(rep.invalid), [1])
        self.api.script += [{"status": 503, "raw": "down"}, {"status": 503, "raw": "down"}]
        self.assertEqual(drain_queue(self.client(), store).stopped_because, "only_failures")
        store.close()
        again = JsonlQueueStore(self.file)
        r = drain_queue(self.client(), again)
        self.assertEqual((r.created, r.stopped_because), (2, "empty"))
        again.close()

    def test_drain_outcomes(self) -> None:
        self.api.puids.add("m1")
        self.api.reject_puids.add("m2")
        store = MemoryQueueStore()
        enqueue_statements(store, [valid_statement("m1"), valid_statement("m2"), valid_statement("m3")])
        r = drain_queue(self.client(), store)
        self.assertEqual((r.created, r.duplicate, r.rejected), (1, 1, 1))
        self.api.token = "other"
        enqueue_statements(store, [valid_statement("m4")])
        self.assertEqual(drain_queue(self.client(), store).stopped_because, "fatal_error")


if __name__ == "__main__":
    unittest.main()
