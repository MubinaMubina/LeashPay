#!/usr/bin/env python3
"""Testnet-only deployment, Atlas relay and journaled sponsored smoke test.
Run from any directory. Private keys are read from root .env, never printed.
"""
import argparse
import fcntl
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import requests
from dotenv import dotenv_values, set_key
from eth_account import Account
from eth_abi import encode, decode
from eth_abi.exceptions import DecodingError
from eth_utils import keccak, to_checksum_address

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / '.setup'
MANIFEST = ROOT / 'contracts/deployments/97.json'
JOURNAL = LOCAL / 'contract-transactions.json'
SOURCES = {'USDT': '0x9fc000fc9c17578b49853278a517e357201d01e4',
           'USDC': '0x2fd873e39e65b5f7f0e03e5079ecd4da7fc4067b'}
RULES_TYPE = '(uint256,uint256,uint256,uint256,uint256,uint256)'
RULES = (500*10**18, 1000*10**18, 60, 200, 1000*10**18, 98*10**16)


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, mode='w', delete=False) as tmp:
        tmp_path = Path(tmp.name)
        try:
            json.dump(data, tmp, indent=2)
            tmp.write('\n')
            tmp.flush()
            if path == JOURNAL:
                os.fsync(tmp.fileno())
            os.replace(tmp_path, path)
        finally:
            tmp_path.unlink(missing_ok=True)
    if path == JOURNAL:
        # Persist the rename before broadcasting, including across power loss.
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


def calldata(signature, types=(), values=()):
    return '0x' + (keccak(text=signature)[:4] + encode(types, values)).hex()


class RevertedTransaction(RuntimeError):
    def __init__(self, tx_hash, receipt):
        super().__init__(f'Transaction reverted: {tx_hash}')
        self.receipt = receipt


class Testnet:
    def __init__(self, *, roles=None):
        config = dotenv_values(ROOT / '.env')
        if roles is None:
            roles = ('DEPLOYER', 'AGENT', 'REPORTER')
            self.env = config
        else:
            keys = {'BSC_TESTNET_RPC_URL', 'BSC_MAINNET_RPC_URL'}
            keys.update(role + '_PRIVATE_KEY' for role in roles)
            if 'REPORTER' not in roles:
                keys.update(('NODEREAL_API_KEY', 'MEGAFUEL_POLICY_ID'))
            self.env = {key: config[key] for key in keys if key in config}
        self.rpc_url = self.env['BSC_TESTNET_RPC_URL']
        self.accounts = {role: Account.from_key(self.env[role + '_PRIVATE_KEY']) for role in roles}
        addresses = {a.address for a in self.accounts.values()}
        if len(addresses) != len(roles):
            raise RuntimeError('Deployer, agent and reporter must differ')
        self.session = requests.Session()
        self.session.headers['User-Agent'] = 'LeashPay-Testnet/1.0'
        self.journal = json.loads(JOURNAL.read_text()) if JOURNAL.exists() else {'chain_id': 97, 'transactions': {}}
        if self.journal['chain_id'] != 97 or int(self.rpc('eth_chainId', []), 16) != 97:
            raise RuntimeError('BSC testnet chain 97 required')

    def rpc(self, method, params, *, mainnet=False, sponsored=False):
        url = self.env['BSC_MAINNET_RPC_URL'] if mainnet else self.rpc_url
        headers = {}
        if mainnet and method not in ('eth_chainId', 'eth_call', 'eth_getCode', 'eth_blockNumber'):
            raise RuntimeError('Mainnet is read-only')
        if sponsored:
            url = 'https://open-platform-ap.nodereal.io/' + self.env['NODEREAL_API_KEY'] + '/megafuel-testnet/97'
            headers['X-MegaFuel-Policy-Uuid'] = self.env['MEGAFUEL_POLICY_ID']
        try:
            response = self.session.post(url, headers=headers,
                json={'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}, timeout=30)
            response.raise_for_status()
            data = response.json()
        except (requests.RequestException, ValueError) as exc:
            # Requests exceptions can contain the credential-bearing URL.
            raise RuntimeError(f'{method}: transport failure ({type(exc).__name__})') from None
        if not isinstance(data, dict) or not ('error' in data or 'result' in data):
            raise RuntimeError(f'{method}: malformed RPC response')
        if 'error' in data:
            message = json.dumps(data['error'])
            if method == 'eth_sendRawTransaction':
                message = message.replace(params[0], '[signed transaction]')
            for value in self.env.values():
                if value and len(value) > 16 and not value.startswith('#'):
                    message = message.replace(value, '[redacted]')
            raise RuntimeError(f'{method}: {message}')
        result = data['result']
        if method in ('eth_call', 'eth_getCode'):
            if not isinstance(result, str) or not re.fullmatch(r'0x(?:[a-fA-F0-9]{2})*', result):
                raise RuntimeError(f'{method}: malformed RPC byte data')
        elif method in ('eth_chainId', 'eth_blockNumber', 'eth_gasPrice', 'eth_estimateGas',
                        'eth_getTransactionCount', 'eth_getBalance'):
            if not isinstance(result, str) or not re.fullmatch(r'0x[a-fA-F0-9]+', result):
                raise RuntimeError(f'{method}: malformed RPC quantity')
        elif method == 'eth_sendRawTransaction':
            if not isinstance(result, str) or not re.fullmatch(r'0x[a-fA-F0-9]{64}', result):
                raise RuntimeError(f'{method}: missing transaction hash')
        return result

    def read(self, to, signature, types=(), values=(), outputs=(), *, sender=None, block='latest', mainnet=False):
        tx = {'to': to, 'data': calldata(signature, types, values)}
        if sender or self.accounts:
            tx['from'] = sender or next(iter(self.accounts.values())).address
        raw = self.rpc('eth_call', [tx, block], mainnet=mainnet)
        return decode(outputs, bytes.fromhex(raw[2:])) if outputs else raw

    def manifest(self):
        data = json.loads(MANIFEST.read_text())
        if data['chainId'] != 97:
            raise RuntimeError('Unexpected manifest chain')
        for role, signer in self.accounts.items():
            if data[role.lower()].lower() != signer.address.lower():
                raise RuntimeError('Manifest identity differs from local signer: ' + role)
        if len({data[role].lower() for role in ('deployer', 'agent', 'reporter')}) != 3:
            raise RuntimeError('Deployment roles must differ')
        return data

    def receipt(self, tx_hash):
        for _ in range(60):
            result = self.rpc('eth_getTransactionReceipt', [tx_hash])
            if result is not None:
                if (not isinstance(result, dict) or str(result.get('transactionHash', '')).lower() != tx_hash.lower()
                        or result.get('status') not in ('0x0', '0x1')
                        or not re.fullmatch(r'0x[a-fA-F0-9]+', str(result.get('blockNumber')))):
                    raise RuntimeError(f'Invalid receipt for {tx_hash}')
                if int(self.rpc('eth_blockNumber', []), 16) >= int(result['blockNumber'], 16) + 2:
                    if result['status'] == '0x0':
                        raise RevertedTransaction(tx_hash, result)
                    return result
            time.sleep(2)
        raise RuntimeError(f'Transaction pending; journal retained: {tx_hash}')

    def send(self, label, role, to, data, *, sponsored=False):
        LOCAL.mkdir(parents=True, exist_ok=True)
        with (LOCAL / 'contract-transactions.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if JOURNAL.exists():
                self.journal = json.loads(JOURNAL.read_text())
            if self.journal.get('chain_id') != 97:
                raise RuntimeError('Unexpected journal chain')
            return self._send_locked(label, role, to, data, sponsored=sponsored)

    def _available_nonce(self, role, sponsored):
        address = self.accounts[role].address
        def pending_nonce():
            return int(self.rpc('eth_getTransactionCount', [address, 'pending'], sponsored=sponsored), 16)

        nonce = pending_nonce()
        entries = sorted(self.journal['transactions'].items(), key=lambda pair: pair[1]['nonce'])
        for label, entry in entries:
            if entry['from'].lower() != address.lower() or entry['nonce'] < nonce:
                continue
            # A reporter can cross into a new observation while an earlier signed
            # update is awaiting delivery. Only recover the original exact bytes.
            if role == 'REPORTER' and entry['state'] in ('signed', 'submitted'):
                try:
                    self._send_locked(label, role, entry['to'], entry['data'], sponsored=entry['sponsored'])
                except RevertedTransaction:
                    pass  # This nonce is now consumed and a newer report can proceed.
                nonce = pending_nonce()
            if entry['nonce'] >= nonce:
                raise RuntimeError(f"Nonce conflict: {label} reserves nonce {entry['nonce']}; "
                                   'reconcile the original intent or wait for the RPC to catch up')
        return nonce

    def _send_locked(self, label, role, to, data, *, sponsored):
        account = self.accounts[role]
        existing = self.journal['transactions'].get(label)
        if existing:
            if (existing['to'].lower() != to.lower() or existing['data'] != data
                    or existing['from'].lower() != account.address.lower() or existing['sponsored'] != sponsored):
                raise RuntimeError(f'{label}: journal input mismatch')
            if existing['state'] == 'reverted':
                raise RevertedTransaction(existing['hash'], existing['receipt'])
            # A timeout during submission is ambiguous. Retry only identical signed bytes.
            if existing['state'] != 'confirmed' and 'gas' in existing:
                if self.rpc('eth_getTransactionByHash', [existing['hash']]) is None:
                    signed = account.sign_transaction({'chainId': 97, 'nonce': existing['nonce'],
                        'to': to_checksum_address(to), 'value': 0, 'data': data,
                        'gas': existing['gas'], 'gasPrice': existing['gasPrice']})
                    if '0x' + signed.hash.hex() != existing['hash']:
                        raise RuntimeError('Journal does not reproduce original signature')
                    returned = self.rpc('eth_sendRawTransaction', ['0x' + signed.raw_transaction.hex()], sponsored=sponsored)
                    if returned.lower() != existing['hash'].lower():
                        raise RuntimeError('Returned transaction hash differs from journal')
            tx_hash = existing['hash']
        else:
            tx = {'from': account.address, 'to': to, 'data': data, 'value': '0x0'}
            estimate = int(self.rpc('eth_estimateGas', [tx]), 16)
            gas = (estimate * 120 + 99) // 100
            if gas > 4_000_000:
                raise RuntimeError('Unexpected transaction gas requirement')
            if sponsored:
                eligibility = self.rpc('pm_isSponsorable', [{**tx, 'gas': hex(gas)}], sponsored=True)
                save(LOCAL / 'sponsorship-eligibility.json', eligibility)
                # Interpret the documented API response explicitly, never its truthiness.
                if not isinstance(eligibility, dict) or eligibility.get('sponsorable', eligibility.get('is_sponsorable')) is not True:
                    raise RuntimeError('Sponsorship not confirmed; inspect .setup/sponsorship-eligibility.json')
            nonce = self._available_nonce(role, sponsored)
            gas_price = 0 if sponsored else int(self.rpc('eth_gasPrice', []), 16)
            if gas_price > 10_000_000_000:
                raise RuntimeError('Gas price exceeds 10 gwei ceiling')
            signed = account.sign_transaction({'chainId': 97, 'nonce': nonce, 'to': to_checksum_address(to),
                'data': data, 'value': 0, 'gas': gas, 'gasPrice': gas_price})
            raw = '0x' + bytes(signed.raw_transaction).hex()
            tx_hash = '0x' + bytes(signed.hash).hex()
            self.journal['transactions'][label] = {'from': account.address, 'to': to, 'data': data,
                'hash': tx_hash, 'nonce': nonce, 'gas': gas, 'gasPrice': gas_price, 'sponsored': sponsored, 'state': 'signed'}
            save(JOURNAL, self.journal)
            returned = self.rpc('eth_sendRawTransaction', [raw], sponsored=sponsored)
            if returned.lower() != tx_hash.lower():
                raise RuntimeError('Returned transaction hash differs from signature')
            self.journal['transactions'][label]['state'] = 'submitted'
            save(JOURNAL, self.journal)
            print(label + ': submitted ' + tx_hash, flush=True)
        try:
            receipt = self.receipt(tx_hash)
        except RevertedTransaction as exc:
            self.journal['transactions'][label].update(state='reverted', receipt=exc.receipt)
            save(JOURNAL, self.journal)
            raise
        self.journal['transactions'][label].update(state='confirmed', receipt=receipt)
        save(JOURNAL, self.journal)
        print(label + ': confirmed ' + receipt['transactionHash'], flush=True)
        return receipt

    def deploy(self, broadcast=False, resume=False):
        previous = ROOT / 'contracts/broadcast/DeployTestnet.s.sol/97/run-latest.json'
        LOCAL.mkdir(parents=True, exist_ok=True)
        with (LOCAL / 'contract-transactions.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if resume and (not broadcast or not previous.is_file()):
                raise RuntimeError('--resume requires a broadcast and its original Foundry journal')
            if broadcast:
                if MANIFEST.exists():
                    existing = self.manifest()
                    if existing.get('status') == 'confirmed' or not resume:
                        raise RuntimeError('Deployment already recorded; use confirm to verify it')
                if previous.exists() and not resume:
                    raise RuntimeError('Broadcast journal already exists; verify status before resuming')
            forge = shutil.which('forge') or str(LOCAL / 'foundry-bin/forge')
            env = os.environ.copy()
            env.update(DEPLOYER_PRIVATE_KEY=self.env['DEPLOYER_PRIVATE_KEY'],
                       AGENT_ADDRESS=self.accounts['AGENT'].address,
                       REPORTER_ADDRESS=self.accounts['REPORTER'].address,
                       FOUNDRY_ETH_RPC_URL=self.rpc_url)
            gas_price = max(100_000_000, int(self.rpc('eth_gasPrice', []), 16))
            if gas_price > 1_000_000_000:
                raise RuntimeError('Deployment gas price exceeds 1 gwei ceiling')
            command = [forge, 'script', 'script/DeployTestnet.s.sol:DeployTestnet',
                       '--slow', '--legacy', '--with-gas-price', str(gas_price)]
            if broadcast:
                command.append('--broadcast')
            if resume:
                command.append('--resume')
            subprocess.run(command, cwd=ROOT / 'contracts', env=env, check=True)
            if broadcast:
                self.confirm_deployment()

    def confirm_deployment(self):
        recorded = self.manifest() if MANIFEST.is_file() else None
        if recorded and recorded.get('status') == 'confirmed':
            hashes = recorded['deploymentTransactions']
        else:
            path = ROOT / 'contracts/broadcast/DeployTestnet.s.sol/97/run-latest.json'
            if not path.is_file():
                raise RuntimeError('Initial confirmation needs the original broadcast journal')
            journal = json.loads(path.read_text())
            if journal.get('chain') != 97:
                raise RuntimeError('Foundry journal does not belong to BSC testnet')
            hashes = [entry['hash'] for entry in journal['transactions']]
        if len(hashes) != 9 or not all(hashes) or len(set(hashes)) != 9:
            raise RuntimeError('Expected nine distinct transaction hashes')

        names = ('usdt', 'usdc', 'usdtFeed', 'usdcFeed', 'tbill', 'dex', 'factory')
        # During recovery the receipt, not the journal's predicted CREATE address,
        # is authoritative. A confirmed checkout can be rechecked using public data.
        roles = ('deployer', 'agent', 'reporter')
        manifest = {role: recorded[role] if recorded else self.accounts[role.upper()].address for role in roles}
        manifest.update(chainId=97, maxPriceAge=90000)
        receipts = [self.receipt(h) for h in hashes]
        for tx_hash, receipt in zip(hashes, receipts):
            if (receipt['transactionHash'].lower() != tx_hash.lower()
                    or receipt['from'].lower() != manifest['deployer'].lower()):
                raise RuntimeError('Unexpected deployment transaction hash or sender')
        for name, receipt in zip(names, receipts):
            address = receipt.get('contractAddress')
            if receipt['to'] is not None or not address or int(address, 16) == 0:
                raise RuntimeError('Expected a contract creation for ' + name)
            manifest[name] = to_checksum_address(address)
            if recorded and manifest[name].lower() != recorded[name].lower():
                raise RuntimeError('Creation receipt differs from recorded address: ' + name)
            if self.rpc('eth_getCode', [address, 'latest']) == '0x':
                raise RuntimeError('Missing deployed code: ' + name)

        transfer = '0x' + keccak(text='Transfer(address,address,uint256)').hex()
        mint_topics = [transfer, '0x' + '00' * 32, '0x' + encode(['address'], [manifest['dex']]).hex()]
        for token, receipt in zip(('usdt', 'usdc'), receipts[7:]):
            address = manifest[token].lower()
            if (not receipt.get('to') or receipt['to'].lower() != address
                    or not any(log['address'].lower() == address and log['topics'] == mint_topics
                               and int(log['data'], 16) == 100_000 * 10**18 for log in receipt['logs'])):
                raise RuntimeError('Liquidity mint to the DEX is unconfirmed: ' + token)

        cfg, = self.read(manifest['factory'], 'config()',
                         outputs=['(address,address,address,address,uint256,address,address,address)'])
        expected = tuple(manifest[k].lower() for k in names[:4]) + (manifest['maxPriceAge'],) + (
            manifest['tbill'].lower(), manifest['dex'].lower(), manifest['agent'].lower())
        if tuple(cfg) != expected:
            raise RuntimeError('On-chain factory config mismatch')
        for feed in ('usdtFeed', 'usdcFeed'):
            reporter, = self.read(manifest[feed], 'reporter()', outputs=['address'])
            if reporter.lower() != manifest['reporter'].lower():
                raise RuntimeError('Unexpected deployed reporter: ' + feed)
        if not recorded or recorded.get('status') != 'confirmed':
            manifest.update(status='confirmed', deploymentTransactions=hashes, confirmedAt=int(time.time()))
            save(MANIFEST, manifest)
        env_file = ROOT / '.env'
        stored = dotenv_values(env_file)
        for key in ('FACTORY_ADDRESS', 'NEXT_PUBLIC_FACTORY_ADDRESS'):
            if (stored.get(key) or '').lower() != manifest['factory'].lower():
                set_key(env_file, key, manifest['factory'])
        if env_file.stat().st_mode & 0o777 != 0o600:
            env_file.chmod(0o600)
        print('Factory and deployment receipts confirmed: ' + manifest['factory'])

    def relay_observation(self, symbol, source, target, max_age):
        fields = ['uint80', 'int256', 'uint256', 'uint256', 'uint80']
        decimals, = self.read(source, 'decimals()', outputs=['uint8'], mainnet=True)
        _, answer, _, updated, _ = self.read(source, 'latestRoundData()', outputs=fields, mainnet=True)
        if decimals != 18 or answer <= 0 or updated == 0 or not 0 <= int(time.time()) - updated <= max_age:
            raise RuntimeError('Invalid or stale Atlas source: ' + symbol)
        mirror = self.read(target, 'latestRoundData()', outputs=fields)
        if mirror[3] < updated:
            data = calldata('update(int256,uint256)', ['int256', 'uint256'], [answer, updated])
            receipt = self.send(f'relay-{symbol}-{updated}', 'REPORTER', target, data)
            mirror = self.read(target, 'latestRoundData()', outputs=fields, block=receipt['blockNumber'])
        if (mirror[1], mirror[3]) != (answer, updated):
            raise RuntimeError('Relay observation differs from source: ' + symbol)
        return {'source': source, 'relay': target, 'answer': answer, 'updatedAt': updated, 'decimals': decimals}

    def relay_cycle(self):
        manifest = self.manifest()
        if manifest.get('status') != 'confirmed':
            raise RuntimeError('Deployment must be confirmed')
        if int(self.rpc('eth_chainId', [], mainnet=True), 16) != 56:
            raise RuntimeError('Atlas source must be BSC mainnet')
        feeds, errors = {}, {}
        for symbol, source in SOURCES.items():
            try:
                feeds[symbol] = self.relay_observation(symbol, source, manifest[symbol.lower() + 'Feed'],
                                                      manifest['maxPriceAge'])
            except (RuntimeError, DecodingError) as exc:
                errors[symbol] = str(exc)
        return feeds, errors

    def relay(self):
        feeds, errors = self.relay_cycle()
        if errors:
            raise RuntimeError(json.dumps(errors))
        save(ROOT / 'contracts/deployments/97-atlas.json', {'sourceChainId': 56, 'feeds': feeds})

    def smoke(self):
        m=self.manifest()
        if m.get('status') != 'confirmed': raise RuntimeError('Deployment must be confirmed')
        owner=m['deployer']
        factory=m['factory']
        vault=self.read(factory,'vaultOf(address)',['address'],[owner],['address'])[0]
        proof_path = ROOT / 'contracts/deployments/97-smoke.json'
        if proof_path.exists():
            proof = json.loads(proof_path.read_text())
            if (proof['chainId'] != 97 or proof['vault'].lower() != vault.lower()
                    or proof['owner'].lower() != owner.lower()):
                raise RuntimeError('Recorded smoke proof differs from the deployment')
            receipt = self.receipt(proof['transactionHash'])
            if receipt['from'].lower() != m['agent'].lower() or receipt['to'].lower() != vault.lower():
                raise RuntimeError('Recorded smoke proof differs from its receipt')
            print('Existing smoke payment confirmed: ' + receipt['transactionHash'])
            return
        recipient=m['reporter']  # controlled test recipient; role grants no vault permission
        if int(vault, 16) != 0 and 'create-demo-vault' not in self.journal['transactions']:
            raise RuntimeError('Existing owner vault without a demo creation journal; refusing to modify it')
        if int(vault,16)==0:
            receipt=self.send('create-demo-vault','DEPLOYER',factory,calldata('createVault('+RULES_TYPE+')',[RULES_TYPE],[RULES]))
            vault=self.read(factory,'vaultOf(address)',['address'],[owner],['address'],block=receipt['blockNumber'])[0]
        self.send('allow-demo-recipient','DEPLOYER',vault,calldata('setRecipient(address,bool,uint256)',['address','bool','uint256'],[recipient,True,1000*10**18]))
        self.send('fund-demo-vault','DEPLOYER',m['usdt'],calldata('mint(address,uint256)',['address','uint256'],[vault,1000*10**18]))
        ref=keccak(text='LeashPay sponsored smoke v1:'+vault.lower())
        data=calldata('pay(address,address,uint256,bytes32)',['address','address','uint256','bytes32'],[recipient,m['usdt'],10**18,ref])
        receipt=self.send('sponsored-demo-payment','AGENT',vault,data,sponsored=True)
        block=int(receipt['blockNumber'],16)
        before=self.read(m['usdt'],'balanceOf(address)',['address'],[recipient],['uint256'],block=hex(block-1))[0]
        after=self.read(m['usdt'],'balanceOf(address)',['address'],[recipient],['uint256'],block=hex(block))[0]
        if after-before != 10**18 or int(receipt['effectiveGasPrice'],16)!=0: raise RuntimeError('Payment or sponsorship not proven')
        topic='0x'+keccak(text='Paid(address,address,uint256,bytes32)').hex()
        events=[x for x in receipt['logs'] if x['address'].lower()==vault.lower() and x['topics'][0].lower()==topic.lower()]
        if len(events)!=1 or events[0]['topics'][3].lower()!='0x'+ref.hex(): raise RuntimeError('Paid event mismatch')
        before_gas=int(self.rpc('eth_getBalance',[self.accounts['AGENT'].address,hex(block-1)]),16)
        after_gas=int(self.rpc('eth_getBalance',[self.accounts['AGENT'].address,hex(block)]),16)
        if before_gas != after_gas: raise RuntimeError('Agent BNB balance changed')
        evidence={'chainId':97,'vault':vault,'owner':owner,'recipient':recipient,'token':m['usdt'],'amount':'1000000000000000000',
            'ref':'0x'+ref.hex(),'transactionHash':receipt['transactionHash'],'block':block,'effectiveGasPrice':'0',
            'recipientBalanceDelta':str(after-before),'agentBNBUnchanged':True,'explorer':'https://testnet.bscscan.com/tx/'+receipt['transactionHash']}
        save(proof_path,evidence)
        print(json.dumps(evidence,indent=2))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['deploy-dry-run','deploy','confirm','relay','smoke'])
    p.add_argument('--resume',action='store_true')
    args=p.parse_args()
    roles = None
    if args.action == 'relay':
        roles = ('REPORTER',)
    elif args.action == 'smoke' and (ROOT / 'contracts/deployments/97-smoke.json').exists():
        roles = ()
    elif args.action == 'confirm' and MANIFEST.exists() and json.loads(MANIFEST.read_text()).get('status') == 'confirmed':
        roles = ()
    t=Testnet(roles=roles)
    if args.action.startswith('deploy'): t.deploy(args.action=='deploy',args.resume)
    elif args.action=='confirm': t.confirm_deployment()
    elif args.action=='relay': t.relay()
    else: t.smoke()

if __name__ == '__main__':
    try: main()
    except (RuntimeError, subprocess.CalledProcessError) as e:
        raise SystemExit(str(e)) from None
