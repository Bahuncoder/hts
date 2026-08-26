#!/usr/bin/env python3
"""Checks a deployment before it takes traffic.

Every item here corresponds to something that has actually gone wrong, or that
fails silently in a way nobody notices until a customer does.
"""
from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))


def warn(name: str, detail: str = "", _unused: object = None) -> None:
    """Same arity as check() so either can be selected inline."""
    results.append((name, None, detail))


# --- data -------------------------------------------------------------------
ref = Path(os.environ.get("HTSDESK_REFERENCE_DB", ROOT / "data" / "htsdesk.db"))
if ref.exists():
    conn = sqlite3.connect(f"file:{ref}?mode=ro", uri=True)
    leaves = conn.execute("SELECT count(*) FROM hts WHERE is_leaf = 1").fetchone()[0]
    rulings = conn.execute("SELECT count(*) FROM ruling").fetchone()[0]
    actions = conn.execute(
        "SELECT count(*) FROM fr_document WHERE tariff_action = 1").fetchone()[0]
    conn.close()
    check("reference database present", True, str(ref))
    check("HTS schedule loaded", leaves > 19_000, f"{leaves:,} leaf codes")
    check("CBP rulings loaded", rulings > 190_000, f"{rulings:,} rulings")
    # An empty feed is not an error, but it means alerts cannot fire.
    if actions:
        check("tariff actions present", True, f"{actions:,} actions")
    else:
        warn("tariff actions present", "none — alerts cannot fire")
else:
    check("reference database present", False, f"missing at {ref}")

acc = Path(os.environ.get("HTSDESK_ACCOUNTS_DB", ROOT / "data" / "accounts.db"))
if acc.exists():
    mode = oct(acc.stat().st_mode & 0o777)
    check("accounts database readable", True, f"{acc} mode {mode}")
    check("accounts database not world-readable",
          not (acc.stat().st_mode & 0o004), f"mode {mode}")
else:
    warn("accounts database", "not created yet — it appears on first signup")

# --- secrets ----------------------------------------------------------------
def env(name: str) -> str | None:
    v = os.environ.get(name)
    return v if v else None


check("HTSDESK_ADMIN_TOKEN set", bool(env("HTSDESK_ADMIN_TOKEN")),
      "without it the diff runner refuses every call")
check("HTSDESK_EMAIL_SECRET set", bool(env("HTSDESK_EMAIL_SECRET")),
      "signs unsubscribe links")
check("SITE_URL set", bool(env("SITE_URL")),
      "sitemaps, metadata and every emailed link derive from it")

for name in ("HTSDESK_ADMIN_TOKEN", "HTSDESK_EMAIL_SECRET"):
    v = env(name)
    if v:
        check(f"{name} is not trivially short", len(v) >= 24, f"{len(v)} characters")

mail = env("RESEND_API_KEY") or env("POSTMARK_API_KEY")
if mail:
    check("mail provider configured", True)
else:
    warn("mail provider configured",
         "alerts, password reset and verified signup all need it")
if not mail:
    warn("signup enumeration", "returns to the visible fallback without email")

stripe_key = env("STRIPE_SECRET_KEY")
if stripe_key:
    check("Stripe configured", True)
else:
    warn("Stripe configured", "paid plans cannot be purchased without it")
if stripe_key:
    check("Stripe webhook secret set", bool(env("STRIPE_WEBHOOK_SECRET")),
          "without it no subscription ever activates")
    for plan in ("STARTER", "GROWTH"):
        check(f"price id for {plan.title()}", bool(env(f"STRIPE_PRICE_{plan}")))

if env("ANTHROPIC_API_KEY"):
    check("reasoning layer enabled", True)
else:
    warn("reasoning layer enabled",
         "classification falls back to retrieval only, at lower accuracy")

# --- exposure ---------------------------------------------------------------
origins = os.environ.get("HTSDESK_ORIGINS", "")
check("CORS closed by default", origins.strip() == "" or "*" not in origins,
      f"HTSDESK_ORIGINS={origins!r}")
proxy = os.environ.get("HTSDESK_BEHIND_PROXY", "0")
warn("proxy header trust", f"HTSDESK_BEHIND_PROXY={proxy} — set 1 only behind nginx")

# --- backups ----------------------------------------------------------------
bdir = Path(os.environ.get("HTSDESK_BACKUP_DIR", "/var/backups/htsdesk"))
backups = sorted(bdir.glob("accounts-*.db.gz")) if bdir.exists() else []
if backups:
    check("accounts backups exist", True, f"{len(backups)} in {bdir}")
else:
    warn("accounts backups exist", f"none in {bdir} — enable htsdesk-backup.timer")

failed = [r for r in results if r[1] is False]
width = max(len(n) for n, _, _ in results)
for name, ok, detail in results:
    mark = "ok  " if ok else ("WARN" if ok is None else "FAIL")
    print(f"  {mark}  {name.ljust(width)}  {detail}")
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed"
      + (f", {len(failed)} FAILED" if failed else ""))
sys.exit(1 if failed else 0)
