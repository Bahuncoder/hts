"""Refresh and reference-data consistency tests.

A routine refresh once destroyed the ruling search index while leaving every
row count intact, and the running engine kept quoting the previous edition
after the database moved on. These tests build a scratch database from the real
schedule files, run a second "edition" with a code removed and a rate changed,
and check that everything that reads the data agrees afterwards.

Uses the real files in data/ (skipped if absent) and a scratch database; it
never touches data/htsdesk.db. Takes about a minute.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ingest.build import (HTS_JSON, NOTES_TXT, BuildRejected, build, counts,  # noqa: E402
                          validate)
from store.db import connect, get_meta, index_coverage, init  # noqa: E402

if not (HTS_JSON.exists() and NOTES_TXT.exists()):
    print("skipped: data/hts_2026.json and data/chapter99.txt are not present")
    sys.exit(0)

_results: list[tuple[str, str, str]] = []


def check(name):
    def wrap(fn):
        try:
            fn()
            _results.append((name, "pass", ""))
        except AssertionError as exc:
            _results.append((name, "FAIL", str(exc) or "assertion failed"))
        except Exception:
            _results.append((name, "ERROR", traceback.format_exc(limit=3).strip()))
        return fn
    return wrap


tmp = Path(tempfile.mkdtemp(prefix="htsdesk-refresh-"))
DB = tmp / "ref.db"
conn = connect(DB)
init(conn)

# A small corpus of rulings, one of which mentions the code we will remove.
conn.executemany(
    "INSERT INTO ruling(ruling_number, subject, body, tariffs, revoked) VALUES(?,?,?,?,0)",
    [(f"N{i:03d}", subj, "the goods are described in the body", json.dumps(t))
     for i, (subj, t) in enumerate([
         ("men's knitted cotton t-shirt", ["6109.10.00.12"]),
         ("nylon backpack with zipper", ["4202.92.30.31"]),
         ("ceramic coffee mug", ["6912.00.48.10"]),
     ])])
conn.commit()

FIRST = build(conn, HTS_JSON, NOTES_TXT)
REMOVED = "6109.10.00.12"
CHANGED = "6912.00.48.10"


def precedent_hits(query="knitted cotton t-shirt"):
    from core.classify import _search_rulings
    return [r["ruling_number"] for r in _search_rulings(conn, query, 5)]


@check("a refresh keeps every ruling indexed, so precedent search still works")
def _():
    cov = index_coverage(conn)
    assert cov["rulings"] == 3 and cov["rulings_indexed"] == 3, cov
    assert "N000" in precedent_hits(), precedent_hits()


@check("rebuilding again does not empty the index either (the old failure mode)")
def _():
    build(conn, HTS_JSON, NOTES_TXT)
    assert index_coverage(conn)["rulings_indexed"] == 3
    assert "N000" in precedent_hits()


@check("a build that fails validation rolls back and leaves the data untouched")
def _():
    conn.execute("INSERT INTO hts(hts,digits,indent,description,full_path,is_leaf,chapter) "
                 "VALUES('0000.00.00.00','0000000000',0,'marker','marker',1,'0000')")
    conn.commit()
    before = counts(conn)
    try:
        build(conn, HTS_JSON, NOTES_TXT, floors={"leaves": 10 ** 9})
    except BuildRejected:
        pass
    else:
        raise AssertionError("an impossible floor was accepted")
    assert counts(conn) == before, "a rejected build changed the database"
    assert conn.execute("SELECT count(*) FROM hts WHERE hts='0000.00.00.00'").fetchone()[0] == 1
    conn.execute("DELETE FROM hts WHERE hts='0000.00.00.00'")
    conn.commit()


@check("a build far smaller than the current one is rejected")
def _():
    prev = counts(conn)
    shrunk = {**prev, "leaves": prev["leaves"] // 2, "hts_indexed": prev["leaves"] // 2}
    problems = validate(prev, shrunk)
    assert any("below the current" in p for p in problems), problems


@check("an index that does not cover its table is rejected")
def _():
    prev = counts(conn)
    bad = {**prev, "rulings_indexed": 0}
    assert any("ruling index" in p for p in validate(prev, bad)), validate(prev, bad)


# ---------------------------------------------------------------- second edition
release = tmp / "release2"
release.mkdir()
rows = json.loads(HTS_JSON.read_text())
edited = []
for r in rows:
    if r.get("htsno") == REMOVED:
        continue                                   # a code that no longer exists
    if r.get("htsno") == CHANGED:
        r = {**r, "general": "77%"}                # a rate that changed
    edited.append(r)
(release / "hts.json").write_text(json.dumps(edited))
shutil.copy(NOTES_TXT, release / "chapter99.txt")

REV1 = get_meta(conn, "dataset_revision")
SECOND = build(conn, release / "hts.json", release / "chapter99.txt",
               release_dir=str(release))


@check("promoting a new edition changes the dataset revision")
def _():
    assert SECOND["revision"] != FIRST["revision"] and get_meta(conn, "dataset_revision") == SECOND["revision"]
    assert REV1 == FIRST["revision"]


@check("a code removed in the new edition disappears from every table")
def _():
    assert conn.execute("SELECT count(*) FROM hts WHERE hts=?", (REMOVED,)).fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM hts_fts WHERE hts=?", (REMOVED,)).fetchone()[0] == 0


@check("the changed rate is what the database now serves")
def _():
    row = conn.execute("SELECT general_rate FROM hts WHERE hts=?", (CHANGED,)).fetchone()
    assert row["general_rate"] == "77%", row["general_rate"]


@check("the API engine reloads on the new revision: rate changed, code gone")
def _():
    import api.main as api
    from core.hts import InvalidHts

    # Serve the FIRST edition, then move the database to the second.
    api._engine = None
    conn.execute("UPDATE meta SET value=? WHERE key='dataset_revision'", (FIRST["revision"],))
    conn.execute("UPDATE meta SET value='' WHERE key='release_dir'")
    conn.commit()
    old = api.engine(conn)
    assert old.revision == FIRST["revision"]
    assert old.quote(hts=REMOVED, country="Vietnam", value=1000).total_duty > 0

    conn.execute("UPDATE meta SET value=? WHERE key='dataset_revision'", (SECOND["revision"],))
    conn.execute("UPDATE meta SET value=? WHERE key='release_dir'", (str(release),))
    conn.commit()
    new = api.engine(conn)
    assert new is not old and new.revision == SECOND["revision"], "engine did not reload"
    assert api.engine(conn) is new, "engine reloaded on every call"

    try:
        new.quote(hts=REMOVED, country="Vietnam", value=1000)
    except InvalidHts:
        pass
    else:
        raise AssertionError("a removed code is still quoted")
    res = new.quote(hts=CHANGED, country="Vietnam", value=1000)
    assert res.dataset_revision == SECOND["revision"], res.dataset_revision
    assert str(res.components[0].rate_pct) == "77", res.components[0]


@check("classifier caches are cleared when the engine reloads")
def _():
    import core.classify as cl
    cl._LEAF_CACHE["61091000"] = {"hts": REMOVED}
    import api.main as api
    conn.execute("UPDATE meta SET value='rev-three' WHERE key='dataset_revision'")
    conn.commit()
    api.engine(conn)
    assert "61091000" not in cl._LEAF_CACHE, "stale leaf resolutions survived a reload"


def main() -> int:
    conn.close()
    shutil.rmtree(tmp, ignore_errors=True)
    width = max(len(n) for n, _, _ in _results)
    failed = 0
    for name, status, detail in _results:
        print(f"  {'ok  ' if status == 'pass' else 'FAIL'}  {name.ljust(width)}")
        if status != "pass":
            failed += 1
            print(f"        {detail.splitlines()[-1][:170]}")
    print(f"\n{len(_results) - failed}/{len(_results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
