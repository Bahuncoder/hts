"""Chapter 99 regime resolution: what is charged, what is exempt, what is unknown.

These run against the real schedule (skipped when data/ is absent) because the
point is the schedule's own text: which headings apply to a code, which are
exempt, and which the engine cannot decide. Every "unknown" case matters as
much as every "applies" case: an unknown must stay flagged, never quietly
become zero or a charge.
"""
from __future__ import annotations

import sys
import traceback
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core.ch99 import parse_countries  # noqa: E402
from core.regimes import (Domain, RegimeIndex, _codes_in, build_index,  # noqa: E402
                          note_refs)

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


# ------------------------------------------------------------ pure unit tests

@check("countries: 'the' prefixes, non-ASCII names and EU member states parse")
def _():
    assert parse_countries("articles the product of the Bahamas, as provided") == ["Bahamas"]
    assert parse_countries("articles the product of Türkiye, as provided") == ["Türkiye"]
    assert parse_countries("the product of the United Arab Emirates, as") == ["United Arab Emirates"]
    eu = parse_countries("articles the product of a member state of the European Union")
    assert "Germany" in eu and "France" in eu and len(eu) == 27, eu
    assert "Germany" in parse_countries("articles the product of the European Union"), "EU expands"


@check("notes: references to general notes and other chapters' notes are ignored")
def _():
    assert note_refs("as provided for in subdivision (b) of U.S. note 52 to this subchapter") == [52]
    assert note_refs("specified in note 17(i) to this subchapter") == [17]
    assert note_refs("under general note 3(c)(i) to the tariff schedule") == []
    assert note_refs("Additional U.S. Note 3(b) to chapter 2 of the HTSUS") == []


@check("domains: prefixes at every level are recognised, chapter 98/99 references are not")
def _():
    got = _codes_in("provided for in heading 8542 and subheadings 8541.10, 8471.30.01 and 9802.00.60")
    assert {"8542", "854110", "84713001"} <= got, got
    assert not any(c.startswith(("98", "99")) for c in got), got
    d = Domain(frozenset({"8542", "854110", "84713001"}))
    assert d.covers("8542310000") and d.covers("8541100050") and d.covers("8471300100")
    assert not d.covers("6109100012")


@check("domains: an empty domain is 'unknown', not 'nothing'")
def _():
    assert not Domain()


# ------------------------------------------------------- real-schedule tests

HTS, NOTES = ROOT / "data" / "hts_2026.json", ROOT / "data" / "chapter99.txt"
if not (HTS.exists() and NOTES.exists()):
    print("real-schedule tests skipped: data/ files are not present")
    E = None
else:
    from core.engine import TariffEngine
    E = TariffEngine(str(HTS), str(NOTES))


def quote(code, origin, value=10000):
    return E.quote(hts=code, country=origin, value=value)


def labels(res):
    return [c.label for c in res.components]


def real(name):
    def wrap(fn):
        if E is None:
            return fn
        return check(name)(fn)
    return wrap


@real("China apparel: the note-52 duty applies, stacks with Section 301, and the quote is complete")
def _():
    r = quote("6109.10.00.12", "China")
    assert any("9903.05.31" in x for x in labels(r)), labels(r)
    assert any("9903.88.15" in x for x in labels(r)), labels(r)
    assert str(r.total_duty) == "3697.14", r.total_duty       # 16.5 + 12.5 + 7.5 % + fees
    assert r.as_dict()["complete"] is True and not r.scope_unverified


@real("the assumption behind a resolved country-wide duty is stated, entry-specific exceptions included")
def _():
    text = " ".join(quote("6109.10.00.12", "China").assumptions)
    assert "note 52" in text and "no entry-specific exemption" in text, text


@real("origin, not a whitelist: Vietnam, India, Philippines and the Bahamas each get their own rate")
def _():
    for origin, rate in (("Vietnam", "12.5"), ("India", "10.0"), ("Philippines", "12.5"),
                         ("Bahamas", "12.5"), ("Türkiye", "12.5"), ("UAE", "12.5")):
        r = quote("6109.10.00.12", origin)
        got = [str(c.rate_pct) for c in r.components if "9903.05" in c.label]
        assert got == [rate], (origin, got)


@real("pure code-list exceptions exempt a product; use-based ones (aircraft parts, pharma) never do")
def _():
    exc = {h: e.codes for h, e in E.regimes.exceptions.items()}
    def first_code(h):
        return next(l.hts for l in E.tree.leaves
                    if any(l.digits.startswith(p) for p in sorted(exc[h])[:300]))
    for h in ("9903.05.86", "9903.05.87"):                 # "classifiable in the following"
        code = first_code(h)
        r = quote(code, "Vietnam")
        assert not any("9903.05" in x for x in labels(r)), (h, code, labels(r))
    for h in ("9903.05.88", "9903.05.89"):                 # ...that are for aircraft / pharmaceutical use
        code = first_code(h)
        r = quote(code, "Vietnam")
        assert r.scope_unverified and not any("9903.05.84" in x for x in labels(r)), (
            h, code, "a code on a use-based list was treated as exempt or as plainly charged")


@real("Section 232 metals and vehicles stay flagged: the engine cannot tell which regime takes them")
def _():
    for code, origin in (("7318.15.20.00", "China"), ("8703.23.01.90", "Vietnam"),
                         ("7601.10.30.00", "India")):
        code = next((l.hts for l in E.tree.leaves if l.hts.startswith(code[:7])), code)
        r = quote(code, origin)
        assert r.scope_unverified, (code, origin, "was quoted as complete")
        assert r.as_dict()["complete"] is False


@real("a country-wide duty is never applied when its exception lists are missing (fail closed)")
def _():
    import dataclasses
    saved = dict(E.regimes.exceptions)
    try:
        E.regimes.exceptions = {h: dataclasses.replace(e, codes=frozenset())
                                for h, e in saved.items()}
        E.regimes.finish()
        r = quote("6109.10.00.12", "China")
        assert not any("9903.05.31" in x for x in labels(r)), "applied without evidence"
        assert r.scope_unverified and r.as_dict()["complete"] is False
    finally:
        E.regimes.exceptions = saved
        E.regimes.finish()


@real("each note-52 exception excuses only the headings it names, and its list is its own")
def _():
    ex = E.regimes.exceptions
    assert ex["9903.05.96"].targets == (("9903.05.81", "9903.05.81"),)          # United Kingdom
    assert ex["9903.05.97"].targets == (("9903.05.38", "9903.05.39"),)          # European Union
    assert ex["9903.06.14"].targets == (("9903.05.75", "9903.05.76"),)          # Taiwan
    uk, eu, ch = ex["9903.05.96"].codes, ex["9903.05.97"].codes, ex["9903.05.98"].codes
    # The lists used to run together: the UK's absorbed the EU's and Switzerland's.
    assert "45011000" in eu and "45011000" not in uk, "EU list leaked into the UK's"
    assert "04101000" in ch and "04101000" not in eu
    assert ex["9903.05.93"].claim == "USMCA" and ex["9903.06.06"].claim == "CAFTA-DR"


@real("a country's list excepts that country only: a UK-listed code is exempt for the UK, charged for Vietnam")
def _():
    dom = E.regimes._exception_domains["9903.05.96"]
    code = next(l.hts for l in E.tree.leaves
                if dom.covers(l.digits) and not E.regimes.domain_232.covers(l.digits))
    uk = quote(code, "United Kingdom")
    assert not any("9903.05" in x for x in labels(uk)), labels(uk)
    other = quote("6109.10.00.12", "United Kingdom")           # not on the list
    assert any("9903.05.81" in x for x in labels(other)), labels(other)


@real("USMCA: Canada and Mexico owe the note-52 duty unless free treatment is claimed, and the quote says which")
def _():
    for origin, heading in (("Canada", "9903.05.29"), ("Mexico", "9903.05.55")):
        plain = E.quote(hts="6109.10.00.12", country=origin, value=10000)
        assert any(heading in x for x in labels(plain)), (origin, labels(plain))
        assert any("No USMCA claim" in a or "no USMCA claim" in a for a in plain.assumptions), plain.assumptions
        claimed = E.quote(hts="6109.10.00.12", country=origin, value=10000, preference_program="S")
        assert not any(heading in x for x in labels(claimed)), (origin, labels(claimed))
        assert any("USMCA" in a and "assumed to qualify" in a for a in claimed.assumptions), claimed.assumptions


@real("CAFTA-DR: a claim for a code on the country's list excuses the duty; no claim does not")
def _():
    dom = E.regimes._exception_domains["9903.06.06"]
    code = next(l.hts for l in E.tree.leaves
                if dom.covers(l.digits) and not E.regimes.domain_232.covers(l.digits)
                and E.tree.effective_rate_cell(l.hts, "special")[0]
                and "P" in E.tree.effective_rate_cell(l.hts, "special")[0])
    plain = E.quote(hts=code, country="Guatemala", value=10000)
    assert any("9903.05.40" in x for x in labels(plain)), labels(plain)
    claimed = E.quote(hts=code, country="Guatemala", value=10000, preference_program="P")
    assert not any("9903.05.40" in x for x in labels(claimed)), labels(claimed)


@real("silent omission is closed: Section 232 wood, furniture and cabinets are flagged, not dropped")
def _():
    code = next(l.hts for l in E.tree.leaves if l.hts.startswith("9401.61.40"))
    r = quote(code, "Vietnam")
    assert r.scope_unverified or any("9903.76" in x for x in labels(r)), (
        "upholstered wooden furniture came back complete with no wood tariff", labels(r))


@real("provisions the schedule itself records as expired are not flagged on every quote")
def _():
    ix = E.regimes
    for h in ("9903.45.01", "9903.45.06", "9903.45.22"):
        assert h in ix.expired, h
    r = quote("6109.10.00.12", "China")
    assert not set(r.scope_unverified) & {"9903.45.01", "9903.45.02", "9903.45.06"}, r.scope_unverified


@real("the Section 122 surcharge is skipped after its stated expiry, and applied before it")
def _():
    after = build_index(E.ch99, E.scopes, open(NOTES, errors="ignore").read(), {}, as_of=date(2026, 9, 20))
    before = build_index(E.ch99, E.scopes, open(NOTES, errors="ignore").read(), {}, as_of=date(2026, 6, 1))
    assert "9903.03.01" in after.expired and "9903.03.01" not in before.expired


@real("a compiler's note that suspends a group suspends its members (Germany 25% aircraft-dispute lines)")
def _():
    by = {r.hts: r for r in E.ch99}
    for h in ("9903.89.13", "9903.89.37"):
        assert by[h].suspended and "suspended" in by[h].suspension_note.lower(), h
    assert "9903.89.13" not in quote("6109.10.00.12", "Germany").scope_unverified


@real("IEEPA headings that cannot be scoped affect the refund estimate, not the amount owed")
def _():
    r = quote("6109.10.00.12", "Canada")
    assert all(not h.startswith("9903.01") for h in r.scope_unverified), r.scope_unverified


@real("resolution is fast enough for a 1,000-line audit (quotes under 20 ms)")
def _():
    import time
    codes = [l.hts for l in E.tree.leaves][:300]
    t = time.time()
    for c in codes:
        quote(c, "China")
    per = (time.time() - t) / len(codes)
    assert per < 0.02, f"{per * 1000:.1f} ms per quote"


def main() -> int:
    width = max(len(n) for n, _, _ in _results)
    failed = 0
    for name, status, detail in _results:
        print(f"  {'ok  ' if status == 'pass' else 'FAIL'}  {name.ljust(width)}")
        if status != "pass":
            failed += 1
            print(f"        {detail.splitlines()[-1][:190]}")
    print(f"\n{len(_results) - failed}/{len(_results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
