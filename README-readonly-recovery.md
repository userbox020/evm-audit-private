# Read-only recovery

Double-click **start-readonly-recovery.cmd** to restore the previously active
read-only services. The window shows a summary and waits for a key before closing.
It does not restore trading or live execution.

## Manual use

```powershell
# Inspect only: no status writes, launches or task changes.
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\run-readonly-recovery.ps1 -Check

# Recover the fixed set of services.
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\run-readonly-recovery.ps1 -Apply
```

The CMD shortcut always applies; it does not accept or forward arguments. For a
check, use the PowerShell command above. Node's entrypoint defaults to
`--check`; use the PowerShell/CMD entrypoint for recovery so concurrent manual and
login invocations share the recovery-only mutex. Paths are fixed to this checkout,
not the caller's working directory. Exit code 1 means recovery is incomplete,
held, deferred or refused; it does not mean a service was stopped.

## Recovery at Windows login

Run these as the current Windows user, without elevation:

```powershell
# Preview registration; makes no changes.
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\manage-readonly-recovery-task.ps1

# Register only EVMAuditReadOnlyRecovery.
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\manage-readonly-recovery-task.ps1 -Apply
```

The new task runs one minute after that user's login (`PT1M` delay), hidden and synchronously, with a limited
interactive principal, IgnoreNew, StartWhenAvailable and a five-minute timeout.
It does not start immediately, wake the machine, ask for a password, or modify any
existing task. A matching task is left unchanged; a disabled, mismatched or raced
registration is refused without replacement or deletion. If legacy monitor
startup/watchdog is running or queued, Apply waits and reinspects every five seconds
within its existing 220-second runtime budget, without launching services or consuming
launch passes while busy. Once quiet, bounded recovery continues. Check reports the
deferral immediately, without waiting or writing. If the deadline expires, recovery
exits nonzero with `TIME_LIMIT`; use manual recovery after startup finishes.
There is no new periodic retry task or supervisor.

## Exactly what is recovered

- The loopback dashboard through `tools/run-dashboard-task.py`, using an existing
  trusted Python installation. No additional Venus launcher is used.
- The ten pinned persistent read-only manifest monitors: novelty, Morpho WS,
  Chainlink WS, Aave V4 owner watch, Aave V3 liquidation watch, global gates, E1
  proximity, Venus PSR, autopilot **status observer**, and Morpho frozen oracle.
- Only `tools/watch-top-whale-triggers.js --watch 20` for the whale sentinel.
  Its catalog alias also includes an executor; recovery does not treat that alias
  as sentinel identity or execution authority.

There are at most three launches per pass and four launch passes, with process
reinspection and a final observation. This can restore the fixed twelve services
after reboot; it never invokes broad monitor autostart or expands the scope.
Prior watchdog/recovery attempts and cooldowns are retained until an exact process
is observed running, matching the watchdog's successful-recovery reset. Unknown inspection,
duplicates, launch failure or lack of observed progress stop recovery. Disabled
linked tasks remain holds. Existing dashboard/Venus tasks in flight own their
startup; recovery does not race them with a fallback launch.

An occupied port 5050 is left alone, even if its occupant is not the dashboard.
Only exact runner processes are counted as dashboard process presence. No process
is stopped or taken over. The mutex serializes **this recovery tool only**, not
legacy launchers or unrelated manual commands; don't run those concurrently.

## Results and boundaries

Apply writes only its own control status:
`reports/monitor/readonly-recovery/status.json`. Existing producers continue to
write their normal artifacts after launch. Check does not write recovery or
watchdog status. Neither mode changes task registration.

The summary distinguishes process presence from health. It uses only loopback
`GET /healthz` and bounded fields from the existing `autopilot-health.json`;
it never requests `/canary`. The status records health freshness and observed
ready counts separately. A responding HTTP server or twelve processes is **not**
an all-green readiness claim. Existing data, provenance and coverage failures
remain visible and are not repaired by restarting services.

Canary scheduler metadata may be reported; READY scheduled collectors are normal.
Recovery never kicks, installs or enables those collectors, archives/deletes/clears
locks, or extends expired observation windows. Any orphan-lock or expired-window
issue needs a separate attended decision.

Live execution is always **EXCLUDED / HELD**. The documented current 2K/2L hold is
`BATCH_TARGET_NOT_APPROVED`; recovery reports that scope restriction without
revalidating protected approvals, journals or keys. No executor, live/fork/profit
autopilot, research producer, external bot, or extra scheduled producer is launched.
Recovery itself reads no endpoint inventories, wallets or protected execution
material. Existing read-only monitors retain their existing data-access behavior.

## Offline checks

```powershell
node --test tools/test/readonly-recovery.test.js
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-readonly-recovery.ps1
```

These use mocked inspection, launching, health, status I/O and Task Scheduler.
They do not run recovery, contact the network or install/start real tasks.
