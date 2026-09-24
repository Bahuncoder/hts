"""Held-out evaluation of the classifier.

Each CROSS ruling states the goods in its subject line and the code CBP
assigned. That is ground truth. For each case the ruling itself, and every
ruling with the same subject (CBP issues families of near-identical rulings),
is removed from retrieval BEFORE scoring, so the answer cannot vote for
itself. An earlier version filtered the answer out of the results afterwards,
which left its influence on every score, and skipped cases with no surviving
candidate, which inflated the rate; neither is true of this version.

Retrieval-only by default. The paid reasoning layer is disabled structurally
(`use_reasoning=False`), not by hoping no key is set, so a plain run can
neither spend money nor blend two systems into one number.

Pass --reasoning to ALSO measure the reasoning layer, on the same held-out
cases, scored side by side with the same retrieval-only baseline in the same
run (not compared against a number from a different day or dataset
revision). This calls the real model — it costs money and needs
ANTHROPIC_API_KEY — so it defaults to a much smaller sample than the
retrieval-only run; see --reasoning=N. Each case's retrieval step still runs
first regardless (free, local); only the reasoning call over its own
candidates is the paid, capped part. A case the reasoning layer degrades on
(network error, unparsable reply — core/classify.py's own "never fail"
contract) is counted separately, not silently folded into either score.

Reported at the levels the product acts on: heading (4), subheading (6),
8-digit and the exact 10-digit line that pricing uses. Cases where nothing was
retrieved count as misses; they are reported as abstentions, never dropped.

Limits: same-subject exclusion does not catch near-duplicates worded
differently, so treat the figures as an upper bound on unseen-product accuracy.
"""
from __future__ import annotations

import json
import os
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


class Tally:
    """One scoreboard, so the retrieval-only and reasoning passes share
    exactly the scoring logic being compared, not two copies that could
    silently drift apart."""
    def __init__(self) -> None:
        self.tried = self.abstained = 0
        self.head_ok = self.sub6_ok = self.sub8_ok = self.exact_ok = self.top3_ok = 0

    def score(self, cands, truth: set[str]) -> None:
        self.tried += 1
        if not cands:
            self.abstained += 1
            return
        heads = {t[:4] for t in truth}
        top = cands[0].hts.replace(".", "")
        self.head_ok += top[:4] in heads
        self.sub6_ok += top[:6] in {t[:6] for t in truth}
        self.sub8_ok += top[:8] in {t[:8] for t in truth if len(t) >= 8}
        self.exact_ok += top in {t for t in truth if len(t) == 10}
        self.top3_ok += any(c.hts.replace(".", "")[:4] in heads for c in cands[:3])

    def report(self, label: str) -> None:
        pct = lambda a: f"{a / self.tried * 100:5.1f}%" if self.tried else "n/a"
        print(f"\n-- {label} --")
        print(f"cases                  {self.tried}   (abstained: {self.abstained}, counted as misses)")
        print(f"top-1 heading (4)      {pct(self.head_ok):>8s}")
        print(f"top-1 subheading (6)   {pct(self.sub6_ok):>8s}")
        print(f"top-1 8-digit          {pct(self.sub8_ok):>8s}")
        print(f"top-1 exact 10-digit   {pct(self.exact_ok):>8s}   <- the line pricing uses")
        print(f"top-3 heading          {pct(self.top3_ok):>8s}")


def main(n: int = 300, seed: int = 7, reasoning_n: int = 0) -> None:
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

    if reasoning_n and not os.environ.get("ANTHROPIC_API_KEY"):
        print("--reasoning was passed but ANTHROPIC_API_KEY is not set; "
              "the reasoning pass would just measure its own no-key fallback. Stopping.",
              file=sys.stderr)
        sys.exit(2)

    retrieval, reasoned = Tally(), Tally()
    reasoning_failed = 0
    for row in rows:
        if retrieval.tried >= n:
            break
        codes = json.loads(row["tariffs"] or "[]")
        truth = {c.replace(".", "") for c in codes if len(c.replace(".", "")) >= 6}
        if not truth:
            continue
        query = to_query(row["subject"])
        if len(query) < 8:
            continue

        held_out = frozenset(family[normalise(row["subject"])] | {row["ruling_number"]})
        base = classify(conn, query, limit=3, use_reasoning=False, exclude_rulings=held_out)
        retrieval.score(base.candidates, truth)

        if reasoning_n and reasoned.tried < reasoning_n:
            reasoned_result = classify(conn, query, limit=3, use_reasoning=True, exclude_rulings=held_out)
            if not reasoned_result.reasoned:
                reasoning_failed += 1
            reasoned.score(reasoned_result.candidates, truth)

    print(f"dataset revision       {get_meta(conn, 'dataset_revision') or '(legacy build)'}")
    print(f"corpus                 {conn.execute('select count(*) from ruling').fetchone()[0]:,} rulings, seed {seed}")
    retrieval.report("retrieval only (free, structurally cannot call the model)")
    if reasoning_n:
        reasoned.report(f"with reasoning ({os.environ.get('HTSDESK_MODEL', 'claude-opus-5')}, real API calls)")
        if reasoning_failed:
            print(f"\nreasoning degraded to retrieval order on {reasoning_failed} of {reasoned.tried} "
                  "case(s) (network error or an unparsable reply — never counted as a reasoning success)")
    conn.close()


if __name__ == "__main__":
    args = sys.argv[1:]
    reasoning_n = 0
    for a in list(args):
        if a == "--reasoning":
            reasoning_n = 50
            args.remove(a)
        elif a.startswith("--reasoning="):
            reasoning_n = int(a.split("=", 1)[1])
            args.remove(a)
    main(int(args[0]) if args else 300, reasoning_n=reasoning_n)
