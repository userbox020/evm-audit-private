#!/usr/bin/env node
// autopilot-action-queue.js - advisory action-intent queue scaffold.
// This file never reads private keys, RPC inventory, or env files.

const fs = require("fs");
const path = require("path");
const { authorizationRow } = require("./live-execution-batch");

const WORKSPACE = path.resolve(__dirname, "..");
const QUEUE_FILE = path.join(WORKSPACE, "reports", "monitor", "autopilot-action-queue.json");

const SIGNED_ACTION_REQUIRES = [
  "explicit operator authorization",
  "same-branch routePositive/executableNow gate",
  "fresh exact positive economics after gas/slippage/fees",
  "fresh fork extraction proof with measured profit",
  "fresh staticCall success",
  "fresh estimateGas within model",
  "minProfit/minOut gates encoded in calldata or executor args",
  "deployed bytecode/artifact verification",
  "chain-specific target/spender allowlist pass",
  "final global gate pass immediately before signing",
];

function ts() {
  return new Date().toISOString();
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function loadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(file);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeIntent(intent) {
  const id = intent.id || `${intent.branch || "unknown"}-${Date.now()}`;
  const checks = intent.checks || {};
  const missing = SIGNED_ACTION_REQUIRES.filter((gate) => checks[gate] !== true);
  return {
    id,
    createdAt: intent.createdAt || ts(),
    updatedAt: ts(),
    branch: intent.branch || "unknown",
    chainId: intent.chainId ?? null,
    action: intent.action || "unknown",
    status: missing.length === 0 ? "ready-for-final-authorization" : "blocked",
    expectedProfitUsd: intent.expectedProfitUsd ?? null,
    routeArtifact: intent.routeArtifact || null,
    forkProofArtifact: intent.forkProofArtifact || null,
    target: intent.target || null,
    spender: intent.spender || null,
    checks,
    missingGates: missing,
    liveActionBlocked: missing.length > 0,
    signedActionJustified: false,
    note: intent.note || "Action intents are advisory only until every gate passes and explicit live authorization is present.",
  };
}

function emptyQueue(reason = "No action intents have been produced.") {
  return {
    generatedAt: ts(),
    scanner: "tools/autopilot-action-queue.js",
    scope: "Advisory central action-intent queue scaffold for manual/capital routes",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      signedActionJustified: false,
    },
    policy: {
      defaultMode: "no-queued-intents",
      queueIsExecutionAuthority: false,
      lowFundAutoExecutorsBypassQueue: true,
      capitalDelayedRoutesDisabled: true,
      signedActionRequires: SIGNED_ACTION_REQUIRES,
    },
    summary: {
      status: "empty-no-queued-intents",
      totalIntents: 0,
      readyIntents: 0,
      blockedIntents: 0,
      executableNow: 0,
      signedActionJustified: false,
      authorizationState: authorizationRow().authorizationState,
      liveActionBlocked: false,
      capitalDelayedRoutesBlocked: true,
      reason,
      nextAction: "Low-fund route-guarded executors may run directly in auto mode; capital/delayed/manual routes must remain disabled or write intents here for review.",
    },
    intents: [],
  };
}

function summarize(intents, reason = null) {
  const ready = intents.filter((intent) => intent.status === "ready-for-final-authorization");
  return {
    status: ready.length > 0 ? "intents-need-final-authorization" : intents.length > 0 ? "all-intents-blocked" : "empty-no-queued-intents",
    totalIntents: intents.length,
    readyIntents: ready.length,
    blockedIntents: intents.length - ready.length,
    executableNow: 0,
    signedActionJustified: false,
    authorizationState: authorizationRow().authorizationState,
    liveActionBlocked: false,
    capitalDelayedRoutesBlocked: true,
    reason: reason || (ready.length > 0 ? "Ready intents still require explicit live authorization and final global-gate check." : "No fully gated action intent is ready."),
    nextAction: "Keep capital/delayed/manual routes disabled unless a route-specific intent has fresh economics, fork proof, preflight, allowlist, and explicit authorization.",
  };
}

function readQueue() {
  return loadJson(QUEUE_FILE, null);
}

function ensureQueue() {
  const existing = readQueue();
  if (
    existing
    && Array.isArray(existing.intents)
    && existing.summary
    && existing.policy?.lowFundAutoExecutorsBypassQueue === true
  ) {
    existing.generatedAt = ts();
    existing.summary = summarize(existing.intents, existing.summary.reason);
    writeJson(QUEUE_FILE, existing);
    return existing;
  }
  const queue = emptyQueue();
  writeJson(QUEUE_FILE, queue);
  return queue;
}

function writeQueue(intents, reason = null) {
  const normalized = intents.map(normalizeIntent);
  const queue = emptyQueue(reason || "Queue rewritten.");
  queue.generatedAt = ts();
  queue.summary = summarize(normalized, reason);
  queue.intents = normalized;
  writeJson(QUEUE_FILE, queue);
  return queue;
}

function appendBlockedIntent(intent) {
  const existing = ensureQueue();
  const intents = Array.isArray(existing.intents) ? existing.intents.slice() : [];
  intents.push(normalizeIntent({ ...intent, status: "blocked" }));
  return writeQueue(intents, "Blocked intent appended; live action remains disabled.");
}

function printStatus(queue) {
  console.log(`actionQueue=${queue.summary.status} total=${queue.summary.totalIntents} ready=${queue.summary.readyIntents} authorizationState=${queue.summary.authorizationState} signedActionJustified=false`);
  console.log(`artifact=${path.relative(WORKSPACE, QUEUE_FILE)}`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--authorize")) {
    console.log(JSON.stringify(authorizationRow()));
    return;
  }
  if (args.includes("--init") || args.includes("--status") || args.length === 0) {
    const queue = ensureQueue();
    printStatus(queue);
    return;
  }
  if (args.includes("--clear")) {
    const queue = writeQueue([], "Queue cleared by operator request; live action remains disabled.");
    printStatus(queue);
    return;
  }
  console.error("Usage: node tools/autopilot-action-queue.js [--init|--status|--clear|--authorize]");
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  QUEUE_FILE,
  SIGNED_ACTION_REQUIRES,
  ensureQueue,
  readQueue,
  writeQueue,
  appendBlockedIntent,
};
