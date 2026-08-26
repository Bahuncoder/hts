#!/usr/bin/env python3
"""Restore an accounts backup.

Deliberately manual and noisy: this overwrites live customer data. The file
being replaced is kept alongside, because a bad restore should not be the end
of it.
"""
from __future__ import annotations

import gzip
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

DB = Path(os.environ.get("HTSDESK_ACCOUNTS_DB", "/opt/htsdesk/data/accounts.db"))


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} <backup.db.gz>", file=sys.stderr)
        return 64
    src = Path(argv[1])
    if not src.exists():
        print(f"restore: no such backup {src}", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / "restore.db"
        with gzip.open(src, "rb") as fin, open(raw, "wb") as fout:
            shutil.copyfileobj(fin, fout)

        conn = sqlite3.connect(raw)
        try:
            if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                print("restore: backup is corrupt, refusing", file=sys.stderr)
                return 1
            accounts = conn.execute("SELECT count(*) FROM account").fetchone()[0]
        finally:
            conn.close()

        print(f"About to replace {DB} with {src} ({accounts} accounts).")
        if input("Type RESTORE to continue: ").strip() != "RESTORE":
            print("aborted")
            return 1

        if DB.exists():
            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
            shutil.copy2(DB, DB.with_name(f"{DB.name}.replaced-{stamp}"))

        DB.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(raw, DB)
        DB.chmod(0o600)
        # Stale WAL/SHM alongside a replaced database will corrupt it.
        for suffix in ("-wal", "-shm"):
            DB.with_name(DB.name + suffix).unlink(missing_ok=True)

    print(f"restored {accounts} accounts from {src}")
    print("restart the web app so it reopens the database")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
