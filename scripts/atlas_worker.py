#!/usr/bin/env python3
"""Mirror the Atlas feeds on BSC testnet until a manual stop."""
import argparse
import fcntl
import logging
import os
import signal
import time
import uuid
from threading import Event

from testnet import LOCAL, Testnet, save


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--interval', type=int, default=60, help='Seconds between cycles (default 60)')
    args = parser.parse_args()
    if args.interval < 10:
        parser.error('Use a polling interval of at least 10 seconds')

    stop = Event()
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, lambda *_: stop.set())
    LOCAL.mkdir(parents=True, exist_ok=True)
    with (LOCAL / 'atlas-worker.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Atlas already running. Use make status to see the active instance.', flush=True)
            return
        logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s',
                            handlers=[logging.StreamHandler(), logging.FileHandler(LOCAL / 'atlas-worker.log')])
        logging.info('Atlas running in this terminal. Press Ctrl-C or use make stop from another terminal.')
        instance = uuid.uuid4().hex
        stop_file = LOCAL / ('atlas-stop-' + instance)
        status_path = LOCAL / 'atlas-worker-status.json'
        status = {'pid': os.getpid(), 'instance': instance, 'intervalSeconds': args.interval, 'cycles': 0}
        try:
            while not stop.is_set() and not stop_file.exists():
                started = time.monotonic()
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
                except (KeyError, ValueError, OSError) as exc:
                    # Malformed values may be credentials. Report the type, never the value.
                    feeds, errors = {}, {'configuration': f'Check .env and the deployment files ({type(exc).__name__})'}
                status.update(feeds=feeds, errors=errors, state='degraded' if errors else 'healthy',
                              checkedAt=int(time.time()), cycles=status['cycles'] + 1)
                save(status_path, status)
                logging.info("Atlas cycle %d: %s, verified %s", status['cycles'], status['state'], ', '.join(feeds))
                next_poll = started + args.interval
                while not stop.is_set() and not stop_file.exists():
                    remaining = next_poll - time.monotonic()
                    if remaining <= 0:
                        break
                    stop.wait(min(remaining, 0.5))
        finally:
            status.update(state='stopped', stoppedAt=int(time.time()))
            save(status_path, status)
            stop_file.unlink(missing_ok=True)
            logging.info('Atlas stopped.')


if __name__ == '__main__':
    main()
