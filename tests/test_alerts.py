"""Operator alerts: one email when the data goes stale, one when it recovers.

Pure checks with a fake sender and a temporary state file, so nothing is sent.
Run: python3 tests/test_alerts.py   (or: make test-alerts)
"""
from __future__ import annotations

import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ops.alerts import deliver, run  # noqa: E402

NOW = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)


def days_ago(n: float) -> str:
    return (NOW - timedelta(days=n)).isoformat()


def fresh_meta(**over):
    meta = {"built_at": days_ago(5), "cross_ingested_at": days_ago(2), "fedreg_polled_at": days_ago(0.5)}
    meta.update(over)
    return meta


class Sender:
    def __init__(self):
        self.sent = []

    def __call__(self, to, subject, text):
        self.sent.append((to, subject, text))
        return "sent"


CHECKS = []


def check(name):
    def wrap(fn):
        CHECKS.append((name, fn))
        return fn
    return wrap


def state_path(d):
    return Path(d) / "alert_state.json"


@check("fresh data with no earlier alert sends nothing")
def _():
    sender = Sender()
    with tempfile.TemporaryDirectory() as d:
        out = run(fresh_meta(), to="ops@example.test", send=sender, status={}, now=NOW, state_path=state_path(d))
    assert sender.sent == [] and out["key"] == "", out


@check("stale data sends one alert, not one per run")
def _():
    sender = Sender()
    with tempfile.TemporaryDirectory() as d:
        sp = state_path(d)
        run(fresh_meta(cross_ingested_at=days_ago(42)), to="ops@example.test", send=sender, status={}, now=NOW, state_path=sp)
        run(fresh_meta(cross_ingested_at=days_ago(43)), to="ops@example.test", send=sender, status={}, now=NOW, state_path=sp)
    assert len(sender.sent) == 1, sender.sent
    to, subject, text = sender.sent[0]
    assert to == "ops@example.test" and subject == "HTSDesk data is stale", sender.sent[0]
    assert "cross_ingested_at" in text and "limit 30" in text, text


@check("a failed refresh alerts with its message")
def _():
    sender = Sender()
    status = {"last_failure_at": days_ago(0.1), "last_error": "HTS download failed"}
    with tempfile.TemporaryDirectory() as d:
        run(fresh_meta(), to="ops@example.test", send=sender, status=status, now=NOW, state_path=state_path(d))
    assert len(sender.sent) == 1 and "HTS download failed" in sender.sent[0][2], sender.sent


@check("recovery sends one 'fresh again' email, then nothing")
def _():
    sender = Sender()
    with tempfile.TemporaryDirectory() as d:
        sp = state_path(d)
        run(fresh_meta(built_at=days_ago(60)), to="ops@example.test", send=sender, status={}, now=NOW, state_path=sp)
        run(fresh_meta(), to="ops@example.test", send=sender, status={}, now=NOW, state_path=sp)
        run(fresh_meta(), to="ops@example.test", send=sender, status={}, now=NOW, state_path=sp)
    assert [s[1] for s in sender.sent] == ["HTSDesk data is stale", "HTSDesk data is fresh again"], sender.sent


@check("without an address the change is recorded as skipped and nothing is sent")
def _():
    sender = Sender()
    with tempfile.TemporaryDirectory() as d:
        out = run(fresh_meta(built_at=None), to=None, send=sender, status={}, now=NOW, state_path=state_path(d))
    assert sender.sent == [] and out["result"].startswith("skipped"), out


@check("without a provider the send is skipped, and the code does not raise")
def _():
    saved = {k: os.environ.pop(k, None) for k in ("RESEND_API_KEY", "POSTMARK_API_KEY")}
    try:
        assert deliver("ops@example.test", "s", "t").startswith("skipped"), "expected skipped"
    finally:
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v


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
