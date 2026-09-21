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


def other232(digits):
    """True when a Section 232 regime other than the metals lists the code."""
    s = E.regimes.s232
    return bool(s.vehicles.pv_parts.covers(digits) or s.vehicles.heavy_parts.covers(digits)
                or s.vehicles.vehicles.covers(digits) or s.wood.softwood.covers(digits)
                or s.wood.upholstered.covers(digits) or s.wood.cabinets.covers(digits)
                or s.unresolved.covers(digits))



def settled(res):
    """Complete as far as duties go: an antidumping order that may apply is a
    separate flag (it depends on the exporter), not a gap in the duty stack."""
    return not res.scope_unverified and set(res.incomplete) <= {"adcvd_possible"}


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
    assert settled(r) and not r.scope_unverified


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


@real("pure code-list exceptions exempt a product; use-based ones (aircraft parts, pharma) only on a stated end use")
def _():
    exc = {h: e.codes for h, e in E.regimes.exceptions.items()}
    def first_code(h):
        return next(l.hts for l in E.tree.leaves
                    if any(l.digits.startswith(p) for p in exc[h])
                    and not other232(l.digits)
                    and not (E.regimes.s232.metals and E.regimes.s232.metals.hits(l.digits)))
    for h in ("9903.05.86", "9903.05.87"):                 # "classifiable in the following"
        code = first_code(h)
        r = quote(code, "Vietnam")
        assert not any("9903.05" in x for x in labels(r)), (h, code, labels(r))
    def note52_state(r):
        return ("charged" if any("9903.05.84" in x for x in labels(r))
                else "flagged" if "9903.05.84" in r.scope_unverified else "excused")
    for h, use, wrong in (("9903.05.88", "civil aircraft", "pharmaceutical"),
                          ("9903.05.89", "pharmaceutical", "civil aircraft")):
        # aircraft parts overlap other Section 232 lists, so they may be flagged
        # rather than charged; what must hold is that only the right use excuses
        code = next(l.hts for l in E.tree.leaves if any(l.digits.startswith(p) for p in exc[h]))
        assert note52_state(E.quote(hts=code, country="Vietnam", value=10000, end_use=use)) == "excused", (h, code)
        assert note52_state(E.quote(hts=code, country="Vietnam", value=10000, end_use=wrong)) != "excused", (h, code)
        assert note52_state(E.quote(hts=code, country="Vietnam", value=10000)) != "excused", (h, code)
    clean = next(l.hts for l in E.tree.leaves if any(l.digits.startswith(p) for p in exc["9903.05.89"])
                 and not other232(l.digits) and not E.regimes.s232.metals.hits(l.digits))
    plain = E.quote(hts=clean, country="Vietnam", value=10000)
    assert any("9903.05.84" in x for x in labels(plain)) and any("end use is claimed" in a for a in plain.assumptions)


@real("an unrecognised end use is refused, never read as none claimed")
def _():
    for bad in ("agriculture", "aricraft?"):
        try:
            E.quote(hts="6109.10.00.12", country="Vietnam", value=1000, end_use=bad)
        except ValueError:
            continue
        raise AssertionError(f"end use {bad!r} was accepted")


@real("Section 232: steel and aluminum mill products, and derivative goods in the metal chapters, are priced")
def _():
    steel = next(l.hts for l in E.tree.leaves if l.hts.startswith("7208.10"))
    r = quote(steel, "Vietnam")
    assert any("9903.82.02" in x for x in labels(r)) and not any("9903.05" in x for x in labels(r)), labels(r)
    assert settled(r), (r.scope_unverified, r.incomplete)
    assert any("ordinary rate is assumed" in a for a in r.assumptions), r.assumptions
    kettle = next(l.hts for l in E.tree.leaves if l.hts.startswith("7323.93"))
    r = quote(kettle, "China")
    assert any("9903.82.09" in x for x in labels(r)) and not any("9903.05.31" in x for x in labels(r)), labels(r)
    assert settled(r), (r.scope_unverified, r.incomplete)


def _hinge():
    """A derivative-metal code outside chapters 72-76 that no other 232 regime claims."""
    return next(l.hts for l in E.tree.leaves
                if E.regimes.s232.metals.hits(l.digits) and l.digits[:2] not in ("72", "73", "74", "76")
                and not other232(l.digits)
                and not E.regimes.exceptions["9903.05.86"].codes & {l.digits[:n] for n in (4, 6, 8, 10)}
                and not E.regimes._exception_domains["9903.05.88"].covers(l.digits)
                and not E.regimes._exception_domains["9903.05.89"].covers(l.digits))


@real("Section 232: derivative goods outside the metal chapters wait for the metal weight, then price by it")
def _():
    hinge = _hinge()
    no_weight = quote(hinge, "China")
    assert no_weight.scope_unverified and no_weight.as_dict()["complete"] is False, no_weight.scope_unverified
    light = E.quote(hts=hinge, country="China", value=10000, metal_weight_pct=10)
    assert not any("9903.82" in x for x in labels(light)) and any("9903.05.31" in x for x in labels(light)), labels(light)
    heavy = E.quote(hts=hinge, country="China", value=10000, metal_weight_pct=60)
    assert any("9903.82" in x for x in labels(heavy)) and not any("9903.05.31" in x for x in labels(heavy)), labels(heavy)
    at15 = E.quote(hts=hinge, country="China", value=10000, metal_weight_pct=15)
    assert at15.total_duty == heavy.total_duty, "15% is 'at least 15 percent'"


@real("Section 232: a code on both a metals list and a vehicle-parts list stays flagged (whether it is a vehicle part is a fact)")
def _():
    both = next(l.hts for l in E.tree.leaves
                if E.regimes.s232.metals.hits(l.digits) and other232(l.digits)
                and l.digits[:2] in ("73", "74", "76", "72"))
    r = quote(both, "Vietnam")
    assert r.scope_unverified and r.as_dict()["complete"] is False, (both, r.scope_unverified)


@real("Section 232 vehicles and other regimes stay flagged: the engine cannot tell which regime takes them")
def _():
    for code, origin in (("8703.23.01.90", "Vietnam"), ("8704.21.01.10", "Vietnam")):
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


@real("Section 232 wood: upholstered furniture and softwood lumber are priced; the EU, Japan and other deal origins stay flagged")
def _():
    w = E.regimes.s232.wood
    chair = next(l.hts for l in E.tree.leaves if w.upholstered.covers(l.digits))
    r = quote(chair, "Vietnam")
    assert any("9903.76.02" in x for x in labels(r)) and not any("9903.05.84" in x for x in labels(r)), labels(r)
    assert settled(r), (r.scope_unverified, r.incomplete)
    for origin, heading in (("Germany", "9903.76.22"), ("Japan", "9903.76.21"), ("South Korea", "9903.76.23"),
                            ("Taiwan", "9903.76.24")):
        d = quote(chair, origin)
        assert any(heading in x for x in labels(d)) and not any("9903.76.02" in x for x in labels(d)), (origin, labels(d))
        assert str(d.components[0].amount) == "1500.00" and settled(d), (origin, d.components)
    uk = quote(chair, "United Kingdom")
    assert any("9903.76.20" in x for x in labels(uk)) and next(
        c.amount for c in uk.components if "9903.76.20" in c.label) == 1000, labels(uk)
    lumber = next(l.hts for l in E.tree.leaves if w.softwood.covers(l.digits))
    r = quote(lumber, "Canada")
    assert any("9903.76.01" in x for x in labels(r)), labels(r)
    cab = next(l.hts for l in E.tree.leaves if w.cabinets.covers(l.digits))
    r = quote(cab, "Vietnam")
    assert any("9903.76.03" in x for x in labels(r)) and any("kitchen cabinets" in a for a in r.assumptions), (labels(r), r.assumptions)


@real("Section 232 vehicle parts: the importer's stated use decides, and without it the quote is flagged")
def _():
    v = E.regimes.s232.vehicles
    code = next(l.hts for l in E.tree.leaves
                if v.pv_parts.covers(l.digits) and not v.heavy_parts.covers(l.digits)
                and not v.vehicles.covers(l.digits) and not E.regimes.s232.metals.hits(l.digits)
                and not E.regimes.s232.unresolved.covers(l.digits))
    unstated = quote(code, "China")
    assert "9903.94.05" in unstated.scope_unverified and unstated.as_dict()["complete"] is False
    car = E.quote(hts=code, country="China", value=10000, vehicle_use="passenger")
    assert any("9903.94.05" in x for x in labels(car)) and not any("9903.05.31" in x for x in labels(car)), labels(car)
    assert settled(car), (car.scope_unverified, car.incomplete)
    other = E.quote(hts=code, country="China", value=10000, vehicle_use="none")
    assert any("9903.05.31" in x for x in labels(other)) and not any("9903.94" in x for x in labels(other)), labels(other)
    heavy = E.quote(hts=code, country="China", value=10000, vehicle_use="heavy")
    assert not any("9903.94" in x for x in labels(heavy)), "a code not on the heavy-duty list was charged as a heavy part"
    uk = E.quote(hts=code, country="United Kingdom", value=10000, vehicle_use="passenger")
    assert uk.scope_unverified and not any("9903.94.05" in x for x in labels(uk)), "the U.K. was priced at the ordinary 25%"
    mx = E.quote(hts=code, country="Mexico", value=10000, vehicle_use="passenger", preference_program="S")
    assert not any("9903.94.05" in x for x in labels(mx)), labels(mx)


@real("Section 232 vehicle parts, deal origins: the EU, Japan, Korea and Taiwan top the total up to exactly 15%")
def _():
    v = E.regimes.s232.vehicles
    code = next(l.hts for l in E.tree.leaves
                if v.pv_parts.covers(l.digits) and not v.heavy_parts.covers(l.digits)
                and not v.vehicles.covers(l.digits)
                and "%" in E.tree.effective_rate_cell(l.hts, "general")[0]
                and 0 < float(E.tree.effective_rate_cell(l.hts, "general")[0].rstrip("%")) < 15)
    mfn = float(E.tree.effective_rate_cell(code, "general")[0].rstrip("%"))
    for origin in ("Germany", "France", "Japan", "South Korea", "Taiwan"):
        r = E.quote(hts=code, country=origin, value=10000, vehicle_use="passenger")
        assert settled(r), (origin, r.scope_unverified, r.incomplete)
        parts = [c for c in r.components if "9903.94" in c.label]
        assert len(parts) == 1 and "tops the duty up to 15%" in parts[0].label, (origin, [c.label for c in r.components])
        assert float(next(c.amount for c in r.components if c.label.startswith("MFN")) + parts[0].amount) == 1500.0, (origin, mfn)
        assert not any("9903.05" in c.label for c in r.components), origin


@real("an unrecognised vehicle use is refused")
def _():
    for bad in ("boat", "spaceship"):
        try:
            E.quote(hts="6109.10.00.12", country="China", value=1000, vehicle_use=bad)
        except ValueError:
            continue
        raise AssertionError(f"vehicle use {bad!r} was accepted")


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
