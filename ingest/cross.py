"""CBP CROSS rulings ingest.

CROSS holds ~221,000 classification rulings, each pre-tagged with the HTS
codes it resolves to, plus a revocation chain saying whether it is still good
law. That mapping is the precedent corpus the classifier reasons over.

The API is undocumented but open. `term` is required; `term=classification`
matches ~201,000 rulings and paginates fully. Metadata comes from the search
endpoint in pages of 100; full text requires a per-ruling detail call, so it is
fetched separately and incrementally.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from store.db import begin, connect, init, rebuild_ruling_index, set_meta

SEARCH = "https://rulings.cbp.gov/api/search"
DETAIL = "https://rulings.cbp.gov/api/ruling/{}"
PAGE_SIZE = 100
UA = "htsdesk-ingest/0.1 (+public data research)"

# CROSS subject lines are not consistently subjects. Some carry the whole
# ruling letter, capped at 1000 characters, with the body running on after the
# salutation. Left alone they swamp the retrieval scoring and render as walls
# of text, so the letter is trimmed back to the actual subject.
_SALUTATION = re.compile(
    r"\s*(?:Dear\s+(?:Mr|Ms|Mrs|Miss|Sir|Madam|Messrs)\b"
    r"|In your letter dated"
    r"|RE:\s)", re.I)


def clean_subject(text: str) -> str:
    s = re.sub(r"[\x00-\x1f]+", " ", text or "")
    s = _SALUTATION.split(s, maxsplit=1)[0]
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) > 220:
        cut = s.rfind(" ", 0, 220)
        s = s[: cut if cut > 120 else 220].rstrip(" ,;:") + "…"
    return s


async def _get(client: httpx.AsyncClient, url: str, params=None, tries: int = 4):
    delay = 1.0
    for attempt in range(tries):
        try:
            r = await client.get(url, params=params, timeout=30)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (429, 503):
                await asyncio.sleep(delay)
                delay *= 2
                continue
            return None
        except (httpx.HTTPError, json.JSONDecodeError):
            await asyncio.sleep(delay)
            delay *= 2
    return None


def _store_meta(conn, rulings: list[dict]) -> int:
    rows, links = [], []
    for r in rulings:
        num = r.get("rulingNumber")
        if not num:
            continue
        tariffs = r.get("tariffs") or []
        rows.append((
            num, clean_subject(r.get("subject") or ""), (r.get("rulingDate") or "")[:10],
            r.get("collection") or "", r.get("categories") or "",
            json.dumps(tariffs),
            int(bool(r.get("operationallyRevoked") or r.get("revokedBy"))),
            f"https://rulings.cbp.gov/ruling/{num}",
        ))
        for t in tariffs:
            links.append((num, t, t.replace(".", "")))
    conn.executemany(
        "INSERT INTO ruling(ruling_number,subject,ruling_date,collection,categories,"
        "tariffs,revoked,url) VALUES(?,?,?,?,?,?,?,?) "
        "ON CONFLICT(ruling_number) DO UPDATE SET subject=excluded.subject,"
        "tariffs=excluded.tariffs,revoked=excluded.revoked", rows)
    if links:
        conn.executemany(
            "INSERT OR IGNORE INTO ruling_tariff(ruling_number,hts,digits) VALUES(?,?,?)",
            links)
    return len(rows)


async def crawl_metadata(conn, *, term: str, concurrency: int, max_pages: int | None):
    async with httpx.AsyncClient(headers={"User-Agent": UA}) as client:
        first = await _get(client, SEARCH, {"term": term, "pageSize": PAGE_SIZE, "page": 1})
        if not first:
            print("search endpoint unavailable")
            return 0
        total = first.get("totalHits") or 0
        pages = (total + PAGE_SIZE - 1) // PAGE_SIZE
        if max_pages:
            pages = min(pages, max_pages)
        print(f"corpus: {total:,} rulings across {pages:,} pages")

        stored = _store_meta(conn, first.get("rulings") or [])
        conn.commit()

        sem = asyncio.Semaphore(concurrency)
        done = {"n": stored, "pages": 1}

        async def one(page: int):
            async with sem:
                data = await _get(client, SEARCH,
                                  {"term": term, "pageSize": PAGE_SIZE, "page": page})
                await asyncio.sleep(0.05)          # be a polite guest
            if not data:
                return
            n = _store_meta(conn, data.get("rulings") or [])
            done["n"] += n
            done["pages"] += 1
            if done["pages"] % 100 == 0:
                conn.commit()
                print(f"  {done['pages']:,}/{pages:,} pages  {done['n']:,} rulings",
                      flush=True)

        await asyncio.gather(*(one(p) for p in range(2, pages + 1)))
        conn.commit()
        return done["n"]


async def crawl_bodies(conn, *, limit: int, concurrency: int):
    """Fetch full text for rulings that have none yet, newest first."""
    todo = [r["ruling_number"] for r in conn.execute(
        "SELECT ruling_number FROM ruling WHERE body IS NULL "
        "ORDER BY ruling_date DESC LIMIT ?", (limit,))]
    if not todo:
        print("no bodies outstanding")
        return 0
    print(f"fetching {len(todo):,} ruling bodies")
    sem = asyncio.Semaphore(concurrency)
    count = {"n": 0}
    pending: list[tuple[str, str]] = []

    def flush() -> None:
        """Write in batches. One UPDATE per ruling from many coroutines holds
        the write lock almost continuously and starves every other process."""
        if not pending:
            return
        conn.executemany(
            "UPDATE ruling SET body = ? WHERE ruling_number = ?", pending)
        conn.commit()
        pending.clear()

    async with httpx.AsyncClient(headers={"User-Agent": UA}) as client:
        async def one(num: str):
            async with sem:
                data = await _get(client, DETAIL.format(num))
                await asyncio.sleep(0.05)
            if not data:
                return
            pending.append((data.get("text") or "", num))
            count["n"] += 1
            if len(pending) >= 500:
                flush()
                print(f"  {count['n']:,}/{len(todo):,} bodies", flush=True)

        await asyncio.gather(*(one(n) for n in todo))
    flush()
    return count["n"]


def reindex(conn) -> int:
    try:
        begin(conn)
        n = rebuild_ruling_index(conn)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return n


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--term", default="classification")
    ap.add_argument("--concurrency", type=int, default=6)
    ap.add_argument("--max-pages", type=int, default=None)
    ap.add_argument("--bodies", type=int, default=0)
    ap.add_argument("--skip-metadata", action="store_true")
    args = ap.parse_args()

    conn = connect()
    init(conn)
    if not args.skip_metadata:
        n = await crawl_metadata(conn, term=args.term,
                                 concurrency=args.concurrency,
                                 max_pages=args.max_pages)
        print(f"metadata stored: {n:,}")
    if args.bodies:
        n = await crawl_bodies(conn, limit=args.bodies, concurrency=args.concurrency)
        print(f"bodies stored: {n:,}")
    indexed = reindex(conn)
    set_meta(conn, "cross_ingested_at", datetime.now(timezone.utc).isoformat())
    conn.commit()
    total = conn.execute("SELECT count(*) c FROM ruling").fetchone()["c"]
    links = conn.execute("SELECT count(*) c FROM ruling_tariff").fetchone()["c"]
    print(f"rulings: {total:,} | code links: {links:,} | fts rows: {indexed:,}")
    conn.close()


if __name__ == "__main__":
    asyncio.run(main())
