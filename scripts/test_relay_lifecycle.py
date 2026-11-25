"""Exercise the real controller/worker processes with an offline price source."""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
FAKE_NETWORK = '''
from pathlib import Path
import json
LOCAL = Path(__file__).resolve().parents[1] / '.setup'
def save(path, data):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data))
    tmp.replace(path)
class Testnet:
    def __init__(self, roles):
        assert roles == ('REPORTER',)
        self.session = self
    def close(self):
        pass
    def relay_cycle(self):
        if (LOCAL / 'offline').exists():
            raise RuntimeError('test RPC is offline')
        return {'USDT': {}, 'USDC': {}}, {}
'''


class WorkerLifecycleTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.local = self.root / '.setup'
        (self.local / 'testnet-venv/bin').mkdir(parents=True)
        (self.local / 'testnet-venv/bin/python').symlink_to(sys.executable)
        scripts = self.root / 'scripts'
        scripts.mkdir()
        for file in ('atlas_worker.py', 'relayctl.py'):
            shutil.copy2(SCRIPTS / file, scripts / file)
        (scripts / 'testnet.py').write_text(FAKE_NETWORK)
        self.controller = [sys.executable, str(scripts / 'relayctl.py')]
        self.addCleanup(self.control, 'stop')

    def control(self, action):
        return subprocess.check_output(self.controller + [action], text=True, timeout=22)

    def status(self):
        return json.loads((self.local / 'atlas-worker-status.json').read_text())

    def wait_state(self, expected):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            if self.status()['state'] == expected:
                return self.status()
            time.sleep(0.05)
        self.fail(f'Worker never reached {expected}')

    def test_double_start_manual_stop_and_restart(self):
        self.control('start')
        first = self.wait_state('healthy')
        self.assertEqual(first['intervalSeconds'], 60)
        self.assertNotIn('stopAt', first)
        self.control('start')
        self.assertEqual(self.status()['instance'], first['instance'])
        self.control('stop')
        self.assertIn('stopped', self.control('status'))
        self.assertIn('already stopped', self.control('stop'))
        self.control('start')
        self.assertNotEqual(self.wait_state('healthy')['instance'], first['instance'])

    def test_restart_after_abrupt_exit_ignores_stale_state_and_stop(self):
        (self.local / 'offline').touch()
        self.control('start')
        old = self.wait_state('degraded')
        os.kill(old['pid'], signal.SIGKILL)  # This temporary worker simulates power loss.
        end = time.monotonic() + 5
        while 'stopped' not in self.control('status') and time.monotonic() < end:
            time.sleep(.05)
        self.assertIn('stopped', self.control('status'))
        (self.local / ('atlas-stop-' + old['instance'])).touch()
        (self.local / 'offline').unlink()
        self.control('start')
        self.assertNotEqual(self.wait_state('healthy')['instance'], old['instance'])
