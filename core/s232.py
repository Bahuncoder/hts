"""Section 232: which heading carries the duty, decided per regime and combined.

Each 232 regime reads its own product lists out of its U.S. note and answers
for one code, origin and set of importer-stated facts with one of

    subject      it is charged under the named heading(s)
    not_subject  the regime does not reach this entry
    unknown      it might, and the quote must say so

Regimes: metals (note 16, core/metals.py), vehicle parts (notes 33 and 38),
and wood products (note 37). Whole vehicles, pharmaceuticals, semiconductors
and every deal-specific origin structure stay unknown; nothing here guesses.

Cross-regime rules come from the notes themselves: parts of passenger and
heavy vehicles are carved out of the metals duties (notes 33(f)(1), 38(h)(1)),
and a code two regimes both list is unknown rather than charged twice.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal

from core.metals import TABLE_TOKEN, MetalsIndex, Selection

_LINE = re.compile(rf"^\s*(?:{TABLE_TOKEN}\s*;?\s*)+$")
VEHICLE_FAMILIES = ("9903.94", "9903.74")       # candidates are headings or heading prefixes

USMCA_PROGRAMS = frozenset({"S", "S+"})
USMCA_ORIGINS = frozenset({"CA", "MX"})

VEHICLE_USES = {"passenger": "a part of a passenger vehicle or light truck",
                "heavy": "a part of a medium- or heavy-duty vehicle",
                "none": "not a vehicle part"}


def normalize_vehicle_use(text: str | None) -> str | None:
    t = re.sub(r"[\s_-]+", " ", (text or "").strip().lower())
    if not t:
        return None
    if t in ("none", "no", "n/a", "not a vehicle part", "not vehicle part", "other"):
        return "none"
    if any(w in t for w in ("heavy", "medium", "mhdv", "bus")):
        return "heavy"
    if any(w in t for w in ("passenger", "light", "car", "suv", "sedan", "van", "pickup")):
        return "passenger"
    raise ValueError(
        f"Unrecognised vehicle use {text!r}. Use 'passenger', 'heavy' or 'none', or leave it blank.")


def table_codes(text: str) -> frozenset[str]:
    """HTS prefixes from the table lines of a block (lines made only of codes)."""
    out: set[str] = set()
    for line in text.split("\n"):
        if _LINE.match(line):
            out |= {c.replace(".", "") for c in re.findall(TABLE_TOKEN, line)}
    return frozenset(c for c in out if not c.startswith(("98", "99")))


def between(text: str, start: str, stop: str) -> str:
    a = re.search(start, text)
    if not a:
        return ""
    b = re.search(stop, text[a.end():])
    return text[a.end():a.end() + b.start()] if b else ""


@dataclass
class VehicleIndex:
    pv_parts: "Domain"                           # noqa: F821  33(g)
    heavy_parts: "Domain"                        # noqa: F821  38(i)
    vehicles: "Domain"                           # noqa: F821  33(b), 38(b), 38(c)
    deal_headings: dict[str, frozenset[str]]     # origin -> its own 9903.94/.74 headings

    def __bool__(self) -> bool:
        return bool(self.pv_parts) and bool(self.heavy_parts)

    def select(self, digits: str, origin: str, program: str | None,
               use: str | None) -> Selection:
        in_pv, in_h = self.pv_parts.covers(digits), self.heavy_parts.covers(digits)
        if self.vehicles.covers(digits):
            return Selection("unknown", candidates=VEHICLE_FAMILIES)
        if not (in_pv or in_h):
            return Selection()
        if use is None:
            return Selection("unknown", candidates=(
                *( ("9903.94.05",) if in_pv else ()), *(("9903.74.08",) if in_h else ()),
                *self.deal_headings.get(origin, ())), needs=("vehicle_use",))
        if use == "none":
            return Selection(assumptions=[
                "The goods are stated not to be vehicle parts, so the Section 232 vehicle-parts "
                "duties (U.S. notes 33 and 38) are not charged."])
        listed = in_pv if use == "passenger" else in_h
        if not listed:
            return Selection(assumptions=[
                f"The goods are stated to be {VEHICLE_USES[use]}, but their code is not on that "
                "regime's parts list, so its duty is not charged."])
        if use == "passenger" and origin in self.deal_headings:
            return Selection("unknown", candidates=("9903.94.05", *self.deal_headings[origin]))
        usmca = program in USMCA_PROGRAMS and origin in USMCA_ORIGINS
        if use == "passenger":
            heading, exempt = "9903.94.05", "9903.94.06"
        else:
            heading, exempt = "9903.74.08", "9903.74.10"
        if usmca:
            return Selection("subject", headings=(exempt,), assumptions=[
                f"USMCA treatment is claimed, so {exempt} applies instead of {heading} "
                "(the parts are assumed to qualify and not to be a knock-down kit)."])
        return Selection("subject", headings=(heading,), assumptions=[
            f"The goods are stated to be {VEHICLE_USES[use]}, so {heading} applies at the full "
            "value; no manufacturer import-adjustment offset is assumed."])


@dataclass
class WoodIndex:
    softwood: "Domain"                           # noqa: F821  37(b)  -> 9903.76.01
    upholstered: "Domain"                        # noqa: F821  37(d)  -> 9903.76.02
    cabinets: "Domain"                           # noqa: F821  37(f)  -> 9903.76.03
    deal_headings: dict[str, frozenset[str]]

    def __bool__(self) -> bool:
        return bool(self.softwood) and bool(self.upholstered) and bool(self.cabinets)

    def select(self, digits: str) -> Selection:
        hits = [h for h, d in (("9903.76.01", self.softwood), ("9903.76.02", self.upholstered),
                               ("9903.76.03", self.cabinets)) if d.covers(digits)]
        if not hits:
            return Selection()
        return Selection("subject", headings=tuple(hits))

    def for_origin(self, sel: Selection, origin: str) -> Selection:
        """Upholstered furniture and cabinets have their own headings for the
        U.K., E.U., Japan, Korea and Taiwan; those origins stay unknown."""
        own = self.deal_headings.get(origin)
        if sel.status == "subject" and own and any(h != "9903.76.01" for h in sel.headings):
            return Selection("unknown", candidates=(*sel.headings, *own))
        if sel.status == "subject" and any(h == "9903.76.03" for h in sel.headings):
            sel.assumptions.append(
                "The goods are assumed to be completed wooden kitchen cabinets or vanities, "
                "or parts of them (U.S. note 37(f)-(g)).")
        return sel


@dataclass
class Outcome:
    headings: set[str] = field(default_factory=set)
    candidates: set[str] = field(default_factory=set)
    assumptions: list[str] = field(default_factory=list)

    unresolved: bool = False                     # a regime this module does not decide lists the code
    needs: set[str] = field(default_factory=set)  # facts that would settle what is unknown

    @property
    def status(self) -> str:
        if self.headings:
            return "subject"
        return "unknown" if (self.candidates or self.unresolved) else "not_subject"

    def charges(self, heading: str) -> bool:
        return heading in self.headings

    def flags(self, heading: str) -> bool:
        return any(heading.startswith(c) for c in self.candidates)


@dataclass
class Section232:
    metals: MetalsIndex | None
    vehicles: VehicleIndex | None
    wood: WoodIndex | None
    unresolved: "Domain"                         # noqa: F821  regimes not decided here

    def resolve(self, digits: str, origin: str, facts) -> Outcome:
        out = Outcome(unresolved=self.unresolved.covers(digits))
        veh = (self.vehicles.select(digits, origin, facts.program, facts.vehicle_use)
               if self.vehicles else Selection("unknown", candidates=VEHICLE_FAMILIES))
        wood = (self.wood.for_origin(self.wood.select(digits), origin)
                if self.wood else Selection())
        met = Selection()
        if self.metals:
            met = self.metals.select(digits, origin, facts.metal_weight_pct)
            if veh.status == "subject":
                # Parts charged as vehicle parts are not charged the metals duties.
                met = Selection()
            elif veh.status == "unknown" and met.status != "not_subject":
                # Whether it is a vehicle part decides whether metals applies.
                met = Selection("unknown", candidates=(*met.headings, *met.candidates),
                                needs=met.needs)
        # A code two regimes both claim is charged under neither until the
        # importer says which; the metals and wood lists do overlap.
        if met.status != "not_subject" and wood.status != "not_subject":
            both = set(met.headings) | set(met.candidates) | set(wood.headings) | set(wood.candidates)
            met = wood = Selection("unknown", candidates=tuple(both))
        for sel in (veh, wood, met):
            out.assumptions += [a for a in sel.assumptions if a not in out.assumptions]
            if sel.status == "subject":
                out.headings |= set(sel.headings)
            elif sel.status == "unknown":
                out.candidates |= set(sel.candidates)
                out.needs |= set(sel.needs)
        return out
