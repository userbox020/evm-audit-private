#!/usr/bin/env node
"use strict";

// run-trigger-fork-poc.js — bridge from the read-only profit-trigger monitor to
// the keyless local fork-PoC harness.
//
// Purpose: when reports/monitor/profit-trigger-watch.json reports a fired
// trigger (a transition precondition that is now true), map that producer to a
// re-verification scenario under tools/fork-poc/triggers/ and run it against a
// keyless local fork.
//
// Usage:
//   node tools/run-trigger-fork-poc.js [--artifact <path>] [--run]
//
// Without --run this program only computes and prints the plan; it contacts
// nothing. --run is mandatory to actually fork. Forking is delegated to
// tools/run-fork-poc.js, which inherits the read-only localhost relay,
// impersonation-only execution, and endpoint hygiene (the endpoint never
// appears on any child-process command line and is never printed or persisted).
//
// Bounds: sequential execution, at most MAX_FIRED_TRIGGERS fired triggers per
// run, an overall wall clock cap, and per-trigger fail-closed isolation so one
// failing scenario cannot abort the rest. Every fork is terminated by the
// delegated harness.

const fs = require("node:fs");
const path = require("node:path");
const epochExecution = require("./lib/trigger-fork-epoch-execution.js");

const forkPoc = require("./run-fork-poc");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "reports", "raw", "fast", "fork-poc");
const TRIGGERS_DIR = path.join(__dirname, "fork-poc", "triggers");
const DEFAULT_ARTIFACT = path.join(ROOT, "reports", "monitor", "profit-trigger-watch.json");

const SCHEMA = "trigger-fork-bridge/v1";
const SOURCE_SCHEMA = "profit-trigger-watch/v1";

// Fired statuses are the terminal transitions that make onboarding / harvesting
// reachable. Everything else is a blocked, closed, unchanged, failed, or timed
// out producer and must never trigger a fork.
const FIRED_STATUSES = Object.freeze(["TRIGGER_UNPAUSE", "WINDOW_OPEN", "STRATEGY_SET_CHANGED", "ATOMIC_FORK_REQUIRED"]);
const NOT_FIRED_STATUSES = Object.freeze(["BLOCKED_PAUSED", "WINDOW_CLOSED", "NO_CHANGE", "NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "FAILED", "TIMEOUT"]);
const FIRED_SET = new Set(FIRED_STATUSES);
const NOT_FIRED_SET = new Set(NOT_FIRED_STATUSES);

// Producers whose fork chain is fixed by the producer contract. kelp-composite
// is intentionally absent: its scenario decides (Base 8453 needs chain-1
// companion reads), so it prefers the scenario's declared chainId and only then
// falls back to the first evidence chainId.
const FIXED_CHAIN = Object.freeze({
  "ostium-settlement-window": 42161,
  "clever-harvest": 1,
  "frax-usdc-cross-venue": 1,
  "base-usdc-usdt-cross-venue": 8453,
  "balancer-v2-eth-cross-venue": 1,
  "balancer-v2-base-cross-venue": 8453,
  "balancer-v2-eth-join-exit": 1,
  "curve-eth-join-exit": 1,
  "curve-base-join-exit": 8453,
  "morpho-blue-eth-l": 1,
  "morpho-blue-base-l": 8453,
  "aave-v3-eth-reserve-watch": 1,
  "aave-v3-base-reserve-watch": 8453,
  "aave-v3-eth-l": 1,
  "aave-v3-base-l": 8453,
});

const LIMITS = Object.freeze({
  maxFiredTriggers: 5,
  totalMs: 900_000,
});

const USAGE = [
  "usage: node tools/run-trigger-fork-poc.js [--artifact <path>] [--run]",
  "  --artifact <path>  monitor artifact (default reports/monitor/profit-trigger-watch.json)",
  "  --run              mandatory to actually fork; without it only the plan is printed.",
  "  keyless local fork, impersonation only, no signing, no broadcast.",
].join("\n");

const PRODUCER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const UINT_STRING = /^(?:0|[1-9][0-9]*)$/u;
const TIMESTAMP_SAFE = /[:.]/gu;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isFired(status) {
  return FIRED_SET.has(String(status));
}

function classifyStatus(status) {
  const value = String(status);
  if (FIRED_SET.has(value)) return "FIRED";
  if (NOT_FIRED_SET.has(value)) return "NOT_FIRED";
  return "UNKNOWN";
}

function relPosix(target) {
  if (!target) return null;
  return path.relative(ROOT, target).split(path.sep).join("/");
}

function safetyBlock() {
  return {
    localOnly: true,
    readOnly: true,
    impersonationOnly: true,
    noSigning: true,
    noBroadcast: true,
    endpointInventoryPrinted: false,
    firedTriggerLimit: LIMITS.maxFiredTriggers,
  };
}

// ---------------------------------------------------------------------------
// CLI (pure; never touches the network)
// ---------------------------------------------------------------------------
function parseArgs(args) {
  if (!Array.isArray(args)) throw fail("USAGE_ERROR");
  const options = { run: false, artifact: null };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--run") {
      if (options.run) throw fail("USAGE_ERROR");
      options.run = true;
      continue;
    }
    if (name !== "--artifact") throw fail("USAGE_ERROR");
    const value = args[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) throw fail("USAGE_ERROR");
    options.artifact = value;
    index += 1;
  }
  return options;
}

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------
function scenarioPathFor(producerId, triggersDir) {
  if (typeof producerId !== "string" || !PRODUCER_ID.test(producerId)) return null;
  return path.join(triggersDir, `${producerId}.js`);
}

function resolveChainId(producerId, evidence, scenarioModule, fixed = FIXED_CHAIN) {
  if (fixed && Object.hasOwn(fixed, producerId)) return fixed[producerId];
  const declared = scenarioModule ? scenarioModule.chainId : null;
  if (Number.isSafeInteger(declared) && declared > 0) return declared;
  const fromEvidence = evidence && typeof evidence === "object" ? evidence.chainId : null;
  if (Number.isSafeInteger(fromEvidence) && fromEvidence > 0) return fromEvidence;
  return null;
}

function resolveBlock(scenarioModule, evidence) {
  const declared = scenarioModule ? scenarioModule.block : null;
  if (declared === "finalized" || (typeof declared === "string" && UINT_STRING.test(declared))) return declared;
  if (evidence && typeof evidence === "object") {
    for (const key of ["blockNumberRaw", "blockNumber", "block"]) {
      const value = evidence[key];
      if (typeof value === "string" && UINT_STRING.test(value)) return value;
    }
  }
  return "finalized";
}

function safeLoadScenario(load, file) {
  try {
    const loaded = load(file);
    return loaded && typeof loaded === "object" ? loaded : null;
  } catch (_) {
    return null;
  }
}

function buildPlan(artifact, options = {}, deps) {
  const scenarioRoot = options.triggersDir || deps.triggersDir || TRIGGERS_DIR;
  const producers = Array.isArray(artifact && artifact.producers) ? artifact.producers : [];
  const rows = [];
  let firedCount = 0;
  let planned = 0;

  for (const producer of producers) {
    const producerId = producer && typeof producer.id === "string" ? producer.id : "";
    const evidence = producer && typeof producer.evidence === "object" && producer.evidence !== null ? producer.evidence : {};
    const classification = classifyStatus(producer ? producer.status : undefined);
    const fired = classification === "FIRED";
    const scenarioPath = fired && PRODUCER_ID.test(producerId) ? scenarioPathFor(producerId, scenarioRoot) : null;
    const present = scenarioPath ? deps.scenarioExists(scenarioPath) === true : false;
    const scenarioModule = present ? safeLoadScenario(deps.loadScenario, scenarioPath) : null;
    const chainId = resolveChainId(producerId, evidence, scenarioModule);
    const block = resolveBlock(scenarioModule, evidence);
    const scenarioRel = present ? relPosix(scenarioPath) : null;

    let status;
    if (classification === "FIRED") {
      firedCount += 1;
      if (!present) status = "NO_SCENARIO_MAPPED";
      else if (planned >= LIMITS.maxFiredTriggers) status = "SKIPPED_CAP";
      else {
        status = "WOULD_FORK";
        planned += 1;
      }
    } else {
      status = classification === "UNKNOWN" ? "NOT_FIRED" : "NOT_FIRED";
    }

    rows.push({
      producerId,
      status,
      fired,
      scenario: scenarioRel,
      chainId,
      block,
      result: null,
      net: null,
      blocker: null,
      forkArtifact: null,
      scenarioInput: evidence,
    });
  }

  return { rows, firedCount };
}

// ---------------------------------------------------------------------------
// aggregation
// ---------------------------------------------------------------------------
function buildOutput({ mode, generatedAt, sourceArtifact, rows, firedCount, executedCount, diagnosticContext = epochExecution.diagnostic() }) {
  return {
    schema: SCHEMA,
    ...epochExecution.metadata(diagnosticContext),
    generatedAt,
    mode,
    sourceArtifact,
    firedCount,
    executedCount,
    triggers: rows.map((row) => ({
      ...epochExecution.metadata(diagnosticContext),
      producerId: row.producerId,
      status: row.status,
      fired: row.fired,
      scenario: row.scenario,
      chainId: row.chainId,
      block: row.block,
      result: row.result,
      net: row.net,
      blocker: row.blocker,
      forkArtifact: row.forkArtifact,
    })),
    safety: safetyBlock(),
  };
}

function extractNet(forkOutput) {
  if (!forkOutput || !Array.isArray(forkOutput.observations)) return null;
  for (let index = forkOutput.observations.length - 1; index >= 0; index -= 1) {
    const entry = forkOutput.observations[index];
    if (entry && entry.label === "net") return Object.hasOwn(entry, "value") ? entry.value : null;
  }
  return null;
}

function sanitizeBlocker(error) {
  if (error && typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code)) return error.code;
  return "TRIGGER_FORK_BRIDGE_FAILED";
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------
async function runBridge(options = {}, depsInput = {}) {
  const held = epochExecution.asyncBlock(options);
  if (held) return held; // JSON/tickets/test booleans cannot arm asynchronous epoch work
  const diagnosticContext = epochExecution.diagnostic(options);
  try { return await runManualBridge(options, depsInput, diagnosticContext); }
  catch (_) { return { status: "FAIL_CLOSED", blocker: "BRIDGE_SETUP_FAILED", ...epochExecution.metadata(diagnosticContext), output: null, outPath: null }; }
}

async function runManualBridge(options, depsInput, diagnosticContext) {
  const refusal = (blocker) => ({ status: "FAIL_CLOSED", blocker, ...epochExecution.metadata(diagnosticContext) });
  const deps = { ...defaultDeps(), ...depsInput };
  const artifactPath = options.artifactPath || DEFAULT_ARTIFACT;
  const sourceArtifact = relPosix(artifactPath);
  const generatedAt = new Date(deps.now()).toISOString();

  let raw;
  try {
    raw = deps.readArtifact(artifactPath);
  } catch (_) {
    return refusal("ARTIFACT_READ_FAILED");
  }
  let artifact;
  try {
    artifact = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
  } catch (_) {
    return refusal("ARTIFACT_PARSE_FAILED");
  }
  if (!artifact || artifact.schema !== SOURCE_SCHEMA || !Array.isArray(artifact.producers)) {
    return refusal("ARTIFACT_INVALID");
  }

  let plan;
  try { plan = buildPlan(artifact, options, deps); }
  catch (_) { return refusal("TRIGGER_FORK_BRIDGE_FAILED"); }
  const rows = plan.rows;

  if (options.run !== true) {
    const output = buildOutput({
      diagnosticContext,
      mode: "PLAN",
      generatedAt,
      sourceArtifact,
      rows,
      firedCount: plan.firedCount,
      executedCount: 0,
    });
    try {
      forkPoc.leakGuard(output);
    } catch (error) {
      return refusal(sanitizeBlocker(error));
    }
    return { status: "PLAN_ONLY", output, outPath: null, ...epochExecution.metadata(diagnosticContext) };
  }

  const scenarioRoot = options.triggersDir || deps.triggersDir || TRIGGERS_DIR;
  const outDir = deps.outDir || OUT_DIR;
  const deadline = deps.now() + (Number.isSafeInteger(options.totalMs) && options.totalMs > 0 ? options.totalMs : LIMITS.totalMs);
  const stamp = generatedAt.replace(TIMESTAMP_SAFE, "-");
  let executedCount = 0;

  for (const row of rows) {
    if (row.status !== "WOULD_FORK") continue;
    if (deps.now() > deadline) {
      row.status = "SKIPPED_WALL_CLOCK";
      row.blocker = "BRIDGE_WALL_CLOCK_EXCEEDED";
      continue;
    }
    const scenarioAbsolute = path.join(scenarioRoot, `${row.producerId}.js`);
    const forkOutPath = path.join(outDir, `trigger-bridge-${stamp}-${row.producerId}.json`);
    try {
      const outcome = await deps.runForkPoc({
        contextText: options.contextText,
        deadlinesText: options.deadlinesText,
        chain: row.chainId === null || row.chainId === undefined ? row.chainId : String(row.chainId),
        block: row.block,
        scenario: scenarioAbsolute,
        scenarioName: row.producerId,
        outPath: forkOutPath,
        scenarioInput: row.scenarioInput,
      });
      row.status = "EXECUTED";
      row.result = outcome && typeof outcome.status === "string" ? outcome.status : null;
      row.blocker = outcome && typeof outcome.blocker === "string" ? outcome.blocker : null;
      row.net = extractNet(outcome && outcome.output);
      row.forkArtifact = relPosix(forkOutPath);
    } catch (error) {
      row.status = "FAILED";
      row.blocker = sanitizeBlocker(error);
    }
    executedCount += 1;
  }

  const output = buildOutput({
    diagnosticContext,
    mode: "RUN",
    generatedAt,
    sourceArtifact,
    rows,
    firedCount: plan.firedCount,
    executedCount,
  });

  try {
    forkPoc.leakGuard(output);
  } catch (error) {
    return refusal(sanitizeBlocker(error));
  }

  const outPath = path.join(outDir, `trigger-bridge-${stamp}.json`);
  try {
    deps.writeArtifact(outPath, output);
  } catch (_) {
    return { ...refusal("ARTIFACT_WRITE_FAILED"), output, outPath };
  }

  return { status: "BRIDGE_COMPLETE", output, outPath, ...epochExecution.metadata(diagnosticContext) };
}

// Explicitly synchronous INERT bridge. No default source reads or async child.
function runEpochBridgeModel(request, deps = {}) {
  const env = epochExecution.envelope(request);
  if (!env.ok) return { status: "FAIL_CLOSED", blocker: env.blocker, ...epochExecution.metadata(env) };
  const gate = epochExecution.guard(env, deps.clock);
  let answer;
  try {
    const snapshot = epochExecution.snapshotRequest(request);
    const sample = gate("work"), blocker = epochExecution.normalized(env, snapshot, sample);
    if (blocker) throw new Error(blocker);
    if (typeof deps.runHarness !== "function" || typeof deps.writeResult !== "function") throw new Error("MODEL_DEPENDENCY_INVALID");
    const child = deps.runHarness(snapshot);
    if (!epochExecution.validResult(child, env)) throw new Error("MODEL_CHILD_RESULT_INVALID");
    answer = epochExecution.result(env, child.status, child.blocker, child.teardownVerified);
    gate(answer.status === "MODEL_PASS" ? "work" : "cleanup");
    try {
      if (!epochExecution.synchronousProof(deps.writeResult(answer), "trigger-fork-inert-write/v1", "written")) throw new Error("MODEL_WRITE_FAILED");
    } catch (_) { throw new Error("MODEL_WRITE_FAILED"); }
    gate(answer.status === "MODEL_PASS" ? "work" : "cleanup");
  } catch (error) {
    const blocker = epochExecution.failureCode(error, "MODEL_CHILD_RESULT_INVALID");
    answer = epochExecution.result(env, "MODEL_UNCERTAIN", blocker, answer ? answer.teardownVerified : false);
  }
  return answer;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
function defaultDeps() {
  return {
    readArtifact: (file) => fs.readFileSync(file, "utf8"),
    writeArtifact: (file, output) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`);
    },
    loadScenario: (file) => require(file),
    scenarioExists: (file) => fs.existsSync(file),
    runForkPoc: (options) => forkPoc.runForkPoc(options),
    now: () => Date.now(),
    write: (text) => process.stdout.write(text),
    triggersDir: TRIGGERS_DIR,
    outDir: OUT_DIR,
  };
}

async function main(argv = process.argv, depsInput = {}) {
  const deps = { ...defaultDeps(), ...depsInput };
  const write = deps.write || (() => {});
  let parsed;
  try {
    parsed = parseArgs(argv.slice(2));
  } catch (error) {
    write(`${USAGE}\n`);
    return { status: "USAGE_ERROR", blocker: sanitizeBlocker(error) };
  }

  const outcome = await runBridge({ artifactPath: parsed.artifact || undefined, run: parsed.run }, deps);
  if (outcome.status === "PLAN_ONLY") {
    write(`${JSON.stringify(outcome.output, null, 2)}\n`);
  } else if (outcome.output) {
    write(`${JSON.stringify({
      status: outcome.status,
      artifact: relPosix(outcome.outPath),
      firedCount: outcome.output.firedCount,
      executedCount: outcome.output.executedCount,
      triggers: outcome.output.triggers.map((row) => ({
        producerId: row.producerId,
        status: row.status,
        result: row.result,
        net: row.net,
        blocker: row.blocker,
      })),
    })}\n`);
  } else {
    write(`${JSON.stringify({ status: outcome.status, blocker: outcome.blocker })}\n`);
  }
  return outcome;
}

async function runCli(argv = process.argv, depsInput = {}) {
  try {
    const outcome = await main(argv, depsInput);
    process.exitCode = outcome && outcome.status === "BRIDGE_COMPLETE" ? 0 : outcome && outcome.status === "PLAN_ONLY" ? 0 : 1;
    return outcome;
  } catch (_) {
    process.stdout.write(`${JSON.stringify({ status: "FAIL_CLOSED", blocker: "INTERNAL_FAILURE_REDACTED" })}\n`);
    process.exitCode = 1;
    return { status: "FAIL_CLOSED", blocker: "INTERNAL_FAILURE_REDACTED" };
  }
}

if (require.main === module) runCli();

module.exports = {
  runEpochBridgeModel,
  ROOT,
  OUT_DIR,
  TRIGGERS_DIR,
  DEFAULT_ARTIFACT,
  SCHEMA,
  SOURCE_SCHEMA,
  FIRED_STATUSES,
  NOT_FIRED_STATUSES,
  FIXED_CHAIN,
  LIMITS,
  USAGE,
  isFired,
  classifyStatus,
  parseArgs,
  scenarioPathFor,
  resolveChainId,
  resolveBlock,
  buildPlan,
  buildOutput,
  extractNet,
  sanitizeBlocker,
  runBridge,
  defaultDeps,
  main,
  runCli,
};
