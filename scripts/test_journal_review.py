"""Regression coverage for durable testnet intents and read-only proof replays."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from eth_account import Account
from eth_utils import keccak

import testnet


class JournalReviewTests(unittest.TestCase):
    def setUp(self):
        local = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.path = local / 'journal.json'
        self.enterContext(patch('testnet.JOURNAL', self.path))
        self.enterContext(patch('testnet.LOCAL', local))
        self.account = Account.create()
        self.client = object.__new__(testnet.Testnet)
        self.client.accounts = {'AGENT': self.account, 'REPORTER': self.account}
        self.client.journal = {'chain_id': 97, 'transactions': {}}
        self.nonce = 3
        self.recorded = []
        self.fail = True

        def rpc(method, params, **options):
            if method == 'eth_sendRawTransaction':
                self.recorded.append(params[0])
                if self.fail:
                    raise RuntimeError('offline')
                return '0x' + keccak(hexstr=params[0]).hex()
            return {'eth_estimateGas': '0xabcd', 'eth_getTransactionCount': hex(self.nonce),
                    'eth_getTransactionByHash': None, 'eth_gasPrice': '0x2',
                    'pm_isSponsorable': {'sponsorable': True}}[method]
        self.client.rpc = rpc
        self.client.receipt = lambda h: {'transactionHash': h}

    def send(self, label, role='AGENT', sponsored=False):
        return self.client.send(label, role, self.account.address, '0x'+label.encode().hex(), sponsored=sponsored)

    def test_ambiguous_payment_cannot_be_replaced_by_a_different_label(self):
        with self.assertRaisesRegex(RuntimeError, 'offline'):
            self.send('first')
        self.fail = False
        with self.assertRaisesRegex(RuntimeError, 'nonce 3'):
            self.send('second')
        self.assertEqual(set(json.loads(self.path.read_text())['transactions']), {'first'})
        self.assertEqual(len(self.recorded), 1)
        self.send('first')
        with self.assertRaisesRegex(RuntimeError, 'nonce 3'):
            self.send('second')
        self.nonce += 1
        self.send('second')
        self.assertEqual(len(self.recorded), 3)
        self.assertEqual(self.recorded[0], self.recorded[1])

    def test_retry_cannot_change_private_sponsorship_route(self):
        with self.assertRaisesRegex(RuntimeError, 'offline'):
            self.send('payment', sponsored=True)
        self.fail = False
        with self.assertRaisesRegex(RuntimeError, 'mismatch'):
            self.send('payment', sponsored=False)
        self.assertEqual(len(self.recorded), 1)

    def test_reporter_recovers_previous_signed_observation_before_new_one(self):
        with self.assertRaisesRegex(RuntimeError, 'offline'):
            self.send('previous', role='REPORTER')
        self.fail = False
        def confirm(h):
            self.nonce += 1
            return {'transactionHash': h}
        self.client.receipt = confirm
        self.send('newer', role='REPORTER')
        self.assertEqual(len(self.recorded), 3)
        self.assertEqual(self.recorded[0], self.recorded[1])
        self.assertNotEqual(self.recorded[1], self.recorded[2])
        records = json.loads(self.path.read_text())['transactions']
        self.assertEqual((records['previous']['nonce'], records['newer']['nonce']), (3, 4))

    def test_error_on_new_chain_journal_is_detected_under_lock(self):
        self.path.write_text(json.dumps({'chain_id': 56, 'transactions': {}}))
        with self.assertRaisesRegex(RuntimeError, 'chain'):
            self.send('payment')
        self.assertFalse(self.recorded)


class RpcReviewTests(unittest.TestCase):
    def test_existing_owner_vault_without_demo_journal_cannot_be_reconfigured(self):
        with tempfile.TemporaryDirectory() as directory:
            client = object.__new__(testnet.Testnet)
            client.journal = {'chain_id': 97, 'transactions': {}}
            client.manifest = Mock(return_value={
                'status': 'confirmed', 'deployer': '0x' + 'b' * 40, 'agent': '0x' + 'c' * 40,
                'reporter': '0x' + 'd' * 40, 'factory': '0x' + 'e' * 40})
            client.read = Mock(return_value=('0x' + 'a' * 40,))
            client.send = Mock(side_effect=AssertionError('unexpected vault mutation'))
            with patch('testnet.ROOT', Path(directory)), self.assertRaisesRegex(RuntimeError, 'creation journal'):
                client.smoke()
            client.send.assert_not_called()

    def test_invalid_gateway_envelopes_and_result_types_are_contained(self):
        client = object.__new__(testnet.Testnet)
        client.rpc_url = 'https://invalid.example'
        client.env = {}
        client.session = Mock()
        for method, response in [('eth_call', []), ('eth_call', {}), ('eth_call', {'result': None}),
                                 ('eth_call', {'result': '0xyy'}), ('eth_chainId', {'result': 'oops'})]:
            with self.subTest(method=method, response=response):
                client.session.post.return_value.json.return_value = response
                with self.assertRaises(RuntimeError):
                    client.rpc(method, [])

    def test_recorded_smoke_skips_transactions_even_without_local_signers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proof_dir = root / 'contracts/deployments'
            proof_dir.mkdir(parents=True)
            vault, owner, agent = ['0x' + c * 40 for c in ('a', 'b', 'c')]
            tx_hash = '0x' + 'd' * 64
            (proof_dir / '97-smoke.json').write_text(json.dumps({'chainId': 97, 'vault': vault,
                        'owner': owner, 'transactionHash': tx_hash}))
            client = object.__new__(testnet.Testnet)
            client.accounts = {}
            client.manifest = Mock(return_value={'status': 'confirmed', 'deployer': owner, 'agent': agent,
                                                 'factory': '0x' + '1' * 40})
            client.read = Mock(return_value=(vault,))
            client.receipt = Mock(return_value={'transactionHash': tx_hash, 'to': vault, 'from': agent})
            client.send = Mock(side_effect=AssertionError('unexpected broadcast'))
            with patch('testnet.ROOT', root):
                client.smoke()
            client.send.assert_not_called()
            client.receipt.assert_called_once_with(tx_hash)
