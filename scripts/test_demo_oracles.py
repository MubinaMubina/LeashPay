import io
import json
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import requests

import demo_oracles

NOW = datetime(2026, 11, 25, 20, 30, tzinfo=timezone.utc)


class OracleDemoTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.responses = []
        self.output = io.StringIO()
        self.enterContext(redirect_stdout(self.output))
        self.enterContext(patch.object(requests.adapters.HTTPAdapter, "send", self.respond))
        self.enterContext(patch.object(demo_oracles, "datetime", wraps=datetime)).now.return_value = NOW
        self.env = {"CMC_API_KEY": "secret-cmc"}

    def respond(self, request, **kwargs):
        self.calls.append(request)
        status, payload = self.responses.pop(0)
        response = requests.Response()
        response.status_code = status
        response._content = json.dumps(payload).encode()
        response.request = request
        return response

    def quote(self, *, price=58.25, age=0, symbol="USDT"):
        stamp = (NOW - timedelta(minutes=age)).isoformat()
        return {"status": {"error_code": "0"}, "data": [
            {"id": 825, "symbol": symbol, "quote": [
                {"symbol": "PHP", "price": price, "last_updated": stamp}]}]}

    def market(self, id=27009811, outcome="YES", end="2027-01-01T05:00:00Z", title="USDC depeg by December 31?"):
        return {"code": 0, "data": {"markets": [{"matching_confidence": 0.9, "market_info": {
            "id": id, "title": title, "end_time": end,
            "description": "Pyth candles for USDC-USD for any 24-hour period are below 98 cents.",
            "market_outcome": outcome, "market_outcome_price": 0.40}}]}}

    def assessment(self, probability=0.03):
        return {"code": 0, "data": {"probability": {
            "result": {"point_estimate": probability},
            "basis": {"primary_anchor": {"source": "Polymarket",
                      "url": "https://polymarket.com/event/usdc-depeg"}}}}}

    def test_cmc_requests_an_exact_asset_and_conversion_and_shows_the_quote(self):
        self.responses = [(200, self.quote())]
        demo_oracles.cmc(self.env)
        request, = self.calls
        self.assertEqual(urlsplit(request.url).netloc, "pro-api.coinmarketcap.com")
        self.assertEqual(parse_qs(urlsplit(request.url).query), {"id": ["825"], "convert": ["PHP"]})
        self.assertEqual(request.headers["X-CMC_PRO_API_KEY"], "secret-cmc")
        output = self.output.getvalue()
        for value in ["✓", "58.25", "USDT", "PHP", "UTC", "825"]:
            self.assertIn(value, output)
        self.assertNotIn("secret-cmc", output)

    def test_cmc_rejects_stale_invalid_and_wrong_asset_quotes(self):
        for quote in (self.quote(age=120), self.quote(age=-120), self.quote(price=-1),
                      self.quote(price=float("nan")), self.quote(symbol="BTC")):
            with self.subTest(quote=quote):
                self.responses = [(200, quote)]
                with self.assertRaises(RuntimeError):
                    demo_oracles.cmc(self.env)
        self.assertNotIn("✓", self.output.getvalue())

    def test_cmc_requires_access_to_the_pro_project(self):
        with self.assertRaisesRegex(RuntimeError, "CMC_API_KEY"):
            demo_oracles.cmc({})
        self.assertEqual(self.calls, [])

    def test_cournot_uses_assessment_instead_of_market_price_and_switches_only_above_threshold(self):
        for probability, expected in [(0.03, "USDC"), (0.05, "USDC"), (0.07, "USDT")]:
            with self.subTest(probability=probability):
                self.responses = [(200, self.market()), (200, self.assessment(probability))]
                self.output.seek(0)
                self.output.truncate()
                demo_oracles.cournot({"COURNOT_API_KEY": "secret-cournot", "DEPEG_THRESHOLD_PCT": "5"})
                resolve, assess = self.calls[-2:]
                self.assertNotIn("COURNOT-API-KEY", resolve.headers)
                self.assertEqual(assess.headers["COURNOT-API-KEY"], "secret-cournot")
                body = json.loads(assess.body)
                self.assertEqual(body["message"], json.loads(resolve.body)["message"])
                self.assertEqual(list(map(str, body["market_ids"])), ["27009811"])
                shown = self.output.getvalue()
                for value in ["✓", "27009811", "USDC depeg", "Polymarket",
                              "https://polymarket.com/event/usdc-depeg", f"→ {expected}"]:
                    self.assertIn(value, shown)
                self.assertNotIn("secret-cournot", shown)

    def test_wrong_expired_or_unmatched_markets_do_not_trigger_an_assessment(self):
        for market in (self.market(title="USDT depeg by December 31?"), self.market(outcome="NO"),
                       self.market(end="2000-01-01T00:00:00Z"),
                       {"code": 0, "data": {"markets": []}}):
            self.responses = [(200, market)]
            with self.assertRaises(RuntimeError):
                demo_oracles.cournot({})
        self.assertTrue(all(c.url.endswith("/resolve") for c in self.calls))
        self.assertNotIn("✓", self.output.getvalue())

    def test_assessment_uses_the_id_returned_by_this_resolution(self):
        self.responses = [(200, self.market(id=22200536)), (200, self.assessment())]
        demo_oracles.cournot({})
        self.assertEqual(list(map(str, json.loads(self.calls[-1].body)["market_ids"])), ["22200536"])
        self.assertIn("22200536", self.output.getvalue())

    def test_flat_live_response_displays_the_sourced_probability_and_quota(self):
        market = self.market(id=22431456)
        assessed = {"code": 0, "data": {"probability": 0.013, "markets": market["data"]["markets"],
                    "basis": [{"source": "polymarket", "time": "2026-11-25T20:17:26Z",
                               "url": "https://polymarket.com/market/usdc-depeg-by-december-31-968"}],
                    "billing": "free_quota", "free_quota": {"remaining": 1, "ip": "private-value"}}}
        self.responses = [(200, market), (200, assessed)]
        demo_oracles.cournot({})
        shown = self.output.getvalue()
        for value in ("1.3 %", "20:17:26", "polymarket", "restant", "→ USDC"):
            self.assertIn(value, shown)
        self.assertNotIn("private-value", shown)

    def test_response_for_another_market_is_not_used_for_routing(self):
        assessed = self.assessment()
        assessed["data"]["markets"] = self.market(id=999)["data"]["markets"]
        self.responses = [(200, self.market()), (200, assessed)]
        with self.assertRaises(RuntimeError):
            demo_oracles.cournot({})
        self.assertNotIn("✓", self.output.getvalue())

    def test_incomplete_assessment_and_provider_refusal_do_not_route(self):
        for status, data in ((200, self.assessment(2)), (200, {"code": 0, "data": {"probability": 0.02}}),
                             (200, {"code": 4100, "msg": "secret-value"}), (402, {"error": "secret-value"})):
            self.responses = [(200, self.market()), (status, data)]
            with self.assertRaises(RuntimeError) as err:
                demo_oracles.cournot({})
            self.assertNotIn("secret-value", str(err.exception))
        self.assertNotIn("✓", self.output.getvalue())

    def test_cournot_rejects_foreign_key_origin_or_threshold_before_network(self):
        for env in ({"COURNOT_API_URL": "https://elsewhere.example"},
                    {"COURNOT_API_KEY": "secret", "COURNOT_API_KEY_BASE": "https://elsewhere.example"},
                    {"DEPEG_THRESHOLD_PCT": "nan"}, {"DEPEG_THRESHOLD_PCT": "101"}):
            with self.assertRaises(RuntimeError):
                demo_oracles.cournot(env)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
