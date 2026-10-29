#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");

const root = path.resolve(__dirname, "..");
const cwd = path.join(root, "targets", "alchemix");
const args = [
  "test",
  "--offline",
  "--match-path",
  "src/test/TransmuterV2ClaimConservation.t.sol",
  "--fuzz-seed",
  "0x414c4348454d4958",
  "--fuzz-runs",
  "256",
  "--json",
];
const env = {
  ...process.env,
  FOUNDRY_INVARIANT_RUNS: "64",
  FOUNDRY_INVARIANT_DEPTH: "128",
  FOUNDRY_FUZZ_FAILURE_PERSIST_DIR: "cache/audit-alchemix-step1-r2-failures",
};

const run = spawnSync("forge", args, {
  cwd,
  env,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
  windowsHide: true,
});

const stdout = run.stdout || "";
const stderr = run.stderr || "";
let parsed = null;
let parseError = null;
try {
  parsed = JSON.parse(stdout);
} catch (error) {
  parseError = String(error && error.message ? error.message : error);
}

const tests = [];
if (parsed) {
  for (const [suite, suiteResult] of Object.entries(parsed)) {
    for (const [name, result] of Object.entries(suiteResult.test_results || {})) {
      const row = { suite, name, status: result.status };
      if (result.reason !== null && result.reason !== undefined) row.reason = result.reason;
      const kind = result.kind || {};
      if (kind.Unit) row.unit = { gas: kind.Unit.gas };
      if (kind.Fuzz) {
        row.fuzz = {
          runs: kind.Fuzz.runs,
          meanGas: kind.Fuzz.mean_gas,
          medianGas: kind.Fuzz.median_gas,
          failedCorpusReplays: kind.Fuzz.failed_corpus_replays,
        };
      }
      if (kind.Invariant) {
        row.invariant = {
          runs: kind.Invariant.runs,
          calls: kind.Invariant.calls,
          reverts: kind.Invariant.reverts,
          discards: kind.Invariant.discards ?? 0,
        };
      }
      tests.push(row);
    }
  }
}

tests.sort((a, b) => (a.suite + "\0" + a.name).localeCompare(b.suite + "\0" + b.name));
const fixed = tests.filter((row) => row.unit).length;
const fuzz = tests.filter((row) => row.fuzz);
const invariants = tests.filter((row) => row.invariant);
const transcript = {
  schemaVersion: 2,
  generatedBy: "tools/run-alchemix-transmuter-step1-offline.js",
  executable: "forge",
  arguments: args,
  cwd: "targets/alchemix",
  environment: {
    FOUNDRY_INVARIANT_RUNS: env.FOUNDRY_INVARIANT_RUNS,
    FOUNDRY_INVARIANT_DEPTH: env.FOUNDRY_INVARIANT_DEPTH,
    FOUNDRY_FUZZ_FAILURE_PERSIST_DIR: env.FOUNDRY_FUZZ_FAILURE_PERSIST_DIR,
  },
  exitCode: run.status,
  signal: run.signal,
  spawnError: run.error ? String(run.error.message || run.error) : null,
  forgeJsonParsed: parsed !== null,
  parseError,
  rawStdoutBytes: Buffer.byteLength(stdout),
  rawStdoutSha256: crypto.createHash("sha256").update(stdout).digest("hex"),
  rawStderrBytes: Buffer.byteLength(stderr),
  rawStderrSha256: crypto.createHash("sha256").update(stderr).digest("hex"),
  counts: {
    totalFunctions: tests.length,
    fixed,
    fuzz: fuzz.length,
    invariants: invariants.length,
    passed: tests.filter((row) => row.status === "Success").length,
    failed: tests.filter((row) => row.status !== "Success").length,
    fuzzRuns: fuzz.reduce((sum, row) => sum + row.fuzz.runs, 0),
    invariantCalls: invariants.reduce((sum, row) => sum + row.invariant.calls, 0),
    invariantReverts: invariants.reduce((sum, row) => sum + row.invariant.reverts, 0),
    invariantDiscards: invariants.reduce((sum, row) => sum + row.invariant.discards, 0),
  },
  tests,
};

process.stdout.write(JSON.stringify(transcript, null, 2) + "\n");
if (run.status !== 0 || !parsed || transcript.counts.failed !== 0) process.exit(run.status || 1);
