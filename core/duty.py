"""Duty stack resolver.

Computes the true landed duty for (HTS code, country of origin, value).

The stack, in order:
    1. base rate      - Column 1 General (MFN), Column 1 Special (FTA), or Column 2
    2. Ch.99 overlays - Section 232 / 301 / country actions, additive or replacing
    3. user fees      - MPF (ad valorem, floored and capped) and HMF (vessel only)

Fee figures are FY2026, effective 2025-10-01, per 19 CFR 24.22 / 24.24
(published at 90 FR 35257, CBP Dec. 25-10). They are inflation-adjusted each
fiscal year, so they are declared here as dated constants rather than inlined.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from functools import lru_cache

from core.ch99 import Ch99Rule, Effect
from core.countries import country_code, require_country
from core.regimes import IEEPA_PREFIXES, Claim
from core.units import parse_specific, unit_of

# --- FY2026 user fees (effective 2025-10-01) ---------------------------------
MPF_RATE = Decimal("0.003464")
MPF_MIN = Decimal("33.58")
MPF_MAX = Decimal("651.50")
HMF_RATE = Decimal("0.00125")

# 19 CFR 24.22(k) requires CBP to re-adjust MPF's floor/cap for inflation each
# fiscal year; HMF and the MPF rate are set by statute and don't move on the
# same clock, but all three get re-verified together every October. Past this
# date the constants above are unconfirmed for the new fiscal year — compute()
# surfaces that as a warning rather than silently serving stale figures.
FEE_CONSTANTS_EFFECTIVE_THROUGH = date(2026, 9, 30)


def fee_constants_stale(today: date | None = None) -> bool:
    return (today or date.today()) > FEE_CONSTANTS_EFFECTIVE_THROUGH

# Column 2 ("other") applies to a small set of non-normal-trade-relations
# countries, held as ISO codes so every spelling of an origin reaches it.
COLUMN_2_COUNTRIES = frozenset({"CU", "KP", "RU", "BY"})

# Subchapters I and II of chapter 99 carry the tariffs imposed under IEEPA. The
# Supreme Court held on 2026-02-20 that IEEPA confers no such authority, so
# these provisions are printed in the schedule but legally void. Duty paid
# under them is potentially refundable, so they are reported separately rather
# than folded into the amount currently owed.
IEEPA_PREFIX = IEEPA_PREFIXES
IEEPA_STRUCK_DOWN = "2026-02-20"

# Preference programs whose eligibility is a fixed set of origins (General
# Note 3(c)(i)). A program absent from this table is one whose beneficiary
# list is long or changes (GSP, AGOA, CBERA...): it is applied only when the
# caller names it, and the result says eligibility was not checked.
_PROGRAM_ORIGINS: dict[str, frozenset[str]] = {
    **{c: frozenset({c}) for c in
       ("AU", "BH", "CA", "CL", "CO", "IL", "JO", "JP", "KR", "MA", "MX",
        "OM", "PA", "PE", "SG")},
    "S": frozenset({"CA", "MX"}), "S+": frozenset({"CA", "MX"}),
    "P": frozenset({"CR", "DO", "SV", "GT", "HN", "NI"}),
    "P+": frozenset({"CR", "DO", "SV", "GT", "HN", "NI"}),
}


@dataclass
class DutyComponent:
    label: str
    rate_pct: Decimal | None
    amount: Decimal
    basis: str
    authority: str = ""

    def as_dict(self) -> dict:
        return {
            "label": self.label,
            "rate_pct": float(self.rate_pct) if self.rate_pct is not None else None,
            "amount": float(self.amount),
            "basis": self.basis,
            "authority": self.authority,
        }


@dataclass
class DutyResult:
    hts: str
    country: str
    entered_value: Decimal
    components: list[DutyComponent] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    scope_unverified: list[str] = field(default_factory=list)
    refundable: list[DutyComponent] = field(default_factory=list)
    # Reasons the total omits something it should include. Empty means the
    # figure is complete for the inputs given; it is never inferred from the
    # absence of warnings, which are prose.
    incomplete: list[str] = field(default_factory=list)
    # Facts a duty rests on that the caller did not state and the engine cannot
    # check (for example "no entry-specific exemption applies").
    assumptions: list[str] = field(default_factory=list)
    # Struck-down (IEEPA) headings whose scope is unresolved: they cannot make
    # the amount owed wrong, only the refund estimate incomplete.
    refund_unverified: list[str] = field(default_factory=list)
    country_code: str = ""
    dataset_revision: str = ""
    # Units a quantity-based duty is charged in; asked of the caller when the
    # duty could not be priced without one.
    quantity_needed: list[str] = field(default_factory=list)

    @property
    def refundable_amount(self) -> Decimal:
        return sum((c.amount for c in self.refundable), Decimal("0"))

    @property
    def total_duty(self) -> Decimal:
        return sum((c.amount for c in self.components), Decimal("0"))

    @property
    def effective_rate_pct(self) -> Decimal:
        if self.entered_value <= 0:
            return Decimal("0")
        return (self.total_duty / self.entered_value * 100).quantize(Decimal("0.01"))

    @property
    def landed_cost(self) -> Decimal:
        return self.entered_value + self.total_duty

    def as_dict(self) -> dict:
        return {
            "hts": self.hts,
            "country": self.country,
            "entered_value": float(self.entered_value),
            "components": [c.as_dict() for c in self.components],
            "total_duty": float(self.total_duty),
            "effective_rate_pct": float(self.effective_rate_pct),
            "landed_cost": float(self.landed_cost),
            "refundable": [c.as_dict() for c in self.refundable],
            "refundable_amount": float(self.refundable_amount),
            "warnings": self.warnings,
            "scope_unverified": self.scope_unverified,
            "incomplete": self.incomplete,
            "assumptions": self.assumptions,
            "refund_unverified": self.refund_unverified,
            "complete": not self.incomplete and not self.scope_unverified,
            "country_code": self.country_code,
            "dataset_revision": self.dataset_revision,
            "quantity_needed": self.quantity_needed,
        }


@dataclass(frozen=True)
class ParsedRate:
    """A rate cell taken apart, so nothing in it can be dropped unnoticed."""
    pct: Decimal                       # ad valorem part; 0 when free
    specific: tuple[str, ...] = ()     # quantity-based parts (need a quantity)
    unparsed: bool = False             # some part was not understood
    raw: str = ""


@dataclass(frozen=True)
class SpecialAlt:
    rate: ParsedRate
    programs: tuple[str, ...]          # empty: applies to any claimed program


_PCT_PART = re.compile(r"^(\d+(?:\.\d+)?)(?:\s+(\d+)/(\d+))?\s*%$")
_SPECIFIC_PART = re.compile(r"(?:\$\s*\d|\d[\d.]*\s*(?:¢|cents?))", re.I)
_PLUS = re.compile(r"\s*\+\s*")
_SPECIAL_ALT = re.compile(r"\s*([^()]+?)\s*\(([^()]*)\)\s*")


def parse_rate(cell: str) -> ParsedRate:
    """Parse one rate expression: 'Free', '5%', '$1/kg + 5%', '2 1/2%'.

    Anything that is not plainly an ad valorem percentage is recorded, never
    discarded: a quantity-based component lands in `specific`, and text the
    grammar does not cover sets `unparsed`. The caller decides how to report
    it; this function does not guess.
    """
    s = (cell or "").strip()
    if not s or s.lower() == "free":
        return ParsedRate(Decimal("0"), raw=s)
    pct, specific, unparsed = Decimal("0"), [], False
    for part in _PLUS.split(s):
        m = _PCT_PART.match(part)
        if m:
            value = Decimal(m.group(1))
            if m.group(2):
                value += Decimal(m.group(2)) / Decimal(m.group(3))
            pct += value
        elif _SPECIFIC_PART.search(part):
            specific.append(part)
        else:
            unparsed = True
    return ParsedRate(pct, tuple(specific), unparsed, s)


def parse_special(cell: str) -> list[SpecialAlt] | None:
    """Parse a Column 1 Special cell into rate/program alternatives.

    'Free (A,AU,KR)' is one alternative; '4% (KR) 5% (MX)' is two. A cell with
    no parenthesised programs applies to whichever preference is claimed.
    Returns None when the cell does not follow this shape.
    """
    s = (cell or "").strip()
    if not s:
        return []
    if "(" not in s:
        return [SpecialAlt(parse_rate(s), ())]
    alts, pos = [], 0
    for m in _SPECIAL_ALT.finditer(s):
        if m.start() != pos:
            return None
        programs = tuple(p.strip() for p in m.group(2).split(",") if p.strip())
        alts.append(SpecialAlt(parse_rate(m.group(1)), programs))
        pos = m.end()
    return alts if pos == len(s) and alts else None


def parse_base_rate(cell: str) -> tuple[Decimal | None, str | None]:
    """Compatibility view of parse_rate: (ad_valorem_pct, unhandled_text)."""
    r = parse_rate(cell)
    if r.unparsed and not r.specific and r.pct == 0:
        return None, (cell or "").strip()
    unhandled = " + ".join(r.specific) or ((cell or "").strip() if r.unparsed else None)
    return r.pct, unhandled


def select_preference(
    special_cell: str, origin: str, program: str | None,
) -> tuple[ParsedRate | None, str | None, list[str]]:
    """Choose the Column 1 Special rate for a claimed preference.

    Returns (rate, program_used, notes). A None rate means the preference could
    not be applied and the caller must fall back to the general rate; the notes
    explain why. Nothing is selected on a bare boolean: the cell is matched to
    a named program, or to the one program that covers the origin.
    """
    alts = parse_special(special_cell)
    if alts is None:
        return None, None, [f"The special rate {special_cell!r} could not be "
                            "interpreted, so the general rate was used."]
    if not alts:
        return None, None, ["This line has no special (preference) rate; "
                            "the general rate was used."]

    if program:
        matches = [a for a in alts if not a.programs or program in a.programs]
        if not matches:
            return None, None, [f"Program {program} is not listed for this "
                                "line; the general rate was used."]
        eligible = _PROGRAM_ORIGINS.get(program)
        if eligible is not None and origin not in eligible:
            return None, None, [f"Program {program} does not cover this origin; "
                                "the general rate was used."]
        notes = []
        if eligible is None:
            notes.append(f"Eligibility of this origin under program {program} "
                         "was asserted, not checked.")
        return matches[0].rate, program, notes

    generic = [a for a in alts if not a.programs]
    if generic:
        return generic[0].rate, None, []
    hits = [(a, p) for a in alts for p in a.programs
            if origin in _PROGRAM_ORIGINS.get(p, ())]
    if not hits:
        return None, None, ["No preference program listed for this line covers "
                            "this origin; the general rate was used. Name a "
                            "program if one applies."]
    if len({(a.rate.pct, a.rate.specific) for a, _ in hits}) > 1:
        return None, None, ["More than one preference program could apply with "
                            "different rates; name the program. The general "
                            "rate was used."]
    return hits[0][0].rate, hits[0][1], []


@lru_cache(maxsize=None)
def _origin_key(name: str) -> str:
    """ISO code for a country name; the lowercased text if it has none, so an
    unrecognised name still compares literally rather than matching nothing."""
    return country_code(name) or name.strip().lower()


def applicable_ch99(
    rules: list[Ch99Rule], hts: str, country: str,
    scopes: dict | None = None,
) -> tuple[list[Ch99Rule], list[Ch99Rule]]:
    """Select Chapter 99 rules matching this code and origin.

    Returns (applied, unscoped).

    Most Chapter 99 remedy lines carry no machine-readable product scope: they
    delegate it to the Chapter 99 U.S. Notes, which are published as prose.
    Such a rule matches on country but its product coverage is unknown, so it
    is *never* applied silently — it is returned separately for verification.
    Applying them blindly is what produces four-figure effective duty rates.
    """
    c = _origin_key(country or "")
    digits = hts.replace(".", "")
    prefixes = {digits[:8], digits[:6], digits[:4]}

    applied: list[Ch99Rule] = []
    unscoped: list[Ch99Rule] = []

    for r in rules:
        if r.suspended:
            continue
        if r.countries and not any(_origin_key(x) == c for x in r.countries):
            continue
        if r.base_refs:
            # Containment is directional: a reference covers this code only when
            # the reference is a PREFIX of it. Sharing a heading is not coverage
            # (ref 8471.49.10 does not cover 8471.30.01.00, though both are 8471).
            if not any(digits.startswith(b.replace(".", "")) for b in r.base_refs):
                continue
            applied.append(r)
        elif scopes and r.hts in scopes:
            # Scope resolved from the Chapter 99 U.S. Notes.
            sc = scopes[r.hts]
            if sc.countries and not any(_origin_key(x) == c for x in sc.countries):
                continue
            if sc.covers(hts):
                applied.append(r)
        elif r.countries:
            # Country matches but product scope remains unresolved.
            unscoped.append(r)
        # Neither country nor product scope: not attributable to this entry.

    exempt_codes = {m.hts for m in applied if m.effect is Effect.PASSTHROUGH}
    applied = [
        m for m in applied
        if not (m.effect is Effect.ADD and set(m.excepts) & exempt_codes)
    ]
    return applied, unscoped


@dataclass
class Resolution:
    applied: list[Ch99Rule] = field(default_factory=list)
    unverified: list[Ch99Rule] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)


def resolve_ch99(
    rules: list[Ch99Rule], hts: str, country: str,
    scopes: dict | None = None, regimes=None, claim=None,
) -> Resolution:
    """Give every Chapter 99 rule an explicit verdict for this code and origin.

    With `regimes=None` this is exactly `applicable_ch99`. With a RegimeIndex the
    two cases that function could not decide are decided from the schedule's own
    text (see core/regimes.py): country-wide duties with enumerated exceptions,
    and lines with neither a country nor a scope, which were dropped silently.
    A rule the evidence cannot settle stays in `unverified`, so a quote is never
    quietly understated.
    """
    from core.regimes import APPLY, SKIP

    origin = _origin_key(country or "")
    digits = hts.replace(".", "")
    out = Resolution()

    for r in rules:
        if r.suspended:
            continue
        if regimes is not None and regimes.is_expired(r):
            continue
        if r.countries and not any(_origin_key(x) == origin for x in r.countries):
            continue
        if r.base_refs:
            if not any(digits.startswith(b.replace(".", "")) for b in r.base_refs):
                continue
            out.applied.append(r)
        elif scopes and r.hts in scopes:
            sc = scopes[r.hts]
            if sc.countries and not any(_origin_key(x) == origin for x in sc.countries):
                continue
            if sc.covers(hts):
                out.applied.append(r)
        elif regimes is None:
            if r.countries:
                out.unverified.append(r)
        else:
            verdict, note = regimes.verdict(r, digits, _origin_key, claim)
            if verdict == APPLY:
                out.applied.append(r)
                if note:
                    out.assumptions.append(note)
            elif verdict != SKIP:
                out.unverified.append(r)
            elif note:
                out.assumptions.append(note)
    out.assumptions = list(dict.fromkeys(out.assumptions))

    exempt_codes = {m.hts for m in out.applied if m.effect is Effect.PASSTHROUGH}
    out.applied = [
        m for m in out.applied
        if not (m.effect is Effect.ADD and set(m.excepts) & exempt_codes)
    ]
    return out


def _positive_value(entered_value: Decimal | float | str) -> Decimal:
    try:
        value = Decimal(str(entered_value))
    except Exception as exc:
        raise ValueError("entered value must be a number") from exc
    if not value.is_finite() or value <= 0:
        raise ValueError("entered value must be a positive amount")
    return value


def _pct(value: Decimal) -> str:
    return format(value.normalize(), "f")


def _positive_quantity(quantity: Decimal | float | str | None) -> Decimal | None:
    if quantity is None or (isinstance(quantity, str) and not quantity.strip()):
        return None
    try:
        q = Decimal(str(quantity))
    except Exception as exc:
        raise ValueError("quantity must be a number") from exc
    if not q.is_finite() or q <= 0:
        raise ValueError("quantity must be a positive amount")
    return q


def _price_specific(parts: tuple[str, ...], cell: str, quantity: Decimal | None,
                    quantity_unit: str | None, res: "DutyResult") -> Decimal | None:
    """Dollar amount of a rate's quantity-based parts, or None (with the reason
    recorded on `res`) when they cannot be priced exactly from what was given."""
    rates = [parse_specific(p) for p in parts]
    if any(r is None for r in rates):
        bad = [p for p, r in zip(parts, rates) if r is None]
        res.warnings.append(
            f"Base rate {cell!r} includes a duty this calculator cannot price "
            f"({'; '.join(bad)}). It is NOT included in this total, which is "
            "therefore understated.")
        res.incomplete.append("specific_duty_unsupported")
        return None
    dims = {r.unit.dimension for r in rates}
    res.quantity_needed = sorted({r.unit_text for r in rates})
    if len(dims) > 1:
        res.warnings.append(
            f"Base rate {cell!r} charges duty in more than one kind of unit, "
            "which one quantity cannot cover. It is NOT included in this total, "
            "which is therefore understated.")
        res.incomplete.append("specific_duty_unsupported")
        return None
    if quantity is None:
        res.warnings.append(
            f"Base rate {cell!r} includes a quantity-based duty "
            f"({'; '.join(parts)}). Enter the quantity in {rates[0].unit_text} "
            "to include it; until then it is NOT included in this total, "
            "which is therefore understated.")
        res.incomplete.append("specific_duty_omitted")
        return None
    given = unit_of(quantity_unit) if (quantity_unit or "").strip() else rates[0].unit
    if given is None or given.dimension not in dims:
        res.warnings.append(
            f"The quantity unit {quantity_unit!r} cannot be converted to "
            f"{rates[0].unit_text}, the unit this duty is charged in "
            f"({'; '.join(parts)}). The duty is NOT included in this total, "
            "which is therefore understated.")
        res.incomplete.append("quantity_unit_mismatch")
        return None
    if not (quantity_unit or "").strip():
        res.assumptions.append(
            f"The quantity {quantity} was taken to be in {rates[0].unit_text}, "
            "the unit this duty is charged in.")
    base_quantity = quantity * given.factor
    return sum((r.per_base_unit() * base_quantity for r in rates), Decimal("0"))


def compute(
    *,
    hts: str,
    country: str,
    entered_value: Decimal | float | str,
    base_rate_cell: str,
    special_rate_cell: str = "",
    column2_rate_cell: str = "",
    ch99_rules: list[Ch99Rule] | None = None,
    scopes: dict | None = None,
    regimes=None,
    fta_claimed: bool = False,
    preference_program: str | None = None,
    by_vessel: bool = True,
    is_formal_entry: bool = True,
    quantity: Decimal | float | str | None = None,
    quantity_unit: str | None = None,
) -> DutyResult:
    value = _positive_value(entered_value)
    qty = _positive_quantity(quantity)
    origin = require_country(country)
    res = DutyResult(hts=hts, country=country, entered_value=value,
                     country_code=origin)
    program = (preference_program or "").strip().upper() or None

    # --- 1. base rate --------------------------------------------------------
    parsed: ParsedRate | None = None
    used: str | None = None
    if origin in COLUMN_2_COUNTRIES:
        cell, label, authority = column2_rate_cell, "Column 2 duty", "HTSUS Column 2"
        if fta_claimed or program:
            res.warnings.append(
                "This origin is subject to Column 2 rates; a trade preference "
                "cannot be applied.")
    else:
        cell, label, authority = base_rate_cell, "MFN duty", "HTSUS Column 1 General"
        if fta_claimed or program:
            chosen, used, notes = select_preference(special_rate_cell, origin, program)
            res.warnings.extend(notes)
            if chosen is not None:
                parsed, cell = chosen, chosen.raw
                label = "FTA preferential duty"
                authority = ("HTSUS Column 1 Special"
                             + (f" (program {used})" if used else ""))
    if parsed is None:
        parsed = parse_rate(cell)

    if not (cell or "").strip():
        res.warnings.append(
            "No rate of duty was found for this line, so no base duty is "
            "included in the total.")
        res.incomplete.append("rate_missing")
    specific_exact = Decimal("0")
    specific_priced = True
    if parsed.specific:
        priced = _price_specific(parsed.specific, cell, qty, quantity_unit, res)
        specific_priced = priced is not None
        specific_exact = priced or Decimal("0")
    if parsed.unparsed:
        res.warnings.append(
            f"Part of base rate {cell!r} could not be interpreted and is NOT "
            "included in this total.")
        res.incomplete.append("rate_unparsed")

    pct = parsed.pct
    base_exact = value * pct / 100 + specific_exact
    base_amount = base_exact.quantize(Decimal("0.01"))
    # The ad valorem equivalent (U.S. note 52(k)): duty payable over customs
    # value. Unknown while any part of the base duty is unpriced.
    base_ave = (base_exact / value * 100
                if specific_priced and not parsed.unparsed and (cell or "").strip()
                else None)
    shown_rate = (base_ave.quantize(Decimal("0.0001"))
                  if parsed.specific and specific_priced else pct)
    basis = cell or "Free"
    if parsed.specific and specific_priced and qty is not None:
        basis += f" on {qty} {quantity_unit or res.quantity_needed[0]}"
    res.components.append(DutyComponent(label, shown_rate, base_amount, basis, authority))
    claim = Claim(program=used,
                  free=(label == "FTA preferential duty" and pct == 0
                        and not parsed.specific and not parsed.unparsed))

    # --- 2. Chapter 99 overlays ---------------------------------------------
    resolution = resolve_ch99(ch99_rules or [], hts, country, scopes, regimes, claim)
    applied, unscoped = resolution.applied, resolution.unverified
    res.assumptions.extend(resolution.assumptions)
    replacements: list[Ch99Rule] = []
    deals: list[Ch99Rule] = []
    for rule in applied:
        if rule.hts.startswith(IEEPA_PREFIX) and rule.rate_pct:
            rate = Decimal(str(rule.rate_pct))
            res.refundable.append(DutyComponent(
                f"IEEPA duty {rule.hts} (struck down {IEEPA_STRUCK_DOWN})", rate,
                (value * rate / 100).quantize(Decimal("0.01")),
                rule.raw_rate, f"HTSUS {rule.hts} — void per Supreme Court",
            ))
            continue
        if rule.threshold_pct is not None:
            deals.append(rule)
            continue
        if rule.effect is Effect.ADD and rule.rate_pct:
            rate = Decimal(str(rule.rate_pct))
            amt = (value * rate / 100).quantize(Decimal("0.01"))
            if rule.non_us_content_only:
                res.warnings.append(
                    f"{rule.hts} applies only to non-U.S. content; "
                    "figure shown assumes 100% non-U.S. content."
                )
            res.components.append(DutyComponent(
                f"Trade remedy {rule.hts}", rate, amt,
                rule.raw_rate, f"HTSUS {rule.hts}",
            ))
        elif rule.effect is Effect.REPLACE and rule.rate_pct:
            replacements.append(rule)

    # Deal headings turn on the entry's own column 1 rate (U.S. note 52(k)): at
    # or above the threshold the duty is left alone; below it, the additional
    # duty tops the total up to the threshold.
    if deals:
        if base_ave is None:
            res.warnings.append(
                f"{', '.join(r.hts for r in deals)} charge a duty that depends on this "
                "line's own ad valorem equivalent rate, which cannot be found while its "
                "base duty is unpriced. They are NOT in this total, which is therefore "
                "understated.")
            res.incomplete.append("deal_rate_unresolved")
        else:
            for rule in deals:
                threshold = Decimal(str(rule.threshold_pct))
                if (base_ave >= threshold) != rule.threshold_above:
                    continue
                if rule.effect is Effect.REPLACE and rule.rate_pct:
                    total_rate = Decimal(str(rule.rate_pct))
                    top_up = (value * total_rate / 100 - base_exact).quantize(Decimal("0.01"))
                    res.components.append(DutyComponent(
                        f"Trade remedy {rule.hts} (tops the duty up to {_pct(total_rate)}%)",
                        (total_rate - base_ave).quantize(Decimal("0.0001")), top_up,
                        rule.raw_rate, f"HTSUS {rule.hts}",
                    ))
                else:
                    res.assumptions.append(
                        f"The duty on this line is {base_ave.quantize(Decimal('0.01'))}%, "
                        f"at or above {_pct(threshold)}%, so {rule.hts} adds nothing "
                        "(U.S. note 52(k)).")

    # A replacement rate supersedes the base rate; the most specific wins.
    if replacements:
        winner = max(
            replacements,
            key=lambda r: (
                max((len(b.replace(".", "")) for b in r.base_refs), default=0),
                r.rate_pct or 0,
            ),
        )
        rate = Decimal(str(winner.rate_pct))
        res.components = [c for c in res.components if c.label != label]
        res.components.insert(0, DutyComponent(
            f"Duty per {winner.hts}", rate,
            (value * rate / 100).quantize(Decimal("0.01")),
            winner.raw_rate, f"HTSUS {winner.hts}",
        ))
        if len(replacements) > 1:
            res.warnings.append(
                f"{len(replacements)} replacement-rate headings matched; applied the most "
                f"specific ({winner.hts}). Others: "
                + ", ".join(r.hts for r in replacements if r is not winner)
            )

    for rule in unscoped:
        if rule.effect in (Effect.ADD, Effect.REPLACE) and rule.rate_pct:
            if rule.hts.startswith(IEEPA_PREFIX):
                res.refund_unverified.append(rule.hts)
            else:
                res.scope_unverified.append(rule.hts)
    if res.scope_unverified:
        res.warnings.append(
            f"{len(res.scope_unverified)} trade-remedy heading(s) may apply to this "
            f"entry from {country}, but their product scope is defined only in the "
            "Chapter 99 U.S. Notes and could not be resolved. They are excluded from "
            "this figure pending scope verification."
        )
    if res.refund_unverified:
        res.warnings.append(
            f"{len(res.refund_unverified)} struck-down (IEEPA) heading(s) could not be "
            "scoped, so the refundable figure may be understated. This does not "
            "change the duty owed."
        )

    # --- 3. user fees --------------------------------------------------------
    if fee_constants_stale():
        res.warnings.append(
            f"MPF/HMF figures are FY2026 constants, unverified past "
            f"{FEE_CONSTANTS_EFFECTIVE_THROUGH.isoformat()}; re-check 19 CFR "
            "24.22/24.24 for the new fiscal year's amounts."
        )
    if is_formal_entry:
        mpf = (value * MPF_RATE).quantize(Decimal("0.01"))
        mpf = min(max(mpf, MPF_MIN), MPF_MAX)
        res.components.append(DutyComponent(
            "Merchandise Processing Fee", MPF_RATE * 100, mpf,
            f"0.3464% (min ${MPF_MIN}, max ${MPF_MAX})", "19 CFR 24.23",
        ))
    if by_vessel:
        hmf = (value * HMF_RATE).quantize(Decimal("0.01"))
        res.components.append(DutyComponent(
            "Harbor Maintenance Fee", HMF_RATE * 100, hmf, "0.125%", "19 CFR 24.24",
        ))

    return res


def entry_mpf(total_value: Decimal | float | str, *, entries: int = 1) -> DutyComponent:
    """Merchandise Processing Fee for a catalogue, applied per entry.

    The MPF floor and cap belong to an entry, not a product line: ten $100 lines
    on one formal entry pay one minimum, not ten. A catalogue does not say how
    its lines are grouped, so the caller states how many formal entries the
    value is spread over (evenly), and the result says so.
    """
    total = Decimal(str(total_value))
    if entries < 1:
        raise ValueError("entries must be at least 1")
    per_entry = total / entries
    each = min(max((per_entry * MPF_RATE).quantize(Decimal("0.01")), MPF_MIN), MPF_MAX)
    return DutyComponent(
        "Merchandise Processing Fee" + (f" ({entries} formal entries)" if entries > 1 else ""),
        MPF_RATE * 100, (each * entries).quantize(Decimal("0.01")),
        f"0.3464% per entry (min ${MPF_MIN}, max ${MPF_MAX})", "19 CFR 24.23",
    )
