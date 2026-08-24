"""
Chapter 99 rule parser.

Chapter 99 of the HTSUS is where every trade-remedy tariff action lives
(Section 232, Section 301, and the country-specific actions). It is not a
lookup table: each line expresses a *modifier* on the duty owed under the
base ("applicable") subheading, scoped by country of origin and by product
scope, and layered with exception chains.

This module turns those free-text lines into structured rules.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum


class Effect(Enum):
    ADD = "add"            # base duty + N%
    PASSTHROUGH = "pass"   # base duty, unchanged (an exemption from an overlay)
    REPLACE = "replace"    # flat N%, replacing the base rate
    FREE = "free"          # duty-free


@dataclass
class Ch99Rule:
    hts: str
    effect: Effect
    rate_pct: float | None = None
    countries: list[str] = field(default_factory=list)
    base_refs: list[str] = field(default_factory=list)   # base subheadings this applies to
    excepts: list[str] = field(default_factory=list)     # 9903 headings that take precedence
    non_us_content_only: bool = False                    # USMCA-style partial-value duty
    description: str = ""
    raw_rate: str = ""
    suspended: bool = False
    country_inherited: bool = False
    suspension_note: str = ""


# Order matters: most specific first.
_RATE_PATTERNS: list[tuple[re.Pattern, str]] = [
    # "+ a duty of 25% upon the value of the non-U.S. content"
    (re.compile(
        r"applicable\s+subheading\s*\+\s*a\s+duty\s+of\s*([\d.]+)\s*%\s*upon\s+the\s+value\s+of\s+the\s+non-?U\.?S\.?\s+content",
        re.I), "add_non_us"),
    # "+ a duty of 25%"  /  "+ 25%"  /  "+25%"  /  "plus 25%"
    (re.compile(
        r"applicable\s+subheading\s*(?:\+|plus)\s*(?:a\s+duty\s+of\s*)?([\d.]+)\s*%", re.I), "add"),
    # tolerate the official typo: "inthe applicable subheading+ 25%"
    (re.compile(r"provided\s*in\s*the\s+applicable\s+subheading\s*\+\s*([\d.]+)\s*%", re.I), "add"),
    # "The duty provided in subheadings 1.1, 2.2 or 3.3 + 25%"
    (re.compile(r"duty\s+provided\s+in\s+subheadings?\s+[\d.,\s or]+\+\s*([\d.]+)\s*%", re.I), "add"),
]

_PASSTHROUGH = re.compile(r"^\s*(?:the\s+duty\s+provided\s+in\s+the\s+applicable\s+subheading|no\s+change)\s*$", re.I)
_FREE = re.compile(r"^\s*free\s*$", re.I)
_FLAT = re.compile(r"^\s*([\d.]+)\s*%\s*$")

_COUNTRY = re.compile(r"products?\s+of\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)")
_BASE_REF = re.compile(r"provided\s+for\s+in\s+(?:subheadings?|headings?)?\s*([\d.,\s]+(?:or\s+[\d.]+)?)", re.I)
_EXCEPT = re.compile(r"^Except\s+for\s+(?:products|articles)\s+described\s+in\s+(?:subheadings?|headings?)\s+([\d.,\s]+(?:or\s+[\d.]+)?)", re.I)

_STOPWORDS = {"The", "Articles", "Except", "United States", "U", "US"}


def _codes(blob: str) -> list[str]:
    return re.findall(r"\d{4}\.\d{2}(?:\.\d{2})?(?:\.\d{2})?", blob or "")


def parse_rate(raw: str) -> tuple[Effect, float | None, bool]:
    """Parse a Chapter 99 'general' rate cell into a structured effect."""
    s = (raw or "").strip()
    if not s:
        return Effect.PASSTHROUGH, None, False
    if _FREE.match(s):
        return Effect.FREE, None, False
    if _PASSTHROUGH.match(s):
        return Effect.PASSTHROUGH, None, False
    for pat, kind in _RATE_PATTERNS:
        m = pat.search(s)
        if m:
            return Effect.ADD, float(m.group(1)), (kind == "add_non_us")
    m = _FLAT.match(s)
    if m:
        return Effect.REPLACE, float(m.group(1)), False
    return Effect.PASSTHROUGH, None, False


def parse_countries(desc: str) -> list[str]:
    out: list[str] = []
    for m in _COUNTRY.finditer(desc or ""):
        name = m.group(1).strip()
        # "China and Hong Kong" -> two entries
        for part in re.split(r"\s+and\s+", name):
            part = part.strip().rstrip(",.")
            if part and part not in _STOPWORDS and len(part) > 1:
                out.append(part)
    seen, uniq = set(), []
    for c in out:
        if c.lower() not in seen:
            seen.add(c.lower())
            uniq.append(c)
    return uniq


def parse_rule(row: dict) -> Ch99Rule:
    desc = row.get("description") or ""
    raw = row.get("general") or ""
    effect, rate, non_us = parse_rate(raw)
    exc_m = _EXCEPT.match(desc)
    base_m = _BASE_REF.search(desc)
    return Ch99Rule(
        hts=row.get("htsno", ""),
        effect=effect,
        rate_pct=rate,
        countries=parse_countries(desc),
        base_refs=_codes(base_m.group(1)) if base_m else [],
        excepts=_codes(exc_m.group(1)) if exc_m else [],
        non_us_content_only=non_us,
        description=desc,
        raw_rate=raw.strip(),
    )
