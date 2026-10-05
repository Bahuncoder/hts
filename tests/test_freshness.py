"""Freshness judgement: how old the data is, and whether the last refresh failed.

Pure checks on ops/freshness.py with fixed times, so nothing here depends on
the real data or the clock. Run: python3 tests/test_freshness.py
"""
from __future__ import annotations

import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ops.freshness import age_days, assess, read_status, write_status  # noqa: E402

NOW = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)


def days_ago(n: float) -> str:
    return (NOW - timedelta(days=n)).isoformat()


def fresh_meta(**over: str | None) -> dict:
    meta = {"built_at": days_ago(5), "cross_ingested_at": days_ago(2), "fedreg_polled_at": days_ago(0.5)}
    meta.update(over)
    return meta


CHECKS = []


def check(name):
    def wrap(fn):
        CHECKS.append((name, fn))
        return fn
    return wrap


@check("recent data and no failed refresh is fresh")
def _():
    r = assess(fresh_meta(), {"last_success_at": days_ago(1)}, NOW)
    assert r["fresh"] and r["stale"] == [] and not r["last_refresh_failed"], r


@check("an HTS build older than its limit is stale, and named")
def _():
    r = assess(fresh_meta(built_at=days_ago(60)), {}, NOW)
    assert not r["fresh"] and r["stale"] == ["built_at"], r


@check("a ruling ingest older than its limit is stale")
def _():
    r = assess(fresh_meta(cross_ingested_at=days_ago(42)), {}, NOW)
    assert r["stale"] == ["cross_ingested_at"], r


@check("a missing source counts as stale, not fresh")
def _():
    r = assess(fresh_meta(fedreg_polled_at=None), {}, NOW)
    assert not r["fresh"] and r["stale"] == ["fedreg_polled_at"], r


@check("a refresh failure after the last success is reported")
def _():
    status = {"last_success_at": days_ago(3), "last_failure_at": days_ago(0.2), "last_error": "HTS download failed"}
    r = assess(fresh_meta(), status, NOW)
    assert not r["fresh"] and r["last_refresh_failed"] and r["last_refresh_error"] == "HTS download failed", r


@check("a success after a failure clears it")
def _():
    status = {"last_failure_at": days_ago(2), "last_success_at": days_ago(0.2)}
    r = assess(fresh_meta(), status, NOW)
    assert r["fresh"] and not r["last_refresh_failed"], r


@check("limits can be tightened from the environment")
def _():
    os.environ["HTSDESK_MAX_BUILD_AGE_DAYS"] = "2"
    try:
        r = assess(fresh_meta(), {}, NOW)
        assert r["stale"] == ["built_at"], r
    finally:
        del os.environ["HTSDESK_MAX_BUILD_AGE_DAYS"]


@check("status is written by outcome and read back, keeping the last success")
def _():
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "refresh_status.json"
        write_status(True, path=path, now=NOW)
        write_status(False, "boom", path=path, now=NOW + timedelta(hours=1))
        status = read_status(path)
        assert status["last_success_at"] == NOW.isoformat(), status
        assert status["last_failure_at"] == (NOW + timedelta(hours=1)).isoformat(), status
        assert status["last_error"] == "boom", status


@check("unreadable timestamps are treated as missing")
def _():
    assert age_days("not a date", NOW) is None
    assert age_days(None, NOW) is None


def main() -> int:
    failed = 0
    for name, fn in CHECKS:
        try:
            fn()
            print(f"  ok    {name}")
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL  {name}\n        {exc}")
    print(f"\n{len(CHECKS) - failed}/{len(CHECKS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
