"""Wires the HTS tree, Chapter 99 rules and duty resolver into one entry point."""
from __future__ import annotations

import json
from decimal import Decimal
from functools import cached_property

import re

from core.ch99 import Ch99Rule, parse_countries, parse_rule
from core.duty import DutyResult, compute
from core.hts import HtsTree
from ingest.notes import load as load_scopes


class TariffEngine:
    def __init__(self, hts_path: str, notes_path: str | None = None):
        self.tree = HtsTree.load(hts_path)
        self.scopes = load_scopes(notes_path) if notes_path else {}
        with open(hts_path) as fh:
            rows = json.load(fh)
        self.ch99: list[Ch99Rule] = []
        for r in rows:
            code = (r.get("htsno") or "").strip()
            if not code.startswith("9903") or not (r.get("general") or "").strip():
                continue
            rule = parse_rule(r)
            # Chapter 99 frequently states country scope on a superior line
            # ("Articles the product of Japan:") rather than on the rate line
            # itself. Inherit it from ancestors when the line is silent.
            line = self.tree.get(code)
            if not rule.countries and line:
                # Superior lines often carry no HTS number of their own
                # ("Articles the product of Japan:"), so walk the description
                # path rather than the code-bearing ancestors.
                for desc in reversed(line.path):
                    inherited = parse_countries(desc)
                    if inherited:
                        rule.countries = inherited
                        rule.country_inherited = True
                        break
            # Suspension is published as a footnote on the duty column, not in
            # the rate cell. A suspended heading must never be applied — this
            # is the most common source of overstated duty figures.
            for fn in r.get("footnotes") or []:
                val = (fn.get("value") or "")
                if "suspend" in val.lower() and re.search(
                    rf"heading\s+{re.escape(code)}\b", val
                ):
                    rule.suspended = True
                    rule.suspension_note = val.strip()
                    break
            self.ch99.append(rule)

    @cached_property
    def leaf_count(self) -> int:
        return len(self.tree.leaves)

    def quote(
        self, *, hts: str, country: str, value: Decimal | float | str,
        fta_claimed: bool = False, by_vessel: bool = True,
    ) -> DutyResult:
        general, _ = self.tree.effective_rate_cell(hts, "general")
        special, _ = self.tree.effective_rate_cell(hts, "special")
        other, _ = self.tree.effective_rate_cell(hts, "other")
        return compute(
            hts=hts, country=country, entered_value=value,
            base_rate_cell=general, special_rate_cell=special,
            column2_rate_cell=other, ch99_rules=self.ch99, scopes=self.scopes,
            fta_claimed=fta_claimed, by_vessel=by_vessel,
        )
