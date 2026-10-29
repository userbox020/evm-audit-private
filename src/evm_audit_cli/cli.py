from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

try:
    import tomllib  # type: ignore[import-not-found]
except ModuleNotFoundError:  # Python 3.10 compatibility.
    tomllib = None  # type: ignore[assignment]


PROFILES = ("fast", "standard", "deep", "formal", "deployed", "monitor", "full")
UTC = dt.timezone.utc
ADDRESS_PATTERN = re.compile(r"^0x[a-fA-F0-9]{40}$")
SEVERITY_ORDER = {
    "informational": 0,
    "info": 0,
    "note": 0,
    "low": 1,
    "medium": 2,
    "warning": 2,
    "moderate": 2,
    "high": 3,
    "error": 3,
    "critical": 4,
}

CHAIN_PRESETS: dict[str, dict[str, Any]] = {
    "ethereum": {
        "name": "Ethereum Mainnet",
        "chain_id": 1,
        "rpc_url_env": "ETHEREUM_RPC_URL",
        "explorer": "Etherscan",
        "explorer_url": "https://etherscan.io",
        "explorer_api_url": "https://api.etherscan.io/api",
        "explorer_api_key_env": "ETHERSCAN_API_KEY",
    },
    "sepolia": {
        "name": "Ethereum Sepolia",
        "chain_id": 11155111,
        "rpc_url_env": "SEPOLIA_RPC_URL",
        "explorer": "Etherscan Sepolia",
        "explorer_url": "https://sepolia.etherscan.io",
        "explorer_api_url": "https://api-sepolia.etherscan.io/api",
        "explorer_api_key_env": "ETHERSCAN_API_KEY",
    },
    "base": {
        "name": "Base Mainnet",
        "chain_id": 8453,
        "rpc_url_env": "BASE_RPC_URL",
        "explorer": "BaseScan",
        "explorer_url": "https://basescan.org",
        "explorer_api_url": "https://api.basescan.org/api",
        "explorer_api_key_env": "BASESCAN_API_KEY",
    },
    "base_sepolia": {
        "name": "Base Sepolia",
        "chain_id": 84532,
        "rpc_url_env": "BASE_SEPOLIA_RPC_URL",
        "explorer": "BaseScan Sepolia",
        "explorer_url": "https://sepolia.basescan.org",
        "explorer_api_url": "https://api-sepolia.basescan.org/api",
        "explorer_api_key_env": "BASESCAN_API_KEY",
    },
    "arbitrum": {
        "name": "Arbitrum One",
        "chain_id": 42161,
        "rpc_url_env": "ARBITRUM_RPC_URL",
        "explorer": "Arbiscan",
        "explorer_url": "https://arbiscan.io",
        "explorer_api_url": "https://api.arbiscan.io/api",
        "explorer_api_key_env": "ARBISCAN_API_KEY",
    },
    "optimism": {
        "name": "OP Mainnet",
        "chain_id": 10,
        "rpc_url_env": "OPTIMISM_RPC_URL",
        "explorer": "Optimistic Etherscan",
        "explorer_url": "https://optimistic.etherscan.io",
        "explorer_api_url": "https://api-optimistic.etherscan.io/api",
        "explorer_api_key_env": "OPTIMISM_ETHERSCAN_API_KEY",
    },
    "polygon": {
        "name": "Polygon PoS",
        "chain_id": 137,
        "rpc_url_env": "POLYGON_RPC_URL",
        "explorer": "PolygonScan",
        "explorer_url": "https://polygonscan.com",
        "explorer_api_url": "https://api.polygonscan.com/api",
        "explorer_api_key_env": "POLYGONSCAN_API_KEY",
    },
    "bnb": {
        "name": "BNB Smart Chain",
        "chain_id": 56,
        "rpc_url_env": "BNB_RPC_URL",
        "explorer": "BscScan",
        "explorer_url": "https://bscscan.com",
        "explorer_api_url": "https://api.bscscan.com/api",
        "explorer_api_key_env": "BSCSCAN_API_KEY",
    },
    "avalanche": {
        "name": "Avalanche C-Chain",
        "chain_id": 43114,
        "rpc_url_env": "AVALANCHE_RPC_URL",
        "explorer": "SnowTrace",
        "explorer_url": "https://snowtrace.io",
        "explorer_api_url": "https://api.snowtrace.io/api",
        "explorer_api_key_env": "SNOWTRACE_API_KEY",
    },
    "gnosis": {
        "name": "Gnosis Chain",
        "chain_id": 100,
        "rpc_url_env": "GNOSIS_RPC_URL",
        "explorer": "Gnosisscan",
        "explorer_url": "https://gnosisscan.io",
        "explorer_api_url": "https://api.gnosisscan.io/api",
        "explorer_api_key_env": "GNOSISSCAN_API_KEY",
    },
    "linea": {
        "name": "Linea",
        "chain_id": 59144,
        "rpc_url_env": "LINEA_RPC_URL",
        "explorer": "LineaScan",
        "explorer_url": "https://lineascan.build",
        "explorer_api_url": "https://api.lineascan.build/api",
        "explorer_api_key_env": "LINEASCAN_API_KEY",
    },
    "scroll": {
        "name": "Scroll",
        "chain_id": 534352,
        "rpc_url_env": "SCROLL_RPC_URL",
        "explorer": "ScrollScan",
        "explorer_url": "https://scrollscan.com",
        "explorer_api_url": "https://api.scrollscan.com/api",
        "explorer_api_key_env": "SCROLLSCAN_API_KEY",
    },
}


@dataclass(frozen=True)
class ToolSpec:
    key: str
    name: str
    category: str
    profiles: tuple[str, ...]
    mode: str = "local"
    command: str | None = None
    executable: str | None = None
    docker_service: str | None = None
    docker_command: str | None = None
    parser: str = "generic"
    output_ext: str = "txt"
    timeout_seconds: int = 600
    enabled: bool = True
    notes: str = ""


@dataclass
class ToolRun:
    tool: ToolSpec
    status: str
    runner: str = "local"
    command: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    duration_seconds: float | None = None
    exit_code: int | None = None
    stdout_path: str | None = None
    stderr_path: str | None = None
    output_path: str | None = None
    message: str = ""


@dataclass
class Finding:
    id: str
    tool: str
    severity: str
    confidence: str
    category: str
    title: str
    description: str
    recommendation: str = ""
    contract: str = ""
    function: str = ""
    file: str = ""
    line: int | None = None
    evidence: str = ""
    status: str = "untriaged"
    raw: dict[str, Any] = field(default_factory=dict)


def default_tool_specs() -> dict[str, ToolSpec]:
    specs = [
        ToolSpec(
            key="solhint",
            name="Solhint",
            category="lint",
            profiles=("fast", "standard", "full"),
            command="solhint {solidity_glob} --formatter unix",
            executable="solhint",
            parser="solhint-unix",
            output_ext="txt",
            timeout_seconds=300,
        ),
        ToolSpec(
            key="slither",
            name="Slither",
            category="static",
            profiles=("fast", "standard", "full"),
            command="slither {root} --json {out}",
            executable="slither",
            parser="slither-json",
            output_ext="json",
            timeout_seconds=900,
        ),
        ToolSpec(
            key="aderyn",
            name="Cyfrin Aderyn",
            category="static",
            profiles=("fast", "standard", "full"),
            command="aderyn {root} --output {out}",
            executable="aderyn",
            parser="generic-json",
            output_ext="json",
            timeout_seconds=600,
        ),
        ToolSpec(
            key="semgrep",
            name="Semgrep Smart Contracts",
            category="pattern",
            profiles=("fast", "standard", "full"),
            command="semgrep --config p/solidity --json --output {out} {root}",
            executable="semgrep",
            parser="semgrep-json",
            output_ext="json",
            timeout_seconds=900,
        ),
        ToolSpec(
            key="foundry",
            name="Foundry / Forge fuzz & invariants",
            category="test-fuzz",
            profiles=("fast", "deep", "full"),
            command="forge test -vvv",
            executable="forge",
            parser="generic",
            output_ext="txt",
            timeout_seconds=900,
        ),
        ToolSpec(
            key="wake",
            name="Wake / Wake Detect",
            category="static-fuzz",
            profiles=("standard", "deep", "full"),
            command="wake detect all --json {out}",
            executable="wake",
            parser="generic-json",
            output_ext="json",
            timeout_seconds=900,
        ),
        ToolSpec(
            key="securify",
            name="Securify 2.0",
            category="static",
            profiles=("standard", "full"),
            command="securify {root}",
            executable="securify",
            parser="generic",
            output_ext="txt",
            timeout_seconds=1200,
        ),
        ToolSpec(
            key="smartcheck",
            name="SmartCheck",
            category="static",
            profiles=("standard", "full"),
            command="smartcheck -p {root}",
            executable="smartcheck",
            parser="generic",
            output_ext="txt",
            timeout_seconds=900,
        ),
        ToolSpec(
            key="remix_analyzer",
            name="Remix Solidity Analyzers / remix-analyzer",
            category="static",
            profiles=("standard", "full"),
            command="remix-analyzer {root}",
            executable="remix-analyzer",
            parser="generic",
            output_ext="txt",
            timeout_seconds=600,
        ),
        ToolSpec(
            key="solidityscan",
            name="SolidityScan",
            category="saas-static",
            profiles=("standard", "full"),
            mode="manual",
            parser="generic",
            notes="SaaS/API scanner. Configure a command or attach exported reports.",
        ),
        ToolSpec(
            key="mythril",
            name="Mythril",
            category="symbolic",
            profiles=("deep", "full"),
            command="myth analyze {root} --output json",
            executable="myth",
            parser="mythril-json",
            output_ext="json",
            timeout_seconds=1800,
        ),
        ToolSpec(
            key="manticore",
            name="Manticore",
            category="symbolic",
            profiles=("deep", "full"),
            command="manticore {root}",
            executable="manticore",
            parser="generic",
            output_ext="txt",
            timeout_seconds=3600,
        ),
        ToolSpec(
            key="halmos",
            name="Halmos",
            category="symbolic-testing",
            profiles=("deep", "formal", "full"),
            command="halmos --root {root} --json-output {out}",
            executable="halmos",
            parser="generic-json",
            output_ext="json",
            timeout_seconds=1800,
        ),
        ToolSpec(
            key="hevm",
            name="hevm",
            category="symbolic-testing",
            profiles=("deep", "formal", "full"),
            command="hevm test --root {root}",
            executable="hevm",
            parser="generic",
            output_ext="txt",
            timeout_seconds=1800,
        ),
        ToolSpec(
            key="echidna",
            name="Echidna",
            category="property-fuzzing",
            profiles=("deep", "full"),
            command="echidna {root} --format json --output {out}",
            executable="echidna",
            parser="generic-json",
            output_ext="json",
            timeout_seconds=3600,
        ),
        ToolSpec(
            key="medusa",
            name="Medusa",
            category="parallel-fuzzing",
            profiles=("deep", "full"),
            command="medusa fuzz --project {root}",
            executable="medusa",
            parser="generic",
            output_ext="txt",
            timeout_seconds=3600,
        ),
        ToolSpec(
            key="diligence_fuzzing",
            name="Diligence Fuzzing",
            category="saas-fuzzing",
            profiles=("deep", "full"),
            mode="manual",
            parser="generic",
            notes="Commercial fuzzing service. Configure CLI/API command when available.",
        ),
        ToolSpec(
            key="scribble",
            name="Scribble",
            category="specification",
            profiles=("formal", "full"),
            command="scribble {root}",
            executable="scribble",
            parser="generic",
            output_ext="txt",
            timeout_seconds=900,
        ),
        ToolSpec(
            key="smtchecker",
            name="Solidity SMTChecker",
            category="formal",
            profiles=("formal", "full"),
            command="solc --model-checker-engine all --model-checker-show-unproved --model-checker-show-unsupported {solidity_glob}",
            executable="solc",
            parser="generic",
            output_ext="txt",
            timeout_seconds=1800,
        ),
        ToolSpec(
            key="certora",
            name="Certora Prover",
            category="formal",
            profiles=("formal", "full"),
            command="certoraRun {root}",
            executable="certoraRun",
            parser="generic",
            output_ext="txt",
            timeout_seconds=3600,
            notes="Usually requires project-specific spec files and credentials.",
        ),
        ToolSpec(
            key="kontrol",
            name="Kontrol",
            category="formal",
            profiles=("formal", "full"),
            command="kontrol prove",
            executable="kontrol",
            parser="generic",
            output_ext="txt",
            timeout_seconds=3600,
        ),
        ToolSpec(
            key="kevm",
            name="KEVM / K Framework",
            category="formal-semantics",
            profiles=("formal", "full"),
            command="kevm prove {root}",
            executable="kevm",
            parser="generic",
            output_ext="txt",
            timeout_seconds=3600,
        ),
        ToolSpec(
            key="verisol",
            name="VeriSol",
            category="formal",
            profiles=("formal", "full"),
            command="verisol {root}",
            executable="verisol",
            parser="generic",
            output_ext="txt",
            timeout_seconds=1800,
        ),
        ToolSpec(
            key="solc_verify",
            name="solc-verify",
            category="formal",
            profiles=("formal", "full"),
            command="solc-verify.py {solidity_glob}",
            executable="solc-verify.py",
            parser="generic",
            output_ext="txt",
            timeout_seconds=1800,
        ),
        ToolSpec(
            key="sourcify",
            name="Sourcify",
            category="source-verification",
            profiles=("deployed", "full"),
            mode="manual",
            parser="generic",
            notes="Use Sourcify API or a framework plugin to verify deployed bytecode against source.",
        ),
        ToolSpec(
            key="heimdall",
            name="Heimdall-rs",
            category="bytecode",
            profiles=("deployed", "full"),
            command="heimdall inspect {target_ref}",
            executable="heimdall",
            parser="generic",
            output_ext="txt",
            timeout_seconds=900,
        ),
        ToolSpec(
            key="dedaub",
            name="Dedaub",
            category="commercial-bytecode-analysis",
            profiles=("deployed", "full"),
            mode="manual",
            parser="generic",
            notes="Commercial decompiler/analysis suite. Configure API/CLI command when available.",
        ),
        ToolSpec(
            key="tenderly",
            name="Tenderly",
            category="simulation-debugging",
            profiles=("deployed", "monitor", "full"),
            command="tenderly version",
            executable="tenderly",
            parser="generic",
            output_ext="txt",
            timeout_seconds=300,
            notes="Replace default command with project simulations or virtual testnet checks.",
        ),
        ToolSpec(
            key="phalcon",
            name="BlockSec Phalcon",
            category="monitoring-simulation",
            profiles=("deployed", "monitor", "full"),
            mode="manual",
            parser="generic",
            notes="Platform/API-backed monitoring and simulation. Configure command if available.",
        ),
        ToolSpec(
            key="forta",
            name="Forta",
            category="runtime-monitoring",
            profiles=("monitor", "full"),
            command="forta-agent --version",
            executable="forta-agent",
            parser="generic",
            output_ext="txt",
            timeout_seconds=300,
            notes="Replace default command with bot build/test/publish workflows.",
        ),
        ToolSpec(
            key="openzeppelin_monitor",
            name="OpenZeppelin Monitor / Defender",
            category="runtime-monitoring",
            profiles=("monitor", "full"),
            mode="manual",
            parser="generic",
            notes="Defender is being phased out; prefer open-source Monitor/Relayer tooling.",
        ),
        ToolSpec(
            key="cargo_audit",
            name="cargo-audit",
            category="supply-chain",
            profiles=("fast", "standard", "full"),
            command="cargo audit --json",
            executable="cargo-audit",
            parser="generic",
            output_ext="json",
            timeout_seconds=300,
            notes="Checks Rust dependencies for known vulnerabilities.",
        ),
        ToolSpec(
            key="cargo_clippy",
            name="cargo-clippy",
            category="lint",
            profiles=("fast", "standard", "full"),
            command="cargo clippy --workspace --all-targets --message-format json",
            executable="cargo-clippy",
            parser="generic-json",
            output_ext="json",
            timeout_seconds=600,
            notes="Rust linter; finds risky patterns and anti-idiomatic code.",
        ),
        ToolSpec(
            key="cargo_geiger",
            name="cargo-geiger",
            category="static",
            profiles=("standard", "full"),
            command="cargo geiger --workspace",
            executable="cargo-geiger",
            parser="generic",
            output_ext="txt",
            timeout_seconds=600,
            notes="Detects and counts usage of unsafe Rust. High counts warrant manual review.",
        ),
        ToolSpec(
            key="trident",
            name="Trident",
            category="property-fuzzing",
            profiles=("deep", "full"),
            command="trident fuzz run --workspace-path {root}",
            executable="trident",
            parser="generic",
            output_ext="txt",
            timeout_seconds=3600,
            notes="Manually-guided Solana program fuzzer. Requires cargo-install and per-project setup.",
        ),
        ToolSpec(
            key="soteria",
            name="Soteria / sec3 X-ray",
            category="static",
            profiles=("standard", "full"),
            mode="manual",
            parser="generic",
            notes="Solana smart-contract vulnerability scanner. Commercial/SaaS tool; configure CLI command per-project.",
        ),
    ]
    docker_services = {
        "solhint": "node",
        "slither": "toolbox",
        "aderyn": "aderyn",
        "semgrep": "semgrep",
        "foundry": "foundry",
        "wake": "static",
        "securify": "securify",
        "smartcheck": "smartcheck",
        "remix_analyzer": "node",
        "mythril": "mythril",
        "manticore": "toolbox",
        "halmos": "formal",
        "hevm": "formal",
        "echidna": "toolbox",
        "medusa": "medusa",
        "scribble": "formal",
        "smtchecker": "formal",
        "certora": "certora",
        "kontrol": "formal",
        "kevm": "formal",
        "verisol": "formal",
        "solc_verify": "formal",
        "heimdall": "bytecode",
        "forta": "ops",
    }
    return {
        spec.key: replace(spec, docker_service=docker_services.get(spec.key))
        for spec in specs
    }


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "init":
        return init_config(args)
    if args.command == "bootstrap":
        return bootstrap_project(args)
    if args.command == "doctor":
        return doctor(args)
    if args.command == "list-chains":
        return list_chains(args)
    if args.command == "list-tools":
        return list_tools(args)
    if args.command == "run":
        return run_profile(args)

    parser.print_help()
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="evm-audit",
        description="Profile-based EVM smart contract audit runner.",
    )
    parser.add_argument("--version", action="version", version="evm-audit 0.1.0")
    sub = parser.add_subparsers(dest="command")

    init = sub.add_parser("init", help="create an audit.toml config")
    init.add_argument("--path", default="audit.toml", help="config path to create")
    init.add_argument("--force", action="store_true", help="overwrite an existing config")

    bootstrap = sub.add_parser("bootstrap", help="create project-local tool directories and env files")
    bootstrap.add_argument("--tools-dir", default=".audit-tools", help="project-local tool directory")
    bootstrap.add_argument("--force", action="store_true", help="overwrite generated env helper files")

    doctor_cmd = sub.add_parser("doctor", help="check local executables and Docker mappings")
    doctor_cmd.add_argument("--profile", choices=PROFILES, help="filter by profile")
    doctor_cmd.add_argument("--config", help="optional config path")
    doctor_cmd.add_argument("--root", help="override audited project root")
    doctor_cmd.add_argument("--tools-dir", help="override project-local tool directory")
    doctor_cmd.add_argument("--runner", choices=("local", "docker", "auto"), default="auto", help="runner availability to inspect")

    list_tools_cmd = sub.add_parser("list-tools", help="show registered tools")
    list_tools_cmd.add_argument("--profile", choices=PROFILES, help="filter by profile")
    list_tools_cmd.add_argument("--config", help="optional config path")

    list_chains_cmd = sub.add_parser("list-chains", help="show built-in and configured EVM chains")
    list_chains_cmd.add_argument("--config", help="optional config path")

    run = sub.add_parser("run", help="run an audit profile")
    run.add_argument("profile", choices=PROFILES, nargs="?", help="profile to run")
    run.add_argument("--config", help="config path")
    run.add_argument("--root", help="override audited project root")
    run.add_argument("--target", help="configured target key from [targets.<name>]")
    run.add_argument("--chain", help="EVM chain key, e.g. base, arbitrum, polygon")
    run.add_argument("--address", help="deployed contract address")
    run.add_argument("--rpc-url", help="RPC URL for deployed/fork-aware tools")
    run.add_argument("--rpc-url-env", help="environment variable containing the RPC URL")
    run.add_argument("--explorer-api-key-env", help="environment variable containing explorer API key")
    run.add_argument("--fork-block", help="optional fork block number")
    run.add_argument("--tool", action="append", help="run only this tool key; repeatable")
    run.add_argument("--dry-run", action="store_true", help="print commands without executing")
    run.add_argument("--include-manual", action="store_true", help="include manual/API tools as manual tasks")
    run.add_argument("--reports-dir", help="override reports directory")
    run.add_argument("--tools-dir", help="override project-local tool directory")
    run.add_argument("--runner", choices=("local", "docker", "auto"), help="execute with local tools, Docker Compose, or auto fallback")
    run.add_argument("--compose-file", help="override Docker Compose file")
    run.add_argument("--fail-on", choices=("low", "medium", "high", "critical"), help="fail if findings meet severity")
    run.add_argument("--strict-tool-failures", action="store_true", help="exit non-zero when a tool command fails")

    return parser


def init_config(args: argparse.Namespace) -> int:
    path = Path(args.path)
    if path.exists() and not args.force:
        print(f"Config already exists: {path}. Use --force to overwrite.", file=sys.stderr)
        return 1
    path.write_text(default_config_text(), encoding="utf-8")
    print(f"Created {path}")
    return 0


def bootstrap_project(args: argparse.Namespace) -> int:
    root = Path(".").resolve()
    tools_dir = resolve_path(root, args.tools_dir)
    directories = [
        tools_dir,
        tools_dir / "bin",
        tools_dir / "cache",
        tools_dir / "venvs",
        tools_dir / "python",
        tools_dir / "node",
        tools_dir / "cargo" / "bin",
        tools_dir / "go" / "bin",
        tools_dir / "foundry" / "bin",
    ]
    for directory in directories:
        directory.mkdir(parents=True, exist_ok=True)

    write_if_missing(tools_dir / "env.ps1", powershell_env_text(tools_dir), args.force)
    write_if_missing(tools_dir / "env.sh", shell_env_text(tools_dir), args.force)
    write_if_missing(tools_dir / "README.md", tools_dir_readme_text(tools_dir), args.force)

    print(f"Created project-local tool directory: {tools_dir}")
    print("Activate local tool PATH:")
    print(f"  PowerShell: . {tools_dir / 'env.ps1'}")
    print(f"  sh/bash:    source {tools_dir / 'env.sh'}")
    print("Install local tools:")
    print("  PowerShell: ./scripts/install-local.ps1 -All")
    print("  sh/bash:    ./scripts/install-local.sh --all")
    print("Build Docker images:")
    print("  docker compose -f docker/docker-compose.audit.yml build")
    return 0


def doctor(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    project = config.get("project", {}) if isinstance(config.get("project", {}), dict) else {}
    control_root = config_base_path(args.config)
    root = Path(str(args.root or project.get("root", "."))).resolve()
    tools_dir = resolve_path(control_root, args.tools_dir or project.get("tools_dir", ".audit-tools"))
    compose_file = resolve_path(control_root, project.get("compose_file", "docker/docker-compose.audit.yml"))
    tools = merge_tool_config(default_tool_specs(), config)
    selected = [tool for tool in tools.values() if not args.profile or profile_matches(tool, args.profile)]
    env = build_tool_env(tools_dir)

    print(f"Project root: {root}")
    print(f"Tools dir: {tools_dir}")
    print(f"Docker compose: {compose_file}")
    print(f"Docker available: {'yes' if shutil.which('docker') else 'no'}")
    print("")
    width = max(len(tool.key) for tool in selected) if selected else 0
    for tool in selected:
        local_status = "manual" if tool.mode == "manual" and not tool.command else "missing"
        found = None if should_prefer_docker(tool) else find_executable(tool.executable, env) if tool.executable else None
        if found:
            local_status = f"local:{found}"
        elif should_prefer_docker(tool):
            local_status = "docker-preferred"
        docker_status = tool.docker_service or "-"
        if args.runner == "local":
            status = local_status
        elif args.runner == "docker":
            status = f"docker:{docker_status}" if tool.docker_service else "docker:-"
        else:
            status = f"{local_status} | docker:{docker_status}"
        print(f"{tool.key:<{width}}  {status}")
    return 0


def list_tools(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    tools = merge_tool_config(default_tool_specs(), config)
    selected = [tool for tool in tools.values() if not args.profile or profile_matches(tool, args.profile)]

    width = max(len(tool.key) for tool in selected) if selected else 0
    for tool in selected:
        profiles = ",".join(tool.profiles)
        executable = tool.executable or "-"
        print(f"{tool.key:<{width}}  {tool.mode:<6}  {tool.category:<28}  {executable:<20}  {profiles}  {tool.name}")
    return 0


def list_chains(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    chains = merge_chain_config(config)
    width = max(len(key) for key in chains) if chains else 0
    for key, chain in sorted(chains.items()):
        chain_id = chain.get("chain_id", "-")
        rpc_env = chain.get("rpc_url_env", "-")
        explorer = chain.get("explorer", chain.get("explorer_url", "-"))
        name = chain.get("name", key)
        print(f"{key:<{width}}  {str(chain_id):<10}  {str(rpc_env):<24}  {explorer}  {name}")
    return 0


def run_profile(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    project = config.get("project", {}) if isinstance(config.get("project", {}), dict) else {}
    control_root = config_base_path(args.config)
    profile = args.profile or config.get("profiles", {}).get("default") or "fast"
    if profile not in PROFILES:
        print(f"Unknown profile: {profile}", file=sys.stderr)
        return 1

    root = Path(str(args.root or project.get("root", "."))).resolve()
    reports_dir = Path(args.reports_dir or project.get("reports_dir", "reports")).resolve()
    tools_dir = resolve_path(control_root, args.tools_dir or project.get("tools_dir", ".audit-tools"))
    runner = args.runner or str(project.get("runner", "local"))
    compose_file = resolve_path(control_root, args.compose_file or project.get("compose_file", "docker/docker-compose.audit.yml"))
    fail_on = args.fail_on or project.get("default_fail_on")
    tools = merge_tool_config(default_tool_specs(), config)
    chain_context = resolve_chain_context(config, args)

    selected = select_tools(tools, profile, args.tool, include_manual=args.include_manual)
    if not selected:
        print("No tools selected.", file=sys.stderr)
        return 1

    started = now_iso()
    run_id = dt.datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    run_context = {
        "run_id": run_id,
        "profile": profile,
        "root": str(root),
        "reports_dir": str(reports_dir),
        "tools_dir": str(tools_dir),
        "runner": runner,
        "compose_file": str(compose_file),
        "chain": public_chain_context(chain_context),
        "started_at": started,
        "dry_run": args.dry_run,
    }

    print(f"Audit profile: {profile}")
    print(f"Project root: {root}")
    print(f"Runner: {runner}")
    if chain_context:
        chain_label = chain_context.get("name") or chain_context.get("chain")
        chain_id = chain_context.get("chain_id") or "unknown"
        address = chain_context.get("address") or "no address"
        print(f"Chain: {chain_label} ({chain_id})")
        print(f"Address: {address}")
    print(f"Selected tools: {', '.join(tool.key for tool in selected)}")

    tool_runs: list[ToolRun] = []
    findings: list[Finding] = []
    env = build_tool_env(tools_dir)
    apply_chain_env(env, chain_context)
    for tool in selected:
        run = execute_tool(tool, root, reports_dir, profile, args.dry_run, runner, tools_dir, compose_file, env, chain_context, control_root)
        tool_runs.append(run)
        if run.output_path:
            findings.extend(parse_findings(tool, Path(run.output_path)))
        if run.stdout_path:
            findings.extend(parse_stdout_findings(tool, Path(run.stdout_path)))
        print(format_run_status(run))

    findings = deduplicate_findings(findings)
    ended = now_iso()
    run_context["ended_at"] = ended

    reports_dir.mkdir(parents=True, exist_ok=True)
    write_json_report(reports_dir / "findings.json", run_context, tool_runs, findings)
    write_markdown_report(reports_dir / "report.md", run_context, tool_runs, findings)
    write_sarif_report(reports_dir / "findings.sarif", findings)

    print(f"Report: {reports_dir / 'report.md'}")
    print(f"Findings: {reports_dir / 'findings.json'}")
    print(f"SARIF: {reports_dir / 'findings.sarif'}")

    if args.strict_tool_failures and any(run.status == "failed" for run in tool_runs):
        return 3
    if fail_on and threshold_breached(findings, str(fail_on)):
        return 2
    return 0


def execute_tool(
    tool: ToolSpec,
    root: Path,
    reports_dir: Path,
    profile: str,
    dry_run: bool,
    runner: str,
    tools_dir: Path,
    compose_file: Path,
    env: dict[str, str],
    chain_context: dict[str, Any],
    workspace_root: Path,
) -> ToolRun:
    tool_dir = reports_dir / "raw" / profile / tool.key
    output_path = tool_dir / f"output.{tool.output_ext}"
    stdout_path = tool_dir / "stdout.log"
    stderr_path = tool_dir / "stderr.log"

    if tool.mode == "manual" and not tool.command:
        return ToolRun(tool=tool, status="manual", message=tool.notes or "Manual/API-backed tool.")

    if not tool.enabled:
        return ToolRun(tool=tool, status="disabled", message="Disabled by config.")

    if not tool.command:
        return ToolRun(tool=tool, status="skipped", message="No command configured.")

    selected_runner, message = choose_runner(tool, runner, env, compose_file)
    if selected_runner == "docker":
        command = render_docker_command(tool, root, reports_dir, output_path, tool.key, profile, compose_file, chain_context, workspace_root)
    else:
        command = render_command(tool.command, root, reports_dir, output_path, tool.key, profile, chain_context)
    display_command = sanitize_command(command, chain_context)

    if dry_run:
        return ToolRun(
            tool=tool,
            status="dry-run",
            runner=selected_runner,
            command=display_command,
            output_path=str(output_path),
            message=message or "Command not executed.",
        )

    if selected_runner == "docker":
        if not compose_file.exists():
            return ToolRun(
                tool=tool,
                status="skipped",
                runner=selected_runner,
                command=display_command,
                output_path=str(output_path),
                message=f"Docker Compose file not found: {compose_file}",
            )
        if shutil.which("docker") is None:
            return ToolRun(
                tool=tool,
                status="skipped",
                runner=selected_runner,
                command=display_command,
                output_path=str(output_path),
                message="Docker executable not found on PATH.",
            )
    elif tool.executable and not find_executable(tool.executable, env):
        return ToolRun(
            tool=tool,
            status="skipped",
            runner=selected_runner,
            command=display_command,
            output_path=str(output_path),
            message=f"Executable not found on PATH or in {tools_dir}: {tool.executable}",
        )

    tool_dir.mkdir(parents=True, exist_ok=True)
    started_dt = dt.datetime.now(UTC)
    started = started_dt.isoformat()
    try:
        completed = subprocess.run(
            command,
            cwd=str(root),
            shell=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=tool.timeout_seconds,
            env=env,
        )
        stdout_path.write_text(completed.stdout or "", encoding="utf-8", errors="replace")
        stderr_path.write_text(completed.stderr or "", encoding="utf-8", errors="replace")
        if "{out}" not in tool.command and completed.stdout and not output_path.exists():
            output_path.write_text(completed.stdout, encoding="utf-8", errors="replace")
        ended_dt = dt.datetime.now(UTC)
        return ToolRun(
            tool=tool,
            status="passed" if completed.returncode == 0 else "failed",
            runner=selected_runner,
            command=display_command,
            started_at=started,
            ended_at=ended_dt.isoformat(),
            duration_seconds=round((ended_dt - started_dt).total_seconds(), 3),
            exit_code=completed.returncode,
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            output_path=str(output_path) if output_path.exists() else None,
            message="" if completed.returncode == 0 else "Command exited non-zero.",
        )
    except subprocess.TimeoutExpired as exc:
        ended_dt = dt.datetime.now(UTC)
        stdout_path.write_text(exc.stdout or "", encoding="utf-8", errors="replace")
        stderr_path.write_text(exc.stderr or "", encoding="utf-8", errors="replace")
        return ToolRun(
            tool=tool,
            status="failed",
            runner=selected_runner,
            command=display_command,
            started_at=started,
            ended_at=ended_dt.isoformat(),
            duration_seconds=round((ended_dt - started_dt).total_seconds(), 3),
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            output_path=str(output_path) if output_path.exists() else None,
            message=f"Timed out after {tool.timeout_seconds}s.",
        )


def parse_findings(tool: ToolSpec, path: Path) -> list[Finding]:
    if not path.exists() or path.stat().st_size == 0:
        return []
    if tool.parser == "slither-json":
        return parse_slither(tool, path)
    if tool.parser == "semgrep-json":
        return parse_semgrep(tool, path)
    if tool.parser == "mythril-json":
        return parse_mythril(tool, path)
    if tool.parser == "generic-json":
        return parse_generic_json(tool, path)
    return []


def parse_stdout_findings(tool: ToolSpec, path: Path) -> list[Finding]:
    if not path.exists() or path.stat().st_size == 0:
        return []
    if tool.parser == "solhint-unix":
        return parse_solhint_unix(tool, path)
    return []


def parse_slither(tool: ToolSpec, path: Path) -> list[Finding]:
    data = read_json(path)
    detectors = data.get("results", {}).get("detectors", []) if isinstance(data, dict) else []
    findings: list[Finding] = []
    for item in detectors:
        if not isinstance(item, dict):
            continue
        source = first_source_mapping(item)
        title = str(item.get("check") or item.get("title") or "Slither finding")
        severity = normalize_severity(str(item.get("impact") or "medium"))
        confidence = normalize_confidence(str(item.get("confidence") or "medium"))
        findings.append(
            make_finding(
                tool=tool.key,
                severity=severity,
                confidence=confidence,
                category=title,
                title=title,
                description=str(item.get("description") or item.get("markdown") or title),
                recommendation=str(item.get("recommendation") or "Review the detector output and remediate if valid."),
                file=source.get("file", ""),
                line=source.get("line"),
                evidence=str(item.get("first_markdown_element") or ""),
                raw=item,
            )
        )
    return findings


def parse_semgrep(tool: ToolSpec, path: Path) -> list[Finding]:
    data = read_json(path)
    results = data.get("results", []) if isinstance(data, dict) else []
    findings: list[Finding] = []
    for item in results:
        if not isinstance(item, dict):
            continue
        extra = item.get("extra", {}) if isinstance(item.get("extra"), dict) else {}
        metadata = extra.get("metadata", {}) if isinstance(extra.get("metadata"), dict) else {}
        title = str(metadata.get("shortlink") or item.get("check_id") or "Semgrep finding")
        severity = normalize_severity(str(extra.get("severity") or metadata.get("severity") or "medium"))
        start = item.get("start", {}) if isinstance(item.get("start"), dict) else {}
        findings.append(
            make_finding(
                tool=tool.key,
                severity=severity,
                confidence="medium",
                category=str(item.get("check_id") or "semgrep"),
                title=title,
                description=str(extra.get("message") or title),
                recommendation=str(metadata.get("fix") or "Review the matched rule and remediate if valid."),
                file=str(item.get("path") or ""),
                line=int_or_none(start.get("line")),
                evidence=str(extra.get("lines") or ""),
                raw=item,
            )
        )
    return findings


def parse_mythril(tool: ToolSpec, path: Path) -> list[Finding]:
    data = read_json(path)
    issues = data.get("issues", []) if isinstance(data, dict) else []
    findings: list[Finding] = []
    for item in issues:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or item.get("swc-id") or "Mythril issue")
        findings.append(
            make_finding(
                tool=tool.key,
                severity=normalize_severity(str(item.get("severity") or "medium")),
                confidence="medium",
                category=str(item.get("swc-id") or title),
                title=title,
                description=str(item.get("description") or item.get("long-description") or title),
                recommendation=str(item.get("recommendation") or "Review symbolic execution trace and remediate if valid."),
                contract=str(item.get("contract") or ""),
                function=str(item.get("function") or ""),
                file=str(item.get("filename") or ""),
                line=int_or_none(item.get("lineno")),
                evidence=str(item.get("debug") or item.get("address") or ""),
                raw=item,
            )
        )
    return findings


def parse_generic_json(tool: ToolSpec, path: Path) -> list[Finding]:
    data = read_json(path)
    candidates: list[Any] = []
    if isinstance(data, dict):
        for key in ("findings", "issues", "results", "detectors", "vulnerabilities"):
            value = data.get(key)
            if isinstance(value, list):
                candidates = value
                break
    elif isinstance(data, list):
        candidates = data

    findings: list[Finding] = []
    for item in candidates:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or item.get("name") or item.get("check") or item.get("id") or f"{tool.name} finding")
        description = str(item.get("description") or item.get("message") or item.get("details") or title)
        findings.append(
            make_finding(
                tool=tool.key,
                severity=normalize_severity(str(item.get("severity") or item.get("impact") or "medium")),
                confidence=normalize_confidence(str(item.get("confidence") or "medium")),
                category=str(item.get("category") or item.get("check") or tool.category),
                title=title,
                description=description,
                recommendation=str(item.get("recommendation") or item.get("fix") or "Review the tool output and remediate if valid."),
                file=str(item.get("file") or item.get("path") or item.get("filename") or ""),
                line=int_or_none(item.get("line") or item.get("lineno")),
                evidence=str(item.get("evidence") or item.get("trace") or ""),
                raw=item,
            )
        )
    return findings


def parse_solhint_unix(tool: ToolSpec, path: Path) -> list[Finding]:
    findings: list[Finding] = []
    pattern = re.compile(r"^(?P<file>.*?):(?P<line>\d+):(?P<col>\d+):\s*(?P<severity>\w+)\s+(?P<message>.*?)(?:\s+\[(?P<rule>[^\]]+)\])?$")
    for line_text in path.read_text(encoding="utf-8", errors="replace").splitlines():
        match = pattern.match(line_text.strip())
        if not match:
            continue
        rule = match.group("rule") or "solhint"
        message = match.group("message") or rule
        findings.append(
            make_finding(
                tool=tool.key,
                severity=normalize_severity(match.group("severity")),
                confidence="medium",
                category=rule,
                title=rule,
                description=message,
                recommendation="Review the lint/security rule and remediate if valid.",
                file=match.group("file"),
                line=int(match.group("line")),
                evidence=line_text,
                raw={"line": line_text},
            )
        )
    return findings


def write_json_report(path: Path, context: dict[str, Any], runs: list[ToolRun], findings: list[Finding]) -> None:
    payload = {
        "context": context,
        "summary": summarize(runs, findings),
        "tools": [tool_run_to_dict(run) for run in runs],
        "findings": [finding_to_dict(finding) for finding in findings],
    }
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def write_markdown_report(path: Path, context: dict[str, Any], runs: list[ToolRun], findings: list[Finding]) -> None:
    summary = summarize(runs, findings)
    chain = context.get("chain") if isinstance(context.get("chain"), dict) else {}
    lines = [
        "# EVM Audit Report",
        "",
        f"- Run ID: `{context['run_id']}`",
        f"- Profile: `{context['profile']}`",
        f"- Root: `{context['root']}`",
    ]
    if chain:
        chain_label = chain.get("name") or chain.get("chain") or "unknown"
        chain_key = chain.get("chain") or "unknown"
        chain_id = chain.get("chain_id") or "unknown"
        lines.append(f"- Chain: `{chain_label}` (`{chain_key}`, ID `{chain_id}`)")
        if chain.get("address"):
            lines.append(f"- Address: `{chain['address']}`")
        if chain.get("rpc_url"):
            lines.append(f"- RPC URL: `{chain['rpc_url']}`")
        if chain.get("rpc_url_env"):
            lines.append(f"- RPC URL Env: `{chain['rpc_url_env']}`")
        if chain.get("explorer") or chain.get("explorer_url"):
            explorer = chain.get("explorer") or "Explorer"
            explorer_url = chain.get("explorer_url") or ""
            lines.append(f"- Explorer: `{explorer}`" + (f" (`{explorer_url}`)" if explorer_url else ""))
        if chain.get("fork_block"):
            lines.append(f"- Fork block: `{chain['fork_block']}`")
    lines.extend([
        f"- Started: `{context['started_at']}`",
        f"- Ended: `{context.get('ended_at', '')}`",
        f"- Total findings: `{summary['total_findings']}`",
        "",
        "## Severity Summary",
        "",
        "| Severity | Count |",
        "| --- | ---: |",
    ])
    for severity in ("critical", "high", "medium", "low", "informational"):
        lines.append(f"| {severity.title()} | {summary['severity_counts'].get(severity, 0)} |")

    lines.extend([
        "",
        "## Tool Runs",
        "",
        "| Tool | Status | Exit | Duration | Message |",
        "| --- | --- | ---: | ---: | --- |",
    ])
    for run in runs:
        duration = "" if run.duration_seconds is None else str(run.duration_seconds)
        exit_code = "" if run.exit_code is None else str(run.exit_code)
        lines.append(f"| {escape_md(run.tool.name)} | `{run.status}` | {exit_code} | {duration} | {escape_md(run.message)} |")

    lines.extend(["", "## Findings", ""])
    if not findings:
        lines.append("No normalized findings were produced.")
    else:
        for index, finding in enumerate(sorted(findings, key=finding_sort_key), start=1):
            location = format_location(finding)
            lines.extend(
                [
                    f"### {index}. {finding.title}",
                    "",
                    f"- ID: `{finding.id}`",
                    f"- Tool: `{finding.tool}`",
                    f"- Severity: `{finding.severity}`",
                    f"- Confidence: `{finding.confidence}`",
                    f"- Category: `{finding.category}`",
                    f"- Location: `{location}`" if location else "- Location: `unknown`",
                    "",
                    finding.description.strip() or "No description provided.",
                    "",
                    f"Recommendation: {finding.recommendation}" if finding.recommendation else "Recommendation: Review and triage.",
                    "",
                ]
            )
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def write_sarif_report(path: Path, findings: list[Finding]) -> None:
    rules: dict[str, dict[str, Any]] = {}
    results: list[dict[str, Any]] = []
    for finding in findings:
        rule_id = f"{finding.tool}/{finding.category}".replace(" ", "-")
        rules.setdefault(
            rule_id,
            {
                "id": rule_id,
                "name": finding.category,
                "shortDescription": {"text": finding.title},
                "fullDescription": {"text": finding.description[:500]},
                "properties": {"security-severity": str(severity_score(finding.severity))},
            },
        )
        location: dict[str, Any] = {"physicalLocation": {"artifactLocation": {"uri": finding.file or "unknown"}}}
        if finding.line:
            location["physicalLocation"]["region"] = {"startLine": finding.line}
        results.append(
            {
                "ruleId": rule_id,
                "level": sarif_level(finding.severity),
                "message": {"text": finding.description},
                "locations": [location],
                "partialFingerprints": {"evmAuditFindingId": finding.id},
            }
        )
    payload = {
        "version": "2.1.0",
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "runs": [
            {
                "tool": {"driver": {"name": "EVM Audit CLI", "informationUri": "https://github.com/", "rules": list(rules.values())}},
                "results": results,
            }
        ],
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def load_config(config_path: str | None) -> dict[str, Any]:
    path = Path(config_path) if config_path else find_config_file()
    if not path:
        return {}
    if not path.exists():
        print(f"Config not found: {path}", file=sys.stderr)
        return {}
    suffix = path.suffix.lower()
    if suffix == ".toml":
        return load_toml(path)
    if suffix == ".json":
        return json.loads(path.read_text(encoding="utf-8"))
    if suffix in (".yaml", ".yml"):
        try:
            import yaml  # type: ignore
        except ImportError as exc:
            raise SystemExit("YAML config requires PyYAML. Install with: pip install -e .[yaml]") from exc
        loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
        return loaded or {}
    raise SystemExit(f"Unsupported config format: {path}")


def find_config_file() -> Path | None:
    for name in ("audit.toml", "audit.json", "audit.yaml", "audit.yml"):
        path = Path(name)
        if path.exists():
            return path
    return None


def load_toml(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if tomllib is not None:
        return tomllib.loads(text)
    return parse_basic_toml(text)


def parse_basic_toml(text: str) -> dict[str, Any]:
    """Parse the small TOML subset used by audit.toml on Python 3.10."""
    root: dict[str, Any] = {}
    current = root
    for raw_line in text.splitlines():
        line = strip_toml_comment(raw_line).strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip()
            current = root
            for part in section.split("."):
                key = unquote_toml_string(part.strip())
                value = current.setdefault(key, {})
                if not isinstance(value, dict):
                    raise ValueError(f"TOML section conflicts with value: {section}")
                current = value
            continue
        if "=" not in line:
            raise ValueError(f"Unsupported TOML line: {raw_line}")
        key, value = line.split("=", 1)
        current[unquote_toml_string(key.strip())] = parse_toml_value(value.strip())
    return root


def strip_toml_comment(value: str) -> str:
    in_quote = False
    escaped = False
    for index, char in enumerate(value):
        if char == '"' and not escaped:
            in_quote = not in_quote
        if char == "#" and not in_quote:
            return value[:index]
        escaped = char == "\\" and not escaped
        if char != "\\":
            escaped = False
    return value


def parse_toml_value(value: str) -> Any:
    lower = value.lower()
    if lower == "true":
        return True
    if lower == "false":
        return False
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [parse_toml_value(item.strip()) for item in split_toml_array(inner)]
    if value.startswith('"') and value.endswith('"'):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value[1:-1]
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1]
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    return value


def split_toml_array(value: str) -> list[str]:
    items: list[str] = []
    start = 0
    in_quote = False
    escaped = False
    for index, char in enumerate(value):
        if char == '"' and not escaped:
            in_quote = not in_quote
        if char == "," and not in_quote:
            items.append(value[start:index])
            start = index + 1
        escaped = char == "\\" and not escaped
        if char != "\\":
            escaped = False
    items.append(value[start:])
    return [item for item in items if item.strip()]


def unquote_toml_string(value: str) -> str:
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    return value


def merge_tool_config(defaults: dict[str, ToolSpec], config: dict[str, Any]) -> dict[str, ToolSpec]:
    tool_config = config.get("tools", {}) if isinstance(config.get("tools", {}), dict) else {}
    merged = dict(defaults)
    for raw_key, value in tool_config.items():
        if not isinstance(value, dict):
            continue
        key = normalize_key(str(raw_key))
        base = merged.get(key)
        if base is None:
            base = ToolSpec(
                key=key,
                name=str(value.get("name") or raw_key),
                category=str(value.get("category") or "custom"),
                profiles=tuple(value.get("profiles") or ("full",)),
                command=value.get("command"),
                executable=value.get("executable"),
            )
        updates: dict[str, Any] = {}
        for field_name in ToolSpec.__dataclass_fields__:
            if field_name not in value or field_name == "key":
                continue
            if field_name == "profiles":
                updates[field_name] = tuple(str(item) for item in value[field_name])
            elif field_name == "timeout_seconds":
                updates[field_name] = int(value[field_name])
            elif field_name == "enabled":
                updates[field_name] = bool(value[field_name])
            else:
                updates[field_name] = value[field_name]
        if updates.get("command") and "mode" not in updates and base.mode == "manual":
            updates["mode"] = "local"
        merged[key] = replace(base, **updates)
    return merged


def select_tools(tools: dict[str, ToolSpec], profile: str, requested: list[str] | None, include_manual: bool) -> list[ToolSpec]:
    requested_keys = {normalize_key(item) for item in requested or []}
    selected: list[ToolSpec] = []
    for tool in tools.values():
        if requested_keys and tool.key not in requested_keys:
            continue
        if not requested_keys and not profile_matches(tool, profile):
            continue
        if tool.mode == "manual" and not include_manual and not tool.command and not requested_keys:
            continue
        selected.append(tool)
    return selected


def profile_matches(tool: ToolSpec, profile: str) -> bool:
    return profile == "full" or profile in tool.profiles


def merge_chain_config(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    chains = {key: dict(value) for key, value in CHAIN_PRESETS.items()}
    configured = config.get("chains", {}) if isinstance(config.get("chains", {}), dict) else {}
    for raw_key, value in configured.items():
        if not isinstance(value, dict):
            continue
        key = normalize_chain_key(str(raw_key))
        base = chains.get(key, {})
        merged = {**base, **value}
        merged.setdefault("name", str(raw_key))
        chains[key] = merged
    return chains


def resolve_chain_context(config: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    targets = config.get("targets", {}) if isinstance(config.get("targets", {}), dict) else {}
    target = targets.get(args.target, {}) if args.target and isinstance(targets.get(args.target), dict) else {}
    chains = merge_chain_config(config)

    chain_key = args.chain or target.get("chain")
    address = args.address or target.get("address")
    fork_block = args.fork_block or target.get("fork_block")
    rpc_url = args.rpc_url or target.get("rpc_url")
    rpc_url_env = args.rpc_url_env or target.get("rpc_url_env")
    explorer_api_key_env = args.explorer_api_key_env or target.get("explorer_api_key_env")

    if not chain_key and not any((address, fork_block, rpc_url, rpc_url_env, explorer_api_key_env)):
        return {}

    key = normalize_chain_key(str(chain_key or "custom"))
    chain = dict(chains.get(key, {}))
    chain.setdefault("name", str(chain_key or "Custom EVM Chain"))
    chain["chain"] = key

    if address:
        chain["address"] = str(address)
        if not ADDRESS_PATTERN.match(str(address)):
            print(f"Warning: address does not look like an EVM address: {address}", file=sys.stderr)
    if fork_block:
        chain["fork_block"] = str(fork_block)
    if rpc_url_env:
        chain["rpc_url_env"] = str(rpc_url_env)
    if explorer_api_key_env:
        chain["explorer_api_key_env"] = str(explorer_api_key_env)
    if rpc_url:
        chain["rpc_url"] = str(rpc_url)
    elif chain.get("rpc_url_env") and os.environ.get(str(chain["rpc_url_env"])):
        chain["rpc_url"] = os.environ[str(chain["rpc_url_env"])]

    return chain


def normalize_chain_key(value: str) -> str:
    aliases = {
        "coinbase": "base",
        "base_mainnet": "base",
        "basesepolia": "base_sepolia",
        "base_testnet": "base_sepolia",
        "arbitrum_one": "arbitrum",
        "arb": "arbitrum",
        "op": "optimism",
        "optimism_mainnet": "optimism",
        "matic": "polygon",
        "polygon_pos": "polygon",
        "bsc": "bnb",
        "binance": "bnb",
        "avalanche_c_chain": "avalanche",
        "avax": "avalanche",
        "xdai": "gnosis",
    }
    key = normalize_key(value)
    return aliases.get(key, key)


def public_chain_context(chain_context: dict[str, Any]) -> dict[str, Any]:
    if not chain_context:
        return {}
    public = dict(chain_context)
    if public.get("rpc_url"):
        public["rpc_url"] = "<set>"
    if public.get("explorer_api_key"):
        public["explorer_api_key"] = "<set>"
    return public


def apply_chain_env(env: dict[str, str], chain_context: dict[str, Any]) -> None:
    if not chain_context:
        return
    if chain_context.get("rpc_url"):
        env["EVM_RPC_URL"] = str(chain_context["rpc_url"])
    if chain_context.get("rpc_url_env") and chain_context.get("rpc_url"):
        env.setdefault(str(chain_context["rpc_url_env"]), str(chain_context["rpc_url"]))
    if chain_context.get("chain_id"):
        env["EVM_CHAIN_ID"] = str(chain_context["chain_id"])
    if chain_context.get("address"):
        env["EVM_TARGET_ADDRESS"] = str(chain_context["address"])
    if chain_context.get("fork_block"):
        env["EVM_FORK_BLOCK"] = str(chain_context["fork_block"])


def command_context_values(chain_context: dict[str, Any], quote_values: bool, root: Path) -> dict[str, str]:
    address = str(chain_context.get("address") or "")
    rpc_url = str(chain_context.get("rpc_url") or "")
    values = {
        "chain": str(chain_context.get("chain") or ""),
        "chain_name": str(chain_context.get("name") or chain_context.get("chain") or ""),
        "chain_id": str(chain_context.get("chain_id") or ""),
        "rpc_url": rpc_url,
        "rpc_url_env": str(chain_context.get("rpc_url_env") or ""),
        "explorer": str(chain_context.get("explorer") or ""),
        "explorer_url": str(chain_context.get("explorer_url") or ""),
        "explorer_api_url": str(chain_context.get("explorer_api_url") or ""),
        "explorer_api_key_env": str(chain_context.get("explorer_api_key_env") or ""),
        "address": address,
        "fork_block": str(chain_context.get("fork_block") or ""),
        "target_ref": address or (str(root) if quote_values else "/workspace"),
    }
    if quote_values:
        return {key: quote(value) for key, value in values.items()}
    return values


def sanitize_command(command: str, chain_context: dict[str, Any]) -> str:
    sanitized = command
    rpc_url = chain_context.get("rpc_url") if chain_context else None
    if rpc_url:
        sanitized = sanitized.replace(str(rpc_url), "<RPC_URL>")
    return sanitized


def config_base_path(config_path: str | None) -> Path:
    if config_path:
        return Path(config_path).resolve().parent
    found = find_config_file()
    return found.resolve().parent if found else Path(".").resolve()


def render_command(
    command: str,
    root: Path,
    reports_dir: Path,
    output_path: Path,
    tool_key: str,
    profile: str,
    chain_context: dict[str, Any],
) -> str:
    solidity_glob = (root / "**" / "*.sol").as_posix()
    return command.format(
        root=quote(str(root)),
        reports_dir=quote(str(reports_dir)),
        out=quote(str(output_path)),
        tool=tool_key,
        profile=profile,
        solidity_glob=quote(solidity_glob),
        **command_context_values(chain_context, quote_values=True, root=root),
    )


def render_docker_command(
    tool: ToolSpec,
    root: Path,
    reports_dir: Path,
    output_path: Path,
    tool_key: str,
    profile: str,
    compose_file: Path,
    chain_context: dict[str, Any],
    workspace_root: Path,
) -> str:
    if not tool.docker_service:
        return render_command(tool.command or "", root, reports_dir, output_path, tool_key, profile, chain_context)
    inner = render_container_command(tool, root, reports_dir, output_path, tool_key, profile, chain_context, workspace_root)
    return " ".join(
        [
            "docker",
            "compose",
            "-f",
            quote(str(compose_file)),
            "run",
            "--rm",
            tool.docker_service,
            "sh",
            "-c",
            command_arg(inner),
        ]
    )


def render_container_command(
    tool: ToolSpec,
    root: Path,
    reports_dir: Path,
    output_path: Path,
    tool_key: str,
    profile: str,
    chain_context: dict[str, Any],
    workspace_root: Path,
) -> str:
    command = tool.docker_command or tool.command or ""
    container_root = container_path(root, workspace_root)
    solidity_glob = f"{container_root.rstrip('/')}/**/*.sol"
    context_values = command_context_values(chain_context, quote_values=False, root=root)
    context_values["target_ref"] = context_values.get("address") or container_root
    return command.format(
        root=container_root,
        reports_dir=container_path(reports_dir, workspace_root),
        out=container_path(output_path, workspace_root),
        tool=tool_key,
        profile=profile,
        solidity_glob=solidity_glob,
        **context_values,
    )


def choose_runner(tool: ToolSpec, requested_runner: str, env: dict[str, str], compose_file: Path) -> tuple[str, str]:
    if requested_runner not in ("local", "docker", "auto"):
        return "local", f"Unknown runner '{requested_runner}', using local."
    if requested_runner == "docker":
        if tool.docker_service:
            return "docker", ""
        return "local", "No Docker service mapped; using local runner."
    if requested_runner == "auto":
        if should_prefer_docker(tool) and tool.docker_service:
            return "docker", "Docker runner preferred for this tool on Windows."
        if not tool.executable or find_executable(tool.executable, env):
            return "local", ""
        if tool.docker_service:
            suffix = "" if compose_file.exists() else " Compose file is not present yet."
            return "docker", f"Local executable missing; using Docker.{suffix}"
        return "local", "Local executable missing and no Docker service is mapped."
    return "local", ""


def should_prefer_docker(tool: ToolSpec) -> bool:
    return os.name == "nt" and tool.key in {"medusa"}


def build_tool_env(tools_dir: Path) -> dict[str, str]:
    env = dict(os.environ)
    path_entries = [
        tools_dir / "bin",
        tools_dir / "python" / "Scripts",
        tools_dir / "python" / "bin",
        tools_dir / "node" / "node_modules" / ".bin",
        tools_dir / "cargo" / "bin",
        tools_dir / "go" / "bin",
        tools_dir / "foundry" / "bin",
    ]
    existing_path = env.get("PATH", "")
    prefix = os.pathsep.join(str(path) for path in path_entries)
    env["PATH"] = prefix + (os.pathsep + existing_path if existing_path else "")
    env.setdefault("CARGO_HOME", str(tools_dir / "cargo"))
    env.setdefault("GOBIN", str(tools_dir / "go" / "bin"))
    env.setdefault("FOUNDRY_DIR", str(tools_dir / "foundry"))
    env.setdefault("npm_config_prefix", str(tools_dir / "node"))
    return env


def find_executable(executable: str | None, env: dict[str, str]) -> str | None:
    if not executable:
        return None
    found = shutil.which(executable, path=env.get("PATH"))
    return found


def resolve_path(root: Path, value: Any) -> Path:
    path = Path(str(value))
    if path.is_absolute():
        return path.resolve()
    return (root / path).resolve()


def container_path(path: Path, root: Path) -> str:
    try:
        relative = path.resolve().relative_to(root.resolve())
        value = "/workspace" if str(relative) == "." else "/workspace/" + relative.as_posix()
        return quote(value)
    except ValueError:
        return quote(path.as_posix())


def command_arg(value: str) -> str:
    return '"' + value.replace('"', '\\"') + '"'


def write_if_missing(path: Path, content: str, force: bool) -> None:
    if path.exists() and not force:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def powershell_env_text(tools_dir: Path) -> str:
    paths = [
        tools_dir / "bin",
        tools_dir / "python" / "Scripts",
        tools_dir / "node" / "node_modules" / ".bin",
        tools_dir / "cargo" / "bin",
        tools_dir / "go" / "bin",
        tools_dir / "foundry" / "bin",
    ]
    path_literal = ";".join(str(path) for path in paths)
    return textwrap.dedent(
        f"""
        $env:AUDIT_TOOLS_DIR = "{tools_dir}"
        $env:CARGO_HOME = Join-Path $env:AUDIT_TOOLS_DIR "cargo"
        $env:GOBIN = Join-Path $env:AUDIT_TOOLS_DIR "go/bin"
        $env:FOUNDRY_DIR = Join-Path $env:AUDIT_TOOLS_DIR "foundry"
        $env:npm_config_prefix = Join-Path $env:AUDIT_TOOLS_DIR "node"
        $env:PATH = "{path_literal};$env:PATH"
        """
    ).lstrip()


def shell_env_text(tools_dir: Path) -> str:
    unix_tools_dir = tools_dir.as_posix()
    return textwrap.dedent(
        f"""
        export AUDIT_TOOLS_DIR="{unix_tools_dir}"
        export CARGO_HOME="$AUDIT_TOOLS_DIR/cargo"
        export GOBIN="$AUDIT_TOOLS_DIR/go/bin"
        export FOUNDRY_DIR="$AUDIT_TOOLS_DIR/foundry"
        export npm_config_prefix="$AUDIT_TOOLS_DIR/node"
        export PATH="$AUDIT_TOOLS_DIR/bin:$AUDIT_TOOLS_DIR/python/bin:$AUDIT_TOOLS_DIR/node/node_modules/.bin:$AUDIT_TOOLS_DIR/cargo/bin:$AUDIT_TOOLS_DIR/go/bin:$AUDIT_TOOLS_DIR/foundry/bin:$PATH"
        """
    ).lstrip()


def tools_dir_readme_text(tools_dir: Path) -> str:
    return textwrap.dedent(
        f"""
        # Audit Tools Directory

        This directory is reserved for project-local audit tooling.

        Path: `{tools_dir}`

        Expected subdirectories:

        - `venvs/` for isolated Python virtual environments
        - `python/` for legacy/shared Python tools
        - `node/` for npm packages installed with `--prefix`
        - `cargo/bin/` for Rust tools installed with `cargo install --root`
        - `go/bin/` for Go tools installed with `GOBIN`
        - `foundry/bin/` for Foundry binaries
        - `bin/` for custom wrappers

        Use `env.ps1` or `env.sh` to add these tools to PATH for this project only.
        """
    ).lstrip()


def quote(value: str) -> str:
    if not value:
        return '""'
    if re.search(r"\s", value):
        return '"' + value.replace('"', '\\"') + '"'
    return value


def default_config_text() -> str:
    return textwrap.dedent(
        """
        [project]
        name = "my-protocol"
        root = "."
        reports_dir = "reports"
        tools_dir = ".audit-tools"
        runner = "local"
        compose_file = "docker/docker-compose.audit.yml"
        default_fail_on = "critical"

        [scope]
        targets = ["src", "contracts"]
        exclude = ["lib", "node_modules", "broadcast", "cache", "out"]

        [profiles]
        default = "fast"

        [chains.base]
        name = "Base Mainnet"
        chain_id = 8453
        rpc_url_env = "BASE_RPC_URL"
        explorer = "BaseScan"
        explorer_url = "https://basescan.org"
        explorer_api_url = "https://api.basescan.org/api"
        explorer_api_key_env = "BASESCAN_API_KEY"

        [targets.example_base]
        chain = "base"
        address = "0x0000000000000000000000000000000000000000"
        fork_block = ""

        # Override any built-in tool command here.
        # [tools.slither]
        # enabled = true
        # command = "slither {root} --json {out}"
        # timeout_seconds = 900
        # profiles = ["fast", "standard", "full"]
        """
    ).lstrip()


def make_finding(
    tool: str,
    severity: str,
    confidence: str,
    category: str,
    title: str,
    description: str,
    recommendation: str = "",
    contract: str = "",
    function: str = "",
    file: str = "",
    line: int | None = None,
    evidence: str = "",
    raw: dict[str, Any] | None = None,
) -> Finding:
    normalized = {
        "tool": tool,
        "severity": normalize_severity(severity),
        "category": category,
        "title": title,
        "file": file,
        "line": line,
        "description": description,
    }
    digest = hashlib.sha256(json.dumps(normalized, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]
    return Finding(
        id=digest,
        tool=tool,
        severity=normalized["severity"],
        confidence=normalize_confidence(confidence),
        category=category,
        title=title,
        description=description,
        recommendation=recommendation,
        contract=contract,
        function=function,
        file=file,
        line=line,
        evidence=evidence,
        raw=raw or {},
    )


def deduplicate_findings(findings: list[Finding]) -> list[Finding]:
    by_key: dict[tuple[str, str, int | None, str, str], Finding] = {}
    for finding in findings:
        key = (finding.file, finding.category, finding.line, finding.title, finding.description[:120])
        existing = by_key.get(key)
        if not existing or severity_rank(finding.severity) > severity_rank(existing.severity):
            by_key[key] = finding
    return list(by_key.values())


def summarize(runs: list[ToolRun], findings: list[Finding]) -> dict[str, Any]:
    severity_counts = {"critical": 0, "high": 0, "medium": 0, "low": 0, "informational": 0}
    for finding in findings:
        severity_counts[normalize_severity(finding.severity)] = severity_counts.get(normalize_severity(finding.severity), 0) + 1
    status_counts: dict[str, int] = {}
    for run in runs:
        status_counts[run.status] = status_counts.get(run.status, 0) + 1
    return {
        "total_findings": len(findings),
        "severity_counts": severity_counts,
        "tool_status_counts": status_counts,
    }


def tool_run_to_dict(run: ToolRun) -> dict[str, Any]:
    return {
        "key": run.tool.key,
        "name": run.tool.name,
        "category": run.tool.category,
        "mode": run.tool.mode,
        "status": run.status,
        "runner": run.runner,
        "command": run.command,
        "started_at": run.started_at,
        "ended_at": run.ended_at,
        "duration_seconds": run.duration_seconds,
        "exit_code": run.exit_code,
        "stdout_path": run.stdout_path,
        "stderr_path": run.stderr_path,
        "output_path": run.output_path,
        "message": run.message,
    }


def finding_to_dict(finding: Finding) -> dict[str, Any]:
    return {
        "id": finding.id,
        "tool": finding.tool,
        "severity": finding.severity,
        "confidence": finding.confidence,
        "category": finding.category,
        "title": finding.title,
        "description": finding.description,
        "recommendation": finding.recommendation,
        "contract": finding.contract,
        "function": finding.function,
        "file": finding.file,
        "line": finding.line,
        "evidence": finding.evidence,
        "status": finding.status,
        "raw": finding.raw,
    }


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError:
        return {}


def first_source_mapping(item: dict[str, Any]) -> dict[str, Any]:
    elements = item.get("elements")
    if isinstance(elements, list):
        for element in elements:
            if not isinstance(element, dict):
                continue
            mapping = element.get("source_mapping")
            if not isinstance(mapping, dict):
                continue
            lines = mapping.get("lines")
            line = lines[0] if isinstance(lines, list) and lines else mapping.get("line")
            return {
                "file": str(mapping.get("filename_relative") or mapping.get("filename_absolute") or mapping.get("filename") or ""),
                "line": int_or_none(line),
            }
    return {"file": "", "line": None}


def format_run_status(run: ToolRun) -> str:
    detail = f" - {run.message}" if run.message else ""
    return f"[{run.status}/{run.runner}] {run.tool.key}{detail}"


def format_location(finding: Finding) -> str:
    if finding.file and finding.line:
        return f"{finding.file}:{finding.line}"
    return finding.file


def finding_sort_key(finding: Finding) -> tuple[int, str, str]:
    return (-severity_rank(finding.severity), finding.file, finding.title)


def threshold_breached(findings: list[Finding], threshold: str) -> bool:
    target = severity_rank(threshold)
    return any(severity_rank(finding.severity) >= target for finding in findings)


def severity_rank(value: str) -> int:
    return SEVERITY_ORDER.get(value.lower(), 0)


def severity_score(value: str) -> float:
    return {"critical": 9.5, "high": 8.0, "medium": 5.0, "low": 2.0, "informational": 0.0}.get(normalize_severity(value), 0.0)


def normalize_severity(value: str) -> str:
    normalized = value.strip().lower()
    if normalized in ("critical",):
        return "critical"
    if normalized in ("high", "error"):
        return "high"
    if normalized in ("medium", "moderate", "warning"):
        return "medium"
    if normalized in ("low",):
        return "low"
    return "informational"


def normalize_confidence(value: str) -> str:
    normalized = value.strip().lower()
    if normalized in ("high", "medium", "low"):
        return normalized
    return "medium"


def sarif_level(severity: str) -> str:
    return {
        "critical": "error",
        "high": "error",
        "medium": "warning",
        "low": "note",
        "informational": "note",
    }.get(normalize_severity(severity), "note")


def int_or_none(value: Any) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def normalize_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")


def escape_md(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


def now_iso() -> str:
    return dt.datetime.now(UTC).isoformat()


if __name__ == "__main__":
    raise SystemExit(main())
