"""Tell the operator when the data goes stale, and when it recovers.

ops/freshness.py decides whether the data is fresh. This sends that judgement
where someone will see it, by the same email providers the web app uses
(Resend or Postmark, configured by RESEND_API_KEY or POSTMARK_API_KEY) to the
address in HTSDESK_OPS_EMAIL.

It is quiet on purpose: one email when the data first goes stale (or a refresh
fails), one when it recovers, and nothing in between. The last alert is kept in
data/alert_state.json, so a daily run does not repeat it.

With no provider or no address set, nothing is sent; the result says so and the
state is still kept, so the wiring can be checked before a key exists.

Run daily, for example from cron:  python3 -m ops.alerts
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ops.freshness import assess, read_status  # noqa: E402

STATE_FILE = ROOT / "data" / "alert_state.json"
FROM = os.environ.get("HTSDESK_EMAIL_FROM", "HTSDesk <alerts@htsdesk.com>")
SourceSender = Callable[[str, str, str], str]


def read_state(path: Path = STATE_FILE) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def write_state(state: dict, path: Path = STATE_FILE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2) + "\n")


def deliver(to: str, subject: str, text: str) -> str:
    """Send one email. Returns "sent", "skipped: ..." or "failed: ..."; never raises."""
    resend = os.environ.get("RESEND_API_KEY")
    postmark = os.environ.get("POSTMARK_API_KEY")
    try:
        if resend:
            url = os.environ.get("RESEND_API_URL", "https://api.resend.com/emails")
            res = httpx.post(url, timeout=20, headers={"authorization": f"Bearer {resend}"},
                             json={"from": FROM, "to": [to], "subject": subject, "text": text})
            return "sent" if res.is_success else f"failed: resend {res.status_code}"
        if postmark:
            res = httpx.post("https://api.postmarkapp.com/email", timeout=20,
                             headers={"X-Postmark-Server-Token": postmark, "accept": "application/json"},
                             json={"From": FROM, "To": to, "Subject": subject, "TextBody": text,
                                   "MessageStream": "outbound"})
            return "sent" if res.is_success else f"failed: postmark {res.status_code}"
    except httpx.HTTPError as exc:
        return f"failed: {type(exc).__name__}"
    return "skipped: no email provider configured"


def describe(reasons: list[str], freshness: dict) -> str:
    lines = []
    if freshness["last_refresh_failed"]:
        lines.append(f"The last data refresh failed: {freshness['last_refresh_error'] or 'no message recorded'}.")
    for key in freshness["stale"]:
        age = freshness["ages_days"].get(key)
        limit = freshness["max_age_days"][key]
        what = "not recorded" if age is None else f"{age:.0f} days old (limit {limit:.0f})"
        lines.append(f"{key}: {what}.")
    lines.append("Check /api/health (keyed for detail) and the refresh job's output.")
    return "\n".join(lines)


def run(meta: dict, *, to: str | None = None, send: SourceSender = deliver,
        status: dict | None = None, now: datetime | None = None,
        state_path: Path = STATE_FILE) -> dict:
    """Compare the data's freshness with the last alert and send at most one email for a change."""
    now = now or datetime.now(timezone.utc)
    freshness = assess(meta, status if status is not None else read_status(), now)
    reasons = list(freshness["stale"]) + (["refresh_failed"] if freshness["last_refresh_failed"] else [])
    key = ",".join(sorted(reasons))
    state = read_state(state_path)
    last = state.get("alerted_key", "")
    if key == last:
        return {"sent": False, "reason": "no change", "key": key}

    if not to:
        result = "skipped: HTSDESK_OPS_EMAIL not set"
    elif reasons:
        result = send(to, "HTSDesk data is stale", describe(reasons, freshness))
    else:
        result = send(to, "HTSDesk data is fresh again", "The data is within its limits and the last refresh succeeded.")

    write_state({"alerted_key": key, "alerted_at": now.isoformat(), "last_result": result}, state_path)
    return {"sent": result == "sent", "result": result, "key": key}


def main() -> int:
    from store.db import connect, get_meta
    from ops.freshness import SOURCES
    conn = connect(readonly=True)
    try:
        meta = {key: get_meta(conn, key) for key in SOURCES}
    finally:
        conn.close()
    outcome = run(meta, to=os.environ.get("HTSDESK_OPS_EMAIL"))
    print(json.dumps(outcome))
    return 0


if __name__ == "__main__":
    sys.exit(main())
