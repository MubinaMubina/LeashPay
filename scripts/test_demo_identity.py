import io
import json
import re
import time
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import jwt
import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

try:
    import demo_identity
except ModuleNotFoundError as exc:
    if exc.name != "demo_identity":
        raise
    demo_identity = None


def response(data):
    res = requests.Response()
    res.status_code = 200
    res._content = b"" if data is None else json.dumps(data).encode()
    return res


class IdentityDemoTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(demo_identity, "Les contrôles des services sont absents")
        self.output = io.StringIO()
        self.enterContext(redirect_stdout(self.output))
        self.enterContext(patch("demo_identity.time.monotonic", side_effect=range(0, 20000, 121)))
        self.env = {
            "LIVING_BRAIN_BRAIN_ID": "demo-brain",
            "LIVING_BRAIN_SUBJECT_ID": "demo-subject",
            "LIVING_BRAIN_API_KEY": "secret-api",
            "NEXT_PUBLIC_PRIVY_APP_ID": "demo-app",
            "PRIVY_APP_SECRET": "secret-app",
        }

    def capture_service(self, mutate, page_body=None):
        sources = {}

        def send(adapter, req, **kwargs):
            self.assertEqual(req.headers["x-subject-id"], "demo-subject")
            self.assertEqual(req.headers["x-api-key"], "secret-api")
            base = "https://api.livingbrain.com/v1/brains/demo-brain"
            if req.method == "POST" and req.url == base + "/captures":
                body = json.loads(req.body)
                self.assertTrue(body["originRef"].startswith("leashpay-demo:"))
                self.assertNotIn("secret", body["content"])
                row = dict(body, id="capture-id", brainId="demo-brain",
                           subjectId="demo-subject", status="completed", affectedPageIds=["page-id"])
                sources[row["id"]] = row
                return response(row)
            if req.method == "GET" and req.url == base + "/sources?ids=capture-id":
                return response({"items": [dict(sources["capture-id"], **mutate)]})
            if req.method == "POST" and req.url == base + "/search":
                query = json.loads(req.body)["query"]
                self.assertIn(query, sources["capture-id"]["content"])
                return response([{"pageId": "page-id", "slug": "run-note"}])
            self.assertEqual((req.method, req.url), ("GET", base + "/pages/run-note"))
            return response({"id": "page-id", "brainId": "demo-brain", "subjectId": "demo-subject",
                             "body": page_body or sources["capture-id"]["content"]})

        return send

    def test_brain_reloads_the_disjoint_run_note(self):
        with patch.object(requests.adapters.HTTPAdapter, "send", self.capture_service({})):
            demo_identity.brain(self.env)
            demo_identity.brain(self.env)
        runs = self.output.getvalue().splitlines()
        self.assertEqual(len(runs), 2)
        self.assertTrue(all("✓" in line for line in runs))
        self.assertNotEqual(runs[0], runs[1])

    def test_old_or_cross_subject_capture_cannot_pass(self):
        for change in ({"content": "old marker"}, {"subjectId": "other"}, {"brainId": "other"},
                       {"id": "old-source"}, {"originRef": "unrelated"}):
            with self.subTest(change=change), patch.object(requests.adapters.HTTPAdapter, "send",
                                                             self.capture_service(change)):
                with self.assertRaises(RuntimeError):
                    demo_identity.brain(self.env)
        self.assertNotIn("✓", self.output.getvalue())

    def test_search_must_return_the_unique_preferred_reference(self):
        def broken_page(*args, **kwargs):
            res = handler(*args, **kwargs)
            data = res.json()
            if isinstance(data, dict) and "body" in data:
                data["body"] = re.sub(r"PAYREF[A-Z0-9]+", "other", data["body"])
                return response(data)
            return res
        handler = self.capture_service({})
        with patch.object(requests.adapters.HTTPAdapter, "send", broken_page):
            with self.assertRaises(RuntimeError):
                demo_identity.brain(self.env)
        self.assertNotIn("✓", self.output.getvalue())

    def test_prepaid_balance_error_is_actionable_and_sanitized(self):
        def refused(*args, **kwargs):
            res = response({"message": "Your prepaid memory balance is too low; top up to continue processing",
                            "body": "private details"})
            res.status_code = 402
            return res
        with patch.object(requests.adapters.HTTPAdapter, "send", refused):
            with self.assertRaisesRegex(RuntimeError, "solde prépayé") as err:
                demo_identity.brain(self.env)
        self.assertNotIn("private details", str(err.exception))

    def privy_service(self, key, credentials=None, token=None, wallets=(), user_id="did:privy:demo"):
        app_url = "https://api.privy.io/v1/apps/demo-app"
        pem = key.public_key().public_bytes(serialization.Encoding.PEM,
                                             serialization.PublicFormat.SubjectPublicKeyInfo).decode()

        def send(adapter, req, **kwargs):
            if req.method == "GET" and req.url == app_url:
                return response({"id": "demo-app", "verification_key": pem})
            if req.method == "GET" and req.url == app_url + "/test_credentials":
                self.assertIn("Authorization", req.headers)
                return response(credentials)
            if req.method == "GET" and req.url == "https://api.privy.io/v1/users/did%3Aprivy%3Ademo":
                self.assertIn("Authorization", req.headers)
                return response({"id": user_id, "linked_accounts": list(wallets)})
            self.assertEqual((req.method, req.url), ("POST", "https://api.privy.io/v1/passwordless/authenticate"))
            self.assertEqual(json.loads(req.body), {"email": "demo@privy.io", "code": "654321"})
            return response({"token": token})

        return send

    def token(self, key, **changes):
        now = int(time.time())
        claims = dict(aud="demo-app", iss="privy.io", sub="did:privy:demo", sid="session-sensitive",
                      iat=now - 40, exp=now + 3600)
        claims.update(changes)
        return jwt.encode(claims, key, algorithm="ES256")

    def test_checks_real_es256_signature_and_app_specific_claims(self):
        key = ec.generate_private_key(ec.SECP256R1())
        with patch.object(requests.adapters.HTTPAdapter, "send", self.privy_service(key)):
            valid = self.token(key)
            demo_identity.privy(dict(self.env, PRIVY_ACCESS_TOKEN=valid))
            self.assertIn("✓", self.output.getvalue())
            self.assertNotIn(valid, self.output.getvalue())
            self.assertNotIn("session-sensitive", self.output.getvalue())
            self.assertIn("aucun wallet EVM associé", self.output.getvalue())
            for token in (self.token(ec.generate_private_key(ec.SECP256R1())),
                          self.token(key, aud="other"), self.token(key, iss="other"),
                          self.token(key, exp=1), self.token(key, sub="other"), self.token(key, sid="")):
                with self.assertRaises(RuntimeError) as fail:
                    demo_identity.privy(dict(self.env, PRIVY_ACCESS_TOKEN=token))
                self.assertNotIn(token, str(fail.exception))
            self.assertEqual(self.output.getvalue().count("✓"), 1)

    def test_wallet_comes_from_verified_user_and_is_displayed_shortened(self):
        key = ec.generate_private_key(ec.SECP256R1())
        address = "0x1234567890abcdef1234567890abcdef12345678"
        wallet = {"type": "wallet", "chain_type": "ethereum", "address": address}
        env = dict(self.env, PRIVY_ACCESS_TOKEN=self.token(key))
        with patch.object(requests.adapters.HTTPAdapter, "send", self.privy_service(key, wallets=[wallet])):
            demo_identity.privy(env)
        self.assertIn("0x1234…5678", self.output.getvalue())
        self.assertNotIn(address, self.output.getvalue())
        with patch.object(requests.adapters.HTTPAdapter, "send",
                          self.privy_service(key, wallets=[wallet], user_id="did:privy:other")):
            with self.assertRaises(RuntimeError):
                demo_identity.privy(env)

    def test_enabled_provider_test_account_logs_in_and_verifies_issued_token(self):
        key = ec.generate_private_key(ec.SECP256R1())
        credentials = {"data": [{"email": "demo@privy.io", "otp_code": "654321"}]}
        handler = self.privy_service(key, credentials=credentials, token=self.token(key))
        with patch.object(requests.adapters.HTTPAdapter, "send", handler):
            demo_identity.privy(self.env)
        self.assertIn("✓", self.output.getvalue())
        self.assertNotIn("654321", self.output.getvalue())

    def test_connectivity_without_test_account_is_an_actionable_failure(self):
        key = ec.generate_private_key(ec.SECP256R1())
        for credentials in (None, {"data": []}):
            with patch.object(requests.adapters.HTTPAdapter, "send", self.privy_service(key, credentials)):
                with self.assertRaisesRegex(RuntimeError, "Enable test accounts"):
                    demo_identity.privy(self.env)
        self.assertNotIn("✓", self.output.getvalue())
