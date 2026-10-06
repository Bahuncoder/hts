import asyncio
import gzip
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from core import classify as classifier  # noqa: E402
from ingest import fedreg  # noqa: E402

spec = importlib.util.spec_from_file_location('restore', ROOT / 'ops' / 'restore-accounts.py')
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


class RemainingSecurity(unittest.TestCase):
    def test_expired_reasoning_never_calls_provider(self):
        with patch('httpx.stream') as stream:
            with self.assertRaises(TimeoutError):
                classifier._reason('goods', [], 'test', deadline=time.monotonic()-1)
            stream.assert_not_called()

    def test_reasoning_phase_timeout_tracks_remaining_budget(self):
        response = httpx.Response(200, json={'content': [{'text': '{"ranked": []}'}]}, request=httpx.Request('POST', 'https://test'))
        with patch('httpx.stream') as stream:
            stream.return_value.__enter__.return_value = response
            classifier._reason('goods', [], 'test', deadline=time.monotonic()+2)
            self.assertLessEqual(stream.call_args.kwargs['timeout'], .5)
            self.assertGreater(stream.call_args.kwargs['timeout'], 0)

    def test_reasoning_enforces_total_deadline_during_stream(self):
        response = httpx.Response(200, content=b'{}', request=httpx.Request('POST', 'https://test'))
        with patch('httpx.stream') as stream, patch.object(classifier.time, 'monotonic', side_effect=[0, 0, 10]):
            stream.return_value.__enter__.return_value = response
            with self.assertRaises(TimeoutError):
                classifier._reason('goods', [], 'test', deadline=1)

    def test_restore_keeps_consistent_private_previous_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            live, incoming = root/'live.db', root/'incoming.db'
            for dbpath, value in [(live, 'old'), (incoming, 'restored')]:
                with sqlite3.connect(dbpath) as db:
                    db.execute('CREATE TABLE account(id)')
                    db.execute('INSERT INTO account VALUES(?)', (value,))
            archive = root/'backup.gz'
            archive.write_bytes(gzip.compress(incoming.read_bytes()))
            inode = live.stat().st_ino
            with patch.object(restore, 'DB', live), patch.object(restore, 'require_offline') as offline, patch('builtins.input', return_value='RESTORE'):
                self.assertEqual(restore.main(['restore', str(archive)]), 0)
                offline.assert_called_once_with(live)
            self.assertEqual(live.stat().st_ino, inode)
            with sqlite3.connect(live) as db:
                self.assertEqual(db.execute('SELECT id FROM account').fetchone()[0], 'restored')
            previous, = root.glob('live.db.replaced-*')
            self.assertEqual(previous.stat().st_mode & 0o777, 0o600)
            with sqlite3.connect(previous) as db:
                self.assertEqual(db.execute('SELECT id FROM account').fetchone()[0], 'old')

    def test_fetch_rejects_redirect_before_private_request(self):
        seen = []
        def handler(request):
            seen.append(str(request.url))
            return httpx.Response(302, headers={'location': 'http://127.0.0.1/secret'})
        async def run():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                self.assertIsNone(await fedreg.fetch_text(client, 'https://www.federalregister.gov/text'))
        asyncio.run(run())
        self.assertEqual(len(seen), 1)

    def test_fetch_valid_text_and_size_limit(self):
        async def run():
            for body, expected in [(b'6109.10.00.12', '6109.10.00.12'), (b'x'*65, None)]:
                async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=body))) as client:
                    with patch.object(fedreg, 'MAX_TEXT_BYTES', 64):
                        self.assertEqual(await fedreg.fetch_text(client, 'https://www.govinfo.gov/text'), expected)
        asyncio.run(run())

    def test_url_policy(self):
        for url in ['http://www.govinfo.gov/x', 'https://www.govinfo.gov.evil.test/x', 'https://user@www.govinfo.gov/x', 'https://www.govinfo.gov:444/x', 'https://127.0.0.1/x']:
            self.assertFalse(fedreg.permitted_text_url(url), url)

    def test_restore_refuses_open_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp)/'accounts.db'
            child = subprocess.Popen([sys.executable, '-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("CREATE TABLE account(id)"); print("ready",flush=True); sys.stdin.read()', str(db)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(), 'ready')
                original = Path.iterdir
                def visible_processes(path):
                    return iter([Path('/proc')/str(child.pid)]) if path == Path('/proc') else original(path)
                with patch.object(Path, 'iterdir', visible_processes), self.assertRaisesRegex(RuntimeError, 'open by PID'):
                    restore.require_offline(db)
            finally:
                child.communicate('stop', timeout=5)

    def test_snapshot_includes_committed_wal_and_is_private(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, dest = Path(tmp)/'live.db', Path(tmp)/'snapshot.db'
            with sqlite3.connect(source) as db:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE account(id)')
                db.execute("INSERT INTO account VALUES('committed')")
                db.commit()
                restore.snapshot(source, dest)
            with sqlite3.connect(dest) as db:
                self.assertEqual(db.execute('SELECT id FROM account').fetchone()[0], 'committed')
            self.assertEqual(dest.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
