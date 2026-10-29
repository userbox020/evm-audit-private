# Existing fork runtime (Windows and Docker)

**Inventory observed 2026-10-15 UTC.** This is a reusable map, not a guarantee of
permanent availability or proof that a fork succeeded. Revalidate cheaply if the
environment changed; do not restart environment discovery for each manual task.
Authorization and secret handling remain governed by
[project instructions](.opencode/oh-my-opencode-slim/project-instructions.md).

## Start here: ordinary manual local validation

1. Keep the requested goal: manual fork validation is not epoch/autopilot activation.
   Default to the existing Windows harness below unless the task explicitly needs
   another backend. Linux, Docker and production storage qualification are not
   blanket prerequisites for an ordinary manual local fork.
2. Check only the required executable/dependency and the relevant reviewed scenario,
   source, chain and block/hash pins. Reuse existing evidence where applicable;
   a runtime being installed does not authorize a scenario or waive its requirements.
3. If blocked, report the precise missing dependency, pin, capability or authorization.
   Do not default to installing tools, selecting a new host or asking the user for
   locally readable nonsecret metadata. Inspect Docker only for a Docker-needed task.

### Minimal offline preflight (PowerShell, workspace root)

These are examples for a task-approved check, not instructions to launch a fork.
They do not require endpoint, key or environment-file reads:

```powershell
Get-Command anvil, forge, cast | Select-Object Name, Source
& 'C:\Users\MiPC\.foundry\bin\anvil.exe' --version
& 'C:\Users\MiPC\.foundry\bin\forge.exe' --version
& 'C:\Users\MiPC\.foundry\bin\cast.exe' --version
node -e "console.log(require.resolve('ethers', { paths: [require('node:path').resolve('tools')] }))"
```

Only if the validation owner agrees, the following checks the harness's offline
usage refusal: **no `--run`, no RPC**, and a refusal/nonzero exit is expected:

```powershell
node tools/run-fork-poc.js
```

Do not run full audit/epoch suites just to verify this documentation. Do not dump
environments, process arguments, Docker inspect output or logs. Never expose endpoint
material or read key/account files as part of tooling discovery.

## Windows inventory

| Observed item | Location / limitation |
|---|---|
| Foundry on Windows PATH | `C:\Users\MiPC\.foundry\bin\{forge,anvil,cast}.exe`; all reported **1.5.1 stable**, commit `b0a9dd9` |
| Medusa | `C:\Users\MiPC\go\bin\medusa.exe` present on PATH; version not executed |
| Project wrappers | `.audit-tools/bin/*.cmd`: slither, semgrep, wake, manticore, halmos, solc-select, certoraRun |
| Project Python executables | `.audit-tools/python/Scripts/` present; not all runtime capabilities tested |
| Project Node executables | `.audit-tools/node/node_modules/.bin/`: solhint, solcjs, scribble, forta-agent; presence is not capability validation |
| Harness dependency | `ethers` resolves from `tools/node_modules`; `tools/package.json` pins **6.17.0**. No reinstall needed when resolution works |
| Project-local Foundry | `.audit-tools/foundry/bin/` was empty; the real Foundry installation is the user-profile path above |

[`.audit-tools/env.ps1`](.audit-tools/env.ps1) prepends project tool directories,
including the empty project Foundry directory, while retaining the existing PATH.
The user-profile Foundry PATH is still needed for bare commands; the manual harness
uses its absolute Anvil path. The audit CLI prepends project tool paths itself:
**no shell activation is needed for CLI runs**. See [INSTALL.md](INSTALL.md) for
installation procedures only when a genuine missing dependency requires them;
`tools/` has its own npm package/lockfile, separate from the root.

The Windows process snapshot contained no `anvil.exe` or `forge.exe`. This is not
proof about all WSL processes. A previous read-only WSL observation showed Ubuntu
22.04.5, kernel `6.18.54.1-microsoft-standard-WSL2`, ext4 virtual disk and cgroup2:
WSL is not a dedicated Linux host and is not required for the Windows manual path.

## Manual harness, scenarios and artifacts

- Canonical entrypoint: [`tools/run-fork-poc.js`](tools/run-fork-poc.js), a **Node**
  harness, not a Forge command. Its `ANVIL_PATH` (line 56 at this snapshot) hardcodes
  `C:/Users/MiPC/.foundry/bin/anvil.exe`. Without `--run`, it only refuses with usage
  and performs no RPC.
- Existing scenarios live in [`tools/fork-poc/`](tools/fork-poc/) and
  [`tools/fork-poc/triggers/`](tools/fork-poc/triggers/). Not every script there is
  a scenario. Reuse the relevant reviewed scenario and its required pins; do not
  select a target or invent a scenario merely to exercise the runtime.

**Template only — do not execute placeholders or use this to select a target:**

```text
node tools/run-fork-poc.js --chain <chain-id> --block <block-number|finalized> --scenario <reviewed-local-scenario.js> --run
```

- Default output: `reports/raw/fast/fork-poc/<scenario>.json`. A rerun with the same
   scenario name rewrites that artifact. Preserve the prior artifact before an
   explicitly authorized rerun; do not rename a reviewed scenario merely to avoid
   collisions or automatically delete history. The inventory found **42 JSON filenames** here;
  their contents/historical success were not validated.
- [`tools/run-trigger-fork-poc.js`](tools/run-trigger-fork-poc.js) is the trigger
  bridge into the same manual harness, not permission to activate automation.
- The default manual path is keyless and uses local impersonation. Helpers from
  [`tools/run-approved-fork-validation.js`](tools/run-approved-fork-validation.js)
  supply an allowlisted **read-only loopback relay**: upstream endpoint material
  stays process-only; Anvil sees the loopback relay, not a raw upstream
  `--fork-url`. Never pass upstream credentials on child command lines, dump
  environments, or forward transactions upstream.
- Do not generalize this to “the module can never sign”: opt-in context EIP-7702
  helpers use an ephemeral in-memory test key and submit only to local Anvil.
  That extension was outside this inspection and is not enabled by this runbook.

### Manual execution is not epoch readiness

[`tools/lib/trigger-fork-epoch-execution.js`](tools/lib/trigger-fork-epoch-execution.js)
`asyncBlock` permits a valid `MANUAL` diagnostic context; the manual `runForkPoc`
then calls the real asynchronous `runManualForkPoc` path. A validated `EPOCH_OWNER`
context instead receives `PLATFORM_RUNTIME_UNIMPLEMENTED` (invalid envelopes fail
separately). Native epoch `admitEvent`/promotion/CLI remain **INACTIVE / NOT_READY**.
Do not turn production storage/containment qualification into a blanket manual-fork
block, and do not use manual availability to waive source/scenario/economic,
authorization, platform, delivery/import/recovery or automation holds.

The standalone **approved-validation runner is not a generic drop-in** for this
Windows path. It requires a valid manifest and approved batch, pinned Anvil and
Linux `O_NOFOLLOW` stable execution. Sharing its relay helpers does not transfer its
runner contract. Do not route a Windows manual task through that runner, adapt it
to bypass checks, or treat this document as batch approval.

## Scenario evidence index

**Index checked 2026-10-15; evidence below is historical (2026-09-19), not a fresh
chain observation or current run approval.** This bounded map followed 29 JavaScript
filenames and targeted handoffs; it is not an exhaustive catalog. A source file,
independent review, quote probe and executed fork are different evidence classes.
None establishes current profitability or executable-now readiness.

| Scenario source | Chain | Established evidence and remaining check |
|---|---|---|
| [FRAX/USDC cross-venue](tools/fork-poc/triggers/frax-usdc-cross-venue.js) | Ethereum (1) | [Independent APPROVE](coordination/handoffs/20260919-frax-atomic-coverage-closeout.md), implementation/tests only: no fork executed, no gross edge. Requires an exact finalized number/hash and bound scenario inputs; no permanent block is prescribed. [2026-10-15 offline check](reports/fork-scenario-evidence-20261015.md): current source/creation/runtime commitments match; artifacts `26012854` (FAIL_CLOSED) and `26012917` (PASS) are retained probes but are NOT established as this adapter's execution. [2026-10-15 constant check + 2026-10-16 source-bound negative-control](reports/critical-frax-negative-control-20261016.md): trigger constants verified honest (uni `0xC63B…D52` = factory FRAX/USDC fee-500 pool; Curve FraxBP pool/coins verified); a fresh-finalized-pin rerun (26201414) observed FAIL_CLOSED with −6.7 bps quoted gross, `NO_GROSS_EDGE` — consistent with the closeout's fire gate (reopen only on `ATOMIC_FORK_REQUIRED`). No route-positive inference. Note: the compiled artifact has no `chainId` field and its test asserts no runtime hash/chainId. |
| [Balancer V2 cross-venue](tools/fork-poc/triggers/balancer-v2-eth-cross-venue.js) | Ethereum (1) | [Documented probe/fork](coordination/handoffs/20260919-balancer-v2-eth-cross-venue.md): quote probe 26013013, fork 26013172. Handoff reports both swaps reached, then `gross` revert; this is not completed repayment/residual proof. [2026-10-15 source-bound negative-control](reports/critical-balancer-negative-control-20261015.md) at the fork pin reproduced the fail-closed outcome (6/6 input asserts, −1.46 bps quoted gross) and found the trigger's `uniPool` constant was a stale misbinding (WETH/USDT fee-500 vs the executed USDC/USDT fee-100 pool `0x3416cF6C…27C6`). [Constant fixed and source-bound rerun](reports/critical-balancer-fork-fix-20261015.md) re-established commitments with the honest binding: trigger SHA `7158c551…40c35` → `800c3d32…5ea107a`; same fail-closed economics. Historical exact-source/adapter link (old bytes) remains unverified; no independent sign-off claim; no route-positive inference. |
| [Balancer V2 cross-venue](tools/fork-poc/triggers/balancer-v2-base-cross-venue.js) | Base (8453) | [Same-pin probe](coordination/handoffs/20260919-balancer-v2-eth-cross-venue.md), 51526423: 16/16 legs exact, no gross edge. [2026-10-15 offline check](reports/fork-scenario-evidence-20261015.md): current source/creation/runtime commitments match; both retained probe artifacts record pin 51526423 (PASS). Probe evidence only, not a full adapter rehearsal; not independently sign-off. |
| [Balancer V2 join/exit](tools/fork-poc/triggers/balancer-v2-eth-join-exit.js) | Ethereum (1) | [R-class probe](coordination/handoffs/20260919-r-class-join-exit-coverage.md): join quote matched mined join; redemption at least the quote. [2026-10-15 offline check](reports/fork-scenario-evidence-20261015.md): current commitments match; retained artifact records pin 26013585 (PASS). Probe evidence only; not independently reviewed. |
| [Curve join/exit](tools/fork-poc/triggers/curve-eth-join-exit.js) | Ethereum (1) | [R-class probe](coordination/handoffs/20260919-r-class-join-exit-coverage.md): composite view could exceed mined result by up to 0.83 bps; 2 bps suppress-only haircut, `quoteExecutable=false`. [2026-10-15 offline check](reports/fork-scenario-evidence-20261015.md): current commitments match; retained artifact records pin 26013806 (PASS). Probe evidence only; not an exact quote claim. |
| [Curve join/exit](tools/fork-poc/triggers/curve-base-join-exit.js) | Base (8453) | [R-class probe](coordination/handoffs/20260919-r-class-join-exit-coverage.md): composite quote did not exceed mined result, `quoteExecutable=true`. [2026-10-15 offline check](reports/fork-scenario-evidence-20261015.md): current commitments match; retained artifact records pin 51529329 (PASS). Probe evidence only; not independently reviewed. |

Before proposing a rerun, compare the actual scenario, contract source and compiled
artifact commitments with the retained evidence; recover the exact chain/block-number/
block-hash bindings and required input context. A self-consistent compiled artifact
alone is not proof those bytes were independently reviewed or historically executed.
Preserve the previous output before any authorized rerun; the default output is overwritten.

For the checked Ethereum Balancer adapter, source/bytecode hash assertions are in
`tools/test-balancer-v2-eth-cross-venue.js`, not enforced merely by importing the
compiled artifact in the scenario. The full test recompiles; do not run it just to
check documentation or confuse a runtime-bytecode template hash with deployed
runtime containing constructor-substituted immutables. Recorded historical pin
hashes recovered offline are not fresh canonical-chain verification.

Do not transfer the separate [Aave rehearsal evidence](coordination/handoffs/20261012-orchestrator-aave-v3-fork-rehearsal-refresh-handoff.md)
for `tools/aave-v3-flash-liquidator-rehearsal.js` to
`tools/fork-poc/triggers/aave-v3-eth-l.js` without an explicit binding. Templates,
discovery utilities and source-only scenarios are not implicitly reviewed entries.
The Base Balancer single-token join/exit and stale Curve cyToken-wrapper evidence
were rejected in the R-class handoff; neither is a validated substitute for these rows.

## Docker: existing backend, only inspect when needed

Observed local metadata (not a capability test):

- Context `desktop-linux`, named-pipe (`npipe`) connection; no `DOCKER_HOST` or
  `DOCKER_CONTEXT` overrides. Server **29.6.1**, Linux, `overlay2`, Docker root
  `/var/lib/docker`.
- **16 containers: 2 running, 14 stopped; no EVM fork container identified.** The
  running FastAPI and BuildKit containers were unrelated: leave them alone.
  No active `evm-audit` Compose project was observed; `api_v4` was unrelated.
- The only workspace bind match was a **stopped Solana validator**, image
  `agave-validator:2.1`, old exit 255 (roughly four months old). Read-only binds:
  `C:\_Work\__EVM_AUDIT\targets\loopscale\hack\harness\accounts_json` to `/accounts`
  and the sibling `programs` directory to `/programs`. Do not start it, use it for
  EVM work or open its account files.
- Related images present: `ghcr.io/foundry-rs/foundry:v1.3.6`,
  `evm-audit-bytecode:latest`, `ethereum/solc:0.6.1`, `agave-validator:2.1`,
  `solanalabs/solana:stable`. Image presence proves neither prior successful runs
  nor current runtime capability.
- Docker's backing store was
  `C:\Users\MiPC\AppData\Local\Docker\wsl\disk\docker_data.vhdx`.
  **Never edit, move or prune the VHD.** Its presence is not storage qualification.

[`docker/docker-compose.audit.yml`](docker/docker-compose.audit.yml) declares project
`evm-audit`, workspace root bound to `/workspace` and `.audit-tools` to `/tools`.
Services: `toolbox`, `static`, `node`, `semgrep`, `foundry`, `mythril`, `aderyn`,
`securify`, `smartcheck`, `medusa`, `formal`, `certora`, `bytecode`, `ops`.
See the Compose file and [INSTALL.md](INSTALL.md) rather than inventing another
container setup. Its Foundry service declares **`:latest`**, not the observed
image **`:v1.3.6`** or Windows binary **1.5.1**: no silent substitution or pull.

The [audit CLI](src/evm_audit_cli/cli.py) renders `docker compose ... run --rm`
(around line 1663), so a persistent audit container is not expected. Runner `auto`
chooses by availability, **not** retry-after-failure; Medusa is Docker-preferred
on Windows. Docker selection does not convert unmapped tools into Docker services.
Use only allowlisted nonsecret metadata if inspection is actually needed; do not
dump inspect/logs/environment/arguments. This map authorizes no service starts,
pulls, builds, installations, host changes or automation activation.
