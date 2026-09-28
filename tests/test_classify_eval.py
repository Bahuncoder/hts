"""The evaluation must not let a ruling vote for itself.

Filtering the answer out of the results after retrieval leaves its influence
on every score; exclusion has to happen before scoring. Uses a tiny in-memory
database, so it runs anywhere.
"""
from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.classify import classify, retrieve
from store.db import connect, init, rebuild_hts_index, rebuild_ruling_index

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


def fixture():
    conn = connect(":memory:")
    init(conn)
    for code, desc in (("6109.10.00.12", "T-shirts, of cotton"),
                       ("4202.92.30.31", "Backpacks with outer surface of textile")):
        conn.execute(
            "INSERT INTO hts(hts,digits,indent,description,full_path,is_leaf,chapter) "
            "VALUES(?,?,0,?,?,1,?)", (code, code.replace(".", ""), desc, desc, code[:4]))
    subject = "knitted cotton short sleeve t-shirt with printed logo"
    rows = [("A1", subject, ["6109.10.00.12"]),
            ("A2", subject, ["6109.10.00.12"]),          # same-subject sibling
            ("B1", "nylon backpack with zipper closure", ["4202.92.30.31"])]
    for num, subj, tariffs in rows:
        conn.execute("INSERT INTO ruling(ruling_number,subject,body,tariffs,revoked) "
                     "VALUES(?,?,?,?,0)", (num, subj, subj, json.dumps(tariffs)))
    rebuild_hts_index(conn)
    rebuild_ruling_index(conn)
    conn.commit()
    return conn, subject


@check("an excluded ruling contributes no votes and no evidence")
def _():
    conn, subject = fixture()
    plain = retrieve(conn, subject, limit=3)
    assert plain and plain[0].hts.startswith("6109"), plain
    assert {r["ruling"] for r in plain[0].rulings} >= {"A1"}, plain[0].rulings

    held = retrieve(conn, subject, limit=3, exclude_rulings=frozenset({"A1", "A2"}))
    cited = {r["ruling"] for c in held for r in c.rulings}
    assert not cited & {"A1", "A2"}, f"an excluded ruling still appears: {cited}"
    # With its evidence gone the heading must lose its precedent support.
    for c in held:
        if c.hts.startswith("6109"):
            assert c.ruling_support == 0, c


@check("excluding only the ruling itself still lets its sibling vote (why families are excluded)")
def _():
    conn, subject = fixture()
    only_self = retrieve(conn, subject, limit=3, exclude_rulings=frozenset({"A1"}))
    assert only_self[0].hts.startswith("6109") and only_self[0].ruling_support >= 1, only_self


@check("reasoning is opt-in: the default never calls the model, even when a key is in the environment")
def _():
    import os
    import core.classify as cl
    conn, subject = fixture()
    called = []
    original = cl._reason
    cl._reason = lambda *a, **k: called.append(1) or ([], [])
    os.environ["ANTHROPIC_API_KEY"] = "sk-test"
    try:
        res = classify(conn, subject, limit=3)
        assert not called and not res.reasoned, "the default path ran the paid model"
        res = classify(conn, subject, limit=3, use_reasoning=False)
        assert not called and not res.reasoned, "an explicit False ran the paid model"
        classify(conn, subject, limit=3, use_reasoning=True)
        assert called, "an explicit True should reach the model when a key is set"
    finally:
        cl._reason = original
        os.environ.pop("ANTHROPIC_API_KEY", None)


def main() -> int:
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
