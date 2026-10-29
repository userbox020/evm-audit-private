#!/usr/bin/env python3
"""Deterministic sanitized manifest generator for TermMax router-sweep Step2."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "targets" / "termmax"
OUT = ROOT / "reports" / "raw" / "fast" / "critical-termmax-v2-router-sweep-step2-manifest.json"
NETWORKS = ["eth-mainnet", "bnb-mainnet", "xlayer-mainnet", "b2-mainnet", "base-mainnet", "arb-mainnet", "bera-mainnet", "hyperevm-mainnet", "pharos-mainnet"]

STATIC = [
    ("production-source", "targets/termmax/contracts/v2/router/TermMaxRouterV2.sol"),
    ("production-source", "targets/termmax/contracts/v2/router/ITermMaxRouterV2.sol"),
    ("production-source", "targets/termmax/contracts/v2/lib/TransferUtilsV2.sol"),
    ("production-source", "targets/termmax/contracts/v2/tokens/AbstractGearingTokenV2.sol"),
    ("runner", "tools/capture-termmax-v2-router-sweep-step2.js"),
    ("runner", "tools/capture-termmax-v2-router-sweep-step2-economics.js"),
    ("runner", "tools/capture-termmax-v2-router-sweep-step2-r2-supplement.js"),
    ("runner-dependency", "tools/shared-rpc.js"),
    ("runner-dependency", "tools/termmax-v2-ethers-runtime-binding.js"),
    ("runner-dependency-lock", "tools/package-lock.json"),
    ("runner-dependency", "tools/node_modules/ethers/package.json"),
    ("test", "tools/test-termmax-v2-router-sweep-step2.js"),
    ("test", "tools/test-termmax-v2-router-sweep-step2-r2.js"),
    ("manifest-tool", "tools/generate-termmax-v2-router-sweep-step2-manifest.py"),
    ("manifest-tool", "tools/check-termmax-v2-router-sweep-step2-manifest.py"),
    ("report", "reports/critical-termmax-v2-router-sweep-step2.md"),
    ("raw", "reports/raw/fast/critical-termmax-v2-router-sweep-step2.json"),
    ("capture-predecessor", "reports/raw/fast/critical-termmax-v2-router-sweep-step2-capture.json"),
    ("capture-current-state-economics-superseded", "reports/raw/fast/critical-termmax-v2-router-sweep-step2-capture-r2.json"),
    ("economics-predecessor-superseded-non-governing", "reports/raw/fast/critical-termmax-v2-router-sweep-step2-economics.json"),
    ("supplement-current", "reports/raw/fast/critical-termmax-v2-router-sweep-step2-r2-supplement.json"),
    ("economics-current", "reports/raw/fast/critical-termmax-v2-router-sweep-step2-economics-r2.json"),
    ("metadata", "reports/raw/fast/critical-termmax-v2-router-sweep-step2-metadata.json"),
    ("coordination", "coordination/inbox/critical/20260729-0955-critical-termmax-v2-router-sweep-step2.json"),
    ("coordination", "coordination/handoffs/20260729-0955-critical-termmax-v2-router-sweep-step2-handoff.md"),
    ("coordination", "coordination/inbox/critical/20260729-1100-critical-termmax-v2-router-sweep-step2-r2.json"),
    ("coordination", "coordination/handoffs/20260729-1100-critical-termmax-v2-router-sweep-step2-r2-handoff.md"),
    ("coordination", "coordination/inbox/critical/20260729-1120-critical-termmax-v2-router-sweep-step2-packaging-cleanup.json"),
    ("coordination", "coordination/handoffs/20260729-1120-critical-termmax-v2-router-sweep-step2-packaging-cleanup-handoff.md"),
]


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def files() -> list[tuple[str, str]]:
    rows = list(STATIC)
    for network in NETWORKS:
        directory = TARGET / "deployments" / network
        if directory.is_dir():
            for file in directory.rglob("*.json"):
                rows.append(("local-deployment-json", rel(file)))
    broadcast = TARGET / "broadcast"
    if broadcast.is_dir():
        for file in broadcast.rglob("run-latest.json"):
            rows.append(("local-broadcast-json", rel(file)))
    unique = {(category, path) for category, path in rows}
    return sorted(unique, key=lambda row: row[1])


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=TARGET, check=True, text=True, encoding="utf-8", capture_output=True).stdout.strip()


def build() -> dict:
    bound = []
    for category, relative in files():
        path = ROOT / relative
        if not path.is_file():
            raise FileNotFoundError(relative)
        if relative.endswith(".env") or ".env." in relative or relative in {"rpc_endpoints.txt", "graphql_endpoints.txt"}:
            raise ValueError("forbidden manifest input")
        bound.append({"category": category, "path": relative, "bytes": path.stat().st_size, "sha256": sha(path)})
    aggregate = hashlib.sha256(json.dumps(bound, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    runtime_binding = json.loads(subprocess.run(
        ["node", str(ROOT / "tools" / "termmax-v2-ethers-runtime-binding.js")],
        cwd=ROOT,
        check=True,
        text=True,
        encoding="utf-8",
        capture_output=True,
    ).stdout)
    return {
        "schema": "termmax-v2-router-sweep-step2-manifest/v1",
        "classification": "WATCH/CONDITIONAL-LOCAL-SOURCE-ROUTE-POSITIVE/CURRENT-BASE-DUST-ECONOMICS-INCOMPLETE/DEPLOYED-RUNTIME-SOURCE-UNRESOLVED/MULTICHAIN-COVERAGE-PARTIAL",
        "source": {"commit": git("rev-parse", "HEAD"), "tree": git("rev-parse", "HEAD^{tree}"), "worktreeDirty": bool(git("status", "--short"))},
        "secretOrEndpointInventoryFilesBound": 0,
        "envFilesBound": 0,
        "forgeTestsExecuted": 0,
        "runtimeDependencyBinding": runtime_binding,
        "fileCount": len(bound),
        "categoryCounts": dict(sorted(Counter(row["category"] for row in bound).items())),
        "files": bound,
        "filesAggregateSha256": aggregate,
    }


def render(value: dict) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    text = render(build())
    if args.write:
        OUT.write_text(text, encoding="utf-8", newline="\n")
        print(rel(OUT))
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
