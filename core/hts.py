"""HTS tree: load the USITC schedule and resolve inherited attributes.

The HTS is a hierarchy expressed as a flat list with an `indent` column.
Leaf (10-digit) lines frequently inherit their duty rates and description
context from superior lines, so the tree must be reconstructed to read a
rate correctly.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import cached_property


@dataclass
class HtsLine:
    hts: str
    indent: int
    description: str
    general: str = ""
    special: str = ""
    other: str = ""
    units: list[str] = field(default_factory=list)
    parent: str | None = None
    path: list[str] = field(default_factory=list)   # ancestor descriptions, root-first

    @property
    def digits(self) -> str:
        return self.hts.replace(".", "")

    @property
    def is_leaf(self) -> bool:
        return len(self.digits) == 10

    @property
    def full_description(self) -> str:
        return " > ".join([*self.path, self.description])


class HtsTree:
    def __init__(self, rows: list[dict]):
        self._lines: dict[str, HtsLine] = {}
        self._ordered: list[HtsLine] = []
        stack: list[tuple[int, str, str]] = []   # (indent, hts, description)

        for row in rows:
            code = (row.get("htsno") or "").strip()
            try:
                indent = int(row.get("indent") or 0)
            except (TypeError, ValueError):
                indent = 0
            desc = (row.get("description") or "").strip()

            while stack and stack[-1][0] >= indent:
                stack.pop()

            parent = next((c for _, c, _ in reversed(stack) if c), None)
            path = [d for _, _, d in stack]

            line = HtsLine(
                hts=code, indent=indent, description=desc,
                general=(row.get("general") or "").strip(),
                special=(row.get("special") or "").strip(),
                other=(row.get("other") or "").strip(),
                units=row.get("units") or [],
                parent=parent, path=path,
            )
            self._ordered.append(line)
            if code:
                self._lines[code] = line
            stack.append((indent, code, desc))

    @classmethod
    def load(cls, path: str) -> "HtsTree":
        with open(path) as fh:
            return cls(json.load(fh))

    def get(self, code: str) -> HtsLine | None:
        return self._lines.get(code)

    @cached_property
    def leaves(self) -> list[HtsLine]:
        return [ln for ln in self._ordered if ln.is_leaf]

    def ancestors(self, code: str) -> list[HtsLine]:
        """Walk up the tree from a code to the chapter root."""
        out, cur = [], self.get(code)
        while cur and cur.parent:
            parent = self.get(cur.parent)
            if not parent:
                break
            out.append(parent)
            cur = parent
        return out

    def effective_rate_cell(self, code: str, column: str = "general") -> tuple[str, str]:
        """Return (rate_text, source_code) — inheriting from superior lines when blank."""
        line = self.get(code)
        if not line:
            return "", ""
        val = getattr(line, column, "")
        if val:
            return val, code
        for anc in self.ancestors(code):
            val = getattr(anc, column, "")
            if val:
                return val, anc.hts
        return "", ""

    def prefix_matches(self, code: str) -> list[str]:
        """All ancestor code prefixes of a leaf, longest first (8,6,4-digit)."""
        d = code.replace(".", "")
        return [d[:8], d[:6], d[:4]]
