"""Daily data refresh.

The HTS is reissued through the year, Chapter 99 changes with every trade
action, and the Federal Register moves daily. This pulls all three and rebuilds
the reference database. Ruling ingest is incremental and run separately, since
the corpus only grows at the margin.

Each refresh downloads into its own immutable release directory
(data/releases/<utc timestamp>/), builds from it, and only then points the
database at it. The build is validated before it is published (see
ingest/build.py), so a truncated download or a reshaped upstream file leaves the
previous release serving traffic. The API reloads its engine when the dataset
revision changes, so lookups and quotes always come from the same edition.
"""
from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

HTS_URL = ("https://hts.usitc.gov/reststop/exportList"
           "?from=0100&to=9999&format=JSON&styles=false")
CH99_URL = ("https://hts.usitc.gov/reststop/file"
            "?release=currentRelease&filename=Chapter%2099")

MIN_SHADING_HEADINGS = 300
KEEP_RELEASES = 3
# Well under the current ~30,000 schedule rows: enough to reject an error page
# or a truncated body before spending time on a build.
MIN_SCHEDULE_ROWS = 20_000

# Well under the current ~713 orders in effect: catches a Federal Register
# search that started coming back empty (a wrong match would be worse than a
# missed one, but a build that silently forgets almost everything it once knew
# is worse than either). The HTS-list ratio floor is well under the ~99%
# currently resolved, so it only fires on a real extraction regression, not
# day-to-day variation as new orders (which take time to resolve) appear.
MIN_ADCVD_ORDERS = 400
MIN_ADCVD_HTS_RATIO = 0.90
ADCVD_SHRINK_LIMIT = 0.90


def fetch(url: str, dest: Path) -> int:
    with httpx.stream("GET", url, timeout=300, follow_redirects=True) as r:
        r.raise_for_status()
        tmp = dest.with_suffix(dest.suffix + ".tmp")
        with tmp.open("wb") as fh:
            for chunk in r.iter_bytes():
                fh.write(chunk)
        tmp.replace(dest)
    return dest.stat().st_size


def check_downloads(release: Path) -> None:
    rows = json.loads((release / "hts.json").read_text())
    if not isinstance(rows, list) or len(rows) < MIN_SCHEDULE_ROWS:
        raise SystemExit(
            f"refresh aborted: schedule has {len(rows) if isinstance(rows, list) else 'no'} "
            f"rows, expected at least {MIN_SCHEDULE_ROWS:,}")
    if "9903" not in (release / "chapter99.txt").read_text(errors="ignore"):
        raise SystemExit("refresh aborted: Chapter 99 text has no 9903 headings")
    marks = json.loads((release / "chapter99_expired.json").read_text())
    if marks.get("headings_checked", 0) < MIN_SHADING_HEADINGS or not marks.get("expired"):
        raise SystemExit(
            f"refresh aborted: the shading pass checked {marks.get('headings_checked', 0)} "
            f"headings and found {len(marks.get('expired', []))} expired; a layout change "
            "would leave every old sanction looking live")


def validate_adcvd(path: Path, previous_path: Path) -> str | None:
    """Reason the new AD/CVD list must not be published, or None if it may be.

    Mirrors ingest/build.py's floor + shrink-limit validation: absolute floors
    catch a first build from a broken scraper, the shrink limit catches a good
    build followed by a bad one (e.g. a Federal Register search that started
    coming back empty without the fetch itself failing)."""
    try:
        orders = json.loads(path.read_text())["orders"]
        if not isinstance(orders, list) or not orders:
            raise ValueError("no orders")
    except Exception as exc:
        return f"output is not readable ({exc})"
    if len(orders) < MIN_ADCVD_ORDERS:
        return f"only {len(orders)} orders, expected at least {MIN_ADCVD_ORDERS}"
    ratio = sum(1 for o in orders if o.get("hts")) / len(orders)
    if ratio < MIN_ADCVD_HTS_RATIO:
        return f"only {ratio:.0%} of orders carry an HTS list, expected at least {MIN_ADCVD_HTS_RATIO:.0%}"
    if previous_path.exists():
        try:
            prev_orders = json.loads(previous_path.read_text())["orders"]
        except Exception:
            prev_orders = None                    # a corrupt previous file cannot block a good new one
        if prev_orders and len(orders) < len(prev_orders) * ADCVD_SHRINK_LIMIT:
            return (f"{len(orders)} orders is more than "
                    f"{round((1 - ADCVD_SHRINK_LIMIT) * 100)}% below the current {len(prev_orders)}")
    return None


def prune(releases: Path, active: Path) -> None:
    dirs = sorted((d for d in releases.iterdir() if d.is_dir()), reverse=True)
    for old in dirs[KEEP_RELEASES:]:
        if old.resolve() != active.resolve():
            shutil.rmtree(old, ignore_errors=True)


def main() -> None:
    data = ROOT / "data"
    releases = data / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    release = releases / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    release.mkdir()

    try:
        print(f"HTS schedule      {fetch(HTS_URL, release / 'hts.json'):,} bytes")
        print(f"Chapter 99 notes  {fetch(CH99_URL, release / 'chapter99.pdf'):,} bytes")

        # The U.S. Notes exist only as PDF prose; layout mode preserves the
        # subdivision indentation the scope parser keys on.
        subprocess.run(
            ["pdftotext", "-layout", str(release / "chapter99.pdf"),
             str(release / "chapter99.txt")], check=True)
        # Expired provisions are marked only by yellow shading in the PDF.
        subprocess.run([sys.executable, "-m", "ingest.shading", str(release / "chapter99.pdf"),
                        str(release / "chapter99_expired.json")], check=True, cwd=ROOT)
        # Antidumping/countervailing orders in effect (Federal Register). A failed
        # fetch keeps the last good list rather than dropping the check.
        orders_out, last = release / "adcvd_orders.json", data / "adcvd_orders.json"
        try:
            subprocess.run([sys.executable, "-m", "ingest.adcvd", str(orders_out), str(last)],
                           check=True, cwd=ROOT)
            problem = validate_adcvd(orders_out, last)
            if problem:
                raise RuntimeError(problem)
        except (subprocess.CalledProcessError, RuntimeError) as exc:
            if not last.exists():
                raise
            shutil.copy(last, orders_out)
            reason = "fetch failed" if isinstance(exc, subprocess.CalledProcessError) else str(exc)
            print(f"AD/CVD orders: {reason}, keeping the previous list")
        check_downloads(release)

        # Exits non-zero, publishing nothing, if validation fails.
        subprocess.run([sys.executable, str(ROOT / "ingest" / "build.py"),
                        "--release", str(release)], check=True)
    except BaseException:
        shutil.rmtree(release, ignore_errors=True)
        raise

    prune(releases, release)

    from ingest.fedreg import poll
    asyncio.run(poll(30))
    print("refresh complete")


if __name__ == "__main__":
    main()
