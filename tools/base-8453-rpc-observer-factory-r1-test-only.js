"use strict";

const {
  ERROR,
  POLICY,
  runHardBoundedPreflightForTest,
} = require("./base-8453-hard-bounded-rpc-r1-test-only");

const LEASES = new WeakMap();
const LEASE_ERROR = "E_BASE8453_OBSERVER_LEASE_INVALID";
const SERIALIZATION_ERROR = "E_BASE8453_OBSERVER_LEASE_NON_SERIALIZABLE";
const SANITIZED_PREFLIGHT = Object.freeze({
  status: "READY",
  chainId: POLICY.chainId,
  requestDeadlineMs: POLICY.requestDeadlineMs,
  selectedPerObserverMs: POLICY.selectedPerObserverMs,
  selectedTotalMs: POLICY.selectedTotalMs,
  retries: POLICY.retries,
});

function fail(code) {
  const error = new Error(code);
  error.code = code;
  error.stack = code;
  throw error;
}

function record(lease) {
  const value = lease && LEASES.get(lease);
  if (!value) fail(LEASE_ERROR);
  return value;
}

async function createTestBase8453Observers(fixture) {
  if (!fixture || Object.getPrototypeOf(fixture) !== Object.prototype) fail(LEASE_ERROR);
  const internal = await runHardBoundedPreflightForTest(fixture);
  const revocable = Proxy.revocable(Object.freeze(Object.create(null)), {
    get(target, property, receiver) {
      if (property === "toJSON" || property === Symbol.toPrimitive) fail(SERIALIZATION_ERROR);
      return Reflect.get(target, property, receiver);
    },
  });
  LEASES.set(revocable.proxy, { revoke: revocable.revoke, internal });
  return revocable.proxy;
}

function getTestBase8453Preflight(lease) {
  record(lease);
  return SANITIZED_PREFLIGHT;
}

function releaseTestBase8453Observers(lease) {
  const value = record(lease);
  LEASES.delete(lease);
  value.revoke();
}

module.exports = Object.freeze({
  ERROR,
  POLICY,
  runHardBoundedPreflightForTest,
  createTestBase8453Observers,
  getTestBase8453Preflight,
  releaseTestBase8453Observers,
});
