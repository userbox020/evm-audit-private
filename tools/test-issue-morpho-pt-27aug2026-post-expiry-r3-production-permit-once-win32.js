#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const child = require("node:child_process");
const test = require("node:test");

test("R3 Windows permit conductor passes isolated synthetic offline qualification", () => {
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const script = path.join(__dirname, "test-issue-morpho-pt-27aug2026-post-expiry-r3-production-permit-once-win32.ps1");
  const result = child.spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: 60000,
    env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", R3_TEST_NODE: process.execPath },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^R3_PERMIT_CONDUCTOR_OFFLINE_SUMMARY assertions=46 tests=17 productionIssuerExecutions=0 wsl=0 network=0 capture=0 outputMutations=0\r?\n$/u);
  assert.equal(result.stderr, "");
});
