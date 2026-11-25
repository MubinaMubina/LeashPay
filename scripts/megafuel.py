#!/usr/bin/env python3
"""Read the demo sponsor policy or extend only its end time (BSC testnet)."""
import argparse
import os
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]
BANGKOK = ZoneInfo('Asia/Bangkok')


def deadline(value):
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        raise argparse.ArgumentTypeError('Use YYYY-MM-DDTHH:MM:SS+07:00') from None
    if dt.utcoffset() is None or dt.microsecond:
        raise argparse.ArgumentTypeError('Include a UTC offset and use whole seconds')
    return int(dt.timestamp())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--until', type=deadline, help='Extend to this date and time with an explicit UTC offset')
    args = parser.parse_args()
    config = dotenv_values(ROOT / '.env')
    key = config.get('NODEREAL_API_KEY') or os.environ.get('NODEREAL_API_KEY')
    policy_id = config.get('MEGAFUEL_POLICY_ID') or os.environ.get('MEGAFUEL_POLICY_ID')
    if not key or not policy_id:
        parser.exit(1, 'Set NODEREAL_API_KEY and MEGAFUEL_POLICY_ID in the local .env.\n')

    def rpc(method, params):
        try:
            response = requests.post(f'https://open-platform-ap.nodereal.io/{key}/megafuel-testnet',
                                     json={'id': 1, 'jsonrpc': '2.0', 'method': method, 'params': params},
                                     timeout=20, allow_redirects=False)
            response.raise_for_status()
            data = response.json()
        except (ValueError, requests.RequestException) as exc:
            raise RuntimeError(f'{method} failed ({type(exc).__name__}). Run make megafuel-status to recheck.') from None
        if not isinstance(data, dict) or 'error' in data or 'result' not in data:
            info = data.get('error') if isinstance(data, dict) else None
            code = info.get('code') if isinstance(info, dict) else 'unknown'
            raise RuntimeError(f'{method} failed (RPC code {code}). Check the policy in the NodeReal dashboard.')
        return data['result']

    def read():
        policy = rpc('pm_getPolicyByUuid', [policy_id])
        if not isinstance(policy, dict) or policy.get('uuid') != policy_id or policy.get('network') != 97:
            raise RuntimeError('Expected the configured BSC testnet policy on chain 97')
        return policy

    policy = read()
    if args.until is not None:
        if args.until <= datetime.now().timestamp() or args.until < int(policy['end']):
            parser.error('The end must be in the future and must not shorten the policy')
        if args.until != int(policy['end']):
            rpc('pm_updatePolicy', [{'uuid': policy_id, 'end': args.until}])
            updated = read()
            if int(updated['end']) != args.until:
                raise RuntimeError('NodeReal has not confirmed the new end time. Run make megafuel-status.')
            fields = ('start', 'activated', 'type', 'fromWhitelistEnabled', 'maxGasCost', 'maxGasCostPerAddr',
                      'maxGasCostPerAddrPerDay', 'maxTxCountPerAddrPerDay', 'fundingFromAddress')
            if any(updated.get(field) != policy.get(field) for field in fields):
                raise RuntimeError('End time updated, but another policy setting changed. Review the dashboard.')
            policy = updated
    print(f"Policy: {policy['name']} · BSC testnet (97)")
    print('End (Bangkok):', datetime.fromtimestamp(int(policy['end']), BANGKOK).isoformat())
    enabled = policy['activated'] and int(policy['start']) <= datetime.now().timestamp() < int(policy['end'])
    print('Enabled and within dates:', 'yes' if enabled else 'no')
    print('Remaining sponsor credit:', Decimal(policy['remainingBalance']) / Decimal(10**18), 'tBNB')
    print('Registered funding wallet:', policy.get('fundingFromAddress') or 'not configured')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from None
