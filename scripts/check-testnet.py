#!/usr/bin/env python3
"""Read-only verification of the sponsored payment and on-chain refusals."""
import argparse
import json

from eth_abi import decode, encode
from eth_utils import keccak

from testnet import ROOT, Testnet, calldata, save


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--nodereal', action='store_true', help='Use NodeReal instead of the public RPC for historical state')
    args = parser.parse_args()
    t = Testnet()
    if args.nodereal:
        t.rpc_url = 'https://bsc-testnet.nodereal.io/v1/' + t.env['NODEREAL_API_KEY']
        if int(t.rpc('eth_chainId', []), 16) != 97:
            raise RuntimeError('BSC testnet chain 97 required')
    m = t.manifest()
    proof = json.loads((ROOT / 'contracts/deployments/97-smoke.json').read_text())
    vault, recipient, token = proof['vault'], proof['recipient'], proof['token']
    agent = t.accounts['AGENT'].address
    ref = bytes.fromhex(proof['ref'][2:])
    amount = int(proof['amount'])
    receipt = t.receipt(proof['transactionHash'])
    block = int(receipt['blockNumber'], 16)
    if receipt['from'].lower() != agent.lower() or receipt['to'].lower() != vault.lower():
        raise RuntimeError('Unexpected payment sender or target')
    if token.lower() != m['usdt'].lower() or int(receipt['effectiveGasPrice'], 16) != 0:
        raise RuntimeError('Unexpected token or nonzero gas price')
    event_topic = '0x' + keccak(text='Paid(address,address,uint256,bytes32)').hex()
    logs = [log for log in receipt['logs'] if log['address'].lower() == vault.lower()
            and log['topics'] and log['topics'][0].lower() == event_topic.lower()]
    expected_topics = [event_topic, '0x' + encode(['address'], [recipient]).hex(),
                       '0x' + encode(['address'], [token]).hex(), proof['ref']]
    if len(logs) != 1 or [s.lower() for s in logs[0]['topics']] != [s.lower() for s in expected_topics]:
        raise RuntimeError('Paid event topics mismatch')
    if decode(['uint256'], bytes.fromhex(logs[0]['data'][2:]))[0] != amount:
        raise RuntimeError('Paid event amount mismatch')
    balances = [t.read(token, 'balanceOf(address)', ['address'], [recipient], ['uint256'], block=hex(b))[0]
                for b in (block - 1, block)]
    gas_balances = [int(t.rpc('eth_getBalance', [agent, hex(b)]), 16) for b in (block - 1, block)]
    if balances[1] - balances[0] != amount or gas_balances[0] != gas_balances[1]:
        raise RuntimeError('Recipient transfer or free gas not proven')

    # Simulate at a fixed recent block; these requests cannot broadcast a transaction.
    check_block = t.rpc('eth_blockNumber', [])
    unknown = '0x000000000000000000000000000000000000bAd0'
    cases = [
        ('duplicatePayment', recipient, ref, 'DuplicatePayment(bytes32,address)', ['bytes32', 'address'], [ref, recipient]),
        ('unauthorizedRecipient', unknown, keccak(text='LeashPay unknown recipient simulation'),
         'RecipientNotAllowed(address)', ['address'], [unknown]),
    ]
    refusals = {}
    for name, target, payment_ref, error, error_types, error_values in cases:
        data = calldata('pay(address,address,uint256,bytes32)', ['address', 'address', 'uint256', 'bytes32'],
                        [target, token, amount, payment_ref])
        expected = calldata(error, error_types, error_values)
        try:
            t.rpc('eth_call', [{'from': agent, 'to': vault, 'data': data}, check_block])
        except RuntimeError as exc:
            try:
                response = json.loads(str(exc).split(': ', 1)[1])
            except (ValueError, IndexError):
                raise RuntimeError('Simulation failed without structured revert data: ' + name) from None
            if str(response.get('data', '')).lower() != expected.lower():
                raise RuntimeError('Unexpected revert data: ' + name) from None
            refusals[name] = {'error': error, 'revertData': expected}
        else:
            raise RuntimeError('Forbidden payment simulation unexpectedly succeeded: ' + name)
    evidence = {'chainId': 97, 'transactionHash': proof['transactionHash'], 'vault': vault,
                'paidEventVerified': True, 'recipientBalanceDelta': str(balances[1] - balances[0]),
                'agentBNBBefore': str(gas_balances[0]), 'agentBNBAfter': str(gas_balances[1]),
                'effectiveGasPrice': '0', 'simulationBlock': int(check_block, 16), 'refusals': refusals}
    save(ROOT / 'contracts/deployments/97-checks.json', evidence)
    print('Confirmed payment, exact Paid event, zero agent gas cost, DuplicatePayment and RecipientNotAllowed.')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from None
