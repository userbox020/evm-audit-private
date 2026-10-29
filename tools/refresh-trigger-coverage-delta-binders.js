#!/usr/bin/env node
"use strict";

// Refresh runner for the trigger-coverage D (deployed runtime/config delta) binders.
//
// Schedule this alongside the official deployed-delta sentinel at the sentinel cadence
// (21600 s, run-critical-trigger-watch-scheduler). It runs the sentinel (`--once` semantics),
// then rebuilds the per-row binders from the freshly observed sentinel artifact.
//
// The runner never stamps a wall-clock observation time: the binders inherit the sentinel's
// own `generatedAt`. Running with `--skip-sentinel` only rebuilds binders from the artifact
// already on disk.

const path = require("node:path");
const sentinelModule = require("./run-official-deployed-delta-sentinel.js");
const builder = require("./build-trigger-coverage-delta-binders.js");

async function refresh(options = {}) {
  const workspace = path.resolve(options.workspace || builder.WORKSPACE);
  const runSentinel = options.runSentinel || sentinelModule.runSentinel;
  const buildBinders = options.buildBinders || builder.buildBinders;
  let sentinelStatus = "skipped";
  if (options.sentinel !== false) {
    const artifact = await runSentinel({ workspace });
    sentinelStatus = artifact && typeof artifact.status === "string" ? artifact.status : "unknown";
  }
  const result = buildBinders({ workspace, apply: true });
  return Object.freeze({
    sentinelStatus,
    observedAt: result.assessment.observedAt,
    covered: result.covered,
    blocked: result.blocked,
    written: result.written,
  });
}

function parseOptions(argv) {
  const unknown = argv.filter((arg) => arg !== "--skip-sentinel");
  if (unknown.length) throw new Error("usage: refresh-trigger-coverage-delta-binders.js [--skip-sentinel]");
  return { sentinel: !argv.includes("--skip-sentinel") };
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseOptions(argv);
    const result = await refresh(options);
    process.stdout.write(`delta-binders refresh: sentinel=${result.sentinelStatus} observedAt=${result.observedAt} covered=${result.covered} blocked=${result.blocked} written=${result.written.length}\n`);
  } catch (error) {
    process.stderr.write(`delta-binders refresh failed closed: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = { refresh, parseOptions };
