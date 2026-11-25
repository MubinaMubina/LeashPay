"""Terminal entry points for the LeashPay live service checks."""
import argparse
import json
import os
import subprocess
import sys

from dotenv import dotenv_values

from demo_chain import atlas, payment, validate_plan
from seed_demo import ROSTER
from testnet import ROOT

TITLES = {
    'cmc': 'CoinMarketCap · Combien vaut 1 USDT aux Philippines ?',
    'atlas': 'Atlas · Quel prix le coffre utilise-t-il ?',
    'cournot': 'Cournot · Que dit le marché sur le risque de décrochage ?',
    'brain': 'Living Brain · Le service retrouve-t-il une préférence enregistrée maintenant ?',
    'agent': 'Claude · Quels paiements propose l’agent ?',
    'privy': 'Privy · Peut-on authentifier une session LeashPay ?',
    'paiement': 'BSC testnet · Marco reçoit-il réellement 1 mUSDT ?',
    'demo': 'LeashPay · De la demande de paiement au solde de Marco',
}


def planner(marco=False):
    directory = ROOT / 'agent'
    if not (directory / 'node_modules/tsx').is_dir():
        raise RuntimeError('Dépendances de l’agent manquantes. Lance npm ci --prefix agent.')
    command = ['node', '--import', 'tsx', 'scripts/demo-agent.ts']
    if marco:
        command += ['--marco', '--json']
    # The CLI sanitizes provider errors. Its JSON output never goes to the signer unchecked.
    result = subprocess.run(command, cwd=directory, stdout=subprocess.PIPE if marco else None, text=True)
    if result.returncode:
        raise RuntimeError('Le plan de paiement n’a pas pu être validé.')
    if marco:
        try:
            return json.loads(result.stdout)
        except ValueError:
            raise RuntimeError('La réponse du planificateur est illisible.') from None


def run(service, env):
    print(f'\n{TITLES[service]}\n', flush=True)
    if service == 'atlas':
        atlas()
    elif service == 'paiement':
        payment(env.get('RUN'))
    elif service == 'agent':
        planner()
    elif service in ('brain', 'privy'):
        from demo_identity import brain, privy
        (brain if service == 'brain' else privy)(env)
    elif service in ('cmc', 'cournot'):
        from demo_oracles import cmc, cournot
        (cmc if service == 'cmc' else cournot)(env)
    elif service == 'demo':
        from demo_oracles import cmc
        print('1. Demande à Claude : « Paie Marco 1 USDT maintenant. »', flush=True)
        plan = planner(marco=True)
        validate_plan(plan, json.loads(ROSTER.read_text()))
        print('✓ Le plan contient un seul paiement de 1 mUSDT à l’adresse de Marco.\n', flush=True)
        print('2. Contre-valeur en pesos philippins', flush=True)
        cmc(env)
        print('\n3. Prix réellement lu par le coffre', flush=True)
        atlas()
        print('\n4. Exécution du paiement sur le coffre de démonstration', flush=True)
        payment(env.get('RUN'), plan)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('service', choices=TITLES)
    args = parser.parse_args()
    env = {**dotenv_values(ROOT / '.env'), **os.environ}
    try:
        run(args.service, env)
    except RuntimeError as exc:
        reason = str(exc)
        if ': transport failure (' in reason:
            reason = 'Le nœud blockchain ne répond pas. Vérifie la connexion au RPC, puis relance le même test.'
        elif reason.startswith('Sponsorship not confirmed'):
            reason = 'MegaFuel a refusé de couvrir les frais. Vérifie le crédit et la date avec make megafuel-status.'
        elif reason.startswith('Vault balance or payment limits'):
            reason = 'Le solde disponible ou le plafond du coffre ne permet plus ce paiement de 1 mUSDT.'
        print(f'\n✗ {reason}', file=sys.stderr)
        return 1
    except KeyError as exc:
        field = exc.args[0]
        message = f'Renseigne {field} dans le .env.' if isinstance(field, str) and field.isupper() else 'Réponse du service incomplète.'
        print(f'\n✗ {message}', file=sys.stderr)
        return 1
    except (ValueError, OSError, TypeError):
        print('\n✗ Configuration locale ou réponse du service illisible. Vérifie le .env et les prérequis.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
