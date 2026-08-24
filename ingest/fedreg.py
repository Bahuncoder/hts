"""Federal Register poller.

Tariff rates change several times a week. That volatility is why a live engine
beats static content, and it is the reason customers stay subscribed: a change
that touches a code in their catalogue is money, and they will not see it
otherwise.

Documents are matched against the tariff authorities that survive — Section 232
and Section 301 — plus any HTS codes named in the text, so a change can be
diffed against a customer's catalogue.
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

# Terms that select genuine tariff actions. IEEPA is retained because its
# provisions still appear in the schedule despite being struck down, and
# importers need to see actions that touch them.
TERMS = [
    "Section 232", "Section 301", "harmonized tariff schedule",
    "tariff-rate quota", "antidumping", "countervailing duty",
    "de minimis", "IEEPA",
]
FIELDS = ["document_number", "title", "type", "publication_date",
          "html_url", "abstract", "agencies", "raw_text_url"]


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


def _store(conn, docs: list[dict], term: str) -> int:
    now = datetime.now(timezone.utc).isoformat()
    rows = []
    for d in docs:
        blob = " ".join(filter(None, [
            d.get("title") or "", d.get("abstract") or "",
        ]))
        codes = sorted({c for c in HTS_RE.findall(blob) if not c.startswith("99")})
        agencies = [a.get("name") for a in (d.get("agencies") or []) if a.get("name")]
        rows.append((
            d.get("document_number"), d.get("title"), d.get("type"),
            d.get("publication_date"), d.get("html_url"), d.get("abstract"),
            json.dumps(agencies), json.dumps(codes), now, d.get("raw_text_url"),
        ))
    conn.executemany(
        "INSERT INTO fr_document(document_number,title,doc_type,publication_date,"
        "html_url,abstract,agencies,hts_mentions,seen_at,raw_text_url) "
        "VALUES(?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(document_number) DO UPDATE SET title=excluded.title,"
        "abstract=excluded.abstract,raw_text_url=excluded.raw_text_url", rows)
    return len(rows)


async def enrich(conn, client: httpx.AsyncClient, limit: int = 300) -> int:
    """Pull document text to recover the HTS codes an action actually names.

    Titles and abstracts rarely list codes; the operative tables do. Without
    them a change cannot be diffed against a customer's catalogue, which is the
    only reason the feed is worth subscribing to.
    """
    rows = conn.execute(
        "SELECT document_number, raw_text_url FROM fr_document "
        "WHERE hts_mentions = '[]' AND raw_text_url IS NOT NULL "
        "ORDER BY publication_date DESC LIMIT ?",
        (limit,)).fetchall()
    if not rows:
        return 0
    sem = asyncio.Semaphore(6)
    updates: list[tuple[str, str]] = []

    async def one(doc: str, raw: str):
        async with sem:
            try:
                r = await client.get(raw, timeout=45, follow_redirects=True)
            except httpx.HTTPError:
                return
            await asyncio.sleep(0.05)
        if r.status_code != 200:
            return
        codes = sorted({c for c in HTS_RE.findall(r.text) if not c.startswith("99")})
        if codes:
            updates.append((json.dumps(codes[:400]), doc))

    await asyncio.gather(*(one(r["document_number"], r["raw_text_url"]) for r in rows))
    if updates:
        conn.executemany(
            "UPDATE fr_document SET hts_mentions = ? WHERE document_number = ?",
            updates)
        conn.commit()
    return len(updates)


async def poll(days: int = 120) -> int:
    since = (date.today() - timedelta(days=days)).isoformat()
    conn = connect()
    init(conn)
    total = 0
    async with httpx.AsyncClient(headers={"User-Agent": "tariffwise/0.1"}) as client:
        for term in TERMS:
            docs = await _fetch(client, term, since)
            n = _store(conn, docs, term)
            total += n
            print(f"  {term:32s} {n:4d} documents")
            await asyncio.sleep(0.2)
        n = await enrich(conn, client)
        print(f"  enriched {n} documents with HTS codes from full text")
    set_meta(conn, "fedreg_polled_at", datetime.now(timezone.utc).isoformat())
    conn.commit()
    distinct = conn.execute("SELECT count(*) c FROM fr_document").fetchone()["c"]
    withcodes = conn.execute(
        "SELECT count(*) c FROM fr_document WHERE hts_mentions != '[]'").fetchone()["c"]
    print(f"stored {distinct:,} documents ({withcodes:,} name specific HTS codes)")
    conn.close()
    return distinct


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=120)
    asyncio.run(poll(ap.parse_args().days))
