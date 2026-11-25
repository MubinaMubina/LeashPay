import unittest
from unittest.mock import Mock, patch

from testnet import Testnet, SOURCES


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.net = object.__new__(Testnet)
        self.net.rpc = Mock(return_value='0x38')
        self.net.send = Mock(return_value={'blockNumber': '0x98'})
        self.net.manifest = Mock(return_value={'status': 'confirmed', 'maxPriceAge': 90000,
                                              'usdtFeed': 'mirror-t', 'usdcFeed': 'mirror-c'})
        self.source = {symbol: (10**18, 100000) for symbol in SOURCES}
        self.mirror = {target: (10**18, 100000) for target in ('mirror-t', 'mirror-c')}
        def read(address, method, **kwargs):
            if method == 'decimals()':
                return (18,)
            if kwargs.get('mainnet'):
                symbol = next(symbol for symbol, source in SOURCES.items() if source == address)
                price, timestamp = self.source[symbol]
            else:
                price, timestamp = self.mirror[address]
            return 1, price, timestamp, timestamp, 1
        self.net.read = read

    @patch('testnet.time.time', return_value=100010)
    def test_restart_skips_observations_already_on_chain(self, _):
        for _ in range(2):
            feeds, errors = self.net.relay_cycle()
            self.assertEqual(set(feeds), set(SOURCES))
            self.assertFalse(errors)
        self.net.send.assert_not_called()

    @patch('testnet.time.time', return_value=100010)
    def test_stale_feed_does_not_block_other_feed(self, _):
        self.source['USDT'] = (10**18, 1)
        self.source['USDC'] = (99 * 10**16, 100009)
        def confirm(label, role, target, data):
            self.assertEqual((role, target), ('REPORTER', 'mirror-c'))
            self.mirror[target] = self.source['USDC']
            return {'blockNumber': '0x98'}
        self.net.send.side_effect = confirm
        feeds, errors = self.net.relay_cycle()
        self.assertEqual(set(errors), {'USDT'})
        self.assertEqual(feeds['USDC']['updatedAt'], 100009)
        self.assertEqual(feeds['USDC']['answer'], 99 * 10**16)
        self.net.send.assert_called_once()

    @patch('testnet.time.time', return_value=100010)
    def test_conflicting_equal_timestamp_fails_closed(self, _):
        self.source['USDT'] = (99 * 10**16, 100000)
        feeds, errors = self.net.relay_cycle()
        self.assertNotIn('USDT', feeds)
        self.assertIn('USDT', errors)
        self.net.send.assert_not_called()


class JournalTests(unittest.TestCase):
    def test_restarts_after_interrupted_send_with_identical_transaction(self):
        import json
        import tempfile
        from pathlib import Path
        from eth_account import Account
        from eth_utils import keccak

        net = object.__new__(Testnet)
        account = Account.create()
        net.accounts = {'REPORTER': account}
        net.journal = {'chain_id': 97, 'transactions': {}}
        submissions = []

        def rpc(method, params, **kwargs):
            if method == 'eth_sendRawTransaction':
                submissions.append(params[0])
                if len(submissions) == 1:
                    raise RuntimeError('connection interrupted')
                return '0x' + keccak(hexstr=params[0]).hex()
            return {'eth_estimateGas': '0x10000', 'eth_getTransactionCount': '0x3',
                    'eth_gasPrice': '0x10', 'eth_getTransactionByHash': None}[method]

        net.rpc = rpc
        net.receipt = lambda tx_hash: {'transactionHash': tx_hash}
        with tempfile.TemporaryDirectory() as directory:
            local = Path(directory)
            journal = local / 'journal.json'
            with patch('testnet.JOURNAL', journal), patch('testnet.LOCAL', local):
                with self.assertRaisesRegex(RuntimeError, 'connection interrupted'):
                    net.send('observation', 'REPORTER', account.address, '0x1234')
                net.journal = {}
                net.send('observation', 'REPORTER', account.address, '0x1234')
                record = json.loads(journal.read_text())['transactions']['observation']
        self.assertEqual(submissions, [submissions[0]] * 2)
        self.assertEqual(record['state'], 'confirmed')
        self.assertEqual(record['nonce'], 3)
