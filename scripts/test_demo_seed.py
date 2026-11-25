import json
import unittest
from unittest.mock import Mock

from testnet import calldata
import seed_demo


class DemoSeedTests(unittest.TestCase):
    def setUp(self):
        self.roster = json.loads(seed_demo.ROSTER.read_text())
        self.m = json.loads((seed_demo.ROSTER.parent / '97.json').read_text())
        self.people = self.roster['recipients']
        self.vault = self.roster['vault']
        self.net = Mock()
        self.net.manifest.return_value = self.m
        self.net.journal = {'transactions': {}}
        self.net.rpc.return_value = '0x100'
        self.net.read.side_effect = self.read
        self.net.send.side_effect = self.send
        self.signer = Mock(return_value=self.net)
        self.token_balance = 993 * 10**18
        self.daily_spent = 0
        self.state = {self.people[0]['address']: (True, 1000 * 10**18, 6 * 10**18, 1)}
        self.writes = []

    def read(self, to, sig, types=(), args=(), outputs=(), **kw):
        if sig == 'recipientInfo(address)':
            return self.state.get(args[0], (False, 0, 0, 0))
        if sig == 'pay(address,address,uint256,bytes32)':
            self.assertEqual(kw['sender'], self.m['agent'])
            self.assertTrue(self.state[args[0]][0])
            return '0x'
        return {
            'vaultOf(address)': (self.vault,), 'owner()': (self.m['deployer'],),
            'agent()': (self.m['agent'],), 'paused()': (False,), 'isTokenAllowed(address)': (True,),
            'rules()': ((500 * 10**18, 1000 * 10**18, 60, 200, 1000 * 10**18, 0),),
            'spentToday()': (self.daily_spent,), 'balanceOf(address)': (self.token_balance,),
        }[sig]

    def send(self, label, role, vault, data):
        self.assertEqual((role, vault), ('DEPLOYER', self.vault))
        for person in self.people:
            address, cap = person['address'], person['monthlyCapTokens'] * 10**18
            if data == calldata('setRecipient(address,bool,uint256)', ['address', 'bool', 'uint256'], [address, True, cap]):
                self.writes.append(address)
                self.state[address] = (True, cap, 0, 0)
                return {'transactionHash': '0x' + '12' * 32, 'blockNumber': '0x100'}
        self.fail('Unexpected state-changing call')

    def run_seed(self):
        return seed_demo.seed(self.net, self.roster, self.signer)

    def test_two_missing_first_run_zero_signatures_on_rerun(self):
        self.run_seed()
        self.assertEqual(self.writes, [r['address'] for r in self.people[1:]])
        self.signer.reset_mock()
        self.run_seed()
        self.signer.assert_not_called()
        self.assertEqual(len(self.writes), 2)
        self.assertEqual(self.state[self.people[0]['address']][2], 6 * 10**18)

    def test_partial_completion_only_adds_remaining_recipient(self):
        self.state[self.people[1]['address']] = (True, 10 * 10**18, 0, 0)
        self.run_seed()
        self.assertEqual(self.writes, [self.people[2]['address']])

    def test_conflicting_last_recipient_preserves_every_policy(self):
        self.state[self.people[2]['address']] = (False, 4 * 10**18, 0, 0)
        with self.assertRaises(RuntimeError):
            self.run_seed()
        self.signer.assert_not_called()

    def test_insufficient_combined_balance_or_daily_limit_stops_before_signing(self):
        self.token_balance = 2 * 10**18
        with self.assertRaises(RuntimeError):
            self.run_seed()
        self.token_balance = 100 * 10**18
        self.daily_spent = 998 * 10**18
        with self.assertRaises(RuntimeError):
            self.run_seed()
        self.signer.assert_not_called()

    def test_duplicate_address_rejected_before_signing(self):
        self.people[2]['address'] = self.people[1]['address']
        with self.assertRaises(RuntimeError):
            self.run_seed()
        self.signer.assert_not_called()
