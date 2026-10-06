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


def require_offline(db: Path) -> None:
    """Refuse a restore while a process has the database or its journal open."""
    targets = {str(db.resolve()) + suffix for suffix in ("", "-wal", "-shm", "-journal")}
    proc = Path("/proc")
    if not proc.is_dir():
        raise RuntimeError("offline detection requires Linux /proc")
    for process in proc.iterdir():
        if not process.name.isdigit() or int(process.name) == os.getpid():
            continue
        try:
            descriptors = list((process / "fd").iterdir())
        except FileNotFoundError:
            continue
        except PermissionError:
            raise RuntimeError("cannot inspect process descriptors; run restore as root")
        for descriptor in descriptors:
            try:
                target = os.readlink(descriptor).removesuffix(" (deleted)")
            except FileNotFoundError:
                continue
            if target in targets:
                raise RuntimeError(f"database is open by PID {process.name}; stop the web app first")


def snapshot(source: Path, destination: Path) -> None:
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    dst = sqlite3.connect(destination)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()


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

        try:
            require_offline(DB)
        except RuntimeError as exc:
            print(f"restore: {exc}", file=sys.stderr)
            return 1

        if DB.exists():
            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
            snapshot(DB, DB.with_name(f"{DB.name}.replaced-{stamp}"))

        DB.parent.mkdir(parents=True, exist_ok=True)
        # SQLite's backup API replaces contents consistently without swapping
        # the inode or manually deleting journals. A late opener therefore
        # cannot retain a detached old database file.
        fd = os.open(DB, os.O_WRONLY | os.O_CREAT, 0o600)
        os.close(fd)
        DB.chmod(0o600)
        src_db = sqlite3.connect(raw)
        dst_db = sqlite3.connect(DB, timeout=5)
        try:
            src_db.backup(dst_db)
        finally:
            dst_db.close()
            src_db.close()

    print(f"restored {accounts} accounts from {src}")
    print("restart the web app so it reopens the database")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
