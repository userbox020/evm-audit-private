# EVM Audit CLI

Profile-based audit runner for Solidity, Vyper, bytecode, formal verification, fuzzing, and runtime-monitoring workflows.

The system is designed to integrate many tools without forcing every tool to run on every commit. Profiles decide which tools are relevant for each phase.

## Profiles

| Profile | Purpose |
| --- | --- |
| `fast` | PR-safe checks: linting, static analysis, tests, basic fuzzing |
| `standard` | Normal manual or nightly audit scan |
| `deep` | Fuzzing and symbolic execution |
| `formal` | Formal/specification verification |
| `deployed` | Deployed bytecode/source verification and simulation |
| `monitor` | Runtime monitoring setup and checks |
| `full` | Everything configured |

## Quick Start

Full setup instructions are in [`INSTALL.md`](INSTALL.md).

```bash
python audit.py init
python audit.py bootstrap
python audit.py list-tools
python audit.py list-chains
python audit.py run fast --dry-run
```

After installation:

```bash
pip install -e .
evm-audit run fast
```

## Project-Local Tools

Use `bootstrap` to create a local tool area under `.audit-tools/`:

```bash
python audit.py bootstrap
```

This creates:

```text
.audit-tools/
  bin/
  python/
  node/
  cargo/bin/
  go/bin/
  foundry/bin/
  env.ps1
  env.sh
```

Activate the project-local PATH:

```powershell
. .audit-tools/env.ps1
```

Or on sh/bash:

```bash
source .audit-tools/env.sh
```

Install local tools into `.audit-tools/`:

```powershell
./scripts/install-local.ps1 -All
```

Or:

```bash
sh scripts/install-local.sh --all
```

Then check availability:

```bash
python audit.py doctor --profile fast
```

The CLI prepends `.audit-tools` paths automatically when running tools, so global installation is not required for supported local installs.

## Docker Tools

Docker-backed tools live under `docker/`:

```text
docker/
  docker-compose.audit.yml
  Dockerfile.toolbox
  Dockerfile.static
  Dockerfile.node
  Dockerfile.aderyn
  Dockerfile.securify
  Dockerfile.smartcheck
  Dockerfile.medusa
  Dockerfile.formal
  Dockerfile.bytecode
  Dockerfile.ops
```

Build all configured audit images:

```bash
docker compose -f docker/docker-compose.audit.yml build
```

Run a profile through Docker:

```bash
python audit.py run fast --runner docker
```

Audit an external contract repository or folder:

```bash
python audit.py run fast --root /path/to/protocol --runner auto
```

Audit with deployed chain context, for example Base:

```bash
python audit.py run fast --root /path/to/protocol --chain base --address 0x0000000000000000000000000000000000000000 --runner auto
```

Use automatic fallback: local executable first, Docker if missing:

```bash
python audit.py run fast --runner auto
```

Manual Docker usage also works:

```bash
docker compose -f docker/docker-compose.audit.yml run --rm toolbox slither /workspace
docker compose -f docker/docker-compose.audit.yml run --rm foundry forge test -vvv
docker compose -f docker/docker-compose.audit.yml run --rm semgrep semgrep --config p/solidity /workspace
```

## Reports

Each run writes:

```text
reports/
  findings.json
  findings.sarif
  report.md
  raw/<profile>/<tool>/
```

`findings.json` is the normalized machine-readable audit output. `report.md` is the human-readable report. `findings.sarif` is intended for GitHub/GitLab code-scanning integrations.

## Configuration

Run `python audit.py init` to generate `audit.toml`.

The CLI searches for config in this order:

```text
audit.toml
audit.json
audit.yaml
audit.yml
```

YAML config is supported when `PyYAML` is installed:

```bash
pip install -e .[yaml]
```

## EVM Chains

The CLI has built-in presets for common EVM chains:

```bash
python audit.py list-chains
```

Built-in keys include:

- `ethereum`
- `sepolia`
- `base`
- `base_sepolia`
- `arbitrum`
- `optimism`
- `polygon`
- `bnb`
- `avalanche`
- `gnosis`
- `linea`
- `scroll`

`coinbase` is accepted as an alias for `base`.

Add custom chains in `audit.toml`:

```toml
[chains.base]
name = "Base Mainnet"
chain_id = 8453
rpc_url_env = "BASE_RPC_URL"
explorer = "BaseScan"
explorer_url = "https://basescan.org"
explorer_api_url = "https://api.basescan.org/api"
explorer_api_key_env = "BASESCAN_API_KEY"

[targets.vault]
chain = "base"
address = "0x0000000000000000000000000000000000000000"
fork_block = ""
```

Run a configured target:

```bash
python audit.py run deployed --target vault --runner auto
```

Tool commands may use these placeholders:

```text
{chain}
{chain_name}
{chain_id}
{rpc_url}
{rpc_url_env}
{explorer_url}
{explorer_api_url}
{explorer_api_key_env}
{address}
{fork_block}
{target_ref}
```

## Tool Strategy

All requested tools are represented in the registry. Some are local CLI tools, while commercial/SaaS/manual tools are marked as `manual` unless a command is configured.

Default local tools include:

- `Slither`
- `Cyfrin Aderyn`
- `Wake / Wake Detect`
- `Securify 2.0`
- `SmartCheck`
- `Solhint`
- `Semgrep Smart Contracts`
- `Remix Analyzer`
- `Mythril`
- `Manticore`
- `Halmos`
- `hevm`
- `Foundry / Forge`
- `Echidna`
- `Medusa`
- `Scribble`
- `Solidity SMTChecker`
- `Certora Prover`
- `Kontrol`
- `KEVM`
- `VeriSol`
- `solc-verify`
- `Heimdall-rs`
- `Sourcify`
- `Tenderly CLI`
- `Forta CLI`
- `OpenZeppelin Monitor`

Manual/API-backed tools include:

- `SolidityScan`
- `Diligence Fuzzing`
- `Dedaub`
- `BlockSec Phalcon`

## Exit Codes

| Code | Meaning |
| ---: | --- |
| `0` | Run completed without threshold breach |
| `2` | Findings met or exceeded `--fail-on` severity |
| `3` | Tool failure with `--strict-tool-failures` |

## Notes

The built-in commands are safe defaults, but many tools require project-specific configuration. Override any command in `audit.toml` under `[tools.<tool_key>]`.

Useful project-level settings:

```toml
[project]
tools_dir = ".audit-tools"
runner = "local" # local, docker, or auto
compose_file = "docker/docker-compose.audit.yml"
```
