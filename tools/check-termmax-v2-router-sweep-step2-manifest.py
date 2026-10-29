#!/usr/bin/env python3
"""Check-only, no-write integrity validator for TermMax router-sweep Step2."""

from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "targets" / "termmax"
MANIFEST = ROOT / "reports" / "raw" / "fast" / "critical-termmax-v2-router-sweep-step2-manifest.json"
GENERATOR = ROOT / "tools" / "generate-termmax-v2-router-sweep-step2-manifest.py"
TEST = ROOT / "tools" / "test-termmax-v2-router-sweep-step2.js"
TEST_R2 = ROOT / "tools" / "test-termmax-v2-router-sweep-step2-r2.js"
RAW = ROOT / "reports" / "raw" / "fast" / "critical-termmax-v2-router-sweep-step2.json"
CAPTURE = ROOT / "reports" / "raw" / "fast" / "critical-termmax-v2-router-sweep-step2-capture-r2.json"
ECON = ROOT / "reports" / "raw" / "fast" / "critical-termmax-v2-router-sweep-step2-economics.json"
SUPPLEMENT = ROOT / "reports" / "raw" / "fast" / "critical-termmax-v2-router-sweep-step2-r2-supplement.json"
ECON_R2 = ROOT / "reports" / "raw" / "fast" / "critical-termmax-v2-router-sweep-step2-economics-r2.json"
CLASSIFICATION = "WATCH/CONDITIONAL-LOCAL-SOURCE-ROUTE-POSITIVE/CURRENT-BASE-DUST-ECONOMICS-INCOMPLETE/DEPLOYED-RUNTIME-SOURCE-UNRESOLVED/MULTICHAIN-COVERAGE-PARTIAL"
AUTHORED_PREFIXES = ("tools/capture-termmax", "tools/test-termmax", "tools/generate-termmax", "tools/check-termmax", "tools/termmax-v2", "reports/critical-termmax", "reports/raw/fast/critical-termmax", "coordination/inbox/critical/20260729-0955", "coordination/handoffs/20260729-0955", "coordination/inbox/critical/20260729-1100", "coordination/handoffs/20260729-1100", "coordination/inbox/critical/20260729-1120", "coordination/handoffs/20260729-1120")
checks = 0


def check(condition: bool, message: str) -> None:
    global checks
    if not condition:
        raise AssertionError(message)
    checks += 1


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run(command: list[str], cwd: Path = ROOT) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(command, cwd=cwd, text=True, encoding="utf-8", capture_output=True, env=env)


def main() -> None:
    manifest_bytes = MANIFEST.read_bytes()
    manifest = json.loads(manifest_bytes)
    check(manifest["schema"] == "termmax-v2-router-sweep-step2-manifest/v1", "schema")
    check(manifest["classification"] == CLASSIFICATION, "classification")
    check(manifest["secretOrEndpointInventoryFilesBound"] == 0 and manifest["envFilesBound"] == 0, "secret exclusions")
    check(manifest["forgeTestsExecuted"] == 0, "zero Forge tests")
    check(manifest["runtimeDependencyBinding"]["loadedFileCount"] == 169, "runtime files")
    check(manifest["runtimeDependencyBinding"]["loadedFilesAggregateSha256"] == "5699024bd2f7bad8651705fb583b4b2a88209b6c3b10bd5394687afeaefe7602", "runtime aggregate")
    check(manifest["runtimeDependencyBinding"]["packageLockSha256"] == "1eccf9bfc6f868dc5017051c36044e671942d833b68de7bf72403eea41482ed5", "package lock")
    check(manifest["fileCount"] == len(manifest["files"]), "file count")
    check(len({row["path"] for row in manifest["files"]}) == manifest["fileCount"], "unique paths")
    categories = {row["path"]: row["category"] for row in manifest["files"]}
    check(categories["reports/raw/fast/critical-termmax-v2-router-sweep-step2-capture-r2.json"] == "capture-current-state-economics-superseded", "capture category")
    check(categories["reports/raw/fast/critical-termmax-v2-router-sweep-step2-economics.json"] == "economics-predecessor-superseded-non-governing", "predecessor category")
    check(MANIFEST.relative_to(ROOT).as_posix() not in {row["path"] for row in manifest["files"]}, "not self-bound")
    for row in manifest["files"]:
        relative = row["path"]
        check(not relative.endswith(".env") and ".env." not in relative, "no env path")
        check(Path(relative).name not in {"rpc_endpoints.txt", "graphql_endpoints.txt"}, "no endpoint inventory path")
        path = ROOT / relative
        check(path.is_file(), f"exists {relative}")
        data = path.read_bytes()
        check(len(data) == row["bytes"], f"size {relative}")
        check(sha(data) == row["sha256"], f"hash {relative}")
        if relative.startswith(AUTHORED_PREFIXES):
            text = data.decode("utf-8")
            check(text.endswith("\n"), f"newline {relative}")
            check(all(not line.endswith((" ", "\t")) for line in text.splitlines()), f"whitespace {relative}")
            if path.suffix == ".json":
                json.loads(text); check(True, f"json {relative}")
    canonical = json.dumps(manifest["files"], sort_keys=True, separators=(",", ":")).encode()
    check(sha(canonical) == manifest["filesAggregateSha256"], "aggregate")
    commit = run(["git", "rev-parse", "HEAD"], TARGET)
    tree = run(["git", "rev-parse", "HEAD^{tree}"], TARGET)
    status = run(["git", "status", "--short"], TARGET)
    check(commit.returncode == 0 and commit.stdout.strip() == manifest["source"]["commit"], "commit")
    check(tree.returncode == 0 and tree.stdout.strip() == manifest["source"]["tree"], "tree")
    check(status.returncode == 0 and not status.stdout.strip() and not manifest["source"]["worktreeDirty"], "clean target")
    for script in [GENERATOR, Path(__file__).resolve()]:
        ast.parse(script.read_text(encoding="utf-8"), filename=str(script)); check(True, f"python syntax {script.name}")
    for script in [ROOT / "tools" / "capture-termmax-v2-router-sweep-step2.js", ROOT / "tools" / "capture-termmax-v2-router-sweep-step2-economics.js", ROOT / "tools" / "capture-termmax-v2-router-sweep-step2-r2-supplement.js", ROOT / "tools" / "termmax-v2-ethers-runtime-binding.js", TEST, TEST_R2]:
        checked = run(["node", "--check", str(script)])
        check(checked.returncode == 0, f"node syntax {script.name}")
    test = run(["node", str(TEST)])
    check(test.returncode == 0, "offline fixture return")
    test_output = json.loads(test.stdout)
    check(test_output["status"] == "PASS" and test_output["captureTokenRows"] == 70 and test_output["nonzeroRows"] == 1, "offline fixture output")
    check(test_output["blockedChainsNull"] == 4 and test_output["predecessorEconomicsGoverning"] is False, "offline cleanup fixture output")
    test_r2 = run(["node", str(TEST_R2)])
    check(test_r2.returncode == 0, "R2 fixture return")
    test_r2_output = json.loads(test_r2.stdout)
    check(test_r2_output["status"] == "PASS" and test_r2_output["pairs"] == 18 and test_r2_output["traceDeltaProven"], "R2 fixture output")
    raw = json.loads(RAW.read_text(encoding="utf-8"))
    capture = json.loads(CAPTURE.read_text(encoding="utf-8"))
    econ = json.loads(ECON.read_text(encoding="utf-8"))
    supplement = json.loads(SUPPLEMENT.read_text(encoding="utf-8"))
    econ_r2 = json.loads(ECON_R2.read_text(encoding="utf-8"))
    check(raw["classification"] == CLASSIFICATION, "raw classification")
    check(raw["gates"]["localSourceRoutePositive"] == 1 and raw["gates"]["operationalGlobalRoutePositive"] == 0 and raw["gates"]["executableNow"] == 0, "raw gates")
    check(not raw["gates"]["standaloneRouteNegativeProven"] and not raw["gates"]["marginalOrBatchedRouteNegativeProven"], "corrected economic gates")
    check(capture["aggregate"]["routerCandidates"] == 8 and capture["aggregate"]["tokenRows"] == 70, "capture counts")
    check(capture["aggregate"]["nonzeroTokenRows"] == 1 and capture["aggregate"]["successfulSimulations"] == 1, "capture nonzero/sim")
    check(capture["aggregate"]["staleAllowanceRows"] == 0 and capture["aggregate"]["operationalRoutePositive"] == 0, "capture gates")
    bnb = next(row for row in capture["chains"] if row["chainId"] == 56)
    blocked = [row for row in capture["chains"] if row["chainId"] in {196, 223, 80094, 688688}]
    check(bnb["economics"]["routePositive"] is None and bnb["economics"]["positiveRows"] is None and "not an all-zero" in bnb["economics"]["reason"], "BNB no-row normalization")
    check(len(blocked) == 4 and all(row["economics"]["routePositive"] is None and row["economics"]["executableNow"] is None for row in blocked), "blocked chain nulls")
    check(econ["artifactStatus"] == "superseded-non-governing" and econ["governing"] is False, "predecessor economics non-governing")
    check(econ["simulation"]["estimateGasObserved"] == "76604" and econ["simulation"]["estimateGasUsedAsMinimum"] is False, "predecessor estimate is observation")
    check(econ["economics"]["historicalEstimateBasedNetUsdBeforeAdditionalFees"] == "-0.00023754679457", "predecessor scenario value retained")
    check(econ["economics"]["routePositive"] is None and econ["economics"]["executableNow"] is None, "predecessor gates null")
    check(econ_r2["supersedesAsGoverningEconomics"].endswith("step2-economics.json"), "economics successor lineage")
    check(econ_r2["predecessorStatus"] == "superseded-non-governing-historical-estimate-based-scenario", "successor predecessor status")
    check(econ_r2["standalone"]["provenMinimumTotalCostWei"] is None and econ_r2["standalone"]["netStatus"] == "incomplete", "standalone incomplete")
    check(econ_r2["marginalOrBatched"]["incrementalCostWei"] is None and econ_r2["marginalOrBatched"]["netStatus"] == "incomplete", "marginal incomplete")
    check(supplement["allowances"]["successfulAgreedPairs"] == 18 and len(supplement["allowances"]["rows"]) == 18, "allowance rows")
    check(supplement["recipientRouterDeltaTrace"]["recipientDeltaProven"], "trace delta")
    generated = run([sys.executable, str(GENERATOR)])
    check(generated.returncode == 0 and generated.stdout.encode() == manifest_bytes, "deterministic regeneration")
    for artifact in [RAW, CAPTURE, ECON, SUPPLEMENT, ECON_R2, ROOT / "reports" / "raw" / "fast" / "critical-termmax-v2-router-sweep-step2-metadata.json"]:
        text = artifact.read_text(encoding="utf-8")
        check(not re.search(r"https?://", text, re.I), f"URL leak {artifact.name}")
        check(not re.search(r"[a-z0-9-]+\.(?:com|io|org|net|xyz|app|dev|cloud)\b", text, re.I), f"domain leak {artifact.name}")
    result = {
        "status": "PASS",
        "mode": "check-only-no-write",
        "checksPassed": checks,
        "offlineFixtureChecks": test_output["checksPassed"],
        "r2FixtureChecks": test_r2_output["checksPassed"],
        "filesBound": manifest["fileCount"],
        "filesAggregateSha256": manifest["filesAggregateSha256"],
        "manifestSha256": sha(manifest_bytes),
        "tokenRows": capture["aggregate"]["tokenRows"],
        "nonzeroRows": capture["aggregate"]["nonzeroTokenRows"],
        "operationalRoutePositive": 0,
        "fork": False,
    }
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
