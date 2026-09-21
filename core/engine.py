"""Wires the HTS tree, Chapter 99 rules and duty resolver into one entry point."""
from __future__ import annotations

import json
from pathlib import Path
from decimal import Decimal
from functools import cached_property

import re

from core.ch99 import Ch99Rule, parse_countries, parse_rule
from core.duty import DutyResult, compute
from core.hts import HtsTree, InvalidHts, NotStatisticalLine  # noqa: F401
from core.regimes import build_index
from ingest.notes import country_statements, extract_note52, load as load_scopes


class TariffEngine:
    def __init__(self, hts_path: str, notes_path: str | None = None,
                 revision: str = ""):
        self.revision = revision
        self.tree = HtsTree.load(hts_path)
        self.scopes = load_scopes(notes_path) if notes_path else {}
        raw_notes = open(notes_path, errors="ignore").read() if notes_path else ""
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
            # A compiler's note on the group header ("Duties suspended except on
            # certain goods entered from foreign trade zones") suspends the
            # provisions beneath it for ordinary entries.
            context = " ".join([rule.description, *(line.path if line else [])])
            note = re.search(r"[Cc]ompiler.s note:[^\]]*[Dd]uties? (?:are )?suspended[^\]]*", context)
            if note and not rule.suspended:
                rule.suspended = True
                rule.suspension_note = note.group(0).strip()
            self.ch99.append(rule)

        # A note that says "products of China shall be subject to" a list of
        # headings names the country for headings whose own text does not.
        for heads, country in country_statements(raw_notes):
            for rule in self.ch99:
                if rule.hts in heads and not rule.countries:
                    rule.countries = parse_countries(f"products of {country}") or [country]
                    rule.country_inherited = True

        # The published schedule shades expired provisions; ingest.shading reads
        # that shading into a file beside the notes.
        shaded: set[str] = set()
        if notes_path:
            marks = Path(notes_path).with_name("chapter99_expired.json")
            if marks.exists():
                shaded = set(json.loads(marks.read_text()).get("expired", []))
        self.shading_loaded = bool(shaded)

        self.regimes = (build_index(self.ch99, self.scopes, raw_notes,
                                    extract_note52(raw_notes), shaded=shaded)
                        if raw_notes else None)

    @cached_property
    def leaf_count(self) -> int:
        return len(self.tree.leaves)

    def quote(
        self, *, hts: str, country: str, value: Decimal | float | str,
        fta_claimed: bool = False, preference_program: str | None = None,
        by_vessel: bool = True, is_formal_entry: bool = True,
        quantity: Decimal | float | str | None = None,
        quantity_unit: str | None = None,
        end_use: str | None = None,
        metal_weight_pct: Decimal | float | str | None = None,
        vehicle_use: str | None = None,
    ) -> DutyResult:
        """Price one statistical line.

        Raises InvalidHts / NotStatisticalLine for a code that is not a
        10-digit line in this schedule, countries.UnknownCountry for an origin
        that cannot be resolved, and ValueError for a non-positive value. None
        of these degrade to a normal-looking number.
        """
        line = self.tree.canonical_leaf(hts)
        code = line.hts
        general, _ = self.tree.effective_rate_cell(code, "general")
        special, _ = self.tree.effective_rate_cell(code, "special")
        other, _ = self.tree.effective_rate_cell(code, "other")
        res = compute(
            hts=code, country=country, entered_value=value,
            base_rate_cell=general, special_rate_cell=special,
            column2_rate_cell=other, ch99_rules=self.ch99, scopes=self.scopes,
            regimes=self.regimes,
            fta_claimed=fta_claimed, preference_program=preference_program,
            by_vessel=by_vessel, is_formal_entry=is_formal_entry,
            quantity=quantity, quantity_unit=quantity_unit, end_use=end_use,
            metal_weight_pct=metal_weight_pct, vehicle_use=vehicle_use,
        )
        res.dataset_revision = self.revision
        return res

    def leaves_under(self, prefix8: str) -> list:
        """Statistical lines beneath an 8-digit subheading, in schedule order."""
        d = prefix8.replace(".", "")[:8]
        return [ln for ln in self.tree.leaves if ln.digits.startswith(d)]
