"use strict";

const DEFAULT_LIMITS = Object.freeze({
  maxCandidates: 44,
  maxProbeCallsPerCandidate: 12,
  reserveRequests: 15,
  retries: 0,
  maxNetworkCalls: 80
});

const REVIEWED_OPERATOR_FAMILY_IDS = Object.freeze([
  "alchemy", "infura", "quicknode", "ankr", "publicnode", "1rpc", "0xrpc", "drpc"
]);
const REVIEWED_OPERATOR_FAMILY_ID_SET = new Set(REVIEWED_OPERATOR_FAMILY_IDS);
const REVIEWED_OPERATOR_FAMILY_SET = new Set(REVIEWED_OPERATOR_FAMILY_IDS);
for (const method of ["add", "delete", "clear"]) {
  Object.defineProperty(REVIEWED_OPERATOR_FAMILY_SET, method, {
    value() { throw new TypeError("REVIEWED_OPERATOR_FAMILY_SET_IMMUTABLE"); },
    writable: false,
    configurable: false
  });
}
Object.freeze(REVIEWED_OPERATOR_FAMILY_SET);

const OPERATOR_SUFFIX_ALIASES = Object.freeze([
  Object.freeze({ suffix: "alchemy.com", operatorFamily: "alchemy", capabilityRank: 0 }),
  Object.freeze({ suffix: "infura.io", operatorFamily: "infura", capabilityRank: 0 }),
  Object.freeze({ suffix: "quicknode.com", operatorFamily: "quicknode", capabilityRank: 0 }),
  Object.freeze({ suffix: "quiknode.pro", operatorFamily: "quicknode", capabilityRank: 0 }),
  Object.freeze({ suffix: "ankr.com", operatorFamily: "ankr", capabilityRank: 0 }),
  Object.freeze({ suffix: "publicnode.com", operatorFamily: "publicnode", capabilityRank: 2 }),
  Object.freeze({ suffix: "1rpc.io", operatorFamily: "1rpc", capabilityRank: 2 }),
  Object.freeze({ suffix: "0xrpc.io", operatorFamily: "0xrpc", capabilityRank: 2 }),
  Object.freeze({ suffix: "drpc.org", operatorFamily: "drpc", capabilityRank: 2 })
]);

const ERROR_CODES = new Set([
  "TWO_FAMILIES_UNAVAILABLE",
  "PIN_CONSENSUS_UNAVAILABLE",
  "STATE_CONSENSUS_UNAVAILABLE",
  "NETWORK_CALL_CAP",
  "PROBE_CAPABILITY_UNAVAILABLE",
  "INVALID_PREFLIGHT_INPUT"
]);

class PreflightError extends Error {
  constructor(code, diagnostics, details = {}) {
    super(code);
    this.name = "PreflightError";
    this.code = ERROR_CODES.has(code) ? code : "INVALID_PREFLIGHT_INPUT";
    this.diagnostics = diagnostics ? Object.freeze({ ...diagnostics }) : undefined;
    this.pin = details.pin;
  }
}

function fail(code, diagnostics, details) { throw new PreflightError(code, diagnostics, details); }
function reviewedOperatorFamily(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return REVIEWED_OPERATOR_FAMILY_ID_SET.has(normalized) ? normalized : null;
}
function classifyOperatorFamily(value) {
  try {
    const raw = typeof value === "string" ? value : value && typeof value.url === "string" ? value.url : null;
    if (!raw) return null;
    const host = new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
    const alias = OPERATOR_SUFFIX_ALIASES.find((row) => host === row.suffix || host.endsWith(`.${row.suffix}`));
    return alias ? Object.freeze({ operatorFamily: alias.operatorFamily, capabilityRank: alias.capabilityRank }) : null;
  } catch (_) {
    return null;
  }
}

function parseQuantity(value) {
  try {
    if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch (_) { return null; }
}
function hash32(value) { return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value); }
function normalizeHeader(raw) {
  if (!raw || typeof raw !== "object") return null;
  const number = parseQuantity(raw.number), timestamp = parseQuantity(raw.timestamp);
  if (number === null || timestamp === null || number > BigInt(Number.MAX_SAFE_INTEGER)
      || !hash32(raw.hash) || !hash32(raw.parentHash) || !hash32(raw.stateRoot)) return null;
  return Object.freeze({
    number: Number(number),
    hash: raw.hash.toLowerCase(),
    parentHash: raw.parentHash.toLowerCase(),
    stateRoot: raw.stateRoot.toLowerCase(),
    timestamp: timestamp.toString()
  });
}
function headerKey(value) {
  return `${value.number}:${value.hash}:${value.parentHash}:${value.stateRoot}:${value.timestamp}`;
}

function normalizeObservation(value, seen = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) ? value.toLowerCase() : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_PREFLIGHT_INPUT");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") return value.toString();
  if (!value || typeof value !== "object" || seen.has(value)) fail("INVALID_PREFLIGHT_INPUT");
  seen.add(value);
  let normalized;
  if (Array.isArray(value)) normalized = value.map((item) => normalizeObservation(item, seen));
  else {
    normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (typeof value[key] === "undefined" || typeof value[key] === "function" || typeof value[key] === "symbol") fail("INVALID_PREFLIGHT_INPUT");
      normalized[key] = normalizeObservation(value[key], seen);
    }
  }
  seen.delete(value);
  return normalized;
}
function stableObservation(value) { return JSON.stringify(normalizeObservation(value)); }

function createRpcLedger(rawCall, maxNetworkCalls = DEFAULT_LIMITS.maxNetworkCalls) {
  if (typeof rawCall !== "function" || !Number.isSafeInteger(maxNetworkCalls) || maxNetworkCalls <= 0) fail("INVALID_PREFLIGHT_INPUT");
  let networkCalls = 0;
  return Object.freeze({
    async call(handle, method, params, timeout) {
      if (networkCalls >= maxNetworkCalls) fail("NETWORK_CALL_CAP");
      networkCalls += 1;
      return rawCall(handle, method, params, timeout);
    },
    get networkCalls() { return networkCalls; },
    get maxNetworkCalls() { return maxNetworkCalls; }
  });
}

function diagnosticsTemplate(candidatesConsidered) {
  return {
    candidatesConsidered,
    qualificationAttempts: 0,
    chainMatches: 0,
    finalizedQualified: 0,
    pinConsensusFamilies: 0,
    stateAttempts: 0,
    stateSuccesses: 0,
    stateConsensusFamilies: 0,
    stateDistinctGroups: 0
  };
}

function normalizeCandidates(values, maximum) {
  if (!Array.isArray(values)) fail("INVALID_PREFLIGHT_INPUT");
  const output = [], seenHandles = new Set();
  for (let index = 0; index < values.length && output.length < maximum; index += 1) {
    const source = values[index];
    if (!source || typeof source !== "object" || !("handle" in source) || seenHandles.has(source.handle)) continue;
    seenHandles.add(source.handle);
    const classified = classifyOperatorFamily(source.handle);
    const explicit = reviewedOperatorFamily(source.operatorFamily);
    const operatorFamily = explicit || (classified && classified.operatorFamily);
    const inventoryOrder = Number.isSafeInteger(source.inventoryOrder) && source.inventoryOrder >= 0 ? source.inventoryOrder : index;
    const capabilityRank = Number.isSafeInteger(source.capabilityRank) && source.capabilityRank >= 0
      ? source.capabilityRank : classified ? classified.capabilityRank : 1;
    output.push(Object.freeze({ source, handle: source.handle, operatorFamily: operatorFamily || null, inventoryOrder, capabilityRank }));
  }
  return output;
}

function distinctFamilies(rows) {
  return new Set(rows.map((row) => row.candidate.operatorFamily).filter(Boolean)).size;
}

function makeGuardedReader(candidate, pin, call, maximumCalls) {
  let calls = 0;
  const categories = new Set();
  const canonical = Object.freeze({ blockHash: pin.hash, requireCanonical: true });
  async function guarded(category, method, params, timeout) {
    if (calls >= maximumCalls) throw new PreflightError("NETWORK_CALL_CAP");
    calls += 1;
    categories.add(category);
    return call(candidate, method, params, timeout);
  }
  return Object.freeze({
    async getCode(address) {
      const result = await guarded("code", "eth_getCode", [address, canonical], 8000);
      if (typeof result !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(result)) throw new PreflightError("PROBE_CAPABILITY_UNAVAILABLE");
      return result;
    },
    async getStorageAt(address, slot) {
      const result = await guarded("storage", "eth_getStorageAt", [address, slot, canonical], 8000);
      if (typeof result !== "string" || !/^0x[0-9a-f]{64}$/i.test(result)) throw new PreflightError("PROBE_CAPABILITY_UNAVAILABLE");
      return result;
    },
    async call(transaction) {
      if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) throw new PreflightError("INVALID_PREFLIGHT_INPUT");
      const result = await guarded("call", "eth_call", [transaction, canonical], 10000);
      if (typeof result !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(result)) throw new PreflightError("PROBE_CAPABILITY_UNAVAILABLE");
      return result;
    },
    async getLogs(filter = {}) {
      if (!filter || typeof filter !== "object" || Array.isArray(filter)
          || Object.hasOwn(filter, "fromBlock") || Object.hasOwn(filter, "toBlock") || Object.hasOwn(filter, "blockHash")) {
        throw new PreflightError("INVALID_PREFLIGHT_INPUT");
      }
      const result = await guarded("logs", "eth_getLogs", [{ ...filter, blockHash: pin.hash }], 10000);
      if (!Array.isArray(result)) throw new PreflightError("PROBE_CAPABILITY_UNAVAILABLE");
      return result;
    },
    get calls() { return calls; },
    exercised(category) { return categories.has(category); }
  });
}

async function qualifyCommonFinalized(options = {}) {
  const logCanaryAddress = options.logCanaryAddress === undefined ? "0x0000000000000000000000000000000000000000" : options.logCanaryAddress;
  if (typeof logCanaryAddress !== "string" || !/^0x[0-9a-f]{40}$/i.test(logCanaryAddress)) fail("INVALID_PREFLIGHT_INPUT");
  const minimumFamilies = options.minimumFamilies === undefined ? 2 : options.minimumFamilies;
  const preferredFamilies = options.preferredFamilies === undefined ? 3 : options.preferredFamilies;
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...(options.limits || {}) });
  if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0 || !Number.isSafeInteger(minimumFamilies)
      || minimumFamilies < 2 || !Number.isSafeInteger(preferredFamilies) || preferredFamilies < minimumFamilies
      || limits.retries !== 0 || !Number.isSafeInteger(limits.maxCandidates) || limits.maxCandidates <= 0
      || !Number.isSafeInteger(limits.maxProbeCallsPerCandidate) || limits.maxProbeCallsPerCandidate < 4
      || !Number.isSafeInteger(limits.reserveRequests) || limits.reserveRequests < 0
      || typeof options.probe !== "function" || !options.rpc || typeof options.rpc.call !== "function"
      || !Number.isSafeInteger(options.rpc.maxNetworkCalls) || options.rpc.maxNetworkCalls <= limits.reserveRequests) {
    fail("INVALID_PREFLIGHT_INPUT");
  }
  const candidates = normalizeCandidates(options.candidates, limits.maxCandidates);
  const diagnostics = diagnosticsTemplate(candidates.length);
  const preflightCeiling = options.rpc.maxNetworkCalls - limits.reserveRequests;
  const startCalls = options.rpc.networkCalls;
  const remaining = () => preflightCeiling - options.rpc.networkCalls;
  const checkedCall = async (candidate, method, params, timeout) => {
    if (remaining() <= 0) fail("NETWORK_CALL_CAP", diagnostics);
    return options.rpc.call(candidate.handle, method, params, timeout);
  };
  const authoritativeFamilies = new Set(candidates.map((row) => row.operatorFamily).filter(Boolean));
  if (authoritativeFamilies.size < minimumFamilies) fail("TWO_FAMILIES_UNAVAILABLE", diagnostics);
  const probeReserve = preferredFamilies * limits.maxProbeCallsPerCandidate;

  const qualified = [], qualifiedFamilies = new Set();
  for (const candidate of candidates) {
    if (!candidate.operatorFamily) continue;
    if (remaining() <= probeReserve) fail("NETWORK_CALL_CAP", diagnostics);
    diagnostics.qualificationAttempts += 1;
    let chain;
    try { chain = await checkedCall(candidate, "eth_chainId", [], 3500); } catch (error) {
      if (error instanceof PreflightError && error.code === "NETWORK_CALL_CAP") throw error;
      continue;
    }
    if (parseQuantity(chain) !== BigInt(options.chainId)) continue;
    diagnostics.chainMatches += 1;
    let finalized;
    try { finalized = normalizeHeader(await checkedCall(candidate, "eth_getBlockByNumber", ["finalized", false], 6000)); } catch (error) {
      if (error instanceof PreflightError && error.code === "NETWORK_CALL_CAP") throw error;
      continue;
    }
    if (!finalized) continue;
    diagnostics.finalizedQualified += 1;
    qualified.push(Object.freeze({ candidate, finalized }));
    qualifiedFamilies.add(candidate.operatorFamily);
    if (qualifiedFamilies.size >= preferredFamilies) break;
  }
  if (qualifiedFamilies.size < minimumFamilies) fail("TWO_FAMILIES_UNAVAILABLE", diagnostics);

  let pin = null, pinRows = [];
  const heights = [...new Set(qualified.map((row) => row.finalized.number))].sort((a, b) => b - a);
  for (const number of heights) {
    const eligible = qualified.filter((row) => row.finalized.number >= number);
    if (distinctFamilies(eligible) < minimumFamilies) continue;
    const groups = new Map();
    for (const row of eligible) {
      if (remaining() <= probeReserve) fail("NETWORK_CALL_CAP", diagnostics);
      try {
        const current = normalizeHeader(await checkedCall(row.candidate, "eth_getBlockByNumber", [`0x${number.toString(16)}`, false], 6000));
        if (!current || current.number !== number) continue;
        const key = headerKey(current);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(Object.freeze({ candidate: row.candidate, header: current }));
      } catch (error) {
        if (error instanceof PreflightError && error.code === "NETWORK_CALL_CAP") throw error;
      }
    }
    const matching = [...groups.values()].filter((group) => distinctFamilies(group) >= minimumFamilies)
      .sort((a, b) => distinctFamilies(b) - distinctFamilies(a));
    diagnostics.pinConsensusFamilies = Math.max(
      diagnostics.pinConsensusFamilies,
      0,
      ...[...groups.values()].map((group) => distinctFamilies(group))
    );
    if (matching.length) {
      pinRows = matching[0];
      pin = pinRows[0].header;
      diagnostics.pinConsensusFamilies = distinctFamilies(pinRows);
      break;
    }
  }
  if (!pin) fail("PIN_CONSENSUS_UNAVAILABLE", diagnostics);

  if (remaining() < Math.min(preferredFamilies, pinRows.length) * limits.maxProbeCallsPerCandidate) fail("NETWORK_CALL_CAP", diagnostics);
  const observed = [], groups = new Map();
  for (const row of pinRows) {
    const bestFamilies = Math.max(0, ...[...groups.values()].map((group) => distinctFamilies(group)));
    if (bestFamilies >= preferredFamilies) break;
    const needed = Math.max(1, minimumFamilies - bestFamilies);
    if (remaining() < needed * limits.maxProbeCallsPerCandidate) fail("NETWORK_CALL_CAP", diagnostics);
    diagnostics.stateAttempts += 1;
    const reader = makeGuardedReader(row.candidate, pin, checkedCall, limits.maxProbeCallsPerCandidate);
    try {
      const observation = await options.probe(Object.freeze({ reader, candidate: row.candidate.source, pin }));
      const canary = await reader.getLogs({
        address: logCanaryAddress,
        topics: [`0x${"0".repeat(64)}`]
      });
      if (!Array.isArray(canary) || !["code", "storage", "call", "logs"].every((category) => reader.exercised(category))) continue;
      const key = stableObservation(observation);
      const member = Object.freeze({ candidate: row.candidate, observation, normalizedObservation: JSON.parse(key) });
      observed.push(member);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(member);
      diagnostics.stateSuccesses += 1;
    } catch (error) {
      if (error instanceof PreflightError && error.code === "NETWORK_CALL_CAP" && options.rpc.networkCalls >= preflightCeiling) {
        fail("NETWORK_CALL_CAP", diagnostics);
      }
    }
  }
  diagnostics.stateDistinctGroups = groups.size;
  diagnostics.stateConsensusFamilies = Math.max(0, ...[...groups.values()].map((group) => distinctFamilies(group)));
  const matchingStates = [...groups.values()].filter((group) => distinctFamilies(group) >= minimumFamilies)
    .sort((a, b) => distinctFamilies(b) - distinctFamilies(a));
  if (!matchingStates.length) fail("STATE_CONSENSUS_UNAVAILABLE", diagnostics, { pin });
  const winning = matchingStates[0];
  const selected = [], selectedFamilies = new Set();
  for (const member of winning) {
    const family = member.candidate.operatorFamily;
    if (selectedFamilies.has(family)) continue;
    selected.push(member);
    selectedFamilies.add(family);
    if (selected.length === preferredFamilies) break;
  }
  diagnostics.stateConsensusFamilies = selected.length;
  return Object.freeze({
    pin,
    selected: Object.freeze(selected),
    observations: Object.freeze(observed),
    diagnostics: Object.freeze({ ...diagnostics }),
    callsUsed: options.rpc.networkCalls - startCalls
  });
}

module.exports = Object.freeze({
  DEFAULT_LIMITS,
  REVIEWED_OPERATOR_FAMILY_IDS,
  REVIEWED_OPERATOR_FAMILY_SET,
  OPERATOR_SUFFIX_ALIASES,
  PreflightError,
  classifyOperatorFamily,
  reviewedOperatorFamily,
  normalizeHeader,
  normalizeObservation,
  stableObservation,
  createRpcLedger,
  qualifyCommonFinalized
});
