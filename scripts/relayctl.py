#!/usr/bin/env python3
"""Control the local Atlas reporter. Requires only the Python standard library."""
import argparse
import fcntl
import json
import re
import os
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.setup'


def running():
    # The kernel releases this lock even on crash or shutdown. A saved PID can be reused.
    with (LOCAL / 'atlas-worker.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False


def snapshot():
    path = LOCAL / 'atlas-worker-status.json'
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}


def describe():
    if not running():
        return 'Atlas stopped. Run make start to resume.'
    data = snapshot()
    checked = data.get('checkedAt')
    last = datetime.fromtimestamp(checked).astimezone().isoformat(timespec='seconds') if checked else 'pending'
    errors = ', '.join(data.get('errors', {}))
    state = data.get('state', 'starting')
    instance = data.get('instance', '')
    if re.fullmatch('[0-9a-f]{32}', instance) and (LOCAL / ('atlas-stop-' + instance)).exists():
        state = 'stopping'
    return (f"Atlas running · {state} · PID {data.get('pid', '?')} · "
            f"interval {data.get('intervalSeconds', '?')}s · last completed check {last}"
            + (f" · errors: {errors}" if errors else ''))


def start():
    if running():
        print(describe())
        return
    python = LOCAL / 'testnet-venv/bin/python'
    # Replace the controller so the terminal, output and signals stay attached.
    os.execv(python, [str(python), str(ROOT / 'scripts/atlas_worker.py')])


def stop():
    if not running():
        print('Atlas already stopped.')
        return
    # A stop request belongs to exactly one run. A stale status file can never kill another process.
    instance = snapshot().get('instance', '')
    if not re.fullmatch('[0-9a-f]{32}', instance):
        raise RuntimeError('Active worker has no control token. Check its startup or migrate the legacy worker.')
    (LOCAL / ('atlas-stop-' + instance)).touch(mode=0o600)
    for _ in range(150):
        if not running():
            print('Atlas stopped.')
            return
        time.sleep(0.1)
    raise RuntimeError('Stop requested. Atlas is finishing its current operation. Use make status before restarting.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'stop', 'status'])
    action = parser.parse_args().action
    LOCAL.mkdir(parents=True, exist_ok=True)
    if action == 'status':
        print(describe())
        return
    if action == 'start':
        start()
        return
    with (LOCAL / 'atlas-control.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        stop()


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, ValueError) as exc:
        raise SystemExit(str(exc)) from None
