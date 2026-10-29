"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const SUITES = Object.freeze([
  "test:explorer-source-fetch",
  "test:monitor", "test:stage1", "test:stage2a", "test:stage2b-apxusd", "test:stage2c-v4-claims",
  "test:gate0-v4-native-claim", "test:gate0-offline-adjudicator", "test:gate0-residual-receipts",
  "test:lido-nest-stage-a1", "test:lido-nest-stage-a2", "test:lido-nest-stage-a3", "test:lido-nest-stage-a4", "test:public-mev-stage0", "test:public-mev-stage1-deep-source", "test:public-mev-stage2-identity",
]);

function runAll(suites = SUITES, spawn = spawnSync) {
  const npmCli = process.env.npm_execpath;
  const results = [];
  for (const suite of suites) {
    const child = typeof npmCli === "string" && npmCli.length > 0 ? spawn(process.execPath, [npmCli, "run", suite], { cwd: path.resolve(__dirname, ".."), stdio: "inherit", shell: false }) : { status: 1, error: { code: "NPM_CLI_UNAVAILABLE" } };
    const status = Number.isInteger(child.status) ? child.status : 1;
    results.push({ suite, status, error: child.error ? child.error.code || "SPAWN_ERROR" : null });
  }
  return { ok: results.every((row) => row.status === 0), results };
}

if (require.main === module) {
  const result = runAll();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

module.exports = { SUITES, runAll };
