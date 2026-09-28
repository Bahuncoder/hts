"""Chapter 99 U.S. Notes extraction: binding a remedy heading to the product
codes and exclusions its note enumerates from PDF-extracted prose.

Self-contained (no pytest, no data/ dependency -- these are pure regex/text
functions). Run: python3 tests/test_notes.py
"""
from __future__ import annotations

import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ingest.notes import EXCLUSION_REF, extract  # noqa: E402

_results: list[tuple[str, str, str]] = []


def check(name):
    def wrap(fn):
        try:
            fn()
            _results.append((name, "pass", ""))
        except AssertionError as exc:
            _results.append((name, "FAIL", str(exc) or "assertion failed"))
        except Exception:
            _results.append((name, "ERROR", traceback.format_exc(limit=3).strip()))
        return fn
    return wrap


@check("EXCLUSION_REF: a dotted HTS code after 'granted an exclusion' is captured, not truncated before its first dot")
def _():
    text = ("Products previously granted an exclusion from the additional duties "
            "imposed by heading 9903.88.01 shall not be subject to the additional "
            "duties described in this subdivision. The following list applies.")
    m = EXCLUSION_REF.search(text)
    assert m, "no match at all"
    assert "9903.88.01" in m.group(0), m.group(0)


@check("EXCLUSION_REF: stops at the real sentence end, not mid-code, so a later sentence's own codes are not swept in")
def _():
    text = ("granted an exclusion under heading 9903.88.01 does not apply here. "
            "Heading 9903.88.15 applies to products classified in 8471.30.01.")
    m = EXCLUSION_REF.search(text)
    assert "8471.30.01" not in m.group(0), (
        "the match ran into the next sentence's own scope codes: " + m.group(0))


@check("extract: a subdivision's exclusion reference is recorded on excluded_by, and its code does not become the subdivision's own scope")
def _():
    raw = (
        "\n  (a)  Heading 9903.88.01 applies to all products of China that are "
        "classified in the following 8-digit subheadings, except for products "
        "previously granted an exclusion from the additional duties imposed by "
        "heading 9903.88.15, which shall not be subject to the duties described "
        "in this subdivision:\n"
        "8471.30.01\n"
        "8471.41.01\n"
        "\n  (b)  Heading 9903.88.15 applies to a different list.\n"
        "8517.62.00\n"
    )
    scopes = extract(raw)
    assert "9903.88.01" in scopes, scopes.keys()
    sc = scopes["9903.88.01"]
    assert sc.excluded_by == ["9903.88.15"], sc.excluded_by
    assert "8471.30.01" in sc.codes, sc.codes


def main() -> int:
    width = max(len(n) for n, _, _ in _results)
    failed = 0
    for name, status, detail in _results:
        print(f"  {'ok  ' if status == 'pass' else 'FAIL'}  {name.ljust(width)}")
        if status != "pass":
            failed += 1
            print(f"        {detail.splitlines()[-1][:200]}")
    print(f"\n{len(_results) - failed}/{len(_results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
