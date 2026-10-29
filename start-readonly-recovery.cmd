@echo off
setlocal DisableDelayedExpansion
set "NODE_OPTIONS="
set "NODE_PATH="
rem Fixed one-click action; arguments are deliberately never expanded or forwarded.
rem For inspection only, use tools\run-readonly-recovery.ps1 -Check.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0tools\run-readonly-recovery.ps1" -Apply
set "RECOVERY_EXIT=%ERRORLEVEL%"
echo.
echo Process presence is not readiness. Live execution remains excluded and held.
echo Review the summary above; existing tasks, holds and locks were not changed.
pause
exit /b %RECOVERY_EXIT%
