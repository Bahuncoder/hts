"""HTSDesk HTTP API.

Serves the duty engine, classifier and reference data. Reference data is
read-only SQLite shipped as a build artifact, so the service has no database
to provision and starts cold in milliseconds.
"""
from __future__ import annotations

import json
import logging
import os
import re
import math
import sys
import threading
import time
from decimal import Decimal, InvalidOperation
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api.security import (ANON_AUDIT_ITEMS, KEYED_AUDIT_ITEMS, MAX_TEXT,
                          clean_text, guard)
from core.classify import classify as run_classify
from core.classify import reset_caches as reset_classify_caches
from core.duty import (FEE_CONSTANTS_EFFECTIVE_THROUGH, entry_mpf,
                       fee_constants_stale)
from core.countries import UnknownCountry
from core.engine import TariffEngine
from core.hts import InvalidHts, NotStatisticalLine
from store.db import connect, get_meta, index_coverage

ROOT = Path(__file__).resolve().parent.parent

# Wall-clock ceiling on a single audit, whatever the item count.
AUDIT_BUDGET_SECONDS = float(os.environ.get("HTSDESK_AUDIT_BUDGET", "45"))
# FastAPI publishes /docs, /redoc and /openapi.json by default. That is a
# complete map of the surface — every path, every schema — handed to anyone who
# asks. Useful in development, so it is opt-in rather than removed.
_DOCS = os.environ.get("HTSDESK_ENABLE_DOCS") == "1"

app = FastAPI(
    title="HTSDesk API",
    version="0.1.0",
    description="Duty calculation and HTS classification for US importers.",
    docs_url="/docs" if _DOCS else None,
    redoc_url="/redoc" if _DOCS else None,
    openapi_url="/openapi.json" if _DOCS else None,
)
# Deny cross-origin by default. An explicit origin list is required to enable
# it, so a misconfigured deployment fails closed rather than open.
_origins = [o.strip() for o in os.environ.get("HTSDESK_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["content-type", "x-api-key"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    # The Server header is not set here on purpose. Uvicorn writes its own at
    # the ASGI layer *after* application middleware, so setting it here only
    # appends a second one. It is suppressed with --no-server-header on the
    # command line instead; see deploy/htsdesk-api.service.
    return response


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    """Return an opaque error. Exception text leaks internals — an invalid
    value was surfacing `decimal.InvalidOperation` to callers."""
    logging.exception("unhandled error on %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal error"})

_engine: TariffEngine | None = None
_engine_lock = threading.Lock()


def _release_paths(release_dir: str) -> tuple[str, str]:
    if release_dir:
        base = Path(release_dir)
        base = base if base.is_absolute() else ROOT / base
        return str(base / "hts.json"), str(base / "chapter99.txt")
    return (str(ROOT / "data" / "hts_2026.json"),
            str(ROOT / "data" / "chapter99.txt"))


def engine(conn) -> TariffEngine:
    """The engine for the dataset the database currently serves.

    The engine reads the schedule and Chapter 99 notes from files, the lookup
    endpoints read the database, and a refresh replaces both. Comparing the
    dataset revision on every call is what keeps them from disagreeing: the
    first request after a refresh reloads the engine and clears the classifier's
    caches, so no endpoint keeps answering from the previous edition.
    """
    global _engine
    revision = get_meta(conn, "dataset_revision") or ""
    current = _engine
    if current is not None and current.revision == revision:
        return current
    with _engine_lock:
        if _engine is None or _engine.revision != revision:
            hts_path, notes_path = _release_paths(get_meta(conn, "release_dir") or "")
            _engine = TariffEngine(hts_path, notes_path, revision=revision)
            reset_classify_caches()
        return _engine


def db():
    conn = connect(readonly=True)
    try:
        yield conn
    finally:
        conn.close()


# --------------------------------------------------------------------------- models

class QuoteRequest(BaseModel):
    hts: str = Field(..., max_length=20, description="10-digit HTS code")
    country: str = Field(..., max_length=MAX_TEXT, description="Country of origin")
    # Capped below the point where Decimal arithmetic overflows; an unbounded
    # float was surfacing decimal.InvalidOperation to the caller.
    value: float = Field(..., gt=0, le=1e12, description="Entered value in USD")
    fta_claimed: bool = False
    preference_program: str | None = Field(
        None, max_length=8,
        description="Special-rate program indicator (e.g. KR, S, AU) when a "
                    "preference is claimed")
    by_vessel: bool = True
    formal_entry: bool = True


class CatalogItem(BaseModel):
    # Structure is validated here; content (value, origin, code) is validated
    # per line so one bad row is reported, not allowed to reject the request
    # and silently drop its neighbours.
    row: int | None = Field(None, ge=1, le=10_000_000,
                            description="Caller's own row number, echoed back")
    sku: str = Field("", max_length=64)
    description: str = Field("", max_length=2000)
    country: str = Field("", max_length=2000)
    value: float = 0.0
    hts: str | None = Field(None, max_length=200)


class AuditRequest(BaseModel):
    items: list[CatalogItem] = Field(..., min_length=1, max_length=KEYED_AUDIT_ITEMS)
    entries: int = Field(
        1, ge=1, le=100_000,
        description="Formal entries the catalogue value is spread over; the "
                    "MPF minimum and maximum apply to each entry")
    by_vessel: bool = True
    formal_entry: bool = True


def _bad_request(exc: Exception) -> HTTPException:
    return HTTPException(400, str(exc))


# --------------------------------------------------------------------------- routes

@app.get("/api/health")
def health(conn=Depends(db), keyed: bool = Depends(guard("cheap"))):
    """Liveness, plus whether the data it serves is coherent.

    Row counts, build timestamps, revisions and whether the reasoning layer is
    enabled are operational detail: they tell an unauthenticated caller how
    complete the data is and which code path a request will take. A keyed
    caller gets them; everyone else gets liveness, which is all a health check
    needs. Both report "degraded" if the precedent index is empty, since a
    populated ruling table with an empty index looks healthy and is not.
    """
    has_precedent = conn.execute("SELECT 1 FROM ruling_fts LIMIT 1").fetchone()
    if not keyed:
        return {"status": "ok" if has_precedent else "degraded"}

    counts = {
        t: conn.execute(f"SELECT count(*) c FROM {t}").fetchone()["c"]
        for t in ("hts", "ch99_rule", "ch99_scope", "ruling", "fr_document")
    }
    coverage = index_coverage(conn)
    index_complete = (coverage["rulings_indexed"] == coverage["rulings"]
                      and coverage["hts_indexed"] == coverage["leaves"])
    db_revision = get_meta(conn, "dataset_revision") or ""
    loaded = _engine.revision if _engine is not None else None
    return {
        "status": "ok" if index_complete else "degraded",
        "hts_edition": get_meta(conn, "hts_edition"),
        "built_at": get_meta(conn, "built_at"),
        "cross_ingested_at": get_meta(conn, "cross_ingested_at"),
        "dataset_revision": db_revision,
        "engine_revision": loaded,
        # None until the first quote loads the engine; False means requests are
        # about to reload it, or a reload failed.
        "engine_current": None if loaded is None else loaded == db_revision,
        "counts": counts,
        "index": coverage,
        "index_complete": index_complete,
        "reasoning_enabled": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "fee_constants_stale": fee_constants_stale(),
        "fee_constants_effective_through": FEE_CONSTANTS_EFFECTIVE_THROUGH.isoformat(),
    }


@app.get("/api/hts/{code}")
def hts_detail(code: str,
               country: str = Query("China", max_length=MAX_TEXT),
               value: float = Query(10000.0, gt=0, le=1e12),
               conn=Depends(db), _=Depends(guard("cheap"))):
    if len(code) > 20:
        raise HTTPException(404, f"HTS code not found")
    row = conn.execute("SELECT * FROM hts WHERE hts = ?", (code,)).fetchone()
    if not row:
        raise HTTPException(404, f"HTS code {code} not found")

    quote = None
    if row["is_leaf"]:
        try:
            quote = engine(conn).quote(hts=code, country=country, value=value).as_dict()
        except (InvalidOperation, ValueError) as exc:
            raise _bad_request(exc) from exc

    rulings = conn.execute(
        """SELECT r.ruling_number, r.subject, r.ruling_date, r.revoked, r.url
             FROM ruling_tariff t JOIN ruling r ON r.ruling_number = t.ruling_number
            WHERE t.digits LIKE ? ORDER BY r.ruling_date DESC LIMIT 12""",
        (row["digits"][:8] + "%",),
    ).fetchall()

    remedies = conn.execute(
        """SELECT s.heading, m.countries, m.note, m.effective_from, c.rate_pct,
                  c.raw_rate, c.suspended
             FROM ch99_scope s
             JOIN ch99_scope_meta m ON m.heading = s.heading
             LEFT JOIN ch99_rule c ON c.hts = s.heading
            WHERE s.code = ?""",
        (code[:10],),
    ).fetchall()

    return {
        "hts": row["hts"],
        "description": row["description"],
        "full_path": row["full_path"],
        "chapter": row["chapter"],
        "is_leaf": bool(row["is_leaf"]),
        "rates": {
            "general": row["general_rate"],
            "special": row["special_rate"],
            "other": row["other_rate"],
        },
        "units": json.loads(row["units"] or "[]"),
        "quote": quote,
        "rulings": [dict(r) for r in rulings],
        "trade_remedies": [dict(r) for r in remedies],
    }


@app.get("/api/search")
def search(q: str = Query(..., min_length=2, max_length=MAX_TEXT),
           limit: int = Query(20, ge=1, le=100),
           conn=Depends(db), _=Depends(guard("cheap"))):
    from core.classify import _fts_query
    fts = _fts_query(clean_text(q, "q"))
    if not fts:
        return {"query": q, "results": []}
    rows = conn.execute(
        """SELECT f.hts, h.description, h.full_path, h.general_rate
             FROM hts_fts f JOIN hts h ON h.hts = f.hts
            WHERE hts_fts MATCH ? ORDER BY bm25(hts_fts) LIMIT ?""",
        (fts, limit),
    ).fetchall()
    return {"query": q, "results": [dict(r) for r in rows]}


@app.get("/api/classify")
def classify_endpoint(q: str = Query(..., min_length=3, max_length=MAX_TEXT),
                      limit: int = Query(6, ge=1, le=20),
                      conn=Depends(db), _=Depends(guard("classify"))):
    return run_classify(conn, clean_text(q, "q"), limit=limit).as_dict()


@app.post("/api/quote")
def quote(req: QuoteRequest, conn=Depends(db), _=Depends(guard("cheap"))):
    try:
        result = engine(conn).quote(
            hts=req.hts, country=req.country, value=req.value,
            fta_claimed=req.fta_claimed,
            preference_program=req.preference_program,
            by_vessel=req.by_vessel, is_formal_entry=req.formal_entry)
    except NotStatisticalLine as exc:
        raise HTTPException(400, str(exc)) from exc
    except InvalidHts as exc:
        raise HTTPException(404, str(exc)) from exc
    except (InvalidOperation, ValueError) as exc:
        raise _bad_request(exc) from exc
    return result.as_dict()


# Primary status of an audited line, most serious first. `ready` is the only
# state that means "priced, complete, and nothing to confirm".
LINE_STATUSES = ("error", "unclassified", "not_processed", "incomplete",
                 "scope_review", "suffix_review", "low_confidence", "ready")
_PRICED = {"incomplete", "scope_review", "suffix_review", "low_confidence", "ready"}


def _audit_line(conn, eng: TariffEngine, item: CatalogItem, base: dict,
                req: AuditRequest) -> dict:
    def refuse(status: str, code: str, message: str) -> dict:
        return {**base, "status": status, "error_code": code, "error": message,
                "review_reasons": [message], "warnings": [], "incomplete": [],
                "scope_unverified": [], "suggested": [], "alternatives": []}

    if not math.isfinite(item.value) or not (0 < item.value <= 1e12):
        return refuse("error", "invalid_value", "Entered value must be a positive amount.")
    if not item.country.strip():
        return refuse("error", "invalid_country", "Country of origin is missing.")
    if len(item.description) > MAX_TEXT:
        return refuse("error", "description_too_long",
                      f"Description is longer than {MAX_TEXT} characters.")

    given = (item.hts or "").strip()
    confidence, suggested, top = "given", [], None
    if given:
        hts = given
    else:
        if not item.description.strip():
            return refuse("unclassified", "no_description",
                          "No HTS code and no description to classify from.")
        cls = run_classify(conn, item.description, limit=3)
        if not cls.candidates:
            return refuse("unclassified", "no_candidate",
                          "Could not classify this product from its description.")
        top = cls.candidates[0]
        hts, confidence = top.hts, top.confidence
        suggested = [c.as_dict() for c in cls.candidates]
    base["hts"] = hts

    try:
        q = eng.quote(hts=hts, country=item.country, value=item.value,
                      by_vessel=req.by_vessel, is_formal_entry=False)
    except InvalidHts as exc:
        return refuse("error", "invalid_code", str(exc))
    except UnknownCountry as exc:
        return refuse("error", "invalid_country", str(exc))
    except (InvalidOperation, ValueError) as exc:
        return refuse("error", "invalid_input", str(exc))
    except Exception:
        logging.exception("audit pricing failed for %r", hts)
        return refuse("error", "pricing_failed", "Could not price this line.")

    # A classified code is a subheading precedent points at plus whichever
    # statistical suffix comes first in the schedule; the suffix was never
    # decided. If sibling lines carry different rates, the price depends on a
    # choice nobody made, so it is surfaced instead of presented as the answer.
    alternatives: list[dict] = []
    if top is not None:
        siblings = eng.leaves_under(q.hts)
        rates = {ln.hts: tuple(eng.tree.effective_rate_cell(ln.hts, col)[0]
                               for col in ("general", "special", "other"))
                 for ln in siblings}
        if len(set(rates.values())) > 1:
            alternatives = [
                {"hts": ln.hts, "description": ln.description,
                 "general_rate": rates[ln.hts][0]}
                for ln in siblings if ln.hts != q.hts][:6]

    triggers: list[tuple[str, str]] = []
    if q.incomplete:
        triggers.append(("incomplete",
                         "The duty is understated: " + "; ".join(q.incomplete)))
    if q.scope_unverified:
        triggers.append(("scope_review",
                         f"{len(q.scope_unverified)} trade-remedy heading(s) cover this "
                         "origin and need scope verification."))
    if alternatives:
        triggers.append(("suffix_review",
                         "Sibling statistical lines carry different rates; the "
                         "10-digit suffix was not determined."))
    if confidence == "low":
        triggers.append(("low_confidence", "Low-confidence classification."))

    return {
        **base,
        "confidence": confidence,
        "status": triggers[0][0] if triggers else "ready",
        "review_reasons": [t[1] for t in triggers],
        "warnings": q.warnings,
        "incomplete": q.incomplete,
        "entered_value": float(q.entered_value),
        "duty": float(q.total_duty),
        "effective_rate_pct": float(q.effective_rate_pct),
        "refundable": float(q.refundable_amount),
        "scope_unverified": q.scope_unverified,
        "suggested": suggested,
        "alternatives": alternatives,
    }


@app.post("/api/audit")
def audit(req: AuditRequest, conn=Depends(db), keyed: bool = Depends(guard("audit"))):
    """Score a product catalogue: duty owed, refundable duty, and gaps.

    Every submitted row comes back, with a status and the reasons for it. A row
    that could not be priced, or whose price is incomplete or unconfirmed, is
    reported as such and counted as unresolved; it is never dropped, and totals
    say whether they are complete.

    Line duty covers the duty stack and the Harbor Maintenance Fee. The
    Merchandise Processing Fee belongs to an entry, not a line, so it is
    computed once over the catalogue for the stated number of entries.

    Classification costs ~175 ms per item, so an unbounded catalogue is a
    denial-of-service rather than a feature: 5,000 items occupied a worker for
    fourteen minutes. Anonymous callers get enough to judge the output; a key
    raises the ceiling, and a wall-clock budget caps even that.
    """
    ceiling = KEYED_AUDIT_ITEMS if keyed else ANON_AUDIT_ITEMS
    if len(req.items) > ceiling:
        raise HTTPException(
            413,
            f"{len(req.items)} items exceeds the limit of {ceiling}. "
            + ("Split the catalogue across requests."
               if keyed else
               "Supply an API key in X-API-Key to raise the limit."),
        )

    eng = engine(conn)
    lines: list[dict] = []
    started = time.monotonic()
    truncated = False

    for idx, item in enumerate(req.items):
        base = {"row": item.row if item.row is not None else idx + 1,
                "sku": item.sku, "description": item.description,
                "country": item.country, "hts": (item.hts or None)}
        if time.monotonic() - started > AUDIT_BUDGET_SECONDS:
            truncated = True
            msg = "Not processed: the time budget for one request was reached."
            lines.append({**base, "status": "not_processed",
                          "error_code": "not_processed", "error": msg,
                          "review_reasons": [msg], "warnings": [],
                          "incomplete": [], "scope_unverified": [],
                          "suggested": [], "alternatives": []})
            continue
        lines.append(_audit_line(conn, eng, item, base, req))

    priced = [ln for ln in lines if ln["status"] in _PRICED]
    total_value = sum((Decimal(str(ln["entered_value"])) for ln in priced), Decimal("0"))
    duty_lines = sum((Decimal(str(ln["duty"])) for ln in priced), Decimal("0"))
    refundable = sum((Decimal(str(ln["refundable"])) for ln in priced), Decimal("0"))
    mpf = (entry_mpf(total_value, entries=req.entries)
           if req.formal_entry and total_value > 0 else None)
    duty_total = duty_lines + (mpf.amount if mpf else Decimal("0"))

    by_status = {st: sum(1 for ln in lines if ln["status"] == st) for st in LINE_STATUSES}
    unresolved = sum(n for st, n in by_status.items() if st != "ready")

    assumptions = [
        (f"The priced value is spread over {req.entries} formal "
         f"entr{'y' if req.entries == 1 else 'ies'}; the Merchandise Processing "
         "Fee minimum and maximum apply to each entry."
         if req.formal_entry else "Informal entry assumed: no Merchandise Processing Fee."),
        ("Vessel shipment assumed: Harbor Maintenance Fee applied."
         if req.by_vessel else "Non-vessel shipment: no Harbor Maintenance Fee."),
        "Preference programs and quantity-based duties are not modelled here; "
        "lines that carry a quantity-based rate are flagged as incomplete.",
    ]
    if fee_constants_stale():
        assumptions.append(
            "User-fee constants are past their fiscal-year boundary and have "
            "not been re-verified.")

    return {
        "summary": {
            "submitted": len(req.items),
            "items": len(lines),
            "processed": len(lines) - by_status["not_processed"],
            "priced": len(priced),
            "unresolved": unresolved,
            "by_status": by_status,
            "truncated": truncated,
            "totals_complete": unresolved == 0 and not truncated,
            "entered_value": float(total_value),
            "duty_and_hmf": float(duty_lines),
            "mpf": float(mpf.amount) if mpf else 0.0,
            "duty": float(duty_total),
            "effective_rate_pct": float(
                (duty_total / total_value * 100).quantize(Decimal("0.01"))
                if total_value else 0),
            "potentially_refundable": float(refundable),
            "unclassified": by_status["unclassified"],
            "needs_scope_review": by_status["scope_review"],
            "assumptions": assumptions,
            "dataset_revision": eng.revision,
        },
        "lines": lines,
    }


@app.get("/api/rulings/{number}")
def ruling(number: str, conn=Depends(db), _=Depends(guard("cheap"))):
    if len(number) > 32:
        raise HTTPException(404, "ruling not found")
    row = conn.execute("SELECT * FROM ruling WHERE ruling_number = ?",
                       (number,)).fetchone()
    if not row:
        raise HTTPException(404, f"ruling {number} not found")
    d = dict(row)
    d["tariffs"] = json.loads(d.get("tariffs") or "[]")
    d["revoked"] = bool(d["revoked"])
    return d


_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@app.get("/api/changes")
def changes(days: int = Query(90, ge=1, le=3650),
            since: str | None = Query(None,
                description="ISO date, inclusive; overrides days and returns "
                            "oldest-first for a caller paging forward"),
            cursor: str | None = Query(None,
                description="Opaque position from a previous response's "
                            "next_cursor; continues strictly after it"),
            limit: int = Query(50, ge=1, le=2000),
            all_documents: bool = Query(False,
                description="Include documents that merely mention a tariff term"),
            conn=Depends(db), keyed: bool = Depends(guard("cheap"))):
    """Tariff actions published in the Federal Register.

    Searching the Register for "Section 232" also returns foreign-trade-zone
    notifications, agency meeting notices and, observed in practice, a
    mushroom council membership adjustment. Only scored tariff actions are
    returned by default.

    Paging forward is by (publication_date, document_number), not date alone:
    a page that ends part-way through a date would otherwise strand the rest of
    that date's documents behind the cursor forever. `since` is inclusive so a
    caller can re-read a lookback window for documents ingested late; the
    consumer deduplicates by document number.
    """
    order_cols = "publication_date, document_number"
    if cursor or since:
        order = "ASC"
        if cursor:
            date_part, _, num_part = cursor.partition("|")
            if not _ISO_DATE.match(date_part) or not num_part:
                raise HTTPException(400, "cursor is not valid")
            where = "(publication_date, document_number) > (?, ?)"
            params: list = [date_part, num_part]
        else:
            if not _ISO_DATE.match(since):
                raise HTTPException(400, "since must be an ISO date (YYYY-MM-DD)")
            where, params = "publication_date >= ?", [since]
    else:
        order = "DESC"
        where, params = "publication_date >= date('now', ?)", [f"-{days} days"]
    if not all_documents:
        where += " AND tariff_action = 1"

    # The higher ceiling is for the keyed, server-to-server diff job paging
    # through history; an anonymous caller gets the page-sized default.
    limit = min(limit, 2000 if keyed else 200)

    rows = conn.execute(
        f"""SELECT document_number, title, doc_type, publication_date, html_url,
                   abstract, hts_mentions, tariff_action
              FROM fr_document
             WHERE {where}
             ORDER BY {", ".join(f"{c} {order}" for c in order_cols.split(", "))}
             LIMIT ?""",
        (*params, limit),
    ).fetchall()

    out = []
    for r in rows:
        d = dict(r)
        d["hts_mentions"] = json.loads(d.get("hts_mentions") or "[]")
        d["tariff_action"] = bool(d["tariff_action"])
        out.append(d)
    last = out[-1] if out else None
    return {
        "days": days,
        "count": len(out),
        "has_more": len(out) == limit,
        "next_cursor": (f"{last['publication_date']}|{last['document_number']}"
                        if last else None),
        "changes": out,
    }


@app.get("/api/sitemap")
def sitemap(chunk: int = Query(0, ge=0, le=100),
            size: int = Query(5000, ge=1, le=10000),
            conn=Depends(db), _=Depends(guard("cheap"))):
    """Leaf HTS codes for sitemap generation, in stable chunks.

    Metered: a hundred chunks of ten thousand enumerates the whole schedule,
    and the assembled dataset is the thing worth having. Our own build passes
    an API key, so it is unaffected.
    """
    rows = conn.execute(
        "SELECT hts FROM hts WHERE is_leaf = 1 ORDER BY hts LIMIT ? OFFSET ?",
        (size, chunk * size),
    ).fetchall()
    total = conn.execute(
        "SELECT count(*) c FROM hts WHERE is_leaf = 1").fetchone()["c"]
    return {
        "chunk": chunk,
        "chunks": (total + size - 1) // size,
        "total": total,
        "codes": [r["hts"] for r in rows],
    }


@app.get("/api/chapters")
def chapters(conn=Depends(db), _=Depends(guard("cheap"))):
    rows = conn.execute(
        """SELECT chapter, count(*) codes,
                  min(CASE WHEN indent = 0 THEN description END) title
             FROM hts WHERE is_leaf = 1 GROUP BY chapter ORDER BY chapter"""
    ).fetchall()
    return {"chapters": [dict(r) for r in rows]}
