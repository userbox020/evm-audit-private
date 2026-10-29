#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { Interface } = require("./node_modules/ethers");
const {
  classifyOperatorFamily,
  reviewedOperatorFamily
} = require("./lib/common-finalized-rpc-preflight");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY_PATH = path.join(ROOT, "rpc_endpoints.txt");
const ADDRESS_BOOK_PATH = path.join(ROOT, "targets", "aave-address-book-6a0ac5a", "src", "AaveV3Ethereum.sol");
const ORIGIN_SOURCE_PATH = path.join(ROOT, "targets", "aave-v3-origin-v3.7-cff15de", "src", "contracts", "protocol", "libraries", "logic", "ConfiguratorLogic.sol");
const OUTPUT_DIRECTORY = path.join(ROOT, "reports", "monitor", "aave-v3-reserve-decimals-scan-runs");

const SOURCE_PINS = Object.freeze({
  originCommit: "cff15de6d1271b0c800fc001f4aea4c263e8a597",
  originTree: "b266dc6157f8c3632a0d41a51fd02a32c8a7a332",
  addressBookCommit: "6a0ac5a5e548d764488a2f95f26714ff9275de48",
  addressBookTree: "d876b6df157c1599eefefd913522f87fb97900f0"
});
const EXPECTED_SOURCE_SHA256 = Object.freeze({
  addressBook: "83ebdcc8bdbf655c6042b489370cfbc448f956e903b0af00ebc83fbf834c2e2b",
  configuratorLogic: "221fb8196a662db892cdc9b736b1ef448ac81357aaaf686681b17dfcf841d30d"
});
const LIMITS = Object.freeze({
  inventoryBytes: 1024 * 1024,
  addressBookBytes: 2 * 1024 * 1024,
  originSourceBytes: 256 * 1024,
  candidates: 16,
  reviewedFamilies: 8,
  qualifiedFamilies: 4,
  reserves: 64,
  rpcCalls: 512,
  responseBytes: 1024 * 1024,
  totalResponseBytes: 16 * 1024 * 1024,
  requestMs: 8000,
  wallMs: 120000,
  retries: 0,
  outputBytes: 256 * 1024
});
const ALLOWED_METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_call"]);
const CHAIN_ID = 1n;

const providerInterface = new Interface([
  "function getPool() view returns(address)",
  "function getPoolConfigurator() view returns(address)",
  "function getPriceOracle() view returns(address)",
  "function getPoolDataProvider() view returns(address)"
]);
const poolInterface = new Interface([
  "function getReservesList() view returns(address[])",
  "function getConfiguration(address asset) view returns(uint256 data)"
]);
const dataProviderInterface = new Interface([
  "function getReserveConfigurationData(address asset) view returns(uint256 decimals,uint256 ltv,uint256 liquidationThreshold,uint256 liquidationBonus,uint256 reserveFactor,bool usageAsCollateralEnabled,bool borrowingEnabled,bool stableBorrowRateEnabled,bool isActive,bool isFrozen)"
]);
const erc20Interface = new Interface(["function decimals() view returns(uint8)"]);

class ScanError extends Error {
  constructor(code) { super(code); this.name = "ScanError"; this.code = code; }
}
const fail = (code) => { throw new ScanError(code); };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("NONFINITE_NUMBER");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") fail("NONCANONICAL_VALUE");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};

function parseBootstrapLocator(source) {
  if (typeof source !== "string" || source.length > 2 * 1024 * 1024) fail("ADDRESS_BOOK_SOURCE_INVALID");
  const uncommented = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\r\n]*/gu, "");
  const expression = /IPoolAddressesProvider\s+internal\s+constant\s+POOL_ADDRESSES_PROVIDER\s*=\s*IPoolAddressesProvider\(\s*(0x[0-9a-fA-F]{40})\s*\)\s*;/gu;
  const matches = [...uncommented.matchAll(expression)];
  const declarations = uncommented.match(/\bPOOL_ADDRESSES_PROVIDER\b/gu) || [];
  if (declarations.length !== 1 || matches.length !== 1) fail(declarations.length > 1 || matches.length > 1 ? "BOOTSTRAP_LOCATOR_DUPLICATE" : "BOOTSTRAP_LOCATOR_NOT_FOUND");
  return matches[0][1].toLowerCase();
}

function parseInventory(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > LIMITS.inventoryBytes) fail("INVENTORY_SIZE_CAP");
  const records = bytes.toString("utf8").split(/(?:\r?\n){2,}/u), rows = [], seen = new Set(), secrets = new Set();
  let inventoryOrder = 0;
  for (const record of records) {
    const foundUrls = [...record.matchAll(/https:\/\/[^\s<'"`\])}]+/giu)].map((match) => match[0].replace(/[>,.;]+$/u, ""));
    const annotations = [...record.matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/giu)];
    const origins = [...record.matchAll(/\[origin:\s*([^\]\s]+)\]/giu)];
    if (foundUrls.length !== 1 || origins.length > 1) continue;
    {
      let url;
      try { url = new URL(foundUrls[0]); } catch (_) { continue; }
      if (url.protocol !== "https:" || url.username || url.password || url.hash) continue;
      const classified = classifyOperatorFamily(url.href);
      if (!classified || !reviewedOperatorFamily(classified.operatorFamily)) continue;
      const headers = {};
      let annotationValid = true;
      for (const item of annotations) {
        const key = item[1].trim().toLowerCase();
        if (Object.hasOwn(headers, key)) { annotationValid = false; break; }
        headers[key] = item[2].trim();
      }
      if (!annotationValid) continue;
      if (origins[0]) headers.origin = origins[0][1].trim();
      const duplicateKey = normalizedEndpointIdentity(url);
      if (seen.has(duplicateKey)) continue;
      seen.add(duplicateKey);
      for (const value of [url.href, url.hostname, ...url.pathname.split("/"), ...url.searchParams.values(), ...Object.values(headers)]) {
        if (String(value).length >= 8) secrets.add(String(value));
      }
      rows.push(Object.freeze({
        handle: Object.freeze({ url, headers: Object.freeze(headers) }),
        operatorFamily: classified.operatorFamily,
        capabilityRank: classified.capabilityRank,
        inventoryOrder: inventoryOrder++
      }));
    }
  }
  rows.sort((a, b) => a.capabilityRank - b.capabilityRank || a.inventoryOrder - b.inventoryOrder);
  return Object.freeze({ candidates: Object.freeze(rows.slice(0, LIMITS.candidates)), secretCorpus: Object.freeze([...secrets]) });
}

function normalizedEndpointIdentity(value) {
  const url = value instanceof URL ? new URL(value.href) : new URL(String(value));
  url.hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (url.port === "443") url.port = "";
  return url.href;
}

function quantity(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u.test(value)) fail("MALFORMED_QUANTITY");
  return BigInt(value);
}
function hash32(value, code) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(value)) fail(code);
  return value.toLowerCase();
}
function normalizeHeader(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("MALFORMED_HEADER");
  const number = quantity(raw.number), timestamp = quantity(raw.timestamp);
  if (number > BigInt(Number.MAX_SAFE_INTEGER)) fail("BLOCK_NUMBER_UNSAFE");
  return Object.freeze({
    number: Number(number),
    timestamp: timestamp.toString(),
    hash: hash32(raw.hash, "MALFORMED_BLOCK_HASH"),
    stateRoot: hash32(raw.stateRoot, "MALFORMED_STATE_ROOT")
  });
}
function validAddress(value) { return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value) && !/^0x0{40}$/u.test(value); }
function normalizeAddress(value) {
  const normalized = String(value).toLowerCase();
  if (!validAddress(normalized)) fail("MALFORMED_RUNTIME_BINDING");
  return normalized;
}

class Budget {
  constructor(now = Date.now) { this.now = now; this.started = now(); this.calls = 0; this.responseBytes = 0; this.fatalCode = null; }
  fatal(code) { if (!this.fatalCode) this.fatalCode = code; const error = new ScanError(this.fatalCode); error.fatalBudget = true; throw error; }
  before() {
    if (this.fatalCode) this.fatal(this.fatalCode);
    if (this.calls >= LIMITS.rpcCalls) this.fatal("RPC_CALL_CAP");
    if (this.now() - this.started > LIMITS.wallMs) this.fatal("WALL_CLOCK_CAP");
    this.calls += 1;
  }
  after(bytes) {
    if (this.fatalCode) this.fatal(this.fatalCode);
    if (!Number.isSafeInteger(bytes) || bytes < 0) this.fatal("RPC_WIRE_BYTES_INVALID");
    this.responseBytes += bytes;
    if (bytes > LIMITS.responseBytes) this.fatal("RPC_RESPONSE_CAP");
    if (this.responseBytes > LIMITS.totalResponseBytes) this.fatal("RPC_TOTAL_RESPONSE_CAP");
    if (this.now() - this.started > LIMITS.wallMs) this.fatal("WALL_CLOCK_CAP");
  }
  summary() {
    return Object.freeze({
      rpcCalls: this.calls,
      responseBytes: this.responseBytes,
      limits: Object.freeze({ rpcCalls: LIMITS.rpcCalls, totalResponseBytes: LIMITS.totalResponseBytes, wallMs: LIMITS.wallMs, retries: 0 }),
      withinBounds: this.fatalCode === null,
      fatalBudgetCode: this.fatalCode
    });
  }
}

function throwIfFatal(error) { if (error?.fatalBudget === true) throw error; }

async function rpc(candidate, method, params, transport, budget) {
  if (!ALLOWED_METHODS.has(method)) fail("RPC_METHOD_FORBIDDEN");
  budget.before();
  let response;
  try { response = await transport(candidate.handle, method, params, LIMITS.requestMs); }
  catch (error) {
    throwIfFatal(error);
    budget.after(error?.wireBytes);
    fail("RPC_CALL_FAILED");
  }
  budget.after(response?.wireBytes);
  if (!response || typeof response !== "object" || !Object.hasOwn(response, "result") || !Object.hasOwn(response, "wireBytes")) fail("TRANSPORT_RESPONSE_INVALID");
  return response.result;
}
async function exactHeader(candidate, number, transport, budget) {
  const header = normalizeHeader(await rpc(candidate, "eth_getBlockByNumber", [`0x${number.toString(16)}`, false], transport, budget));
  if (header.number !== number) fail("HEADER_NUMBER_MISMATCH");
  return header;
}
function sameHeader(a, b) { return a.number === b.number && a.hash === b.hash && a.stateRoot === b.stateRoot && a.timestamp === b.timestamp; }

function normalizedCandidates(candidates) {
  if (!Array.isArray(candidates)) fail("CANDIDATES_INVALID");
  const rows = [], seenEndpoints = new Set();
  for (let index = 0; index < candidates.length && rows.length < LIMITS.candidates; index += 1) {
    const row = candidates[index];
    if (!row || typeof row !== "object" || !("handle" in row)) continue;
    const rawUrl = row.handle instanceof URL || typeof row.handle === "string" ? row.handle : row.handle?.url;
    const classified = classifyOperatorFamily(rawUrl instanceof URL ? rawUrl.href : rawUrl);
    if (!classified || !reviewedOperatorFamily(classified.operatorFamily)) continue;
    if (row.operatorFamily !== undefined && reviewedOperatorFamily(row.operatorFamily) !== classified.operatorFamily) continue;
    let identity;
    try { identity = normalizedEndpointIdentity(rawUrl); } catch (_) { continue; }
    if (seenEndpoints.has(identity)) continue;
    seenEndpoints.add(identity);
    rows.push(Object.freeze({
      handle: row.handle,
      endpointIdentity: identity,
      operatorFamily: classified.operatorFamily,
      capabilityRank: classified.capabilityRank,
      inventoryOrder: Number.isSafeInteger(row.inventoryOrder) && row.inventoryOrder >= 0 ? row.inventoryOrder : index
    }));
  }
  rows.sort((a, b) => a.capabilityRank - b.capabilityRank || a.inventoryOrder - b.inventoryOrder);
  return rows;
}

async function qualify(candidates, transport, budget) {
  const rows = normalizedCandidates(candidates), qualified = [], attemptedFamilies = new Set();
  for (const candidate of rows) {
    if (attemptedFamilies.has(candidate.operatorFamily) || attemptedFamilies.size >= LIMITS.reviewedFamilies) continue;
    attemptedFamilies.add(candidate.operatorFamily);
    try {
      if (quantity(await rpc(candidate, "eth_chainId", [], transport, budget)) !== CHAIN_ID) continue;
      const finalized = normalizeHeader(await rpc(candidate, "eth_getBlockByNumber", ["finalized", false], transport, budget));
      qualified.push(Object.freeze({ candidate, finalized }));
      if (qualified.length >= LIMITS.qualifiedFamilies) break;
    } catch (error) {
      throwIfFatal(error);
    }
  }
  if (qualified.length < 2) fail("TWO_FAMILIES_UNAVAILABLE");
  for (let left = 0; left < qualified.length; left += 1) {
    for (let right = left + 1; right < qualified.length; right += 1) {
      if (qualified[left].candidate.operatorFamily === qualified[right].candidate.operatorFamily) continue;
      const number = Math.min(qualified[left].finalized.number, qualified[right].finalized.number);
      try {
        const headers = [];
        headers.push(await exactHeader(qualified[left].candidate, number, transport, budget));
        headers.push(await exactHeader(qualified[right].candidate, number, transport, budget));
        if (sameHeader(headers[0], headers[1])) return Object.freeze({ selected: [qualified[left].candidate, qualified[right].candidate], pin: headers[0], attemptedFamilies: attemptedFamilies.size, qualifiedFamilies: qualified.length });
      } catch (error) {
        throwIfFatal(error);
      }
    }
  }
  fail("COMMON_FINALIZED_PIN_UNAVAILABLE");
}

async function contractCall(candidate, target, iface, fragment, args, pin, transport, budget) {
  const data = iface.encodeFunctionData(fragment, args);
  const raw = await rpc(candidate, "eth_call", [{ to: target, data }, { blockHash: pin.hash, requireCanonical: true }], transport, budget);
  if (typeof raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(raw)) fail("MALFORMED_ETH_CALL_RESULT");
  try { return iface.decodeFunctionResult(fragment, raw); } catch (_) { fail("MALFORMED_ABI_RESULT"); }
}
async function readAddress(candidate, provider, method, pin, transport, budget) {
  const decoded = await contractCall(candidate, provider, providerInterface, method, [], pin, transport, budget);
  if (decoded.length !== 1) fail("RUNTIME_BINDING_ARITY");
  return normalizeAddress(decoded[0]);
}
async function readDecimalsCall(candidate, target, iface, method, args, pin, transport, budget) {
  const decoded = await contractCall(candidate, target, iface, method, args, pin, transport, budget);
  if (decoded.length < 1 || typeof decoded[0] !== "bigint" || decoded[0] < 0n || decoded[0] > 255n) fail("DECIMALS_RESULT_MALFORMED");
  return Number(decoded[0]);
}

function emptyCounts() {
  return { reserves: 0, pass: 0, risk: 0, incomplete: 0, storedLiveMismatch: 0, storedPackedMismatch: 0, outsideRange: 0 };
}
async function scanFamily(candidate, bootstrap, pin, transport, budget) {
  const bindings = {
    pool: await readAddress(candidate, bootstrap, "getPool", pin, transport, budget),
    configurator: await readAddress(candidate, bootstrap, "getPoolConfigurator", pin, transport, budget),
    oracle: await readAddress(candidate, bootstrap, "getPriceOracle", pin, transport, budget),
    dataProvider: await readAddress(candidate, bootstrap, "getPoolDataProvider", pin, transport, budget)
  };
  const decodedList = await contractCall(candidate, bindings.pool, poolInterface, "getReservesList", [], pin, transport, budget);
  if (decodedList.length !== 1 || !Array.isArray(decodedList[0]) || decodedList[0].length === 0 || decodedList[0].length > LIMITS.reserves) fail("RESERVE_LIST_MALFORMED_OR_CAPPED");
  const reserves = decodedList[0].map(normalizeAddress);
  if (new Set(reserves).size !== reserves.length) fail("DUPLICATE_RESERVE");
  const counts = emptyCounts(), processRows = [];
  counts.reserves = reserves.length;
  for (let index = 0; index < reserves.length; index += 1) {
    const reserve = reserves[index];
    let storedDecimals = null, liveDecimals = null, packedDecimals = null;
    const signals = [];
    try { storedDecimals = await readDecimalsCall(candidate, bindings.dataProvider, dataProviderInterface, "getReserveConfigurationData", [reserve], pin, transport, budget); }
    catch (error) { throwIfFatal(error); signals.push("STORED_DECIMALS_CALL_INCOMPLETE"); }
    try { liveDecimals = await readDecimalsCall(candidate, reserve, erc20Interface, "decimals", [], pin, transport, budget); }
    catch (error) { throwIfFatal(error); signals.push("LIVE_DECIMALS_CALL_INCOMPLETE"); }
    try {
      const packed = await contractCall(candidate, bindings.pool, poolInterface, "getConfiguration", [reserve], pin, transport, budget);
      if (packed.length !== 1 || typeof packed[0] !== "bigint") fail("PACKED_CONFIG_MALFORMED");
      packedDecimals = Number((packed[0] >> 48n) & 0xffn);
    } catch (error) { throwIfFatal(error); signals.push("PACKED_DECIMALS_CALL_INCOMPLETE"); }
    let rowStatus = "PASS";
    if (signals.length) rowStatus = "INCOMPLETE";
    else {
      if (storedDecimals !== liveDecimals) signals.push("STORED_LIVE_MISMATCH");
      if (storedDecimals !== packedDecimals) signals.push("STORED_PACKED_MISMATCH");
      if ([storedDecimals, liveDecimals, packedDecimals].some((value) => value < 6 || value > 77)) signals.push("DECIMALS_OUTSIDE_6_77");
      if (signals.length) rowStatus = "RISK";
    }
    if (rowStatus === "PASS") counts.pass += 1;
    else {
      counts[rowStatus === "RISK" ? "risk" : "incomplete"] += 1;
      if (signals.includes("STORED_LIVE_MISMATCH")) counts.storedLiveMismatch += 1;
      if (signals.includes("STORED_PACKED_MISMATCH")) counts.storedPackedMismatch += 1;
      if (signals.includes("DECIMALS_OUTSIDE_6_77")) counts.outsideRange += 1;
    }
    processRows.push(Object.freeze({ ordinal: index + 1, status: rowStatus, storedDecimals, liveDecimals, packedDecimals, signals: Object.freeze(signals.sort()) }));
  }
  return Object.freeze({
    processOnly: Object.freeze({ bindings, reserves, rows: Object.freeze(processRows) }),
    sanitized: Object.freeze({
      runtimeBindings: Object.freeze({ providerToPool: true, providerToConfigurator: true, providerToOracle: true, providerToDataProvider: true }),
      counts: Object.freeze(counts)
    })
  });
}

function safeDiagnostic(error, fallback) {
  return error instanceof ScanError && /^[A-Z0-9_]+$/u.test(error.code) ? error.code : fallback;
}
function makeReport(options, state) {
  const status = state.status;
  return {
    schema: "aave-v3-reserve-decimals-scan-r1/result-v1",
    generatedAt: options.generatedAt,
    status,
    evidenceScope: "SCANNER_EVIDENCE_ONLY_NOT_VULNERABILITY_OR_PROFIT_EVIDENCE",
    source: options.sourceCommitments,
    chain: { chainId: 1, finalizedBlock: { number: state.pin ? state.pin.number : null, timestamp: state.pin ? state.pin.timestamp : null } },
    qualification: {
      ordering: "capability-rank-then-inventory-order-never-alphabetical",
      reviewedIndependentFamiliesRequired: 2,
      twoIndependentFamilies: state.twoFamilies,
      commonFinalizedEip1898Pin: Boolean(state.pin),
      attemptedFamilies: state.attemptedFamilies,
      qualifiedFamilies: state.qualifiedFamilies
    },
    runtimeBindings: state.runtimeBindings,
    agreement: { sameBlock: state.sameBlock, sameSanitizedState: state.sameState, terminalHeaderRecheck: state.terminalRecheck },
    counts: state.counts,
    signals: {
      outsideRange: state.counts.outsideRange,
      storedLiveMismatch: state.counts.storedLiveMismatch,
      storedPackedMismatch: state.counts.storedPackedMismatch,
      incompleteReserveReads: state.counts.incomplete
    },
    diagnostics: state.diagnostics,
    budget: state.budget,
    safety: {
      readOnly: true,
      inventoryRead: "rpc_endpoints.txt",
      inventoryProcessOnly: true,
      endpointMaterialPersisted: false,
      endpointMaterialHashed: false,
      rawResponsesPersisted: false,
      calldataPersisted: false,
      addressesPersisted: false,
      blockHashesPersisted: false,
      stateRootsPersisted: false,
      environmentFilesRead: false,
      keyFilesRead: false,
      childProcesses: false,
      retries: 0,
      transactions: false,
      signing: false,
      broadcast: false,
      automaticPromotion: false
    },
    gates: { automaticPromotion: false, routePositive: "unknown", executableNow: "unknown", signedActionJustified: false },
    limitations: [
      "A signal is scanner evidence only and is not vulnerability, deployment-exploitability, or profit evidence.",
      "Only current reserves returned by the dynamically bound Pool at the common finalized pin are covered.",
      "Any failed or malformed decimals read makes the result INCOMPLETE."
    ]
  };
}

function validateSourceCommitments(value) {
  if (!value || typeof value !== "object"
      || value.origin?.commit !== SOURCE_PINS.originCommit
      || value.origin?.tree !== SOURCE_PINS.originTree
      || value.origin?.configuratorLogicSha256 !== EXPECTED_SOURCE_SHA256.configuratorLogic
      || value.addressBook?.commit !== SOURCE_PINS.addressBookCommit
      || value.addressBook?.tree !== SOURCE_PINS.addressBookTree
      || value.addressBook?.aaveV3EthereumSha256 !== EXPECTED_SOURCE_SHA256.addressBook) fail("SOURCE_COMMITMENTS_UNAUTHORIZED");
  return value;
}

async function runScanner(options = {}) {
  if (typeof options.transport !== "function" || !validAddress(options.bootstrapLocator)
      || !options.sourceCommitments || typeof options.sourceCommitments !== "object") fail("ENGINE_INPUT_INVALID");
  validateSourceCommitments(options.sourceCommitments);
  const generatedAt = options.generatedAt || new Date().toISOString(), now = options.now || Date.now;
  if (Number.isNaN(Date.parse(generatedAt))) fail("GENERATED_AT_INVALID");
  const budget = new Budget(now);
  const base = {
    pin: null, twoFamilies: false, sameBlock: false, sameState: false, terminalRecheck: false,
    attemptedFamilies: 0, qualifiedFamilies: 0,
    runtimeBindings: { providerToPool: false, providerToConfigurator: false, providerToOracle: false, providerToDataProvider: false },
    counts: emptyCounts(), diagnostics: []
  };
  let qualification;
  try { qualification = await qualify(options.candidates, options.transport, budget); }
  catch (error) {
    base.diagnostics.push(safeDiagnostic(error, "QUALIFICATION_INCOMPLETE"));
    base.budget = budget.summary();
    const report = makeReport({ generatedAt, sourceCommitments: options.sourceCommitments }, { ...base, status: "INCOMPLETE" });
    assertSanitized(report, options.secretCorpus || []);
    return report;
  }
  Object.assign(base, {
    pin: qualification.pin,
    twoFamilies: true,
    sameBlock: true,
    attemptedFamilies: qualification.attemptedFamilies,
    qualifiedFamilies: qualification.qualifiedFamilies
  });
  const states = [];
  for (const candidate of qualification.selected) {
    try { states.push(await scanFamily(candidate, options.bootstrapLocator, qualification.pin, options.transport, budget)); }
    catch (error) {
      if (error?.fatalBudget === true) {
        base.diagnostics.push(error.code);
        states.push(null);
        break;
      }
      states.push(null);
    }
  }
  if (states.length !== qualification.selected.length || states.some((value) => value === null)) {
    if (!base.diagnostics.length) base.diagnostics.push("ONE_OR_MORE_FAMILY_STATE_READS_INCOMPLETE");
  }
  else {
    const rawAgreed = canonical(states[0].processOnly) === canonical(states[1].processOnly);
    const sanitizedAgreed = canonical(states[0].sanitized) === canonical(states[1].sanitized);
    base.sameState = rawAgreed && sanitizedAgreed;
    if (!base.sameState) base.diagnostics.push("CROSS_FAMILY_STATE_DISAGREEMENT");
    else {
      base.runtimeBindings = states[0].sanitized.runtimeBindings;
      base.counts = states[0].sanitized.counts;
    }
  }
  if (base.sameState) {
    try {
      const terminal = [];
      for (const candidate of qualification.selected) terminal.push(await exactHeader(candidate, qualification.pin.number, options.transport, budget));
      base.terminalRecheck = terminal.every((header) => sameHeader(header, qualification.pin));
    } catch (error) {
      base.terminalRecheck = false;
      if (error?.fatalBudget === true) base.diagnostics.push(error.code);
    }
    if (!base.terminalRecheck) base.diagnostics.push("TERMINAL_HEADER_RECHECK_FAILED");
  }
  const incomplete = base.diagnostics.length > 0 || base.counts.incomplete > 0;
  const status = incomplete ? "INCOMPLETE" : base.counts.risk > 0 ? "RISK_SIGNAL" : "PASS_NO_DECIMALS_RISK";
  base.budget = budget.summary();
  const report = makeReport({ generatedAt, sourceCommitments: options.sourceCommitments }, { ...base, status });
  assertSanitized(report, options.secretCorpus || []);
  return report;
}

const FORBIDDEN_KEYS = /^(?:endpoint|endpoints|endpointValue|hostname|domain|headers?|credentials?|authorization|apiKey|token|secret|password|providerLabel|operatorFamily|operatorFamilyLabel|rawResponse|rawResponses|rawRpc|calldata|address|addresses|transactionHash|txHash|blockHash|stateRoot|ordinal|row|rows|tuple|tuples)$/iu;
function assertSanitized(value, secretCorpus = []) {
  const seen = new Set();
  function visit(current) {
    if (typeof current === "string") {
      if (/(?:https?|wss?):\/\//iu.test(current)) fail("SANITIZER_URL_REJECTED");
      if (/^0x[0-9a-fA-F]{40}$/u.test(current)) fail("SANITIZER_ADDRESS_REJECTED");
      if (/\b(?:[a-z0-9-]+\.)+(?:com|io|org|net|pro|xyz|cloud|dev)\b/iu.test(current)) fail("SANITIZER_DOMAIN_REJECTED");
      if (/^(?:Bearer|Basic)\s+/iu.test(current)) fail("SANITIZER_CREDENTIAL_REJECTED");
      for (const secret of secretCorpus) if (String(secret) && current.toLowerCase().includes(String(secret).toLowerCase())) fail("SANITIZER_INVENTORY_MATERIAL_REJECTED");
      return;
    }
    if (current === null || typeof current === "boolean" || typeof current === "number") return;
    if (!current || typeof current !== "object" || seen.has(current)) fail("SANITIZER_VALUE_REJECTED");
    seen.add(current);
    if (Array.isArray(current)) for (const item of current) visit(item);
    else for (const [key, item] of Object.entries(current)) {
      if (FORBIDDEN_KEYS.test(key)) fail(`SANITIZER_FORBIDDEN_KEY_${key.toUpperCase()}`);
      visit(item);
    }
    seen.delete(current);
  }
  visit(value);
  return true;
}

function publishNoOverwrite(file, bytes, fsImpl = fs, randomBytes = crypto.randomBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > LIMITS.outputBytes) fail("OUTPUT_SIZE_CAP");
  const parent = path.dirname(file);
  if (!fsImpl.existsSync(parent)) fail("OUTPUT_PARENT_MISSING");
  const temporary = path.join(parent, `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    fsImpl.writeFileSync(temporary, bytes, { flag: "wx" });
    fsImpl.linkSync(temporary, file);
  } catch (error) {
    if (error && error.code === "EEXIST") fail("OUTPUT_ALREADY_EXISTS");
    throw error;
  } finally {
    try { fsImpl.unlinkSync(temporary); } catch (_) {}
  }
  return file;
}

function createHttpsTransport(httpsImpl = https) {
  let nextId = 1;
  return (handle, method, params, timeoutMs) => new Promise((resolve, reject) => {
    if (!handle || !(handle.url instanceof URL) || !handle.headers || !ALLOWED_METHODS.has(method)) {
      const error = new ScanError("TRANSPORT_INPUT_INVALID"); error.wireBytes = 0; return reject(error);
    }
    const requestId = nextId++;
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
    let settled = false, request, size = 0;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { request?.destroy(); } catch (_) {}
      error ? reject(error) : resolve(value);
    };
    const withWireBytes = (code) => { const error = new ScanError(code); error.wireBytes = size; return error; };
    const timer = setTimeout(() => finish(withWireBytes("TRANSPORT_TIMEOUT")), timeoutMs);
    try {
      request = httpsImpl.request({
        protocol: "https:", hostname: handle.url.hostname, port: handle.url.port || 443,
        path: `${handle.url.pathname}${handle.url.search}`, method: "POST", agent: false,
        headers: { ...handle.headers, "content-type": "application/json", accept: "application/json", "accept-encoding": "identity", "content-length": body.length }
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > LIMITS.responseBytes) {
            finish(withWireBytes("TRANSPORT_RESPONSE_CAP"));
          }
          else chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          if (settled) return;
          if (response.statusCode !== 200) return finish(withWireBytes("TRANSPORT_HTTP_STATUS"));
          try {
            return finish(null, decodeJsonRpcEnvelope(Buffer.concat(chunks), requestId));
          } catch (error) {
            const translated = error instanceof ScanError ? error : new ScanError("TRANSPORT_JSON_INVALID");
            translated.wireBytes = size;
            return finish(translated);
          }
        });
        response.on("aborted", () => finish(withWireBytes("TRANSPORT_PARTIAL_RESPONSE")));
        response.on("error", () => finish(withWireBytes("TRANSPORT_PARTIAL_RESPONSE")));
      });
      request.on("error", () => finish(withWireBytes(size > 0 ? "TRANSPORT_PARTIAL_RESPONSE" : "TRANSPORT_ERROR")));
      request.end(body);
    } catch (_) { finish(withWireBytes("TRANSPORT_ERROR")); }
  });
}

function decodeJsonRpcEnvelope(bytes, expectedId) {
  if (!Buffer.isBuffer(bytes)) fail("TRANSPORT_WIRE_INVALID");
  if (bytes.length > LIMITS.responseBytes) fail("TRANSPORT_RESPONSE_CAP");
  let envelope;
  try { envelope = JSON.parse(bytes.toString("utf8")); } catch (_) { fail("TRANSPORT_JSON_INVALID"); }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) fail("TRANSPORT_ENVELOPE_INVALID");
  if (envelope.jsonrpc !== "2.0") fail("TRANSPORT_JSONRPC_VERSION_INVALID");
  if (!Object.hasOwn(envelope, "id") || envelope.id !== expectedId) fail("TRANSPORT_ID_MISMATCH");
  if (Object.hasOwn(envelope, "error")) fail("TRANSPORT_RPC_ERROR");
  if (!Object.hasOwn(envelope, "result")) fail("TRANSPORT_RESULT_MISSING");
  return Object.freeze({ result: envelope.result, wireBytes: bytes.length });
}

function readBoundedFile(file, maximum, code, fsImpl = fs) {
  let descriptor;
  try {
    descriptor = fsImpl.openSync(file, "r");
    const before = fsImpl.fstatSync(descriptor, { bigint: true });
    const beforeSize = typeof before?.size === "bigint" ? before.size : BigInt(before?.size);
    if (!before || !before.isFile() || beforeSize < 0n || beforeSize > BigInt(maximum) || beforeSize > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${code}_SIZE_CAP`);
    const expectedSize = Number(beforeSize), capacity = Math.min(maximum + 1, expectedSize + 1);
    const buffer = Buffer.alloc(capacity);
    const bytesRead = fsImpl.readSync(descriptor, buffer, 0, capacity, 0);
    const after = fsImpl.fstatSync(descriptor, { bigint: true });
    const afterSize = typeof after?.size === "bigint" ? after.size : BigInt(after?.size);
    const identity = (stat) => [stat.dev, stat.ino, stat.mtimeNs ?? stat.mtimeMs, stat.ctimeNs ?? stat.ctimeMs].map(String).join(":");
    if (!after || !after.isFile() || !Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > maximum
        || bytesRead !== expectedSize || afterSize !== beforeSize || identity(after) !== identity(before)) fail(`${code}_READ_CHANGED_OR_TRUNCATED`);
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    if (error instanceof ScanError) throw error;
    fail(`${code}_READ_FAILED`);
  } finally {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch (_) {}
    }
  }
}

function verifySourceAuthority(addressBookBytes, originBytes) {
  if (!Buffer.isBuffer(addressBookBytes) || sha256(addressBookBytes) !== EXPECTED_SOURCE_SHA256.addressBook) fail("ADDRESS_BOOK_AUTHORITY_MISMATCH");
  if (!Buffer.isBuffer(originBytes) || sha256(originBytes) !== EXPECTED_SOURCE_SHA256.configuratorLogic) fail("ORIGIN_SOURCE_AUTHORITY_MISMATCH");
  const bootstrapLocator = parseBootstrapLocator(addressBookBytes.toString("utf8"));
  return Object.freeze({ bootstrapLocator, commitments: sourceCommitments(addressBookBytes, originBytes) });
}

function sourceCommitments(addressBookBytes, originBytes) {
  return Object.freeze({
    origin: Object.freeze({ commit: SOURCE_PINS.originCommit, tree: SOURCE_PINS.originTree, configuratorLogicSha256: sha256(originBytes) }),
    addressBook: Object.freeze({ commit: SOURCE_PINS.addressBookCommit, tree: SOURCE_PINS.addressBookTree, aaveV3EthereumSha256: sha256(addressBookBytes) })
  });
}

function loadAuthorizedInputs(fsImpl = fs) {
  const addressBookBytes = readBoundedFile(ADDRESS_BOOK_PATH, LIMITS.addressBookBytes, "ADDRESS_BOOK", fsImpl);
  const originBytes = readBoundedFile(ORIGIN_SOURCE_PATH, LIMITS.originSourceBytes, "ORIGIN_SOURCE", fsImpl);
  const authority = verifySourceAuthority(addressBookBytes, originBytes);
  const inventoryBytes = readBoundedFile(INVENTORY_PATH, LIMITS.inventoryBytes, "INVENTORY", fsImpl);
  const inventory = parseInventory(inventoryBytes);
  if (new Set(inventory.candidates.map((row) => row.operatorFamily)).size < 2) fail("TWO_FAMILIES_UNAVAILABLE");
  return Object.freeze({ authority, inventory });
}

async function runProduction(dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  // Source authority is established before the protected inventory is statted or read.
  const { authority, inventory } = loadAuthorizedInputs(fsImpl);
  const report = await runScanner({
    candidates: inventory.candidates,
    secretCorpus: inventory.secretCorpus,
    bootstrapLocator: authority.bootstrapLocator,
    sourceCommitments: authority.commitments,
    transport: dependencies.transport || createHttpsTransport(),
    generatedAt: dependencies.generatedAt
  });
  assertSanitized(report, inventory.secretCorpus);
  fsImpl.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
  const suffix = report.chain.finalizedBlock.number === null ? "unavailable" : String(report.chain.finalizedBlock.number);
  const output = path.join(OUTPUT_DIRECTORY, `scan-r1-block-${suffix}.json`);
  publishNoOverwrite(output, Buffer.from(`${JSON.stringify(report, null, 2)}\n`), fsImpl);
  return report;
}

async function runCli(options = {}) {
  const argv = options.argv || process.argv, env = options.env || process.env;
  const stdout = options.stdout || process.stdout, stderr = options.stderr || process.stderr;
  if (!Array.isArray(argv) || argv.length !== 2) {
    stderr.write(`${JSON.stringify({ status: "INCOMPLETE", code: "CLI_ARGUMENTS_FORBIDDEN" })}\n`);
    return 1;
  }
  if (env.AAVE_RESERVE_DECIMALS_SCAN_R1 !== "1") {
    stdout.write(`${JSON.stringify({ status: "CLI_DISABLED", optInRequired: true })}\n`);
    return 0;
  }
  try {
    const report = await (options.runProduction || runProduction)(options.dependencies);
    stdout.write(`${JSON.stringify({ status: report.status, finalizedBlockNumber: report.chain.finalizedBlock.number, counts: report.counts, signals: report.signals })}\n`);
    return report.status === "INCOMPLETE" ? 1 : 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({ status: "INCOMPLETE", code: safeDiagnostic(error, "UNEXPECTED_FAILURE") })}\n`);
    return 1;
  }
}

module.exports = Object.freeze({
  SOURCE_PINS,
  EXPECTED_SOURCE_SHA256,
  LIMITS,
  interfaces: Object.freeze({ providerInterface, poolInterface, dataProviderInterface, erc20Interface }),
  ScanError,
  canonical,
  parseBootstrapLocator,
  parseInventory,
  normalizedEndpointIdentity,
  normalizeHeader,
  runScanner,
  assertSanitized,
  publishNoOverwrite,
  createHttpsTransport,
  decodeJsonRpcEnvelope,
  readBoundedFile,
  verifySourceAuthority,
  validateSourceCommitments,
  sourceCommitments,
  loadAuthorizedInputs,
  runProduction,
  runCli
});

if (require.main === module) void runCli().then((code) => { process.exitCode = code; });
