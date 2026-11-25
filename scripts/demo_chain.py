"""Live Atlas and one sponsored payment from the chain-97 demo vault."""
import contextlib
import fcntl
import io
import json
import os
import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal

from eth_utils import keccak

from pay_demo import PAY, agent_client, verify_delivery
from seed_demo import PAY_TYPES, ROSTER, UNIT, check_budget, demo_vault
from testnet import LOCAL, RULES_TYPE, SOURCES, Testnet, calldata


def inspect_observation(symbol, mirrored, source, now, max_age):
    price, timestamp = mirrored
    age = now - timestamp
    if price <= 0 or timestamp <= 0 or age < 0:
        raise RuntimeError(f'{symbol} : le relais a renvoyé un prix ou un horodatage invalide.')
    if age > max_age:
        raise RuntimeError(f'{symbol} : prix vieux de {age // 60} min, limite du coffre {max_age // 60} min. '
                           'Lance make start pour actualiser le relais Atlas.')
    if mirrored != source:
        raise RuntimeError(f'{symbol} : le relais et la dernière observation Atlas diffèrent. '
                           'Lance make start et attends le prochain relevé.')


def atlas():
    net = Testnet(roles=())
    if int(net.rpc('eth_chainId', [], mainnet=True), 16) != 56:
        raise RuntimeError('La source Atlas doit être sur BSC mainnet (56).')
    block = net.rpc('eth_blockNumber', [])
    source_block = net.rpc('eth_blockNumber', [], mainnet=True)
    now = int(net.rpc('eth_getBlockByNumber', [block, False])['timestamp'], 16)
    manifest, vault = demo_vault(net, json.loads(ROSTER.read_text()), block)
    fields = ['uint80', 'int256', 'uint256', 'uint256', 'uint80']
    for symbol, source in SOURCES.items():
        token = manifest[symbol.lower()]
        relay, max_age = net.read(vault, 'priceFeed(address)', ['address'], [token],
                                  ['address', 'uint256'], block=block)
        if relay.lower() != manifest[symbol.lower() + 'Feed'].lower():
            raise RuntimeError(f'{symbol} : le coffre utilise un relais différent du déploiement.')
        _, price, _, ts, _ = net.read(relay, 'latestRoundData()', outputs=fields, block=block)
        _, origin, _, source_ts, _ = net.read(source, 'latestRoundData()', outputs=fields, block=source_block, mainnet=True)
        inspect_observation(symbol, (price, ts), (origin, source_ts), now, max_age)
        if net.read(vault, 'getPrice(address)', ['address'], [token], ['uint256', 'uint256'], block=block) != (price, ts):
            raise RuntimeError(f'{symbol} : le prix effectivement lu par le coffre diffère du prix Atlas.')
        observed = datetime.fromtimestamp(ts, timezone.utc).strftime('%d/%m %H:%M UTC')
        print(f'✓ {symbol} vaut {Decimal(price) / UNIT:.6f} USD selon le coffre et Atlas. '
              f'Observation du {observed}, âge {(now-ts)//60} min sur {max_age//60} autorisées.', flush=True)
    print(f'  Bloc du coffre : https://testnet.bscscan.com/block/{int(block, 16)}', flush=True)


def demo_payment(roster):
    matches = [person for person in roster['recipients'] if person['name'] == 'Marco' and person['currency'] == 'PHP']
    if len(matches) != 1:
        raise RuntimeError('Marco doit apparaître une fois dans le registre de démonstration.')
    return matches[0]


def validate_plan(plan, roster):
    """Only the advertised payment can reach the testnet signer."""
    marco = demo_payment(roster)
    try:
        payment, = plan['payments']
        valid = (plan['chainId'] == 97 and plan['vault'].lower() == roster['vault'].lower()
                 and plan['token'].lower() == roster['token'].lower() and payment['amount'] == str(UNIT)
                 and payment['name'].casefold() == 'marco' and payment['address'].lower() == marco['address'].lower())
    except (TypeError, ValueError, AttributeError, KeyError):
        valid = False
    if not valid:
        raise RuntimeError('Le plan doit contenir exactement 1 mUSDT pour Marco sur le coffre de démonstration.')


def active_run(path, requested):
    """Persist the intent before signing. Caller holds the payment lock through verification."""
    if requested and not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', requested):
        raise RuntimeError('RUN doit contenir 1 à 64 lettres, chiffres, tirets ou underscores.')
    if path.exists():
        current = path.read_text().strip()
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', current):
            raise RuntimeError('Identifiant de reprise illisible. Vérifie le journal local avant tout nouvel envoi.')
        if requested and requested != current:
            raise RuntimeError(f'Le paiement {current} attend sa vérification. Relance avec RUN={current}.')
        return current
    current = requested or uuid.uuid4().hex
    with path.open('x') as out:
        out.write(current + '\n')
        out.flush()
        os.fsync(out.fileno())
    return current


def payment(run_id=None, plan=None):
    roster = json.loads(ROSTER.read_text())
    person = demo_payment(roster)
    if plan is not None:
        validate_plan(plan, roster)
    LOCAL.mkdir(exist_ok=True)
    with (LOCAL / 'service-payment.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Un test de paiement est déjà en cours dans un autre terminal.') from None
        net = Testnet(roles=())
        if net.env.get('NODEREAL_API_KEY'):
            net.rpc_url = 'https://bsc-testnet.nodereal.io/v1/' + net.env['NODEREAL_API_KEY']
            if int(net.rpc('eth_chainId', []), 16) != 97:
                raise RuntimeError('Le RPC de vérification doit être sur BSC testnet (97).')
        block = net.rpc('eth_blockNumber', [])
        manifest, vault = demo_vault(net, roster, block)
        pointer = LOCAL / 'service-payment-pending'
        run = active_run(pointer, run_id)
        print(f'  Paiement de 1 mUSDT à Marco sur BSC testnet · RUN={run}', flush=True)
        token = manifest['usdt']
        base = f'service-payment-{vault.lower()}-{person["address"].lower()}-{run}'
        ref = keccak(text=base)
        label = base
        attempts = 0
        entries = net.journal['transactions']
        while entries.get(label, {}).get('state') == 'reverted':
            attempts += 1
            label = f'{base}-retry-{attempts}'
        entry = entries.get(label)
        if entry and entry['state'] == 'confirmed':
            print('  Ce paiement a déjà été confirmé. Relecture de son reçu.', flush=True)
            receipt = net.receipt(entry['hash'])
        else:
            args = [person['address'], token, UNIT, ref]
            if not entry:
                check_budget(net, vault, token, UNIT, 1, block)
                rules, = net.read(vault, 'rules()', outputs=[RULES_TYPE], block=block)
                allowed, cap, spent, last = net.read(vault, 'recipientInfo(address)', ['address'], [person['address']],
                                                     ['bool', 'uint256', 'uint256', 'uint256'], block=block)
                now = int(net.rpc('eth_getBlockByNumber', [block, False])['timestamp'], 16)
                if not allowed or cap - spent < UNIT:
                    raise RuntimeError('Marco doit être autorisé et disposer de 1 mUSDT de plafond restant.')
                if last and last + rules[2] > now:
                    raise RuntimeError(f'Le coffre impose encore {last + rules[2] - now} s entre deux paiements à Marco.')
                net.read(vault, PAY, PAY_TYPES, args, sender=manifest['agent'], block=block)
            print('  Confirmation de la transaction sponsorisée en cours…', flush=True)
            with contextlib.redirect_stdout(io.StringIO()):
                receipt = agent_client().send(label, 'AGENT', vault, calldata(PAY, PAY_TYPES, args), sponsored=True)
        before, after = verify_delivery(net, receipt, vault, manifest['agent'], token, person, ref, show=False)
        print(f'✓ Marco a reçu 1 mUSDT. Son solde est passé de {Decimal(before)/UNIT} à {Decimal(after)/UNIT} mUSDT.')
        print('✓ Le coffre et le jeton ont confirmé le transfert. Frais payés par l’agent : 0 tBNB.')
        print(f'  Reçu : https://testnet.bscscan.com/tx/{receipt["transactionHash"]}', flush=True)
        pointer.unlink()
