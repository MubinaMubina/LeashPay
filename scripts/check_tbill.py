#!/usr/bin/env python3
"""Replay the sponsored T-bill deposit, withdrawal and payment on BSC testnet."""
import argparse
import json

from eth_abi import decode, encode
from eth_utils import keccak

from testnet import ROOT, Testnet, calldata, save

PROOF = ROOT / 'contracts/deployments/97-tbill.json'
STEPS = ('sweep', 'redeem', 'pay')
AMOUNT = 5 * 10**18  # All three transactions use the same amount of mUSDT.


def balances(net, manifest, vault, recipient, block):
    usdt, bill = manifest['usdt'], manifest['tbill']
    return {name: net.read(token, 'balanceOf(address)', ['address'], [holder], ['uint256'], block=block)[0]
            for name, token, holder in [('vaultUSDT', usdt, vault), ('vaultShares', bill, vault),
                                        ('billUSDT', usdt, bill), ('recipientUSDT', usdt, recipient)]}


def event_data(receipt, vault, signature, indexed_topics, types):
    topics = ['0x' + keccak(text=signature).hex(), *indexed_topics]
    events = [log for log in receipt['logs'] if log['address'].lower() == vault and log['topics'] == topics]
    if len(events) != 1:
        raise RuntimeError(f'Expected one {signature} event with matching topics')
    return decode(types, bytes.fromhex(events[0]['data'][2:]))


def verify(net, hashes):
    m = net.manifest()
    receipts = [net.receipt(hashes[step]) for step in STEPS]
    blocks = [int(r['blockNumber'], 16) for r in receipts]
    if not blocks[0] < blocks[1] < blocks[2]:
        raise RuntimeError('Expected separate sweep, redeem and pay blocks in that order')
    first = hex(blocks[0] - 1)
    vault, = net.read(m['factory'], 'vaultOf(address)', ['address'], [m['deployer']], ['address'], block=first)
    bill, = net.read(vault, 'tbill()', outputs=['address'], block=first)
    asset, = net.read(bill, 'asset()', outputs=['address'], block=first)
    if m['status'] != 'confirmed' or bill != m['tbill'].lower() or asset != m['usdt'].lower():
        raise RuntimeError('Unexpected vault treasury or underlying asset')
    recipient = m['reporter']  # The same controlled recipient as the initial sponsored payment.
    ref = keccak(text='LeashPay T-bill payout v1 ' + vault)
    pay_types = ['address', 'address', 'uint256', 'bytes32']
    calls = [calldata('sweepToTBill(uint256)', ['uint256'], [AMOUNT]),
             calldata('redeemFromTBill(uint256)', ['uint256'], [AMOUNT]),
             calldata('pay(address,address,uint256,bytes32)', pay_types, [recipient, asset, AMOUNT, ref])]
    proof = {'chainId': 97, 'vault': vault, 'agent': m['agent'], 'asset': asset, 'tbill': bill,
             'recipient': recipient, 'ref': '0x' + ref.hex(), 'amountUSDTBaseUnits': str(AMOUNT),
             'transactions': {}}
    previous = None
    minted = None
    for step, block, receipt, call in zip(STEPS, blocks, receipts, calls):
        tx = net.rpc('eth_getTransactionByHash', [hashes[step]])
        if (receipt['from'].lower() != m['agent'].lower() or receipt['to'].lower() != vault
                or int(receipt['effectiveGasPrice'], 16) != 0 or tx['input'] != call
                or int(tx['value'], 16) != 0 or tx['blockHash'] != receipt['blockHash']):
            raise RuntimeError(f'{step}: unexpected sender, vault, gas price or call')
        before, after = [balances(net, m, vault, recipient, hex(b)) for b in (block - 1, block)]
        if previous is not None and before != previous:
            raise RuntimeError(f'{step}: balances changed between transactions')
        if step == 'pay':
            indexed = ['0x' + encode(['address'], [addr]).hex() for addr in (recipient, asset)]
            amount, = event_data(receipt, vault, 'Paid(address,address,uint256,bytes32)',
                                 [*indexed, '0x' + ref.hex()], ['uint256'])
            delta = {'vaultUSDT': -AMOUNT, 'vaultShares': 0, 'billUSDT': 0, 'recipientUSDT': AMOUNT}
        else:
            sweep = step == 'sweep'
            signature = 'SweptToTBill(uint256,uint256)' if sweep else 'RedeemedFromTBill(uint256,uint256)'
            amount, shares = event_data(receipt, vault, signature, [], ['uint256', 'uint256'])
            if shares == 0 or (not sweep and shares != minted):
                raise RuntimeError(f'{step}: the round trip must mint and burn the same nonzero shares')
            if sweep:
                minted = shares
            direction = 1 if sweep else -1
            delta = {'vaultUSDT': -direction * AMOUNT, 'vaultShares': direction * shares,
                     'billUSDT': direction * AMOUNT, 'recipientUSDT': 0}
        if amount != AMOUNT or any(after[k] - before[k] != change for k, change in delta.items()):
            raise RuntimeError(f'{step}: event amount or balance changes disagree with the demo')
        proof['transactions'][step] = {'hash': hashes[step], 'block': block, 'effectiveGasPrice': '0',
                                       'before': {k: str(v) for k, v in before.items()},
                                       'after': {k: str(v) for k, v in after.items()}}
        previous = after
    return proof


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record', action='store_true', help='Save the proof from confirmed local journal receipts')
    args = parser.parse_args()
    existing = json.loads(PROOF.read_text()) if PROOF.exists() else None
    if existing is None and not args.record:
        parser.error('No recorded T-bill proof found')
    net = Testnet(roles=())
    if net.env.get('NODEREAL_API_KEY'):
        net.rpc_url = 'https://bsc-testnet.nodereal.io/v1/' + net.env['NODEREAL_API_KEY']
    if int(net.rpc('eth_chainId', []), 16) != 97:
        raise RuntimeError('BSC testnet chain 97 required')
    if existing is None:
        entries = [net.journal['transactions'].get('tbill-v1-' + step, {}) for step in STEPS]
        if any(entry.get('state') != 'confirmed' for entry in entries):
            raise RuntimeError('All three confirmed demo transactions are required')
        hashes = {step: entry['hash'] for step, entry in zip(STEPS, entries)}
    else:
        hashes = {step: existing['transactions'][step]['hash'] for step in STEPS}
    proof = verify(net, hashes)
    if existing is None:
        save(PROOF, proof)
    elif existing != proof:
        raise RuntimeError('Replayed proof differs from the recorded T-bill proof')
    print('Confirmed 5 mUSDT deposited, withdrawn and paid to the demo recipient. Agent gas price was zero.')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from None
