"""Section 232 duties on aluminum, steel and copper (U.S. note 16, 9903.82.xx).

Note 16(c) lists the articles the metals duties cover, in eleven lists that fix
which heading applies. The headings are mutually exclusive (16(a)), so one
article is charged under at most one of them, and the choice is a function of
the code, the origin and one fact only the importer knows: for goods outside
chapters 72, 73, 74 and 76, the share of the article's weight that is the listed
metal (the duties apply only from 15 percent).

    lists (i)-(v)                 heading 9903.82.02   +50% on the full value
    lists (vi)-(viii), (xi)       heading 9903.82.09   +25%
    lists (ix)-(x)                headings 9903.82.10/.11, topped up to 15%

Everything the note makes conditional on a claim the importer would have to
make (85% U.S.-melted metal, 95% U.K. metal, use in U.S. manufacturing, quota
allocations) is assumed not made: the duty shown is the ordinary one, and the
quote says so. Anything the engine cannot decide stays unknown, so a quote is
never quietly understated.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal

TABLE_TOKEN = r"\d{4}(?:\.\d{2}(?:\.\d{2}(?:\d{2})?)?)?"
_TABLE_LINE = re.compile(rf"^\s*(?:{TABLE_TOKEN}\s*)+$")
_LIST_HEAD = re.compile(
    r"\n\s*\((i|ii|iii|iv|v|vi|vii|viii|ix|x|xi)\)\s+(?:Articles|Derivative)[^\n]*")

METAL_CHAPTERS = ("72", "73", "74", "76")
WEIGHT_MIN = Decimal("15")

GROUP_A = ("i", "ii", "iii", "iv", "v")            # 9903.82.02
GROUP_B = ("vi", "vii", "viii", "xi")              # 9903.82.09
GROUP_C = ("ix", "x")                              # 9903.82.10 / .11
HEADING_A, HEADING_B = "9903.82.02", "9903.82.09"
HEADINGS_C = ("9903.82.10", "9903.82.11")
LOW, HIGH = "9903.82.01", "9903.82.26"


def extract_lists(note16: str) -> dict[str, frozenset[str]]:
    """The eleven product lists of note 16(c), as HTS digit prefixes."""
    start = re.search(r"\n\s*\(c\)\s+Headings 9903\.82\.02", note16)
    end = re.search(r"\n\s*\(d\)\s+Headings 9903\.82\.04", note16)
    if not start or not end:
        return {}
    seg = note16[start.start():end.start()]
    heads = list(_LIST_HEAD.finditer(seg))
    out: dict[str, frozenset[str]] = {}
    for i, m in enumerate(heads):
        stop = heads[i + 1].start() if i + 1 < len(heads) else len(seg)
        codes: set[str] = set()
        for line in seg[m.end():stop].split("\n"):
            if _TABLE_LINE.match(line):
                codes |= {c.replace(".", "") for c in re.findall(TABLE_TOKEN, line)}
        out[m.group(1)] = frozenset(codes)
    return out


@dataclass
class Selection:
    """What the metals regime says about one code, origin and set of facts."""
    status: str = "not_subject"                  # subject | not_subject | unknown
    headings: tuple[str, ...] = ()               # the headings that carry the duty
    candidates: tuple[str, ...] = ()             # headings that might, when unknown
    assumptions: list[str] = field(default_factory=list)
    needs: tuple[str, ...] = ()                  # facts that would settle an unknown


@dataclass
class MetalsIndex:
    lists: dict[str, "Domain"]                   # noqa: F821  (regimes.Domain)
    gn3b: frozenset[str] = frozenset()           # origins named in general note 3(b)
    deal_origins: frozenset[str] = frozenset()   # origins 9903.82.22 names

    def __bool__(self) -> bool:
        return any(bool(d) for d in self.lists.values())

    def hits(self, digits: str) -> tuple[str, ...]:
        return tuple(k for k, d in self.lists.items() if d.covers(digits))

    def select(self, digits: str, origin: str, weight_pct: Decimal | None) -> Selection:
        hit = self.hits(digits)
        if not hit:
            return Selection()
        a = [k for k in hit if k in GROUP_A]
        b = [k for k in hit if k in GROUP_B]
        c = [k for k in hit if k in GROUP_C]
        if len([g for g in (a, b, c) if g]) != 1:
            return Selection("unknown", candidates=(HEADING_A, HEADING_B, *HEADINGS_C))
        heads = ((HEADING_A,) if a else (HEADING_B,) if b else HEADINGS_C)
        if origin in self.gn3b or (b and "xi" in hit and origin in self.deal_origins):
            return Selection("unknown", candidates=heads)
        notes: list[str] = []
        if digits[:2] not in METAL_CHAPTERS:
            if weight_pct is None:
                return Selection("unknown", candidates=heads, needs=("metal_weight_pct",))
            if weight_pct < WEIGHT_MIN:
                return Selection(assumptions=[
                    f"The article is {weight_pct}% metal by weight, under the 15% the "
                    "Section 232 metals duties (U.S. note 16(c)) require, so they are not charged."])
            notes.append(
                f"The Section 232 metals duty applies because the article is {weight_pct}% "
                "metal by weight (15% or more, U.S. note 16(c)).")
        notes.append(
            "The ordinary rate is assumed: no claim to the lower rates for metal melted "
            "and poured in the United States (85%) or the United Kingdom (95%), for U.S. "
            "manufacturing use, or to a quota allocation (U.S. note 16(d)-(k)).")
        return Selection("subject", headings=heads, assumptions=notes)
