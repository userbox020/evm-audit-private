@echo off
REM aave-autopilot-v3.cmd - Start Aave V3 HF monitor with auto-fork trigger.
REM Monitors borrower 0x1a557... (WETH/weETH) every 5 minutes.
REM If HF drops below 1.0, auto-runs fork test.
echo ==========================================
echo   Aave V3 Autopilot - Read-Only Monitor
echo   Borrower: 0x1a557...b158 (WETH/weETH)
echo   Auto-fork: ENABLED
echo   Interval: 5 minutes
echo ==========================================
echo.
echo Starting autopilot. Press Ctrl+C to stop.
echo Status file: reports\monitor\aave-v3-autopilot-status.json
echo Alert file:  reports\monitor\aave-v3-trigger-alert.json
echo.

node tools\aave-v3-autopilot.js --auto-fork --interval=300000
