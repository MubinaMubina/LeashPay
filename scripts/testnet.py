#!/usr/bin/env python3
"""Testnet-only deployment, Atlas relay and journaled sponsored smoke test.
Run from any directory. Private keys are read from root .env, never printed.
"""
import argparse
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import requests
from dotenv import dotenv_values, set_key
from eth_account import Account
from eth_abi import encode, decode
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
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, indent=2) + '\n')
    tmp.replace(path)


def calldata(signature, types=(), values=()):
    return '0x' + (keccak(text=signature)[:4] + encode(types, values)).hex()


class Testnet:
    def __init__(self):
        self.env = dotenv_values(ROOT / '.env')
        self.rpc_url = self.env['BSC_TESTNET_RPC_URL']
        self.accounts = {role: Account.from_key(self.env[role + '_PRIVATE_KEY'])
                         for role in ('DEPLOYER', 'AGENT', 'REPORTER')}
        addresses = {a.address for a in self.accounts.values()}
        if len(addresses) != 3:
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
        if 'error' in data:
            message = json.dumps(data['error'])
            for value in self.env.values():
                if value and len(value) > 16 and not value.startswith('#'):
                    message = message.replace(value, '[redacted]')
            raise RuntimeError(f'{method}: {message}')
        return data['result']

    def read(self, to, signature, types=(), values=(), outputs=(), *, sender=None, block='latest', mainnet=False):
        tx = {'to': to, 'from': sender or self.accounts['DEPLOYER'].address,
              'data': calldata(signature, types, values)}
        raw = self.rpc('eth_call', [tx, block], mainnet=mainnet)
        return decode(outputs, bytes.fromhex(raw[2:])) if outputs else raw

    def manifest(self):
        data = json.loads(MANIFEST.read_text())
        if data['chainId'] != 97:
            raise RuntimeError('Unexpected manifest chain')
        if data['deployer'].lower() != self.accounts['DEPLOYER'].address.lower():
            raise RuntimeError('Manifest deployer differs from local key')
        return data

    def receipt(self, tx_hash):
        for _ in range(60):
            result = self.rpc('eth_getTransactionReceipt', [tx_hash])
            if result:
                if int(result['status'], 16) != 1:
                    raise RuntimeError(f'Transaction reverted: {tx_hash}')
                if int(self.rpc('eth_blockNumber', []), 16) >= int(result['blockNumber'], 16) + 2:
                    return result
            time.sleep(2)
        raise RuntimeError(f'Transaction pending; journal retained: {tx_hash}')

    def send(self, label, role, to, data, *, sponsored=False):
        account = self.accounts[role]
        existing = self.journal['transactions'].get(label)
        if existing:
            if existing['to'].lower() != to.lower() or existing['data'] != data or existing['from'] != account.address:
                raise RuntimeError(f'{label}: journal input mismatch')
            receipt = self.receipt(existing['hash'])
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
            nonce = int(self.rpc('eth_getTransactionCount', [account.address, 'pending'], sponsored=sponsored), 16)
            gas_price = 0 if sponsored else int(self.rpc('eth_gasPrice', []), 16)
            if gas_price > 10_000_000_000:
                raise RuntimeError('Gas price exceeds 10 gwei ceiling')
            signed = account.sign_transaction({'chainId': 97, 'nonce': nonce, 'to': to_checksum_address(to),
                'data': data, 'value': 0, 'gas': gas, 'gasPrice': gas_price})
            raw = '0x' + bytes(signed.raw_transaction).hex()
            tx_hash = '0x' + bytes(signed.hash).hex()
            self.journal['transactions'][label] = {'from': account.address, 'to': to, 'data': data,
                'hash': tx_hash, 'nonce': nonce, 'sponsored': sponsored, 'state': 'signed'}
            save(JOURNAL, self.journal)
            returned = self.rpc('eth_sendRawTransaction', [raw], sponsored=sponsored)
            if returned.lower() != tx_hash.lower():
                raise RuntimeError('Returned transaction hash differs from signature')
            self.journal['transactions'][label]['state'] = 'submitted'
            save(JOURNAL, self.journal)
            print(label + ': submitted ' + tx_hash, flush=True)
            receipt = self.receipt(tx_hash)
        self.journal['transactions'][label].update(state='confirmed', receipt=receipt)
        save(JOURNAL, self.journal)
        print(label + ': confirmed ' + receipt['transactionHash'], flush=True)
        return receipt

    def deploy(self, broadcast=False, resume=False):
        previous = ROOT / 'contracts/broadcast/DeployTestnet.s.sol/97/run-latest.json'
        if previous.exists() and not resume:
            raise RuntimeError('Broadcast journal already exists; verify status or explicitly --resume')
        forge = shutil.which('forge') or str(LOCAL / 'foundry-bin/forge')
        env = os.environ.copy()
        env['DEPLOYER_PRIVATE_KEY'] = self.env['DEPLOYER_PRIVATE_KEY']
        env['AGENT_ADDRESS'] = self.accounts['AGENT'].address
        env['REPORTER_ADDRESS'] = self.accounts['REPORTER'].address
        gas_price = max(100_000_000, int(self.rpc('eth_gasPrice', []), 16))
        if gas_price > 1_000_000_000:
            raise RuntimeError('Deployment gas price exceeds 1 gwei ceiling')
        command = [forge, 'script', 'script/DeployTestnet.s.sol:DeployTestnet', '--rpc-url', self.rpc_url,
                   '--slow', '--legacy', '--with-gas-price', str(gas_price)]
        if broadcast: command += ['--broadcast']
        if resume: command += ['--resume']
        # Logs contain public addresses and transactions; private keys stay in env.
        subprocess.run(command, cwd=ROOT/'contracts', env=env, check=True)
        if broadcast: self.confirm_deployment()

    def confirm_deployment(self):
        manifest = self.manifest()
        journal = json.loads((ROOT/'contracts/broadcast/DeployTestnet.s.sol/97/run-latest.json').read_text())
        hashes = [t['hash'] for t in journal['transactions']]
        if len(hashes) != 9: raise RuntimeError('Expected seven deployments and two liquidity mints')
        for h in hashes: self.receipt(h)
        for name in ('factory','usdt','usdc','usdtFeed','usdcFeed','tbill','dex'):
            if self.rpc('eth_getCode',[manifest[name],'latest']) == '0x':
                raise RuntimeError('Missing deployed code: '+name)
        cfg = self.read(manifest['factory'],'config()',outputs=['(address,address,address,address,uint256,address,address,address)'])[0]
        expected = [manifest[k].lower() for k in ('usdt','usdc','usdtFeed','usdcFeed')]+[90000]+[manifest[k].lower() for k in ('tbill','dex','agent')]
        if list(cfg) != expected: raise RuntimeError('On-chain factory config mismatch')
        manifest.update(status='confirmed', deploymentTransactions=hashes, confirmedAt=int(time.time()))
        save(MANIFEST,manifest)
        for key in ('FACTORY_ADDRESS','NEXT_PUBLIC_FACTORY_ADDRESS'):
            set_key(ROOT/'.env',key,manifest['factory'])
        (ROOT/'.env').chmod(0o600)
        print('Factory confirmed and both local factory variables updated: '+manifest['factory'])

    def relay(self):
        m = self.manifest()
        if m.get('status') != 'confirmed': raise RuntimeError('Deployment must be confirmed')
        if int(self.rpc('eth_chainId',[],mainnet=True),16) != 56: raise RuntimeError('Atlas source must be BSC mainnet')
        snapshot = {'sourceChainId':56,'feeds':{}}
        for symbol, address in SOURCES.items():
            decimals = self.read(address,'decimals()',outputs=['uint8'],mainnet=True)[0]
            _,answer,_,updated,_ = self.read(address,'latestRoundData()',outputs=['uint80','int256','uint256','uint256','uint80'],mainnet=True)
            if decimals != 18 or answer <= 0 or not 0 <= int(time.time())-updated <= m['maxPriceAge']:
                raise RuntimeError('Invalid or stale Atlas source: '+symbol)
            target = m[symbol.lower()+'Feed']
            current = self.read(target,'latestRoundData()',outputs=['uint80','int256','uint256','uint256','uint80'])
            if current[3] < updated:
                self.send('relay-'+symbol+'-'+str(updated),'REPORTER',target,calldata('update(int256,uint256)',['int256','uint256'],[answer,updated]))
            mirrored = self.read(target,'latestRoundData()',outputs=['uint80','int256','uint256','uint256','uint80'])
            if mirrored[1] != answer or mirrored[3] != updated: raise RuntimeError('Relay mismatch')
            snapshot['feeds'][symbol]={'source':address,'relay':target,'answer':answer,'updatedAt':updated,'decimals':decimals}
        save(ROOT/'contracts/deployments/97-atlas.json',snapshot)

    def smoke(self):
        m=self.manifest()
        if m.get('status') != 'confirmed': raise RuntimeError('Deployment must be confirmed')
        owner=self.accounts['DEPLOYER'].address
        recipient=self.accounts['REPORTER'].address  # controlled test recipient; role grants no vault permission
        factory=m['factory']
        vault=self.read(factory,'vaultOf(address)',['address'],[owner],['address'])[0]
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
        save(ROOT/'contracts/deployments/97-smoke.json',evidence)
        print(json.dumps(evidence,indent=2))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['deploy-dry-run','deploy','confirm','relay','smoke'])
    p.add_argument('--resume',action='store_true')
    args=p.parse_args(); t=Testnet()
    if args.action.startswith('deploy'): t.deploy(args.action=='deploy',args.resume)
    elif args.action=='confirm': t.confirm_deployment()
    elif args.action=='relay': t.relay()
    else: t.smoke()

if __name__ == '__main__':
    try: main()
    except (RuntimeError, subprocess.CalledProcessError) as e:
        raise SystemExit(str(e)) from None
