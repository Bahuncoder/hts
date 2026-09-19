"""Build the reference database from the parsed public sources.

A build is one transaction. Every derived table (schedule, Chapter 99 rules,
U.S. Notes scope, search indexes) is cleared and refilled inside it, checked
against the previous build, and only then committed. Readers under WAL see the
old data until the commit and the new data after it, never a mixture, and a
build that fails validation rolls back and leaves the running data untouched.

Records that accumulate over time (rulings, Federal Register documents) are not
derived from these files and are never touched here.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.engine import TariffEngine
from ingest.notes import load as load_scopes
from store.db import (begin, connect, index_coverage, init, rebuild_hts_index,
                      rebuild_ruling_index, set_meta)

ROOT = Path(__file__).resolve().parent.parent
HTS_JSON = ROOT / "data" / "hts_2026.json"
NOTES_TXT = ROOT / "data" / "chapter99.txt"

# A refresh that returns a truncated or reshaped upstream file must not replace
# good data. Absolute floors catch a first build from a bad file; the shrink
# limit catches a good build followed by a bad one.
FLOORS = {"leaves": 19_000, "ch99_rules": 300, "scope_pairs": 5_000}
SHRINK_LIMIT = 0.90


class BuildRejected(RuntimeError):
    """The new build failed validation; nothing was published."""


def build_hts(conn, engine: TariffEngine) -> int:
    rows = []
    for ln in engine.tree._ordered:
        if not ln.hts:
            continue
        rows.append((
            ln.hts, ln.digits, ln.indent, ln.description, ln.full_description,
            ln.general, ln.special, ln.other, json.dumps(ln.units),
            int(ln.is_leaf), ln.digits[:4],
        ))
    conn.executemany(
        "INSERT OR REPLACE INTO hts(hts,digits,indent,description,full_path,"
        "general_rate,special_rate,other_rate,units,is_leaf,chapter) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?)", rows)
    return len(rows)


def build_ch99(conn, engine: TariffEngine) -> int:
    rows = [(
        r.hts, r.effect.value, r.rate_pct, json.dumps(r.countries),
        json.dumps(r.base_refs), json.dumps(r.excepts), int(r.suspended),
        r.suspension_note, int(r.country_inherited), r.raw_rate, r.description,
    ) for r in engine.ch99]
    conn.executemany(
        "INSERT OR REPLACE INTO ch99_rule(hts,effect,rate_pct,countries,base_refs,"
        "excepts,suspended,suspension_note,country_inherited,raw_rate,description) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?)", rows)
    return len(rows)


def build_scope(conn, scopes: dict) -> tuple[int, int]:
    meta, pairs = [], []
    for heading, sc in scopes.items():
        meta.append((heading, sc.note, json.dumps(sc.countries), len(sc.codes),
                     sc.effective_from, int(sc.described_scope), sc.source_excerpt[:400]))
        pairs.extend((heading, code) for code in sc.codes)
    conn.executemany(
        "INSERT OR REPLACE INTO ch99_scope_meta(heading,note,countries,code_count,"
        "effective_from,described_scope,source_excerpt) VALUES(?,?,?,?,?,?,?)", meta)
    conn.executemany(
        "INSERT OR REPLACE INTO ch99_scope(heading,code) VALUES(?,?)", pairs)
    return len(meta), len(pairs)


def counts(conn) -> dict:
    one = lambda q: conn.execute(q).fetchone()[0]  # noqa: E731
    return {
        "leaves": one("SELECT count(*) FROM hts WHERE is_leaf = 1"),
        "ch99_rules": one("SELECT count(*) FROM ch99_rule"),
        "scope_pairs": one("SELECT count(*) FROM ch99_scope"),
        **index_coverage(conn),
    }


def validate(prev: dict, new: dict, floors: dict | None = None,
             shrink_limit: float = SHRINK_LIMIT) -> list[str]:
    """Reasons the new build must not be published. Empty means it may."""
    floors = FLOORS if floors is None else floors
    problems = []
    for key, floor in floors.items():
        if new[key] < floor:
            problems.append(f"{key}: {new[key]:,} is below the floor of {floor:,}")
        if prev.get(key) and new[key] < prev[key] * shrink_limit:
            problems.append(
                f"{key}: {new[key]:,} is more than {round((1 - shrink_limit) * 100)}% "
                f"below the current {prev[key]:,}")
    if new["hts_indexed"] != new["leaves"]:
        problems.append(f"schedule index covers {new['hts_indexed']:,} of {new['leaves']:,} lines")
    if new["rulings_indexed"] != new["rulings"]:
        problems.append(f"ruling index covers {new['rulings_indexed']:,} of {new['rulings']:,} rulings")
    return problems


def dataset_revision(*paths: Path) -> str:
    h = hashlib.sha256()
    for p in paths:
        h.update(Path(p).read_bytes())
    return h.hexdigest()[:16]


def build(conn, hts_json: Path, notes_txt: Path, *, release_dir: str = "",
          floors: dict | None = None) -> dict:
    """Rebuild every derived table in one validated transaction."""
    engine = TariffEngine(str(hts_json), str(notes_txt))
    scopes = load_scopes(str(notes_txt))
    revision = dataset_revision(hts_json, notes_txt)

    prev = counts(conn)
    begin(conn)
    try:
        for table in ("hts", "ch99_rule", "ch99_scope", "ch99_scope_meta"):
            conn.execute(f"DELETE FROM {table}")
        n_hts = build_hts(conn, engine)
        n_rules = build_ch99(conn, engine)
        n_meta, n_pairs = build_scope(conn, scopes)
        rebuild_hts_index(conn)
        rebuild_ruling_index(conn)

        new = counts(conn)
        problems = validate(prev, new, floors)
        if problems:
            raise BuildRejected("; ".join(problems))

        set_meta(conn, "hts_edition", "2026")
        set_meta(conn, "built_at", datetime.now(timezone.utc).isoformat())
        set_meta(conn, "dataset_revision", revision)
        set_meta(conn, "release_dir", release_dir)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    return {"revision": revision, "hts_rows": n_hts, "ch99_rules": n_rules,
            "scope_headings": n_meta, "scope_pairs": n_pairs, **new}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--release", help="directory holding hts.json and chapter99.txt; "
                    "default is the legacy data/ files")
    args = ap.parse_args()

    if args.release:
        rel = Path(args.release).resolve()
        hts_json, notes_txt = rel / "hts.json", rel / "chapter99.txt"
        try:
            release_dir = str(rel.relative_to(ROOT))
        except ValueError:
            release_dir = str(rel)
    else:
        hts_json, notes_txt, release_dir = HTS_JSON, NOTES_TXT, ""

    conn = connect()
    init(conn)
    try:
        out = build(conn, hts_json, notes_txt, release_dir=release_dir)
    except BuildRejected as exc:
        print(f"BUILD REJECTED, previous data left in place: {exc}", file=sys.stderr)
        sys.exit(2)
    finally:
        conn.close()

    print(f"revision          {out['revision']}")
    print(f"hts rows          {out['hts_rows']:,}  ({out['leaves']:,} leaf codes)")
    print(f"ch99 rules        {out['ch99_rules']:,}")
    print(f"scope headings    {out['scope_headings']:,}  ({out['scope_pairs']:,} heading/code pairs)")
    print(f"rulings indexed   {out['rulings_indexed']:,} of {out['rulings']:,}")


if __name__ == "__main__":
    main()
