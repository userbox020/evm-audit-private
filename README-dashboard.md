# Local Watchboard

Local Flask watchboard for an explicit artifact allowlist, with wallet watchlist management and on-demand balance collection. Starting the dashboard alone does not start background monitor loops.

Run from the workspace root:

```powershell
python -m pip install -r requirements-dashboard.txt
python -m dashboard
```

Open `http://127.0.0.1:5050`. The server binds only to loopback, accepts GET/HEAD/OPTIONS plus the three wallet POST routes below, and emits no-cache and browser security headers. Wallet POST bodies are limited to 4096 bytes and the limit is enforced before the body is buffered: a declared oversize and a terminated/unknown-length stream both return `413 BODY_TOO_LARGE`. Malformed, `null`, scalar or list JSON returns `400 INVALID_JSON` before any side effect; only a JSON object is accepted.

## Jobs and background monitors

Open `/jobs` for the fixed job inventory, current producer PIDs, separate process/task states,
cadences, last/next scheduled runs, result codes, and launch visibility. `/api/v1/jobs` exposes
the same sanitized read-only snapshot. Collection uses a bounded hidden Windows inspector and
a short cache; it never starts or stops a monitored job. The page uses the existing 60-second
refresh and pause controls. Unsupported, failed, or stale inspection shows unknown liveness
and withholds PIDs; a relative script match is explicitly lower confidence. `Ready` means an
idle scheduled task, not a stopped process, and `Disabled` does not prove process absence.
Neither view exposes command arguments, task XML, endpoints, or process environments.

Audit launchers use `tools/launch-hidden.vbs` and a no-console bridge, not minimized
terminal windows. Scheduled actions wait for their original payload and retain its exit
code; persistent monitor starts remain detached. `tools/set-audit-tasks-silent.ps1` is
dry-run by default; `-Apply` updates only the fixed enabled-task allowlist after validating
the installed payload. It preserves arguments, working directories (including inherited
ones), schedules, principals, settings, and disabled tasks; known executable aliases are
pinned to trusted installed binaries. Use this helper rather than hand-editing managed
actions: task managers validate the exact wrapper and inner payload. The dashboard has no
task-management endpoint, and Task Scheduler's own `Hidden` setting does not hide consoles.

## Exploit re-arm canary page

`/canary` is a read-only view of the original three Ethereum sentinels, multichain sentinels, oracle divergence, wallet transactions, and balances. The producers write their status and bounded history files under `reports/raw/fast/exploit-rearm-canary/`. They share a **directory-wide writer lock**: run their one-shots sequentially, rather than starting competing loops against that directory:

```powershell
node tools/refresh-canary-feeds.js --once
```

The refresh command checks that each producer actually published a new observation. `INCOMPLETE` and `FIRED` observations remain visible; neither is converted to `DORMANT`. Each child has a five-minute timeout, and an abandoned writer lock requires attended recovery. Runner health is recorded at `reports/monitor/canary-feeds/status.json` and is exposed read-only by the canary page and `/api/v1/canary` as a sanitized `runner` object that is always present. It reports a fixed status (`UNAVAILABLE`, `RUNNING`, `BLOCKED`, `DEGRADED`, `FAILED`, `UPDATED`), a fixed reason enum (window closed, producer owner present, attended recovery required) or `null`, the bounded updated-feed count and feed ids, and the monitoring-window end. Age is reported separately as `freshness`/`age` (a `RUNNING` run without a `generatedAt` uses `startedAt`), so a previously successful but now stale run is never shown as current health. Malformed, unsupported or oversized status payloads, and any reason/output outside the fixed enums, are rejected and reported as `UNAVAILABLE`; raw producer output is never rendered. The current read-only monitoring window ends **2026-10-25T22:10:00Z**; the runner checks the multichain producer's window before each child. It grants no execution authority. The dedicated producer, when run independently without `--max-hours`, has no implicit lifetime.

On this workstation, `EVMAuditCanaryFeeds` schedules the sequential refresh every five minutes through that window, and `EVMAuditWalletTransactions` refreshes outbound transaction history hourly. Both tasks use `IgnoreNew` to prevent scheduled overlap and run as the logged-in user. Starting Flask alone does not install or start either task. Task state can be inspected with `Get-ScheduledTask -TaskName EVMAuditCanaryFeeds,EVMAuditWalletTransactions`; inspect artifacts as well, because process exit and fresh timestamps do not establish complete observations. The canary runner exits 1 for degraded coverage or operational failure; its status distinguishes them.

A `FIRED` verdict records a condition requiring route review. Execution readiness comes from the separate signed-batch verifier. The page never signs, broadcasts, or renders endpoint or key material; balance refresh uses the fixed first-party collector.

The ops/overview mode panel is always **read-only** (`mode.current = "READ_ONLY"`). A valid, unexpired signed batch keeps its own verifier semantics but is treated as *authorization evidence only*: it does not mean a verified arming controller is connected, and the runtime gate stays `UNKNOWN`. `mode.go_live_ready` is therefore always `false`, `mode.readiness` stays `NOT_READY` with the shared disconnected-controller reason, and `mode.scope` stays `NOT_VERIFIED`. The five campaign gates can be satisfied at most 5 of 6; the canary execution view reports the same readiness/scope contract.


## Wallet watchlist and balance refresh

The wallet controls use these JSON routes:

| POST route | JSON fields | Effect |
| --- | --- | --- |
| `/api/v1/wallets/addresses` | `address`, optional `label` and `family` | Add an address; start collection or queue a follow-up. |
| `/api/v1/wallets/addresses/remove` | `address`, optional `family` | Remove an address; start collection or queue a follow-up. |
| `/api/v1/wallets/refresh` | `{}` | Start balance collection; returns `409` if collection is already running. |

Add/remove requests serialize watchlist mutations within the single dashboard process and atomically update `coordination/watch-addresses.json`. Add/remove/refresh requests can start `node tools/watch-wallet-balances.js --once` asynchronously from the workspace root, with at most one collector running per dashboard process. Watchlist changes during collection queue one coalesced follow-up run; the UI waits until it finishes. Wallet refresh requires `node` on PATH.

Mutations strictly validate the existing stored file before writing: an unsupported schema or container, an invalid entry/family/address, an unknown key, a label over the supported bound, an entry count over 512, or input over 256 KiB is rejected with a sanitized `409 WATCHLIST_UNREADABLE`, the original bytes are left unchanged, and no collector is started. The supported legacy entry forms (a bare address string, or an object with `address` and optional `label`/`family`) are preserved. This strict check is deliberately separate from the tolerant display projection, which may skip or shorten unsupported rows for rendering only.

The wallet collector handles balance refreshes; Venus observations come from the separate producer described below. Loading `/canary` can start balance collection when its snapshot is missing or older than 15 minutes, subject to single-flight and cooldown limits. The JSON GET APIs read local artifacts; execution-authority views also invoke the fixed read-only batch status verifier. `/healthz` reports narrow parser/source liveness only: whether the legacy and Venus PSR artifacts parse and are currently readable. It does not assert observation age, coverage, or execution authority.

## Why Venus data was missing (historical, July 2026)

> Historical context, not a current status assertion. The paragraph below records a July 2026 observation; current publication and coverage must be re-checked against dated artifacts.

The Flask process does not schedule Venus observations. The legacy `reports/monitor/state.json` and alert producer stopped updating on July 14, there was no scheduler or frontend polling, and the newer Venus PSR artifacts were not in the dashboard allowlist. The legacy producer remains stale and unrepaired. The dashboard reads the dedicated bounded `venus-psr-state/v1` state produced by the separate Venus monitor. Only the three Venus rows have been demonstrated fresh; do not interpret the combined 19-row catalog as entirely fresh.

The Venus producer compares fresh read-only captures against cryptographically committed BNB, Ethereum, and Arbitrum fixed-block baselines. Before inventory access it validates each approved raw file hash, schema, block pin, expanded normalized configuration digest, the approved BNB controls supplement, and the Ethereum/Arbitrum treasury supplement hashes. It publishes only normalized configuration digests, drift categories, block pins, timestamps, unresolved-drift history, and sanitized health. It never overwrites raw baselines or publishes endpoint, inventory, provider, raw RPC, or runtime-bytecode material. Each capture runs in a bounded worker that is terminated and awaited on timeout.

The keyless Ethereum public fallback is disabled by default. The production Venus worker now rejects raw-inventory candidates because inventory membership does not establish ownership or permitted access. The existing explicit fallback flag selects only the documented public Ethereum path without opening the inventory. BNB and Arbitrum remain `ACCESS_PROVENANCE_REQUIRED` until a reviewed per-entry access resolver is supplied. No credentialed or app-restricted fallback is attempted:

```powershell
node tools/monitor-venus-psr-multichain.js --once --use-authorized-inventory --allow-public-ethereum-fallback
```

## One-shot Venus refresh

The historical inventory flag remains an opt-in run gate, not evidence of endpoint ownership. This command does not open the inventory:

```powershell
node tools/monitor-venus-psr-multichain.js --once --use-authorized-inventory --allow-public-ethereum-fallback
```

### Active BNB control baseline (historical)

> The baseline and the `2026-08-06` state below are historical records, not current access or coverage claims.

The approved no-replace controls artifact and its raw, normalized-control, and combined BNB commitments are historical baselines. They bind the reviewed destinations and controls at their recorded pin only. Baseline integrity does not establish current access or corroboration. BNB production capture remains access-blocked.

The first authorized state at `2026-08-06T04:17:28.777Z` was overall `CLEAR`: BNB block `114287836`, Ethereum block `25693372`, and Arbitrum block `491581825`, with all current digests equal to committed baselines. The state is read-only, records zero upstream transactions and no signing, and contains no provider material. API and health test-client requests returned `200`; all three Venus rows were `FRESH/CLEAR`, while legacy source health remained separately visible. Normalized drift reopens an alert, and an `ERROR` never clears unresolved prior drift.

Use `--check-only` to avoid publication; with the public fallback enabled it can still perform public reads. Omitting `--use-authorized-inventory` returns an authorization-required summary. Every successful v1 Venus observation, including historical records without the new `rpcStrength` field, is single-provider evidence. `CLEAR` means only that the observed configuration matched the baseline; it is not two-family corroboration, a safety certificate, or a profit result.

## Live dashboard

The launcher starts the hourly Venus producer loop and the dashboard together, prevents duplicate monitor loops, passes no endpoint text on child arguments, and stops the monitor child when the dashboard exits. It requires `node` and the Windows `py` launcher on PATH, plus an existing `reports/monitor/` directory:

```powershell
.\tools\start-dashboard-live.ps1 -UseAuthorizedInventory -AllowPublicEthereumFallback
```

`-UseAuthorizedInventory` and `-AllowPublicEthereumFallback` are both explicit switches. The fallback switch forwards only a boolean CLI flag; no endpoint text is placed on child arguments.

The default cadence is one hour. `-IntervalSeconds` accepts `300` through `86400`; dashboard freshness is aging after the greater of two hours or twice the recorded interval, and stale after the greater of six hours or six times that interval. Running `python -m dashboard` by itself starts the web application, including its wallet controls, without scheduling Venus observations.

The frontend reloads the page every 60 seconds while the tab is visible and automatic refresh is enabled. Reloads defer while a wallet form is being edited or wallet actions/collection are in flight; completion refreshes use the same guard. Stable-ID disclosure sections retain their open/closed state. Each reload re-reads local artifacts; scheduled Venus collection is controlled by the producer launcher.

Fraxlend bad-data evidence is `WATCH` by default. It becomes `TRIGGERED` only when the same successful observation reports at least $10,000 `availableUsd`; this is the dashboard's explicit conservative materiality threshold.

## Dashboard tests

Run from the workspace root. `requirements-dashboard-dev.txt` includes the runtime requirements and pins pytest. The producer-contract regression tests also require Node.js and the tools package dependencies; their RPCs and output paths are injected for offline testing. Disable plugin autoload to match the repository's dashboard test script and avoid unrelated installed plugins:

```powershell
python -m pip install -r requirements-dashboard-dev.txt
npm --prefix tools ci
$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD = "1"
python -m pytest tests/dashboard -q
```

For a focused file, use `python -m pytest tests/dashboard/test_dashboard.py -q` with the same environment setting. On Windows, `npm run test:dashboard` sets the same environment variable and runs the suite; its script uses cmd syntax rather than PowerShell syntax.

The browser refresh/overlapping-wallet-action regressions use Node builtins and fake DOM/timers;
they are separate from the Python suite and root `npm test`:

```powershell
node --test tests/ui/dashboard-refresh.test.cjs
```

The sequential canary refresher's offline lifecycle checks are separate:

```powershell
node --test tools/test/refresh-canary-feeds.test.js tools/test/canary-output-owner.test.js
```
