@echo off
setlocal
node "%~dp0notional-v3-missed-quarter-stage-a-r2-runner.js" %*
exit /b %ERRORLEVEL%
