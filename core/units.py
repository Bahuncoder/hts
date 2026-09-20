"""Units of quantity for specific (per-unit) duties.

A specific duty is charged per unit of the goods ("8.8¢/kg", "$1.70/m3",
"2¢ each"), so pricing it needs a quantity in that unit. Units belong to a
dimension; a quantity converts only within its own dimension (pounds to
kilograms, gallons to litres) and never across it (a count is not a weight).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal

D = Decimal


@dataclass(frozen=True)
class Unit:
    dimension: str
    factor: Decimal          # size of one of this unit, in the dimension's base
    label: str               # what to call it when asking for a quantity


# alias (lower-case, no trailing dots or spaces) -> Unit
_TABLE: dict[str, Unit] = {}


def _add(unit: Unit, *aliases: str) -> None:
    for a in aliases:
        _TABLE[a] = unit


_add(Unit("mass", D(1), "kilograms"), "kg", "kgs", "kilogram", "kilograms", "kilo")
_add(Unit("mass", D("0.001"), "grams"), "g", "gram", "grams")
_add(Unit("mass", D(1000), "metric tons"), "t", "tonne", "tonnes", "metric ton", "metric tons", "mt")
_add(Unit("mass", D("0.45359237"), "pounds"), "lb", "lbs", "pound", "pounds")
_add(Unit("mass", D("0.028349523125"), "ounces"), "oz", "ounce", "ounces")
_add(Unit("volume", D(1), "liters"), "l", "liter", "liters", "litre", "litres")
_add(Unit("volume", D("0.001"), "milliliters"), "ml", "milliliter", "milliliters")
_add(Unit("volume", D(1000), "cubic meters"), "m3", "m³", "cubic meter", "cubic meters")
_add(Unit("volume", D("3.785411784"), "US gallons"), "gal", "gallon", "gallons")
_add(Unit("proof_liter", D(1), "proof liters"), "pf.liter", "pf liter", "pf.liters",
     "pf liters", "proof liter", "proof liters")
_add(Unit("barrel", D(1), "barrels"), "bbl", "barrel", "barrels")
_add(Unit("count", D(1), "pieces"), "each", "ea", "piece", "pieces", "pcs", "pc",
     "no", "no.", "unit", "units", "article", "articles")
_add(Unit("count", D(12), "dozen"), "doz", "doz.", "dozen")
_add(Unit("count", D(144), "gross"), "gross")
_add(Unit("count", D(1000), "thousands"), "thousand", "thousands")
_add(Unit("pair", D(1), "pairs"), "pr", "prs", "pair", "pairs")
_add(Unit("jewel", D(1), "jewels"), "jewel", "jewels")
_add(Unit("head", D(1), "head"), "head")
_add(Unit("pack", D(1), "packs"), "pack", "packs")
_add(Unit("length", D(1), "meters"), "m", "meter", "meters", "metre", "metres")


def unit_of(name: str | None) -> Unit | None:
    """Look a unit up by any spelling; None when it is not one we know."""
    key = re.sub(r"\s+", " ", (name or "").strip().lower()).rstrip(".")
    return _TABLE.get(key) or _TABLE.get(key + ".")


_SPECIFIC = re.compile(
    r"^(?P<cur>\$)?\s*(?P<amt>\d+(?:\.\d+)?)\s*(?P<cents>¢|cents?)?\s*"
    r"(?:/\s*|\s+per\s+|\s+)(?P<unit>[A-Za-z][A-Za-z0-9.³² ]*?)\s*$")


@dataclass(frozen=True)
class SpecificRate:
    """One quantity-based part of a duty, in dollars per one `unit`."""
    dollars: Decimal
    unit: Unit
    unit_text: str
    raw: str

    def per_base_unit(self) -> Decimal:
        return self.dollars / self.unit.factor


def parse_specific(part: str) -> SpecificRate | None:
    """'8.8¢/kg' -> $0.088 per kg. None for anything this cannot price exactly:
    a qualifier ('on copper content'), a sliding scale, an unknown unit."""
    m = _SPECIFIC.match((part or "").strip())
    if not m:
        return None
    unit = unit_of(m.group("unit"))
    if unit is None or not (m.group("cur") or m.group("cents")):
        return None
    amount = D(m.group("amt"))
    dollars = amount / 100 if m.group("cents") else amount
    return SpecificRate(dollars, unit, m.group("unit").strip(), part.strip())


def convert(quantity: Decimal, given: Unit, wanted_dimension: str) -> Decimal | None:
    """`quantity` of `given`, in the base unit of `wanted_dimension`; None when
    the dimensions differ."""
    if given.dimension != wanted_dimension:
        return None
    return quantity * given.factor
