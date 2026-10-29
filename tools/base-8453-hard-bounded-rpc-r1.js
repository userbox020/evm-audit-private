"use strict";

const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");
const {
  POLICY,
  runHardBoundedPreflightForTest,
} = require("./base-8453-hard-bounded-rpc-r1-test-only");

const INVENTORY_PATH = path.resolve(__dirname, "..", "rpc_endpoints.txt");
const PRODUCTION_FETCH = globalThis.fetch.bind(globalThis);
const LEASES = new WeakMap();
const ERROR = Object.freeze({
  preflight: "E_BASE8453_PRODUCTION_PREFLIGHT_FAILED",
  lease: "E_BASE8453_OBSERVER_LEASE_INVALID",
  serialization: "E_BASE8453_OBSERVER_LEASE_NON_SERIALIZABLE",
});
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

function readFixedInventory() {
  try {
    const stat = fs.statSync(INVENTORY_PATH);
    if (!stat.isFile() || stat.size > POLICY.inventoryBytes) fail(ERROR.preflight);
    const bytes = fs.readFileSync(INVENTORY_PATH);
    if (bytes.length > POLICY.inventoryBytes) fail(ERROR.preflight);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error?.code === ERROR.preflight) throw error;
    fail(ERROR.preflight);
  }
}

function createLease(internal) {
  const revocable = Proxy.revocable(Object.freeze(Object.create(null)), {
    get(target, property, receiver) {
      if (property === "toJSON" || property === Symbol.toPrimitive) fail(ERROR.serialization);
      return Reflect.get(target, property, receiver);
    },
  });
  LEASES.set(revocable.proxy, { internal, revoke: revocable.revoke });
  return revocable.proxy;
}

function getRecord(lease) {
  const record = lease && LEASES.get(lease);
  if (!record) fail(ERROR.lease);
  return record;
}

async function createProductionBase8453Observers() {
  try {
    const result = await runHardBoundedPreflightForTest({
      inventoryText: readFixedInventory(),
      fetchImpl: PRODUCTION_FETCH,
    });
    return createLease(result);
  } catch (_error) {
    fail(ERROR.preflight);
  }
}

function getProductionBase8453Preflight(lease) {
  getRecord(lease);
  return SANITIZED_PREFLIGHT;
}

function releaseProductionBase8453Observers(lease) {
  const record = getRecord(lease);
  LEASES.delete(lease);
  record.revoke();
}

module.exports = Object.freeze({
  createProductionBase8453Observers,
  getProductionBase8453Preflight,
  releaseProductionBase8453Observers,
});
