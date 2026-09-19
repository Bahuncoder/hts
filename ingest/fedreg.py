"""Federal Register poller.

Tariff rates change several times a week. That volatility is why a live engine
beats static content, and it is the reason watching a catalogue is worth doing:
a change touching a code in the customer's catalogue is money, and they will
not otherwise see it.

Two things make the feed usable rather than merely full:

  * Relevance. Searching for "Section 232" matches every document that
    mentions it, including foreign-trade-zone notifications and, observed in
    practice, an education funding rule and a mushroom council membership
    notice. Documents are therefore scored against issuing agency, document
    type and title, and only genuine tariff actions are surfaced.

  * Codes. Titles and abstracts rarely list HTS codes; the operative tables
    do. Without codes a change cannot be diffed against a catalogue. Full text
    is fetched from the `raw_text_url` the API supplies — it is date
    partitioned, and a constructed URL 404s.

Even fetched correctly, only a minority of relevant documents name codes:
measured at 8% for Section 232 notices, 42% for antidumping and 58% for
schedule modifications. The rest are narrative.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from store.db import connect, init, set_meta

API = "https://www.federalregister.gov/api/v1/documents.json"
HTS_RE = re.compile(r"\b\d{4}\.\d{2}(?:\.\d{2})?(?:\.\d{2})?\b")

TERMS = [
    "Section 232", "Section 301", "harmonized tariff schedule",
    "tariff-rate quota", "antidumping", "countervailing duty",
    "de minimis", "IEEPA",
]
FIELDS = ["document_number", "title", "type", "publication_date",
          "html_url", "abstract", "agencies", "raw_text_url"]

# Agencies that actually set or administer duties.
TARIFF_AGENCIES = {
    "international trade administration",
    "trade representative, office of united states",
    "u.s. customs and border protection",
    "customs and border protection",
    "international trade commission",
    "commerce department", "treasury department",
    "executive office of the president",
}

# Titles that match a search term while having nothing to do with rate setting.
NOISE = re.compile(
    r"foreign-trade zone|notification of proposed production|membership"
    r"|general administrative regulations|information collection"
    r"|combined notice of filings|sunshine act|meeting notice",
    re.I)

ACTION = re.compile(
    r"antidumping|countervailing|tariff|duty|duties|quota|import|section 232"
    r"|section 301|harmonized", re.I)


def is_tariff_action(title: str, doc_type: str, agencies: list[str]) -> bool:
    if NOISE.search(title or ""):
        return False
    if not ACTION.search(title or ""):
        return False
    if doc_type == "Presidential Document":
        return True
    return any(a.lower() in TARIFF_AGENCIES for a in agencies)


async def _fetch(client: httpx.AsyncClient, term: str, since: str) -> list[dict]:
    out, page = [], 1
    while page <= 5:
        params = [
            ("per_page", 100), ("page", page), ("order", "newest"),
            ("conditions[term]", term),
            ("conditions[publication_date][gte]", since),
            *[("fields[]", f) for f in FIELDS],
        ]
        r = await client.get(API, params=params, timeout=45)
        if r.status_code != 200:
            print(f"    {term}: HTTP {r.status_code}")
            break
        results = r.json().get("results") or []
        out.extend(results)
        if len(results) < 100:
            break
        page += 1
    return out


def _store(conn, docs: list[dict]) -> tuple[int, int]:
    now = datetime.now(timezone.utc).isoformat()
    rows, relevant = [], 0
    for d in docs:
        agencies = [a.get("name") for a in (d.get("agencies") or []) if a.get("name")]
        blob = " ".join(filter(None, [d.get("title") or "", d.get("abstract") or ""]))
        codes = sorted({c for c in HTS_RE.findall(blob) if not c.startswith("99")})
        action = is_tariff_action(d.get("title") or "", d.get("type") or "", agencies)
        relevant += action
        rows.append((
            d.get("document_number"), d.get("title"), d.get("type"),
            d.get("publication_date"), d.get("html_url"), d.get("abstract"),
            json.dumps(agencies), json.dumps(codes), d.get("raw_text_url"),
            int(action), now,
        ))
    conn.executemany(
        "INSERT INTO fr_document(document_number,title,doc_type,publication_date,"
        "html_url,abstract,agencies,hts_mentions,raw_text_url,tariff_action,seen_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(document_number) DO UPDATE SET title=excluded.title,"
        "abstract=excluded.abstract,raw_text_url=excluded.raw_text_url,"
        "tariff_action=excluded.tariff_action", rows)
    return len(rows), relevant


async def enrich(conn, client: httpx.AsyncClient, limit: int) -> tuple[int, int]:
    """Fetch full text for tariff actions and extract the codes they name."""
    rows = conn.execute(
        "SELECT document_number, raw_text_url FROM fr_document "
        "WHERE tariff_action = 1 AND text_fetched = 0 AND raw_text_url IS NOT NULL "
        "ORDER BY publication_date DESC LIMIT ?", (limit,)).fetchall()
    if not rows:
        return 0, 0

    sem = asyncio.Semaphore(6)
    updates: list[tuple[str, str]] = []

    async def one(doc: str, url: str):
        async with sem:
            try:
                r = await client.get(url, timeout=45, follow_redirects=True)
            except httpx.HTTPError:
                return
            await asyncio.sleep(0.05)
        if r.status_code != 200:
            return
        codes = sorted({c for c in HTS_RE.findall(r.text) if not c.startswith("99")})
        updates.append((json.dumps(codes[:400]), doc))

    await asyncio.gather(*(one(r["document_number"], r["raw_text_url"]) for r in rows))
    if updates:
        conn.executemany(
            "UPDATE fr_document SET hts_mentions = ?, text_fetched = 1 "
            "WHERE document_number = ?", updates)
        conn.commit()
    with_codes = sum(1 for payload, _ in updates if payload != "[]")
    return len(updates), with_codes


async def poll(days: int = 120, enrich_limit: int = 400) -> int:
    since = (date.today() - timedelta(days=days)).isoformat()
    conn = connect()
    init(conn)
    async with httpx.AsyncClient(headers={"User-Agent": "htsdesk/0.1"}) as client:
        for term in TERMS:
            docs = await _fetch(client, term, since)
            n, rel = _store(conn, docs)
            conn.commit()
            print(f"  {term:30s} {n:4d} documents, {rel:4d} tariff actions")
            await asyncio.sleep(0.2)

        fetched, with_codes = await enrich(conn, client, enrich_limit)
        print(f"  full text fetched for {fetched} actions; "
              f"{with_codes} name HTS codes")

    set_meta(conn, "fedreg_polled_at", datetime.now(timezone.utc).isoformat())
    conn.commit()
    total = conn.execute("SELECT count(*) c FROM fr_document").fetchone()["c"]
    actions = conn.execute(
        "SELECT count(*) c FROM fr_document WHERE tariff_action = 1").fetchone()["c"]
    coded = conn.execute(
        "SELECT count(*) c FROM fr_document "
        "WHERE tariff_action = 1 AND hts_mentions != '[]'").fetchone()["c"]
    print(f"stored {total:,} documents | {actions:,} tariff actions | "
          f"{coded:,} with HTS codes")
    conn.close()
    return actions


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=120)
    ap.add_argument("--enrich", type=int, default=400)
    asyncio.run(poll(ap.parse_args().days, ap.parse_args().enrich))
