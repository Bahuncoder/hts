"""API contract and security-regression tests.

Every control here corresponds to a defect found in audit. They exist so the
defects cannot come back: an unbounded audit request occupied a worker for
fourteen minutes, unbounded `limit` parameters returned whole tables, and
unhandled exceptions echoed Python type names to callers.

Runs against a live API. Start one first:
    HTSDESK_API_KEYS=testkey python3 -m uvicorn api.main:app --port 8099
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("HTSDESK_TEST_API", "http://127.0.0.1:8099")
KEY = os.environ.get("HTSDESK_TEST_KEY", "testkey123")

_results: list[tuple[str, str, str]] = []


def call(path: str, *, method="GET", body=None, key=None, timeout=120):
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    if key:
        req.add_header("x-api-key", key)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return e.code, {"raw": raw[:200].decode(errors="replace")}


def check(name):
    def wrap(fn):
        try:
            fn()
            _results.append((name, "pass", ""))
        except AssertionError as exc:
            _results.append((name, "FAIL", str(exc) or "assertion failed"))
        except Exception as exc:
            _results.append((name, "ERROR", f"{type(exc).__name__}: {exc}"))
        return fn
    return wrap


def headers_of(path: str) -> dict[str, str]:
    """Response headers, authenticated — a header assertion should not compete
    with the tests that deliberately exhaust the anonymous budget."""
    req = urllib.request.Request(f"{BASE}{path}")
    req.add_header("x-api-key", KEY)
    with urllib.request.urlopen(req, timeout=30) as r:
        return {k.lower(): v for k, v in r.headers.items()}


def items(n, desc="cotton knitted t-shirt"):
    return {"items": [{"sku": f"S{i}", "description": desc,
                       "country": "China", "value": 100} for i in range(n)]}


# ------------------------------------------------------------------- contract

@check("hts detail returns a priced duty stack")
def _():
    s, d = call("/api/hts/6109.10.00.12?country=China", key=KEY)
    assert s == 200, s
    assert d["quote"]["total_duty"] > 0
    assert any(c["authority"] for c in d["quote"]["components"]), "components must cite authority"


@check("unknown hts code is a clean 404")
def _():
    s, d = call("/api/hts/0000.00.00.00", key=KEY)
    assert s == 404, s


@check("classify returns candidates carrying precedent")
def _():
    s, d = call("/api/classify?" + urllib.parse.urlencode({"q": "nylon backpack with zipper"}), key=KEY)
    assert s == 200, s
    assert d["candidates"], "expected candidates"
    assert d["candidates"][0]["hts"].startswith("4202"), d["candidates"][0]["hts"]


@check("quote rejects a non-leaf heading")
def _():
    s, _ = call("/api/quote", method="POST",
                body={"hts": "6109", "country": "China", "value": 1000}, key=KEY)
    assert s == 400, s


# ------------------------------------------------------- security regressions

@check("audit: anonymous catalogue is capped at 25 items")
def _():
    s, d = call("/api/audit", method="POST", body=items(40))
    assert s == 413, s
    assert "API key" in json.dumps(d), d


@check("audit: 5000 items rejected fast, not processed for 14 minutes")
def _():
    s, _ = call("/api/audit", method="POST", body=items(5000), key=KEY, timeout=30)
    assert s == 422, s


@check("audit: a key raises the ceiling; every row comes back, truncation disclosed")
def _():
    s, d = call("/api/audit", method="POST", body=items(400), key=KEY)
    assert s == 200, s
    su = d["summary"]
    assert su["submitted"] == 400
    # Unprocessed rows are returned and labelled, never silently dropped.
    assert su["items"] == su["submitted"] == len(d["lines"]), su
    if su["truncated"]:
        assert su["processed"] < su["submitted"], su
        assert su["by_status"]["not_processed"] == su["submitted"] - su["processed"], su
        assert su["totals_complete"] is False, "a partial total must say it is partial"


@check("audit: an invalid key is treated as anonymous")
def _():
    s, _ = call("/api/audit", method="POST", body=items(40), key="not-a-real-key")
    assert s == 413, s


@check("search limit cannot exceed its bound")
def _():
    s, _ = call("/api/search?q=cotton&limit=99999999", key=KEY)
    assert s == 422, s


@check("changes limit and window are bounded")
def _():
    assert call("/api/changes?limit=99999999", key=KEY)[0] == 422
    assert call("/api/changes?days=-5", key=KEY)[0] == 422


@check("oversized text fields are rejected")
def _():
    s, _ = call("/api/quote", method="POST",
                body={"hts": "6109.10.00.12", "country": "A" * 10_000, "value": 100}, key=KEY)
    assert s == 422, s


@check("value overflow is rejected before Decimal sees it")
def _():
    s, d = call("/api/quote", method="POST",
                body={"hts": "6109.10.00.12", "country": "China", "value": 1e308}, key=KEY)
    assert s == 422, s
    assert "InvalidOperation" not in json.dumps(d), "internal exception type leaked"


@check("sql and fts injection do not escape parameterisation")
def _():
    for q in ["x' UNION SELECT name FROM sqlite_master--", '" OR "1"="1', "*"]:
        s, d = call("/api/search?" + urllib.parse.urlencode({"q": q}), key=KEY)
        assert s in (200, 422), (q, s)
        assert "sqlite_master" not in json.dumps(d.get("results", [])), q


@check("path traversal is not routed")
def _():
    s, _ = call("/api/hts/..%2F..%2Fetc%2Fpasswd", key=KEY)
    assert s == 404, s


@check("changes feed excludes documents that merely mention a term")
def _():
    s, d = call("/api/changes?days=120&limit=100", key=KEY)
    assert s == 200, s
    assert all(c["tariff_action"] for c in d["changes"]), "unfiltered document surfaced"
    # Searching the Register for tariff terms returns FTZ notices, agency
    # meetings and council memberships; none belong in a rate-change feed.
    bad = [c["title"] for c in d["changes"]
           if any(w in c["title"].lower()
                  for w in ("foreign-trade zone", "sunshine act",
                            "information collection", "membership adjustment"))]
    assert not bad, bad[:3]


@check("interactive docs and schema are not published")
def _():
    for path in ("/docs", "/redoc", "/openapi.json"):
        code, _ = call(path, key=KEY)
        assert code == 404, f"{path} returned {code} — the whole API surface is mapped"


@check("health tells an anonymous caller only that it is alive")
def _():
    code, body = call("/api/health")
    # 429 means the anonymous budget is spent, which is also correct behaviour
    # and not what this test is about.
    if code == 429:
        return
    assert code == 200, code
    assert body == {"status": "ok"}, body
    assert "counts" not in body, "row counts disclosed without a key"
    assert "reasoning_enabled" not in body, "code path disclosed without a key"


@check("health gives operational detail to a keyed caller")
def _():
    code, body = call("/api/health", key=KEY)
    assert code == 200, code
    assert body["counts"]["hts"] > 19_000, body


@check("our own build is not throttled by its key")
def _():
    code, body = call("/api/sitemap?chunk=0&size=10000", key=KEY)
    assert code == 200, code
    assert len(body["codes"]) == 10_000, len(body["codes"])


@check("the server does not advertise its stack")
def _():
    server = headers_of("/api/health").get("server")
    assert not server, f"Server header present: {server!r}"


@check("security headers are present")
def _():
    h = headers_of("/api/health")
    for want in ("x-content-type-options", "x-frame-options", "referrer-policy"):
        assert want in h, f"missing {want}"


# Runs last on purpose: it spends the anonymous budget, and anything
# anonymous after it would fail for the wrong reason.
@check("bulk enumeration endpoints are metered")
def _():
    # A hundred chunks of ten thousand walks the whole schedule.
    limited = False
    for _ in range(140):
        code, _body = call("/api/sitemap?chunk=0&size=100")
        if code == 429:
            limited = True
            break
    assert limited, "sitemap accepts unlimited anonymous calls"


# ---------------------------------------------- calculation integrity (audit)

def _audit(rows, **kw):
    s, d = call("/api/audit", method="POST", body={"items": rows, **kw}, key=KEY)
    assert s == 200, (s, d)
    return d


@check("audit: an invalid HTS code is an error line, not a priced one")
def _():
    d = _audit([{"sku": "X", "description": "junk", "country": "Vietnam",
                 "value": 10000, "hts": "NOT-A-CODE"}])
    ln = d["lines"][0]
    assert ln["status"] == "error" and ln["error_code"] == "invalid_code", ln
    assert "duty" not in ln, "an unresolvable code must not carry a duty figure"
    assert d["summary"]["priced"] == 0 and d["summary"]["duty"] == 0, d["summary"]


@check("audit: origin spelling cannot change the duty")
def _():
    rows = [{"sku": n, "description": "tee", "country": c, "value": 10000,
             "hts": "6109.10.00.12"} for n, c in
            (("a", "China"), ("b", "CN"), ("c", "PRC"), ("d", "china"))]
    duties = {ln["duty"] for ln in _audit(rows)["lines"]}
    assert len(duties) == 1, f"the same origin priced {len(duties)} ways: {duties}"


@check("audit: an unrecognised origin is refused, not priced as ordinary")
def _():
    ln = _audit([{"sku": "t", "description": "tee", "country": "Chnia",
                  "value": 10000, "hts": "6109.10.00.12"}])["lines"][0]
    assert ln["status"] == "error" and ln["error_code"] == "invalid_country", ln


@check("audit: one bad row cannot reject or hide its neighbours")
def _():
    rows = [
        {"row": 7, "sku": "ok", "description": "tee", "country": "Vietnam",
         "value": 100, "hts": "6109.10.00.12"},
        {"row": 9, "sku": "bad", "description": "tee", "country": "Vietnam",
         "value": 0, "hts": "6109.10.00.12"},
    ]
    d = _audit(rows)
    assert [ln["row"] for ln in d["lines"]] == [7, 9], "row numbers must round-trip"
    assert d["lines"][1]["status"] == "error", d["lines"][1]
    su = d["summary"]
    assert su["submitted"] == su["items"] == 2 and su["priced"] == 1, su
    assert su["unresolved"] >= 1 and su["totals_complete"] is False, su


@check("audit: MPF is charged per entry, not per line")
def _():
    rows = [{"sku": str(i), "description": "tee", "country": "Vietnam",
             "value": 100, "hts": "6109.10.00.12"} for i in range(10)]
    su = _audit(rows)["summary"]
    assert su["mpf"] == 33.58, f"ten $100 lines on one entry pay one minimum, got {su['mpf']}"
    su5 = _audit(rows, entries=5)["summary"]
    assert su5["mpf"] == round(5 * 33.58, 2), su5["mpf"]
    assert any("entr" in a for a in su["assumptions"]), "the entry assumption must be stated"


@check("audit: every summary carries the dataset revision")
def _():
    su = _audit([{"sku": "1", "description": "tee", "country": "Vietnam",
                  "value": 100, "hts": "6109.10.00.12"}])["summary"]
    assert "dataset_revision" in su, su


@check("quote: junk code, junk origin and digits-only codes")
def _():
    s, _b = call("/api/quote", method="POST",
                 body={"hts": "NOT-A-CODE", "country": "China", "value": 100}, key=KEY)
    assert s in (400, 404), s
    s, _b = call("/api/quote", method="POST",
                 body={"hts": "6109.10.00.12", "country": "Zzz", "value": 100}, key=KEY)
    assert s == 400, s
    s, a = call("/api/quote", method="POST",
                body={"hts": "6109100012", "country": "CN", "value": 10000}, key=KEY)
    s2, b = call("/api/quote", method="POST",
                 body={"hts": "6109.10.00.12", "country": "China", "value": 10000}, key=KEY)
    assert s == s2 == 200 and a["total_duty"] == b["total_duty"], (a, b)


@check("hts page: an unrecognised origin is a 400, not a 500")
def _():
    s, _b = call("/api/hts/6109.10.00.12?country=Zzz", key=KEY)
    assert s == 400, s


@check("health: a keyed caller sees index coverage and engine/reference agreement")
def _():
    s, d = call("/api/health", key=KEY)
    assert s == 200
    for k in ("dataset_revision", "engine_current", "index", "index_complete"):
        assert k in d, f"health is missing {k}"
    assert d["index"]["rulings_indexed"] == d["index"]["rulings"], d["index"]


@check("changes: cursor paging returns every document once")
def _():
    s, big = call("/api/changes?since=2026-01-01&limit=2000", key=KEY)
    seen, cur = [], None
    for _ in range(2000):
        path = "/api/changes?limit=7" + (f"&cursor={cur}" if cur else "&since=2026-01-01")
        s, d = call(path, key=KEY)
        assert s == 200
        seen += [x["document_number"] for x in d["changes"]]
        if not d["has_more"]:
            break
        cur = d["next_cursor"]
    assert seen == [x["document_number"] for x in big["changes"]], "paging skipped or repeated documents"
    assert call("/api/changes?cursor=nope", key=KEY)[0] == 400
    assert call("/api/changes?since=nope", key=KEY)[0] == 400


@check("hts page: remedies say whether they cover the origin being viewed")
def _():
    s, cn = call("/api/hts/6109.10.00.12?country=China", key=KEY)
    s2, ca = call("/api/hts/6109.10.00.12?country=Canada", key=KEY)
    assert s == s2 == 200
    def by_head(d):
        return {r["heading"]: r["applies_to_origin"] for r in d["trade_remedies"]}
    a, b = by_head(cn), by_head(ca)
    assert a and a == {h: a[h] for h in a}, a
    assert a["9903.88.15"] is True and a["9903.03.12"] is False, a
    assert b["9903.03.12"] is True and b["9903.88.15"] is False, b


@check("audit: a China apparel line is complete and states the assumption its duty rests on")
def _():
    d = _audit([{"sku": "T", "description": "cotton tee", "country": "China",
                 "value": 10000, "hts": "6109.10.00.12"}])
    ln = d["lines"][0]
    assert ln["status"] == "ready", (ln["status"], ln["review_reasons"])
    assert any("note 52" in a for a in ln["assumptions"]), ln["assumptions"]
    assert any("note 52" in a for a in d["summary"]["assumptions"]), d["summary"]["assumptions"]
    assert d["summary"]["totals_complete"] is True, d["summary"]


@check("audit: metals and vehicles are never presented as ready")
def _():
    d = _audit([{"sku": "S", "description": "bolt", "country": "China", "value": 1000, "hts": "7318.15.20.00"},
                {"sku": "V", "description": "car", "country": "Vietnam", "value": 1000, "hts": "8703.23.01.90"}])
    assert all(ln["status"] != "ready" for ln in d["lines"]), [ln["status"] for ln in d["lines"]]


def main() -> int:
    # Authenticated: the anonymous budget may already be spent by the very
    # tests below, and a reachability probe should not compete with them.
    s, _ = call("/api/health", key=KEY)
    if s != 200:
        print(f"API not reachable at {BASE}. Start it first.")
        return 2
    width = max(len(n) for n, _, _ in _results)
    failed = 0
    for name, status, detail in _results:
        print(f"  {'ok  ' if status == 'pass' else 'FAIL'}  {name.ljust(width)}")
        if status != "pass":
            failed += 1
            print(f"        {detail[:160]}")
    print(f"\n{len(_results) - failed}/{len(_results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
