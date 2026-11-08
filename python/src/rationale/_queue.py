# Copyright 2026 MB AFKzona Group
# SPDX-License-Identifier: Apache-2.0
"""Queue stores (memory and append-only JSONL) and draining.

The JSONL format is the same as the TypeScript package's, so both can read
each other's queue files (one process at a time).
"""

from __future__ import annotations

import datetime
import json
import os
import re
import secrets
import stat
import threading
from dataclasses import dataclass, replace
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from ._client import Report, TransparencyClient, parse_json_safe
from ._core import RationaleError, redact
from ._validate import ValidationResult, validate_statement, validate_statements

_ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z", re.ASCII)
_PUID = re.compile(r"[a-zA-Z0-9_-]{1,500}", re.ASCII)
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", re.ASCII)
_SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,200}", re.ASCII)
_MAX_REASON = 500
_MAX_LINE = 2 * 1024 * 1024


@dataclass(frozen=True)
class QueueEntry:
    puid: str
    state: str
    statement: Optional[Dict[str, Any]]
    added_at: str
    attempts: int = 0
    last_error: Optional[str] = None
    uuid: Optional[str] = None


def _now() -> str:
    n = datetime.datetime.now(datetime.timezone.utc)
    return n.strftime("%Y-%m-%dT%H:%M:%S.") + f"{n.microsecond // 1000:03d}Z"


def clean_reason(reason: str) -> str:
    """Shorten and redact a failure reason before it is stored."""
    return "".join(" " if ord(c) < 0x20 or ord(c) == 0x7F else c for c in redact(reason))[:_MAX_REASON]


def parse_event(value: Any) -> Optional[Dict[str, Any]]:
    """Check one stored event. Stored files are untrusted: every field is checked."""
    if not isinstance(value, dict) or value.get("v") != 1 or isinstance(value.get("v"), bool):
        return None
    op, at, puid = value.get("op"), value.get("at"), value.get("puid")
    if not isinstance(at, str) or not _ISO.fullmatch(at) or not isinstance(puid, str) or not _PUID.fullmatch(puid):
        return None
    keys = set(value)
    if op == "add":
        if keys != {"v", "op", "at", "puid", "statement"}:
            return None
        r = validate_statement(value["statement"], "off")
        if not r.ok or r.statement is None or r.statement["puid"] != puid:
            return None
        return {"v": 1, "op": op, "at": at, "puid": puid, "statement": r.statement}
    if op == "done":
        if not {"v", "op", "at", "puid"} <= keys <= {"v", "op", "at", "puid", "uuid", "duplicate"}:
            return None
        uuid, dup = value.get("uuid"), value.get("duplicate")
        if uuid is not None and (not isinstance(uuid, str) or not _UUID.fullmatch(uuid)):
            return None
        if dup is not None and not isinstance(dup, bool):
            return None
        out: Dict[str, Any] = {"v": 1, "op": op, "at": at, "puid": puid}
        if uuid is not None:
            out["uuid"] = uuid
        if dup is not None:
            out["duplicate"] = dup
        return out
    if op in ("rejected", "failed"):
        if keys != {"v", "op", "at", "puid", "reason"}:
            return None
        reason = value["reason"]
        if not isinstance(reason, str) or len(reason) > _MAX_REASON:
            return None
        return {"v": 1, "op": op, "at": at, "puid": puid, "reason": reason}
    return None


class QueueState:
    """In-memory state built by applying events in order."""

    def __init__(self) -> None:
        self._entries: Dict[str, QueueEntry] = {}

    def apply(self, e: Mapping[str, Any]) -> None:
        puid = e["puid"]
        entry = self._entries.get(puid)
        if e["op"] == "add":
            if entry is not None:
                raise RationaleError("queue_corrupt", "A PUID was added twice.")
            self._entries[puid] = QueueEntry(puid, "pending", e["statement"], e["at"])
            return
        if entry is None:
            raise RationaleError("queue_corrupt", "An outcome refers to a PUID that was never added.")
        if entry.state != "pending":
            raise RationaleError("queue_corrupt", "An outcome was recorded for a statement that was already settled.")
        if e["op"] == "done":
            self._entries[puid] = replace(entry, state="done", statement=None, uuid=e.get("uuid"))
        elif e["op"] == "rejected":
            self._entries[puid] = replace(entry, state="rejected", statement=None, last_error=e["reason"])
        else:
            self._entries[puid] = replace(entry, attempts=entry.attempts + 1, last_error=e["reason"])

    def has(self, puid: str) -> bool:
        return puid in self._entries

    def is_pending(self, puid: str) -> bool:
        e = self._entries.get(puid)
        return e is not None and e.state == "pending"

    def pending(self, limit: int, exclude: Optional[Set[str]] = None) -> List[QueueEntry]:
        out: List[QueueEntry] = []
        for e in self._entries.values():
            if len(out) >= limit:
                break
            if e.state == "pending" and (exclude is None or e.puid not in exclude):
                out.append(e)
        return out

    def entries(self) -> List[QueueEntry]:
        return list(self._entries.values())

    def stats(self) -> Dict[str, int]:
        out = {"pending": 0, "done": 0, "rejected": 0}
        for e in self._entries.values():
            out[e.state] += 1
        return out


def _update_event(state: QueueState, u: Mapping[str, Any], at: str) -> Optional[Dict[str, Any]]:
    puid = u.get("puid")
    if not isinstance(puid, str) or not state.is_pending(puid):
        return None
    result = u.get("result")
    if result == "done":
        e: Dict[str, Any] = {"v": 1, "op": "done", "at": at, "puid": puid}
        uuid = u.get("uuid")
        if isinstance(uuid, str) and _UUID.fullmatch(uuid):
            e["uuid"] = uuid
        if isinstance(u.get("duplicate"), bool):
            e["duplicate"] = u["duplicate"]
        return e
    if result in ("rejected", "failed"):
        return {"v": 1, "op": result, "at": at, "puid": puid, "reason": clean_reason(str(u.get("reason", "")))}
    return None


def _check_limit(limit: int) -> None:
    if not isinstance(limit, int) or not 1 <= limit <= 100_000:
        raise ValueError("limit must be an integer from 1 to 100000")


class MemoryQueueStore:
    """Queue store in memory (lost when the process ends)."""

    def __init__(self) -> None:
        self._state = QueueState()
        self._closed = False
        self._lock = threading.Lock()

    def _open(self) -> None:
        if self._closed:
            raise RationaleError("queue", "The queue store is closed.")

    def _add_events(self, statements: Iterable[Any]) -> Tuple[List[Dict[str, Any]], List[str], List[str]]:
        at = _now()
        events: List[Dict[str, Any]] = []
        added: List[str] = []
        skipped: List[str] = []
        seen: Set[str] = set()
        for s in statements:
            r = validate_statement(s, "off")
            if not r.ok or r.statement is None:
                raise RationaleError("queue", "Only valid statements can be queued. Validate before adding.")
            puid = str(r.statement["puid"])
            if self._state.has(puid) or puid in seen:
                skipped.append(puid)
                continue
            seen.add(puid)
            events.append({"v": 1, "op": "add", "at": at, "puid": puid, "statement": r.statement})
            added.append(puid)
        return events, added, skipped

    def _write(self, events: List[Dict[str, Any]]) -> None:
        for e in events:
            self._state.apply(e)

    def add(self, statements: Sequence[Any]) -> Tuple[List[str], List[str]]:
        """Add statements whose PUID is not known yet. Returns (added, skipped)."""
        with self._lock:
            self._open()
            events, added, skipped = self._add_events(statements)
            self._write(events)
            return added, skipped

    def pending(self, limit: int, exclude: Optional[Set[str]] = None) -> List[QueueEntry]:
        with self._lock:
            self._open()
            _check_limit(limit)
            return self._state.pending(limit, exclude)

    def settle(self, updates: Sequence[Mapping[str, Any]]) -> None:
        with self._lock:
            self._open()
            at = _now()
            events: List[Dict[str, Any]] = []
            seen: Set[str] = set()
            for u in updates:
                e = _update_event(self._state, u, at)
                if e is not None and e["puid"] not in seen:
                    seen.add(e["puid"])
                    events.append(e)
            self._write(events)

    def stats(self) -> Dict[str, int]:
        with self._lock:
            self._open()
            return self._state.stats()

    def close(self) -> None:
        self._closed = True


def _check_path(path: str) -> str:
    if not isinstance(path, str) or not path or "\0" in path or len(path) > 4096:
        raise RationaleError("unsafe_path", "Invalid file path.")
    full = os.path.abspath(path)
    name = os.path.basename(full)
    if not _SAFE_NAME.fullmatch(name):
        raise RationaleError("unsafe_path", 'The file name may contain only letters, digits, ".", "_" and "-".')
    d = os.path.dirname(full)
    try:
        st = os.lstat(d)
    except FileNotFoundError:
        raise RationaleError("unsafe_path", "The directory does not exist or is not a directory.") from None
    if not stat.S_ISDIR(st.st_mode):
        raise RationaleError("unsafe_path", "The directory does not exist or is not a directory.")
    if hasattr(os, "getuid") and st.st_mode & 0o002 and not st.st_mode & 0o1000:
        raise RationaleError("unsafe_path", "The directory is writable by everyone. Use a private directory.")
    try:
        fst = os.lstat(full)
    except FileNotFoundError:
        return full
    _check_existing(fst)
    return full


def _check_existing(st: os.stat_result) -> None:
    if stat.S_ISLNK(st.st_mode):
        raise RationaleError("unsafe_path", "The path is a symbolic link. Refusing to follow it.")
    if not stat.S_ISREG(st.st_mode):
        raise RationaleError("unsafe_path", "The path exists and is not a regular file.")
    if hasattr(os, "getuid"):
        if st.st_uid != os.getuid():
            raise RationaleError("unsafe_path", "The file belongs to another user.")
        if st.st_mode & 0o022:
            raise RationaleError("unsafe_path", "The file is writable by other users. Run chmod 600 on it.")


_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
# Opening a FIFO for reading would block; O_NONBLOCK makes it return so the type check can refuse it.
_NONBLOCK = getattr(os, "O_NONBLOCK", 0)


def _sync_directory(path: str) -> None:
    """Sync a directory so a rename in it survives a crash (skipped where directories cannot be opened)."""
    try:
        dfd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(dfd)
    except OSError:
        pass
    finally:
        os.close(dfd)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class JsonlQueueStore(MemoryQueueStore):
    """Durable queue store: an append-only JSONL file with a lock file (one process at a time)."""

    def __init__(self, path: str, *, max_file_bytes: int = 256 * 1024 * 1024, sync: bool = True) -> None:
        super().__init__()
        self._path = _check_path(path)
        self._lock_path = self._path + ".lock"
        self._sync = sync
        self._acquire_lock()
        try:
            self._load(max_file_bytes)
            self._fd = os.open(self._path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | _NOFOLLOW | _NONBLOCK, 0o600)
            _check_existing(os.fstat(self._fd))
            if self._truncate_to is not None:
                os.ftruncate(self._fd, self._truncate_to)
        except BaseException:
            self._release_lock()
            raise

    @property
    def path(self) -> str:
        return self._path

    def _create_lock(self) -> None:
        fd = os.open(self._lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW, 0o600)
        try:
            os.write(fd, f"{os.getpid()}\n".encode("ascii"))
        finally:
            os.close(fd)

    def _lock_is_stale(self) -> bool:
        holder = -1
        try:
            rfd = os.open(self._lock_path, os.O_RDONLY | _NOFOLLOW | _NONBLOCK)
            try:
                _check_existing(os.fstat(rfd))
                raw = os.read(rfd, 32).decode("ascii", "replace").strip()
                holder = int(raw) if re.fullmatch(r"[0-9]{1,10}", raw, re.ASCII) else -1
            finally:
                os.close(rfd)
        except (OSError, RationaleError):
            holder = -1
        return holder > 0 and holder != os.getpid() and not _pid_alive(holder)

    def _acquire_lock(self) -> None:
        """Take the lock file. A stale lock is taken over only under an exclusive takeover file (see the TypeScript store)."""
        try:
            self._create_lock()
            return
        except FileExistsError:
            pass
        locked = RationaleError("queue_locked", "The queue file is in use by another process (lock file exists).")
        if not self._lock_is_stale():
            raise locked
        guard = self._lock_path + ".takeover"
        try:
            os.close(os.open(guard, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW, 0o600))
        except FileExistsError:
            raise RationaleError("queue_locked", "Another process is taking over the queue lock. If none is, remove the .lock.takeover file by hand.") from None
        try:
            # Read again under the guard: another process may have taken over in the meantime.
            if not self._lock_is_stale():
                raise locked
            os.unlink(self._lock_path)
            try:
                self._create_lock()
            except FileExistsError:
                raise locked from None
        finally:
            try:
                os.unlink(guard)
            except FileNotFoundError:
                pass

    def _release_lock(self) -> None:
        try:
            os.unlink(self._lock_path)
        except FileNotFoundError:
            pass

    def _load(self, max_file_bytes: int) -> None:
        self._truncate_to: Optional[int] = None
        try:
            fd = os.open(self._path, os.O_RDONLY | _NOFOLLOW | _NONBLOCK)
        except FileNotFoundError:
            return
        try:
            st = os.fstat(fd)
            _check_existing(st)
            if st.st_size > max_file_bytes:
                raise RationaleError("queue", f"The queue file is larger than {max_file_bytes} bytes. Compact it.")
            chunks = []
            while True:
                b = os.read(fd, 1 << 20)
                if not b:
                    break
                chunks.append(b)
            data = b"".join(chunks)
        finally:
            os.close(fd)
        lines = data.split(b"\n")
        offset = 0
        for n, raw in enumerate(lines[:-1], start=1):
            offset += len(raw) + 1
            if len(raw) > _MAX_LINE:
                raise RationaleError("queue_corrupt", f"Queue file line {n} is too long.")
            if not raw.strip():
                continue
            try:
                line = raw.decode("utf-8")
            except UnicodeDecodeError:
                raise RationaleError("queue_corrupt", f"Queue file line {n} is not valid UTF-8.") from None
            event = parse_event(parse_json_safe(line))
            if event is None:
                raise RationaleError("queue_corrupt", f"Queue file line {n} is not a valid queue record.")
            try:
                self._state.apply(event)
            except RationaleError as e:
                raise RationaleError("queue_corrupt", f"Queue file line {n}: {e.message}") from None
        if offset < len(data):
            self._truncate_to = offset

    def _write(self, events: List[Dict[str, Any]]) -> None:
        if not events:
            return
        if self._fd < 0:
            raise RationaleError("queue", "The queue store is closed.")
        data = "".join(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n" for e in events).encode("utf-8")
        view = memoryview(data)
        while view:
            n = os.write(self._fd, view)
            view = view[n:]
        if self._sync:
            os.fsync(self._fd)
        super()._write(events)

    def compact(self) -> Tuple[int, int]:
        """Rewrite the file with only pending statements (atomic rename). Returns (kept, dropped)."""
        with self._lock:
            self._open()
            entries = self._state.entries()
            keep = [e for e in entries if e.state == "pending" and e.statement is not None]
            tmp = os.path.join(os.path.dirname(self._path), f".rationale-compact-{secrets.token_hex(8)}.tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW, 0o600)
            try:
                with os.fdopen(fd, "wb", closefd=False) as out:
                    for e in keep:
                        out.write((json.dumps({"v": 1, "op": "add", "at": e.added_at, "puid": e.puid, "statement": e.statement}, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
                os.fsync(fd)
            except BaseException:
                os.close(fd)
                try:
                    os.unlink(tmp)
                except FileNotFoundError:
                    pass
                raise
            os.close(fd)
            os.close(self._fd)
            self._fd = -1
            try:
                os.replace(tmp, self._path)
                _sync_directory(os.path.dirname(self._path))
            finally:
                self._fd = os.open(self._path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | _NOFOLLOW | _NONBLOCK, 0o600)
            fresh = QueueState()
            for e in keep:
                fresh.apply({"op": "add", "puid": e.puid, "at": e.added_at, "statement": e.statement})
            self._state = fresh
            return len(keep), len(entries) - len(keep)

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                self._closed = True
                if self._fd >= 0:
                    os.close(self._fd)
                    self._fd = -1
                self._release_lock()


@dataclass(frozen=True)
class EnqueueReport:
    added: Tuple[str, ...]
    skipped: Tuple[str, ...]
    invalid: Mapping[int, ValidationResult]


def enqueue_statements(store: MemoryQueueStore, statements: Sequence[Any], personal_data: str = "warn") -> EnqueueReport:
    """Validate statements and add the valid ones to the queue."""
    results = validate_statements(statements, personal_data)
    invalid = {i: r for i, r in enumerate(results) if not r.ok}
    valid = [r.statement for r in results if r.ok and r.statement is not None]
    added, skipped = store.add(valid)
    return EnqueueReport(tuple(added), tuple(skipped), invalid)


@dataclass(frozen=True)
class DrainReport:
    created: int
    duplicate: int
    rejected: int
    failed: int
    rounds: int
    stopped_because: str


def drain_queue(client: TransparencyClient, store: MemoryQueueStore, page_size: int = 500, max_rounds: Optional[int] = None) -> DrainReport:
    """Send pending statements until the queue is empty or no progress is possible."""
    if not isinstance(page_size, int) or not 1 <= page_size <= 10_000:
        raise ValueError("page_size must be an integer from 1 to 10000")
    tried: Set[str] = set()
    t = {"created": 0, "duplicate": 0, "rejected": 0, "failed": 0}
    rounds = 0

    def report(why: str) -> DrainReport:
        return DrainReport(t["created"], t["duplicate"], t["rejected"], t["failed"], rounds, why)

    while True:
        if max_rounds is not None and rounds >= max_rounds:
            return report("max_rounds")
        page = store.pending(page_size, tried)
        if not page:
            return report("empty")
        statements = [e.statement for e in page if e.statement is not None]
        tried.update(e.puid for e in page)
        rounds += 1
        result: Report = client.submit_batch(statements)
        if result.dry_run:
            return report("dry_run")
        updates: List[Dict[str, Any]] = []
        progress = False
        fatal = False
        for o, s in zip(result.outcomes, statements):
            puid = str(s["puid"])
            if o.status == "created":
                updates.append({"puid": puid, "result": "done", "uuid": o.uuid, "duplicate": False})
                t["created"] += 1
            elif o.status == "duplicate":
                updates.append({"puid": puid, "result": "done", "duplicate": True})
                t["duplicate"] += 1
            elif o.status in ("rejected", "invalid"):
                reason = "; ".join(f"{k}: {' '.join(v)}" for k, v in o.server_errors.items()) or "; ".join(f"{e.attribute}: {e.code}" for e in o.errors) or "Rejected."
                updates.append({"puid": puid, "result": "rejected", "reason": reason})
                t["rejected"] += 1
            elif o.status == "failed":
                err = o.error or {}
                updates.append({"puid": puid, "result": "failed", "reason": f"{err.get('code')}: {err.get('message')}"})
                t["failed"] += 1
                if err.get("code") in ("unauthorized", "forbidden", "token"):
                    fatal = True
            if o.status != "failed":
                progress = True
        store.settle(updates)
        if fatal:
            return report("fatal_error")
        if not progress:
            return report("only_failures")
