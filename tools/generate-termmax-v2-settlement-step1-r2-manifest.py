#!/usr/bin/env python3
"""Deterministic manifest generator for TermMax V2 Step1 R2."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "targets" / "termmax"
MANIFEST = ROOT / "reports" / "raw" / "fast" / "critical-termmax-v2-settlement-conservation-step1-r2-manifest.json"

FILES = [
    ("production-source", "targets/termmax/contracts/v2/router/TermMaxRouterV2.sol"),
    ("production-source", "targets/termmax/contracts/v2/router/ITermMaxRouterV2.sol"),
    ("production-source", "targets/termmax/contracts/v2/router/IERC20SwapAdapter.sol"),
    ("production-source", "targets/termmax/contracts/v2/router/swapAdapters/ERC20SwapAdapterV2.sol"),
    ("production-source", "targets/termmax/contracts/v2/router/swapAdapters/OkxSwapAdapter.sol"),
    ("production-source", "targets/termmax/contracts/v1/extensions/OKXScaleHelper.sol"),
    ("production-source", "targets/termmax/contracts/v2/lib/TransferUtilsV2.sol"),
    ("production-source", "targets/termmax/contracts/v2/TermMaxMarketV2.sol"),
    ("production-source", "targets/termmax/contracts/v2/TermMaxOrderV2.sol"),
    ("production-source", "targets/termmax/contracts/v2/tokens/AbstractGearingTokenV2.sol"),
    ("production-source", "targets/termmax/contracts/v2/tokens/GearingTokenWithERC20V2.sol"),
    ("production-source", "targets/termmax/contracts/v2/tokens/MintableERC20V2.sol"),
    ("production-source", "targets/termmax/contracts/v2/vault/TermMaxVaultV2.sol"),
    ("production-source", "targets/termmax/contracts/v2/vault/OrderManagerV2.sol"),
    ("dependency-lock", "targets/termmax/foundry.toml"),
    ("dependency-lock", "targets/termmax/remappings.txt"),
    ("dependency-lock", "targets/termmax/soldeer.lock"),
    ("test-model", "tools/validate-termmax-v2-settlement-step1.py"),
    ("test-model", "tools/validate-termmax-v2-settlement-step1-r2.py"),
    ("manifest-tool", "tools/generate-termmax-v2-settlement-step1-r2-manifest.py"),
    ("manifest-tool", "tools/check-termmax-v2-settlement-step1-r2-manifest.py"),
    ("report", "reports/critical-termmax-v2-settlement-conservation-step1.md"),
    ("raw", "reports/raw/fast/critical-termmax-v2-settlement-conservation-step1-r2.json"),
    ("output", "reports/raw/fast/critical-termmax-v2-settlement-conservation-step1-r2-model-output.json"),
    ("metadata", "reports/raw/fast/critical-termmax-v2-settlement-conservation-step1-r2-metadata.json"),
    ("coordination", "coordination/inbox/critical/20260729-0845-critical-termmax-v2-step1-r2.json"),
    ("coordination", "coordination/handoffs/20260729-0845-critical-termmax-v2-step1-r2-handoff.md"),
]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=TARGET, check=True, text=True, encoding="utf-8", capture_output=True
    ).stdout.strip()


def build_manifest() -> dict:
    rows = []
    for category, relative in FILES:
        path = ROOT / relative
        if not path.is_file():
            raise FileNotFoundError(relative)
        rows.append({"category": category, "path": relative, "bytes": path.stat().st_size, "sha256": digest(path)})
    rows.sort(key=lambda row: row["path"])
    aggregate = hashlib.sha256(
        json.dumps(rows, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).hexdigest()
    return {
        "schema": "termmax-v2-settlement-step1-r2-manifest/v1",
        "classification": "WATCH/CONDITIONAL-LOCAL-ROUTE-POSITIVE/REPOSITORY-SOURCE-CONFIRMED/DEPLOYMENT-UNVERIFIED/FORGE-EXECUTION-BLOCKED",
        "source": {
            "commit": git("rev-parse", "HEAD"),
            "tree": git("rev-parse", "HEAD^{tree}"),
            "worktreeDirty": bool(git("status", "--short")),
        },
        "dependencyDirectoryPresent": (TARGET / "dependencies").is_dir(),
        "forgeTestsExecuted": 0,
        "seed": 0x7E4D4A,
        "fileCount": len(rows),
        "categoryCounts": dict(sorted(Counter(row["category"] for row in rows).items())),
        "files": rows,
        "filesAggregateSha256": aggregate,
    }


def render(manifest: dict) -> str:
    return json.dumps(manifest, indent=2, sort_keys=True) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="write the versioned manifest")
    args = parser.parse_args()
    text = render(build_manifest())
    if args.write:
        MANIFEST.write_text(text, encoding="utf-8", newline="\n")
        print(MANIFEST.relative_to(ROOT).as_posix())
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
