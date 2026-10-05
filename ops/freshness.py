"""How old the data this service answers from is, and whether the last refresh failed.

The data is refreshed by ingest/refresh.py. A refresh that fails leaves the
previous data in place, and the health endpoint still reports it healthy
unless something says otherwise. This module is that something: it turns the
timestamps the pipeline already records, plus the outcome of the last refresh
(written to data/refresh_status.json), into one judgement the health check and
a monitor can act on.

Thresholds are deliberately generous for a schedule that moves monthly; each
can be tightened with an environment variable. A source that has never been
recorded counts as stale, not fresh.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATUS_FILE = ROOT / "data" / "refresh_status.json"

# The meta key each source is recorded under, and the most days it may be old.
SOURCES = {
    "built_at": ("HTSDESK_MAX_BUILD_AGE_DAYS", 45),          # HTS schedule and notes
    "cross_ingested_at": ("HTSDESK_MAX_INGEST_AGE_DAYS", 30),  # rulings
    "fedreg_polled_at": ("HTSDESK_MAX_POLL_AGE_DAYS", 3),      # Federal Register, daily
}


def thresholds() -> dict[str, float]:
    return {key: float(os.environ.get(env, default)) for key, (env, default) in SOURCES.items()}


def age_days(iso: str | None, now: datetime) -> float | None:
    if not iso:
        return None
    try:
        then = datetime.fromisoformat(iso)
    except ValueError:
        return None
    if then.tzinfo is None:
        then = then.replace(tzinfo=timezone.utc)
    return round((now - then).total_seconds() / 86400, 2)


def read_status(path: Path = STATUS_FILE) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def write_status(ok: bool, message: str = "", *, path: Path = STATUS_FILE, now: datetime | None = None) -> None:
    """Record the outcome of a refresh. Called by the refresh job, win or lose."""
    stamp = (now or datetime.now(timezone.utc)).isoformat()
    status = read_status(path)
    if ok:
        status["last_success_at"] = stamp
    else:
        status["last_failure_at"] = stamp
        status["last_error"] = message[:300]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(status, indent=2) + "\n")


def assess(meta: dict, status: dict, now: datetime | None = None) -> dict:
    """Judge freshness from the recorded timestamps and the last refresh outcome."""
    now = now or datetime.now(timezone.utc)
    limits = thresholds()
    ages = {key: age_days(meta.get(key), now) for key in SOURCES}
    stale = [key for key, age in ages.items() if age is None or age > limits[key]]

    failure = status.get("last_failure_at")
    success = status.get("last_success_at")
    refresh_failed = bool(failure) and (not success or failure > success)

    return {
        "fresh": not stale and not refresh_failed,
        "stale": stale,
        "ages_days": ages,
        "max_age_days": limits,
        "last_refresh_failed": refresh_failed,
        "last_refresh_error": status.get("last_error") if refresh_failed else None,
        "last_success_at": success,
    }
