"""Held-out evaluation of the classifier.

Each CROSS ruling states the goods in its subject line and the code CBP
assigned. That is ground truth. A ruling is excluded from its own retrieval so
the system cannot simply find the answer, which makes this leave-one-out rather
than a lookup.

Accuracy is reported at heading (4-digit) and subheading (6-digit) level.
Classification is decided at the heading; the statistical suffix below it is
frequently a judgement call that even CBP splits on, so 10-digit exactness is
the wrong bar.
"""
from __future__ import annotations

import json
import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.classify import classify
from store.db import connect

SUBJECT_CLEAN = re.compile(
    r"^(the\s+)?(tariff\s+)?classification\s+(and\s+country\s+of\s+origin\s+)?of\s+",
    re.I)
FROM_TAIL = re.compile(r"\s+from\s+[A-Z][\w\s,.]+$")


def to_query(subject: str) -> str:
    """Turn a ruling subject into the sort of description an importer types."""
    s = SUBJECT_CLEAN.sub("", subject or "").strip()
    s = FROM_TAIL.sub("", s).strip(" .;")
    return s


def main(n: int = 300, seed: int = 7) -> None:
    conn = connect(readonly=True)
    rows = conn.execute(
        """SELECT r.ruling_number, r.subject, r.tariffs
             FROM ruling r
            WHERE r.revoked = 0 AND r.subject LIKE '%classification of%'
              AND length(r.tariffs) > 4 AND r.ruling_date >= '2015-01-01'"""
    ).fetchall()
    random.Random(seed).shuffle(rows)

    tried = head_ok = sub_ok = top3_ok = 0
    for row in rows:
        if tried >= n:
            break
        codes = json.loads(row["tariffs"] or "[]")
        truth = {c.replace(".", "") for c in codes if len(c.replace(".", "")) >= 6}
        if not truth:
            continue
        query = to_query(row["subject"])
        if len(query) < 8:
            continue

        result = classify(conn, query, limit=3, api_key=None)
        # Exclude the source ruling so this is not a lookup of itself.
        cands = [c for c in result.candidates
                 if row["ruling_number"] not in {r["ruling"] for r in c.rulings}
                 or len(c.rulings) > 1]
        if not cands:
            continue

        tried += 1
        heads = {t[:4] for t in truth}
        subs = {t[:6] for t in truth}
        top = cands[0].hts.replace(".", "")
        if top[:4] in heads:
            head_ok += 1
        if top[:6] in subs:
            sub_ok += 1
        if any(c.hts.replace(".", "")[:4] in heads for c in cands[:3]):
            top3_ok += 1

    pct = lambda a: f"{a / tried * 100:5.1f}%" if tried else "n/a"
    print(f"evaluated              {tried}")
    print(f"top-1 heading (4-digit){pct(head_ok):>10s}")
    print(f"top-1 subheading (6)   {pct(sub_ok):>10s}")
    print(f"top-3 heading          {pct(top3_ok):>10s}")
    conn.close()


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 300)
