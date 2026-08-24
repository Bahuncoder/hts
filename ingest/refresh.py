"""Daily data refresh.

The HTS is reissued through the year, Chapter 99 changes with every trade
action, and the Federal Register moves daily. This pulls all three and rebuilds
the reference database. Ruling ingest is incremental and run separately, since
the corpus only grows at the margin.
"""
from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

HTS_URL = ("https://hts.usitc.gov/reststop/exportList"
           "?from=0100&to=9999&format=JSON&styles=false")
CH99_URL = ("https://hts.usitc.gov/reststop/file"
            "?release=currentRelease&filename=Chapter%2099")


def fetch(url: str, dest: Path) -> int:
    with httpx.stream("GET", url, timeout=300, follow_redirects=True) as r:
        r.raise_for_status()
        tmp = dest.with_suffix(dest.suffix + ".tmp")
        with tmp.open("wb") as fh:
            for chunk in r.iter_bytes():
                fh.write(chunk)
        tmp.replace(dest)
    return dest.stat().st_size


def main() -> None:
    data = ROOT / "data"
    data.mkdir(exist_ok=True)

    print(f"HTS schedule      {fetch(HTS_URL, data / 'hts_2026.json'):,} bytes")
    print(f"Chapter 99 notes  {fetch(CH99_URL, data / 'chapter99.pdf'):,} bytes")

    # The U.S. Notes exist only as PDF prose; layout mode preserves the
    # subdivision indentation the scope parser keys on.
    subprocess.run(
        ["pdftotext", "-layout", str(data / "chapter99.pdf"), str(data / "chapter99.txt")],
        check=True)

    subprocess.run([sys.executable, str(ROOT / "ingest" / "build.py")], check=True)

    from ingest.fedreg import poll
    asyncio.run(poll(30))
    print("refresh complete")


if __name__ == "__main__":
    main()
