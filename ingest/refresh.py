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
