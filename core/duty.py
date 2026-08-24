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

import re
from dataclasses import dataclass, field
from decimal import Decimal

from core.ch99 import Ch99Rule, Effect

# --- FY2026 user fees (effective 2025-10-01) ---------------------------------
MPF_RATE = Decimal("0.003464")
MPF_MIN = Decimal("33.58")
MPF_MAX = Decimal("651.50")
HMF_RATE = Decimal("0.00125")

# Column 2 ("other") applies to a small set of non-normal-trade-relations countries.
COLUMN_2_COUNTRIES = {"cuba", "north korea", "russia", "belarus"}

# Subchapter I of chapter 99 carries the tariffs imposed under IEEPA. The
# Supreme Court held on 2026-02-20 that IEEPA confers no such authority, so
# these provisions are printed in the schedule but legally void. Duty paid
# under them is potentially refundable, so they are reported separately rather
# than folded into the amount currently owed.
IEEPA_PREFIX = "9903.01"
IEEPA_STRUCK_DOWN = "2026-02-20"

_AD_VALOREM = re.compile(r"([\d.]+)\s*%")
_SPECIFIC = re.compile(r"([\d.]+)\s*(?:cents|¢)/\s*(\w+)", re.I)


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
        }


def parse_base_rate(cell: str) -> tuple[Decimal | None, str | None]:
    """Parse an HTS rate cell. Returns (ad_valorem_pct, unhandled_specific_text)."""
    s = (cell or "").strip()
    if not s or s.lower() == "free":
        return Decimal("0"), None
    m = _AD_VALOREM.search(s)
    pct = Decimal(m.group(1)) if m else None
    # Compound/specific duties (e.g. "5.5% + 12 cents/kg") need quantity data.
    specific = s if _SPECIFIC.search(s) else None
    if pct is None and specific is None:
        return None, s
    return (pct if pct is not None else Decimal("0")), specific


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
    c = (country or "").strip().lower()
    digits = hts.replace(".", "")
    prefixes = {digits[:8], digits[:6], digits[:4]}

    applied: list[Ch99Rule] = []
    unscoped: list[Ch99Rule] = []

    for r in rules:
        if r.suspended:
            continue
        if r.countries and not any(x.lower() == c for x in r.countries):
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
            if sc.countries and not any(x.lower() == c for x in sc.countries):
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
    fta_claimed: bool = False,
    by_vessel: bool = True,
    is_formal_entry: bool = True,
) -> DutyResult:
    value = Decimal(str(entered_value))
    res = DutyResult(hts=hts, country=country, entered_value=value)

    # --- 1. base rate --------------------------------------------------------
    if (country or "").strip().lower() in COLUMN_2_COUNTRIES:
        cell, label, authority = column2_rate_cell, "Column 2 duty", "HTSUS Column 2"
    elif fta_claimed and special_rate_cell:
        cell, label, authority = special_rate_cell, "FTA preferential duty", "HTSUS Column 1 Special"
    else:
        cell, label, authority = base_rate_cell, "MFN duty", "HTSUS Column 1 General"

    pct, specific = parse_base_rate(cell)
    if specific:
        res.warnings.append(
            f"Base rate {cell!r} includes a specific or compound duty; "
            "quantity data is required for an exact figure."
        )
    if pct is None:
        res.warnings.append(f"Could not parse base rate {cell!r}.")
        pct = Decimal("0")

    base_amount = (value * pct / 100).quantize(Decimal("0.01"))
    res.components.append(DutyComponent(label, pct, base_amount, cell or "Free", authority))

    # --- 2. Chapter 99 overlays ---------------------------------------------
    applied, unscoped = applicable_ch99(ch99_rules or [], hts, country, scopes)
    replacements: list[Ch99Rule] = []
    for rule in applied:
        if rule.hts.startswith(IEEPA_PREFIX) and rule.rate_pct:
            rate = Decimal(str(rule.rate_pct))
            res.refundable.append(DutyComponent(
                f"IEEPA duty {rule.hts} (struck down {IEEPA_STRUCK_DOWN})", rate,
                (value * rate / 100).quantize(Decimal("0.01")),
                rule.raw_rate, f"HTSUS {rule.hts} — void per Supreme Court",
            ))
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
        if rule.effect is Effect.ADD and rule.rate_pct:
            res.scope_unverified.append(rule.hts)
    if res.scope_unverified:
        res.warnings.append(
            f"{len(res.scope_unverified)} trade-remedy heading(s) cover {country} but "
            "define product scope in the Chapter 99 U.S. Notes. They are excluded "
            "from this figure pending scope verification."
        )

    # --- 3. user fees --------------------------------------------------------
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
