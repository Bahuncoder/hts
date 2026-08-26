"""Request controls for the public API.

The classifier costs roughly 175 ms of CPU per item, which makes every
endpoint that calls it a denial-of-service surface: a single 5,000-item
catalogue request occupies a worker for a quarter of an hour. Work is
therefore bounded per request, per client and per unit time, and the bounds
are tighter for anonymous callers than for keyed ones.

Rate limiting counts in SQLite rather than process memory. Uvicorn runs
several workers, and an in-process counter is multiplied by the worker count —
two workers hand an attacker twice the configured budget, and every restart
wipes the tally. The counter lives in its own small writable database because
the reference data is opened read-only.
"""
from __future__ import annotations

import hmac
import os
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock

from fastapi import Header, HTTPException, Request

# Anonymous callers get enough to evaluate the product, not enough to mine it.
ANON_AUDIT_ITEMS = 25
KEYED_AUDIT_ITEMS = 1000

# Requests per window, by cost class.
LIMITS = {
    "cheap": (120, 60),     # lookups: 120 per minute
    "classify": (20, 60),   # one classification per request
    "audit": (5, 60),       # many classifications per request
}

MAX_TEXT = 400              # longest accepted free-text field


def api_keys() -> set[str]:
    """Keys permitted to use the paid limits, from HTSDESK_API_KEYS."""
    raw = os.environ.get("HTSDESK_API_KEYS", "")
    return {k.strip() for k in raw.split(",") if k.strip()}


RUNTIME_DB = Path(os.environ.get(
    "HTSDESK_RUNTIME_DB",
    str(Path(__file__).resolve().parent.parent / "data" / "runtime.db"),
))


class RateLimiter:
    """Sliding-window limiter shared by every worker on the host."""

    def __init__(self, path: Path | None = None) -> None:
        self._path = Path(path or RUNTIME_DB)
        self._lock = Lock()
        self._last_sweep = 0.0
        self._conn: sqlite3.Connection | None = None

    def _db(self) -> sqlite3.Connection:
        if self._conn is None:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self._path, check_same_thread=False, timeout=5)
            try:
                os.chmod(self._path, 0o600)
            except OSError:
                pass
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA busy_timeout = 5000")
            conn.execute("PRAGMA synchronous = NORMAL")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS api_hit ("
                "  client TEXT NOT NULL, cls TEXT NOT NULL, at REAL NOT NULL)")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS api_hit_key ON api_hit(client, cls, at)")
            conn.commit()
            self._conn = conn
        return self._conn

    def check(self, client: str, cls: str) -> None:
        limit, window = LIMITS[cls]
        now = time.time()
        with self._lock:
            db = self._db()
            self._sweep(db, now)
            cutoff = now - window
            row = db.execute(
                "SELECT count(*), min(at) FROM api_hit "
                "WHERE client = ? AND cls = ? AND at >= ?",
                (client, cls, cutoff),
            ).fetchone()
            count, oldest = row[0], row[1]
            if count >= limit:
                retry = int(window - (now - oldest)) + 1
                raise HTTPException(
                    429, f"Rate limit exceeded. Retry in {retry}s.",
                    headers={"Retry-After": str(retry)},
                )
            db.execute("INSERT INTO api_hit(client, cls, at) VALUES(?, ?, ?)",
                       (client, cls, now))
            db.commit()

    def _sweep(self, db: sqlite3.Connection, now: float) -> None:
        """Drop hits outside the longest window, at most once a minute."""
        if now - self._last_sweep < 60:
            return
        self._last_sweep = now
        longest = max(w for _, w in LIMITS.values())
        db.execute("DELETE FROM api_hit WHERE at < ?", (now - longest,))
        db.commit()


limiter = RateLimiter()


def client_id(request: Request) -> str:
    """Identify the caller for rate limiting.

    Only the last hop of X-Forwarded-For is trusted, and only when a proxy is
    declared, because the header is caller-supplied and otherwise forgeable.
    """
    if os.environ.get("HTSDESK_BEHIND_PROXY") == "1":
        fwd = request.headers.get("x-forwarded-for", "")
        if fwd:
            return fwd.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def authorised(key: str | None) -> bool:
    if not key:
        return False
    # Constant-time compare so a key cannot be recovered by timing.
    return any(hmac.compare_digest(key, k) for k in api_keys())


def guard(cls: str):
    """Dependency enforcing the rate limit for a cost class."""
    def _dep(request: Request,
             x_api_key: str | None = Header(default=None)) -> bool:
        keyed = authorised(x_api_key)
        if not keyed:
            limiter.check(client_id(request), cls)
        return keyed
    return _dep


def clean_text(value: str, field: str) -> str:
    value = (value or "").strip()
    if not value:
        raise HTTPException(400, f"{field} must not be empty")
    if len(value) > MAX_TEXT:
        raise HTTPException(400, f"{field} must be {MAX_TEXT} characters or fewer")
    return value
