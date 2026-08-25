"""API contract and security-regression tests.

Every control here corresponds to a defect found in audit. They exist so the
defects cannot come back: an unbounded audit request occupied a worker for
fourteen minutes, unbounded `limit` parameters returned whole tables, and
unhandled exceptions echoed Python type names to callers.

Runs against a live API. Start one first:
    TARIFFWISE_API_KEYS=testkey python3 -m uvicorn api.main:app --port 8099
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("TARIFFWISE_TEST_API", "http://127.0.0.1:8099")
KEY = os.environ.get("TARIFFWISE_TEST_KEY", "testkey123")

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


def items(n, desc="cotton knitted t-shirt"):
    return {"items": [{"sku": f"S{i}", "description": desc,
                       "country": "China", "value": 100} for i in range(n)]}


# ------------------------------------------------------------------- contract

@check("health reports counts and reasoning state")
def _():
    s, d = call("/api/health")
    assert s == 200, s
    assert d["counts"]["hts"] > 19_000, d["counts"]
    assert "reasoning_enabled" in d


@check("hts detail returns a priced duty stack")
def _():
    s, d = call("/api/hts/6109.10.00.12?country=China")
    assert s == 200, s
    assert d["quote"]["total_duty"] > 0
    assert any(c["authority"] for c in d["quote"]["components"]), "components must cite authority"


@check("unknown hts code is a clean 404")
def _():
    s, d = call("/api/hts/0000.00.00.00")
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


@check("audit: a key raises the ceiling and truncation is disclosed")
def _():
    s, d = call("/api/audit", method="POST", body=items(400), key=KEY)
    assert s == 200, s
    su = d["summary"]
    assert su["submitted"] == 400
    if su["truncated"]:
        assert su["items"] < su["submitted"], su
        assert su["items"] > 0


@check("audit: an invalid key is treated as anonymous")
def _():
    s, _ = call("/api/audit", method="POST", body=items(40), key="not-a-real-key")
    assert s == 413, s


@check("search limit cannot exceed its bound")
def _():
    s, _ = call("/api/search?q=cotton&limit=99999999")
    assert s == 422, s


@check("changes limit and window are bounded")
def _():
    assert call("/api/changes?limit=99999999")[0] == 422
    assert call("/api/changes?days=-5")[0] == 422


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
        s, d = call("/api/search?" + urllib.parse.urlencode({"q": q}))
        assert s in (200, 422), (q, s)
        assert "sqlite_master" not in json.dumps(d.get("results", [])), q


@check("path traversal is not routed")
def _():
    s, _ = call("/api/hts/..%2F..%2Fetc%2Fpasswd")
    assert s == 404, s


@check("changes feed excludes documents that merely mention a term")
def _():
    s, d = call("/api/changes?days=120&limit=100")
    assert s == 200, s
    assert all(c["tariff_action"] for c in d["changes"]), "unfiltered document surfaced"
    # Searching the Register for tariff terms returns FTZ notices, agency
    # meetings and council memberships; none belong in a rate-change feed.
    bad = [c["title"] for c in d["changes"]
           if any(w in c["title"].lower()
                  for w in ("foreign-trade zone", "sunshine act",
                            "information collection", "membership adjustment"))]
    assert not bad, bad[:3]


@check("security headers are present")
def _():
    req = urllib.request.Request(f"{BASE}/api/health")
    with urllib.request.urlopen(req, timeout=30) as r:
        h = {k.lower(): v for k, v in r.headers.items()}
    for want in ("x-content-type-options", "x-frame-options", "referrer-policy"):
        assert want in h, f"missing {want}"


def main() -> int:
    s, _ = call("/api/health")
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
