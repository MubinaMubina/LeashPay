import argparse
import contextlib
import io
import sys
import unittest
from unittest.mock import Mock, patch

import megafuel


class SponsorPolicyTests(unittest.TestCase):
    def run_command(self, args, replies):
        mocked = [Mock(json=Mock(return_value={'result': reply})) for reply in replies]
        with (patch.object(sys, 'argv', ['megafuel', *args]),
              patch.object(megafuel, 'dotenv_values', return_value={'NODEREAL_API_KEY': 'test', 'MEGAFUEL_POLICY_ID': 'demo'}),
              patch.object(megafuel.requests, 'post', side_effect=mocked) as post,
              contextlib.redirect_stdout(io.StringIO())):
            megafuel.main()
        return [call.kwargs['json'] for call in post.call_args_list]

    def setUp(self):
        self.policy = {'uuid': 'demo', 'network': 97, 'name': 'demo', 'activated': True, 'start': 1,
                       'end': 2, 'remainingBalance': '100', 'fromWhitelistEnabled': True}
        self.until = '2099-11-27T09:00:00+07:00'
        self.end = megafuel.deadline(self.until)

    def test_status_only_reads(self):
        calls = self.run_command([], [self.policy])
        self.assertEqual([c['method'] for c in calls], ['pm_getPolicyByUuid'])

    def test_extension_updates_only_end_and_requires_confirmation(self):
        args = ['--until', self.until]
        calls = self.run_command(args, [self.policy, True, {**self.policy, 'end': self.end}])
        self.assertEqual([c['method'] for c in calls], ['pm_getPolicyByUuid', 'pm_updatePolicy', 'pm_getPolicyByUuid'])
        self.assertEqual(calls[1]['params'], [{'uuid': 'demo', 'end': self.end}])
        with self.assertRaisesRegex(RuntimeError, 'not confirmed'):
            self.run_command(args, [self.policy, True, self.policy])

    def test_refuses_wrong_chain_and_ambiguous_timezone(self):
        with self.assertRaisesRegex(RuntimeError, 'testnet'):
            self.run_command(['--until', self.until], [{**self.policy, 'network': 56}])
        with self.assertRaises(argparse.ArgumentTypeError):
            megafuel.deadline('2099-11-27T09:00:00')
