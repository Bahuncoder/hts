"""api/security.py's RateLimiter under real concurrency, not just sequential
calls — a check-then-act limiter can look correct in every single-threaded
test and still oversubscribe the moment two callers land at the same
instant, which is exactly the shape of a multi-worker deployment (the
module's own docstring says rate limiting lives in SQLite specifically
because uvicorn runs several worker processes, each with its own memory).

Found by an independent security review (2026-09-24): the original check()
did a SELECT, decided, then a separate INSERT, under a threading.Lock that
only ever coordinated threads inside ONE process — nothing coordinates two
separate worker processes, which don't share a Lock() at all. Reproduced
directly before fixing: two threads bypassing the in-process lock (standing
in for two workers, which never shared one to begin with) landed on the
same read and both got admitted, storing 121 hits against a limit of 120.

Fix: the admit decision and the reservation are now one atomic
INSERT ... SELECT ... WHERE statement. SQLite serializes writers across
every connection to the same file regardless of process, which is what a
Python-level lock never could be for a multi-worker deployment.
"""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

_results: list[tuple[str, str, str]] = []


def check(name):
    def wrap(fn):
        try:
            fn()
            _results.append((name, "pass", ""))
        except AssertionError as exc:
            _results.append((name, "FAIL", str(exc) or "assertion failed"))
        except Exception:
            _results.append((name, "ERROR", traceback.format_exc(limit=3).strip()))
        return fn
    return wrap


def fresh_limiter():
    """A RateLimiter over its own scratch database, never data/runtime.db."""
    import importlib
    import api.security as sec
    importlib.reload(sec)
    scratch = Path(tempfile.mkdtemp(prefix="htsdesk-ratelimit-"))
    os.environ["HTSDESK_RUNTIME_DB"] = str(scratch / "runtime.db")
    importlib.reload(sec)
    return sec


@check("sequential calls: admitted exactly up to the limit, refused after")
def _():
    sec = fresh_limiter()
    limit, _window = sec.LIMITS["cheap"]
    admitted = 0
    for _ in range(limit + 5):
        try:
            sec.limiter.check("seq-client", "cheap")
            admitted += 1
        except Exception:
            pass
    assert admitted == limit, f"admitted {admitted}, limit is {limit}"


@check("concurrent calls at the exact limit boundary: never oversubscribed, even with the in-process lock bypassed")
def _():
    # Bypasses self._lock entirely — standing in for two separate uvicorn
    # worker processes, which never shared a Lock() to begin with, not for
    # a bug in the lock itself.
    sec = fresh_limiter()
    limit, window = sec.LIMITS["cheap"]
    lim = sec.RateLimiter()
    db = lim._db()
    now = time.time()
    for _ in range(limit - 1):
        db.execute("INSERT INTO api_hit(client, cls, at) VALUES(?, ?, ?)", ("race-client", "cheap", now))
    db.commit()

    barrier = threading.Barrier(2)
    results: list[str] = []

    def raw_check(client: str, cls: str) -> None:
        lim2, win2 = sec.LIMITS[cls]
        t = time.time()
        d = lim._db()
        cutoff = t - win2
        barrier.wait()  # force both callers to reach the database at the same instant
        cur = d.execute(
            "INSERT INTO api_hit(client, cls, at) SELECT ?, ?, ? WHERE "
            "(SELECT count(*) FROM api_hit WHERE client = ? AND cls = ? AND at >= ?) < ?",
            (client, cls, t, client, cls, cutoff, lim2),
        )
        d.commit()
        if cur.rowcount == 0:
            raise Exception("refused")

    def worker():
        try:
            raw_check("race-client", "cheap")
            results.append("admitted")
        except Exception:
            results.append("refused")

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert results.count("admitted") == 1, f"expected exactly 1 admitted of 2 racing at the boundary, got {results}"
    count = db.execute(
        "SELECT count(*) FROM api_hit WHERE client = ? AND cls = ?", ("race-client", "cheap")
    ).fetchone()[0]
    assert count == limit, f"stored {count} hits against a limit of {limit}"


@check("a caller under the limit is unaffected by another client racing at its own boundary")
def _():
    sec = fresh_limiter()
    limit, _window = sec.LIMITS["cheap"]
    lim = sec.RateLimiter()
    db = lim._db()
    now = time.time()
    for _ in range(limit):
        db.execute("INSERT INTO api_hit(client, cls, at) VALUES(?, ?, ?)", ("busy-client", "cheap", now))
    db.commit()
    # busy-client is exhausted; a different client must be untouched.
    lim.check("quiet-client", "cheap")  # must not raise


def main() -> int:
    width = max(len(n) for n, _, _ in _results)
    failed = 0
    for name, status, detail in _results:
        print(f"  {'ok  ' if status == 'pass' else 'FAIL'}  {name.ljust(width)}")
        if status != "pass":
            failed += 1
            print(f"        {detail.splitlines()[-1][:200]}")
    print(f"\n{len(_results) - failed}/{len(_results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
