#!/usr/bin/env python3
"""Poll both Atlas feeds locally and update the BSC testnet mirrors as needed."""
import argparse
import fcntl
import os
import signal
import time
from datetime import datetime
from threading import Event

from testnet import LOCAL, Testnet, save


def deadline(value):
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        raise argparse.ArgumentTypeError('Include a UTC offset in --until')
    return dt.timestamp()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--interval', type=int, default=300, help='Seconds between cycles (default 300)')
    parser.add_argument('--until', type=deadline, help='Optional stop time with a UTC offset')
    args = parser.parse_args()
    if args.interval < 10:
        parser.error('Use a polling interval of at least 10 seconds')
    stop = Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())

    LOCAL.mkdir(parents=True, exist_ok=True)
    with (LOCAL / 'atlas-worker.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('An Atlas worker is already running here')
        status_path = LOCAL / 'atlas-worker-status.json'
        status = {'pid': os.getpid(), 'intervalSeconds': args.interval, 'stopAt': args.until, 'cycles': 0}
        while not stop.is_set() and (args.until is None or time.time() < args.until):
            status.update(state='checking', startedAt=int(time.time()))
            save(status_path, status)
            try:
                client = Testnet(roles=('REPORTER',))
                try:
                    feeds, errors = client.relay_cycle()
                finally:
                    client.session.close()
            except RuntimeError as exc:
                feeds, errors = {}, {'rpc': str(exc)}
            status.update(feeds=feeds, errors=errors, state='degraded' if errors else 'healthy',
                          checkedAt=int(time.time()), cycles=status['cycles'] + 1)
            save(status_path, status)
            print(f"Atlas cycle {status['cycles']}: {status['state']}, verified {', '.join(feeds)}", flush=True)
            delay = min(60, args.interval) if errors else args.interval
            if args.until is not None:
                delay = min(delay, max(0, args.until - time.time()))
            stop.wait(delay)
        status.update(state='stopped', stoppedAt=int(time.time()))
        save(status_path, status)


if __name__ == '__main__':
    main()
