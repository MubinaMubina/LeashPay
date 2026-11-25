#!/usr/bin/env python3
"""Replay the Atlas swap proof, or submit the initial 1 mUSDT demo swap with --send."""
import argparse
import json

from eth_abi import decode
from eth_utils import keccak

from testnet import ROOT, RULES_TYPE, Testnet, calldata, save

PROOF = ROOT / 'contracts/deployments/97-atlas-swap.json'
UNIT = 10**18
PAIR_TYPES = ['address', 'address', 'uint256']


def proof_at_block(net, manifest, vault, receipt):
    block = receipt['blockNumber']
    agent = manifest['agent']
    usdt, usdc = manifest['usdt'], manifest['usdc']
    if (receipt['from'].lower() != agent.lower() or receipt['to'].lower() != vault.lower()
            or int(receipt['effectiveGasPrice'], 16) != 0):
        raise RuntimeError('Unexpected transaction sender, vault or gas price')
    prices = [net.read(vault, 'getPrice(address)', ['address'], [token], ['uint256', 'uint256'], block=block)
              for token in (usdt, usdc)]
    rules, = net.read(vault, 'rules()', outputs=[RULES_TYPE], block=block)
    slippage = rules[3]
    if slippage > 200:
        raise RuntimeError('Unexpected slippage limit')
    minimum = (UNIT * prices[0][0] // prices[1][0]) * (10000 - slippage) // 10000

    topic = '0x' + keccak(text='Swapped(address,address,uint256,uint256,uint256)').hex()
    events = [log for log in receipt['logs'] if log['address'].lower() == vault.lower() and log['topics'][0] == topic]
    if len(events) != 1 or [int(x, 16) for x in events[0]['topics'][1:]] != [int(usdt, 16), int(usdc, 16)]:
        raise RuntimeError('Expected one Swapped event for the demo pair')
    amount_in, amount_out, event_min = decode(['uint256'] * 3, bytes.fromhex(events[0]['data'][2:]))
    if amount_in != UNIT or event_min != minimum or amount_out < minimum:
        raise RuntimeError('Swap amounts disagree with the Atlas minimum')

    deltas = []
    for token in (usdt, usdc):
        before, after = [net.read(token, 'balanceOf(address)', ['address'], [vault], ['uint256'], block=at)[0]
                         for at in (hex(int(block, 16) - 1), block)]
        deltas.append(after - before)
    if deltas != [-amount_in, amount_out]:
        raise RuntimeError('Vault balance changes disagree with the Swapped event')

    # eth_simulateV1 applies both calls on one disposable copy of this block.
    poor_rate = 9 * UNIT // 10
    calls = [
        {'from': manifest['deployer'], 'to': manifest['dex'],
         'data': calldata('setRate(address,address,uint256)', PAIR_TYPES, [usdt, usdc, poor_rate])},
        {'from': agent, 'to': vault,
         'data': calldata('swap(address,address,uint256)', PAIR_TYPES, [usdt, usdc, UNIT])},
    ]
    sim, = net.rpc('eth_simulateV1', [{'blockStateCalls': [{'calls': calls}], 'validation': False}, block])
    rate_call, swap_call = sim['calls']
    expected = calldata('SlippageTooHigh(uint256,uint256)', ['uint256'] * 2, [minimum, poor_rate])
    if (rate_call['status'] != '0x1' or swap_call['status'] != '0x0'
            or swap_call.get('error', {}).get('data') != expected):
        raise RuntimeError('Bad quote did not produce the exact expected SlippageTooHigh error')

    return {'chainId': 97, 'vault': vault, 'agent': agent, 'transactionHash': receipt['transactionHash'],
            'block': int(block, 16), 'effectiveGasPrice': '0', 'tokenIn': usdt, 'tokenOut': usdc,
            'priceIn': str(prices[0][0]), 'priceInUpdatedAt': prices[0][1],
            'priceOut': str(prices[1][0]), 'priceOutUpdatedAt': prices[1][1], 'maxSlippageBps': slippage,
            'amountIn': str(amount_in), 'amountOut': str(amount_out), 'minAmountOut': str(minimum),
            'vaultBalanceDeltas': list(map(str, deltas)), 'badQuoteSimulation': {
                'method': 'eth_simulateV1', 'quotedOut': str(poor_rate), 'error': 'SlippageTooHigh',
                'revertData': expected}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--send', action='store_true', help='Send only if no published proof exists')
    args = parser.parse_args()
    existing = json.loads(PROOF.read_text()) if PROOF.exists() else None
    if not existing and not args.send:
        parser.error('No receipt recorded yet. Pass --send for the initial testnet swap.')
    net = Testnet(roles=('AGENT',) if existing is None else ())
    manifest = net.manifest()
    vault, = net.read(manifest['factory'], 'vaultOf(address)', ['address'], [manifest['deployer']], ['address'])
    if existing:
        receipt = net.receipt(existing['transactionHash'])
    else:
        data = calldata('swap(address,address,uint256)', PAIR_TYPES, [manifest['usdt'], manifest['usdc'], UNIT])
        receipt = net.send('atlas-demo-swap-v1', 'AGENT', vault, data, sponsored=True)
    if net.env.get('NODEREAL_API_KEY'):
        net.rpc_url = 'https://bsc-testnet.nodereal.io/v1/' + net.env['NODEREAL_API_KEY']
    if int(net.rpc('eth_chainId', []), 16) != 97:
        raise RuntimeError('Historical verification requires chain 97')
    proof = proof_at_block(net, manifest, vault, receipt)
    if existing and proof != existing:
        raise RuntimeError('Replayed proof differs from the recorded proof')
    if not existing:
        save(PROOF, proof)
    print('Confirmed swap and simulated refusal:', proof['transactionHash'], flush=True)


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from None
