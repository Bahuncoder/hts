"""Antidumping and countervailing duty orders: reading the lists, matching a code
and an origin, and saying what could not be checked.

The parsing tests use text copied from real Federal Register notices, layout and
all (wrapped product names, page markers, leader dots). Real-data tests skip when
data/adcvd_orders.json has not been built.
"""
from __future__ import annotations

import json
import sys
import tempfile
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core.adcvd import AdcvdIndex, Order  # noqa: E402
import ingest.adcvd as adcvd_mod  # noqa: E402
from ingest.adcvd import _own_case, _rank, _try_candidates, country_iso, parse_list, scope_hts  # noqa: E402
from ingest.refresh import MIN_ADCVD_ORDERS, validate_adcvd  # noqa: E402

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


# Real language, adapted from Fresh Tomatoes From Mexico's order (A-201-820,
# 2025-13453): a bare heading, no subheading digits at all, which matches
# neither the dotted pattern nor "heading(s) NNNN" — the word "subheading"
# here sits nowhere near the number.
BARE_HEADING = """
Scope of the Order

    The merchandise subject to the order is all fresh or chilled
tomatoes. Tomatoes imported from Mexico covered by this order are
classified under the following subheading of the Harmonized Tariff
Schedule of the United States (HTSUS), according to the season of
importation: 0702. Although the HTSUS numbers are provided for
convenience and customs purposes, the written description of the scope
of this order is dispositive.
"""


@check("scope: a scope naming only a bare heading (no subheading digits at all) is read from just before the standard disclaimer")
def _():
    assert scope_hts(BARE_HEADING) == ["0702"]


NO_CODES_NEAR_CONVENIENCE = """
Scope of the Order

    The merchandise subject to this order is described in Appendix I,
available for convenience at the Department's public file, docket
number 2020, filed under 19 CFR 351.225. The written description
governs.
"""


@check("scope: an unrelated 4-digit number merely near the word 'convenience' is not read as a code")
def _():
    assert scope_hts(NO_CODES_NEAR_CONVENIENCE) == []


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



WRAPPED_FALSE_STOP = """
Scope of the Order

    The product covered by this order is widgets from Ruritania. The
merchandise is currently classifiable under HTSUS subheadings 7202.21.1000,
7202.21.5000, and 7202.29.0010.

Amendment to the Final LTFV
Determination to reflect a ministerial error

    We determine that we made certain ministerial errors in the sales at LTFV
final determination. Widgets are further classifiable under subheading
9999.99.9999, which is far past where extraction should have stopped.

Scope Comments

    Interested parties may request scope rulings.
"""


@check("scope: a common word that merely starts a wrapped line (mid-sentence) does not truncate the scope section early")
def _():
    got = set(scope_hts(WRAPPED_FALSE_STOP))
    assert {"7202211000", "7202215000", "7202290010"} <= got, got
    assert "9999999999" not in got, "ran past 'Scope Comments' into the next section"


DEFERRED_APPENDIX = """
Scope of the Orders

    The product covered by these orders is ferrosilicon from Ruritania. For a
complete description of the scope of the orders, see the appendix to this
notice.

Amendment to the Final LTFV
Determination to reflect a ministerial error

    Nothing relevant here, and no repeated "Scope of the Order" heading below.

Appendix

    The scope of these orders covers all forms and sizes of ferrosilicon.
Ferrosilicon is currently classifiable under subheadings 7202.21.1000,
7202.21.5000, 7202.21.7500, 7202.21.9000, 7202.29.0010, and 7202.29.0050 of
the Harmonized Tariff Schedule of the United States (HTSUS). While the HTSUS
numbers are provided for convenience, the written description is dispositive.
"""


@check("scope: an appendix that defers without repeating the 'Scope of the Order' heading is still found, from before the HTSUS phrase")
def _():
    got = set(scope_hts(DEFERRED_APPENDIX))
    assert {"7202211000", "7202215000", "7202217500", "7202219000", "7202290010", "7202290050"} <= got, got


HEADER_SHARED = """
Federal Register, Volume 90


DEPARTMENT OF COMMERCE

International Trade Administration

[A-351-860, A-834-812, A-557-828]


Ferrosilicon From Malaysia: Amended Final Determination; Ferrosilicon From
Brazil, Kazakhstan, and Malaysia: Antidumping Duty Orders
"""

HEADER_UNRELATED = """
Federal Register, Volume 66


DEPARTMENT OF COMMERCE

International Trade Administration

[A-560-811; A-455-803; A-823-809; A-822-804, A-570-860, A-580-844]


Antidumping Duty Orders: Steel Concrete Reinforcing Bars From Several Countries

    ... later in the body, an unrelated footnote happens to cite A-351-860
    as a companion proceeding, which must not be read as this document
    being about that case.
"""

HEADER_MISSING = "Some old-format document with no bracketed case-number header at all."


@check("own-case: a case listed in the header bracket (singly or in a combined notice) is recognised as this document's own")
def _():
    assert _own_case(HEADER_SHARED, "A-351-860") is True
    assert _own_case(HEADER_SHARED, "A-834-812") is True


@check("own-case: a case merely mentioned in body text, absent from the header bracket, is rejected — not a false match")
def _():
    assert _own_case(HEADER_UNRELATED, "A-351-860") is False, (
        "a footnote citing an unrelated case number was read as this document being about it")


@check("own-case: a document with no header bracket at all returns 'unknown', not a false negative")
def _():
    assert _own_case(HEADER_MISSING, "A-351-860") is None


NO_HEADER_WITH_SCOPE = (HEADER_MISSING +
                        "\n\nScope of the Order\n\n    The products covered are steel "
                        "widgets, classified under HTSUS subheading 7317.00.5502.\n")
CONFIRMED_WITH_SCOPE = (HEADER_SHARED +
                        "\n\nScope of the Order\n\n    The products covered are steel "
                        "widgets, classified under HTSUS subheading 7317.00.5502.\n")


@check("candidates: an unconfirmable header is never accepted on its scope text alone — a miss beats a wrong match")
def _():
    docs = {"unheaded": NO_HEADER_WITH_SCOPE}
    original = adcvd_mod._get
    adcvd_mod._get = lambda url, retries=3: docs[url]
    try:
        d = {"results": [{"title": "Antidumping Duty Order", "publication_date": "2020-01-01",
                          "document_number": "1", "raw_text_url": "unheaded"}]}
        # Rejected outright: a header-less notice must never be trusted on scope text alone,
        # regardless of how confidently it matches -- fail closed, not a guess.
        assert _try_candidates(d, "A-351-860") is None
    finally:
        adcvd_mod._get = original


@check("candidates: a later, confirmed-header notice is used when an earlier unconfirmable one is skipped")
def _():
    docs = {"unheaded": NO_HEADER_WITH_SCOPE, "confirmed": CONFIRMED_WITH_SCOPE}
    original = adcvd_mod._get
    adcvd_mod._get = lambda url, retries=3: docs[url]
    try:
        d = {"results": [
            {"title": "Antidumping Duty Order", "publication_date": "2020-01-01",
             "document_number": "1", "raw_text_url": "unheaded"},
            {"title": "Antidumping Duty Order", "publication_date": "2019-01-01",
             "document_number": "2", "raw_text_url": "confirmed"},
        ]}
        got = _try_candidates(d, "A-351-860")
        assert got is not None and got["source"] == "2", got
        assert "7317005502" in got["hts"], got
    finally:
        adcvd_mod._get = original


@check("rank: a correction notice never outranks the order it corrects, even reusing its exact phrase")
def _():
    order = "Antidumping Duty Order on Hydrofluorocarbon Blends From the People's Republic of China"
    correction = ("White Grape Juice Concentrate From Argentina: Preliminary Affirmative Countervailing "
                  "Duty Determination and Alignment of Final Determination With the Final Antidumping "
                  "Duty Determination; Correction")
    assert _rank(order) == 0
    assert _rank(correction) > _rank(order), (correction, _rank(correction))


@check("rank: a circumvention finding never outranks the order, though its title contains 'duty order'")
def _():
    circumvention = ("Antidumping Duty Order on Hydrofluorocarbon Blends From the People's Republic of "
                      "China: Final Negative Determination of Circumvention With Respect to Certain Blends")
    assert _rank(circumvention) > 0, circumvention


@check("rank: a suspension agreement notice ranks with the order — it is the order-equivalent document")
def _():
    assert _rank("White Grape Juice Concentrate From Argentina: Suspension of Countervailing Duty Investigation") == 0


@check("rank: an 'opportunity to request review' monthly notice is excluded even with a typo dodging the exact-prefix check")
def _():
    # A real Federal Register title (99-14629): "Antidumping *of* Countervailing
    # Duty Order..." where the standard text says "or" — MONTHLY_TITLE's exact
    # prefix match misses it, and unguarded it would satisfy the "duty order"
    # phrase and get wrongly promoted to rank 0.
    typo = "Antidumping of Countervailing Duty Order, Finding, or Suspended Investigation; Opportunity To Request Administrative Review"
    assert _rank(typo) == 9, typo


@check("rank: a title that only mentions a review in passing, while imposing or continuing the order itself, still ranks with the order")
def _():
    order = ("Fresh Tomatoes From Mexico: Termination of Suspension Agreement, Rescission of "
              "Administrative Reviews, and Imposition of an Antidumping Duty Order")
    assert _rank(order) == 0, order


@check("rank: a notice that IS a review — its own preliminary/final results, or its own initiation — still never ranks with the order")
def _():
    for title in (
        "Certain In-shell Pistachios from the Islamic Republic of Iran: Preliminary Results of Countervailing Duty Administrative Review",
        "Twist Ties From People's Republic of China: Final Results of the Expedited First Sunset Review of the Countervailing Duty Order",
        "Oil Country Tubular Goods From Ukraine: Preliminary Results of the First Five-Year Sunset Review of the Antidumping Duty Order",
        "Initiation of Antidumping and Countervailing Duty Administrative Reviews",
    ):
        assert _rank(title) > 0, title


@check("rank: a scope clarification is tried early even when its title omits the order's own phrasing")
def _():
    # Most real clarification titles repeat "... Antidumping Duty Order" and
    # already rank with the order itself (fine — both are genuine
    # scope-bearing candidates). This checks the branch that catches a
    # clarification phrased without that, which would otherwise fall all the
    # way to the bottom tier alongside an ordinary administrative notice.
    bare = "Certain Widgets From Elsewhere: Clarification of the Scope"
    assert _rank(bare) == 1, bare
    assert _rank(bare) < _rank("Certain Widgets From Elsewhere: Final Results of Administrative Review")


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


@real("real orders: fresh tomatoes from Mexico are matched — the bare-heading scope_hts fallback, end to end")
def _():
    code = next(l.hts for l in E.tree.leaves if l.hts.startswith("0702.00"))
    r = E.quote(hts=code, country="Mexico", value=10000)
    assert any(o["case"] == "A-201-820" for o in r.adcvd), [o["case"] for o in r.adcvd]


@real("real orders: twist ties and petroleum wax candles from China are matched — the product-name search fallback, end to end")
def _():
    code = next(l.hts for l in E.tree.leaves if l.hts.startswith("8309.90"))
    r = E.quote(hts=code, country="China", value=10000)
    assert any(o["case"] == "C-570-132" for o in r.adcvd), [o["case"] for o in r.adcvd]
    code = next(l.hts for l in E.tree.leaves if l.hts.startswith("3406.00"))
    r = E.quote(hts=code, country="China", value=10000)
    assert any(o["case"] == "A-570-504" for o in r.adcvd), [o["case"] for o in r.adcvd]


@real("real orders: an ordinary garment is not flagged, and every order carries an ISO country")
def _():
    r = E.quote(hts="6109.10.00.12", country="China", value=10000)
    assert not r.adcvd and r.adcvd_checked is True
    data = json.loads(DATA.read_text())
    assert len(data["orders"]) > 400, len(data["orders"])
    assert all(o.get("iso") for o in data["orders"]), [o["country"] for o in data["orders"] if not o.get("iso")]
    with_hts = sum(1 for o in data["orders"] if o["hts"])
    assert with_hts / len(data["orders"]) > 0.95, f"only {with_hts} of {len(data['orders'])} orders list HTS numbers"


def _write(dir_, name, obj):
    p = Path(dir_) / name
    p.write_text(json.dumps(obj))
    return p


def _orders(n, with_hts_frac=1.0):
    return {"orders": [{"case": f"A-000-{i:03d}", "country": "China",
                        "hts": ["1234567890"] if i < n * with_hts_frac else []}
                       for i in range(n)]}


@check("refresh: an unreadable or empty AD/CVD output is rejected")
def _():
    with tempfile.TemporaryDirectory() as d:
        bad = _write(d, "bad.json", {"orders": []})
        assert validate_adcvd(bad, Path(d) / "missing.json") is not None
        garbage = Path(d) / "garbage.json"
        garbage.write_text("not json")
        assert validate_adcvd(garbage, Path(d) / "missing.json") is not None


@check("refresh: fewer orders than the floor is rejected, even with no previous file to compare")
def _():
    with tempfile.TemporaryDirectory() as d:
        new = _write(d, "new.json", _orders(MIN_ADCVD_ORDERS - 1))
        problem = validate_adcvd(new, Path(d) / "missing.json")
        assert problem and str(MIN_ADCVD_ORDERS) in problem, problem


@check("refresh: a collapsed HTS-resolution ratio is rejected even with enough orders")
def _():
    with tempfile.TemporaryDirectory() as d:
        new = _write(d, "new.json", _orders(MIN_ADCVD_ORDERS + 100, with_hts_frac=0.5))
        problem = validate_adcvd(new, Path(d) / "missing.json")
        assert problem and "HTS list" in problem, problem


@check("refresh: a real drop from the previous count is rejected; a good file with no previous is not")
def _():
    with tempfile.TemporaryDirectory() as d:
        prev = _write(d, "prev.json", _orders(700))
        shrunk = _write(d, "shrunk.json", _orders(500))          # < 90% of 700
        assert validate_adcvd(shrunk, prev) is not None
        steady = _write(d, "steady.json", _orders(650))          # >= 90% of 700
        assert validate_adcvd(steady, prev) is None
        assert validate_adcvd(prev, Path(d) / "missing.json") is None


@check("refresh: a corrupt previous file cannot block a good new one")
def _():
    with tempfile.TemporaryDirectory() as d:
        prev = Path(d) / "prev.json"
        prev.write_text("not json")
        new = _write(d, "new.json", _orders(MIN_ADCVD_ORDERS + 100))
        assert validate_adcvd(new, prev) is None


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
