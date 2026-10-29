#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { connectForPass, loadRpcCandidates, httpRpc, runPass, validateAuthorization,
  validateMorphoAuthorization, readBatchWithRenewal, createPhaseTimings, computeEthPollIntervalMs,
  shouldImmediateFollowUp, waitForNewHead } = require("./execute-top-whale-trigger.js");
const { requireThat, atomicJson, safeError } = require("./lib/wallet-execution-guard.js");

const ROOT = path.resolve(__dirname, "..");
const BUNDLE = path.join(ROOT, "coordination/live-execution-batch-aave-v4-v3-morpho.json");
const MORPHO_BUNDLE = path.join(ROOT, "coordination/live-execution-batch-morpho-trigger.json");
const BUNDLE_RENEWAL = path.join(ROOT, "coordination/live-execution-batch-aave-v4-v3-morpho-renewal-20261027.json");
const MORPHO_BUNDLE_RENEWAL = path.join(ROOT, "coordination/live-execution-batch-morpho-trigger-renewal-20261027.json");
const STATUS_FILE = path.join(ROOT, "reports/raw/fast/top-whale-executor-live-watch.json");
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRYABLE = new Set(["WALLET_LOCK_HELD", "BROAD_COLLECTION_PARTIAL",
  "RPC_TIMEOUT", "RPC_TRANSPORT_ERROR", "RPC_HTTP_RETRYABLE"]);
const FATAL_PIN_ERRORS = new Set(["PIN_EVIDENCE_INVALIDATED", "PROVIDER_RESULT_DISAGREEMENT",
  "PIN_TOO_FAR_BEHIND", "REPIN_IN_PROGRESS"]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const milliseconds = start => Math.round((performance.now() - start) * 1000) / 1000;
const pinRef = pin => pin ? { number: pin.number, hash: pin.hash } : null;

function parseOptions(args) {
  let maxPasses = Infinity, interval = 1000;
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], raw = args[++i], value = Number(raw);
    requireThat(["--max-passes", "--interval-ms"].includes(flag) && !seen.has(flag) &&
      /^[1-9][0-9]*$/.test(raw || "") && Number.isSafeInteger(value), "WARM_LOOP_ARGUMENTS_INVALID");
    seen.add(flag);
    if (flag === "--max-passes") maxPasses = value;
    else {
      requireThat(value <= 2147483647, "WARM_LOOP_ARGUMENTS_INVALID");
      interval = value;
    }
  }
  return { maxPasses, interval };
}

// Preserve each method's receiver, arguments, result and rejection. Track whole
// operations (including their retries), not just individual physical RPC calls.
// This also drains a head read that outlives waitForNewHead's advisory timeout.
function trackSessionWork(pinned) {
  const pending = new Set();
  const track = (owner, name) => {
    const invoke = owner[name];
    if (typeof invoke !== "function") return;
    owner[name] = function (...args) {
      const result = invoke.apply(this, args);
      const settled = Promise.resolve(result).then(() => pending.delete(settled), () => pending.delete(settled));
      pending.add(settled);
      return result;
    };
  };
  for (const name of ["call", "estimateGas", "nonce", "receipt", "send", "recheck", "code", "liveHeadNumber"]) track(pinned, name);
  track(pinned.collectorOptions, "rpcCall");
  return async () => { while (pending.size) await Promise.all([...pending]); };
}

function printPass(pass, summary, from, cycleStart) {
  const phases = summary.phaseTimingsMs;
  console.log(JSON.stringify({ pass, armed: summary.armed === true,
    candidateCount: summary.candidateCount ?? null, pin: summary.pin ?? null,
    repin: { from, to: pinRef(summary.pin) }, cycleMs: milliseconds(cycleStart),
    phases: { acquisition: phases.acquisition ?? 0, broadCollection: phases.broadCollection, total: phases.total } }));
}

async function main(args = process.argv.slice(2)) {
  const { maxPasses, interval } = parseOptions(args);
  // Only the plain CURRENT session supports repin. Do not accept lease/future
  // flags, change the default partition, or bypass any runPass execution gate.
  const argv = [];
  const loadBatch = () => readBatchWithRenewal(BUNDLE, BUNDLE_RENEWAL);
  const loadMorphoBatch = () => readBatchWithRenewal(MORPHO_BUNDLE, MORPHO_BUNDLE_RENEWAL);
  const validateBatches = () => {
    const batch = loadBatch(), morphoBatch = loadMorphoBatch(), now = Date.now();
    validateAuthorization(batch, now); validateMorphoAuthorization(morphoBatch, now);
    return { batch, morphoBatch };
  };
  const secondarySendRawTransaction = (signed, assertDispatch) =>
    httpRpc({ handle: "https://rpc.flashbots.net/fast" }, "eth_sendRawTransaction", [signed], 3500, assertDispatch);
  let cycleStart = performance.now(), timings = createPhaseTimings(), pinned;
  const blocked = error => error.passSummary || { ok: false, armed: false, mode: "BLOCKED",
    checkedAt: new Date().toISOString(), reason: safeError(error), phaseTimingsMs: timings.snapshot(),
    ...(pinned ? { pin: pinned.pin } : {}) };
  try {
    validateBatches();
    const endAcquisition = timings.begin("acquisition");
    try {
      const candidates = loadRpcCandidates();
      pinned = await connectForPass({ argv, candidates, rpc: httpRpc });
    } finally { endAcquisition(pinned?.pin); }
    requireThat(typeof pinned.repin === "function" && typeof pinned.liveHeadNumber === "function",
      "WARM_LOOP_SESSION_UNSUPPORTED");
  } catch (error) {
    atomicJson(STATUS_FILE, blocked(error)); throw error;
  }
  const drain = trackSessionWork(pinned);
  let consecutiveFailures = 0;
  for (let pass = 1; pass <= maxPasses; pass++) {
    if (pass > 1) { cycleStart = performance.now(); timings = createPhaseTimings(); }
    const from = pass === 1 ? null : pinRef(pinned.pin);
    let result, stage = "repin";
    try {
      await drain();
      if (pass > 1) await pinned.repin();
      pinned.assertUsable();
      stage = "authorization";
      const { batch, morphoBatch } = validateBatches();
      stage = "pass";
      try {
        result = await runPass({ execute: true, argv, batch, morphoBatch, pinned,
          writeOut: true, timings, loadBatch, loadMorphoBatch, secondarySendRawTransaction });
      } finally { await drain(); }
      // runPass writes its own summary, exactly as the one-shot success path.
      // Never overwrite that artifact with the { fired, summary } return wrapper.
      pinned.assertUsable();
      printPass(pass, result.summary, from, cycleStart);
      consecutiveFailures = 0;
    } catch (error) {
      await drain();
      const summary = blocked(error);
      atomicJson(STATUS_FILE, summary); printPass(pass, summary, from, cycleStart);
      consecutiveFailures++;
      let usable = true;
      try { pinned.assertUsable(); } catch (_) { usable = false; }
      // Trust failures and every repin failure are terminal: never retry a
      // poisoned session or reconnect silently. Retry only known unsigned holds.
      if (!usable || stage !== "pass" || FATAL_PIN_ERRORS.has(error.code) || !RETRYABLE.has(error.code) ||
        consecutiveFailures >= MAX_CONSECUTIVE_FAILURES || pass === maxPasses) throw error;
      await sleep(computeEthPollIntervalMs(null, Math.min(5000, interval * 2 ** (consecutiveFailures - 1))));
      continue;
    }
    if (pass === maxPasses) break;
    const intervalMs = computeEthPollIntervalMs(result.summary, interval);
    if (shouldImmediateFollowUp(result.summary)) continue;
    try {
      await waitForNewHead({ ...pinned.pin }, { intervalMs, liveHeadNumber: pinned.liveHeadNumber.bind(pinned) });
    } finally { await drain(); }
  }
}

if (require.main === module) main().catch(() => {
  console.error(JSON.stringify({ ok: false, armed: false, reason: "WARM_LOOP_STOPPED" }));
  process.exitCode = 1;
});
module.exports = { main };
