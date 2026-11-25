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
        shutil.copy2(SCRIPTS.parent / 'Makefile', self.root / 'Makefile')
        (scripts / 'requirements-testnet.txt').touch()
        (self.local / 'testnet-venv/.requirements-installed').touch()
        self.addCleanup(self.control, 'stop')

    def control(self, action):
        return subprocess.check_output(['make', action], cwd=self.root, text=True, timeout=8)

    def start(self, expected='healthy'):
        path = self.local / 'atlas-worker-status.json'
        previous = json.loads(path.read_text())['instance'] if path.exists() else None
        proc = subprocess.Popen(['make', 'start'], cwd=self.root, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True)
        # addCleanup is LIFO: request stop, then collect the foreground command.
        self.addCleanup(proc.communicate, timeout=8)
        self.addCleanup(self.control, 'stop')
        end = time.monotonic() + 5
        while time.monotonic() < end and proc.poll() is None:
            data = json.loads(path.read_text()) if path.exists() else {}
            if data.get('state') == expected and data['instance'] != previous:
                return proc, data
            time.sleep(0.05)
        self.fail(f'make start should stay attached and reach {expected}')

    def test_double_start_manual_stop_and_restart(self):
        proc, first = self.start()
        self.assertEqual(first['intervalSeconds'], 60)
        self.assertNotIn('stopAt', first)
        self.assertIn('running', self.control('start'))
        self.assertIn(str(first['pid']), self.control('status'))
        self.control('stop')
        output, _ = proc.communicate(timeout=5)
        self.assertEqual(proc.returncode, 0)
        self.assertIn('healthy, verified USDT, USDC', output)
        self.assertIn('Atlas stopped.', output)
        self.assertIn('healthy, verified USDT, USDC', self.control('logs'))
        self.assertIn('already stopped', self.control('stop'))
        _, second = self.start()
        self.assertNotEqual(second['instance'], first['instance'])

    def test_keyboard_interrupt_and_terminal_hangup_stop_worker(self):
        for sig in (signal.SIGINT, signal.SIGHUP):
            with self.subTest(sig=sig):
                proc, status = self.start()
                os.kill(status['pid'], sig)
                self.assertEqual(proc.wait(timeout=5), 0)
                self.assertIn('stopped', self.control('status'))

    def test_restart_after_abrupt_exit_ignores_stale_state_and_stop(self):
        (self.local / 'offline').touch()
        proc, old = self.start('degraded')
        os.kill(old['pid'], signal.SIGKILL)  # This temporary worker simulates power loss.
        self.assertNotEqual(proc.wait(timeout=5), 0)
        self.assertIn('stopped', self.control('status'))
        (self.local / ('atlas-stop-' + old['instance'])).touch()
        (self.local / 'offline').unlink()
        _, current = self.start()
        self.assertNotEqual(current['instance'], old['instance'])
