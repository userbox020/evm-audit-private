@echo off
setlocal
cd /d "%~dp0.."
node "tools\aave-trigger-watch.js" --until-trigger --batch-iterations 2 --interval-ms 10000 --dashboard %*
