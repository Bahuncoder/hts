"""Antidumping and countervailing duty orders in effect, from the Federal Register.

AD/CVD duties are imposed per order, on a product from a country, at rates that
differ by exporter (a cash deposit that the importer pays at entry). Commerce
publishes each month a notice listing every order whose anniversary falls in
that month ("Antidumping or Countervailing Duty Order, Finding, or Suspended
Investigation; Opportunity To Request Administrative Review"); the twelve most
recent together are the orders in effect. Each order's scope, with the HTS
subheadings Commerce lists for convenience, is read from its most recent notice.

What this gives a quote is a flag, never a figure: which orders may reach this
product from this country. The duty itself depends on the exporter and is not
computed. An HTS list in a scope is "for convenience; the written description is
dispositive", so a product an order covers but does not list can be missed; the
flag says an order may apply, and its absence is not proof that none does.

    python3 -m ingest.adcvd data/adcvd_orders.json
"""
from __future__ import annotations

import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

API = "https://www.federalregister.gov/api/v1/documents.json"
MONTHLY_TITLE = "Antidumping or Countervailing Duty Order, Finding, or Suspended Investigation"
CASE = re.compile(r"\b([ACE])-\s*(\d{3})-\s*(\d{3})\b")
_LEADERS = re.compile(r"\.{2,}")
_PERIOD = re.compile(r"\d{1,2}/\d{1,2}/\d{2}\s*-\s*\d{1,2}/\d{1,2}/\d{2}")
_PAGE = re.compile(r"\[\[Page \d+\]\]")
_COUNTRY = re.compile(r"(?<![A-Za-z])([A-Z][A-Z'’\-\. ,\[\]a-z;&]{2,70}?):\s")


_COUNTRY_ALIASES = {
    "PEOPLE'S REPUBLIC OF CHINA": "CN", "SOCIALIST REPUBLIC OF VIETNAM": "VN", "SOCIALIST OF VIETNAM": "VN",
    "REPUBLIC OF TURKIYE": "TR", "RUPUBLIC OF KOREA": "KR", "REPUBLIC OF KOREA": "KR",
    "UNITED KINGDOM": "GB", "NETHERLANDS": "NL", "REPUBLIC OF KAZAKHSTAN": "KZ",
}


def country_iso(name: str) -> str | None:
    """ISO code for a country as the Federal Register prints it ("THE PEOPLE'S
    REPUBLIC OF CHINA", "REPUBLIC OF T[Uuml]RKIYE")."""
    from core.countries import country_code
    n = re.sub(r"\[Uuml\]", "U", name or "").strip()
    n = re.sub(r"^THE\s+", "", n)
    if n in _COUNTRY_ALIASES:
        return _COUNTRY_ALIASES[n]
    return country_code(n.title())


def _get(url: str, retries: int = 3) -> str:
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                return r.read().decode("utf8", "ignore")
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("unreachable")


def _search(**params) -> dict:
    return json.loads(_get(API + "?" + urllib.parse.urlencode(params, doseq=True)))


def monthly_notices(today: date | None = None, months: int = 13) -> list[dict]:
    """The order-list notices of the last `months` months, newest first."""
    since = ((today or date.today()) - timedelta(days=31 * months)).isoformat()
    found: list[dict] = []
    for page in range(1, 6):
        d = _search(per_page=100, page=page, order="newest", **{
            "conditions[term]": '"Opportunity To Request Administrative Review"',
            "conditions[agencies][]": "international-trade-administration",
            "conditions[type][]": "NOTICE",
            "conditions[publication_date][gte]": since,
            "fields[]": ["title", "publication_date", "document_number", "raw_text_url"]})
        found += [r for r in d["results"] if r["title"].startswith(MONTHLY_TITLE)]
        if page >= d.get("total_pages", 1):
            break
    return found


def _plain(raw: str) -> str:
    text = re.sub(r"<[^>]+>", "", raw)
    return html.unescape(text)


def parse_list(text: str) -> list[dict]:
    """(kind, country, product, case) for every order in one monthly notice."""
    body = _plain(text)
    out: list[dict] = []
    for kind, marker in (("AD", "Antidumping Duty Proceedings"),
                         ("CVD", "Countervailing Duty Proceedings"),
                         ("AD", "Suspension Agreements")):
        i = body.find(marker)
        if i < 0:
            continue
        start = i + len(marker)
        stops = [body.find(m, start) for m in ("Countervailing Duty Proceedings",
                                                 "Suspension Agreements",
                                                 "Antidumping Duty Proceedings")]
        stops = [s for s in stops if s > 0]
        section = body[i + len(marker):min(stops) if stops else len(body)]
        section = _PAGE.sub(" ", section)
        section = _LEADERS.sub(" ", section)
        section = _PERIOD.sub(" ", section)
        country, pos = "", 0
        for m in CASE.finditer(section):
            chunk = section[pos:m.start()]
            pos = m.end()
            heads = _COUNTRY.findall(chunk)
            for h in heads:
                letters = re.sub(r"\[[A-Za-z]+\]", "", h)
                if letters.upper() == letters:
                    country = h.strip()
            product = re.sub(r"\s+", " ", _COUNTRY.sub(" ", chunk)).strip(" ,:;.")
            if product:
                out.append({"kind": "CVD" if m.group(1) == "C" else "AD", "country": country,
                            "product": product, "case": f"{m.group(1)}-{m.group(2)}-{m.group(3)}"})
    return out


_HTS_DOTTED = re.compile(r"\b(\d{4}\.\d{2}(?:\.\d{2,4}(?:\.\d{2})?)?)\b")
_HEADING_WORD = re.compile(
    r"\b(?:sub)?headings?\s+((?:\d{4}(?:\.\d{2}){0,3}(?:\s*(?:,|and|or|through)\s*)?)+)", re.I)
_SCOPE_HEAD = re.compile(r"\n\s*Scope of the (?:Order|Orders|Antidumping Duty Order|Countervailing Duty Order)[^\n]*\n")
_SCOPE_END = re.compile(
    r"\n\s*(?:Scope Comments|Scope Rulings|Analysis of Comments|Discussion of the Issues|"
    r"Determination|Product Characteristics|Verification|Final Results|Preliminary Results|"
    r"Affiliation|Applicable|Methodology|Use of|Date of|Period of|Final Determination)\b")


def scope_hts(text: str) -> list[str]:
    """HTS subheadings listed in a notice's scope section, as digit prefixes.
    Only dotted numbers and numbers after the word "heading" count, so page
    numbers and dollar figures are not read as codes."""
    body = _plain(text)
    codes: set[str] = set()
    # A notice often summarises the scope in its body and gives the full text,
    # with the HTS list, in an appendix; every scope section counts.
    for m in _SCOPE_HEAD.finditer(body):
        part = body[m.end():m.end() + 30_000]
        end = _SCOPE_END.search(part, 40)
        if end:
            part = part[:end.start()]
        codes |= {c.replace(".", "") for c in _HTS_DOTTED.findall(part)}
        for w in _HEADING_WORD.finditer(part):
            codes |= {c.replace(".", "") for c in re.findall(r"\d{4}(?:\.\d{2}){0,3}", w.group(1))}
    if not codes:
        # No scope heading carries the list: take dotted numbers that follow a
        # mention of the tariff schedule ("classifiable under HTSUS ...").
        for m in re.finditer(r"HTSUS|Harmonized Tariff Schedule", body):
            codes |= {c.replace(".", "") for c in _HTS_DOTTED.findall(body[m.end():m.end() + 1500])}
    return sorted(c for c in codes if not c.startswith(("98", "99")))


def _rank(title: str) -> int:
    t = title.lower()
    if t.startswith(MONTHLY_TITLE.lower()):
        return 9
    if "continuation of" in t or re.search(r"(?:antidumping|countervailing) duty order", t) and "review" not in t:
        return 0
    if "preliminary" in t and "review" in t or "amended final" in t or "final determination" in t:
        return 1
    if "final results" in t:
        return 2
    return 5


def latest_scope(case: str) -> dict | None:
    """HTS list from the best recent notice that quotes this case's scope: the
    order or its continuation, else a preliminary or final review."""
    d = _search(per_page=30, order="newest", **{
        "conditions[term]": f'"{case}"',
        "conditions[agencies][]": "international-trade-administration",
        "conditions[type][]": "NOTICE",
        "fields[]": ["title", "publication_date", "document_number", "raw_text_url"]})
    cands = sorted((r for r in d.get("results", []) if _rank(r["title"]) < 9),
                   key=lambda r: (_rank(r["title"]), -int(r["publication_date"].replace("-", ""))))
    first = None
    for r in cands[:4]:
        hts = scope_hts(_get(r["raw_text_url"]))
        got = {"source": r["document_number"], "source_date": r["publication_date"],
               "title": r["title"][:140], "hts": hts}
        first = first or got
        if hts:
            return got
    return first


REUSE_DAYS = 180


def build(today: date | None = None, previous: dict | None = None) -> dict:
    """Every order in effect with its scope's HTS list. A case already read in
    `previous` within REUSE_DAYS keeps its list, so a routine refresh reads only
    the monthly notices and any new order."""
    now = today or date.today()
    known = {o["case"]: o for o in (previous or {}).get("orders", [])}
    orders: dict[str, dict] = {}
    notices = monthly_notices(now)
    for n in notices:
        for o in parse_list(_get(n["raw_text_url"])):
            orders.setdefault(o["case"], {**o, "listed_in": n["document_number"]})
    for i, (case, o) in enumerate(sorted(orders.items())):
        old = known.get(case)
        if old and old.get("fetched") and not old.get("error") and (
                now - date.fromisoformat(old["fetched"])).days < REUSE_DAYS and (
                old.get("hts") or old.get("source")):
            o.update({k: old.get(k) for k in ("source", "source_date", "title", "hts", "fetched")})
            continue
        try:
            scope = latest_scope(case)
        except Exception as exc:                 # one bad case must not lose the rest
            scope = {"source": None, "source_date": None, "hts": [], "error": str(exc)[:120]}
        o.update(scope or {"source": None, "source_date": None, "hts": []})
        o["fetched"] = now.isoformat()
        if i % 50 == 0:
            print(f"  {i}/{len(orders)} scopes read", file=sys.stderr)
    for o in orders.values():
        o["iso"] = country_iso(o["country"])
    return {"generated": now.isoformat(),
            "notices": [n["document_number"] for n in notices],
            "orders": sorted(orders.values(), key=lambda o: (o["country"], o["case"]))}


def main(argv: list[str]) -> int:
    previous = None
    if len(argv) > 2 and Path(argv[2]).exists():
        previous = json.loads(Path(argv[2]).read_text())
    data = build(previous=previous)
    Path(argv[1]).write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
    with_hts = sum(1 for o in data["orders"] if o["hts"])
    lost = [o["country"] for o in data["orders"] if not o.get("iso")]
    print(f"{len(data['orders'])} orders in effect, {with_hts} with an HTS list"
          + (f"; unresolved countries: {sorted(set(lost))}" if lost else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
