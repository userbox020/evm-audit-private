#!/usr/bin/env python3
"""Check-only, no-write validator for the TermMax V2 Step1 R2 package."""

from __future__ import annotations

import ast
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "targets" / "termmax"
MANIFEST_PATH = ROOT / "reports" / "raw" / "fast" / "critical-termmax-v2-settlement-conservation-step1-r2-manifest.json"
GENERATOR = ROOT / "tools" / "generate-termmax-v2-settlement-step1-r2-manifest.py"
MODEL_R1 = ROOT / "tools" / "validate-termmax-v2-settlement-step1.py"
MODEL_R2 = ROOT / "tools" / "validate-termmax-v2-settlement-step1-r2.py"
OUTPUT_R2 = ROOT / "reports" / "raw" / "fast" / "critical-termmax-v2-settlement-conservation-step1-r2-model-output.json"
RAW_R2 = ROOT / "reports" / "raw" / "fast" / "critical-termmax-v2-settlement-conservation-step1-r2.json"
METADATA = ROOT / "reports" / "raw" / "fast" / "critical-termmax-v2-settlement-conservation-step1-r2-metadata.json"
CLASSIFICATION = "WATCH/CONDITIONAL-LOCAL-ROUTE-POSITIVE/REPOSITORY-SOURCE-CONFIRMED/DEPLOYMENT-UNVERIFIED/FORGE-EXECUTION-BLOCKED"

EXPECTED_PATHS = {
    "targets/termmax/contracts/v2/router/TermMaxRouterV2.sol",
    "targets/termmax/contracts/v2/router/ITermMaxRouterV2.sol",
    "targets/termmax/contracts/v2/router/IERC20SwapAdapter.sol",
    "targets/termmax/contracts/v2/router/swapAdapters/ERC20SwapAdapterV2.sol",
    "targets/termmax/contracts/v2/router/swapAdapters/OkxSwapAdapter.sol",
    "targets/termmax/contracts/v1/extensions/OKXScaleHelper.sol",
    "targets/termmax/contracts/v2/lib/TransferUtilsV2.sol",
    "targets/termmax/contracts/v2/TermMaxMarketV2.sol",
    "targets/termmax/contracts/v2/TermMaxOrderV2.sol",
    "targets/termmax/contracts/v2/tokens/AbstractGearingTokenV2.sol",
    "targets/termmax/contracts/v2/tokens/GearingTokenWithERC20V2.sol",
    "targets/termmax/contracts/v2/tokens/MintableERC20V2.sol",
    "targets/termmax/contracts/v2/vault/TermMaxVaultV2.sol",
    "targets/termmax/contracts/v2/vault/OrderManagerV2.sol",
    "targets/termmax/foundry.toml",
    "targets/termmax/remappings.txt",
    "targets/termmax/soldeer.lock",
    "tools/validate-termmax-v2-settlement-step1.py",
    "tools/validate-termmax-v2-settlement-step1-r2.py",
    "tools/generate-termmax-v2-settlement-step1-r2-manifest.py",
    "tools/check-termmax-v2-settlement-step1-r2-manifest.py",
    "reports/critical-termmax-v2-settlement-conservation-step1.md",
    "reports/raw/fast/critical-termmax-v2-settlement-conservation-step1-r2.json",
    "reports/raw/fast/critical-termmax-v2-settlement-conservation-step1-r2-model-output.json",
    "reports/raw/fast/critical-termmax-v2-settlement-conservation-step1-r2-metadata.json",
    "coordination/inbox/critical/20260729-0845-critical-termmax-v2-step1-r2.json",
    "coordination/handoffs/20260729-0845-critical-termmax-v2-step1-r2-handoff.md",
}

checks = 0


def check(condition: bool, message: str) -> None:
    global checks
    if not condition:
        raise AssertionError(message)
    checks += 1


def run(command: list[str], cwd: Path = ROOT) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(command, cwd=cwd, text=True, encoding="utf-8", capture_output=True, env=env)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    manifest_bytes = MANIFEST_PATH.read_bytes()
    manifest = json.loads(manifest_bytes)
    check(manifest["schema"] == "termmax-v2-settlement-step1-r2-manifest/v1", "manifest schema")
    check(manifest["classification"] == CLASSIFICATION, "manifest classification")
    check(manifest["fileCount"] == len(EXPECTED_PATHS), "manifest file count")
    check({row["path"] for row in manifest["files"]} == EXPECTED_PATHS, "exact manifest path set")
    check(MANIFEST_PATH.relative_to(ROOT).as_posix() not in EXPECTED_PATHS, "manifest is not self-bound")

    for row in manifest["files"]:
        path = ROOT / row["path"]
        check(path.is_file(), f"missing {row['path']}")
        data = path.read_bytes()
        check(len(data) == row["bytes"], f"size mismatch {row['path']}")
        check(sha256(data) == row["sha256"], f"hash mismatch {row['path']}")
        if path.suffix.lower() in {".py", ".json", ".md", ".sol", ".toml", ".txt"}:
            text = data.decode("utf-8")
            check(text.endswith("\n"), f"missing final newline {row['path']}")
            check(all(not line.endswith((" ", "\t")) for line in text.splitlines()), f"trailing whitespace {row['path']}")
            if path.suffix.lower() == ".json":
                json.loads(text)
                check(True, f"JSON syntax {row['path']}")

    canonical_rows = json.dumps(manifest["files"], sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    check(sha256(canonical_rows) == manifest["filesAggregateSha256"], "files aggregate")

    commit = run(["git", "rev-parse", "HEAD"], TARGET)
    tree = run(["git", "rev-parse", "HEAD^{tree}"], TARGET)
    status = run(["git", "status", "--short"], TARGET)
    check(commit.returncode == 0 and commit.stdout.strip() == manifest["source"]["commit"], "source commit")
    check(tree.returncode == 0 and tree.stdout.strip() == manifest["source"]["tree"], "source tree")
    check(status.returncode == 0 and not status.stdout.strip() and not manifest["source"]["worktreeDirty"], "source clean")
    check(not (TARGET / "dependencies").exists() and not manifest["dependencyDirectoryPresent"], "dependencies absent")
    check(manifest["forgeTestsExecuted"] == 0, "zero Forge tests")

    for script in (MODEL_R1, MODEL_R2, GENERATOR, Path(__file__).resolve()):
        ast.parse(script.read_text(encoding="utf-8"), filename=str(script))
        check(True, f"syntax {script.name}")

    raw = json.loads(RAW_R2.read_text(encoding="utf-8"))
    metadata = json.loads(METADATA.read_text(encoding="utf-8"))
    output = json.loads(OUTPUT_R2.read_text(encoding="utf-8"))
    check(raw["classification"] == CLASSIFICATION, "raw classification")
    check(raw["gates"] == {"localSourceRoutePositive": 1, "operationalGlobalRoutePositive": 0, "executableNow": 0, "signedActionJustified": False, "fork": False}, "raw gates")
    check(metadata["predecessorEvidence"]["validatorFunctions"] == 15, "predecessor 15")
    check(metadata["predecessorEvidence"]["sourceSubstringChecks"] == 6, "predecessor six substrings")
    check(metadata["predecessorEvidence"]["pythonModelTests"] == 9, "predecessor nine models")
    check(metadata["predecessorEvidence"]["integerOrderCases"] == 20000, "predecessor 20k integer cases")
    check(metadata["forgeBlocker"]["forgeTestsExecuted"] == 0, "metadata zero Forge tests")
    check(output["regressionCount"] == 7 and output["sourceAnchorCount"] == 23, "R2 model counts")

    r1 = run([sys.executable, str(MODEL_R1)])
    check(r1.returncode == 0, "predecessor validator return code")
    check("Ran 15 tests" in r1.stderr and "OK" in r1.stderr, "predecessor validator 15/15")

    r2 = run([sys.executable, str(MODEL_R2), "--json"])
    check(r2.returncode == 0, "R2 model return code")
    check(json.loads(r2.stdout) == output, "R2 retained output equality")

    generated = run([sys.executable, str(GENERATOR)])
    check(generated.returncode == 0, "generator check-mode return code")
    check(generated.stdout.encode("utf-8") == manifest_bytes, "deterministic manifest reproduction")

    result = {
        "status": "PASS",
        "mode": "check-only-no-write",
        "checksPassed": checks,
        "filesBound": manifest["fileCount"],
        "filesAggregateSha256": manifest["filesAggregateSha256"],
        "manifestSha256": sha256(manifest_bytes),
        "predecessorValidator": "15/15",
        "r2SourceAnchors": output["sourceAnchorCount"],
        "r2Regressions": output["regressionCount"],
        "forgeTestsExecuted": 0,
    }
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
