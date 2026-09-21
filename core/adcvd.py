"""Which antidumping and countervailing duty orders may reach a product.

The orders come from ingest/adcvd.py: every order in effect, its country, and
the HTS numbers Commerce lists in its scope. A match is a flag, never a figure:
the duty is a cash deposit that depends on the exporter, so it is not computed,
and a quote with a match says its total leaves the deposit out.

Two limits are stated with every result. Commerce lists HTS numbers "for
convenience"; the written scope decides, so a product an order covers but does
not list is not matched. And an order whose scope lists no HTS number cannot be
matched at all; those are counted per origin so the quote can say they were not
checked.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Order:
    case: str
    kind: str                       # AD or CVD
    country: str
    iso: str
    product: str
    prefixes: frozenset[str]
    source: str | None = None
    source_date: str | None = None

    def covers(self, digits: str) -> bool:
        return any(digits.startswith(p) for p in self.prefixes)

    def as_dict(self) -> dict:
        return {"case": self.case, "kind": self.kind, "product": self.product,
                "country": self.country, "source": self.source,
                "source_date": self.source_date}


class AdcvdIndex:
    def __init__(self, orders: list[Order], generated: str = ""):
        self.generated = generated
        self.orders = orders
        self._by_country: dict[str, list[Order]] = {}
        for o in orders:
            self._by_country.setdefault(o.iso, []).append(o)

    def __bool__(self) -> bool:
        return bool(self.orders)

    @classmethod
    def load(cls, path: str | Path) -> "AdcvdIndex | None":
        p = Path(path)
        if not p.exists():
            return None
        data = json.loads(p.read_text())
        orders = [
            Order(o["case"], o["kind"], o["country"], o["iso"], o["product"],
                  frozenset(o.get("hts") or ()), o.get("source"), o.get("source_date"))
            for o in data.get("orders", []) if o.get("iso")]
        return cls(orders, data.get("generated", ""))

    def match(self, digits: str, origin: str) -> tuple[list[Order], int]:
        """(orders that list this code for this origin, orders for this origin
        whose scope lists no HTS number and so could not be checked)."""
        mine = self._by_country.get(origin, [])
        hits = [o for o in mine if o.covers(digits)]
        unchecked = sum(1 for o in mine if not o.prefixes)
        return hits, unchecked
