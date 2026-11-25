#!/usr/bin/env python3
"""Publish or check the eight LeashPay sources on BscScan Testnet (chain 97)."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

from dotenv import dotenv_values
from eth_abi import encode
import requests

from testnet import LOCAL, ROOT, RULES, RULES_TYPE, Testnet, save

API = 'https://api.etherscan.io/v2/api'
CONTRACTS = ROOT / 'contracts'
DEPLOYMENTS = CONTRACTS / 'deployments'
PROOF = DEPLOYMENTS / '97-verification.json'
COMPILER = 'v0.8.28+commit.7893614a'


def targets():
    m = json.loads((DEPLOYMENTS / '97.json').read_text())
    demo = json.loads((DEPLOYMENTS / '97-smoke.json').read_text())
    if (m['status'] != 'confirmed' or m['chainId'] != 97 or demo['chainId'] != 97
            or demo['owner'].lower() != m['deployer'].lower()):
        raise RuntimeError('Expected the confirmed chain 97 deployment and demo vault')
    cfg_type = '(address,address,address,address,uint256,address,address,address)'
    cfg = tuple(m[k] for k in ('usdt', 'usdc', 'usdtFeed', 'usdcFeed', 'maxPriceAge', 'tbill', 'dex', 'agent'))
    return [
        ('usdt', m['usdt'], 'src/mocks/MockToken.sol:MockToken', ['string', 'string'], ['LeashPay Mock USDT', 'mUSDT']),
        ('usdc', m['usdc'], 'src/mocks/MockToken.sol:MockToken', ['string', 'string'], ['LeashPay Mock USDC', 'mUSDC']),
        ('usdtFeed', m['usdtFeed'], 'src/AtlasRelayFeed.sol:AtlasRelayFeed', ['address', 'uint8'], [m['reporter'], 18]),
        ('usdcFeed', m['usdcFeed'], 'src/AtlasRelayFeed.sol:AtlasRelayFeed', ['address', 'uint8'], [m['reporter'], 18]),
        ('tbill', m['tbill'], 'src/mocks/MockTBill.sol:MockTBill', ['address'], [m['usdt']]),
        ('dex', m['dex'], 'src/mocks/MockDEX.sol:MockDEX', ['address', 'address'], [m['usdt'], m['usdc']]),
        ('factory', m['factory'], 'src/LeashVaultFactory.sol:LeashVaultFactory', [cfg_type], [cfg]),
        ('vault', demo['vault'], 'src/LeashVault.sol:LeashVault', ['address', cfg_type, RULES_TYPE],
         [demo['owner'], cfg, RULES]),
    ]


def explorer(key, action, *, params=None, data=None):
    query = {'chainid': '97', 'module': 'contract', 'action': action, 'apikey': key, **(params or {})}
    try:
        response = requests.request('POST' if data else 'GET', API, params=query, data=data,
                                    timeout=30, allow_redirects=False)
        response.raise_for_status()
        body = response.json()
    except (ValueError, requests.RequestException) as exc:
        # Request exception messages may include the API key.
        raise RuntimeError(f'{action}: {type(exc).__name__}') from None
    if body['status'] != '1':
        raise RuntimeError(f"{action}: {str(body['result']).replace(key, '[redacted]')[:240]}")
    return body['result']


def check_bundle(bundle, filename):
    sources = bundle['sources']
    if bundle['language'] != 'Solidity' or filename not in sources:
        raise RuntimeError(f'Missing Solidity source for {filename}')
    for name, item in sources.items():
        path = Path(name)
        if (path.suffix != '.sol' or '..' in path.parts
                or not name.startswith(('src/', 'lib/openzeppelin-contracts/contracts/'))
                or set(item) != {'content'} or item['content'] != (CONTRACTS / path).read_text()):
            raise RuntimeError(f'Unexpected source file or content for {name}')


def source_record(key, address, contract, args_hex):
    row, = explorer(key, 'getsourcecode', params={'address': address})
    if not row['SourceCode']:
        return None
    filename, name = contract.split(':')
    similar = row.get('SimilarMatch')
    if (row['ContractName'] != name or row['ContractFileName'] != filename or row['CompilerVersion'] != COMPILER
            or (not similar and row['ConstructorArguments'].lower() != args_hex) or row['EVMVersion'].lower() != 'paris'
            or row['OptimizationUsed'] != '1' or row['Runs'] != '200' or not json.loads(row['ABI'])):
        raise RuntimeError(f'{address}: published constructor, ABI or build settings differ')
    raw = row['SourceCode']
    check_bundle(json.loads(raw[1:-1] if raw.startswith('{{') else raw), filename)
    record = {'address': address, 'contract': contract, 'match': 'similar' if similar else 'exact',
              'compiler': row['CompilerVersion'], 'explorer': f'https://testnet.bscscan.com/address/{address}#code'}
    if similar:
        record['similarTo'] = similar
    return record


def check_creation(net, role, record, args_hex, results):
    # These two pairs have identical implementations and separate CREATE transactions.
    pairs = {'usdc': ('usdt', 1), 'usdcFeed': ('usdtFeed', 3)}
    if role not in pairs:
        raise RuntimeError(f'{role}: unexpected similar match')
    peer, index = pairs[role]
    if results[peer]['match'] != 'exact' or record['similarTo'].lower() != results[peer]['address'].lower():
        raise RuntimeError(f'{role}: BscScan points to an unexpected implementation')
    tx_hash = net.manifest()['deploymentTransactions'][index]
    receipt = net.receipt(tx_hash)
    tx = net.rpc('eth_getTransactionByHash', [tx_hash])
    name = record['contract'].split(':')[1]
    artifact = CONTRACTS / 'out' / f'{name}.sol' / f'{name}.json'
    if not artifact.is_file():
        raise RuntimeError('Build the deployment artifacts with forge build --root contracts')
    bytecode = json.loads(artifact.read_text())['bytecode']['object']
    if (tx['to'] is not None or tx['blockHash'] != receipt['blockHash']
            or receipt['contractAddress'].lower() != record['address'].lower()
            or tx['input'].lower() != (bytecode + args_hex).lower()):
        raise RuntimeError(f'{role}: original creation bytecode or constructor arguments differ')
    record['creationTransaction'] = tx_hash


def publish(key, address, contract, args_hex):
    # Forge prepares the standard input locally. Only the Etherscan V2 API receives the upload.
    forge = shutil.which('forge') or str(LOCAL / 'foundry-bin/forge')
    rendered = subprocess.run([forge, 'verify-contract', '--root', '.', '--chain', '97', '--show-standard-json-input',
                               '--compiler-version', COMPILER, address, contract],
                              cwd=CONTRACTS, capture_output=True, text=True, timeout=90)
    if rendered.returncode:
        raise RuntimeError(f'Foundry could not prepare the standard JSON input for {contract}')
    check_bundle(json.loads(rendered.stdout), contract.split(':')[0])
    data = {
        'contractaddress': address, 'contractname': contract, 'sourceCode': rendered.stdout,
        'codeformat': 'solidity-standard-json-input', 'compilerversion': COMPILER,
        'optimizationUsed': '1', 'runs': '200', 'evmVersion': 'paris', 'constructorArguments': args_hex,
        'licenseType': '3',  # MIT
    }
    try:
        guid = explorer(key, 'verifysourcecode', data=data)
    except RuntimeError as exc:
        if 'already verified' not in str(exc).lower():
            raise
        return source_record(key, address, contract, args_hex)
    print(f'{address}: submitted to BscScan', flush=True)
    for _ in range(48):
        time.sleep(5)
        record = source_record(key, address, contract, args_hex)
        if record and record['match'] == 'exact':
            return record
        try:
            explorer(key, 'checkverifystatus', params={'guid': guid})
        except RuntimeError as exc:
            if record and 'already verified' in str(exc).lower():
                return record
            if 'pending' not in str(exc).lower() and 'queue' not in str(exc).lower():
                raise
    raise RuntimeError(f'{address}: verification is still pending (GUID {guid})')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Only read the published sources and compare the proof')
    options = parser.parse_args()
    key = dotenv_values(ROOT / '.env').get('ETHERSCAN_API_KEY') or os.getenv('ETHERSCAN_API_KEY')
    if not key:
        raise RuntimeError('ETHERSCAN_API_KEY is required')
    results = {}
    net = None
    for role, address, contract, types, values in targets():
        args_hex = encode(types, values).hex()
        record = source_record(key, address, contract, args_hex)
        if not options.check and (not record or record['match'] == 'similar'):
            record = publish(key, address, contract, args_hex)
        if not record:
            raise RuntimeError(f'{role}: no verified source on BscScan')
        if record['match'] == 'similar':
            net = net or Testnet(roles=())
            check_creation(net, role, record, args_hex, results)
        results[role] = record
        print(f"{role}: {record['match']} match, constructor checked", flush=True)
        time.sleep(0.4)
    proof = {'chainId': 97, 'contracts': results}
    if options.check:
        if proof != json.loads(PROOF.read_text()):
            raise RuntimeError('Explorer results differ from the recorded proof')
    else:
        save(PROOF, proof)


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from None
