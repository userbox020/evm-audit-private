"use strict";

// Offline controller only. The caller owns approval, the scanner, and every physical RPC dispatch.
const { types } = require("node:util");
const { performance } = require("node:perf_hooks");
const { setTimeout: delay } = require("node:timers/promises");

const batchKeys = ["approved", "chainIds", "maxCycles", "maxRPCRequests", "cadenceMs", "expiresAtMs", "maxCycleMs"];
const resultKeys = ["observations", "providerHold"];
const observationKeys = ["chainId", "candidateId", "pinHash", "observedAtMs", "evidence", "grossDeltaAtomic", "economicCostsComplete", "conservativeNetAtomic", "fullInputConsumed", "financingRepaymentProven", "atomicSettlementProven", "completeGasMeasured", "independentStateConfirmed", "routeProofComplete"];
const gateKeys = ["economicCostsComplete", "fullInputConsumed", "financingRepaymentProven", "atomicSettlementProven", "completeGasMeasured", "independentStateConfirmed", "routeProofComplete"];
const optionsKeys = ["batch", "scanCycle", "now", "sleep", "onEvent", "signal"];
const decimal = /^-?(?:0|[1-9][0-9]*)$/;
const reasons = new WeakMap();
const fail = (reason) => { const error = new Error(reason); reasons.set(error, reason); return error; };
const reasonOf = (error, fallback) => reasons.get(error) || fallback;
const safeInt = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;

function ownData(value, keys, array = false, maxLength = Number.MAX_SAFE_INTEGER) {
  if (value === null || typeof value !== "object" || types.isProxy(value)) throw fail("STOP_INVALID_RESULT");
  if (array ? !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    : Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw fail("STOP_INVALID_RESULT");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (array) {
    if (!safeInt(descriptors.length?.value, 0, maxLength) || names.length !== descriptors.length.value + 1) throw fail("STOP_INVALID_RESULT");
    for (let i = 0; i < descriptors.length.value; i += 1) {
      if (!descriptors[i] || !Object.hasOwn(descriptors[i], "value")) throw fail("STOP_INVALID_RESULT");
    }
    return Array.from({ length: descriptors.length.value }, (_, i) => descriptors[i].value);
  }
  if (names.length !== keys.length || names.some((name) => typeof name !== "string" || !keys.includes(name) || !Object.hasOwn(descriptors[name], "value"))) {
    throw fail("STOP_INVALID_RESULT");
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function atomic(value) {
  return value === null || (typeof value === "string" && decimal.test(value)
    && value.replace(/^-/, "").length <= 78 && value !== "-0");
}

function clock(now, previous) {
  let value;
  try { value = now(); } catch (_) { throw fail("STOP_UNSAFE_CLOCK"); }
  if (!safeInt(value, 1, Number.MAX_SAFE_INTEGER) || value < previous) throw fail("STOP_UNSAFE_CLOCK");
  return value;
}

function validatedResult(raw, chains, cycleStart, maxCycleMs, time) {
  const result = ownData(raw, resultKeys);
  if (typeof result.providerHold !== "boolean") throw fail("STOP_INVALID_RESULT");
  const rows = ownData(result.observations, [], true, 48);
  return { providerHold: result.providerHold, observations: rows.map((row) => {
    const obs = ownData(row, observationKeys);
    if (!chains.includes(obs.chainId) || !safeInt(obs.observedAtMs, cycleStart, Number.MAX_SAFE_INTEGER)
      || obs.observedAtMs > time + 15000 || obs.observedAtMs - cycleStart > maxCycleMs
      || typeof obs.candidateId !== "string" || !/^[a-z0-9-]{1,80}$/.test(obs.candidateId)
      || typeof obs.pinHash !== "string" || !/^(?:0x)?[a-fA-F0-9]{64}$/.test(obs.pinHash)
      || !["PREFILTER", "FULL_SIZE_QUOTE"].includes(obs.evidence)
      || !atomic(obs.grossDeltaAtomic) || !atomic(obs.conservativeNetAtomic)
      || gateKeys.some((key) => typeof obs[key] !== "boolean")
      || (obs.economicCostsComplete && obs.conservativeNetAtomic === null)
      || (obs.grossDeltaAtomic !== null && obs.conservativeNetAtomic !== null
        && BigInt(obs.conservativeNetAtomic) > BigInt(obs.grossDeltaAtomic))) throw fail("STOP_INVALID_RESULT");
    return obs;
  }) };
}

function classify(obs) {
  let status = "PREFILTER_WATCH";
  if (obs.evidence === "FULL_SIZE_QUOTE" && obs.grossDeltaAtomic !== null) {
    if (BigInt(obs.grossDeltaAtomic) <= 0n || (obs.conservativeNetAtomic !== null && BigInt(obs.conservativeNetAtomic) <= 0n)) {
      status = "NET_NONPOSITIVE_WATCH";
    } else if (!obs.economicCostsComplete) {
      status = "GROSS_POSITIVE_COSTS_UNKNOWN_WATCH";
    } else {
      status = obs.conservativeNetAtomic !== null && BigInt(obs.conservativeNetAtomic) > 0n
        && gateKeys.every((key) => obs[key])
        ? "CONSERVATIVE_NET_POSITIVE_VALIDATED" : "NET_POSITIVE_VALIDATION_REQUIRED";
    }
  }
  return Object.freeze({ ...obs, status, routePositive: "unknown", automaticPromotion: false,
    signedActionsAuthorized: false, requiresParentReview: true });
}

// Callback arguments: sleep(milliseconds, signal), scanCycle(frozenContext), onEvent(frozenEvent).
async function runBoundedRouteWatch(options) {
  const out = { status: "NOT_STARTED", reason: "STOP_INVALID_BATCH", cyclesStarted: 0, cyclesCompleted: 0,
    actualRPCRequests: 0, events: [], active: false, unsettled: false,
    automaticPromotion: false, signedActionsAuthorized: false };
  let input, batch, now, sleep, scanCycle, onEvent, signal, last = 0;
  try {
    if (options === null || typeof options !== "object" || types.isProxy(options)) throw fail("STOP_INVALID_BATCH");
    input = ownData(options, optionsKeys.filter((key) => Object.hasOwn(options, key)));
    batch = ownData(input.batch, batchKeys);
    ({ scanCycle, signal } = input);
    now = input.now === undefined ? Date.now : input.now;
    sleep = input.sleep === undefined ? (ms, s) => delay(ms, undefined, { signal: s }) : input.sleep;
    onEvent = input.onEvent;
    if (batch.approved !== true || !Array.isArray(batch.chainIds) || types.isProxy(batch.chainIds)
      || !safeInt(batch.maxCycles, 1, 12) || !safeInt(batch.maxRPCRequests, 1, 1000)
      || !safeInt(batch.cadenceMs, 60000, 3600000) || !safeInt(batch.maxCycleMs, 1000, 300000)
      || !safeInt(batch.expiresAtMs, 1, Number.MAX_SAFE_INTEGER)
      || typeof scanCycle !== "function" || typeof now !== "function" || typeof sleep !== "function"
      || (onEvent !== undefined && typeof onEvent !== "function")
      || (signal !== undefined && (types.isProxy(signal) || !(signal instanceof AbortSignal)))) throw fail("STOP_INVALID_BATCH");
    // Array descriptor inspection rejects holes, accessors, non-index properties and proxies.
    const chainIds = ownData(batch.chainIds, [], true);
    if (!chainIds.length || chainIds.some((id) => !safeInt(id, 1, Number.MAX_SAFE_INTEGER))
      || new Set(chainIds).size !== chainIds.length) throw fail("STOP_INVALID_BATCH");
    batch.chainIds = Object.freeze(chainIds);
    last = clock(now, 0);
    if (last >= batch.expiresAtMs) { out.reason = "STOP_EXPIRED"; return out; }
  } catch (_) { return out; }

  const startedAt = last;
  const nativeStart = performance.now();
  const stop = (reason) => { out.status = "STOPPED"; out.reason = reason; return out; };
  function time() {
    last = clock(now, last);
    if (performance.now() - nativeStart >= batch.expiresAtMs - startedAt || last >= batch.expiresAtMs) throw fail("STOP_EXPIRED");
    if (signal?.aborted) throw fail("STOP_ABORTED");
    return last;
  }

  // A native watchdog bounds an ignored abort or injected sleep/scan/event promise.
  async function bounded(action, deadline, cycleController, nativeDeadline = Infinity) {
    let pending = true;
    const task = Promise.resolve().then(action).then(
      (value) => { pending = false; return { value }; },
      (error) => { pending = false; return { error }; },
    );
    let timer, abortListener;
    const watchdog = new Promise((resolve) => {
      const ms = Math.max(0, Math.min(deadline - last, nativeDeadline - performance.now(),
        batch.expiresAtMs - startedAt - (performance.now() - nativeStart)));
      timer = setTimeout(() => resolve({ reason: "STOP_TIMEOUT" }), ms);
      if (signal) {
        abortListener = () => resolve({ reason: "STOP_ABORTED" });
        signal.addEventListener("abort", abortListener, { once: true });
        if (signal.aborted) abortListener();
      }
    });
    const settled = await Promise.race([task, watchdog]);
    clearTimeout(timer);
    if (abortListener) signal.removeEventListener("abort", abortListener);
    if (settled.reason) {
      cycleController?.abort();
      out.unsettled ||= pending;
      throw fail(settled.reason);
    }
    if (settled.error) throw settled.error;
    return settled.value;
  }

  try {
    for (let number = 1; number <= batch.maxCycles; number += 1) {
      let current = time();
      const schedule = startedAt + (number - 1) * batch.cadenceMs;
      if (!Number.isSafeInteger(schedule) || schedule >= batch.expiresAtMs) throw fail("STOP_EXPIRED");
      let waits = 0;
      while (current < schedule) {
        if (++waits > 4) throw fail("STOP_UNSAFE_CLOCK");
        const waitController = new AbortController();
        try {
          await bounded(() => sleep(schedule - current, waitController.signal), batch.expiresAtMs, waitController);
        } catch (error) { waitController.abort(); throw error; }
        current = time();
      }
      const cycleStart = current;
      const deadlineMs = Math.min(cycleStart + batch.maxCycleMs, batch.expiresAtMs);
      const nativeDeadline = performance.now() + (deadlineMs - cycleStart);
      const cycleController = new AbortController();
      let running = true;
      let forcedStop = null;
      const consumeRPC = () => {
        if (!running) throw fail("STOP_INACTIVE_CYCLE");
        if (forcedStop) throw fail(forcedStop);
        let at;
        try { at = time(); } catch (error) { forcedStop = reasonOf(error, "STOP_UNSAFE_CLOCK"); throw error; }
        if (at >= deadlineMs || performance.now() >= nativeDeadline || cycleController.signal.aborted) {
          forcedStop = "STOP_TIMEOUT"; throw fail(forcedStop);
        }
        if (out.actualRPCRequests >= batch.maxRPCRequests) { forcedStop = "STOP_RPC_CAP"; throw fail(forcedStop); }
        out.actualRPCRequests += 1;
      };
      const context = Object.freeze({ cycleNumber: number, chainIds: batch.chainIds,
        remainingRPCRequests: batch.maxRPCRequests - out.actualRPCRequests,
        deadlineMs, signal: cycleController.signal, consumeRPC });
      out.cyclesStarted++;
      try {
        let raw;
        try { raw = await bounded(() => scanCycle(context), deadlineMs, cycleController, nativeDeadline); }
        catch (error) { throw fail(forcedStop || reasonOf(error, "STOP_SCAN_ERROR")); }
        if (forcedStop) throw fail(forcedStop);
        const at = time();
        if (at >= deadlineMs || performance.now() >= nativeDeadline) throw fail("STOP_TIMEOUT");
        const result = validatedResult(raw, batch.chainIds, cycleStart, batch.maxCycleMs, at);
        if (result.providerHold) throw fail("STOP_PROVIDER_HOLD");
        for (const obs of result.observations) {
          time();
          const event = classify(obs);
          out.events.push(event);
          if (onEvent) {
            try { await bounded(() => onEvent(event), deadlineMs, cycleController, nativeDeadline); }
            catch (error) { throw fail(reasonOf(error, "STOP_EVENT_ERROR")); }
          }
        }
        time();
        if (performance.now() >= nativeDeadline) throw fail("STOP_TIMEOUT");
        out.cyclesCompleted++;
        if (out.actualRPCRequests === batch.maxRPCRequests) throw fail("STOP_RPC_CAP");
      } finally { running = false; cycleController.abort(); }
    }
    out.status = "COMPLETED";
    out.reason = "MAX_CYCLES";
  } catch (error) { stop(reasonOf(error, "STOP_INTERNAL_ERROR")); }
  return out;
}

module.exports = { runBoundedRouteWatch };
