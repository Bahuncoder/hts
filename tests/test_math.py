"""The arithmetic of a duty quote: specific duties, deal thresholds, and the
invariants any correct calculation must keep.

Two kinds of test. The first pins worked examples to the schedule's own words
(U.S. note 52(k)'s "50 cents per kilogram ... $10 = 5 percent"). The second
states properties that must hold for every input, and checks them over many
generated inputs with a fixed seed: doubling the value doubles an ad valorem
duty, converting a quantity between units cannot change the duty, and the
fee clamp never leaves its bounds. A worked example can be wrong in the same
way as the code; a violated property cannot hide behind one.

Self-contained (no pytest). Real-schedule tests skip if data/ is absent.
"""
from __future__ import annotations

import random
import sys
import traceback
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core.ch99 import parse_rule  # noqa: E402
from core.duty import (MPF_MAX, MPF_MIN, MPF_RATE, compute, parse_rate)  # noqa: E402
from core.regimes import described_scope  # noqa: E402
from core.units import convert, parse_specific, unit_of  # noqa: E402

D = Decimal
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


def money(res, label_start):
    return next(c.amount for c in res.components if c.label.startswith(label_start))


# ------------------------------------------------------------------- units

@check("units: every spelling of a unit resolves, and unknown ones do not")
def _():
    for name in ("kg", "KG", "kilograms", "lb", "lbs", "oz", "t", "liter", "L", "gal",
                 "m3", "each", "doz.", "doz", "gross", "pr.", "pairs", "pf.liter", "bbl"):
        assert unit_of(name) is not None, name
    for name in ("", None, "furlong", "kg on copper content"):
        assert unit_of(name) is None, name


@check("units: a quantity converts within its dimension and never across it")
def _():
    lb, kg = unit_of("lb"), unit_of("kg")
    assert convert(D(1000), lb, "mass") == D("453.59237000")
    assert convert(D(5), kg, "volume") is None, "kilograms became litres"
    assert convert(D(5), unit_of("doz"), "count") == 60
    assert convert(D(2), unit_of("pr."), "count") is None, "pairs are not pieces"


@check("units: cents and dollars are read exactly, and anything unpriceable is refused")
def _():
    r = parse_specific("8.8¢/kg")
    assert r and r.dollars == D("0.088") and r.unit.dimension == "mass"
    assert parse_specific("$1.70/m3").dollars == D("1.70")
    assert parse_specific("2¢ each") is not None
    assert parse_specific("50¢/doz.").per_base_unit() == D("50") / 100 / 12
    for text in ("8.8¢/kg on copper content", "10.8¢/kg on drained weight",
                 "7¢/kg less 0.5¢/kg for each degree under 100 degrees", "5%", "Free", "¢/kg"):
        assert parse_specific(text) is None, text


# ------------------------------------------------------- specific duty math

def cmp(**kw):
    args = dict(hts="0000.00.00.00", country="Germany", entered_value=1000,
                base_rate_cell="", by_vessel=False, is_formal_entry=False)
    args.update(kw)
    return compute(**args)


@check("specific: 50 cents per kilogram on $10 of goods is 5 percent (note 52(k)'s own example)")
def _():
    r = cmp(entered_value=10, base_rate_cell="50¢/kg", quantity=1)
    assert r.total_duty == D("0.50") and r.effective_rate_pct == D("5.00"), r.total_duty
    assert r.incomplete == []


@check("specific: a compound duty adds its ad valorem and per-unit parts")
def _():
    r = cmp(entered_value=1000, base_rate_cell="$1/kg + 5%", quantity=200)
    assert r.total_duty == D("250.00"), r.total_duty      # $200 specific + $50 ad valorem
    assert r.incomplete == []


@check("specific: without a quantity the duty is understated, flagged, and says what to enter")
def _():
    r = cmp(base_rate_cell="8.8¢/kg")
    assert r.incomplete == ["specific_duty_omitted"] and r.quantity_needed == ["kg"]
    assert any("Enter the quantity in kg" in w for w in r.warnings), r.warnings
    assert r.as_dict()["complete"] is False


@check("specific: a quantity in another unit of the same kind is converted, not misread")
def _():
    kg = cmp(base_rate_cell="10¢/kg", quantity=1000, quantity_unit="kg")
    lb = cmp(base_rate_cell="10¢/kg", quantity="2204.62262185", quantity_unit="lb")
    tonne = cmp(base_rate_cell="10¢/kg", quantity=1, quantity_unit="t")
    assert kg.total_duty == lb.total_duty == tonne.total_duty == D("100.00"), (
        kg.total_duty, lb.total_duty, tonne.total_duty)
    dz = cmp(base_rate_cell="60¢/doz.", quantity=120, quantity_unit="each")
    assert dz.total_duty == D("6.00"), dz.total_duty


@check("specific: a quantity in an incompatible unit is refused, never applied as if it matched")
def _():
    r = cmp(base_rate_cell="10¢/kg", quantity=5, quantity_unit="liter")
    assert r.incomplete == ["quantity_unit_mismatch"] and r.total_duty == 0, (r.incomplete, r.total_duty)
    r = cmp(base_rate_cell="10¢/kg", quantity=5, quantity_unit="furlong")
    assert r.incomplete == ["quantity_unit_mismatch"]


@check("specific: a form that cannot be priced exactly stays flagged even with a quantity")
def _():
    r = cmp(base_rate_cell="7¢/kg less 0.5¢/kg for each degree under 100 degrees", quantity=100)
    assert r.incomplete == ["specific_duty_unsupported"] and r.total_duty == 0
    r = cmp(base_rate_cell="8.8¢/kg on copper content", quantity=100)
    assert r.incomplete == ["specific_duty_unsupported"]


@check("specific: the unit is stated as an assumption when the caller did not name it")
def _():
    r = cmp(base_rate_cell="10¢/kg", quantity=10)
    assert any("taken to be in kg" in a for a in r.assumptions), r.assumptions
    r = cmp(base_rate_cell="10¢/kg", quantity=10, quantity_unit="kg")
    assert not any("taken to be" in a for a in r.assumptions)


@check("specific: a non-positive or non-numeric quantity is an error, not a free pass")
def _():
    for bad in (0, -5, "abc", float("nan"), float("inf")):
        try:
            cmp(base_rate_cell="10¢/kg", quantity=bad)
        except ValueError:
            continue
        raise AssertionError(f"quantity {bad!r} was accepted")


@check("specific: the base duty is shown as its ad valorem equivalent")
def _():
    r = cmp(entered_value=1000, base_rate_cell="10¢/kg", quantity=1000)
    base = r.components[0]
    assert base.amount == D("100.00") and base.rate_pct == D("10.0000"), (base.amount, base.rate_pct)


# ------------------------------------------------------------ real schedule

HTS, NOTES = ROOT / "data" / "hts_2026.json", ROOT / "data" / "chapter99.txt"
E = None
if HTS.exists() and NOTES.exists():
    from core.engine import TariffEngine
    E = TariffEngine(str(HTS), str(NOTES))


def real(name):
    def wrap(fn):
        if E is None:
            return fn
        return check(name)(fn)
    return wrap


def other232(digits):
    """True when a Section 232 regime other than the metals lists the code."""
    s = E.regimes.s232
    return bool(s.vehicles.pv_parts.covers(digits) or s.vehicles.heavy_parts.covers(digits)
                or s.vehicles.vehicles.covers(digits) or s.wood.softwood.covers(digits)
                or s.wood.upholstered.covers(digits) or s.wood.cabinets.covers(digits)
                or s.unresolved.covers(digits))



def general(code):
    return E.tree.effective_rate_cell(code, "general")[0]


def clear_of_232(l):
    return not E.regimes.domain_232.covers(l.digits)


def line_with_rate(pct, exclude_232=True):
    """A leaf whose general rate is exactly `pct` percent, with no special rate
    that could change the base for a claimed program."""
    for l in E.tree.leaves:
        if general(l.hts) == f"{pct}%" and (not exclude_232 or clear_of_232(l)) \
                and not l.hts.startswith(("98", "99")):
            return l.hts
    raise AssertionError(f"no line at {pct}%")


DEALS = (("Germany", "9903.05.39", "9903.05.38", 10), ("Japan", "9903.05.49", "9903.05.48", 12.5),
         ("South Korea", "9903.05.71", "9903.05.70", 12.5), ("Switzerland", "9903.05.74", "9903.05.73", 12.5),
         ("Taiwan", "9903.05.76", "9903.05.75", 10))


@real("deal math: below the threshold the duty is topped up so base + additional equals it exactly")
def _():
    for origin, low, _hi, th in DEALS:
        code = line_with_rate("5")
        r = E.quote(hts=code, country=origin, value=10000)
        top = [c for c in r.components if low in c.label]
        assert len(top) == 1, (origin, [c.label for c in r.components])
        assert money(r, "MFN") + top[0].amount == D(str(th)) * 100, (origin, money(r, "MFN"), top[0].amount)
        assert r.incomplete == [] and not any("9903.05.7" in h or "9903.05.3" in h
                                              for h in r.scope_unverified)


@real("deal math: at or above the threshold nothing is added, and the quote says why")
def _():
    for origin, low, hi, th in DEALS:
        code = line_with_rate("16.5")
        r = E.quote(hts=code, country=origin, value=10000)
        assert not any(low in c.label or hi in c.label for c in r.components), (origin, r.components)
        assert any(f"adds nothing" in a and hi in a for a in r.assumptions), (origin, r.assumptions)
        assert money(r, "MFN") == D("1650.00")


@real("deal math: exactly at the threshold counts as 'equal to or greater', so nothing is added")
def _():
    code = line_with_rate("10")
    r = E.quote(hts=code, country="Germany", value=10000)
    assert not any("9903.05.39" in c.label for c in r.components), r.components


@real("deal math: a per-unit base rate needs its quantity before the deal rate can be known")
def _():
    code = next(l.hts for l in E.tree.leaves if general(l.hts) == "1¢/kg" and clear_of_232(l))
    r = E.quote(hts=code, country="Germany", value=5000)
    assert "specific_duty_omitted" in r.incomplete and "deal_rate_unresolved" in r.incomplete, r.incomplete
    priced = E.quote(hts=code, country="Germany", value=5000, quantity=1000)
    assert priced.incomplete == [], priced.incomplete
    total = money(priced, "MFN") + next(c.amount for c in priced.components if "9903.05.39" in c.label)
    assert total == D("500.00"), total                        # 10% of $5,000


@real("deal math: the additional duty is the threshold minus the ad valorem equivalent, however it arises")
def _():
    code = next(l.hts for l in E.tree.leaves if general(l.hts) == "1¢/kg" and clear_of_232(l))
    for kilos in (1, 40, 1000, 4999):
        r = E.quote(hts=code, country="Japan", value=5000, quantity=kilos)
        base = money(r, "MFN")
        ave = base / 5000 * 100
        top = next((c for c in r.components if "9903.05.49" in c.label), None)
        if ave < D("12.5"):
            assert top and base + top.amount == D("625.00"), (kilos, base, top)
        else:
            assert top is None


@real("chapter 99 codes named as exceptions are not base subheadings (121 rules once matched nothing)")
def _():
    assert not [r.hts for r in E.ch99 if any(b.startswith(("98", "99")) for b in r.base_refs)]
    r = parse_rule({"htsno": "9903.02.69", "general": "The duty provided in the applicable subheading + 20%",
                    "description": "articles the product of Vietnam, except as provided for in headings "
                                   "9903.01.34 and 9903.02.01, as provided for in subdivision (v) of U.S. note 2"})
    assert r.base_refs == [], r.base_refs


@real("reciprocal (9903.02) tariffs are struck-down IEEPA duties: refund estimate, never amount owed")
def _():
    r = E.quote(hts="6109.10.00.12", country="Vietnam", value=10000)
    assert "9903.02.69" in r.refund_unverified, r.refund_unverified
    assert not any("9903.02" in c.label for c in r.components)
    assert not any(h.startswith("9903.02") for h in r.scope_unverified)


@real("note 51: Canada's 50% headings each take only their own product list")
def _():
    scopes = E.scopes
    a, b, c = (scopes[h].codes for h in ("9903.03.12", "9903.03.13", "9903.03.14"))
    assert a and b and c and not (a & b) and not (a & c) and not (b & c)
    assert sum(map(len, (a, b, c))) == 554 and len(a) == 63


@real("a provision that names its own goods ('provided for in heading 4104') is out of scope for other goods")
def _():
    assert described_scope("leather (provided for in heading 4104 or 4107)") == {"4104", "4107"}
    assert described_scope("footwear, provided for in chapter 64, except (a) slip-on") == {"64"}
    # "except" before the phrase means the phrase may name what is left out
    assert described_scope("Everything except goods (provided for in heading 8471)") is None
    r = E.quote(hts="6109.10.00.12", country="Japan", value=10000)
    assert not {"9903.41.05", "9903.41.10"} & set(r.scope_unverified), r.scope_unverified


# ----------------------------------------------------------------- properties

def sample_lines(n, seed):
    rng = random.Random(seed)
    leaves = [l for l in E.tree.leaves if not l.hts.startswith(("98", "99"))]
    return rng.sample(leaves, n)


@real("property: doubling the entered value doubles every ad valorem component (to the cent)")
def _():
    rng = random.Random(11)
    compared = 0
    for l in sample_lines(150, 1):
        origin = rng.choice(["China", "Vietnam", "Germany", "Japan", "Canada", "India"])
        v = D(rng.randint(100, 900_000))
        a = E.quote(hts=l.hts, country=origin, value=v, by_vessel=False, is_formal_entry=False)
        b = E.quote(hts=l.hts, country=origin, value=v * 2, by_vessel=False, is_formal_entry=False)
        if a.incomplete or b.incomplete or [c.label for c in a.components] != [c.label for c in b.components]:
            continue                       # deal thresholds legitimately change with a specific rate
        compared += 1
        for ca, cb in zip(a.components, b.components):
            assert abs(cb.amount - 2 * ca.amount) <= D("0.01"), (l.hts, origin, ca.label, ca.amount, cb.amount)
    assert compared >= 60, f"only {compared} of 150 quotes were comparable: the property is close to vacuous"


@real("property: the total is the sum of its parts, is never negative, and reports every part")
def _():
    rng = random.Random(12)
    for l in sample_lines(200, 2):
        r = E.quote(hts=l.hts, country=rng.choice(["China", "Mexico", "France", "India", "Thailand"]),
                    value=rng.randint(50, 500_000), quantity=rng.randint(1, 10_000))
        assert r.total_duty == sum(c.amount for c in r.components)
        assert all(c.amount >= 0 for c in r.components), (l.hts, [(c.label, c.amount) for c in r.components])
        assert r.landed_cost == r.entered_value + r.total_duty


@real("property: the same duty comes out whichever unit the quantity is given in")
def _():
    rng = random.Random(13)
    codes = [l.hts for l in E.tree.leaves if "¢/kg" in general(l.hts) and "+" not in general(l.hts)
             and " " not in general(l.hts)][:60]
    for code in codes:
        kilos = rng.randint(1, 50_000)
        v = rng.randint(1000, 400_000)
        ref = E.quote(hts=code, country="Vietnam", value=v, quantity=kilos, quantity_unit="kg")
        pounds = E.quote(hts=code, country="Vietnam", value=v,
                         quantity=D(kilos) / D("0.45359237"), quantity_unit="lb")
        assert abs(ref.total_duty - pounds.total_duty) <= D("0.01"), (code, ref.total_duty, pounds.total_duty)


@real("property: a per-unit duty is proportional to quantity and independent of value")
def _():
    code = next(l.hts for l in E.tree.leaves if general(l.hts) == "1¢/kg")
    base = E.quote(hts=code, country="Vietnam", value=1000, quantity=1000, by_vessel=False, is_formal_entry=False)
    for k in (2, 5, 10):
        q = E.quote(hts=code, country="Vietnam", value=1000, quantity=1000 * k, by_vessel=False, is_formal_entry=False)
        assert money(q, "MFN") == money(base, "MFN") * k
    rich = E.quote(hts=code, country="Vietnam", value=900_000, quantity=1000, by_vessel=False, is_formal_entry=False)
    assert money(rich, "MFN") == money(base, "MFN")


@real("property: the Merchandise Processing Fee never leaves its floor and cap, and matches the rate between them")
def _():
    rng = random.Random(14)
    code = "6109.10.00.12"
    for _ in range(200):
        v = D(rng.choice([rng.randint(1, 50_000), rng.randint(50_000, 5_000_000)]))
        mpf = money(E.quote(hts=code, country="Vietnam", value=v), "Merchandise Processing")
        assert MPF_MIN <= mpf <= MPF_MAX, (v, mpf)
        exact = (v * MPF_RATE).quantize(D("0.01"))
        assert mpf == min(max(exact, MPF_MIN), MPF_MAX), (v, mpf, exact)


@real("property: every spelling of an origin prices the same, with a quantity too")
def _():
    code = next(l.hts for l in E.tree.leaves if general(l.hts) == "1¢/kg" and clear_of_232(l))
    for names in (("China", "PRC", "cn", "People's Republic of China"),
                  ("Germany", "DE", "germany"), ("South Korea", "Korea, South", "KR")):
        totals = {E.quote(hts=code, country=n, value=3000, quantity=500).total_duty for n in names}
        assert len(totals) == 1, (names, totals)


@real("property: the metals headings are mutually exclusive, never stack with note 52, and never reach a code outside note 16's lists")
def _():
    rng = random.Random(21)
    seen = 0
    for l in random.Random(3).sample([x for x in E.tree.leaves if not x.hts.startswith(("98", "99"))], 700):
        origin = rng.choice(["China", "Vietnam", "India", "Germany", "Japan", "Mexico", "United Kingdom"])
        r = E.quote(hts=l.hts, country=origin, value=10000, quantity=1, metal_weight_pct=50)
        metals = [c for c in r.components if "9903.82" in c.label]
        note52 = [c for c in r.components if "9903.05" in c.label]
        assert len(metals) <= 1, (l.hts, origin, [c.label for c in metals])
        assert not (metals and note52), (l.hts, origin, "232 metals stacked with note 52")
        if not E.regimes.s232.metals.hits(l.digits):
            assert not metals, (l.hts, "charged metals duty outside the lists")
        seen += bool(metals)
    assert seen >= 20, f"only {seen} lines exercised the metals headings"


@real("property: a metal weight below 15% never yields a metals charge, and 15% or more always does (outside the metal chapters)")
def _():
    rng = random.Random(22)
    checked = 0
    for l in E.tree.leaves:
        if not E.regimes.s232.metals.hits(l.digits) or l.digits[:2] in ("72", "73", "74", "76") \
                or other232(l.digits):
            continue
        low = E.quote(hts=l.hts, country="Vietnam", value=5000, quantity=1, metal_weight_pct=rng.choice([0, 5, 14.9]))
        high = E.quote(hts=l.hts, country="Vietnam", value=5000, quantity=1, metal_weight_pct=rng.choice([15, 40, 100]))
        assert not any("9903.82" in c.label for c in low.components), (l.hts, "under 15% was charged")
        assert any("9903.82" in c.label for c in high.components) or high.incomplete, (l.hts, "15%+ was not charged")
        checked += 1
    assert checked >= 100, checked


@real("metal weight must be a percentage")
def _():
    for bad in (-1, 100.5, "abc", float("nan")):
        try:
            E.quote(hts="6109.10.00.12", country="China", value=1000, metal_weight_pct=bad)
        except ValueError:
            continue
        raise AssertionError(f"metal weight {bad!r} was accepted")


@real("property: with every fact stated, at most one Section 232 regime charges a code, and never alongside note 52")
def _():
    rng = random.Random(31)
    fams = {"metals": "9903.82", "vehicle": ("9903.94", "9903.74"), "wood": "9903.76"}
    charged = 0
    for l in random.Random(4).sample([x for x in E.tree.leaves if not x.hts.startswith(("98", "99"))], 900):
        origin = rng.choice(["China", "Vietnam", "India", "Mexico", "Canada", "Germany", "Japan"])
        r = E.quote(hts=l.hts, country=origin, value=8000, quantity=1, metal_weight_pct=rng.choice([5, 30, 80]),
                    vehicle_use=rng.choice(["passenger", "heavy", "none"]), end_use=rng.choice([None, "pharmaceutical"]),
                    preference_program=rng.choice([None, "S"]))
        regs = {k for k, pre in fams.items() if any(c.label.split("Trade remedy ")[-1].startswith(pre)
                                                    for c in r.components if "Trade remedy" in c.label)}
        assert len(regs) <= 1, (l.hts, origin, regs)
        if regs:
            charged += 1
            assert not any("9903.05" in c.label for c in r.components), (l.hts, origin, "232 stacked with note 52")
    assert charged >= 40, f"only {charged} lines exercised Section 232"


@real("property: a stated 'not a vehicle part' can never produce a vehicle-parts duty")
def _():
    for l in E.tree.leaves:
        v = E.regimes.s232.vehicles
        if not (v.pv_parts.covers(l.digits) or v.heavy_parts.covers(l.digits)):
            continue
        r = E.quote(hts=l.hts, country="Vietnam", value=5000, quantity=1, metal_weight_pct=50, vehicle_use="none")
        assert not any("9903.94" in c.label or "9903.74" in c.label for c in r.components), (l.hts, [c.label for c in r.components])


@real("property: pricing is deterministic")
def _():
    l = sample_lines(1, 5)[0]
    a = E.quote(hts=l.hts, country="Japan", value=1234.5, quantity=77).as_dict()
    b = E.quote(hts=l.hts, country="Japan", value=1234.5, quantity=77).as_dict()
    assert a == b


def main() -> int:
    width = max(len(n) for n, _, _ in _results)
    failed = 0
    for name, status, detail in _results:
        print(f"  {'ok  ' if status == 'pass' else 'FAIL'}  {name.ljust(width)}")
        if status != "pass":
            failed += 1
            print(f"        {detail.splitlines()[-1][:220]}")
    print(f"\n{len(_results) - failed}/{len(_results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
