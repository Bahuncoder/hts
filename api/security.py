"""Request controls for the public API.

The classifier costs roughly 175 ms of CPU per item, which makes every
endpoint that calls it a denial-of-service surface: a single 5,000-item
catalogue request occupies a worker for a quarter of an hour. Work is
therefore bounded per request, per client and per unit time, and the bounds
are tighter for anonymous callers than for keyed ones.

Rate limiting is in-process. It is correct for a single instance and is the
right amount of machinery for one; running several behind a load balancer
needs a shared counter instead.
"""
from __future__ import annotations

import hmac
import os
import time
from collections import deque
from dataclasses import dataclass, field
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
    """Keys permitted to use the paid limits, from TARIFFWISE_API_KEYS."""
    raw = os.environ.get("TARIFFWISE_API_KEYS", "")
    return {k.strip() for k in raw.split(",") if k.strip()}


@dataclass
class _Bucket:
    hits: deque[float] = field(default_factory=deque)


class RateLimiter:
    def __init__(self) -> None:
        self._buckets: dict[tuple[str, str], _Bucket] = {}
        self._lock = Lock()
        self._last_sweep = time.monotonic()

    def check(self, client: str, cls: str) -> None:
        limit, window = LIMITS[cls]
        now = time.monotonic()
        with self._lock:
            if now - self._last_sweep > 300:
                self._sweep(now)
            bucket = self._buckets.setdefault((client, cls), _Bucket())
            while bucket.hits and now - bucket.hits[0] > window:
                bucket.hits.popleft()
            if len(bucket.hits) >= limit:
                retry = int(window - (now - bucket.hits[0])) + 1
                raise HTTPException(
                    429, f"Rate limit exceeded. Retry in {retry}s.",
                    headers={"Retry-After": str(retry)},
                )
            bucket.hits.append(now)

    def _sweep(self, now: float) -> None:
        """Drop buckets nothing has touched inside the longest window."""
        longest = max(w for _, w in LIMITS.values())
        for key in [k for k, b in self._buckets.items()
                    if not b.hits or now - b.hits[-1] > longest]:
            self._buckets.pop(key, None)
        self._last_sweep = now


limiter = RateLimiter()


def client_id(request: Request) -> str:
    """Identify the caller for rate limiting.

    Only the last hop of X-Forwarded-For is trusted, and only when a proxy is
    declared, because the header is caller-supplied and otherwise forgeable.
    """
    if os.environ.get("TARIFFWISE_BEHIND_PROXY") == "1":
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
