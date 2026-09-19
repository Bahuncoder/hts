"""Held-out evaluation of the classifier.

Each CROSS ruling states the goods in its subject line and the code CBP
assigned. That is ground truth. For each case the ruling itself, and every
ruling with the same subject (CBP issues families of near-identical rulings),
is removed from retrieval BEFORE scoring, so the answer cannot vote for
itself. An earlier version filtered the answer out of the results afterwards,
which left its influence on every score, and skipped cases with no surviving
candidate, which inflated the rate; neither is true of this version.

Retrieval only. The paid reasoning layer is disabled structurally
(`use_reasoning=False`), not by hoping no key is set, so a run can neither
spend money nor blend two systems into one number.

Reported at the levels the product acts on: heading (4), subheading (6),
8-digit and the exact 10-digit line that pricing uses. Cases where nothing was
retrieved count as misses; they are reported as abstentions, never dropped.

Limits: same-subject exclusion does not catch near-duplicates worded
differently, so treat the figures as an upper bound on unseen-product accuracy.
"""
from __future__ import annotations

import json
import random
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.classify import classify
from store.db import connect, get_meta

SUBJECT_CLEAN = re.compile(
    r"^(the\s+)?(tariff\s+)?classification\s+(and\s+country\s+of\s+origin\s+)?of\s+",
    re.I)
FROM_TAIL = re.compile(r"\s+from\s+[A-Z][\w\s,.]+$")


def to_query(subject: str) -> str:
    """Turn a ruling subject into the sort of description an importer types."""
    s = SUBJECT_CLEAN.sub("", subject or "").strip()
    s = FROM_TAIL.sub("", s).strip(" .;")
    return s


def normalise(subject: str) -> str:
    return re.sub(r"\W+", " ", to_query(subject).lower()).strip()


def main(n: int = 300, seed: int = 7) -> None:
    conn = connect(readonly=True)
    rows = conn.execute(
        """SELECT r.ruling_number, r.subject, r.tariffs
             FROM ruling r
            WHERE r.revoked = 0 AND r.subject LIKE '%classification of%'
              AND length(r.tariffs) > 4 AND r.ruling_date >= '2015-01-01'"""
    ).fetchall()
    random.Random(seed).shuffle(rows)

    family: dict[str, set[str]] = defaultdict(set)
    for num, subj in conn.execute("SELECT ruling_number, subject FROM ruling"):
        family[normalise(subj or "")].add(num)

    tried = abstained = head_ok = sub6_ok = sub8_ok = exact_ok = top3_ok = 0
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

        held_out = frozenset(family[normalise(row["subject"])] | {row["ruling_number"]})
        result = classify(conn, query, limit=3, use_reasoning=False,
                          exclude_rulings=held_out)
        tried += 1
        if not result.candidates:
            abstained += 1
            continue

        cands = result.candidates
        heads = {t[:4] for t in truth}
        top = cands[0].hts.replace(".", "")
        head_ok += top[:4] in heads
        sub6_ok += top[:6] in {t[:6] for t in truth}
        sub8_ok += top[:8] in {t[:8] for t in truth if len(t) >= 8}
        exact_ok += top in {t for t in truth if len(t) == 10}
        top3_ok += any(c.hts.replace(".", "")[:4] in heads for c in cands[:3])

    pct = lambda a: f"{a / tried * 100:5.1f}%" if tried else "n/a"
    print(f"dataset revision       {get_meta(conn, 'dataset_revision') or '(legacy build)'}")
    print(f"corpus                 {conn.execute('select count(*) from ruling').fetchone()[0]:,} rulings, seed {seed}")
    print(f"cases                  {tried}   (abstained: {abstained}, counted as misses)")
    print(f"top-1 heading (4)      {pct(head_ok):>8s}")
    print(f"top-1 subheading (6)   {pct(sub6_ok):>8s}")
    print(f"top-1 8-digit          {pct(sub8_ok):>8s}")
    print(f"top-1 exact 10-digit   {pct(exact_ok):>8s}   <- the line pricing uses")
    print(f"top-3 heading          {pct(top3_ok):>8s}")
    conn.close()


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 300)
