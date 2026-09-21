"""Which Chapter 99 provisions the schedule itself marks as expired.

The USITC publication shades an expired provision's row yellow and says so in a
footnote ("The shaded areas indicate the provision has expired"). That is the
only place many old provisions are marked: the JSON feed and the extracted text
carry no trace of it, so a 1987 sanction still reads as a live duty. This
module reads the shading from the PDF: it finds each heading number's position
with pdftotext, renders the page, and checks whether the number's cell is
yellow.

Needs poppler (pdftotext, pdftoppm) and Pillow. Run by the refresh pipeline
after the PDF is fetched; the result is stored beside the extracted notes.

    python3 -m ingest.shading data/chapter99.pdf data/chapter99_expired.json
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

HEADING = re.compile(r"^9903\.\d{2}\.\d{2}$")
_WORD = re.compile(
    r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]+)</word>')
# Shaded fraction of the heading cell above which the row counts as expired.
SHADED_FRACTION = 0.3


def _pages_with_headings(pdf: str) -> list[int]:
    text = subprocess.run(["pdftotext", "-layout", pdf, "-"], capture_output=True,
                          text=True, errors="ignore", check=True).stdout
    line = re.compile(r"^\s*9903\.\d{2}\.\d{2}\b", re.M)
    return [i for i, page in enumerate(text.split("\f"), 1) if line.search(page)]


def _is_yellow(px: tuple[int, int, int]) -> bool:
    r, g, b = px[:3]
    return r > 225 and g > 225 and b < 140


def page_headings(pdf: str, page: int) -> dict[str, bool]:
    """heading -> shaded, for every heading number in the first column of a page."""
    boxes = subprocess.run(
        ["pdftotext", "-f", str(page), "-l", str(page), "-bbox", pdf, "-"],
        capture_output=True, text=True, errors="ignore", check=True).stdout
    with tempfile.TemporaryDirectory() as tmp:
        root = str(Path(tmp) / "page")
        subprocess.run(["pdftoppm", "-f", str(page), "-l", str(page), "-r", "72", "-png",
                        "-singlefile", pdf, root], capture_output=True, check=True)
        img = Image.open(root + ".png").convert("RGB")
    out: dict[str, bool] = {}
    for m in _WORD.finditer(boxes):
        x0, y0, x1, y1, word = float(m[1]), float(m[2]), float(m[3]), float(m[4]), m[5]
        if not HEADING.match(word) or x0 > 130:
            continue
        pts = [(x, y) for x in range(int(x0), int(x1) + 1)
               for y in range(int(y0) + 1, int(y1))
               if 0 <= x < img.width and 0 <= y < img.height]
        if not pts:
            continue
        yellow = sum(_is_yellow(img.getpixel(p)) for p in pts)
        out[word] = yellow / len(pts) >= SHADED_FRACTION
    return out


def expired_headings(pdf: str) -> dict[str, bool]:
    result: dict[str, bool] = {}
    for page in _pages_with_headings(pdf):
        for heading, shaded in page_headings(pdf, page).items():
            result[heading] = result.get(heading, False) or shaded
    return result


def main(argv: list[str]) -> int:
    pdf, out = argv[1], argv[2]
    found = expired_headings(pdf)
    expired = sorted(h for h, s in found.items() if s)
    Path(out).write_text(json.dumps(
        {"source": Path(pdf).name, "headings_checked": len(found), "expired": expired},
        indent=1) + "\n")
    print(f"{len(found)} headings checked, {len(expired)} shaded (expired)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
