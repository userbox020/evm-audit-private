#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "lorenzo-susd1plus");
const OUTPUT = path.join(ROOT, "reports", "raw", "fast", "critical-lorenzo-susd1plus-stale-nav-step1.forge-test.json");
const BUILD_ARTIFACT = path.join(TARGET, "out", "ProductionLinkedSUSD1Plus.sol", "ProductionLinkedSUSD1Plus.json");
const SEED = "0x4c6f72656e7a6f2d73555344312b53746570312d3230323630373237";
const ARGS = ["test", "--offline", "--json", "--fuzz-seed", SEED, "--fuzz-runs", "256"];

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function run(executable, args) {
  return spawnSync(executable, args, {
    cwd: TARGET,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
}

const versionRun = run("forge", ["--version"]);
if (versionRun.status !== 0) throw new Error("forge --version failed");
if (!fs.existsSync(BUILD_ARTIFACT)) throw new Error("missing forced-build artifact");
const buildArtifact = JSON.parse(fs.readFileSync(BUILD_ARTIFACT, "utf8"));
const metadata = buildArtifact.metadata;
if (!metadata?.compiler?.version || !metadata?.settings) throw new Error("build metadata unavailable");

const testRun = run("forge", ARGS);
if (testRun.status !== 0) {
  throw new Error(`forge test failed: exit=${testRun.status}; stderrSha256=${sha(testRun.stderr || "")}`);
}

let result;
try {
  result = JSON.parse(testRun.stdout);
} catch (_) {
  throw new Error(`forge JSON parse failed; stdoutSha256=${sha(testRun.stdout || "")}`);
}

const suites = Object.values(result);
const tests = suites.flatMap((suite) => Object.values(suite.test_results || {}));
const failed = tests.filter((test) => test.status !== "Success");
const fuzzRuns = tests.reduce((sum, test) => sum + Number(test.kind?.Fuzz?.runs || 0), 0);
if (tests.length === 0 || failed.length !== 0) {
  throw new Error(`unexpected Forge result: tests=${tests.length}; failures=${failed.length}`);
}

const artifact = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  tool: versionRun.stdout.trim(),
  workingDirectory: "targets/lorenzo-susd1plus",
  command: ["forge", ...ARGS],
  compilerSettings: {
    solc: metadata.compiler.version,
    optimizer: metadata.settings.optimizer,
    evmVersion: metadata.settings.evmVersion,
    bytecodeHash: metadata.settings.metadata?.bytecodeHash || null,
  },
  seed: SEED,
  configuredFuzzRunsPerFunction: 256,
  exitCode: testRun.status,
  stderrBytes: Buffer.byteLength(testRun.stderr || ""),
  stderrSha256: sha(testRun.stderr || ""),
  derivedSummary: {
    suites: suites.length,
    testFunctions: tests.length,
    succeeded: tests.length - failed.length,
    failed: failed.length,
    fuzzFunctions: tests.filter((test) => test.kind?.Fuzz).length,
    fuzzRuns,
  },
  forgeResult: result,
};

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ output: path.relative(ROOT, OUTPUT).replaceAll("\\", "/"), ...artifact.derivedSummary }));
