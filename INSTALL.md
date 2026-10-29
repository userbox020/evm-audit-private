# Install Steps

This project supports two installation modes:

- Project-local tools under `.audit-tools/`
- Docker-backed tools under `docker/`

Use both for the most complete audit coverage. Some tools are easier and more reliable in Docker, especially on Windows.

## 1. Prerequisites

Install these first:

```text
Python 3.10+
Node.js + npm
Docker Desktop
Git
Go
Rust + Cargo
Foundry
```

Foundry can be installed from:

```text
https://getfoundry.sh/
```

## 2. Bootstrap Local Tool Folder

From the project root:

```powershell
python audit.py bootstrap --force
```

This creates:

```text
.audit-tools/
  bin/
  cache/
  venvs/
  python/
  node/
  cargo/bin/
  go/bin/
  foundry/bin/
  env.ps1
  env.sh
```

## 3. Activate Local Tool PATH

PowerShell:

```powershell
. .audit-tools/env.ps1
```

Bash/sh:

```bash
source .audit-tools/env.sh
```

The CLI also prepends `.audit-tools` paths automatically when it runs tools.

## 4. Install Local Tools

PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts/install-local.ps1" -Python -Node -Go
```

Bash/sh:

```bash
sh scripts/install-local.sh --python --node --go
```

Recommended local tools include:

```text
Solhint
Slither
Semgrep
Foundry / Forge
Wake
Manticore
Halmos
Scribble
Solidity SMTChecker / solc
Certora CLI
Forta Agent
```

## 5. Build Docker Tools

Build all Docker-backed audit images:

```powershell
docker compose -f "docker/docker-compose.audit.yml" build
```

Or:

```bash
sh scripts/build-docker.sh
```

Docker is used for tools that are heavier, Linux-oriented, or unreliable on Windows:

```text
Aderyn
Mythril
Medusa
Heimdall
Securify
SmartCheck
Echidna/toolbox tools
Formal/toolbox tools
```

## 6. Verify Installation

Check all tool mappings:

```powershell
python -B audit.py doctor --profile full --runner auto --config "audit.example.toml"
```

Run a fast dry-run:

```powershell
python -B audit.py run fast --dry-run --runner auto --config "audit.example.toml"
```

List supported EVM chains:

```powershell
python -B audit.py list-chains --config "audit.example.toml"
```

Smoke-test common tools:

```powershell
& ".audit-tools/bin/slither.cmd" --version
& ".audit-tools/bin/semgrep.cmd" --version
& ".audit-tools/bin/halmos.cmd" --version
docker compose -f "docker/docker-compose.audit.yml" run --rm aderyn aderyn --version
docker compose -f "docker/docker-compose.audit.yml" run --rm mythril myth version
docker compose -f "docker/docker-compose.audit.yml" run --rm medusa medusa --version
docker compose -f "docker/docker-compose.audit.yml" run --rm bytecode heimdall --version
```

## 7. Audit A Contract Project

Audit a local Solidity/Foundry/Hardhat project:

```powershell
python -B audit.py run fast --root "C:\path\to\contract-project" --runner auto
```

Run a broader standard profile:

```powershell
python -B audit.py run standard --root "C:\path\to\contract-project" --runner auto
```

Run deeper checks:

```powershell
python -B audit.py run deep --root "C:\path\to\contract-project" --runner auto
```

Run everything configured:

```powershell
python -B audit.py run full --root "C:\path\to\contract-project" --runner auto --include-manual
```

Audit a project with Base/Coinbase deployed-contract context:

```powershell
$env:BASE_RPC_URL = "https://your-base-rpc.example"
python -B audit.py run fast --root "C:\path\to\contract-project" --chain base --address "0x0000000000000000000000000000000000000000" --runner auto
```

`coinbase` is accepted as an alias for `base`:

```powershell
python -B audit.py run deployed --chain coinbase --address "0x0000000000000000000000000000000000000000" --runner auto
```

Use configured targets in `audit.toml`:

```toml
[targets.vault]
chain = "base"
address = "0x0000000000000000000000000000000000000000"
fork_block = ""
```

Then run:

```powershell
python -B audit.py run deployed --target vault --runner auto
```

## 8. Reports

Reports are written to:

```text
reports/
  findings.json
  findings.sarif
  report.md
  raw/<profile>/<tool>/
```

Use `report.md` for human review and `findings.json` for normalized machine-readable output.

## 9. Notes

On Windows, some tools should be Docker-preferred even if a local binary exists.

`Mythril` may fail to install locally on Windows because of native `pyethash` build issues. Use Docker for Mythril.

`Medusa` is Docker-preferred on Windows.

SaaS/manual tools still require credentials or external setup:

```text
SolidityScan
Diligence Fuzzing
Dedaub
BlockSec Phalcon
Sourcify verification workflows
OpenZeppelin Monitor workflows
Tenderly simulations
```
