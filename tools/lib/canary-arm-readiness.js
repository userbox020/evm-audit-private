"use strict";

// A pure, monitoring-only projection over *caller-attested* evidence. The caller
// must independently verify and freeze the route proof, canonical batch signature,
// monitor lease, chain pins, and executable recheck; these booleans are not proofs.
// Only a future external controller can atomically claim and consume the batch
// before submission. At-most-once attempts do not guarantee chain inclusion.
// An omitted or spoofed previous result cannot be detected here: an external
// durable, authenticated, batch-bound ledger must enforce continuity and terminal
// tombstones. The flags and witness fields below are caller attestations only.
const HASH = /^0x[0-9a-f]{64}$/u;
const INTEGER = /^(0|[1-9][0-9]*)$/u;
const MAX_PIN_AGE_MS = 10 * 60 * 1000;
const MAX_POLL_GAP_MS = 2 * 60 * 1000;
const SAFETY = Object.freeze({ monitoringOnly: true, noSigning: true, noBroadcast: true,
  dispatchAllowed: false, evidenceStatus: "CALLER_ATTESTED_ONLY", requiresVerifiedController: true });

function identity(value) {
  return value && Number.isSafeInteger(value.chainId) && value.chainId > 0 &&
    typeof value.marketId === "string" && HASH.test(value.marketId) &&
    typeof value.actionId === "string" && value.actionId.length > 0 && value.actionId.length <= 128;
}

function sameIdentity(a, b) {
  return identity(a) && identity(b) && a.chainId === b.chainId &&
    a.marketId === b.marketId && a.actionId === b.actionId;
}

function pinValid(pin, chainId, nowMs) {
  return pin && pin.witnessed === true && pin.chainId === chainId && Number.isSafeInteger(pin.block) && pin.block > 0 &&
    typeof pin.hash === "string" && HASH.test(pin.hash) &&
    Number.isSafeInteger(pin.timeMs) && pin.timeMs >= 0 && pin.timeMs <= nowMs &&
    nowMs - pin.timeMs <= MAX_PIN_AGE_MS;
}

function newer(next, prior) {
  return next.block > prior.block && next.timeMs > prior.timeMs && next.hash !== prior.hash;
}

function amountPositive(value) {
  return typeof value === "bigint" ? value > 0n :
    typeof value === "string" && INTEGER.test(value) && BigInt(value) > 0n;
}

// Inputs: { nowMs, plan, authority, producer, signal, previous?, recheck? }.
// All identities are { chainId (number), marketId (lowercase bytes32), actionId }.
// plan: immutable, independent, sameMarket, forkRehearsed, realFundingProved,
// conditionalNetPositive, nonSynthetic, and identity. `immutable` attests that
// the external proof was sealed; it does not freeze or verify caller data here.
// authority: already signature-verified canonical { state, signatureVerified,
// mode, batchCommitment, scopeCommitment, actionMatch, capsOk, notBeforeMs,
// expiresAtMs, identity }. producer: { active, sole, leaseValid,
// continuityAttested, leaseExpiresAtMs }.
// signal: { status: DORMANT|FIRED, condition: boolean, identity,
// batchCommitment, scopeCommitment, pin: { chainId, block, hash, timeMs,
// witnessed: true } }. Pin witness and continuity attestations are not verified here.
// recheck (FIRED only): identity, batchCommitment, scopeCommitment, pin,
// borrowExecutable, exitExecutable, gasBounded, slippageBounded,
// nonSynthetic, conservativeNet (bigint or canonical nonnegative integer string).
// previous must be this projection's prior result, supplied by the caller.
function projectCanaryArmReadiness({ nowMs, plan, authority, producer, signal, previous, recheck } = {}) {
  const result = (state, reason, extra = {}) => ({ state, reason, ...extra, ...SAFETY });
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return result("NOT_READY", "CLOCK_INVALID");
  const bound = identity(plan?.identity) && sameIdentity(plan.identity, authority?.identity) &&
    HASH.test(authority?.batchCommitment || "") && HASH.test(authority?.scopeCommitment || "");
  const observed = bound ? { identity: { ...plan.identity }, batchCommitment: authority.batchCommitment,
    scopeCommitment: authority.scopeCommitment } : {};
  if (authority?.state === "REVOKED" || authority?.state === "EXPIRED") {
    return result(authority.state, `BATCH_${authority.state}`, observed);
  }
  if (bound && previous && previous.batchCommitment === authority.batchCommitment &&
      previous.scopeCommitment === authority.scopeCommitment &&
      sameIdentity(plan.identity, previous.identity) &&
      ["EXPIRED", "REVOKED", "BLOCKED_RECHECK", "TRIGGERED"].includes(previous.state)) {
    const state = previous.state === "EXPIRED" || previous.state === "REVOKED" ? previous.state : "BLOCKED_RECHECK";
    return result(state, "PRIOR_TERMINAL", observed);
  }
  if (!plan || plan.immutable !== true || plan.independent !== true ||
      plan.sameMarket !== true || plan.forkRehearsed !== true ||
      plan.realFundingProved !== true || plan.conditionalNetPositive !== true ||
      plan.nonSynthetic !== true || !identity(plan.identity)) {
    return result("NOT_READY", "ROUTE_UNPROVEN");
  }
  if (!authority || authority.state !== "VALID" || authority.signatureVerified !== true ||
      authority.mode !== "PRODUCTION" || !HASH.test(authority.batchCommitment || "") ||
      !HASH.test(authority.scopeCommitment || "") || authority.actionMatch !== true ||
      authority.capsOk !== true || !sameIdentity(plan.identity, authority.identity) ||
      !Number.isSafeInteger(authority.notBeforeMs) ||
      !Number.isSafeInteger(authority.expiresAtMs) || authority.notBeforeMs < 0 ||
      authority.expiresAtMs <= authority.notBeforeMs) {
    return result("NOT_READY", "BATCH_INVALID_OR_SCOPE_MISMATCH");
  }
  if (nowMs >= authority.expiresAtMs) return result("EXPIRED", "BATCH_EXPIRED", observed);
  if (nowMs < authority.notBeforeMs) return result("NOT_READY", "BATCH_NOT_YET_VALID");
  if (!producer || producer.active !== true || producer.sole !== true ||
      producer.leaseValid !== true || producer.continuityAttested !== true ||
      !Number.isSafeInteger(producer.leaseExpiresAtMs) ||
      producer.leaseExpiresAtMs <= nowMs) {
    return result("NOT_READY", "MONITOR_NOT_SOLE_ACTIVE");
  }
  const fired = signal?.status === "FIRED";
  const invalid = (reason) => result(fired ? "BLOCKED_RECHECK" : "NOT_READY", reason, observed);
  if (!signal || !["DORMANT", "FIRED"].includes(signal.status) ||
      signal.condition !== fired || !sameIdentity(plan.identity, signal.identity) ||
      signal.batchCommitment !== authority.batchCommitment ||
      signal.scopeCommitment !== authority.scopeCommitment ||
      !pinValid(signal.pin, plan.identity.chainId, nowMs)) {
    return invalid("SIGNAL_INVALID_OR_STALE");
  }
  if (previous !== undefined) {
    if (!previous || !Number.isSafeInteger(previous.observedAtMs) ||
        previous.observedAtMs > nowMs || nowMs - previous.observedAtMs > MAX_POLL_GAP_MS || !previous.pin ||
        !sameIdentity(plan.identity, previous.identity) ||
        previous.batchCommitment !== authority.batchCommitment ||
        previous.scopeCommitment !== authority.scopeCommitment ||
        !pinValid(previous.pin, plan.identity.chainId, previous.observedAtMs) ||
        !newer(signal.pin, previous.pin)) {
      return invalid("POLL_REGRESSION_OR_SCOPE_CHANGE");
    }
    if (previous.state === "BLOCKED_RECHECK" || previous.state === "TRIGGERED") {
      return result("BLOCKED_RECHECK", "PRIOR_FIRE_TERMINAL", { ...observed, pin: { ...signal.pin }, observedAtMs: nowMs });
    }
  }
  const current = { ...observed, pin: { ...signal.pin }, observedAtMs: nowMs };
  if (!fired) return result("ARMED_WAITING", "AWAITING_SIGNAL", current);
  if (previous?.state !== "ARMED_WAITING") return result("BLOCKED_RECHECK", "NO_PRIOR_ARMED_POLL", current);
  if (!recheck || !sameIdentity(plan.identity, recheck.identity) ||
      recheck.batchCommitment !== authority.batchCommitment ||
      recheck.scopeCommitment !== authority.scopeCommitment ||
      !pinValid(recheck.pin, plan.identity.chainId, nowMs) ||
      !newer(recheck.pin, signal.pin) || recheck.borrowExecutable !== true ||
      recheck.exitExecutable !== true || recheck.gasBounded !== true ||
      recheck.slippageBounded !== true || recheck.nonSynthetic !== true ||
      !amountPositive(recheck.conservativeNet)) {
    return result("BLOCKED_RECHECK", "RECHECK_INVALID_OR_UNPROFITABLE", current);
  }
  return result("TRIGGERED", "RECHECK_PASSED_DECISION_ONLY", { ...current, recheckPin: { ...recheck.pin } });
}

module.exports = { projectCanaryArmReadiness };
