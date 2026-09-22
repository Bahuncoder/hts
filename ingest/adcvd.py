"""Antidumping and countervailing duty orders in effect, from the Federal Register.

AD/CVD duties are imposed per order, on a product from a country, at rates that
differ by exporter (a cash deposit that the importer pays at entry). Commerce
publishes each month a notice listing every order whose anniversary falls in
that month ("Antidumping or Countervailing Duty Order, Finding, or Suspended
Investigation; Opportunity To Request Administrative Review"); the twelve most
recent together are the orders in effect. Each order's scope, with the HTS
subheadings Commerce lists for convenience, is read from whichever of its own
notices states the fullest list — often the original order or a continuation,
sometimes only a later administrative review — searched across the case's
full history, not just its most recent notices.

Two things make that search reliable rather than merely broad. First, a case
number can turn up in an unrelated document (a footnote citing a companion
proceeding, a combined notice for several countries) without that document
being about it; `_own_case` reads the case numbers the Federal Register
brackets at the top of every notice — where it says which case(s) the notice
actually concerns — and a candidate whose bracket excludes the case is
skipped. Second, the Federal Register's own text is wrapped to a fixed width,
so an ordinary word can start a new line by chance in the middle of a
sentence; `_SCOPE_END` only stops a scope section at a heading recognisable by
sitting alone on its line, not by that accident.

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
# A stop phrase must sit alone on its own line — the plain-text conversion
# wraps prose at a fixed width, so a short common word ("Determination",
# "Verification") can start a wrapped line by pure chance in the middle of a
# sentence ("the Malaysia Final LTFV\nDetermination to reflect ..."). Requiring
# nothing but whitespace before the next newline is what tells a real section
# heading (alone on its line) from that kind of accident.
_SCOPE_END = re.compile(
    r"\n\s*(?:Scope Comments|Scope Rulings|Analysis of Comments(?: and Recommendations)?|"
    r"Discussion of the Issues|Product Characteristics|Verification|"
    r"(?:Amended )?Final (?:Results|Determination)(?: of (?:Sales|the Review|Review))?|"
    r"(?:Amended )?Preliminary (?:Results|Determination)(?: of (?:Sales|the Review|Review))?|"
    r"Successor[- ]in[- ]Interest|Separate Rates?|Surrogate (?:Country|Value)s?|"
    r"(?:Application|Use) of (?:Adverse )?Facts Available|Critical Circumstances|"
    r"Cash Deposit (?:Requirements|Rates?)|Assessment Rates?|Disclosure|"
    r"Administrative Protective Order|Notification (?:to|Regarding)|ITC Notification)"
    r"\s*\n")


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
        # No scope heading carried the list (an appendix that defers to
        # "see the appendix" without repeating the heading, or a scope section
        # cut short by an unrelated word like "Determination" appearing soon
        # after). A number list almost always comes right BEFORE the phrase
        # "of the Harmonized Tariff Schedule of the United States (HTSUS)",
        # not after, so the window looks backward.
        for m in re.finditer(r"Harmonized Tariff Schedule|\bHTSUS\b", body):
            codes |= {c.replace(".", "") for c in
                     _HTS_DOTTED.findall(body[max(0, m.start() - 1500):m.end() + 200])}
    return sorted(c for c in codes if not c.startswith(("98", "99")))


def _rank(title: str) -> int:
    t = title.lower()
    if t.startswith(MONTHLY_TITLE.lower()):
        return 9
    # A correction or a circumvention finding is a follow-on notice *about*
    # the order, not the order's own scope text — either can contain the
    # literal words "antidumping duty order" or "final determination" (a
    # correction fixing an unrelated paragraph, a circumvention finding on
    # one derivative product) without restating, or even mentioning, the
    # HTS list. Left unguarded, one of these can outrank — and so get tried
    # before — the actual order, continuation or suspension notice that
    # carries it. A scope clarification is judged on its own merits: it
    # sometimes narrows or restates the list, sometimes (as with a
    # certification-only change) never mentions it, so it is worth trying
    # but not worth preferring over the order itself.
    followon = "correction" in t or "circumvention" in t
    if not followon and (
            "continuation of" in t
            # A suspension agreement is the order-equivalent document for a
            # case resolved that way (the monthly notice groups it with
            # "Order, Finding, or Suspended Investigation" for exactly this
            # reason); its own notice is where the scope was first stated.
            or re.search(r"suspension of (?:the )?(?:antidumping|countervailing) duty investigation", t)
            or (re.search(r"(?:antidumping|countervailing) duty order", t) and "review" not in t)):
        return 0
    if not followon and (
            "clarification of the scope" in t
            or "preliminary" in t and "review" in t or "amended final" in t or "final determination" in t):
        return 1
    if "final results" in t:
        return 2
    return 5


_HEADER_CASES = re.compile(r"International Trade Administration\s*\n+\s*\[([^\]]{3,400})\]")


def _own_case(body: str, case: str) -> bool | None:
    """Whether the case numbers bracketed at the top of a notice — where the
    Federal Register cites exactly which case(s) it concerns, singly or as a
    combined multi-country notice — include this one. A case number can turn
    up elsewhere in a document (a cross-reference, a footnote, a table of
    unrelated companion orders) without the document being about it, which
    text search alone cannot tell apart; this can. None means the header was
    not found (an unusual format), and the caller decides how to treat that."""
    m = _HEADER_CASES.search(body[:2500])
    if not m:
        return None
    found = {f"{g[0]}-{g[1]}-{g[2]}" for g in CASE.findall(m.group(1))}
    return case in found


def latest_scope(case: str) -> dict | None:
    """HTS list from the best notice that quotes this case's scope: the order
    or its continuation, else a preliminary or final review.

    The case number ("A-533-877") is searched with its digit groups
    space-separated rather than as a quoted, hyphenated phrase: the Federal
    Register's search treats a quoted "A-533-877" as a single literal token
    that many of a case's own notices do not match verbatim (a rendering
    difference in how the case number is printed), which silently starved the
    candidate pool. A 100-notice pool, not 30, matters for a case with decades
    of administrative reviews: the original order notice — the one most likely
    to carry the scope in full — sorts oldest within its rank and can fall
    outside a smaller page."""
    term = case.replace("-", " ")
    d = _search(per_page=100, order="newest", **{
        "conditions[term]": term,
        "conditions[agencies][]": "international-trade-administration",
        "conditions[type][]": "NOTICE",
        "fields[]": ["title", "publication_date", "document_number", "raw_text_url"]})
    cands = sorted((r for r in d.get("results", []) if _rank(r["title"]) < 9),
                   key=lambda r: (_rank(r["title"]), -int(r["publication_date"].replace("-", ""))))
    first = None
    for r in cands[:8]:
        body = _plain(_get(r["raw_text_url"]))
        if _own_case(body, case) is False:
            continue                              # this notice is about a different case
        hts = scope_hts(body)
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
        # An empty HTS list is retried every build: it is as likely to be a
        # search miss as a genuinely code-free scope, and the miss is the kind
        # this module keeps getting better at avoiding.
        if old and old.get("fetched") and not old.get("error") and old.get("hts") and (
                now - date.fromisoformat(old["fetched"])).days < REUSE_DAYS:
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
