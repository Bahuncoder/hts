"""HTS classification.

Classification is the job importers actually cannot do for themselves, and the
one every free duty calculator punts on by demanding a code up front.

Two stages:

  1. Retrieval (always on). Full-text search over 19,949 HTS leaf descriptions
     and over the CROSS ruling corpus, whose rulings are pre-tagged with the
     codes CBP itself assigned. A code that CBP has repeatedly assigned to
     similar goods is a far stronger signal than description overlap alone.

  2. Reasoning (enabled by an API key). A model applies the General Rules of
     Interpretation to the retrieved candidates and must ground its answer in
     the cited rulings. Without a key the retrieval ranking stands on its own,
     so the system degrades rather than fails.

Output is always evidence-bearing: every candidate carries the rulings that
support it, because the importer's reasonable-care duty under 19 U.S.C. 1484
is non-delegable and an uncited code is useless to them.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
from dataclasses import dataclass, field

MODEL = os.environ.get("TARIFFWISE_MODEL", "claude-opus-5")
API_URL = "https://api.anthropic.com/v1/messages"

_FTS_STRIP = re.compile(r"[^\w\s]")
_STOP = {
    "the", "a", "an", "of", "for", "with", "and", "or", "in", "on", "to",
    "from", "made", "used", "item", "product", "products", "goods",
}


@dataclass
class Candidate:
    hts: str
    description: str
    full_path: str
    general_rate: str = ""
    score: float = 0.0
    ruling_support: int = 0
    rulings: list[dict] = field(default_factory=list)
    reasoning: str = ""
    confidence: str = "low"

    def as_dict(self) -> dict:
        return {
            "hts": self.hts,
            "description": self.description,
            "full_path": self.full_path,
            "general_rate": self.general_rate,
            "score": round(self.score, 4),
            "ruling_support": self.ruling_support,
            "rulings": self.rulings,
            "reasoning": self.reasoning,
            "confidence": self.confidence,
        }


@dataclass
class Classification:
    query: str
    candidates: list[Candidate] = field(default_factory=list)
    reasoned: bool = False
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "query": self.query,
            "candidates": [c.as_dict() for c in self.candidates],
            "reasoned": self.reasoned,
            "notes": self.notes,
        }


def _terms(text: str) -> list[str]:
    seen, out = set(), []
    for w in _FTS_STRIP.sub(" ", text.lower()).split():
        if len(w) > 2 and w not in _STOP and w not in seen:
            seen.add(w)
            out.append(w)
    return out[:14]


def _fts_query(text: str) -> str:
    """Build a tolerant FTS5 OR-query from free text."""
    return " OR ".join(f'"{w}"' for w in _terms(text))


def _coverage(terms: list[str], *texts: str) -> float:
    """Share of query terms present in the candidate text.

    Pure bm25 over an OR-query lets one common word carry a match: "silicone
    phone case" retrieved "mobile drilling derricks" on the strength of a
    single token. Weighting by coverage suppresses that.
    """
    if not terms:
        return 0.0
    blob = set(_FTS_STRIP.sub(" ", " ".join(texts).lower()).split())
    # Match on whole words with a light prefix tolerance for plurals and
    # inflections. Substring matching is wrong here: "phone" is inside
    # "telephone", which is how a phone case matched a drilling derrick.
    hit = 0
    for t in terms:
        if t in blob or any(w.startswith(t) and len(w) - len(t) <= 3 for w in blob):
            hit += 1
    return hit / len(terms)


def _search_hts(conn: sqlite3.Connection, query: str, limit: int) -> dict[str, Candidate]:
    q = _fts_query(query)
    if not q:
        return {}
    rows = conn.execute(
        """SELECT f.hts, h.description, h.full_path, h.general_rate,
                  bm25(hts_fts) AS rank
             FROM hts_fts f JOIN hts h ON h.hts = f.hts
            WHERE hts_fts MATCH ?
            ORDER BY rank LIMIT ?""",
        (q, limit),
    ).fetchall()
    terms = _terms(query)
    out: dict[str, Candidate] = {}
    for r in rows:
        # bm25 returns increasingly negative values for better matches.
        cov = _coverage(terms, r["description"], r["full_path"])
        out[r["hts"]] = Candidate(
            hts=r["hts"], description=r["description"], full_path=r["full_path"],
            general_rate=r["general_rate"] or "",
            # Squaring coverage makes a one-word accident lose decisively.
            score=-float(r["rank"]) * (cov ** 2),
        )
    return out


def _search_rulings(conn: sqlite3.Connection, query: str, limit: int) -> list[sqlite3.Row]:
    q = _fts_query(query)
    if not q:
        return []
    return conn.execute(
        """SELECT r.ruling_number, r.subject, r.ruling_date, r.tariffs, r.revoked,
                  r.url, substr(COALESCE(r.body, ''), 1, 900) AS body_head,
                  bm25(ruling_fts) AS rank
             FROM ruling_fts f JOIN ruling r ON r.ruling_number = f.ruling_number
            WHERE ruling_fts MATCH ?
            ORDER BY rank LIMIT ?""",
        (q, limit),
    ).fetchall()


_LEAF_CACHE: dict[str, dict | None] = {}


def _leaf_for(conn: sqlite3.Connection, code: str) -> dict | None:
    """Resolve a ruling's tariff reference to a 10-digit leaf line.

    Rulings cite the same few thousand codes over and over, so this is cached;
    uncached it dominates classification latency.
    """
    key = code.replace(".", "")[:8]
    if key in _LEAF_CACHE:
        return _LEAF_CACHE[key]
    row = conn.execute(
        "SELECT hts, description, full_path, general_rate FROM hts "
        "WHERE is_leaf = 1 AND digits GLOB ? ORDER BY hts LIMIT 1",
        (key + "*",),
    ).fetchone()
    _LEAF_CACHE[key] = dict(row) if row else None
    return _LEAF_CACHE[key]


def retrieve(conn: sqlite3.Connection, query: str, *, limit: int = 8) -> list[Candidate]:
    """Rank candidate codes from CBP ruling precedent, refined by heading text.

    The correct heading appears somewhere in the ruling votes for ~99% of
    queries, so the work is ranking, not recall. Two things make the ranking
    hold up:

      * votes are decided at heading (4-digit) level, where classification is
        actually settled, before any statistical suffix is chosen;
      * a ruling's weight falls off sharply with how little of the query it
        matches, so the long tail of loosely-related rulings cannot outvote a
        handful of closely-matching ones.

    HTS description text alone finds the right heading less than half the time,
    so it is used only to choose between leaves inside a heading precedent has
    already selected — never to select the heading itself.
    """
    terms = _terms(query)
    text_cands = _search_hts(conn, query, limit=60)

    head_votes: dict[str, float] = {}
    code_votes: dict[str, float] = {}
    evidence: dict[str, list[dict]] = {}
    seen_rulings: dict[str, set[str]] = {}

    for row in _search_rulings(conn, query, limit=120):
        # Score against the opening of the ruling as well as its subject. The
        # subject names the goods; the opening paragraphs describe them, which
        # is where material and construction — the facts classification turns
        # on — actually appear.
        cov = max(
            _coverage(terms, row["subject"] or ""),
            _coverage(terms, row["subject"] or "", row["body_head"] or ""),
        )
        if cov < 0.34:
            continue
        # Cubing coverage separates a close match from a loose one decisively;
        # with ~68 rulings matching a typical query, a flat weight lets the
        # tail outvote the signal.
        weight = (cov ** 3) / (1.0 + abs(float(row["rank"])))
        if row["revoked"]:
            weight *= 0.25
        for code in json.loads(row["tariffs"] or "[]"):
            digits = code.replace(".", "")
            head = digits[:4]
            if len(head) < 4 or not head.isdigit():
                continue
            head_votes[head] = head_votes.get(head, 0.0) + weight
            code_votes[digits[:8]] = code_votes.get(digits[:8], 0.0) + weight
            seen = seen_rulings.setdefault(head, set())
            if row["ruling_number"] not in seen:
                seen.add(row["ruling_number"])
                bucket = evidence.setdefault(head, [])
                if len(bucket) < 5:
                    bucket.append({
                        "ruling": row["ruling_number"], "subject": row["subject"],
                        "date": row["ruling_date"], "revoked": bool(row["revoked"]),
                        "url": row["url"],
                    })

    if not head_votes:
        return sorted(text_cands.values(), key=lambda c: -c.score)[:limit]

    top_heads = sorted(head_votes, key=lambda h: -head_votes[h])[:max(limit, 6)]
    best = max(head_votes.values()) or 1.0

    out: list[Candidate] = []
    for head in top_heads:
        # Choose the leaf within the winning heading: prefer the 8-digit
        # subheading CBP itself cited most, then description overlap.
        leaves = conn.execute(
            "SELECT hts, digits, description, full_path, general_rate FROM hts "
            "WHERE is_leaf = 1 AND digits GLOB ? ORDER BY hts",
            (head + "*",),
        ).fetchall()
        if not leaves:
            continue
        pick, pick_score = None, -1.0
        for lf in leaves:
            sub = lf["digits"][:8]
            score = code_votes.get(sub, 0.0) * 100.0
            score += _coverage(terms, lf["description"], lf["full_path"])
            if lf["hts"] in text_cands:
                score += 0.5
            if score > pick_score:
                pick, pick_score = lf, score
        cand = Candidate(
            hts=pick["hts"], description=pick["description"],
            full_path=pick["full_path"], general_rate=pick["general_rate"] or "",
            score=head_votes[head] / best,
            ruling_support=len(seen_rulings.get(head, ())),
            rulings=evidence.get(head, []),
        )
        cand.confidence = ("high" if cand.ruling_support >= 3 and cand.score > 0.5
                           else "medium" if cand.ruling_support >= 2
                           else "low")
        out.append(cand)

    return out[:limit]


def _prompt(query: str, cands: list[Candidate]) -> str:
    lines = [
        "You are classifying goods under the Harmonized Tariff Schedule of the "
        "United States. Apply the General Rules of Interpretation in order "
        "(GRI 1 first; only reach GRI 3 if a good is prima facie classifiable "
        "under two or more headings).",
        "",
        f"Goods: {query}",
        "",
        "Candidate classifications, with CBP ruling precedent:",
    ]
    for c in cands:
        lines.append(f"\n[{c.hts}] {c.description}")
        lines.append(f"  context: {c.full_path[:300]}")
        lines.append(f"  MFN rate: {c.general_rate or 'see superior line'}")
        if c.rulings:
            for r in c.rulings[:3]:
                flag = " (REVOKED)" if r["revoked"] else ""
                lines.append(f"  precedent {r['ruling']}{flag}: {r['subject'][:110]}")
        else:
            lines.append("  precedent: none found")
    lines += [
        "",
        "Rank the candidates. Ground every conclusion in the listed rulings or in "
        "the terms of the headings; do not invent rulings or codes. If the "
        "description lacks a fact the classification turns on (material "
        "composition, function, whether a set is put up for retail sale), say "
        "which fact is missing.",
        "",
        'Reply as JSON only: {"ranked":[{"hts":"...","confidence":"high|medium|low",'
        '"reasoning":"...","gri":"..."}],"missing_facts":["..."]}',
    ]
    return "\n".join(lines)


def _reason(query: str, cands: list[Candidate], api_key: str) -> tuple[list[Candidate], list[str]]:
    import httpx

    resp = httpx.post(
        API_URL,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": MODEL,
            "max_tokens": 2000,
            "messages": [{"role": "user", "content": _prompt(query, cands)}],
        },
        timeout=90,
    )
    resp.raise_for_status()
    text = "".join(b.get("text", "") for b in resp.json().get("content", []))
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return cands, ["model returned no parsable ranking; retrieval order kept"]
    data = json.loads(m.group(0))

    by_code = {c.hts: c for c in cands}
    ordered: list[Candidate] = []
    for item in data.get("ranked", []):
        c = by_code.pop(item.get("hts", ""), None)
        if not c:
            continue
        c.reasoning = " ".join(filter(None, [item.get("gri", ""), item.get("reasoning", "")])).strip()
        c.confidence = item.get("confidence", c.confidence)
        ordered.append(c)
    ordered.extend(by_code.values())
    return ordered, list(data.get("missing_facts") or [])


def classify(conn: sqlite3.Connection, query: str, *, limit: int = 8,
             api_key: str | None = None) -> Classification:
    cands = retrieve(conn, query, limit=limit)
    result = Classification(query=query, candidates=cands)
    if not cands:
        result.notes.append("No candidate headings matched. Describe the material, "
                            "function and form of the goods.")
        return result

    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        result.notes.append(
            "Ranked by CBP ruling precedent and heading text. Set ANTHROPIC_API_KEY "
            "to add GRI reasoning over these candidates."
        )
        return result
    try:
        result.candidates, missing = _reason(query, cands, key)
        result.reasoned = True
        result.notes.extend(f"Missing fact: {m}" for m in missing)
    except Exception as exc:                      # degrade, never fail
        result.notes.append(f"Reasoning unavailable ({type(exc).__name__}); "
                            "retrieval ranking shown.")
    return result
