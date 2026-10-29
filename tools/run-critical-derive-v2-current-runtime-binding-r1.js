#!/usr/bin/env node
"use strict";

// Narrow, defensive, read-only Derive Chain runtime/topology capture. Endpoint
// inventory material and RPC replies remain process-only and are never emitted.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { id, keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY_PATH = path.join(ROOT, "rpc_endpoints.txt");
const SCHEMA = "critical-derive-v2-current-runtime-binding-r1/v1";
const CHAIN_ID = 957n;
const MAX_CANDIDATES = 12;
const MAX_RPC_REQUESTS = 96;
const MAX_TIMEOUT_MS = 12_000;
const MAX_INVENTORY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;

const EIP1967_SLOTS = Object.freeze({
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
});

const ADDRESSES = Object.freeze({
  cash: "0x57b03e14d409adc7fab6cfc44b5886cad2d5f02b",
  srm: "0x28c9ddf9a3b29c2e6a561c1bc520954e5a33de5d",
  perpSettlementHelper: "0xbd282333710b9c7e33e8a37d027885a7c079ae23",
  ethPerp: "0xaf65752c4643e25c02f693f9d4fe19cf23a095e3",
  pmrm2Proxy: "0xc755dae3fd295a687adf3e192387163f813f0598",
  pmrm2ManifestImplementation: "0xae5faba2b6d13f3b80de855a7f921ba2dda7b5c5",
  pmrm2ManifestAdmin: "0x6ecce6823743c5f40505db287bb77190e83b0916",
  subAccounts: "0xe7603df191d699d8bd9891b821347dbab889e5a5",
  rateModel: "0x989656625954b5359b4095c34ac8532a7fed4899",
});

const SOURCE = Object.freeze({
  repositoryPath: "targets/derive-v2-core",
  commit: "96796a61dcb1dc852e25518b00cc1a79fb3caeeb",
  manifests: Object.freeze([
    "deployments/957/core.json",
    "deployments/957/ETH.json",
    "deployments/957/ETH_2.json",
    "deployments/957/shared.json",
  ]),
  settlementSignature: "settlePerpsWithIndex(uint256)",
  settlementSelector: "0x5d935799",
});

const ALLOWED_RPC_METHODS = Object.freeze([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_call",
]);
const ALLOWED_RPC = new Set(ALLOWED_RPC_METHODS);

const SIGNATURES = Object.freeze({
  subAccounts: "subAccounts()",
  cashAsset: "cashAsset()",
  perp: "perp()",
  rateModel: "rateModel()",
  whitelistedManager: "whitelistedManager(address)",
  adjustmentsPaused: "adjustmentsPaused()",
  borrowingEnabled: "borrowingEnabled()",
  isDisabled: "isDisabled()",
  totalSupply: "totalSupply()",
  totalBorrow: "totalBorrow()",
  netSettledCash: "netSettledCash()",
  lastTimestamp: "lastTimestamp()",
  assetMap: "assetMap(uint256,uint8)",
  lastMarketId: "lastMarketId()",
  assetDetails: "assetDetails(address)",
});
const SELECTORS = Object.freeze(Object.fromEntries(
  Object.entries(SIGNATURES).map(([name, signature]) => [name, id(signature).slice(0, 10).toLowerCase()]),
));
if (id(SOURCE.settlementSignature).slice(0, 10).toLowerCase() !== SOURCE.settlementSelector) {
  throw new Error("SOURCE_SELECTOR_PIN_INVALID");
}

class CaptureError extends Error {
  constructor(code) {
    super(code);
    this.name = "CaptureError";
    this.code = code;
  }
}
function fail(code) { throw new CaptureError(code); }
function sha256(bytes) { return `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`; }
function strictHex(value, bytes = null) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) fail("MALFORMED_HEX");
  const normalized = value.toLowerCase();
  if (bytes !== null && normalized.length !== 2 + bytes * 2) fail("MALFORMED_HEX_LENGTH");
  return normalized;
}
function strictAddress(value) { return strictHex(value, 20); }
function strictQuantity(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) fail("MALFORMED_QUANTITY");
  return BigInt(value);
}
function parseHeader(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MALFORMED_HEADER");
  return { number: strictQuantity(value.number), hash: strictHex(value.hash, 32) };
}
function addressWord(address) { return address.slice(2).padStart(64, "0"); }
function uintWord(value) {
  const bigint = BigInt(value);
  if (bigint < 0n || bigint >= 1n << 256n) fail("ABI_UINT_OUT_OF_RANGE");
  return bigint.toString(16).padStart(64, "0");
}
function callData(selector, words = []) { return `${selector}${words.join("")}`; }
function decodeWords(value, expected) {
  const hex = strictHex(value);
  if (hex.length !== 2 + expected * 64) fail("MALFORMED_ABI_RESULT");
  return Array.from({ length: expected }, (_, index) => hex.slice(2 + index * 64, 2 + (index + 1) * 64));
}
function decodeAddress(value) {
  const [word] = decodeWords(value, 1);
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) fail("MALFORMED_ADDRESS_RESULT");
  return `0x${word.slice(24)}`;
}
function decodeBool(value) {
  const [word] = decodeWords(value, 1);
  const decoded = BigInt(`0x${word}`);
  if (decoded !== 0n && decoded !== 1n) fail("MALFORMED_BOOL_RESULT");
  return decoded === 1n;
}
function decodeUint(value) { return BigInt(`0x${decodeWords(value, 1)[0]}`).toString(); }
function decodeInt(value) {
  let decoded = BigInt(`0x${decodeWords(value, 1)[0]}`);
  if (decoded >= 1n << 255n) decoded -= 1n << 256n;
  return decoded.toString();
}
function decodeAssetDetails(value) {
  const words = decodeWords(value, 3);
  const flag = BigInt(`0x${words[0]}`), assetType = BigInt(`0x${words[1]}`), marketId = BigInt(`0x${words[2]}`);
  if (flag > 1n || assetType > 255n) fail("MALFORMED_ASSET_DETAILS");
  return { isWhitelisted: flag === 1n, assetType: Number(assetType), marketId: marketId.toString() };
}

function familyLabel(endpoint) {
  let parsed;
  try { parsed = new URL(endpoint); } catch (_) { fail("INVENTORY_ENDPOINT_MALFORMED"); }
  const host = parsed.hostname.toLowerCase();
  if (!host) fail("INVENTORY_ENDPOINT_MALFORMED");
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join(".") : host;
}
function parseContextHeaders(context) {
  const headers = {};
  const origin = context.match(/\[origin:\s*([^\]\s]+)\]/i)?.[1];
  if (origin) headers.origin = origin;
  for (const match of context.matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/gi)) {
    headers[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return headers;
}
function parseInventorySafely(input, options = {}) {
  const maxCandidates = options.maxCandidates ?? MAX_CANDIDATES;
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 2 || maxCandidates > MAX_CANDIDATES) fail("CANDIDATE_CAP_INVALID");
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  if (bytes.length > MAX_INVENTORY_BYTES) fail("INVENTORY_SIZE_CAP");
  const text = bytes.toString("utf8").replace(/\\\//g, "/");
  if (text.includes("\0")) fail("INVENTORY_NUL");
  const separator = ":" + "/" + "/";
  const expression = new RegExp(`(?:https?)${separator.replaceAll("/", "\\/")}[^\\s\"'\\x60<>{}\\[\\]]+`, "gi");
  const containsEndpoint = new RegExp(`(?:https?)${separator.replaceAll("/", "\\/")}`, "i");
  const lines = text.split(/\r?\n/);
  const rows = new Map();
  for (let index = 0; index < lines.length; index++) {
    for (const match of lines[index].matchAll(expression)) {
      const raw = match[0].replace(/[)>`,.;\]]+$/g, "");
      let parsed;
      try { parsed = new URL(raw); } catch (_) { continue; }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      const endpoint = parsed.href;
      if (rows.has(endpoint)) continue;
      const contextLines = [lines[index]];
      for (let distance = 1; distance <= 3 && index - distance >= 0; distance++) {
        const previous = lines[index - distance];
        if (!previous.trim() || containsEndpoint.test(previous)) break;
        contextLines.unshift(previous);
      }
      const context = contextLines.join("\n");
      const lower = context.toLowerCase();
      rows.set(endpoint, {
        endpoint,
        headers: parseContextHeaders(context),
        familyLabel: familyLabel(endpoint),
        priority: (lower.includes("derive") ? 2 : 0) + (/(?:^|\D)957(?:\D|$)/.test(lower) ? 2 : 0),
        inventoryOrdinal: rows.size,
      });
    }
  }
  const candidates = [...rows.values()]
    .sort((a, b) => b.priority - a.priority || a.inventoryOrdinal - b.inventoryOrdinal)
    .slice(0, maxCandidates)
    .map(({ priority: _priority, inventoryOrdinal: _ordinal, ...row }) => row);
  if (candidates.length < 2) fail("INCOMPLETE_CANDIDATE_POOL");
  return candidates;
}

function readInventoryFileSafely(filePath = INVENTORY_PATH, fsImpl = fs) {
  if (path.resolve(filePath) !== INVENTORY_PATH) fail("INVENTORY_PATH_FORBIDDEN");
  let stat;
  try { stat = fsImpl.lstatSync(filePath); } catch (_) { fail("INVENTORY_READ_FAILED"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INVENTORY_BYTES) fail("INVENTORY_FILE_INVALID");
  let bytes;
  try { bytes = fsImpl.readFileSync(filePath); } catch (_) { fail("INVENTORY_READ_FAILED"); }
  if (!Buffer.isBuffer(bytes) || bytes.length !== stat.size || bytes.length > MAX_INVENTORY_BYTES) fail("INVENTORY_FILE_CHANGED");
  return bytes;
}

async function defaultTransport(candidate, request, options = {}) {
  const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) fail("TIMEOUT_CAP_INVALID");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(candidate.endpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...candidate.headers },
      body: JSON.stringify(request),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) fail("TRANSPORT_STATUS_REJECTED");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) fail("RPC_RESPONSE_SIZE_CAP");
    return bytes;
  } catch (error) {
    if (error instanceof CaptureError) throw error;
    fail(error?.name === "AbortError" ? "RPC_TIMEOUT" : "TRANSPORT_FAILURE");
  } finally {
    clearTimeout(timer);
  }
}

function createRpcClient(options = {}) {
  const transport = options.transport || defaultTransport;
  const maxRequests = options.maxRequests ?? MAX_RPC_REQUESTS;
  const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > MAX_RPC_REQUESTS) fail("RPC_BUDGET_INVALID");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) fail("TIMEOUT_CAP_INVALID");
  const state = { requests: 0, methodCounts: {}, nextId: 1, retries: 0 };
  async function request(candidate, method, params) {
    if (!ALLOWED_RPC.has(method)) fail("RPC_METHOD_FORBIDDEN");
    if (++state.requests > maxRequests) fail("RPC_BUDGET_EXCEEDED");
    state.methodCounts[method] = (state.methodCounts[method] || 0) + 1;
    const envelope = { jsonrpc: "2.0", id: state.nextId++, method, params };
    let raw;
    try { raw = await transport(candidate, envelope, { timeoutMs }); }
    catch (error) { if (error instanceof CaptureError) throw error; fail("TRANSPORT_FAILURE"); }
    if (Buffer.isBuffer(raw)) {
      if (raw.length > MAX_RESPONSE_BYTES) fail("RPC_RESPONSE_SIZE_CAP");
      try { raw = JSON.parse(raw.toString("utf8")); } catch (_) { fail("RPC_RESPONSE_MALFORMED"); }
    } else if (typeof raw === "string") {
      if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) fail("RPC_RESPONSE_SIZE_CAP");
      try { raw = JSON.parse(raw); } catch (_) { fail("RPC_RESPONSE_MALFORMED"); }
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.jsonrpc !== "2.0" || raw.id !== envelope.id) fail("RPC_RESPONSE_MALFORMED");
    if (Object.hasOwn(raw, "error")) fail("RPC_REMOTE_ERROR");
    if (!Object.hasOwn(raw, "result")) fail("RPC_RESPONSE_MALFORMED");
    return raw.result;
  }
  return { request, state };
}

function assertFixedPinAgreement(qualified) {
  if (!Array.isArray(qualified) || qualified.length < 2) fail("INCOMPLETE_INDEPENDENT_FAMILIES");
  const first = qualified[0];
  if (new Set(qualified.map((row) => row.familyLabel)).size < 2) fail("INCOMPLETE_INDEPENDENT_FAMILIES");
  for (const row of qualified.slice(1)) {
    if (row.header.number !== first.header.number || row.header.hash !== first.header.hash) fail("FINALIZED_PIN_MISMATCH");
  }
  return { number: first.header.number, hash: first.header.hash };
}

function selectQualifiedFamilies(qualified) {
  const groups = new Map();
  for (const row of qualified) {
    const key = `${row.header.number.toString()}:${row.header.hash}`;
    if (!groups.has(key)) groups.set(key, []);
    const group = groups.get(key);
    if (!group.some((candidate) => candidate.familyLabel === row.familyLabel)) group.push(row);
  }
  const eligible = [...groups.values()].filter((group) => group.length >= 2);
  if (eligible.length !== 1) fail(eligible.length ? "FINALIZED_PIN_AMBIGUOUS" : "INCOMPLETE_INDEPENDENT_FAMILIES");
  const selected = eligible[0].slice(0, 2);
  assertFixedPinAgreement(selected);
  return selected;
}

async function qualifyAndSelect(candidates, rpc) {
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > MAX_CANDIDATES) fail("CANDIDATE_POOL_INVALID");
  const qualified = [];
  const classifications = {};
  function classify(name) { classifications[name] = (classifications[name] || 0) + 1; }
  for (const candidate of candidates) {
    try {
      const chain = strictQuantity(await rpc.request(candidate, "eth_chainId", []));
      if (chain !== CHAIN_ID) { classify("CHAIN_MISMATCH"); continue; }
      const header = parseHeader(await rpc.request(candidate, "eth_getBlockByNumber", ["finalized", false]));
      qualified.push({ candidate, familyLabel: candidate.familyLabel, header });
      classify("QUALIFIED");
    } catch (error) {
      classify(error instanceof CaptureError ? error.code : "TRANSPORT_FAILURE");
    }
  }
  const selected = selectQualifiedFamilies(qualified);
  return { selected, qualifiedCount: qualified.length, classifications };
}

function opaqueFamilyCommitments(candidates, selected) {
  const labels = [];
  for (const candidate of candidates) if (!labels.includes(candidate.familyLabel)) labels.push(candidate.familyLabel);
  return selected.map((row) => {
    const ordinal = labels.indexOf(row.familyLabel) + 1;
    if (!ordinal) fail("FAMILY_COMMITMENT_INTERNAL_ERROR");
    return sha256(Buffer.from(`derive-v2-r1-family-${ordinal}`));
  });
}

function blockRef(pin) { return { blockHash: pin.hash, requireCanonical: true }; }
async function agreedRequest(selected, rpc, method, params) {
  const results = [];
  for (const row of selected) results.push(await rpc.request(row.candidate, method, params));
  const canonical = results.map((value) => JSON.stringify(value));
  if (canonical.some((value) => value !== canonical[0])) fail("FIXED_STATE_FAMILY_MISMATCH");
  return results[0];
}
function decodeStorageAddress(value) {
  const word = strictHex(value, 32).slice(2);
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) fail("PROXY_SLOT_MALFORMED");
  return `0x${word.slice(24)}`;
}
function resolveProxySlots(values) {
  const result = {
    implementation: decodeStorageAddress(values.implementation),
    admin: decodeStorageAddress(values.admin),
    beacon: decodeStorageAddress(values.beacon),
  };
  if (result.implementation === ZERO_ADDRESS) fail("PROXY_IMPLEMENTATION_SLOT_ZERO");
  if (result.admin === ZERO_ADDRESS) fail("PROXY_ADMIN_SLOT_ZERO");
  if (result.beacon !== ZERO_ADDRESS) fail("PROXY_BEACON_SLOT_CONFLICT");
  return result;
}
function codeCommitment(value) {
  const hex = strictHex(value);
  const bytes = Buffer.from(hex.slice(2), "hex");
  if (!bytes.length || bytes.length > 128 * 1024) fail("MISSING_OR_OVERSIZED_CODE");
  return { byteLength: bytes.length, sha256: sha256(bytes), keccak256: keccak256(hex) };
}

function evaluateTopology(facts) {
  const checks = [
    facts.pmrm2?.subAccounts === undefined ? "UNKNOWN" : facts.pmrm2.subAccounts === ADDRESSES.subAccounts,
    facts.pmrm2?.cashAsset === undefined ? "UNKNOWN" : facts.pmrm2.cashAsset === ADDRESSES.cash,
    facts.pmrm2?.perp === undefined ? "UNKNOWN" : facts.pmrm2.perp === ADDRESSES.ethPerp,
    facts.cash?.subAccounts === undefined ? "UNKNOWN" : facts.cash.subAccounts === ADDRESSES.subAccounts,
    facts.cash?.rateModel === undefined ? "UNKNOWN" : facts.cash.rateModel === ADDRESSES.rateModel,
    facts.cash?.pmrm2Whitelisted === undefined ? "UNKNOWN" : facts.cash.pmrm2Whitelisted === true,
    facts.perp?.subAccounts === undefined ? "UNKNOWN" : facts.perp.subAccounts === ADDRESSES.subAccounts,
    facts.perp?.pmrm2Whitelisted === undefined ? "UNKNOWN" : facts.perp.pmrm2Whitelisted === true,
  ];
  const registration = facts.srm?.ethPerpRegistration;
  if (!registration) checks.push("UNKNOWN");
  else checks.push(registration.isWhitelisted === true && registration.assetType === 2
    && BigInt(registration.marketId) > 0n && registration.assetMap === ADDRESSES.ethPerp
    && BigInt(registration.marketId) <= BigInt(facts.srm.lastMarketId));
  if (checks.some((value) => value === false)) return "RUNTIME_MISMATCH";
  if (checks.some((value) => value === "UNKNOWN")) return "INCOMPLETE_TOPOLOGY";
  return "BOUND_TOPOLOGY_PARTIAL";
}

async function captureRunner(options = {}) {
  const candidates = options.candidates || parseInventorySafely(options.inventoryText);
  const rpc = options.rpc || createRpcClient({ transport: options.transport, maxRequests: options.maxRequests, timeoutMs: options.timeoutMs });
  const qualification = await qualifyAndSelect(candidates, rpc);
  const selected = qualification.selected;
  const pin = assertFixedPinAgreement(selected);
  const ref = blockRef(pin);

  const slotWords = {};
  for (const [name, slot] of Object.entries(EIP1967_SLOTS)) {
    slotWords[name] = await agreedRequest(selected, rpc, "eth_getStorageAt", [ADDRESSES.pmrm2Proxy, slot, ref]);
  }
  const proxy = resolveProxySlots(slotWords);

  const locators = {
    cash: ADDRESSES.cash,
    srm: ADDRESSES.srm,
    perpSettlementHelper: ADDRESSES.perpSettlementHelper,
    ethPerp: ADDRESSES.ethPerp,
    pmrm2Proxy: ADDRESSES.pmrm2Proxy,
    subAccounts: ADDRESSES.subAccounts,
    rateModel: ADDRESSES.rateModel,
    pmrm2Implementation: proxy.implementation,
  };
  const code = {};
  for (const [name, address] of Object.entries(locators)) {
    const raw = await agreedRequest(selected, rpc, "eth_getCode", [address, ref]);
    code[name] = { address, ...codeCommitment(raw) };
  }

  async function view(to, selector, words, decoder) {
    const result = await agreedRequest(selected, rpc, "eth_call", [{ to, data: callData(selector, words) }, ref]);
    return decoder(result);
  }
  const facts = {
    pmrm2: {
      implementation: proxy.implementation,
      subAccounts: await view(ADDRESSES.pmrm2Proxy, SELECTORS.subAccounts, [], decodeAddress),
      cashAsset: await view(ADDRESSES.pmrm2Proxy, SELECTORS.cashAsset, [], decodeAddress),
      perp: await view(ADDRESSES.pmrm2Proxy, SELECTORS.perp, [], decodeAddress),
      adjustmentsPaused: await view(ADDRESSES.pmrm2Proxy, SELECTORS.adjustmentsPaused, [], decodeBool),
    },
    cash: {
      subAccounts: await view(ADDRESSES.cash, SELECTORS.subAccounts, [], decodeAddress),
      rateModel: await view(ADDRESSES.cash, SELECTORS.rateModel, [], decodeAddress),
      pmrm2Whitelisted: await view(ADDRESSES.cash, SELECTORS.whitelistedManager, [addressWord(ADDRESSES.pmrm2Proxy)], decodeBool),
      totalSupply: await view(ADDRESSES.cash, SELECTORS.totalSupply, [], decodeUint),
      totalBorrow: await view(ADDRESSES.cash, SELECTORS.totalBorrow, [], decodeUint),
      netSettledCash: await view(ADDRESSES.cash, SELECTORS.netSettledCash, [], decodeInt),
      lastTimestamp: await view(ADDRESSES.cash, SELECTORS.lastTimestamp, [], decodeUint),
    },
    perp: {
      subAccounts: await view(ADDRESSES.ethPerp, SELECTORS.subAccounts, [], decodeAddress),
      pmrm2Whitelisted: await view(ADDRESSES.ethPerp, SELECTORS.whitelistedManager, [addressWord(ADDRESSES.pmrm2Proxy)], decodeBool),
      isDisabled: await view(ADDRESSES.ethPerp, SELECTORS.isDisabled, [], decodeBool),
    },
    srm: {
      borrowingEnabled: await view(ADDRESSES.srm, SELECTORS.borrowingEnabled, [], decodeBool),
      lastMarketId: await view(ADDRESSES.srm, SELECTORS.lastMarketId, [], decodeUint),
    },
  };
  const assetDetails = await view(ADDRESSES.srm, SELECTORS.assetDetails, [addressWord(ADDRESSES.ethPerp)], decodeAssetDetails);
  const mapped = await view(ADDRESSES.srm, SELECTORS.assetMap, [uintWord(assetDetails.marketId), uintWord(assetDetails.assetType)], decodeAddress);
  facts.srm.ethPerpRegistration = { ...assetDetails, assetMap: mapped };

  for (const row of selected) {
    const terminal = parseHeader(await rpc.request(row.candidate, "eth_getBlockByHash", [pin.hash, false]));
    if (terminal.number !== pin.number || terminal.hash !== pin.hash) fail("TERMINAL_PIN_RECHECK_FAILED");
  }

  const manifestImplementationMatch = proxy.implementation === ADDRESSES.pmrm2ManifestImplementation;
  const manifestAdminMatch = proxy.admin === ADDRESSES.pmrm2ManifestAdmin;
  const topologyClassification = evaluateTopology(facts);

  const output = {
    schema: SCHEMA,
    classification: !manifestImplementationMatch || !manifestAdminMatch ? "RUNTIME_MISMATCH" : topologyClassification,
    scope: "CURRENT_DERIVE_CHAIN_TOPOLOGY_AND_PUBLIC_SETTLEMENT_BINDING_GATE_ONLY",
    chainId: CHAIN_ID.toString(),
    finalizedPin: { number: pin.number.toString(), hash: pin.hash },
    selectedFamilyCommitments: opaqueFamilyCommitments(candidates, selected),
    qualification: {
      candidateCount: candidates.length,
      qualifiedCount: qualification.qualifiedCount,
      classifications: qualification.classifications,
    },
    rpcPolicy: {
      readOnly: true,
      allowlist: [...ALLOWED_RPC_METHODS],
      requestsUsed: rpc.state.requests,
      requestBudget: MAX_RPC_REQUESTS,
      timeoutMs: options.timeoutMs ?? MAX_TIMEOUT_MS,
      retries: 0,
      terminalHashRecheck: true,
    },
    sourceAuthority: {
      ...SOURCE,
      runtimeSourceEquivalence: "UNKNOWN_NOT_BUILT",
      publicEntrypointStatus: "SOURCE_PUBLIC_ENTRYPOINT_UNTESTED",
      reachabilityInferred: false,
    },
    proxy: {
      address: ADDRESSES.pmrm2Proxy,
      implementation: proxy.implementation,
      admin: proxy.admin,
      beacon: proxy.beacon,
      manifestImplementationMatch,
      manifestAdminMatch,
    },
    code,
    topology: facts,
    gates: {
      routePositive: "unknown",
      executableNow: "unknown",
      signedActionJustified: false,
      forkJustified: false,
    },
    safety: {
      rawCodePersisted: false,
      rawRepliesPersisted: false,
      endpointMaterialPersisted: false,
      settlementFunctionCalled: false,
      stateChangingMethodCalled: false,
      forkCreated: false,
      signedAction: false,
    },
  };
  validateOutput(output);
  return output;
}

const FORBIDDEN_OUTPUT_KEY = /(?:endpoint|provider|hostname|domain|credential|authorization|headers?|token|secret|rawresponse|rawreply|rawdata|rawmaterial|responsebody|bytecode|transport|url|uri)/i;
function walkOutput(value, visit, parts = []) {
  visit(value, parts);
  if (Array.isArray(value)) value.forEach((item, index) => walkOutput(item, visit, [...parts, String(index)]));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) walkOutput(item, visit, [...parts, key]);
}
function validateOutput(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) fail("OUTPUT_MALFORMED");
  if (output.schema !== SCHEMA || !/^(?:BOUND_TOPOLOGY_PARTIAL|INCOMPLETE_[A-Z0-9_]+|RUNTIME_MISMATCH)$/.test(output.classification)) fail("OUTPUT_CLASSIFICATION_FORBIDDEN");
  if (output.chainId !== CHAIN_ID.toString() || strictHex(output.finalizedPin?.hash, 32) !== output.finalizedPin.hash || !/^\d+$/.test(output.finalizedPin?.number)) fail("OUTPUT_PIN_INVALID");
  if (!Array.isArray(output.selectedFamilyCommitments) || output.selectedFamilyCommitments.length !== 2
    || new Set(output.selectedFamilyCommitments).size !== 2 || output.selectedFamilyCommitments.some((value) => !/^0x[0-9a-f]{64}$/.test(value))) fail("OUTPUT_FAMILY_COMMITMENTS_INVALID");
  if (output.rpcPolicy?.requestsUsed > MAX_RPC_REQUESTS || output.rpcPolicy?.requestBudget !== MAX_RPC_REQUESTS
    || output.rpcPolicy?.timeoutMs > MAX_TIMEOUT_MS || output.rpcPolicy?.retries !== 0
    || JSON.stringify(output.rpcPolicy?.allowlist) !== JSON.stringify(ALLOWED_RPC_METHODS)) fail("OUTPUT_RPC_POLICY_INVALID");
  if (output.sourceAuthority?.runtimeSourceEquivalence !== "UNKNOWN_NOT_BUILT"
    || output.sourceAuthority?.publicEntrypointStatus !== "SOURCE_PUBLIC_ENTRYPOINT_UNTESTED"
    || output.sourceAuthority?.reachabilityInferred !== false) fail("OUTPUT_SOURCE_CLAIM_INVALID");
  const currentImplementation = strictAddress(output.proxy?.implementation);
  const currentAdmin = strictAddress(output.proxy?.admin);
  if (strictAddress(output.proxy?.address) !== ADDRESSES.pmrm2Proxy || strictAddress(output.proxy?.beacon) !== ZERO_ADDRESS
    || output.proxy?.manifestImplementationMatch !== (currentImplementation === ADDRESSES.pmrm2ManifestImplementation)
    || output.proxy?.manifestAdminMatch !== (currentAdmin === ADDRESSES.pmrm2ManifestAdmin)
    || output.code?.pmrm2Implementation?.address !== currentImplementation
    || ((!output.proxy.manifestImplementationMatch || !output.proxy.manifestAdminMatch) && output.classification !== "RUNTIME_MISMATCH")) {
    fail("OUTPUT_PROXY_BINDING_INVALID");
  }
  if (output.gates?.routePositive !== "unknown" || output.gates?.executableNow !== "unknown"
    || output.gates?.signedActionJustified !== false || output.gates?.forkJustified !== false) fail("OUTPUT_GATE_INVALID");
  if (output.safety?.rawCodePersisted !== false || output.safety?.rawRepliesPersisted !== false
    || output.safety?.endpointMaterialPersisted !== false || output.safety?.settlementFunctionCalled !== false
    || output.safety?.stateChangingMethodCalled !== false || output.safety?.forkCreated !== false
    || output.safety?.signedAction !== false) fail("OUTPUT_SAFETY_INVALID");
  walkOutput(output, (value, parts) => {
    const key = parts.at(-1) || "";
    if (FORBIDDEN_OUTPUT_KEY.test(key) && !["endpointMaterialPersisted"].includes(key)) fail("OUTPUT_FORBIDDEN_KEY");
    if (typeof value !== "string") return;
    const separator = ":" + "/" + "/";
    if (value.includes(separator)) fail("OUTPUT_NETWORK_MATERIAL");
    if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(value)
      && !/\.(?:json|js|sol|md|txt)$/i.test(value)) fail("OUTPUT_NETWORK_MATERIAL");
    if (/^0x[0-9a-f]+$/i.test(value) && value.length > 66) fail("OUTPUT_RAW_HEX_FORBIDDEN");
  });
  for (const row of Object.values(output.code || {})) {
    strictAddress(row.address);
    if (!Number.isSafeInteger(row.byteLength) || row.byteLength < 1 || !/^0x[0-9a-f]{64}$/.test(row.sha256)
      || !/^0x[0-9a-f]{64}$/.test(row.keccak256)) fail("OUTPUT_CODE_COMMITMENT_INVALID");
  }
  return true;
}
function serializeOutput(output) { validateOutput(output); return `${JSON.stringify(output, null, 2)}\n`; }
function writeArtifactExclusive(outputPath, output, fsImpl = fs) {
  if (typeof outputPath !== "string" || !outputPath || outputPath.includes(":" + "/" + "/")) fail("OUTPUT_PATH_INVALID");
  const bytes = serializeOutput(output);
  const target = path.resolve(outputPath);
  let descriptor;
  try {
    descriptor = fsImpl.openSync(target, "wx");
    fsImpl.writeFileSync(descriptor, bytes, "utf8");
    fsImpl.closeSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) { try { fsImpl.closeSync(descriptor); } catch (_) {} }
    if (descriptor !== undefined && typeof fsImpl.unlinkSync === "function") { try { fsImpl.unlinkSync(target); } catch (_) {} }
    fail(error?.code === "EEXIST" ? "ARTIFACT_OVERWRITE_REJECTED" : "ARTIFACT_WRITE_FAILED");
  }
  return true;
}

function parseCli(argv) {
  if (!argv.includes("--capture")) {
    if (argv.length) fail("CLI_ARGUMENT_FORBIDDEN");
    return { capture: false };
  }
  const allowed = new Set(["--capture", "--output"]);
  for (let index = 0; index < argv.length; index++) {
    if (!allowed.has(argv[index])) fail("CLI_ARGUMENT_FORBIDDEN");
    if (argv[index] === "--output") index++;
  }
  const at = argv.indexOf("--output");
  if (at < 0 || at + 1 >= argv.length || argv.indexOf("--output", at + 1) >= 0) fail("CAPTURE_OUTPUT_REQUIRED");
  return { capture: true, outputPath: argv[at + 1] };
}
async function main(argv = process.argv.slice(2), dependencies = {}) {
  const cli = parseCli(argv);
  if (!cli.capture) return { mode: "PREFLIGHT", inventoryReads: 0, networkRequests: 0, captureRequired: true };
  const readInventory = dependencies.readInventory || (() => readInventoryFileSafely());
  const inventory = readInventory();
  const output = await captureRunner({ inventoryText: inventory, transport: dependencies.transport });
  (dependencies.writeArtifact || writeArtifactExclusive)(cli.outputPath, output);
  return { mode: "CAPTURE_COMPLETE", classification: output.classification, requestsUsed: output.rpcPolicy.requestsUsed };
}

module.exports = {
  ADDRESSES,
  ALLOWED_RPC_METHODS,
  CaptureError,
  CHAIN_ID,
  EIP1967_SLOTS,
  MAX_CANDIDATES,
  MAX_RPC_REQUESTS,
  MAX_TIMEOUT_MS,
  SCHEMA,
  SELECTORS,
  SIGNATURES,
  SOURCE,
  _test: { addressWord, callData, decodeAddress, decodeAssetDetails, decodeBool, decodeInt, decodeUint, parseHeader, uintWord },
  assertFixedPinAgreement,
  captureRunner,
  codeCommitment,
  createRpcClient,
  evaluateTopology,
  familyLabel,
  main,
  opaqueFamilyCommitments,
  parseInventorySafely,
  qualifyAndSelect,
  readInventoryFileSafely,
  resolveProxySlots,
  selectQualifiedFamilies,
  serializeOutput,
  validateOutput,
  writeArtifactExclusive,
};

if (require.main === module) {
  main().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(error instanceof CaptureError ? error.code : "CAPTURE_FAILED");
    process.exitCode = 1;
  });
}
