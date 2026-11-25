"""Send or verify the three sponsored payouts on BSC testnet."""
import argparse
import fcntl
import json
from decimal import Decimal

from eth_abi import encode
from eth_utils import keccak

from check_tbill import event_data
from seed_demo import PAY_TYPES, ROSTER, UNIT, check_budget, demo_vault
from testnet import LOCAL, Testnet, calldata

PAY = 'pay(address,address,uint256,bytes32)'


def verify_delivery(net, receipt, vault, agent, token, person, ref, *, show=True):
    if (receipt['status'] != '0x1' or receipt['from'].lower() != agent.lower()
            or receipt['to'].lower() != vault.lower() or int(receipt['effectiveGasPrice'], 16) != 0):
        raise RuntimeError('Unexpected payroll receipt status, sender, vault or gas price')
    address = person['address']
    recipient_topic, token_topic, vault_topic = [
        '0x' + encode(['address'], [a]).hex() for a in (address, token, vault)]
    paid, = event_data(receipt, vault.lower(), 'Paid(address,address,uint256,bytes32)',
                       [recipient_topic, token_topic, '0x' + ref.hex()], ['uint256'])
    transferred, = event_data(receipt, token.lower(), 'Transfer(address,address,uint256)',
                              [vault_topic, recipient_topic], ['uint256'])
    block = int(receipt['blockNumber'], 16)
    before, after = [net.read(token, 'balanceOf(address)', ['address'], [address],
                              ['uint256'], block=hex(b))[0] for b in (block - 1, block)]
    if paid != UNIT or transferred != UNIT or after - before != UNIT:
        raise RuntimeError(f"{person['name']}: expected both events and a balance increase of 1 mUSDT")
    if show:
        print(f"{person['name']}: {Decimal(before) / UNIT} -> {Decimal(after) / UNIT} mUSDT "
              f"(+1), https://testnet.bscscan.com/tx/{receipt['transactionHash']}", flush=True)
    return before, after


def payroll(net, roster, get_signer):
    manifest, vault = demo_vault(net, roster, net.rpc('eth_blockNumber', []))
    agent, token = manifest['agent'], manifest['usdt']
    entries = net.journal['transactions']
    pending = []
    signer = None
    for person in roster['recipients']:
        address = person['address']
        base = f'demo-payroll-v1-{vault.lower()}-{address.lower()}'
        ref = keccak(text=base)
        label = base
        attempt = 0
        # Only a mined revert allows a new nonce. The on-chain payment ref stays fixed.
        while entries.get(label, {}).get('state') == 'reverted':
            attempt += 1
            label = f'{base}-retry-{attempt}'
        entry = entries.get(label)
        args = [address, token, UNIT, ref]
        if entry is None:
            pending.append((person, label, args))
            continue
        if entry['state'] == 'confirmed' or get_signer is None:
            receipt = net.receipt(entry['hash'])
        else:
            signer = signer or get_signer()
            receipt = signer.send(label, 'AGENT', vault, calldata(PAY, PAY_TYPES, args), sponsored=True)
        verify_delivery(net, receipt, vault, agent, token, person, ref)

    if pending:
        if get_signer is None:
            raise RuntimeError('No local payment receipt for ' + ', '.join(p['name'] for p, _, _ in pending))
        block = net.rpc('eth_blockNumber', [])
        check_budget(net, vault, token, UNIT, len(pending), block)
        for _, _, args in pending:
            net.read(vault, PAY, PAY_TYPES, args, sender=agent, block=block)
        signer = signer or get_signer()
        for person, label, args in pending:
            receipt = signer.send(label, 'AGENT', vault, calldata(PAY, PAY_TYPES, args), sponsored=True)
            verify_delivery(net, receipt, vault, agent, token, person, args[-1])
    print('Confirmed: 3 recipients received 1 mUSDT each on BSC testnet.')


def agent_client():
    net = Testnet(roles=('AGENT',))
    net.manifest()
    return net


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--send', action='store_true', help='Submit outstanding testnet payments')
    args = parser.parse_args()
    LOCAL.mkdir(exist_ok=True)
    with (LOCAL / 'demo-payroll.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        net = Testnet(roles=())
        if net.env.get('NODEREAL_API_KEY'):
            net.rpc_url = 'https://bsc-testnet.nodereal.io/v1/' + net.env['NODEREAL_API_KEY']
            if int(net.rpc('eth_chainId', []), 16) != 97:
                raise RuntimeError('Expected BSC testnet for historical balance checks')
        payroll(net, json.loads(ROSTER.read_text()), agent_client if args.send else None)


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from None
