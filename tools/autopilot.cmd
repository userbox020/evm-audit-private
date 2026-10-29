@echo off
REM autopilot.cmd - Unified Aave V4 + V3 read-only monitoring pipeline.
REM Runs V4 watcher (shadow quotes, Socket enrichment, gate refresh) + V3 hot borrower check every cycle.
REM V3 auto-triggers fork test if HF < 1. Never uses private keys.
echo ==========================================
echo   Aave Autopilot - V4 + V3 Unified Monitor
echo ==========================================
echo   V4: Near-liquidation watcher + shadow quotes + Socket branch
echo   V3: Hot borrower HF check (0x1a557...b158, WETH/weETH)
echo   Auto-fork: armed on V3 HF ^< 1.0
echo ==========================================
echo.
node tools\aave-autopilot.js %*
