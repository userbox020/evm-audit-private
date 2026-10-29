#!/usr/bin/env node
"use strict";

// Refresh runner for the Ethereum Aave V4 L/O trigger-coverage binders.
//
// Schedule this on the trigger-watch scheduler's 900 s cycle (see
// run-critical-trigger-watch-scheduler.js). The Aave V4 topology scan and borrower
// monitor refresh on an observed ~19m15s cadence from their own service; this runner
// rebuilds the `trigger-coverage-evidence/v1` binders from the artifacts already on
// disk at least once per observation cycle, so the covered O row cannot expire inside
// its 1800 s freshness window.
//
// The runner never stamps a wall-clock observation time: the binders inherit the source
// artifact `generatedAt` verbatim (see build-trigger-coverage-aave-v4-binders.js). It
// fails closed if the topology/monitor artifacts are absent, shape-invalid, or not
// sample-complete; it never forces coverage and never fabricates an observation.

const path = require("node:path");
const builder = require("./build-trigger-coverage-aave-v4-binders.js");

function refresh(options = {}) {
  const workspace = path.resolve(options.workspace || builder.WORKSPACE);
  const buildBinders = options.buildBinders || builder.buildBinders;
  const result = buildBinders({ workspace, apply: options.apply !== false });
  return Object.freeze({
    observedAt: result.assessments.topology.observedAt,
    covered: result.covered,
    blocked: result.blocked,
    written: result.written,
  });
}

function parseOptions(argv) {
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length) throw new Error("usage: refresh-trigger-coverage-aave-v4-binders.js [--check]");
  return { apply: !argv.includes("--check") };
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseOptions(argv);
    const result = refresh({ apply: options.apply });
    process.stdout.write(`aave-v4-binders refresh: observedAt=${result.observedAt} covered=${result.covered} blocked=${result.blocked} written=${result.written.length}\n`);
  } catch (error) {
    process.stderr.write(`aave-v4-binders refresh failed closed: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { refresh, parseOptions };
