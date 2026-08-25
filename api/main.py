"""Tariffwise HTTP API.

Serves the duty engine, classifier and reference data. Reference data is
read-only SQLite shipped as a build artifact, so the service has no database
to provision and starts cold in milliseconds.
"""
from __future__ import annotations

import json
import logging
import os
import sys
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
from core.engine import TariffEngine
from store.db import connect, get_meta

ROOT = Path(__file__).resolve().parent.parent

# Wall-clock ceiling on a single audit, whatever the item count.
AUDIT_BUDGET_SECONDS = float(os.environ.get("TARIFFWISE_AUDIT_BUDGET", "45"))
app = FastAPI(
    title="Tariffwise API",
    version="0.1.0",
    description="Duty calculation and HTS classification for US importers.",
)
# Deny cross-origin by default. An explicit origin list is required to enable
# it, so a misconfigured deployment fails closed rather than open.
_origins = [o.strip() for o in os.environ.get("TARIFFWISE_ORIGINS", "").split(",") if o.strip()]
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
    return response


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    """Return an opaque error. Exception text leaks internals — an invalid
    value was surfacing `decimal.InvalidOperation` to callers."""
    logging.exception("unhandled error on %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal error"})

_engine: TariffEngine | None = None


def engine() -> TariffEngine:
    global _engine
    if _engine is None:
        _engine = TariffEngine(str(ROOT / "data" / "hts_2026.json"),
                               str(ROOT / "data" / "chapter99.txt"))
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
    by_vessel: bool = True


class CatalogItem(BaseModel):
    sku: str = Field("", max_length=64)
    description: str = Field(..., max_length=MAX_TEXT)
    country: str = Field(..., max_length=MAX_TEXT)
    value: float = Field(..., gt=0, le=1e12)
    hts: str | None = Field(None, max_length=20)


class AuditRequest(BaseModel):
    items: list[CatalogItem] = Field(..., min_length=1, max_length=KEYED_AUDIT_ITEMS)


# --------------------------------------------------------------------------- routes

@app.get("/api/health")
def health(conn=Depends(db)):
    counts = {
        t: conn.execute(f"SELECT count(*) c FROM {t}").fetchone()["c"]
        for t in ("hts", "ch99_rule", "ch99_scope", "ruling", "fr_document")
    }
    return {
        "status": "ok",
        "hts_edition": get_meta(conn, "hts_edition"),
        "built_at": get_meta(conn, "built_at"),
        "cross_ingested_at": get_meta(conn, "cross_ingested_at"),
        "counts": counts,
        "reasoning_enabled": bool(os.environ.get("ANTHROPIC_API_KEY")),
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
        quote = engine().quote(hts=code, country=country, value=value).as_dict()

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
    row = conn.execute("SELECT is_leaf FROM hts WHERE hts = ?", (req.hts,)).fetchone()
    if not row:
        raise HTTPException(404, f"HTS code {req.hts} not found")
    if not row["is_leaf"]:
        raise HTTPException(400, f"{req.hts} is not a 10-digit statistical line")
    try:
        result = engine().quote(hts=req.hts, country=req.country, value=req.value,
                                fta_claimed=req.fta_claimed, by_vessel=req.by_vessel)
    except (InvalidOperation, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return result.as_dict()


@app.post("/api/audit")
def audit(req: AuditRequest, conn=Depends(db), keyed: bool = Depends(guard("audit"))):
    """Score a product catalogue: duty owed, refundable duty, and gaps.

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

    eng, lines = engine(), []
    total_value = total_duty = total_refundable = Decimal("0")
    unclassified = flagged = 0
    started = time.monotonic()
    truncated = False

    for item in req.items:
        if time.monotonic() - started > AUDIT_BUDGET_SECONDS:
            truncated = True
            break

        hts, confidence, suggested = item.hts, "given", []
        if not hts:
            cls = run_classify(conn, item.description, limit=3)
            if cls.candidates:
                hts = cls.candidates[0].hts
                confidence = cls.candidates[0].confidence
                suggested = [c.as_dict() for c in cls.candidates]
            else:
                unclassified += 1
                lines.append({"sku": item.sku, "description": item.description,
                              "hts": None, "error": "could not classify"})
                continue

        try:
            q = eng.quote(hts=hts, country=item.country, value=item.value)
        except Exception:
            lines.append({"sku": item.sku, "hts": hts,
                          "error": "could not price this line"})
            continue

        total_value += q.entered_value
        total_duty += q.total_duty
        total_refundable += q.refundable_amount
        if q.scope_unverified:
            flagged += 1
        lines.append({
            "sku": item.sku, "description": item.description, "hts": hts,
            "confidence": confidence, "country": item.country,
            "entered_value": float(q.entered_value),
            "duty": float(q.total_duty),
            "effective_rate_pct": float(q.effective_rate_pct),
            "refundable": float(q.refundable_amount),
            "scope_unverified": q.scope_unverified,
            "suggested": suggested,
        })

    return {
        "summary": {
            "items": len(lines),
            "submitted": len(req.items),
            "truncated": truncated,
            "entered_value": float(total_value),
            "duty": float(total_duty),
            "effective_rate_pct": float(
                (total_duty / total_value * 100).quantize(Decimal("0.01"))
                if total_value else 0),
            "potentially_refundable": float(total_refundable),
            "unclassified": unclassified,
            "needs_scope_review": flagged,
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


@app.get("/api/changes")
def changes(days: int = Query(90, ge=1, le=3650),
            limit: int = Query(50, ge=1, le=200),
            conn=Depends(db), _=Depends(guard("cheap"))):
    rows = conn.execute(
        """SELECT document_number, title, doc_type, publication_date, html_url,
                  abstract, hts_mentions
             FROM fr_document
            WHERE publication_date >= date('now', ?)
            ORDER BY publication_date DESC LIMIT ?""",
        (f"-{days} days", limit),
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["hts_mentions"] = json.loads(d.get("hts_mentions") or "[]")
        out.append(d)
    return {"days": days, "count": len(out), "changes": out}


@app.get("/api/sitemap")
def sitemap(chunk: int = Query(0, ge=0, le=100),
            size: int = Query(5000, ge=1, le=10000), conn=Depends(db)):
    """Leaf HTS codes for sitemap generation, in stable chunks."""
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
def chapters(conn=Depends(db)):
    rows = conn.execute(
        """SELECT chapter, count(*) codes,
                  min(CASE WHEN indent = 0 THEN description END) title
             FROM hts WHERE is_leaf = 1 GROUP BY chapter ORDER BY chapter"""
    ).fetchall()
    return {"chapters": [dict(r) for r in rows]}
