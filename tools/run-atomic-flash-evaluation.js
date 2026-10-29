#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const economics = require("./atomic-flash-economics");

const ROOT = path.resolve(__dirname, "..");
const INPUT_SCHEMA = "atomic-flash-evaluation-input/v1";
const OUTPUT_SCHEMA = "atomic-flash-evaluation-run/v1";
const DEFAULT_OUTPUT = path.join(ROOT, "reports", "monitor", "atomic-flash-evaluation.json");
const LIMITS = Object.freeze({ candidates: 128, inputBytes: 8 * 1024 * 1024, outputBytes: 4 * 1024 * 1024 });
const USAGE = [
  "usage: node tools/run-atomic-flash-evaluation.js --input <path.json> [--output <path.json>] --run-once",
  "  --run-once is mandatory; without it no input, network, or output is touched.",
  "  input schema: atomic-flash-evaluation-input/v1 with candidates: [{candidate, context}].",
  "  this evaluator performs no signing, transaction, broadcast, or fork execution.",
].join("\n");

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseCli(argv) {
  if (!Array.isArray(argv)) throw failure("CLI_ARGUMENT_INVALID");
  const options = { input: null, output: DEFAULT_OUTPUT, runOnce: false, networkReadsAllowed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--run-once") {
      if (options.runOnce) throw failure("CLI_ARGUMENT_INVALID");
      options.runOnce = true;
      options.networkReadsAllowed = true;
      continue;
    }
    if (name !== "--input" && name !== "--output") throw failure("CLI_ARGUMENT_INVALID");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw failure("CLI_ARGUMENT_INVALID");
    }
    options[name.slice(2)] = path.resolve(value);
    index += 1;
  }
  return options;
}

function readInput(file) {
  let stat;
  try { stat = fs.statSync(file); } catch (_) { throw failure("INPUT_READ_FAILED"); }
  if (!stat.isFile() || stat.size <= 0 || stat.size > LIMITS.inputBytes) throw failure("INPUT_FILE_INVALID");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { throw failure("INPUT_JSON_INVALID"); }
}

function normalizeEntries(input) {
  if (!input || input.schema !== INPUT_SCHEMA || !Array.isArray(input.candidates)) throw failure("INPUT_SCHEMA_INVALID");
  if (input.candidates.length === 0 || input.candidates.length > LIMITS.candidates) throw failure("CANDIDATE_COUNT_INVALID");
  return input.candidates.map((entry) => ({ candidate: entry?.candidate, context: entry?.context }));
}

function atomicPublish(file, artifact, maxBytes = LIMITS.outputBytes) {
  economics.assertSanitized(artifact);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  if (bytes.length > maxBytes) throw failure("OUTPUT_SIZE_EXCEEDED");
  const parent = path.dirname(file);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw failure("OUTPUT_DIRECTORY_INVALID");
  const temporary = `${file}.tmp-${process.pid}-${process.hrtime.bigint().toString(16)}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, file);
  } catch (_) {
    throw failure("OUTPUT_PUBLISH_FAILED");
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch (_) { /* best effort */ }
  }
  return bytes.length;
}

function buildArtifact(entries, options = {}) {
  const results = entries.map(({ candidate, context }) => economics.evaluateFailClosed(candidate, context));
  const failedClosed = results.filter((row) => row.status === "FAIL_CLOSED").length;
  const forkProvenPositive = results.filter((row) => row.status === "FORK_PROVEN_POSITIVE").length;
  const artifact = {
    schema: OUTPUT_SCHEMA,
    generatedAt: new Date(options.now === undefined ? Date.now() : options.now).toISOString(),
    mode: options.runOnce ? "RUN_ONCE_SUPPLIED_CONTEXT" : "OFFLINE_LIBRARY",
    candidatesEvaluated: results.length,
    results,
    stats: {
      arithmeticOnlyForkRequired: results.length - failedClosed - forkProvenPositive,
      forkProvenPositive,
      failedClosed,
      failureReasons: results.reduce((counts, row) => {
        if (row.status === "FAIL_CLOSED") counts[row.reason] = (counts[row.reason] || 0) + 1;
        return counts;
      }, {}),
      networkRequests: 0,
    },
    safety: {
      boundedCandidates: LIMITS.candidates,
      perCandidateFailClosed: true,
      atomicPublish: true,
      suppliedPriceGasContextOnly: true,
      networkReadsAllowedOnlyWithRunOnce: true,
      networkReadsPerformed: false,
      endpointMaterialPersisted: false,
      signing: false,
      transactions: false,
      broadcasting: false,
      forkExecuted: false,
      arithmeticProfitClaimed: false,
    },
  };
  economics.assertSanitized(artifact);
  return artifact;
}

function run(options = {}) {
  if (options.runOnce !== true) throw failure("RUN_ONCE_REQUIRED");
  if (!options.input) throw failure("INPUT_REQUIRED");
  const entries = normalizeEntries(options.inputData || readInput(options.input));
  const artifact = buildArtifact(entries, options);
  if (options.write !== false) atomicPublish(options.output || DEFAULT_OUTPUT, artifact);
  return artifact;
}

function safeCode(error) {
  const code = error?.code || error?.message;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : "ATOMIC_EVALUATION_FAILED";
}

function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseCli(argv); } catch (error) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return { status: "FAIL_CLOSED", reason: safeCode(error) };
  }
  if (!options.runOnce) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return { status: "REFUSED", reason: "RUN_ONCE_REQUIRED" };
  }
  try {
    const artifact = run(options);
    const summary = {
      schema: artifact.schema,
      candidatesEvaluated: artifact.candidatesEvaluated,
      arithmeticOnlyForkRequired: artifact.stats.arithmeticOnlyForkRequired,
      forkProvenPositive: artifact.stats.forkProvenPositive,
      failedClosed: artifact.stats.failedClosed,
      networkRequests: artifact.stats.networkRequests,
    };
    economics.assertSanitized(summary);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return { status: "PASS", artifact };
  } catch (error) {
    process.stderr.write(`atomic-flash-evaluation failed: ${safeCode(error)}\n`);
    process.exitCode = 1;
    return { status: "FAIL_CLOSED", reason: safeCode(error) };
  }
}

if (require.main === module) main();

module.exports = Object.freeze({
  ROOT,
  INPUT_SCHEMA,
  OUTPUT_SCHEMA,
  DEFAULT_OUTPUT,
  LIMITS,
  USAGE,
  atomicPublish,
  buildArtifact,
  main,
  normalizeEntries,
  parseCli,
  readInput,
  run,
  safeCode,
});
