"""Prepare the existing LeashPay demo vault's three payees on BSC testnet."""
import fcntl
import json
from decimal import Decimal

from eth_utils import is_checksum_address, keccak

from testnet import LOCAL, ROOT, RULES_TYPE, Testnet, calldata

ROSTER = ROOT / 'contracts/deployments/97-demo-recipients.json'
UNIT = 10**18
PAY_TYPES = ['address', 'address', 'uint256', 'bytes32']


def seed(net, roster, get_signer):
    m = net.manifest()
    people = roster['recipients']
    addresses = [p['address'] for p in people]
    reserved = {m['deployer'].lower(), m['agent'].lower(), roster['vault'].lower(), '0x' + '00' * 20}
    if (m['status'] != 'confirmed' or m['chainId'] != 97 or roster['chainId'] != 97
            or roster['token'].lower() != m['usdt'].lower() or roster['paymentPerRecipientTokens'] != 1
            or len(people) != 3 or len({a.lower() for a in addresses}) != 3
            or any(not is_checksum_address(a) or a.lower() in reserved for a in addresses)
            or any(type(p['monthlyCapTokens']) is not int or not 1 <= p['monthlyCapTokens'] <= 1000 for p in people)):
        raise RuntimeError('Invalid chain 97 demo roster')

    block = net.rpc('eth_blockNumber', [])
    vault, = net.read(m['factory'], 'vaultOf(address)', ['address'], [m['deployer']], ['address'], block=block)
    if vault.lower() != roster['vault'].lower() or int(vault, 16) == 0:
        raise RuntimeError('Factory does not identify the expected demo vault')
    owner, = net.read(vault, 'owner()', outputs=['address'], block=block)
    agent, = net.read(vault, 'agent()', outputs=['address'], block=block)
    if owner.lower() != m['deployer'].lower() or agent.lower() != m['agent'].lower():
        raise RuntimeError('Unexpected owner or agent on the demo vault')
    token = m['usdt']
    amount = roster['paymentPerRecipientTokens'] * UNIT
    total = len(people) * amount

    def check_budget(at):
        rules, = net.read(vault, 'rules()', outputs=[RULES_TYPE], block=at)
        spent, = net.read(vault, 'spentToday()', outputs=['uint256'], block=at)
        liquid, = net.read(token, 'balanceOf(address)', ['address'], [vault], ['uint256'], block=at)
        if amount > rules[0] or spent + total > rules[1] or liquid < total:
            raise RuntimeError('Vault balance or payment limits cannot cover the three demo payments')
        return liquid

    if net.read(vault, 'paused()', outputs=['bool'], block=block)[0] or not net.read(
            vault, 'isTokenAllowed(address)', ['address'], [token], ['bool'], block=block)[0]:
        raise RuntimeError('Demo vault is paused or mUSDT is disabled')
    check_budget(block)
    pending = []
    for p in people:
        address, cap = p['address'], p['monthlyCapTokens'] * UNIT
        allowed, current_cap, spent, last = net.read(vault, 'recipientInfo(address)', ['address'], [address],
                                                    ['bool', 'uint256', 'uint256', 'uint256'], block=block)
        label = f'demo-recipient-v1-{vault.lower()}-{address.lower()}'
        entry = net.journal['transactions'].get(label, {})
        configured = allowed and current_cap == cap
        if not configured and (allowed or current_cap or spent or last or entry.get('state') == 'confirmed'):
            raise RuntimeError(f"{p['name']}: existing recipient policy differs; review it with the owner")
        if cap - spent < amount:
            raise RuntimeError(f"{p['name']}: monthly allowance cannot cover the demo payment")
        if not configured or entry.get('state') in ('signed', 'submitted'):
            pending.append((label, address, cap))

    receipts = []
    if pending:
        signer = get_signer()
        for label, address, cap in pending:
            data = calldata('setRecipient(address,bool,uint256)', ['address', 'bool', 'uint256'], [address, True, cap])
            receipts.append(signer.send(label, 'DEPLOYER', vault, data))

    block = net.rpc('eth_blockNumber', [])
    liquid = check_budget(block)
    for p in people:
        address = p['address']
        state = net.read(vault, 'recipientInfo(address)', ['address'], [address],
                         ['bool', 'uint256', 'uint256', 'uint256'], block=block)
        if state[:2] != (True, p['monthlyCapTokens'] * UNIT):
            raise RuntimeError(f"{p['name']}: on-chain allowance not confirmed")
        # A read-only call exercises cooldown, oracle and payment rules without transferring funds.
        ref = keccak(text=f'LeashPay seed readiness {vault} {address} {block}')
        net.read(vault, 'pay(address,address,uint256,bytes32)', PAY_TYPES, [address, token, amount, ref],
                 sender=agent, block=block)
        print(f"{p['name']} ({p['currency']}): {address}, monthly cap {p['monthlyCapTokens']} tokens")
    print(f'Block {int(block, 16)}: 3 payees ready, {Decimal(liquid) / UNIT:f} mUSDT in vault. '
          f'{len(receipts)} setup transaction(s) confirmed in this run; 0 payouts.')
    return receipts


def owner_client():
    net = Testnet(roles=('DEPLOYER',))
    net.manifest()  # Verifies the local signing key against the deployment owner.
    return net


def main():
    LOCAL.mkdir(exist_ok=True)
    with (LOCAL / 'demo-seed.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        seed(Testnet(roles=()), json.loads(ROSTER.read_text()), owner_client)


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from None
