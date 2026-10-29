"""Offline fail-closed tests for top-level sentinel coverage."""

import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "build-all-sentinels-coverage.py"
SPEC = importlib.util.spec_from_file_location("build_all_sentinels_coverage", SCRIPT)
coverage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(coverage)

INPUTS = {
    "divergence": r"C:\Users\MiPC\AppData\Local\Temp\opencode\divergence-deployment-smoke-20260926\status-divergence.json",
    "ledger": str(ROOT / "reports/raw/fast/divergence-readiness-step1/readiness-r4.json"),
    "multichain": r"C:\Users\MiPC\AppData\Local\Temp\opencode\canary-readiness-20260925-world-r3\status-multichain.json",
    "multichainHistory": r"C:\Users\MiPC\AppData\Local\Temp\opencode\canary-readiness-20260925-world-r3\history-multichain.json",
    "dedicated": str(ROOT / "reports/raw/fast/exploit-rearm-canary/status.json"),
    "dedicatedHistory": str(ROOT / "reports/raw/fast/exploit-rearm-canary/history.json"),
}


class CoverageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = {name: coverage.read_bounded(path) for name, path in INPUTS.items()}

    def inputs(self):
        return copy.deepcopy(self.fixture)

    def test_valid_421_top_level_rows_remain_blocked(self):
        output = coverage.build(self.inputs())
        self.assertEqual(output["summary"]["universe"], 421)
        self.assertEqual(output["summary"]["bySurface"], {"divergence": 351, "multichain": 67, "dedicated": 3})
        self.assertEqual(output["summary"]["rowCompleteness"]["uniqueTopLevelRows"], 421)
        self.assertEqual(output["summary"]["verifiedProfitable"], 0)
        self.assertEqual(output["summary"]["unknownProfitability"], 421)
        self.assertTrue(all(not r["routeReady"] and not r["liveReady"] and r["profitRank"] is None
                            and r["observationFreshness"] == "not-revalidated"
                            and all(v == "unknown" for v in r["executionGates"].values())
                            for r in output["records"]))

    def test_missing_one_row_fails(self):
        inputs = self.inputs()
        inputs["divergence"]["sentinels"].pop()
        with self.assertRaises(ValueError):
            coverage.build(inputs)

    def test_double_identity_fails(self):
        inputs = self.inputs()
        inputs["multichain"]["sentinels"][1]["sentinel"] = inputs["multichain"]["sentinels"][0]["sentinel"]
        with self.assertRaises(ValueError):
            coverage.build(inputs)

    def test_forged_profit_route_gate_fails(self):
        for modification in ({"routeReady": True}, {"profitRank": 1}, {"gates": {"signedBatchValid": True}}):
            inputs = self.inputs()
            inputs["ledger"]["records"][0].update(modification)
            with self.subTest(modification=modification), self.assertRaises(ValueError):
                coverage.build(inputs)

    def test_forged_source_reported_market_binding_fails(self):
        inputs = self.inputs()
        source = next(r for r in inputs["divergence"]["sentinels"] if not r["ok"])
        ledger_row = next(r for r in inputs["ledger"]["records"]
                          if r["chainId"] == source["chainId"] and r["sentinel"] == source["sentinel"])
        ledger_row["sourceReportedMarketBinding"] = True
        with self.assertRaisesRegex(ValueError, "ledger-source-market-binding-mismatch"):
            coverage.build(inputs)
        inputs = self.inputs()
        source = next(r for r in inputs["divergence"]["sentinels"]
                      if r["ok"] and r.get("measurements", {}).get("collateralToken"))
        source["measurements"].pop("collateralToken")
        with self.assertRaisesRegex(ValueError, "ledger-source-market-binding-mismatch"):
            coverage.build(inputs)

    def test_ledger_run_mismatch_fails(self):
        inputs = self.inputs()
        inputs["ledger"]["sourceRunId"] = "other-run"
        with self.assertRaisesRegex(ValueError, "ledger-run-mismatch"):
            coverage.build(inputs)

    def test_malformed_and_mismatched_history_fail(self):
        inputs = self.inputs()
        inputs["multichainHistory"]["runs"][-1]["runId"] = "other-run"
        with self.assertRaisesRegex(ValueError, "history-run-mismatch"):
            coverage.build(inputs)
        inputs = self.inputs()
        inputs["dedicatedHistory"]["schema"] = "forged-history"
        with self.assertRaisesRegex(ValueError, "invalid-dedicatedHistory"):
            coverage.build(inputs)

    def test_world_unqualified_cursor_not_promoted_to_current_head(self):
        output = coverage.build(self.inputs())
        world = next(r for r in output["records"] if r["id"] == "upgrade:480:world-openxaut")
        self.assertIsNone(world["chainObservedPin"])
        self.assertIsNotNone(world["verifiedCursor"])
        self.assertIsNotNone(world["historicalObservedPin"])
        self.assertIsNone(world["uncoveredFrom"])
        self.assertIsNone(world["uncoveredTo"])
        self.assertEqual(world["uncoveredReason"], "unknown-current-head")

    def test_arc_cursor_gap_uses_qualified_chain_pin_only(self):
        inputs = self.inputs()
        arc = inputs["multichain"]["upgradeState"]["sentinels"]["upgrade:5042:arc-cirbtc"]
        arc["pin"] = 22796208
        arc["arc"]["cursor"] = 22811208
        inputs["multichain"]["chains"]["5042"]["qualified"] = True
        inputs["multichain"]["chains"]["5042"]["block"] = 22813236
        output = coverage.build(inputs)
        row = next(r for r in output["records"] if r["id"] == "upgrade:5042:arc-cirbtc")
        self.assertEqual(row["upgradeStoredPin"], 22796208)
        self.assertEqual(row["verifiedCursor"], 22811208)
        self.assertEqual(row["chainObservedPin"], 22813236)
        self.assertEqual((row["uncoveredFrom"], row["uncoveredTo"]), (22811209, 22813236))
        self.assertEqual(row["uncoveredReason"], "unscanned-after-verified-cursor")

    def test_arc_unqualified_chain_never_promotes_historical_pin(self):
        inputs = self.inputs()
        inputs["multichain"]["chains"]["5042"] = {"qualified": False, "reason": "endpoint-unavailable"}
        output = coverage.build(inputs)
        row = next(r for r in output["records"] if r["id"] == "upgrade:5042:arc-cirbtc")
        self.assertIsNone(row["chainObservedPin"])
        self.assertIsNone(row["uncoveredFrom"])
        self.assertIsNone(row["uncoveredTo"])
        self.assertEqual(row["uncoveredReason"], "unknown-current-head")

    def test_nested_ten_markets_not_extra_sentinels(self):
        output = coverage.build(self.inputs())
        rows = [r for r in output["records"] if "nestedMarketChecks" in r]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], "rh:rh-equity-gap-threshold")
        self.assertTrue(rows[0]["nestedMarketChecks"]["observed"])
        self.assertEqual((rows[0]["nestedMarketChecks"]["count"], rows[0]["nestedMarketChecks"]["ok"],
                          rows[0]["nestedMarketChecks"]["notOk"]), (10, 3, 7))
        self.assertEqual(len(set(rows[0]["nestedMarketChecks"]["marketIds"])), 10)
        self.assertEqual(output["summary"]["universe"], 421)

    def test_nested_market_count_and_ok_distribution_follow_status(self):
        inputs = self.inputs()
        nested = next(r for r in inputs["multichain"]["sentinels"] if r["sentinel"] == "rh:rh-equity-gap-threshold")
        nested["markets"] = nested["markets"][:4]
        for market, ok in zip(nested["markets"], (True, True, False, False)):
            market["ok"] = ok
        output = coverage.build(inputs)
        checks = next(r["nestedMarketChecks"] for r in output["records"] if r["id"] == nested["sentinel"])
        self.assertTrue(checks["observed"])
        self.assertEqual((checks["count"], checks["ok"], checks["notOk"]), (4, 2, 2))
        self.assertEqual(output["summary"]["universe"], 421)

    def test_duplicate_nested_market_id_fails(self):
        inputs = self.inputs()
        nested = next(r for r in inputs["multichain"]["sentinels"] if r["sentinel"] == "rh:rh-equity-gap-threshold")
        nested["markets"][1]["marketId"] = nested["markets"][0]["marketId"]
        with self.assertRaisesRegex(ValueError, "equity-market-identity-invalid"):
            coverage.build(inputs)

    def test_unqualified_equity_endpoint_absent_markets_is_unobserved(self):
        inputs = self.inputs()
        nested = next(r for r in inputs["multichain"]["sentinels"] if r["sentinel"] == "rh:rh-equity-gap-threshold")
        nested["ok"] = False
        nested["error"] = "endpoint-unavailable"
        nested.pop("markets")
        inputs["multichain"]["chains"]["4663"] = {"qualified": False, "reason": "endpoint-unavailable"}
        inputs["multichain"]["verdict"] = "INCOMPLETE"
        output = coverage.build(inputs)
        row = next(r for r in output["records"] if r["id"] == nested["sentinel"])
        self.assertEqual(row["nestedMarketChecks"], {
            "observed": False, "count": None, "ok": None, "notOk": None,
            "marketIds": [], "note": "unobserved-endpoint-unavailable",
        })
        self.assertIn("nested-market-evidence-unavailable", row["blockingReasons"])
        self.assertEqual(output["summary"]["universe"], 421)

    def test_qualified_equity_missing_markets_rejected(self):
        inputs = self.inputs()
        nested = next(r for r in inputs["multichain"]["sentinels"] if r["sentinel"] == "rh:rh-equity-gap-threshold")
        nested.pop("markets")
        with self.assertRaisesRegex(ValueError, "equity-market-count-invalid"):
            coverage.build(inputs)

    def test_unsafe_output_and_symlink_input_fail(self):
        with self.assertRaisesRegex(ValueError, "output-outside-allowlist"):
            coverage.output_path(str(ROOT / "reports/raw/fast/exploit-rearm-canary/status.json"))
        with patch.object(Path, "is_symlink", return_value=True):
            with self.assertRaisesRegex(ValueError, "symlink-refused"):
                coverage.read_bounded(INPUTS["divergence"])


if __name__ == "__main__":
    unittest.main()
