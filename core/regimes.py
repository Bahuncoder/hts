"""Chapter 99 regimes whose product scope is not a code list on the rule.

Most Chapter 99 charge lines carry a scope the engine can read: a code list in
the notes, or codes in the line itself. Two kinds do not, and both used to be
handled badly:

* Country-wide regimes ("articles the product of China ... except for products
  described in headings 9903.05.85-9903.05.92"). The line has no product scope
  because it covers *everything* except enumerated exceptions. The exceptions
  live in the notes. These were flagged as "scope unverified" for every quote.
* Lines with neither a country nor a scope (Section 232 autos, wood, chips and
  others). These were dropped silently, so a quote in those areas came back
  understated with no warning.

This module turns both into an explicit verdict per (rule, code, origin):

    APPLY    the rule charges this entry (possibly under a stated assumption)
    SKIP     the rule provably does not reach this entry
    UNKNOWN  it might; the quote must say so (fail closed)

Nothing here is guessed. A verdict of APPLY or SKIP needs positive evidence from
the schedule's own text; anything else is UNKNOWN, which keeps the quote flagged
exactly as before.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

from core.ch99 import Ch99Rule, Effect

APPLY, SKIP, UNKNOWN = "apply", "skip", "unknown"

# Headings 9903.05.20-.84 impose the country-wide duties of U.S. note 52; note
# 52(a) lists every exception to them as headings 9903.05.85-9903.06.21.
NOTE52_RULES = ("9903.05.20", "9903.05.84")
NOTE52_EXCEPTIONS = ("9903.05.85", "9903.06.21")

# Exceptions that depend on the entry itself, not on the product code. They
# cannot be evaluated from a catalogue, so a quote states them as assumptions.
_ENTRY_EXCEPTION = re.compile(
    r"loaded onto a vessel|in transit|donations|informational materials", re.I)
_FAMILY_232 = re.compile(r"aluminum, of steel or of copper", re.I)
# Exceptions that are a code list AND an end-use condition (civil aircraft parts
# that meet general note 6; articles for use in pharmaceutical applications).
# Being on the list is necessary, not sufficient, so it never proves an exemption.
_USE_EXCEPTION = re.compile(r"civil aircraft|pharmaceutical", re.I)

# Statements the schedule makes about itself, next to the provision.
_TERMINATED = re.compile(
    r"provision (?:has |have )?(?:terminated|expired)|(?:have|has) expired", re.I)

# Provisions the schedule still prints but that ended by their own terms, which
# the compiler's notes have not yet recorded. Each entry is an editorial fact
# with its source, and must be re-checked whenever the schedule is refreshed.
#   9903.03.01-.11: the Section 122 surcharge (U.S. note 2(aa)), imposed by
#   Proclamation 11012 for 150 days from 2026-02-24, ended 2026-07-24 and was
#   replaced by the duties of U.S. note 52.
KNOWN_EXPIRED: tuple[tuple[str, str, date, str], ...] = (
    ("9903.03.01", "9903.03.11", date(2026, 7, 24),
     "Section 122 surcharge (U.S. note 2(aa)) expired 2026-07-24"),
)

# Section 232 regimes whose scope is a product list in the notes; a code in any
# of them (or in a base metal chapter) is a code note 52's exception (f) may
# take out of the country-wide duty, so the quote stays flagged.
_METAL_CHAPTERS = ("72", "73", "74", "76")
_FAMILY_232_PREFIXES = ("9903.74", "9903.76", "9903.78", "9903.79", "9903.81",
                        "9903.82", "9903.85", "9903.94")
_FAMILY_232_NOTES = (16, 31, 33, 37, 38, 39, 40)

_HTS_DOTTED = re.compile(r"\b(\d{4}(?:\.\d{2}){1,3})\b")
_HEADING_LIST = re.compile(
    r"\b(?:sub)?headings?\s+(\d{4}(?:\.\d{2}){0,3}"
    r"(?:(?:,|\s+and|\s+or|\s+through|\s*[-–])\s*\d{4}(?:\.\d{2}){0,3})*)", re.I)
_NOTE_REF = re.compile(r"(general |Additional )?(?:U\.S\. )?[Nn]ote (\d+)")
_EXPIRY_NOTE = re.compile(r"[Cc]ompiler.s note:[^\]]{0,300}?(?:expired|terminated)", re.S)
_HEADING_RANGE = re.compile(
    r"(9903\.\d{2}\.\d{2})(?:\s*(?:through|to|[-–])\s*(9903\.\d{2}\.\d{2}))?")


def _digits(code: str) -> str:
    return code.replace(".", "")


@dataclass
class Domain:
    """A set of HTS digit prefixes. Empty means "not known", never "nothing"."""
    prefixes: frozenset[str] = frozenset()

    def __post_init__(self) -> None:
        # Prefixes come in a handful of lengths (2, 4, 6, 8, 10 digits), so a
        # code is checked with five set lookups rather than a scan of thousands.
        self._by_len: dict[int, frozenset[str]] = {}
        for p in self.prefixes:
            self._by_len.setdefault(len(p), set()).add(p)        # type: ignore[arg-type]
        self._by_len = {n: frozenset(v) for n, v in self._by_len.items()}

    def covers(self, digits: str) -> bool:
        return any(digits[:n] in members for n, members in self._by_len.items())

    def __bool__(self) -> bool:
        return bool(self.prefixes)


def note_blocks(raw: str, wanted: tuple[int, ...]) -> dict[int, str]:
    """Text of the subchapter III U.S. notes named in `wanted`.

    Note numbers are not reliable markers on their own: numbering restarts in
    other subchapters, and the PDF renders a note's number several ways. The
    starts that form the longest ascending run of numbers are the real ones.
    """
    cands = []
    for m in re.finditer(r"\n[ \t]{0,8}(\d{1,2})\.[ \t]*", raw):
        tail = raw[m.end():m.end() + 90]
        if re.match(r"\s*\(a\)", tail) or re.match(r"[^\n]{0,60}\n\s*\n?\s*\(a\)", tail):
            cands.append((m.start(), int(m.group(1))))
    best_len = [1] * len(cands)
    prev = [-1] * len(cands)
    for i in range(len(cands)):
        for j in range(i):
            if cands[j][1] < cands[i][1] and best_len[j] + 1 > best_len[i]:
                best_len[i], prev[i] = best_len[j] + 1, j
    if not cands:
        return {}
    k = max(range(len(cands)), key=lambda i: best_len[i])
    chain = []
    while k != -1:
        chain.append(cands[k])
        k = prev[k]
    chain.reverse()
    out: dict[int, str] = {}
    for idx, (pos, n) in enumerate(chain):
        if n in wanted:
            end = chain[idx + 1][0] if idx + 1 < len(chain) else pos + 400_000
            out[n] = raw[pos:end]
    return out


def _codes_in(text: str) -> set[str]:
    """HTS prefixes a note names, at heading, subheading or line level.

    Broader is safe here: this only decides whether a code is *outside* a
    regime, so an extra prefix can only add a flag, never remove one.
    """
    out = {_digits(c) for c in _HTS_DOTTED.findall(text)}
    for m in _HEADING_LIST.finditer(text):
        out.update(_digits(c) for c in re.findall(r"\d{4}(?:\.\d{2}){0,3}", m.group(1)))
    return {c for c in out if not c.startswith(("98", "99"))}


def note_refs(description: str) -> list[int]:
    """Subchapter note numbers a rule cites. General notes and the additional
    notes of other chapters are different documents and are not returned."""
    refs = []
    for m in _NOTE_REF.finditer(description or ""):
        if m.group(1):
            continue
        if re.match(r"\s*(?:\([a-z]+\))*\s*to (?:chapter|the tariff)", (description or "")[m.end():m.end() + 40]):
            continue
        refs.append(int(m.group(2)))
    return refs


def _expired_ranges(blocks: dict[int, str]) -> list[tuple[str, str, int]]:
    """Heading ranges a note's own compiler's note records as expired."""
    out = []
    for n, text in blocks.items():
        para = text[:3500]
        if not _EXPIRY_NOTE.search(para):
            continue
        for m in _HEADING_RANGE.finditer(para):
            lo, hi = m.group(1), m.group(2) or m.group(1)
            out.append((lo, hi, n))
    return out


@dataclass
class RegimeIndex:
    """Everything the engine needs to give a verdict on an unscoped rule."""
    exception_scopes: dict[str, set[str]] = field(default_factory=dict)  # heading -> 8-digit prefixes
    exception_kind: dict[str, str] = field(default_factory=dict)
    exception_countries: dict[str, list[str]] = field(default_factory=dict)
    domain_232: Domain = field(default_factory=Domain)
    note_domain: dict[int, Domain] = field(default_factory=dict)
    expired: dict[str, str] = field(default_factory=dict)    # heading -> reason
    as_of: date = field(default_factory=date.today)

    def __post_init__(self) -> None:
        self._exception_domains: dict[str, Domain] = {}

    def finish(self) -> "RegimeIndex":
        """Build the lookup structures once the index is fully populated."""
        self._exception_domains = {h: Domain(frozenset(c))
                                   for h, c in self.exception_scopes.items()}
        return self

    # ------------------------------------------------------------- expiry
    def is_expired(self, rule: Ch99Rule) -> str | None:
        reason = self.expired.get(rule.hts)
        return reason

    # ---------------------------------------------------------- verdicts
    def verdict(self, rule: Ch99Rule, digits: str, origin_of) -> tuple[str, str | None]:
        """(verdict, assumption) for a rule whose scope is not a code list."""
        if _in_range(rule.hts, *NOTE52_RULES):
            return self._note52(rule, digits, origin_of)
        return self._product_specific(rule, digits)

    def _note52(self, rule: Ch99Rule, digits: str, origin_of) -> tuple[str, str | None]:
        # Only the plain additive duty is resolved. The deal-specific "replace"
        # lines (EU, Japan, Korea, Switzerland, Taiwan) turn on the entry's
        # own column 1 rate and stay unknown.
        if rule.effect is not Effect.ADD or not rule.rate_pct:
            return UNKNOWN, None
        origin = origin_of(rule.countries[0]) if rule.countries else None
        if origin is None:
            return UNKNOWN, None
        entry_bound = False
        for h, kind in self.exception_kind.items():
            if kind == "entry":
                entry_bound = True
            elif kind == "code":
                domain = self._exception_domains.get(h)
                if not domain:
                    return UNKNOWN, None           # list not extracted: fail closed
                if domain.covers(digits):
                    return SKIP, None
            elif kind == "code_use":
                domain = self._exception_domains.get(h)
                if not domain or domain.covers(digits):
                    return UNKNOWN, None           # exempt only for the stated end use
            elif kind == "family232":
                if self.domain_232.covers(digits) or not self.domain_232:
                    return UNKNOWN, None
            elif kind == "country":
                if any(origin_of(c) == origin for c in self.exception_countries.get(h, [])):
                    return UNKNOWN, None           # a deal-specific exception applies
            else:
                return UNKNOWN, None               # an exception we cannot classify
        text = (
            f"{rule.raw_rate.split('+')[-1].strip() or str(rule.rate_pct) + '%'} under "
            f"{rule.hts} (U.S. note 52) is applied to all products of this origin "
            "because the code is in none of the note's product exceptions."
        )
        if entry_bound:
            text += (" It assumes no entry-specific exemption applies: goods "
                     "in transit before the effective date, donations, "
                     "informational materials, or a Chapter 98 claim.")
        return APPLY, text

    def _product_specific(self, rule: Ch99Rule, digits: str) -> tuple[str, str | None]:
        if rule.effect not in (Effect.ADD, Effect.REPLACE) or not rule.rate_pct:
            return SKIP, None                       # an exemption: nothing to charge
        if re.search(r"transship", rule.description, re.I):
            return SKIP, None        # a penalty CBP determines after entry
        refs = note_refs(rule.description)
        # Out of scope only if EVERY note the rule cites has a product list to
        # check against; a cited note that is prose leaves the question open.
        if refs and all(n in self.note_domain for n in refs):
            covered = any(self.note_domain[n].covers(digits) for n in refs)
            return (UNKNOWN, None) if covered else (SKIP, None)
        return UNKNOWN, None                        # no evidence it is out of scope


def _in_range(heading: str, lo: str, hi: str) -> bool:
    return lo <= heading <= hi


def build_index(rules: list[Ch99Rule], scopes: dict, raw_notes: str,
                exception_scopes: dict[str, set[str]],
                as_of: date | None = None) -> RegimeIndex:
    """Assemble the index from the parsed rules and the notes text."""
    idx = RegimeIndex(as_of=as_of or date.today())
    by = {r.hts: r for r in rules}

    for h, r in by.items():
        if _in_range(h, *NOTE52_EXCEPTIONS):
            blob = r.description or ""
            if r.countries:
                idx.exception_kind[h] = "country"
                idx.exception_countries[h] = list(r.countries)
            elif _ENTRY_EXCEPTION.search(blob):
                idx.exception_kind[h] = "entry"
            elif _FAMILY_232.search(blob):
                idx.exception_kind[h] = "family232"
            elif h in exception_scopes and _USE_EXCEPTION.search(blob):
                idx.exception_kind[h] = "code_use"
            elif h in exception_scopes:
                idx.exception_kind[h] = "code"
            else:
                idx.exception_kind[h] = "unclassified"
            idx.exception_scopes[h] = {c for c in exception_scopes.get(h, set())}

    blocks = note_blocks(raw_notes, _FAMILY_232_NOTES + tuple(range(1, 60)))
    for n, text in blocks.items():
        codes = _codes_in(text)
        if codes:
            idx.note_domain[n] = Domain(frozenset(codes))

    fam: set[str] = set(_METAL_CHAPTERS)
    for n in _FAMILY_232_NOTES:
        if n in idx.note_domain:
            fam |= idx.note_domain[n].prefixes
    for r in rules:
        if r.hts.startswith(_FAMILY_232_PREFIXES):
            fam |= {_digits(b) for b in r.base_refs}
    for h, sc in scopes.items():
        if h.startswith(_FAMILY_232_PREFIXES):
            fam |= {_digits(c) for c in sc.codes}
    idx.domain_232 = Domain(frozenset(fam))

    for r in rules:
        blob = r.description or ""
        if _TERMINATED.search(blob) or _TERMINATED.search(r.suspension_note or ""):
            idx.expired[r.hts] = "the schedule records this provision as terminated or expired"
    for lo, hi, n in _expired_ranges(blocks):
        for h in by:
            if _in_range(h, lo, hi):
                idx.expired.setdefault(
                    h, f"U.S. note {n} records these provisions as expired or terminated")
    for lo, hi, when, why in KNOWN_EXPIRED:
        if idx.as_of > when:
            for h in by:
                if _in_range(h, lo, hi):
                    idx.expired[h] = why
    return idx.finish()
