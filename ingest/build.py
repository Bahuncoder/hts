"""Build the reference database from the parsed public sources."""
from __future__ import annotations

import json
import sys
from datetime import date, timezone, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.engine import TariffEngine
from ingest.notes import load as load_scopes
from store.db import connect, init, set_meta

ROOT = Path(__file__).resolve().parent.parent
HTS_JSON = ROOT / "data" / "hts_2026.json"
NOTES_TXT = ROOT / "data" / "chapter99.txt"


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


def build_fts(conn) -> None:
    """Full-text index over HTS descriptions. Rulings are indexed on ingest."""
    conn.executescript("""
        DROP TABLE IF EXISTS hts_fts;
        CREATE VIRTUAL TABLE hts_fts USING fts5(
            hts UNINDEXED, description, full_path,
            tokenize = 'porter unicode61'
        );
        INSERT INTO hts_fts(hts, description, full_path)
            SELECT hts, description, full_path FROM hts WHERE is_leaf = 1;

        DROP TABLE IF EXISTS ruling_fts;
        CREATE VIRTUAL TABLE ruling_fts USING fts5(
            ruling_number UNINDEXED, subject, body,
            tokenize = 'porter unicode61'
        );
    """)


def main() -> None:
    conn = connect()
    init(conn)
    engine = TariffEngine(str(HTS_JSON), str(NOTES_TXT))
    scopes = load_scopes(str(NOTES_TXT))

    n_hts = build_hts(conn, engine)
    n_rules = build_ch99(conn, engine)
    n_meta, n_pairs = build_scope(conn, scopes)
    build_fts(conn)

    set_meta(conn, "hts_edition", "2026")
    set_meta(conn, "built_at", datetime.now(timezone.utc).isoformat())
    conn.commit()

    leaves = conn.execute("SELECT count(*) c FROM hts WHERE is_leaf=1").fetchone()["c"]
    print(f"hts rows          {n_hts:,}  ({leaves:,} leaf codes)")
    print(f"ch99 rules        {n_rules:,}")
    print(f"scope headings    {n_meta:,}  ({n_pairs:,} heading/code pairs)")
    print(f"fts index         built")
    conn.close()


if __name__ == "__main__":
    main()
