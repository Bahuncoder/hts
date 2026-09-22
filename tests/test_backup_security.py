import gzip
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


class BackupSecurityTest(unittest.TestCase):
    def test_private_compressed_restorable_backup(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            source = root / "accounts.db"
            with sqlite3.connect(source) as db:
                db.executescript("CREATE TABLE account(id TEXT); CREATE TABLE catalogue(id TEXT); INSERT INTO account VALUES('fixture');")
            subprocess.run([sys.executable, "ops/backup-accounts.py"], check=True, env={
                **os.environ, "HTSDESK_ACCOUNTS_DB": str(source), "HTSDESK_BACKUP_DIR": str(root / "backups")}, capture_output=True)
            archive, = (root / "backups").glob("*.gz")
            self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
            self.assertEqual(archive.parent.stat().st_mode & 0o777, 0o700)
            restored = root / "restored.db"
            restored.write_bytes(gzip.decompress(archive.read_bytes()))
            with sqlite3.connect(restored) as db:
                self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(db.execute("SELECT id FROM account").fetchone()[0], "fixture")
