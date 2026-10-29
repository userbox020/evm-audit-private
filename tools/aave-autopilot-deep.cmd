@echo off
setlocal
cd /d "%~dp0.."
node "tools\aave-autopilot.js" --until-trigger --interval-ms 10000 --cycle-sleep-ms 10000 --shadow-max-rows 2 --shadow-pair-limit 2 --shadow-size-fractions 0.05,0.1,0.2,0.25,0.3,0.5 %*
