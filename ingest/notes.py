"""Chapter 99 U.S. Notes extractor.

Trade-remedy headings in Chapter 99 carry no machine-readable product scope in
the USITC JSON feed; they delegate it to the Chapter 99 U.S. Notes, published
only as PDF prose. Those notes enumerate covered subheadings explicitly — the
Section 301 lists literally live there:

    (b)  Heading 9903.88.01 applies to all products of China that are
         classified in the following 8-digit subheadings ...

This module turns that prose into a machine-readable scope table. Without it a
remedy heading cannot be scoped, and a duty figure cannot be computed.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

# Subdivision markers are indented and start a line: "    (b)    Heading ..."
SUBDIV = re.compile(r"\n\s{2,}\(([a-z]{1,4}|\d{1,2})\)\s")
# Product codes. Chapter 98/99 codes are cross-references, never product scope.
HTS8 = re.compile(r"\b(\d{4}\.\d{2}\.\d{2})\b")
BINDS = [
    re.compile(r"[Hh]eading\s+(9903\.\d{2}\.\d{2})\s+applies\s+to"),
    re.compile(r"[Ff]or the purposes of heading\s+(9903\.\d{2}\.\d{2})"),
    re.compile(r"subject to[^.]{0,80}under heading\s+(9903\.\d{2}\.\d{2})"),
]
COUNTRY = re.compile(r"products? of ([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})")
EFFECTIVE = re.compile(r"on or after\s+([A-Z][a-z]+ \d{1,2},? \d{4})")
EXCLUSION_REF = re.compile(r"granted an exclusion[^.]{0,4000}", re.S)
IN_EFFECT = re.compile(r"only subdivisions?\s+(.{0,200}?)\s*of this note", re.I)

_NOISE = {"The", "United", "Notwithstanding", "For", "Any", "All", "Such",
          "Articles", "Products", "This", "Subchapter", "Chapter", "Heading"}


@dataclass
class NoteScope:
    heading: str
    note: str = ""
    countries: list[str] = field(default_factory=list)
    codes: set[str] = field(default_factory=set)
    excluded_by: list[str] = field(default_factory=list)
    effective_from: str | None = None
    is_exclusion: bool = False
    described_scope: bool = False
    source_excerpt: str = ""

    def covers(self, hts10: str) -> bool:
        d = hts10.replace(".", "")
        return any(d.startswith(c.replace(".", "")) for c in self.codes)

    def as_dict(self) -> dict:
        return {
            "heading": self.heading, "note": self.note,
            "countries": self.countries, "codes": sorted(self.codes),
            "code_count": len(self.codes), "excluded_by": self.excluded_by,
            "effective_from": self.effective_from, "is_exclusion": self.is_exclusion,
            "described_scope": self.described_scope,
            "source_excerpt": self.source_excerpt[:300],
        }


def _product_codes(text: str) -> set[str]:
    """Enumerated product subheadings, excluding Chapter 98/99 cross-references."""
    return {c for c in HTS8.findall(text) if not c.startswith(("98", "99"))}


def _is_code_list(text: str, codes: set[str]) -> bool:
    """True when a block is an enumeration of subheadings rather than prose.

    Note subdivisions that continue a scope list are dense with HTS codes.
    Quantity tables and narrative subdivisions are not, and absorbing them
    fabricates coverage (a quota table once contributed 2,115 phantom codes).
    """
    if len(codes) < 10:
        return False
    words = max(len(text.split()), 1)
    return (len(HTS8.findall(text)) / words) > 0.05


def _countries(text: str) -> list[str]:
    out: list[str] = []
    for m in COUNTRY.finditer(text):
        for part in re.split(r"\s+and\s+", m.group(1).strip()):
            part = part.strip().rstrip(",.")
            if part and part.split()[0] not in _NOISE and part not in out:
                out.append(part)
    return out[:6]


def _blocks(raw: str) -> list[tuple[str, str]]:
    """Yield (subdivision_letter, body) for every indented subdivision."""
    marks = []
    for m in SUBDIV.finditer(raw):
        # A numbered item ("(2)") starts its own block only when it introduces a
        # heading: elsewhere numbers only count the entries of a list, and
        # splitting there would cut that list off from the heading it scopes.
        if m.group(1).isdigit() and not any(
                p.match(raw[m.end():m.end() + 200].lstrip()) for p in BINDS):
            continue
        marks.append((m.group(1), m.start(), m.end()))
    out = []
    for i, (letter, _, end) in enumerate(marks):
        stop = marks[i + 1][1] if i + 1 < len(marks) else len(raw)
        out.append((letter, raw[end:stop]))
    return out


def extract(raw: str, binds: list | None = None) -> dict[str, NoteScope]:
    """Bind every remedy heading to the product codes its note enumerates.

    Note subdivisions nest: heading 9903.88.15 (Section 301 List 4A) takes its
    scope from note 20(s)(i), which the PDF renders as a separate `(i)` block
    following `(s)`. A binding block therefore claims every following block up
    to the next block that binds a different heading.
    """
    scopes: dict[str, NoteScope] = {}
    current: NoteScope | None = None
    parent_countries: list[str] = []

    for letter, body in _blocks(raw):
        if not letter.isdigit():
            parent_countries = _countries(body[:1500])
        heading = None
        for pat in (binds if binds is not None else BINDS):
            m = pat.search(body[:1500])
            if m:
                heading = m.group(1)
                break

        if heading:
            sc = scopes.get(heading)
            if sc is None:
                sc = NoteScope(heading=heading, note=letter)
                scopes[heading] = sc
            # A numbered item ("(3) Heading 9903.03.14 applies to ...") names its
            # country once, in the lettered subdivision above it.
            found = _countries(body[:1500]) or (parent_countries if letter.isdigit() else [])
            for c in found:
                if c not in sc.countries:
                    sc.countries.append(c)
            if not sc.effective_from:
                em = EFFECTIVE.search(body)
                if em:
                    sc.effective_from = em.group(1)
            exc = EXCLUSION_REF.search(body)
            if exc:
                sc.excluded_by = sorted(set(re.findall(r"9903\.\d{2}\.\d{2}", exc.group(0))))
            if not sc.source_excerpt:
                sc.source_excerpt = re.sub(r"\s+", " ", body[:300]).strip()
            # A subdivision that only points elsewhere carries prose, not scope.
            sc.described_scope = sc.described_scope or bool(
                re.search(r"described in U\.S\. note", body[:1500])
            )
            current = sc

        if current is None:
            continue
        stripped = EXCLUSION_REF.sub(" ", body)
        codes = _product_codes(stripped)
        if heading is None and not _is_code_list(stripped, codes):
            # A continuation block that is prose or a quantity table belongs to
            # a different provision; absorbing it invents scope that is not there.
            current = None
            continue
        current.codes.update(codes)

    return scopes


# U.S. note 52 lists each exception as "As provided in heading 9903.06.14, the
# duties imposed by headings 9903.05.75-9903.05.76 shall not apply to articles
# the product of Taiwan that are classifiable in the following provisions:" and
# then the codes. Each statement names the headings it excuses, so it is read
# as its own segment; the generic subdivision binder above cannot do that, and
# would let one country's list bleed into the next.
_AS_PROVIDED = re.compile(r"As provided in headings?\s+(9903\.\d{2}\.\d{2})")
_IMPOSED = re.compile(
    r"dut(?:y|ies)\s+imposed\s+by\s+headings?\s+(.*?)\s+shall\s+not\s+apply", re.S)
_HEADING_SPAN = re.compile(r"(9903\.\d{2}\.\d{2})(?:\s*[–-]\s*(9903\.\d{2}\.\d{2}))?")
_LIST_CODE = re.compile(r"\b(\d{4}\.\d{2}\.\d{2}(?:\d{2})?)\b")
_CLAIMS = (("USMCA", re.compile(r"United States-Mexico-Canada Agreement")),
           ("CAFTA-DR", re.compile(r"Dominican Republic-Central America-United States")))


@dataclass
class Note52Exception:
    heading: str
    targets: tuple[tuple[str, str], ...]     # (lo, hi) heading spans excused
    codes: frozenset[str]                    # HTS digit prefixes listed
    claim: str | None = None                 # agreement the entry must claim
    head: str = ""                           # the statement, before the list

    def applies_to(self, rule_heading: str) -> bool:
        return not self.targets or any(lo <= rule_heading <= hi for lo, hi in self.targets)


def extract_note52(raw: str, lo: str = "9903.05.85",
                   hi: str = "9903.06.21") -> dict[str, Note52Exception]:
    """Every exception statement of U.S. note 52, keyed by exception heading."""
    start = raw.find("Except as provided in headings 9903.05.85")
    if start < 0:
        return {}
    tail = raw[start:]
    marks = list(_AS_PROVIDED.finditer(tail))
    out: dict[str, Note52Exception] = {}
    for i, m in enumerate(marks):
        h = m.group(1)
        if not (lo <= h <= hi):
            continue
        end = marks[i + 1].start() if i + 1 < len(marks) else len(tail)
        seg = tail[m.start():end]
        head = re.sub(r"\s+", " ", seg[:1200])
        imposed = _IMPOSED.search(seg[:1200])
        targets = tuple((a, b or a) for a, b in _HEADING_SPAN.findall(imposed.group(1))) if imposed else ()
        codes = frozenset(c.replace(".", "") for c in _LIST_CODE.findall(seg)
                          if not c.startswith(("98", "99")))
        claim = next((name for name, pat in _CLAIMS if pat.search(head)), None)
        out[h] = Note52Exception(h, targets, codes, claim, head)
    return out


def extract_exceptions(raw: str, lo: str = "9903.05.85",
                       hi: str = "9903.06.21") -> dict[str, set[str]]:
    """Product prefixes (digits) of each note-52 exception heading."""
    return {h: set(e.codes) for h, e in extract_note52(raw, lo, hi).items()}


def load(path: str) -> dict[str, NoteScope]:
    with open(path, errors="ignore") as fh:
        return extract(fh.read())


if __name__ == "__main__":
    sc = load("data/chapter99.txt")
    json.dump({k: v.as_dict() for k, v in sc.items()},
              open("data/ch99_scope.json", "w"), indent=1)
    print(f"headings scoped: {len(sc)}")
