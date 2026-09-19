#!/usr/bin/env python3
"""Checks the API host's deployment before it takes traffic.

Every item here corresponds to something that has actually gone wrong, or that
fails silently in a way nobody notices until a customer does.

Scoped to the API host only: the web app deploys separately to Vercel, with
its own environment (email secret, Turso credentials) set in the
Vercel dashboard rather than here, so those are not checkable from this
script. Verify them with `vercel env ls` before a web deploy instead.
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
    revision = conn.execute("SELECT value FROM meta WHERE key='dataset_revision'").fetchone()
    release = conn.execute("SELECT value FROM meta WHERE key='release_dir'").fetchone()
    hts_idx = conn.execute("SELECT count(*) FROM hts_fts").fetchone()[0]
    ruling_idx = conn.execute("SELECT count(*) FROM ruling_fts").fetchone()[0]
    conn.close()
    check("reference database present", True, str(ref))
    # A populated ruling table with an empty index looks healthy and returns no
    # precedent at all; row counts alone cannot show it.
    check("schedule search index covers every line", hts_idx == leaves,
          f"{hts_idx:,} indexed of {leaves:,}")
    check("ruling search index covers every ruling", ruling_idx == rulings,
          f"{ruling_idx:,} indexed of {rulings:,}")
    if revision and revision[0]:
        check("dataset revision recorded", True, revision[0])
        if release and release[0]:
            rel = Path(release[0])
            rel = rel if rel.is_absolute() else ROOT / rel
            check("active release files exist",
                  (rel / "hts.json").exists() and (rel / "chapter99.txt").exists(),
                  str(rel))
    else:
        warn("dataset revision recorded",
             "legacy build with no revision — run `make refresh` once")
    check("HTS schedule loaded", leaves > 19_000, f"{leaves:,} leaf codes")
    check("CBP rulings loaded", rulings > 190_000, f"{rulings:,} rulings")
    # An empty feed is not an error, but it means alerts cannot fire.
    if actions:
        check("tariff actions present", True, f"{actions:,} actions")
    else:
        warn("tariff actions present", "none — alerts cannot fire")
else:
    check("reference database present", False, f"missing at {ref}")

# --- secrets ----------------------------------------------------------------
def env(name: str) -> str | None:
    v = os.environ.get(name)
    return v if v else None


check("HTSDESK_ADMIN_TOKEN set", bool(env("HTSDESK_ADMIN_TOKEN")),
      "without it the diff runner refuses every call")
check("HTSDESK_WEB_URL set", bool(env("HTSDESK_WEB_URL")),
      "the diff trigger posts here — the Vercel deployment's origin")

token = env("HTSDESK_ADMIN_TOKEN")
if token:
    check("HTSDESK_ADMIN_TOKEN is not trivially short", len(token) >= 24, f"{len(token)} characters")

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

failed = [r for r in results if r[1] is False]
width = max(len(n) for n, _, _ in results)
for name, ok, detail in results:
    mark = "ok  " if ok else ("WARN" if ok is None else "FAIL")
    print(f"  {mark}  {name.ljust(width)}  {detail}")
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed"
      + (f", {len(failed)} FAILED" if failed else ""))
sys.exit(1 if failed else 0)
