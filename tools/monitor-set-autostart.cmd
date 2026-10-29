@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0.."

rem Fail closed before any monitor or manifest process starts. The helper emits
rem variable names only; values are never printed or persisted.
set "NODE_OPTIONS="
set "NODE_PATH="
for /f "usebackq delims=" %%V in (`node tools\monitor-minimal-env.js --names-to-clear`) do set "%%V="
node tools\monitor-minimal-env.js --assert-current >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Could not establish the minimal monitor environment.
    exit /b 1
)

echo ============================================
echo   EVM AUDIT - Read-Only Monitor Launcher
echo   Updated: 2026-08-25
echo ============================================
echo   Safety: no keys, signing, or broadcast.
echo   Scope: observation and artifact reporting only.
echo.

for /f "delims=" %%N in ('node tools\monitor-service-manifest.js --count persistent') do set "PERSISTENT_TOTAL=%%N"
for /f "delims=" %%N in ('node tools\monitor-service-manifest.js --count scheduled') do set "SCHEDULED_TOTAL=%%N"
if not defined PERSISTENT_TOTAL (
    echo [ERROR] Could not read persistent service total from the monitor manifest.
    exit /b 1
)
if not defined SCHEDULED_TOTAL (
    echo [ERROR] Could not read scheduled service total from the monitor manifest.
    exit /b 1
)
set /a "STAGE_TOTAL=PERSISTENT_TOTAL+SCHEDULED_TOTAL"

rem Atomically reserve the single supervisor owner and reject forbidden legacy,
rem action-capable, or already-running persistent manifest services before the
rem first background service is started. This prevents duplicate monitor sets.
node tools\autopilot-status.js --reserve-launch >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Monitor launch preflight failed closed.
    exit /b 1
)

if not exist "reports\monitor" mkdir "reports\monitor"
if exist "reports\monitor\morpho-liquidatable-startup.json" del /q "reports\monitor\morpho-liquidatable-startup.json"
if exist "reports\monitor\research-watch-startup.done" del /q "reports\monitor\research-watch-startup.done"

set "PERSISTENT_TOTAL="
set "SCHEDULED_TOTAL="
set "STAGE_TOTAL="

echo [1/13] Launching novelty monitor; readiness pending artifact health...
node tools\monitor-hidden-dispatch.js novelty-monitor

echo [2/13] Launching Morpho WebSocket monitor; readiness pending artifact health...
node tools\monitor-hidden-dispatch.js morpho-ws

echo [3/13] Launching Chainlink WebSocket monitor; readiness pending artifact health...
node tools\monitor-hidden-dispatch.js chainlink-ws

echo [4/13] Launching direct Aave V4 owner watch; readiness pending artifact health...
node tools\monitor-hidden-dispatch.js aave-v4-owner-watch

echo [5/13] Launching direct Aave V3 liquidation watch; readiness pending artifact health...
node tools\monitor-hidden-dispatch.js aave-v3-liquidation-watch

echo [6/13] Launching global gate monitor; readiness pending artifact health...
node tools\monitor-hidden-dispatch.js global-gates

echo [7/13] Launching E1 proximity monitor; readiness pending artifact health...
node tools\monitor-hidden-dispatch.js e1-proximity

echo [8/13] Launching Venus PSR multichain monitor; readiness pending artifact health...
node tools\monitor-hidden-dispatch.js venus-psr-multichain

echo [9/13] Launching monitor health service; readiness pending its first health cycle...
node tools\monitor-hidden-dispatch.js autopilot-status

echo [10/13] Launching Morpho frozen-oracle monitor; readiness pending artifact health...
node tools\monitor-hidden-dispatch.js morpho-frozen-oracle

echo [11/13] Scheduling Morpho one-shot scanner; completion pending artifact health...
node tools\monitor-hidden-dispatch.js morpho-startup-scan

echo [12/13] Scheduling disabled-routes report; completion pending artifact health...
node tools\monitor-hidden-dispatch.js disabled-routes-report

if exist "tools\build-monitor-research-watch.js" (
    echo [13/13] Scheduling optional research watch build; completion pending artifact health...
    node tools\monitor-hidden-dispatch.js research-watch-build
) else (
    echo [13/13] Optional research watch build is not installed; scheduled slot recorded as optional.
)

for /f "delims=" %%N in ('node tools\monitor-service-manifest.js --count persistent') do set "PERSISTENT_TOTAL=%%N"
for /f "delims=" %%N in ('node tools\monitor-service-manifest.js --count scheduled') do set "SCHEDULED_TOTAL=%%N"

echo.
echo ============================================
echo   READ-ONLY SERVICES LAUNCHED
echo   %PERSISTENT_TOTAL% persistent + %SCHEDULED_TOTAL% scheduled
echo   Readiness is observational and may remain pending during first cycles.
echo   Health: reports\monitor\autopilot-health.json
echo ============================================
echo.
echo Close this window to finish the launcher. Services continue in the background.
