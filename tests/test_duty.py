"""Unit tests for the duty engine.

This module decides what a customer is told they owe, so its arithmetic and
its refusals both matter. The refusals matter more: applying a trade remedy
whose product scope is unknown is how a tool reports a four-figure duty rate
on ordinary goods, and quietly charging for a tariff the Supreme Court struck
down is how it reports money owed that is actually money recoverable.

Self-contained: pytest is not installable in this environment.
"""
from __future__ import annotations

import sys
import traceback
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.ch99 import Ch99Rule, Effect
from core.countries import UnknownCountry, country_code, require_country
from core.duty import (HMF_RATE, MPF_MAX, MPF_MIN, MPF_RATE, applicable_ch99,
                       compute, entry_mpf, parse_base_rate, parse_rate,
                       parse_special, select_preference)

_results: list[tuple[str, str, str]] = []


def check(name: str):
    def wrap(fn):
        try:
            fn()
            _results.append((name, "pass", ""))
        except AssertionError as exc:
            _results.append((name, "FAIL", str(exc) or "assertion failed"))
        except Exception:
            _results.append((name, "ERROR", traceback.format_exc(limit=2).strip()))
        return fn
    return wrap


def component(res, fragment: str):
    for c in res.components:
        if fragment.lower() in c.label.lower():
            return c
    return None


def rule(hts, effect=Effect.ADD, rate=None, countries=(), refs=(),
         excepts=(), suspended=False):
    return Ch99Rule(hts=hts, effect=effect, rate_pct=rate,
                    countries=list(countries), base_refs=list(refs),
                    excepts=list(excepts), suspended=suspended,
                    raw_rate=f"+{rate}%" if rate else "")


# --------------------------------------------------------------- rate parsing

@check("parse: 'Free' is zero, not unparseable")
def _():
    pct, spec = parse_base_rate("Free")
    assert pct == Decimal("0") and spec is None, (pct, spec)


@check("parse: empty cell is zero")
def _():
    assert parse_base_rate("")[0] == Decimal("0")


@check("parse: ad valorem percentage")
def _():
    assert parse_base_rate("16.5%")[0] == Decimal("16.5")


@check("parse: compound duty flags the specific part")
def _():
    pct, spec = parse_base_rate("5.5% + 12 cents/kg")
    assert pct == Decimal("5.5"), pct
    assert spec is not None, "specific duty must be surfaced, not silently dropped"


@check("parse: unparseable cell returns None so the caller can warn")
def _():
    pct, spec = parse_base_rate("See heading 9902")
    assert pct is None and spec == "See heading 9902", (pct, spec)


# ------------------------------------------------------------------ user fees

@check("MPF: floored at the statutory minimum on small entries")
def _():
    res = compute(hts="6109.10.00.12", country="Vietnam", entered_value=100,
                  base_rate_cell="Free")
    assert component(res, "Merchandise").amount == MPF_MIN, component(res, "Merchandise").amount


@check("MPF: capped at the statutory maximum on large entries")
def _():
    res = compute(hts="6109.10.00.12", country="Vietnam", entered_value=10_000_000,
                  base_rate_cell="Free")
    assert component(res, "Merchandise").amount == MPF_MAX, component(res, "Merchandise").amount


@check("MPF: ad valorem between the floor and the cap")
def _():
    res = compute(hts="6109.10.00.12", country="Vietnam", entered_value=50_000,
                  base_rate_cell="Free")
    assert component(res, "Merchandise").amount == (Decimal("50000") * MPF_RATE).quantize(Decimal("0.01"))


@check("HMF: charged on vessel entries")
def _():
    res = compute(hts="6109.10.00.12", country="Vietnam", entered_value=50_000,
                  base_rate_cell="Free", by_vessel=True)
    assert component(res, "Harbor").amount == (Decimal("50000") * HMF_RATE).quantize(Decimal("0.01"))


@check("HMF: not charged on air entries")
def _():
    res = compute(hts="6109.10.00.12", country="Vietnam", entered_value=50_000,
                  base_rate_cell="Free", by_vessel=False)
    assert component(res, "Harbor") is None, "HMF applies to vessel cargo only"


@check("MPF: omitted on informal entries")
def _():
    res = compute(hts="6109.10.00.12", country="Vietnam", entered_value=500,
                  base_rate_cell="Free", is_formal_entry=False)
    assert component(res, "Merchandise") is None


# ----------------------------------------------------------------- base rates

@check("Column 2 rate applies to sanctioned origins")
def _():
    res = compute(hts="6109.10.00.12", country="North Korea", entered_value=10_000,
                  base_rate_cell="16.5%", column2_rate_cell="90%")
    c = component(res, "Column 2")
    assert c is not None and c.rate_pct == Decimal("90"), res.components


@check("Column 1 General applies to ordinary origins")
def _():
    res = compute(hts="6109.10.00.12", country="Vietnam", entered_value=10_000,
                  base_rate_cell="16.5%", column2_rate_cell="90%")
    assert component(res, "MFN").rate_pct == Decimal("16.5")


@check("FTA special rate applies only when claimed")
def _():
    kw = dict(hts="6109.10.00.12", country="Mexico", entered_value=10_000,
              base_rate_cell="16.5%", special_rate_cell="Free")
    assert component(compute(**kw, fta_claimed=False), "MFN").rate_pct == Decimal("16.5")
    assert component(compute(**kw, fta_claimed=True), "FTA").rate_pct == Decimal("0")


# ------------------------------------------------------------ chapter 99 scope

@check("Ch99: a rule matching country and product is applied")
def _():
    res = compute(hts="6109.10.00.12", country="China", entered_value=10_000,
                  base_rate_cell="16.5%",
                  ch99_rules=[rule("9903.88.15", rate=7.5, countries=["China"],
                                   refs=["6109.10.00"])])
    c = component(res, "9903.88.15")
    assert c is not None and c.amount == Decimal("750.00"), res.components


@check("Ch99: a rule for another country is not applied")
def _():
    res = compute(hts="6109.10.00.12", country="Vietnam", entered_value=10_000,
                  base_rate_cell="16.5%",
                  ch99_rules=[rule("9903.88.15", rate=7.5, countries=["China"],
                                   refs=["6109.10.00"])])
    assert component(res, "9903.88.15") is None


@check("Ch99: suspended headings are skipped entirely")
def _():
    res = compute(hts="6109.10.00.12", country="China", entered_value=10_000,
                  base_rate_cell="16.5%",
                  ch99_rules=[rule("9903.88.16", rate=15, countries=["China"],
                                   refs=["6109.10.00"], suspended=True)])
    assert component(res, "9903.88.16") is None, "a suspended tariff must not be charged"


@check("Ch99: containment is directional, not merely same-heading")
def _():
    # 8471.49.10 shares heading 8471 with 8471.30.01.00 but does not cover it.
    applied, _ = applicable_ch99(
        [rule("9903.88.01", rate=25, countries=["China"], refs=["8471.49.10"])],
        "8471.30.01.00", "China")
    assert applied == [], "a sibling subheading must not be treated as coverage"


@check("Ch99: an unscoped rule is withheld and flagged, never applied")
def _():
    res = compute(hts="6109.10.00.12", country="China", entered_value=10_000,
                  base_rate_cell="16.5%",
                  ch99_rules=[rule("9903.94.01", rate=25, countries=["China"])])
    assert component(res, "9903.94.01") is None, "scope is unknown; charging it invents duty"
    assert "9903.94.01" in res.scope_unverified
    assert res.warnings, "the omission must be disclosed"


@check("Ch99: REPLACE supersedes the base rate rather than stacking")
def _():
    res = compute(hts="7208.10.15.00", country="China", entered_value=10_000,
                  base_rate_cell="10%",
                  ch99_rules=[rule("9903.81.90", effect=Effect.REPLACE, rate=50,
                                   countries=["China"], refs=["7208.10.15"])])
    assert component(res, "MFN") is None, "base rate must be displaced"
    c = component(res, "9903.81.90")
    assert c.rate_pct == Decimal("50") and c.amount == Decimal("5000.00")


@check("Ch99: PASSTHROUGH exemption cancels the ADD it excepts")
def _():
    res = compute(hts="6109.10.00.12", country="China", entered_value=10_000,
                  base_rate_cell="16.5%",
                  ch99_rules=[
                      rule("9903.88.15", rate=7.5, countries=["China"],
                           refs=["6109.10.00"], excepts=["9903.88.67"]),
                      rule("9903.88.67", effect=Effect.PASSTHROUGH,
                           countries=["China"], refs=["6109.10.00"]),
                  ])
    assert component(res, "9903.88.15") is None, "an exclusion must remove the duty"


# ------------------------------------------------------------------- IEEPA

@check("IEEPA: reported as refundable, not charged as duty owed")
def _():
    res = compute(hts="6109.10.00.12", country="China", entered_value=10_000,
                  base_rate_cell="16.5%",
                  ch99_rules=[rule("9903.01.24", rate=20, countries=["China"],
                                   refs=["6109.10.00"])])
    assert component(res, "9903.01.24") is None, "struck-down duty is not owed"
    assert res.refundable_amount == Decimal("2000.00"), res.refundable_amount
    assert res.total_duty == Decimal("1650.00") + Decimal("34.64") + Decimal("12.50"), res.total_duty


# -------------------------------------------------------------------- totals

@check("totals: duty, effective rate and landed cost agree")
def _():
    res = compute(hts="6109.10.00.12", country="China", entered_value=10_000,
                  base_rate_cell="16.5%",
                  ch99_rules=[rule("9903.88.15", rate=7.5, countries=["China"],
                                   refs=["6109.10.00"])])
    expected = Decimal("1650.00") + Decimal("750.00") + Decimal("34.64") + Decimal("12.50")
    assert res.total_duty == expected, (res.total_duty, expected)
    assert res.landed_cost == Decimal("10000") + expected
    assert res.effective_rate_pct == (expected / Decimal("10000") * 100).quantize(Decimal("0.01"))


@check("totals: refundable duty is excluded from the effective rate")
def _():
    res = compute(hts="6109.10.00.12", country="China", entered_value=10_000,
                  base_rate_cell="Free",
                  ch99_rules=[rule("9903.01.24", rate=20, countries=["China"],
                                   refs=["6109.10.00"])])
    assert res.effective_rate_pct < Decimal("1"), res.effective_rate_pct


@check("rounding: money is quantised to cents")
def _():
    res = compute(hts="6109.10.00.12", country="Vietnam", entered_value="1234.567",
                  base_rate_cell="7.3%")
    for c in res.components:
        assert c.amount == c.amount.quantize(Decimal("0.01")), c


# ------------------------------------------- typed rate grammar (audit #5)

@check("rate: '$1/kg + 5%' keeps the specific part instead of dropping it")
def _():
    r = parse_rate("$1/kg + 5%")
    assert r.pct == Decimal("5") and r.specific == ("$1/kg",) and not r.unparsed, r


@check("rate: cents-per-unit forms are all recognised as specific")
def _():
    for cell in ("0.5¢/kg", "12 cents/kg", "$1.20/doz.", "3.4¢/liter", "1.9¢/kg + 5%"):
        assert parse_rate(cell).specific, cell


@check("rate: mixed fractions such as '2 1/2%' are read as 2.5")
def _():
    assert parse_rate("2 1/2%").pct == Decimal("2.5")


@check("rate: prose is unparsed, never silently zero")
def _():
    r = parse_rate("The rate applicable to the natural juice in heading 2009")
    assert r.unparsed, r


@check("compute: a quantity-based duty makes the total explicitly incomplete")
def _():
    res = compute(hts="0402.10.10.00", country="Vietnam", entered_value=1000,
                  base_rate_cell="$1/kg + 5%")
    assert "specific_duty_omitted" in res.incomplete, res.incomplete
    assert res.as_dict()["complete"] is False
    assert any("NOT included" in w for w in res.warnings), res.warnings


@check("compute: a blank rate cell is flagged, not silently Free")
def _():
    res = compute(hts="0000.00.00.00", country="Vietnam", entered_value=1000,
                  base_rate_cell="")
    assert "rate_missing" in res.incomplete, res.incomplete


@check("compute: refuses non-positive and non-finite values")
def _():
    for bad in (0, -1, float("nan"), float("inf")):
        try:
            compute(hts="x", country="Vietnam", entered_value=bad, base_rate_cell="Free")
        except ValueError:
            continue
        raise AssertionError(f"accepted {bad!r}")


# ---------------------------------------- preference selection (audit #5)

@check("special: programs and their rates are separated")
def _():
    alts = parse_special("Free (A,AU,KR) 5% (MX)")
    assert alts and alts[0].programs == ("A", "AU", "KR") and alts[1].rate.pct == Decimal("5"), alts


@check("special: a preference is matched to the origin, not to a bare flag")
def _():
    cell = "Free (A,AU,KR) 5% (MX)"
    rate, prog, _n = select_preference(cell, "MX", None)
    assert rate is not None and rate.pct == Decimal("5") and prog == "MX", (rate, prog)
    rate, prog, _n = select_preference(cell, "KR", None)
    assert rate is not None and rate.pct == Decimal("0") and prog == "KR", (rate, prog)


@check("special: an origin no listed program covers falls back to MFN with a reason")
def _():
    rate, _p, notes = select_preference("Free (AU,KR)", "VN", None)
    assert rate is None and notes, (rate, notes)


@check("special: a named program the origin is not party to is refused")
def _():
    rate, _p, notes = select_preference("Free (AU,KR)", "VN", "KR")
    assert rate is None and any("does not cover" in n for n in notes), notes


@check("special: a caller-asserted GSP-style program is applied but flagged unchecked")
def _():
    rate, prog, notes = select_preference("Free (A,AU)", "VN", "A")
    assert rate is not None and prog == "A" and any("not checked" in n for n in notes), notes


@check("compute: claiming a preference the line does not offer keeps MFN and says so")
def _():
    res = compute(hts="6109.10.00.12", country="Vietnam", entered_value=10_000,
                  base_rate_cell="16.5%", special_rate_cell="Free (AU,KR)",
                  fta_claimed=True)
    assert component(res, "MFN").rate_pct == Decimal("16.5")
    assert res.warnings, "the fall-back must be explained"


@check("compute: USMCA program S applies to Mexico and not to Vietnam")
def _():
    kw = dict(hts="6109.10.00.12", entered_value=10_000, base_rate_cell="16.5%",
              special_rate_cell="Free (S,AU)", preference_program="S")
    assert component(compute(country="Mexico", **kw), "FTA").rate_pct == Decimal("0")
    assert component(compute(country="Vietnam", **kw), "MFN").rate_pct == Decimal("16.5")


# --------------------------------------------- origin canonicalisation (#4)

@check("country: every common spelling of China resolves to one key")
def _():
    for name in ("China", "CN", "cn", "PRC", "People's Republic of China", "chn"):
        assert country_code(name) == "CN", name


@check("country: an unrecognised origin raises rather than resolving to nothing")
def _():
    for bad in ("Chnia", "", "  ", "Atlantis"):
        try:
            require_country(bad)
        except UnknownCountry:
            continue
        raise AssertionError(f"accepted {bad!r}")


@check("origin: the same country under different spellings prices identically")
def _():
    rules = [rule("9903.88.03", rate=25, countries=["China"], refs=["6109.10"])]
    totals = set()
    for name in ("China", "CN", "PRC", "china"):
        res = compute(hts="6109.10.00.12", country=name, entered_value=10_000,
                      base_rate_cell="16.5%", ch99_rules=rules)
        totals.add(res.total_duty)
    assert len(totals) == 1, f"one origin priced {len(totals)} ways: {totals}"
    assert component(res, "Trade remedy") is not None


@check("origin: Chapter 99's truncated country names still match ('Bosnia', 'Trinidad')")
def _():
    assert country_code("Bosnia") == country_code("Bosnia and Herzegovina") == "BA"
    assert country_code("Trinidad") == "TT"
    rules = [rule("9903.99.01", rate=10, countries=["Bosnia"], refs=["6109"])]
    res = compute(hts="6109.10.00.12", country="BA", entered_value=1000,
                  base_rate_cell="Free", ch99_rules=rules)
    assert component(res, "Trade remedy") is not None


# --------------------------------------------- catalogue fee model (#6)

@check("fees: MPF minimum is charged once per entry, not once per line")
def _():
    assert entry_mpf(1000, entries=1).amount == MPF_MIN
    assert entry_mpf(1000, entries=10).amount == MPF_MIN * 10
    per_line = sum(
        next(c.amount for c in compute(
            hts="6109.10.00.12", country="Vietnam", entered_value=100,
            base_rate_cell="Free").components if "Processing" in c.label)
        for _ in range(10))
    assert per_line == MPF_MIN * 10 and entry_mpf(1000).amount == MPF_MIN


@check("fees: MPF cap applies per entry")
def _():
    assert entry_mpf(10_000_000, entries=1).amount == MPF_MAX
    assert entry_mpf(10_000_000, entries=4).amount == MPF_MAX * 4


@check("fees: an informal entry line carries no MPF")
def _():
    res = compute(hts="6109.10.00.12", country="Vietnam", entered_value=100,
                  base_rate_cell="Free", is_formal_entry=False)
    assert component(res, "Processing") is None


def main() -> int:
    width = max(len(n) for n, _, _ in _results)
    failed = 0
    for name, status, detail in _results:
        mark = "ok  " if status == "pass" else "FAIL"
        print(f"  {mark}  {name.ljust(width)}")
        if status != "pass":
            failed += 1
            print(f"        {detail.splitlines()[-1][:160]}")
    print(f"\n{len(_results) - failed}/{len(_results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
