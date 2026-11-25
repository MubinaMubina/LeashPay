"""The source publisher prepares Solidity locally and submits only to BscScan."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('verify_testnet', Path(__file__).with_name('verify-testnet.py'))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class SourceVerificationTests(unittest.TestCase):
    def test_only_etherscan_receives_the_source_bundle(self):
        name = 'src/AtlasRelayFeed.sol'
        bundle = {'language': 'Solidity', 'sources': {name: {'content': (verify.CONTRACTS / name).read_text()}}}
        output = json.dumps(bundle)
        with (patch.object(verify.subprocess, 'run', return_value=Mock(returncode=0, stdout=output)) as forge,
              patch.object(verify.requests, 'request') as request,
              patch.object(verify, 'source_record', return_value={'match': 'exact'}),
              patch.object(verify.time, 'sleep')):
            request.return_value.json.return_value = {'status': '1', 'result': 'test-guid'}
            verify.publish('test-key', '0x01', name + ':AtlasRelayFeed', '1234')
        self.assertIn('--show-standard-json-input', forge.call_args.args[0])
        request.assert_called_once()
        self.assertEqual(request.call_args.args, ('POST', 'https://api.etherscan.io/v2/api'))
        self.assertEqual(request.call_args.kwargs['params']['chainid'], '97')
        self.assertEqual(request.call_args.kwargs['data']['sourceCode'], output)
        self.assertFalse(request.call_args.kwargs['allow_redirects'])

    def test_prepared_bundle_with_an_unrelated_file_never_leaves_the_process(self):
        name = 'src/AtlasRelayFeed.sol'
        sources = {name: {'content': (verify.CONTRACTS / name).read_text()}, '.env': {'content': 'test fixture'}}
        output = json.dumps({'language': 'Solidity', 'sources': sources})
        with (patch.object(verify.subprocess, 'run', return_value=Mock(returncode=0, stdout=output)),
              patch.object(verify.requests, 'request') as request,
              self.assertRaisesRegex(RuntimeError, 'Unexpected source')):
            verify.publish('test-key', '0x01', name + ':AtlasRelayFeed', '1234')
        request.assert_not_called()
