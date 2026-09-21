"""Antidumping and countervailing duty orders: reading the lists, matching a code
and an origin, and saying what could not be checked.

The parsing tests use text copied from real Federal Register notices, layout and
all (wrapped product names, page markers, leader dots). Real-data tests skip when
data/adcvd_orders.json has not been built.
"""
from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core.adcvd import AdcvdIndex, Order  # noqa: E402
from ingest.adcvd import country_iso, parse_list, scope_hts  # noqa: E402

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


MONTHLY = """<html><body><pre>
------------------------------------------------------------------------
                                                             Period
------------------------------------------------------------------------
             Antidumping Duty Proceedings

BELARUS: Steel Concrete Reinforcing Bars, A-822-804..     8/31/26-9/1/25
INDIA:
    Cold-Rolled Steel Flat Products, A-533-865.......     9/1/25-8/31/26
    Mattresses, A-533-919............................     9/1/25-8/31/26

[[Page 56108]]

    Certain Oil Country Tubular Goods, A-533-857.....     9/1/25-8/31/26
MEXICO:
    Heavy Walled Rectangular Welded Carbon Steel          9/1/25-8/31/26
     Pipes and Tubes, A-201-847......................
REPUBLIC OF T[Uuml]RKIYE:
    Certain Oil Country Tubular Goods, A-489-816.....     9/1/25-8/31/26
THE PEOPLE'S REPUBLIC OF CHINA:
    Sol Gel Alumina-Based Ceramic Abrasive Grains, A-     9/1/25-8/31/26
     570-190.........................................
    Steel Concrete Reinforcing Bars, A-570-860.......     9/1/25-8/31/26
UNITED KINGDOM: Cold-Rolled Steel Flat Products, A-       9/1/25-8/31/26
 412-824.............................................

           Countervailing Duty Proceedings

INDIA:
    Cold-Rolled Steel Flat Products, C-533-866.......    1/1/25-12/31/25
REPUBLIC OF KOREA: Cold-Rolled Steel Flat Products, C-   1/1/25-12/31/25
 580-882.............................................

Suspension Agreements

    None.
</pre></body></html>"""


@check("order list: countries, wrapped product names and wrapped case numbers are read")
def _():
    got = {o["case"]: o for o in parse_list(MONTHLY)}
    assert set(got) == {"A-822-804", "A-533-865", "A-533-919", "A-533-857", "A-201-847", "A-489-816",
                        "A-570-190", "A-570-860", "A-412-824", "C-533-866", "C-580-882"}, sorted(got)
    assert got["A-201-847"]["product"] == "Heavy Walled Rectangular Welded Carbon Steel Pipes and Tubes"
    assert got["A-570-190"]["product"] == "Sol Gel Alumina-Based Ceramic Abrasive Grains", got["A-570-190"]
    assert got["A-570-860"]["product"] == "Steel Concrete Reinforcing Bars"
    assert got["A-533-857"]["country"] == "INDIA", "a page break lost the country"
    assert got["A-412-824"]["country"] == "UNITED KINGDOM"


@check("order list: countervailing orders are labelled CVD, from their case letter")
def _():
    kinds = {o["case"]: o["kind"] for o in parse_list(MONTHLY)}
    assert kinds["C-533-866"] == "CVD" and kinds["A-533-865"] == "AD"


@check("order list: country names as the Federal Register prints them resolve to ISO codes")
def _():
    for name, iso in (("THE PEOPLE'S REPUBLIC OF CHINA", "CN"), ("REPUBLIC OF T[Uuml]RKIYE", "TR"),
                      ("SOCIALIST REPUBLIC OF VIETNAM", "VN"), ("THE UNITED KINGDOM", "GB"),
                      ("REPUBLIC OF KOREA", "KR"), ("RUPUBLIC OF KOREA", "KR"), ("INDIA", "IN"),
                      ("THE NETHERLANDS", "NL")):
        assert country_iso(name) == iso, (name, country_iso(name))
    assert country_iso("ATLANTIS") is None


SCOPE = """
Scope of the Order

    The merchandise subject to this order is certain steel nails. The
merchandise is currently classified under HTSUS subheadings 7317.00.10,
7317.00.20, 7317.00.30, 7317.00.5502 and heading 7907. Page 3510 and a
fee of 1900 dollars are not codes. Also 9903.88.03.

Scope Comments

    We received comments on 7318.15.20.
"""


@check("scope: dotted HTS numbers and headings are read, page numbers and chapter 98/99 references are not")
def _():
    got = scope_hts(SCOPE)
    assert {"73170010", "73170020", "73170030", "7317005502", "7907"} <= set(got), got
    assert "3510" not in got and "1900" not in got and not any(c.startswith("99") for c in got), got
    assert "731815" not in got and "73181520" not in got, "read past the end of the scope section"


APPENDIX = """
Scope of the Orders

    The products covered by these orders are mattresses. For a complete description, see the appendix.

Appendix

Scope of the Orders

    Mattresses ... classified under HTSUS subheadings 9404.21.0010, 9404.21.0013 and 9404.29.1095.
"""


@check("scope: a scope that defers to an appendix is read from the appendix")
def _():
    assert {"9404210010", "9404210013", "9404291095"} <= set(scope_hts(APPENDIX))


ORDERS = [
    Order("A-570-909", "AD", "CHINA", "CN", "Certain Steel Nails", frozenset({"731700", "7907"})),
    Order("A-570-190", "AD", "CHINA", "CN", "Abrasive Grains", frozenset()),
    Order("A-533-919", "AD", "INDIA", "IN", "Mattresses", frozenset({"940421"})),
]


@check("match: an order applies to its own country and listed codes only, and unlisted orders are counted")
def _():
    ix = AdcvdIndex(ORDERS, "2026-09-20")
    hits, unchecked = ix.match("7317005502", "CN")
    assert [o.case for o in hits] == ["A-570-909"] and unchecked == 1
    assert ix.match("7317005502", "VN") == ([], 0), "an order followed the product to another country"
    assert ix.match("6109100012", "CN")[0] == []
    assert [o.case for o in ix.match("9404210010", "IN")[0]] == ["A-533-919"]
    assert ix.match("9404210010", "CN")[0] == []


@check("a heading-level entry covers every subheading beneath it, and a longer entry does not cover its siblings")
def _():
    o = Order("X", "AD", "CHINA", "CN", "p", frozenset({"7604", "76109000"}))
    assert o.covers("7604210010") and o.covers("7610900000") and not o.covers("7610100000")


HTS, NOTES = ROOT / "data" / "hts_2026.json", ROOT / "data" / "chapter99.txt"
DATA = ROOT / "data" / "adcvd_orders.json"
E = None
if HTS.exists() and NOTES.exists() and DATA.exists():
    from core.engine import TariffEngine
    E = TariffEngine(str(HTS), str(NOTES))


def real(name):
    def wrap(fn):
        if E is None or not E.adcvd:
            return fn
        return check(name)(fn)
    return wrap


@real("real orders: steel nails from China carry the order and an incomplete total; the same code from Germany does not")
def _():
    code = next(l.hts for l in E.tree.leaves if l.hts.startswith("7317.00.55"))
    cn = E.quote(hts=code, country="China", value=10000)
    assert any(o["case"] == "A-570-909" for o in cn.adcvd), cn.adcvd
    assert "adcvd_possible" in cn.incomplete and cn.as_dict()["complete"] is False
    assert any("cash deposit" in w for w in cn.warnings)
    de = E.quote(hts=code, country="Germany", value=10000)
    assert not any(o["case"] == "A-570-909" for o in de.adcvd)


@real("real orders: softwood lumber from Canada, aluminum extrusions and hardwood plywood from China are matched")
def _():
    for prefix, origin, case in (("4407.11", "Canada", "A-122-857"), ("7604.21", "China", "A-570-967"),
                                 ("4412.33", "China", "A-570-051")):
        code = next(l.hts for l in E.tree.leaves if l.hts.startswith(prefix))
        r = E.quote(hts=code, country=origin, value=10000)
        assert any(o["case"] == case for o in r.adcvd), (prefix, origin, case, [o["case"] for o in r.adcvd])


@real("real orders: an ordinary garment is not flagged, and every order carries an ISO country")
def _():
    r = E.quote(hts="6109.10.00.12", country="China", value=10000)
    assert not r.adcvd and r.adcvd_checked is True
    data = json.loads(DATA.read_text())
    assert len(data["orders"]) > 400, len(data["orders"])
    assert all(o.get("iso") for o in data["orders"]), [o["country"] for o in data["orders"] if not o.get("iso")]
    with_hts = sum(1 for o in data["orders"] if o["hts"])
    assert with_hts / len(data["orders"]) > 0.8, f"only {with_hts} of {len(data['orders'])} orders list HTS numbers"


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
