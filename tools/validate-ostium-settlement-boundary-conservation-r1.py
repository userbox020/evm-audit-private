#!/usr/bin/env python3
"""Check-only validator for the offline Ostium settlement-boundary R1 package."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "targets" / "ostium"
FINAL_NAME = "ostium-settlement-boundary-conservation-r1"
FILES = {"model.json", "observations.json", "test-result.json", "manifest.json"}
CASES = [
    "A_DEADLINE_MINUS_1", "A_DEADLINE_EXACT", "A_DEADLINE_PLUS_1",
    "B_OPEN_PNL_ZERO_DELTA", "B_OPEN_PNL_POSITIVE_BELOW_CAP", "B_OPEN_PNL_EXACT_CONFIGURED_CAP",
    "B_OPEN_PNL_ONE_ABOVE_CONFIGURED_CAP", "B_OPEN_PNL_VAULT_VALUE_CAP", "B_OPEN_PNL_EQUAL_CAPS",
    "B_OPEN_PNL_LARGE_NEGATIVE_NONDIVISIBLE", "B_OPEN_PNL_ZERO_SUPPLY_POSITIVE", "B_OPEN_PNL_ZERO_SUPPLY_NEGATIVE",
    "C_MIXED_WITHDRAWAL_FIRST_PINNED_PRICE", "C_FULL_WITHDRAWAL_REJECT_RECLAIM",
    "C_DEPOSIT_BLOCKED_RECLAIM", "C_CAPPED_MULTI_USER_PRORATA_DUST",
    "D_MM_POSITIVE_BEFORE_REFRESH", "D_MM_NEGATIVE_AFTER_REFRESH_FLOOR", "D_MM_NON_MM_REJECTION",
    "D_MM_OVER_BUFFER_ROLLBACK", "D_MM_INSUFFICIENT_BALANCE_ROLLBACK", "E_NONZERO_THRESHOLD_DERIVATIONS",
]
DECIMAL = re.compile(r"^(?:0|-?[1-9][0-9]*)$")
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}(?![0-9a-fA-F])")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def trunc_zero(a: int, b: int) -> int:
    assert b > 0
    return abs(a) // b * (-1 if a < 0 else 1)


def floor_signed(a: int, b: int) -> int:
    q = trunc_zero(a, b)
    return q - 1 if a < 0 and a % b else q


def metric(cases: dict[str, dict], case_id: str, name: str) -> int:
    rows = [x for x in cases[case_id]["metrics"] if x["name"] == name]
    assert len(rows) == 1, f"missing/duplicate metric {case_id}.{name}"
    assert DECIMAL.fullmatch(rows[0]["value"]), f"noncanonical decimal {case_id}.{name}"
    assert isinstance(rows[0]["unit"], str) and rows[0]["unit"], "metric unit required"
    return int(rows[0]["value"])


def walk(node):
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from walk(value)


def validate_assertion_flags(document: dict) -> None:
    for key in ("runtimeAssertion", "deploymentAssertion", "currentStateAssertion", "economicsAssertion"):
        assert document.get(key) is False, f"{key} must be false"
    assert document.get("routePositive") is None
    assert document.get("fork") is False


def validate(directory: Path) -> dict:
    assert directory.is_dir(), f"missing package directory: {directory}"
    assert {p.name for p in directory.iterdir()} == FILES, "package must contain exactly four authoritative files"
    for path in directory.iterdir():
        assert not ADDRESS.search(path.read_text(encoding="utf-8")), f"address forbidden in {path.name}"

    model = load(directory / "model.json")
    obs = load(directory / "observations.json")
    result = load(directory / "test-result.json")
    manifest = load(directory / "manifest.json")
    for doc in (model, obs, result, manifest):
        validate_assertion_flags(doc)
        assert doc["classification"] == "LOCAL_SOURCE_BEHAVIOR_CONFIRMED"

    assert model["schema"] == "ostium-settlement-boundary-conservation-r1-model/v1"
    assert obs["schema"] == "ostium-settlement-boundary-conservation-r1-observations/v1"
    assert result["schema"] == "ostium-settlement-boundary-conservation-r1-test-result/v1"
    assert manifest["schema"] == "ostium-settlement-boundary-conservation-r1-manifest/v1"
    assert obs["caseCount"] == len(CASES)
    ids = [x["caseId"] for x in obs["cases"]]
    assert ids == CASES and len(ids) == len(set(ids)), "unknown, missing, reordered, or duplicate case IDs"
    assert all(x["status"] == "PASS" for x in obs["cases"])
    cases = {x["caseId"]: x for x in obs["cases"]}

    # Independent stdlib arithmetic checks (does not import or trust the JS oracle).
    assert [metric(cases, f"A_DEADLINE_{x}", "deadlineOffset") for x in ("MINUS_1", "EXACT", "PLUS_1")] == [-1, 0, 1]
    assert [metric(cases, f"A_DEADLINE_{x}", "settlements") for x in ("MINUS_1", "EXACT", "PLUS_1")] == [0, 1, 1]
    negative = -9_876_543_210_123_456_789_012_345
    assert metric(cases, "B_OPEN_PNL_LARGE_NEGATIVE_NONDIVISIBLE", "accDeltaTruncTowardZero") == trunc_zero(negative * 10**6, 3_000_001)
    assert metric(cases, "B_OPEN_PNL_ZERO_SUPPLY_POSITIVE", "accepted") == 0
    assert metric(cases, "B_OPEN_PNL_ZERO_SUPPLY_NEGATIVE", "accepted") == -7 * 10**18
    scale = 7 * 10**18 // 12
    a, b = 7 * scale // 10**18, 5 * scale // 10**18
    assert metric(cases, "C_CAPPED_MULTI_USER_PRORATA_DUST", "scale") == scale
    assert metric(cases, "C_CAPPED_MULTI_USER_PRORATA_DUST", "aliceAllocation") == a
    assert metric(cases, "C_CAPPED_MULTI_USER_PRORATA_DUST", "bobAllocation") == b
    assert metric(cases, "C_CAPPED_MULTI_USER_PRORATA_DUST", "residualVaultShares") == 7 - a - b
    expected_floor = floor_signed(-(1_000_001 * 10**6) * 10**18, 10_000_003 * 10**6)
    assert metric(cases, "D_MM_NEGATIVE_AFTER_REFRESH_FLOOR", "negativeFloorDelta") == expected_floor
    assert metric(cases, "E_NONZERO_THRESHOLD_DERIVATIONS", "threshold") > 0

    assert result["compile"]["exitCode"] == 0 and result["test"]["exitCode"] == 0
    assert result["test"]["passing"] == 4 and result["test"]["failing"] == 0
    assert result["caseCount"] == len(CASES)
    assert model["caseIds"] == CASES and model["caseCount"] == len(CASES)
    assert model["historicalContext"] == []

    build_rel = model["build"]["buildInfoPath"]
    artifact_rel = model["build"]["artifactPath"]
    build_path, artifact_path = ROOT / build_rel, ROOT / artifact_rel
    assert sha(build_path) == model["build"]["buildInfoSha256"]
    assert sha(artifact_path) == model["build"]["artifactSha256"]
    build = load(build_path)
    artifact = load(artifact_path)
    assert build["solcVersion"] == "0.8.24"
    assert build["solcLongVersion"] == "0.8.24+commit.e11b9ed9"
    assert model["compiler"]["longVersion"] == build["solcLongVersion"]
    assert artifact["sourceName"] == "src/OstiumVault.sol" and artifact["contractName"] == "OstiumVault"
    assert model["build"]["fqn"] == "src/OstiumVault.sol:OstiumVault"
    assert model["build"]["compilerSettings"] == build["input"]["settings"]
    assert hashlib.sha256(artifact["deployedBytecode"].encode()).hexdigest() == model["build"]["artifactRuntimeBytecodeSha256"]
    assert obs["deployment"]["vaultImplementationRuntimeKeccak256"] == obs["deployment"]["artifactRuntimeKeccak256"]

    closure = model["build"]["sourceClosure"]
    assert set(closure) == set(build["input"]["sources"])
    for source_name, expected in closure.items():
        content = build["input"]["sources"][source_name]["content"].encode()
        assert hashlib.sha256(content).hexdigest() == expected
        disk = TARGET / ("node_modules" if source_name.startswith("@") else "") / source_name
        assert disk.read_bytes() == content, f"build input differs from disk: {source_name}"

    ast = build["output"]["sources"]["src/OstiumVault.sol"]["ast"]
    definitions = {(n.get("nodeType"), n.get("name")) for n in walk(ast)}
    for tripwire in model["build"]["astTripwires"]:
        assert (tripwire["nodeType"], tripwire["name"]) in definitions, f"AST tripwire missing: {tripwire}"

    for binding in model["inputBindings"] + model["overlays"]:
        path = ROOT / binding["path"]
        assert path.is_file() and sha(path) == binding["sha256"], f"binding mismatch: {binding['path']}"

    git = lambda *args: subprocess.run(["git", *args], cwd=TARGET, check=True, text=True, capture_output=True).stdout.strip()
    assert git("rev-parse", "HEAD") == model["repository"]["commit"]
    assert git("rev-parse", "HEAD^{tree}") == model["repository"]["tree"]
    assert git("diff", "--", "src/OstiumVault.sol", "src/OstiumRegistry.sol", "src/interfaces/IOstiumVault.sol", "src/interfaces/IOstiumRegistry.sol") == ""

    cache = Path(os.environ["LOCALAPPDATA"]) / "hardhat-nodejs" / "Cache" / "compilers-v2" / "windows-amd64"
    compiler = cache / model["compiler"]["executable"]
    assert compiler.is_file() and sha(compiler) == model["compiler"]["executableSha256"]
    version = subprocess.run([str(compiler), "--version"], check=True, text=True, capture_output=True).stdout
    assert "0.8.24+commit.e11b9ed9" in version

    hashes = manifest["authoritativeFileSha256"]
    assert set(hashes) == {"model.json", "observations.json", "test-result.json"}
    for name, expected in hashes.items():
        assert sha(directory / name) == expected
    assert "manifest.json" not in hashes and "validatorReceipt" not in manifest
    assert manifest["packageDirectory"] == FINAL_NAME
    return {"cases": len(CASES), "sources": len(closure), "bindings": len(model["inputBindings"]), "overlays": len(model["overlays"])}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    summary = validate(args.directory.resolve())
    print(f"PASS check-only: {summary['cases']} cases, {summary['sources']} source files, "
          f"{summary['bindings']} bindings, {summary['overlays']} overlays")


if __name__ == "__main__":
    main()
