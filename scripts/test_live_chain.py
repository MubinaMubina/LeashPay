import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import demo_services
from demo_chain import active_run, demo_payment, inspect_observation, validate_plan
from seed_demo import ROSTER, UNIT


class LiveChainTests(unittest.TestCase):
    def test_interruption_keeps_same_reference_and_a_named_rerun_is_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'pending'
            first = active_run(path, None)
            self.assertEqual(active_run(path, None), first)
            with self.assertRaises(RuntimeError):
                active_run(path, 'different')
            self.assertEqual(path.read_text().strip(), first)
            path.unlink()
            self.assertNotEqual(active_run(path, None), first)
            path.unlink()
            self.assertEqual(active_run(path, 'jury-1'), 'jury-1')
            self.assertEqual(active_run(path, 'jury-1'), 'jury-1')

    def test_cannot_authorize_different_or_extra_payment(self):
        roster = json.loads(ROSTER.read_text())
        marco = demo_payment(roster)
        plan = {'chainId': 97, 'vault': roster['vault'], 'token': roster['token'],
                'payments': [{'name': 'Marco', 'address': marco['address'], 'amount': str(UNIT)}]}
        validate_plan(plan, roster)
        for key, value in [('chainId', 56), ('token', roster['vault']), ('payments', plan['payments'] * 2),
                           ('payments', [{**plan['payments'][0], 'amount': str(UNIT * 2)}]),
                           ('payments', [{**plan['payments'][0], 'address': roster['recipients'][0]['address']}])]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                validate_plan({**plan, key: value}, roster)

    def test_rejects_expired_future_or_mismatched_prices(self):
        inspect_observation('USDT', (UNIT, 1000), (UNIT, 1000), 1050, 50)
        for obs, time in [((UNIT, 1001), 1050), ((UNIT - 1, 1000), 1050),
                          ((UNIT, 1000), 1051), ((UNIT, 1000), 999), ((0, 1000), 1050)]:
            with self.subTest(obs=obs, time=time), self.assertRaises(RuntimeError):
                inspect_observation('USDT', obs, (UNIT, 1000), time, 50)

    def test_end_to_end_stops_before_signer_when_planner_or_price_fails(self):
        roster = json.loads(ROSTER.read_text())
        valid = {'chainId': 97, 'vault': roster['vault'], 'token': roster['token'], 'payments': [
            {'name': 'Marco', 'address': demo_payment(roster)['address'], 'amount': str(UNIT)}]}
        for candidate, reason in ((valid, 'Prix périmé'), ({**valid, 'payments': []}, 'Le plan doit contenir')):
            with (self.subTest(reason=reason), redirect_stdout(io.StringIO()),
                  patch('demo_services.planner', return_value=candidate), patch('demo_oracles.cmc'),
                  patch('demo_services.atlas', side_effect=RuntimeError('Prix périmé')),
                  patch('demo_services.payment') as send):
                with self.assertRaisesRegex(RuntimeError, reason):
                    demo_services.run('demo', {})
                send.assert_not_called()
