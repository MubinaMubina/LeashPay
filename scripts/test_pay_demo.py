import contextlib
import io
import json
import unittest
from unittest.mock import Mock

from eth_abi import decode, encode
from eth_utils import keccak

from seed_demo import PAY_TYPES, ROSTER, UNIT
import pay_demo


class PayrollTests(unittest.TestCase):
    def setUp(self):
        self.roster = json.loads(ROSTER.read_text())
        self.m = json.loads((ROSTER.parent / '97.json').read_text())
        self.vault, self.token = self.roster['vault'], self.m['usdt']
        self.net = Mock()
        self.net.manifest.return_value = self.m
        self.net.rpc.return_value = '0x50'
        self.net.journal = {'transactions': {}}
        self.net.read.side_effect = self.read
        self.net.send.side_effect = self.send
        self.receipts = {}
        self.net.receipt.side_effect = self.receipts.__getitem__
        self.signer = Mock(return_value=self.net)
        self.balance = 3 * UNIT
        self.sent = []

    def read(self, to, sig, types=(), args=(), outputs=(), **kw):
        if sig == 'balanceOf(address)':
            if args[0].lower() == self.vault.lower():
                return (self.balance,)
            block = int(kw['block'], 16)
            return (sum(UNIT for who, at in self.sent if who == args[0].lower() and at <= block),)
        return {
            'vaultOf(address)': (self.vault,), 'owner()': (self.m['deployer'],),
            'agent()': (self.m['agent'],), 'rules()': ((UNIT, 3 * UNIT, 0, 0, 0, 0),),
            'spentToday()': (0,), 'pay(address,address,uint256,bytes32)': '0x',
        }[sig]

    def send(self, label, role, vault, data, *, sponsored):
        self.assertEqual((role, vault, sponsored), ('AGENT', self.vault, True))
        address, token, amount, ref = decode(PAY_TYPES, bytes.fromhex(data[10:]))
        self.assertEqual((token, amount), (self.token.lower(), UNIT))
        self.assertIn(address, [p['address'].lower() for p in self.roster['recipients']])
        block = 100 + len(self.sent)
        self.sent.append((address, block))
        tx_hash = f'0x{block:064x}'

        def event(emitter, signature, indexed):
            return {'address': emitter, 'topics': ['0x' + keccak(text=signature).hex(), *indexed],
                    'data': '0x' + encode(['uint256'], [amount]).hex()}

        def topic(addr):
            return '0x' + encode(['address'], [addr]).hex()

        receipt = {'status': '0x1', 'from': self.m['agent'], 'to': vault, 'effectiveGasPrice': '0x0',
                   'transactionHash': tx_hash, 'blockNumber': hex(block), 'logs': [
                       event(vault, 'Paid(address,address,uint256,bytes32)', [topic(address), topic(token), '0x' + ref.hex()]),
                       event(token, 'Transfer(address,address,uint256)', [topic(vault), topic(address)])]}
        self.receipts[tx_hash] = receipt
        self.net.journal['transactions'][label] = {'hash': tx_hash, 'state': 'confirmed'}
        return receipt

    def run_batch(self, send=True):
        with contextlib.redirect_stdout(io.StringIO()):
            pay_demo.payroll(self.net, self.roster, self.signer if send else None)

    def test_resume_after_partial_payment_and_recheck_without_signing(self):
        def disconnect_on_second(*args, **kwargs):
            if len(self.sent) == 1:
                raise RuntimeError('disconnected')
            return self.send(*args, **kwargs)

        self.net.send.side_effect = disconnect_on_second
        with self.assertRaisesRegex(RuntimeError, 'disconnected'):
            self.run_batch()
        self.net.send.side_effect = self.send
        self.balance = 2 * UNIT
        self.run_batch()
        self.assertEqual([a for a, _ in self.sent], [p['address'].lower() for p in self.roster['recipients']])
        self.balance = 0
        self.signer.reset_mock()
        self.run_batch(send=False)
        self.run_batch()
        self.signer.assert_not_called()
        self.assertEqual(len(self.sent), 3)

    def test_verify_before_first_payment_and_short_budget_cannot_send(self):
        with self.assertRaises(RuntimeError):
            self.run_batch(send=False)
        self.balance = 2 * UNIT
        with self.assertRaises(RuntimeError):
            self.run_batch()
        self.assertEqual(self.sent, [])

    def test_verification_requires_both_token_delivery_and_balance_increase(self):
        self.run_batch()
        receipt = next(iter(self.receipts.values()))
        receipt['logs'][1]['data'] = '0x' + '00' * 32
        with self.assertRaises(RuntimeError):
            self.run_batch(send=False)
        receipt['logs'][1]['data'] = '0x' + encode(['uint256'], [UNIT]).hex()
        self.sent.clear()
        with self.assertRaises(RuntimeError):
            self.run_batch(send=False)

    def test_last_recipient_refusal_stops_before_first_transfer(self):
        def refuse_last(to, sig, types=(), args=(), outputs=(), **kw):
            if sig == pay_demo.PAY and args[0] == self.roster['recipients'][2]['address']:
                raise RuntimeError('Cooldown active')
            return self.read(to, sig, types, args, outputs, **kw)

        self.net.read.side_effect = refuse_last
        with self.assertRaisesRegex(RuntimeError, 'Cooldown active'):
            self.run_batch()
        self.assertEqual(self.sent, [])
