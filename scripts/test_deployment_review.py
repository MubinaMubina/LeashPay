"""Operational regressions verified offline against public deployment fixtures."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from eth_abi import encode
from eth_utils import keccak

import testnet


def checker():
    path = Path(testnet.__file__).parent / 'check-testnet.py'
    spec = importlib.util.spec_from_file_location('check_testnet', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.source = json.loads(testnet.MANIFEST.read_text())
        self.path = self.root / 'contracts/deployments/97.json'
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps(self.source))
        for attr, value in (('ROOT', self.root), ('MANIFEST', self.path), ('LOCAL', self.root / '.setup')):
            self.enterContext(patch.object(testnet, attr, value))
        self.net = object.__new__(testnet.Testnet)
        self.net.accounts = {}
        self.net.env = {}
        self.net.rpc = Mock(return_value='0x01')
        self.net.receipt = Mock()
        self.net.read = Mock()
        self.forge = self.enterContext(patch.object(testnet.subprocess, 'run'))
        self.env_file = self.root / '.env'
        self.env_file.write_text('')

    def test_fresh_checkout_with_confirmed_manifest_cannot_broadcast(self):
        with self.assertRaisesRegex(RuntimeError, 'already recorded'):
            self.net.deploy(broadcast=True)
        self.forge.assert_not_called()
        self.net.rpc.assert_not_called()

    def test_resume_requires_prior_broadcast_even_without_manifest(self):
        self.path.unlink()
        with self.assertRaisesRegex(RuntimeError, 'original Foundry journal'):
            self.net.deploy(broadcast=True, resume=True)
        self.forge.assert_not_called()

    def arrange_receipts(self):
        manifest = self.source
        names = ['usdt', 'usdc', 'usdtFeed', 'usdcFeed', 'tbill', 'dex', 'factory']
        hashes = manifest['deploymentTransactions']
        receipts = {hash_: {'transactionHash': hash_, 'from': manifest['deployer'], 'to': None,
                            'contractAddress': manifest[name]}
                    for hash_, name in zip(hashes, names)}
        for hash_, token in zip(hashes[7:], ('usdt', 'usdc')):
            receipts[hash_] = {'transactionHash': hash_, 'from': manifest['deployer'], 'to': manifest[token],
                               'contractAddress': None, 'logs': [{
                                   'address': manifest[token], 'topics': [
                                       '0x' + keccak(text='Transfer(address,address,uint256)').hex(),
                                       '0x' + '00' * 32,
                                       '0x' + encode(['address'], [manifest['dex']]).hex()],
                                   'data': hex(100_000 * 10**18)}]}
        cfg = tuple(manifest[k].lower() for k in names[:4]) + (manifest['maxPriceAge'],) + tuple(
            manifest[k].lower() for k in ('tbill', 'dex', 'agent'))
        self.net.receipt.side_effect = receipts.__getitem__
        self.net.read.side_effect = lambda to, fn, **kwargs: (cfg,) if fn == 'config()' else (manifest['reporter'],)
        return receipts

    def test_confirmed_public_hashes_work_without_broadcast_or_signing_keys(self):
        self.arrange_receipts()
        original = self.path.read_bytes()
        self.net.confirm_deployment()
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(self.net.receipt.call_count, 9)
        self.assertIn(self.source['factory'], self.env_file.read_text())

    def test_repeat_keyless_confirmation_leaves_existing_env_untouched(self):
        self.arrange_receipts()
        factory = self.source['factory']
        self.env_file.write_text(f'FACTORY_ADDRESS={factory}\nNEXT_PUBLIC_FACTORY_ADDRESS={factory}\n')
        self.env_file.chmod(0o600)
        original = self.env_file.stat()
        with patch('testnet.set_key') as write:
            self.net.confirm_deployment()
            write.assert_not_called()
        current = self.env_file.stat()
        self.assertEqual((original.st_ino, original.st_mtime_ns), (current.st_ino, current.st_mtime_ns))

    def test_create_receipt_must_match_canonical_address(self):
        receipts = self.arrange_receipts()
        receipts[self.source['deploymentTransactions'][0]]['contractAddress'] = self.source['reporter']
        with self.assertRaisesRegex(RuntimeError, 'Creation receipt differs'):
            self.net.confirm_deployment()
        self.assertEqual(self.env_file.read_text(), '')

    def test_liquidity_receipt_must_prove_correct_amount_to_dex(self):
        receipts = self.arrange_receipts()
        receipts[self.source['deploymentTransactions'][-1]]['logs'][0]['data'] = '0x1'
        with self.assertRaisesRegex(RuntimeError, 'Liquidity mint'):
            self.net.confirm_deployment()
        self.assertEqual(self.env_file.read_text(), '')


class PaymentProofTests(unittest.TestCase):
    def test_recorded_simulation_replays_without_signers_or_mutation(self):
        check = checker()
        manifest = json.loads(testnet.MANIFEST.read_text())
        original_dir = testnet.MANIFEST.parent
        proof = json.loads((original_dir / '97-smoke.json').read_text())
        checks = json.loads((original_dir / '97-checks.json').read_text())
        recipient, token = proof['recipient'], proof['token']
        amount = int(proof['amount'])
        topics = ['0x' + keccak(text='Paid(address,address,uint256,bytes32)').hex(),
                  '0x' + encode(['address'], [recipient]).hex(), '0x' + encode(['address'], [token]).hex(), proof['ref']]
        receipt = {'blockNumber': hex(proof['block']), 'transactionHash': proof['transactionHash'],
                   'effectiveGasPrice': '0x0', 'from': manifest['agent'], 'to': proof['vault'],
                   'logs': [{'address': proof['vault'], 'topics': topics, 'data': '0x' + encode(['uint256'], [amount]).hex()}]}
        calls = []
        def rpc(method, params):
            if method == 'eth_getBalance':
                return hex(int(checks['agentBNBAfter']))
            self.assertEqual(method, 'eth_call')
            self.assertEqual(params[1], hex(checks['simulationBlock']))
            self.assertEqual(params[0]['from'], manifest['agent'])
            refusal = ['duplicatePayment', 'unauthorizedRecipient'][len(calls)]
            calls.append(refusal)
            raise RuntimeError('eth_call: ' + json.dumps({'data': checks['refusals'][refusal]['revertData']}))
        net = Mock()
        net.manifest.return_value = manifest
        net.receipt.return_value = receipt
        net.rpc.side_effect = rpc
        net.read.side_effect = [(proof['vault'],), (0,), (amount,)]
        with patch.object(check, 'Testnet', return_value=net) as construct, patch.object(check, 'save') as write, \
             patch.object(sys, 'argv', ['check-testnet.py']):
            check.main()
        construct.assert_called_once_with(roles=())
        write.assert_not_called()
        self.assertEqual(calls, ['duplicatePayment', 'unauthorizedRecipient'])
