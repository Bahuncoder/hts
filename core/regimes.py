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
from decimal import Decimal

from core.ch99 import Ch99Rule, Effect
from core.countries import country_code
from core.metals import LOW as METALS_LOW, HIGH as METALS_HIGH, MetalsIndex, extract_lists
from core.s232 import (Section232, VehicleIndex, WoodIndex, between, normalize_vehicle_use,  # noqa: F401
                       table_codes)
from ingest.notes import Note52Exception

APPLY, SKIP, UNKNOWN = "apply", "skip", "unknown"

# Headings 9903.05.20-.84 impose the country-wide duties of U.S. note 52; note
# 52(a) lists every exception to them as headings 9903.05.85-9903.06.21.
NOTE52_RULES = ("9903.05.20", "9903.05.84")
NOTE52_EXCEPTIONS = ("9903.05.85", "9903.06.21")

# Headings 9903.01 and 9903.02 impose the IEEPA tariffs the Supreme Court held
# void on 2026-02-20 (fentanyl-related duties and reciprocal tariffs). Their
# product scope is "everything except Annex II", so an unlisted product is
# charged, not skipped; only a stated scope can settle it.
IEEPA_PREFIXES = ("9903.01", "9903.02")

# Preference programs (Column 1 Special indicators) that stand for an agreement
# an exception can require the entry to claim.
_CLAIM_PROGRAMS = {"USMCA": frozenset({"S", "S+"}), "CAFTA-DR": frozenset({"P", "P+"})}


END_USES = {"civil_aircraft": "civil aircraft (general note 6)",
            "pharmaceutical": "pharmaceutical applications"}


def normalize_end_use(text: str | None) -> str | None:
    """'civil aircraft' / 'aircraft' / 'pharma' -> a key of END_USES; None for
    blank. Anything else is refused: an unrecognised use must not be read as
    'none claimed', which would quietly raise the duty."""
    t = re.sub(r"[\s_-]+", " ", (text or "").strip().lower())
    if not t or t in ("none", "no", "n/a"):
        return None
    if "aircraft" in t:
        return "civil_aircraft"
    if "pharma" in t:
        return "pharmaceutical"
    raise ValueError(
        f"Unrecognised end use {text!r}. Use 'civil aircraft' or 'pharmaceutical', or leave it blank.")


# General note 3(b): the origins that are not offered normal trade relations.
COLUMN_2_COUNTRIES = frozenset({"CU", "KP", "RU", "BY"})


@dataclass(frozen=True)
class EntryFacts:
    """What the importer states about the entry. A claim (a preference program,
    an end use a note-52 exception is conditional on) is the importer's own
    assertion; a fact about the goods (their metal weight) is theirs to supply.
    Neither is ever inferred from the code."""
    program: str | None = None
    free: bool = False        # the preference rate applied is duty-free
    end_use: str | None = None
    metal_weight_pct: Decimal | None = None
    vehicle_use: str | None = None      # passenger | heavy | none


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
_S232_RULE_RANGES = (("9903.82.01", "9903.82.26"), ("9903.94.01", "9903.94.69"),
                     ("9903.74.01", "9903.74.11"), ("9903.76.01", "9903.76.24"))
_FAMILY_232_NOTES = (16, 33, 37, 38, 39, 40)
_OTHER_232_NOTES = (33, 37, 38, 39, 40)
_OTHER_232_PREFIXES = ("9903.74", "9903.76", "9903.78", "9903.79", "9903.94")

_PROVIDED_FOR = re.compile(r"provided\s+for\s+in\s+([^;)]*)", re.I)
_NARROWING = re.compile(r"\b(?:except|other than|not|excluding)\b", re.I)
_CHAPTER_LIST = re.compile(r"\bchapters?\s+(\d{1,2}(?:(?:,|\s+and|\s+or)\s*\d{1,2})*)", re.I)

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


def described_scope(description: str) -> frozenset[str] | None:
    """The goods a provision names for itself ("provided for in heading 4104 or
    4107", "provided for in chapter 64"), as HTS digit prefixes.

    Only a plain statement of scope is read: if anything that narrows or negates
    ("except", "other than", "not") precedes the first such phrase, the phrase
    may name what is left out rather than what is covered, and None is returned.
    """
    m = _PROVIDED_FOR.search(description or "")
    if not m or _NARROWING.search((description or "")[:m.start()]):
        return None
    prefixes: set[str] = set()
    for pm in _PROVIDED_FOR.finditer(description):
        span = pm.group(1)
        prefixes |= {_digits(c) for c in re.findall(r"\b\d{4}(?:\.\d{2}){0,3}\b", span)}
        for cm in _CHAPTER_LIST.finditer("chapter " + span if span.strip()[:1].isdigit() else span):
            prefixes |= {n.zfill(2) for n in re.findall(r"\d{1,2}", cm.group(1))}
    prefixes = {p for p in prefixes if not p.startswith(("98", "99"))}
    return frozenset(prefixes) or None


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


_SUSPENDED = re.compile(r"[Tt]he following provisions have been suspended[^\n]*(?:\n(?![ \t]*\n)[^\n]*)*")
_CEASES = re.compile(
    r"[Nn]o rate of duty provided for in [^.\n]*?(?:\n[^.\n]*)?in chapter 99 shall be imposed[^.]*?"
    r"after the close of\s+([A-Z][a-z]+ \d{1,2}, \d{4})", re.S)


def _suspended_ranges(raw: str) -> list[tuple[str, str]]:
    """Heading ranges a note lists as "suspended pursuant to executive action"."""
    out = []
    for m in _SUSPENDED.finditer(raw):
        for r in _HEADING_RANGE.finditer(m.group(0)):
            out.append((r.group(1), r.group(2) or r.group(1)))
    return out


def _ceased_headings(blocks: dict[int, str]) -> list[tuple[list[str], date]]:
    """Headings a note says no longer carry a duty after a stated date ("No rate of
    duty provided for in such subheadings ... shall be imposed ... after the close
    of September 25, 2012"), taken from the headings the note opens with."""
    from core.ch99 import _parse_date
    out = []
    for text in blocks.values():
        m = _CEASES.search(text)
        d = _parse_date(m.group(1)) if m else None
        if d:
            out.append((re.findall(r"9903\.\d{2}\.\d{2}", text[:600]), d))
    return out


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
    exceptions: dict[str, Note52Exception] = field(default_factory=dict)
    exception_kind: dict[str, str] = field(default_factory=dict)
    exception_use: dict[str, str] = field(default_factory=dict)      # code_use -> END_USES key
    domain_232: Domain = field(default_factory=Domain)
    other_232: Domain = field(default_factory=Domain)          # every 232 regime but the metals
    s232: Section232 | None = None
    note_domain: dict[int, Domain] = field(default_factory=dict)
    desc_domain: dict[str, Domain] = field(default_factory=dict)   # heading -> goods it names
    expired: dict[str, str] = field(default_factory=dict)    # heading -> reason
    as_of: date = field(default_factory=date.today)

    def __post_init__(self) -> None:
        self._exception_domains: dict[str, Domain] = {}

    def finish(self) -> "RegimeIndex":
        """Build the lookup structures once the index is fully populated."""
        self._exception_domains = {h: Domain(e.codes)
                                   for h, e in self.exceptions.items()}
        return self

    # ------------------------------------------------------------- expiry
    def is_expired(self, rule: Ch99Rule) -> str | None:
        reason = self.expired.get(rule.hts)
        if reason:
            return reason
        if rule.effective_to and self.as_of >= rule.effective_to:
            return f"the provision's own text limits it to entries before {rule.effective_to}"
        return None

    def not_yet(self, rule: Ch99Rule) -> bool:
        """A provision whose own text starts it on a later date than the quote's."""
        return bool(rule.effective_from and self.as_of < rule.effective_from)

    # ---------------------------------------------------------- verdicts
    def verdict(self, rule: Ch99Rule, digits: str, origin: str = "",
                facts: EntryFacts | None = None) -> tuple[str, str | None]:
        """(verdict, assumption) for a rule whose scope is not a code list."""
        facts = facts or EntryFacts()
        if _in_range(rule.hts, *NOTE52_RULES):
            return self._note52(rule, digits, origin, facts)
        if self.decides(rule):
            return self._s232_rule(rule, digits, origin, facts)
        return self._product_specific(rule, digits)

    def needs(self, digits: str, origin: str, facts: EntryFacts) -> list[str]:
        """Facts the importer could state that would settle a Section 232 unknown."""
        if not self.s232:
            return []
        return sorted(self.s232.resolve(digits, origin, facts).needs)

    def decides(self, rule: Ch99Rule) -> bool:
        """Whether the Section 232 resolver, not a generic scope lookup, decides
        this heading (its scope depends on facts about the entry)."""
        return bool(self.s232) and any(
            _in_range(rule.hts, lo, hi) for lo, hi in _S232_RULE_RANGES)

    def _s232_rule(self, rule: Ch99Rule, digits: str, origin: str,
                   facts: EntryFacts) -> tuple[str, str | None]:
        out = self.s232.resolve(digits, origin, facts)
        if out.charges(rule.hts):
            return APPLY, " ".join(out.assumptions)
        if out.flags(rule.hts):
            return UNKNOWN, None
        return SKIP, (" ".join(out.assumptions) if out.status == "not_subject" and out.assumptions
                      else None)

    def s232_status(self, digits: str, origin: str, facts: EntryFacts) -> str:
        """Whether Section 232 takes these goods out of the note-52 duty:
        'subject' (they are charged under a 232 heading), 'not_subject', or
        'unknown'."""
        if not self.domain_232:
            return "unknown"                       # nothing extracted: fail closed
        if not self.s232:
            return "unknown" if self.domain_232.covers(digits) else "not_subject"
        return self.s232.resolve(digits, origin, facts).status

    def _note52(self, rule: Ch99Rule, digits: str, origin: str,
                facts: EntryFacts) -> tuple[str, str | None]:
        # Two shapes are resolved: the plain additive duty, and the deal headings
        # that turn on the entry's own column 1 rate (the caller applies the
        # threshold once the base duty is known). Anything else stays unknown.
        deal = rule.threshold_pct is not None
        if not deal and not (rule.effect is Effect.ADD and rule.rate_pct):
            return UNKNOWN, None
        skipped: list[str] = []
        unknown = False
        entry_bound = False
        unclaimed: list[str] = []
        for h, kind in self.exception_kind.items():
            ex = self.exceptions.get(h)
            if ex is not None and not ex.applies_to(rule.hts):
                continue
            domain = self._exception_domains.get(h)
            if kind == "entry":
                entry_bound = True
            elif kind == "code":
                if not domain:
                    unknown = True                 # list not extracted: fail closed
                elif domain.covers(digits):
                    return SKIP, None
            elif kind == "code_use":
                use = self.exception_use.get(h)
                if not domain or use is None:
                    unknown = True
                elif domain.covers(digits):
                    if facts.end_use == use:
                        skipped.append(
                            f"{rule.hts} does not apply because the goods are claimed for "
                            f"{END_USES[use]} (exception {h}); the code is on that "
                            "exception's list and the end use is assumed to be met.")
                    else:
                        unclaimed.append(
                            f"no {END_USES[use]} end use is claimed, so exception {h} "
                            "does not apply")
            elif kind == "family232":
                status = self.s232_status(digits, origin, facts)
                if status == "subject":
                    skipped.append(
                        f"{rule.hts} does not apply because these goods are charged under "
                        f"Section 232 instead (exception {h}, U.S. note 52(f)).")
                elif status == "unknown":
                    unknown = True
            elif kind == "claim":
                programs = _CLAIM_PROGRAMS.get(ex.claim, frozenset())
                if domain and not domain.covers(digits):
                    continue                       # this list does not name the code
                if facts.program in programs:
                    if ex.claim == "USMCA":
                        if facts.free:
                            skipped.append(
                                f"{rule.hts} does not apply because the entry is claimed "
                                f"free of duty under USMCA (exception {h}); the goods are "
                                "assumed to qualify.")
                        else:
                            unclaimed.append(
                                f"USMCA was claimed but the rate is not duty-free, so "
                                f"exception {h} does not apply")
                    elif domain:
                        skipped.append(
                            f"{rule.hts} does not apply because {ex.claim} treatment is "
                            f"claimed for this code (exception {h}); the goods are assumed "
                            "to qualify.")
                    else:
                        unknown = True             # a textile/apparel test we cannot run
                else:
                    unclaimed.append(f"no {ex.claim} claim is made, so exception {h} "
                                     "does not apply")
            else:
                unknown = True                     # an exception we cannot classify
        if skipped:
            return SKIP, skipped[0]
        if unknown:
            return UNKNOWN, None
        if deal:
            text = ""
        else:
            text = (
                f"{rule.raw_rate.split('+')[-1].strip() or str(rule.rate_pct) + '%'} under "
                f"{rule.hts} (U.S. note 52) is applied to all products of this origin "
                "because the code is in none of the note's product exceptions."
            )
        if unclaimed:
            text += " " + "; ".join(u[0].upper() + u[1:] for u in unclaimed) + "."
        if entry_bound:
            text += (" It assumes" if not deal else " The note 52 duty assumes")
            text += (" no entry-specific exemption applies: goods "
                     "in transit before the effective date, donations, "
                     "informational materials, or a Chapter 98 claim.")
        text = text.strip()
        if deal and not text:
            return APPLY, None
        return APPLY, text

    def _product_specific(self, rule: Ch99Rule, digits: str) -> tuple[str, str | None]:
        if rule.effect not in (Effect.ADD, Effect.REPLACE) or not rule.rate_pct:
            return SKIP, None                       # an exemption: nothing to charge
        if re.search(r"transship", rule.description, re.I):
            return SKIP, None        # a penalty CBP determines after entry
        if rule.hts.startswith(IEEPA_PREFIXES):
            return UNKNOWN, None     # scope is everything but Annex II: not derivable
        refs = note_refs(rule.description)
        # Out of scope only if EVERY note the rule cites has a product list to
        # check against; a cited note that is prose leaves the question open.
        if refs and all(n in self.note_domain for n in refs):
            covered = any(self.note_domain[n].covers(digits) for n in refs)
            return (UNKNOWN, None) if covered else (SKIP, None)
        named = self.desc_domain.get(rule.hts)
        if named is not None and not refs:
            return (UNKNOWN, None) if named.covers(digits) else (SKIP, None)
        return UNKNOWN, None                        # no evidence it is out of scope


def _in_range(heading: str, lo: str, hi: str) -> bool:
    return lo <= heading <= hi


def _build_s232(rules: list[Ch99Rule], blocks: dict[int, str], idx: RegimeIndex,
                scopes: dict) -> Section232 | None:
    """Read the product lists of notes 16, 33, 37 and 38. A regime whose lists
    cannot all be found is left out, so its codes fall back to 'unknown'."""
    dom = Domain

    metals = None
    lists = extract_lists(blocks.get(16, ""))
    if lists and all(lists.get(k) for k in ("i", "iii", "iv", "vii", "x")):
        deal = frozenset(filter(None, (country_code(c) for r in rules
                                       if r.hts == "9903.82.22" for c in r.countries)))
        metals = MetalsIndex({k: dom(v) for k, v in lists.items()}, COLUMN_2_COUNTRIES, deal)

    def deals(lo: str, hi: str) -> dict[str, frozenset[str]]:
        out: dict[str, set[str]] = {}
        for r in rules:
            if _in_range(r.hts, lo, hi):
                for c in r.countries:
                    iso = country_code(c)
                    if iso:
                        out.setdefault(iso, set()).add(r.hts)
        return {k: frozenset(v) for k, v in out.items()}

    vehicles = None
    n33, n38 = blocks.get(33, ""), blocks.get(38, "")
    pv = table_codes(between(n33, r"\n\s*\(g\)\s+Subject to a manufacturer",
                            r"\n\s*\(h\)\s+Heading 9903\.94\.06"))
    heavy = table_codes(between(n38, r"\n\s*\(i\)\s+Subject to a manufacturer", r"\n\s*\(j\)\s"))
    whole = (table_codes(between(n33, r"\n\s*\(b\)\s+The rates of duty set forth in headings 9903\.94\.01",
                                 r"\n\s*\(c\)\s+Heading 9903\.94\.02"))
             | table_codes(between(n38, r"\n\s*\(b\)\s+The rate of duty set forth in heading 9903\.74\.01",
                                   r"\n\s*\(c\)\s+Heading 9903\.74\.02"))
             | table_codes(between(n38, r"\n\s*\(c\)\s+Heading 9903\.74\.02",
                                   r"\n\s*\(d\)\s+Heading 9903\.74\.03")))
    if pv and heavy and whole:
        by_origin = deals("9903.94.31", "9903.94.69")
        pairs: dict[str, tuple[str, str]] = {}
        parts_rules = [r for r in rules
                       if _in_range(r.hts, "9903.94.31", "9903.94.69") and r.threshold_pct is not None
                       and (r.description or "").startswith("Parts of passenger vehicles and light trucks")
                       and not re.search(r"subdivisions? \(r\)", r.description or "")]
        for iso in by_origin:
            mine = sorted((r for r in parts_rules if any(country_code(c) == iso for c in r.countries)),
                          key=lambda r: r.hts)
            hi = [r.hts for r in mine if r.threshold_above is True]
            lo = [r.hts for r in mine if r.threshold_above is False]
            if len(hi) == 1 and len(lo) == 1:
                pairs[iso] = (hi[0], lo[0])
        vehicles = VehicleIndex(dom(pv), dom(heavy), dom(whole), by_origin, pairs)

    wood = None
    n37 = blocks.get(37, "")
    soft = table_codes(between(n37, r"\n\s*\(b\)\s+The rates of duty set forth in heading 9903\.76\.01",
                               r"\n\s*\(c\)\s+Heading"))
    uph = table_codes(between(n37, r"\n\s*\(d\)\s+The rates of duty set forth in headings 9903\.76\.02",
                              r"\n\s*\(e\)\s+Except"))
    cab = table_codes(between(n37, r"\n\s*\(f\)\s+Except for as provided by heading 9903\.76\.04, the rates",
                              r"\n\s*\(g\)\s+Heading"))
    if soft and uph and cab:
        own = {iso: sorted(h)[0] for iso, h in deals("9903.76.20", "9903.76.24").items() if len(h) == 1}
        wood = WoodIndex(dom(soft), dom(uph), dom(cab), own)

    if not (metals or vehicles or wood):
        return None
    unresolved: set[str] = set()
    for n in (39, 40):
        if n in idx.note_domain:
            unresolved |= idx.note_domain[n].prefixes
    for h, sc in scopes.items():
        if h.startswith(("9903.78", "9903.79")):
            unresolved |= {_digits(c) for c in sc.codes}
    return Section232(metals, vehicles, wood, dom(frozenset(unresolved)))


def build_index(rules: list[Ch99Rule], scopes: dict, raw_notes: str,
                exceptions: dict[str, Note52Exception],
                as_of: date | None = None, shaded: set[str] | frozenset[str] = frozenset()) -> RegimeIndex:
    """Assemble the index from the parsed rules and the notes text."""
    idx = RegimeIndex(as_of=as_of or date.today())
    by = {r.hts: r for r in rules}

    for h, r in by.items():
        if not _in_range(h, *NOTE52_EXCEPTIONS):
            continue
        blob = r.description or ""
        ex = exceptions.get(h)
        head = ex.head if ex else blob
        if ex is not None:
            idx.exceptions[h] = ex
        if ex is not None and ex.claim:
            idx.exception_kind[h] = "claim"
        elif _ENTRY_EXCEPTION.search(blob):
            idx.exception_kind[h] = "entry"
        elif _FAMILY_232.search(blob) or _FAMILY_232.search(head):
            idx.exception_kind[h] = "family232"
        elif ex is not None and ex.codes and _USE_EXCEPTION.search(head):
            idx.exception_kind[h] = "code_use"
            idx.exception_use[h] = ("civil_aircraft" if re.search("civil aircraft", head, re.I)
                                    else "pharmaceutical")
        elif ex is not None and ex.codes:
            idx.exception_kind[h] = "code"
        else:
            idx.exception_kind[h] = "unclassified"

    for r in rules:
        named = described_scope(r.description)
        if named:
            idx.desc_domain[r.hts] = Domain(named)

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

    others: set[str] = set()
    for n in _OTHER_232_NOTES:
        if n in idx.note_domain:
            others |= idx.note_domain[n].prefixes
    for h, sc in scopes.items():
        if h.startswith(_OTHER_232_PREFIXES):
            others |= {_digits(c) for c in sc.codes}
    idx.other_232 = Domain(frozenset(others))

    idx.s232 = _build_s232(rules, blocks, idx, scopes)

    for r in rules:
        blob = r.description or ""
        if _TERMINATED.search(blob) or _TERMINATED.search(r.suspension_note or ""):
            idx.expired[r.hts] = "the schedule records this provision as terminated or expired"
    for lo, hi, n in _expired_ranges(blocks):
        for h in by:
            if _in_range(h, lo, hi):
                idx.expired.setdefault(
                    h, f"U.S. note {n} records these provisions as expired or terminated")
    for h in shaded:
        if h in by:
            idx.expired[h] = "the published schedule shades this provision as expired"
    for lo, hi in _suspended_ranges(raw_notes):
        for h in by:
            if _in_range(h, lo, hi):
                idx.expired.setdefault(
                    h, "the schedule's notes record this provision as suspended pursuant to executive action")
    for heads, when in _ceased_headings(blocks):
        if idx.as_of > when:
            for h in heads:
                if h in by:
                    idx.expired.setdefault(
                        h, f"its U.S. note bars any duty under it after {when.isoformat()}")
    for lo, hi, when, why in KNOWN_EXPIRED:
        if idx.as_of > when:
            for h in by:
                if _in_range(h, lo, hi):
                    idx.expired[h] = why
    return idx.finish()
