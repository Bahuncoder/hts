#!/usr/bin/env python3
"""Back up the accounts database.

`data/htsdesk.db` is a build artifact and can be rebuilt from public sources at
any time. `data/accounts.db` cannot: it holds every account, catalogue, watched
code and alert. It is the only file here whose loss is unrecoverable.

Uses SQLite's online backup API rather than copying the file. With WAL enabled
a plain copy taken mid-write can be torn, and a backup that will not open is
worse than none because it is trusted.
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
DEST = Path(os.environ.get("HTSDESK_BACKUP_DIR", "/var/backups/htsdesk"))
KEEP = int(os.environ.get("HTSDESK_BACKUP_KEEP", "30"))


def main() -> int:
    if not DB.exists():
        print(f"backup: no database at {DB}", file=sys.stderr)
        return 1

    DEST.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(DEST, 0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
    final = DEST / f"accounts-{stamp}.db.gz"

    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / "accounts.db"
        src = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        dst = sqlite3.connect(raw)
        try:
            src.backup(dst)          # consistent snapshot, even mid-write
        finally:
            dst.close()
            src.close()

        check = sqlite3.connect(raw)
        try:
            ok = check.execute("PRAGMA integrity_check").fetchone()[0]
            if ok != "ok":
                print(f"backup: integrity check failed ({ok})", file=sys.stderr)
                return 1
            accounts = check.execute("SELECT count(*) FROM account").fetchone()[0]
            catalogues = check.execute("SELECT count(*) FROM catalogue").fetchone()[0]
        finally:
            check.close()

        # Write compressed to a temp name, then rename: a reader must never see
        # a half-written backup and take it for a good one.
        part = final.with_suffix(".part")
        # Do not let the process umask decide who can read account backups.
        fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fout, open(raw, "rb") as fin:
            with gzip.GzipFile(fileobj=fout, mode="wb") as compressed:
                shutil.copyfileobj(fin, compressed)
        os.chmod(part, 0o600)
        part.replace(final)
        os.chmod(final, 0o600)

    rotate()
    size = final.stat().st_size / 1024
    print(f"backup: {final.name}  {accounts} accounts, {catalogues} catalogues, {size:.0f} KiB")
    return 0


def rotate() -> None:
    backups = sorted(DEST.glob("accounts-*.db.gz"), key=lambda p: p.name, reverse=True)
    for old in backups[KEEP:]:
        old.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
