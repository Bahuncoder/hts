"""SQLite reference store.

Holds the HTS schedule, parsed Chapter 99 rules, U.S. Notes scope, CROSS
rulings and Federal Register actions. Read-heavy and rebuilt from public
sources, so it ships as a build artifact rather than a provisioned service.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "htsdesk.db"
SCHEMA = Path(__file__).resolve().parent / "schema.sql"


def connect(path: Path | str | None = None, *, readonly: bool = False) -> sqlite3.Connection:
    p = Path(path or DB_PATH)
    if readonly:
        conn = sqlite3.connect(f"file:{p}?mode=ro", uri=True, check_same_thread=False)
    else:
        p.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(p, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # Ingest workers run concurrently with the API; WAL lets readers proceed
    # during writes, and the timeout absorbs brief writer contention.
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def init(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA.read_text())
    conn.commit()


def set_meta(conn: sqlite3.Connection, key: str, value) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value) if not isinstance(value, str) else value),
    )


def get_meta(conn: sqlite3.Connection, key: str, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def begin(conn: sqlite3.Connection) -> None:
    """Open a write transaction that readers see all-or-nothing under WAL."""
    conn.execute("BEGIN IMMEDIATE")


def rebuild_hts_index(conn: sqlite3.Connection) -> int:
    """Repopulate hts_fts from hts. The caller owns the transaction."""
    conn.execute("DELETE FROM hts_fts")
    conn.execute(
        "INSERT INTO hts_fts(hts, description, full_path) "
        "SELECT hts, description, full_path FROM hts WHERE is_leaf = 1")
    return conn.execute("SELECT count(*) c FROM hts_fts").fetchone()["c"]


def rebuild_ruling_index(conn: sqlite3.Connection) -> int:
    """Repopulate ruling_fts from ruling. The caller owns the transaction.

    Every ruling is indexed. Dropping and recreating the table empty, as the
    schedule refresh used to, silently removed all classification precedent
    while the ruling rows and health counts stayed intact.
    """
    conn.execute("DELETE FROM ruling_fts")
    conn.execute(
        "INSERT INTO ruling_fts(ruling_number, subject, body) "
        "SELECT ruling_number, subject, COALESCE(body, '') FROM ruling")
    return conn.execute("SELECT count(*) c FROM ruling_fts").fetchone()["c"]


def index_coverage(conn: sqlite3.Connection) -> dict:
    """Row counts of the searchable tables next to their indexes."""
    one = lambda q: conn.execute(q).fetchone()[0]  # noqa: E731
    return {
        "leaves": one("SELECT count(*) FROM hts WHERE is_leaf = 1"),
        "hts_indexed": one("SELECT count(*) FROM hts_fts"),
        "rulings": one("SELECT count(*) FROM ruling"),
        "rulings_indexed": one("SELECT count(*) FROM ruling_fts"),
    }
