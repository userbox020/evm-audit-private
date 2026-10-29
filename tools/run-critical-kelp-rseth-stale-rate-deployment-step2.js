#!/usr/bin/env node
"use strict";

// Strictly bounded read-only capture. Endpoint material and RPC envelopes are
// memory-only. The default mode is offline/check-only; only --capture may read
// the inventory, use fetch, or create the immutable sanitized output.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const OUTPUT = path.join(ROOT, "reports", "raw", "fast", "critical-kelp-rseth-stale-rate-deployment-step2.json");
const FINDING_ID = "critical-kelp-rseth-stale-rate-deployment-step2";
const SCHEMA_VERSION = "kelp-rseth-stale-rate-deployment-step2/v2";
const SOURCE_COMMIT = "3dded885f6f797f5959aff449c3a30c5cbb6ce23";
const SOURCE_RUNTIME_ATTESTED = false;
const ZERO = "0x0000000000000000000000000000000000000000";
const ROUTE = Object.freeze({ receiverExpectedSourceChainId: 101, providerExpectedDestinationChainId: 184 });

const ADDRESSES = Object.freeze({
  base: Object.freeze({
    pool: "0x291088312150482826b3a37d5a69a4c54daa9118",
    wrapper: "0xedfa23602d0ec14714057867a78d01e94176bea0",
    receiver: "0x7781ae9b47fecaceaecc4fca8d0b6187e3ef9ba7",
    canonical: "0x1bc71130a0e39942a7658878169764bbd8a45993",
    proxyAdmin: "0xdf3f5926fd14ed048b04941189da54bdedd478d0",
  }),
  ethereum: Object.freeze({
    provider: "0x0788906b19ba8f8d0e8a7015f0714df3179d9ab6",
    lrtOracle: "0x349a73444b1a310bae67ef67973022020d70020d",
  }),
});

const SLOTS = Object.freeze({
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
});

const SELECTORS = Object.freeze({
  pool: Object.freeze({
    wrsETH: "e129200f", rsETHOracle: "54d1d5e4", paused: "5c975abb", feeBps: "24a9d853",
    dailyMintLimit: "62680e4b", dailyMintAmount: "fd0c9ff1", lastMintDay: "e27cafb9",
    startTimestamp: "e6fd48bc", getCurrentDay: "3e6968b6", remainingDailyMintLimit: "dc5b954f",
    getRate: "679aefce",
  }),
  wrapper: Object.freeze({
    minterRole: "d5391393", hasRole: "91d14854", allowedTokens: "e744092e",
    maxAmountToDepositBridgerAsset: "6d47a8af", totalSupply: "18160ddd",
  }),
  token: Object.freeze({ balanceOf: "70a08231", decimals: "313ce567" }),
  receiver: Object.freeze({
    rate: "2c4e722e", lastUpdated: "d0b06f5d", srcChainId: "49d12605",
    rateProvider: "949db658", layerZeroEndpoint: "07968db1",
  }),
  provider: Object.freeze({
    getLatestRate: "e1e7ff77", getRate: "679aefce", rate: "2c4e722e", lastUpdated: "d0b06f5d",
    rsETHPriceOracle: "458e7836", getRateReceivers: "b02d0322", layerZeroEndpoint: "07968db1",
  }),
  lrtOracle: Object.freeze({ rsETHPrice: "b4b46434" }),
  beacon: Object.freeze({ implementation: "5c60da1b" }),
});

const CAPS = Object.freeze({
  baseCalls: 48,
  ethereumCalls: 24,
  totalCalls: 72,
  qualificationCalls: 12,
  callsPerBatch: 12,
  requestBytes: 32 * 1024,
  responseBytesPerBatch: 128 * 1024,
  aggregateTransientBytes: 768 * 1024,
  getterBytes: 128,
  routeReceiverEntries: 32,
  routeGetterBytes: 2112,
  codeBytes: 64 * 1024,
  timeoutMs: 10_000,
  staleThresholdSeconds: 24 * 60 * 60,
  snapshotSkewSeconds: 30 * 60,
  maxCandidateInputWei: 10n ** 19n,
  minimumValueDeltaWei: 10n ** 15n,
  minimumValueMarginBps: 10,
});

const PLAN = Object.freeze({ baseCallsIncludingQualificationAndTerminal: 44, ethereumCallsIncludingQualificationAndTerminal: 14, totalCallsWithMaximumQualification: 68 });

const ALLOWED_METHODS = Object.freeze([
  "eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call",
]);
const ALLOWED_SET = new Set(ALLOWED_METHODS);

class Stop extends Error {
  constructor(code) { super(code); this.code = code; }
}
const stop = (code) => { throw new Stop(code); };
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const lower = (value) => String(value).toLowerCase();
const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : typeof value === "bigint" ? value.toString() : value;
const canonicalJson = (value) => JSON.stringify(canonical(value));

function specDescriptor() {
  return canonical({ schemaVersion: SCHEMA_VERSION, sourceCommit: SOURCE_COMMIT, sourceRuntimeAttested: SOURCE_RUNTIME_ATTESTED, addresses: ADDRESSES, route: ROUTE, slots: SLOTS, selectors: SELECTORS, caps: CAPS, plan: PLAN, allowedMethods: ALLOWED_METHODS });
}
const SPEC_SHA256 = sha256(Buffer.from(canonicalJson(specDescriptor())));

function canonicalQuantity(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

function strictHex(value, maxBytes, code) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) stop(code);
  const bytes = (value.length - 2) / 2;
  if (bytes > maxBytes) stop(code);
  return { hex: lower(value), bytes };
}

function decodeWord(value) {
  const parsed = strictHex(value, CAPS.getterBytes, "ABI_MALFORMED_OR_OVERSIZED");
  if (parsed.bytes !== 32) stop("ABI_SCALAR_NOT_32_BYTES");
  return parsed.hex.slice(2);
}

function decodeUint(value) { return BigInt(`0x${decodeWord(value)}`); }
function decodeAddress(value) {
  const word = decodeWord(value);
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) stop("ABI_ADDRESS_PADDING_INVALID");
  return `0x${word.slice(24)}`;
}
function decodeBool(value) {
  const decoded = decodeUint(value);
  if (decoded !== 0n && decoded !== 1n) stop("ABI_BOOL_INVALID");
  return decoded === 1n;
}

function decodeRateReceivers(value) {
  const parsed = strictHex(value, CAPS.routeGetterBytes, "ROUTE_ABI_OVERSIZED");
  if (parsed.bytes < 64 || parsed.bytes % 32 !== 0) stop("ROUTE_ABI_TRUNCATED");
  const wordAt = (index) => parsed.hex.slice(2 + index * 64, 2 + (index + 1) * 64);
  const offsetWord = wordAt(0);
  if (BigInt(`0x${offsetWord}`) !== 32n) stop("ROUTE_ABI_NONCANONICAL_OFFSET");
  const lengthValue = BigInt(`0x${wordAt(1)}`);
  if (lengthValue > BigInt(CAPS.routeReceiverEntries)) stop("ROUTE_ENTRY_CAP_EXCEEDED");
  const length = Number(lengthValue), expectedBytes = 64 + length * 64;
  if (parsed.bytes !== expectedBytes) stop("ROUTE_ABI_LENGTH_MISMATCH");
  const entries = [];
  for (let index = 0; index < length; index++) {
    const chainWord = wordAt(2 + index * 2), contractWord = wordAt(3 + index * 2);
    if (!/^0{60}[0-9a-f]{4}$/.test(chainWord)) stop("ROUTE_CHAIN_ID_PADDING_INVALID");
    if (!/^0{24}[0-9a-f]{40}$/.test(contractWord)) stop("ROUTE_ADDRESS_PADDING_INVALID");
    entries.push({ chainId: Number(BigInt(`0x${chainWord}`)), receiver: `0x${contractWord.slice(24)}` });
  }
  return entries;
}

function summarizeProviderRoute(entries) {
  if (!Array.isArray(entries) || entries.length > CAPS.routeReceiverEntries) stop("ROUTE_ENTRY_CAP_EXCEEDED");
  const base = entries.filter((entry) => entry.chainId === ROUTE.providerExpectedDestinationChainId);
  const matching = base.filter((entry) => lower(entry.receiver) === ADDRESSES.base.receiver);
  return canonical({ getterStatus: "OBSERVED", totalEntries: entries.length, baseDestinationEntries: base.length, matchingBaseEntries: matching.length, conflictingBaseEntries: base.length - matching.length });
}

function strictHeader(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) stop("BLOCK_HEADER_MALFORMED");
  const number = canonicalQuantity(lower(value.number)), timestamp = canonicalQuantity(lower(value.timestamp));
  if (number === null || timestamp === null || !/^0x[0-9a-fA-F]{64}$/.test(value.hash || "")) stop("BLOCK_HEADER_MALFORMED");
  return { number, timestamp, hash: lower(value.hash) };
}

function addressWord(address) {
  if (!/^0x[0-9a-f]{40}$/.test(lower(address))) stop("INTERNAL_ADDRESS_INVALID");
  return lower(address).slice(2).padStart(64, "0");
}
function bytes32Word(value) {
  if (!/^0x[0-9a-f]{64}$/.test(lower(value))) stop("INTERNAL_BYTES32_INVALID");
  return lower(value).slice(2);
}
const callData = (selector, words = []) => `0x${selector}${words.join("")}`;
const quantity = (value) => `0x${BigInt(value).toString(16)}`;
const slotAddress = (word) => {
  const decoded = decodeWord(word);
  if (BigInt(`0x${decoded}`) === 0n) return null;
  if (!/^0{24}[0-9a-f]{40}$/.test(decoded)) stop("EIP1967_SLOT_PADDING_INVALID");
  return `0x${decoded.slice(24)}`;
};

function classifyProxy(slotWords) {
  const implementation = slotAddress(slotWords.implementation);
  const admin = slotAddress(slotWords.admin);
  const beacon = slotAddress(slotWords.beacon);
  if (implementation && beacon) stop("EIP1967_AMBIGUOUS_IMPLEMENTATION_AND_BEACON");
  if (implementation) return { kind: "EIP1967_IMPLEMENTATION", implementation, beacon: null, admin };
  if (beacon) return { kind: "EIP1967_BEACON", implementation: null, beacon, admin };
  return { kind: "DIRECT", implementation: null, beacon: null, admin };
}

function summarizeCode(value, required = true) {
  const parsed = strictHex(value, CAPS.codeBytes, "CODE_MALFORMED_OR_OVERSIZED");
  if (required && parsed.bytes === 0) stop("REQUIRED_CODE_EMPTY");
  return { bytes: parsed.bytes, keccak256: parsed.bytes === 0 ? null : keccak256(parsed.hex) };
}

class Budget {
  constructor(caps = CAPS) {
    this.caps = caps;
    this.total = 0;
    this.base = 0;
    this.ethereum = 0;
    this.qualification = 0;
    this.transientBytes = 0;
    this.batches = 0;
    this.byMethod = {};
  }
  reserve(method, chain = null, qualification = false) {
    if (!ALLOWED_SET.has(method)) stop("RPC_METHOD_NOT_ALLOWED");
    if (this.total + 1 > this.caps.totalCalls) stop("RPC_TOTAL_CAP_EXCEEDED");
    if (qualification && this.qualification + 1 > this.caps.qualificationCalls) stop("RPC_QUALIFICATION_CAP_EXCEEDED");
    if (chain === "base" && this.base + 1 > this.caps.baseCalls) stop("RPC_BASE_CAP_EXCEEDED");
    if (chain === "ethereum" && this.ethereum + 1 > this.caps.ethereumCalls) stop("RPC_ETHEREUM_CAP_EXCEEDED");
    this.total++; if (qualification) this.qualification++;
    if (chain === "base") this.base++; if (chain === "ethereum") this.ethereum++;
    this.byMethod[method] = (this.byMethod[method] || 0) + 1;
  }
  attributeQualification(chain) {
    if (chain === "base") { if (this.base + 1 > this.caps.baseCalls) stop("RPC_BASE_CAP_EXCEEDED"); this.base++; }
    if (chain === "ethereum") { if (this.ethereum + 1 > this.caps.ethereumCalls) stop("RPC_ETHEREUM_CAP_EXCEEDED"); this.ethereum++; }
  }
  addTransient(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.transientBytes + bytes > this.caps.aggregateTransientBytes) stop("RPC_AGGREGATE_TRANSIENT_CAP_EXCEEDED");
    this.transientBytes += bytes;
  }
  summary() {
    return canonical({ totalCalls: this.total, callsByChain: { base: this.base, ethereum: this.ethereum }, qualificationCalls: this.qualification, batches: this.batches, transientBytes: this.transientBytes, byMethod: this.byMethod });
  }
}

function enforceBatchCallCap(count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > CAPS.callsPerBatch) stop("RPC_BATCH_CALL_CAP_EXCEEDED");
}
function enforceRequestByteCap(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > CAPS.requestBytes) stop("RPC_REQUEST_BATCH_CAP_EXCEEDED");
}
function enforceResponseByteCap(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > CAPS.responseBytesPerBatch) stop("RPC_RESPONSE_BATCH_CAP_EXCEEDED");
}

function parseInventoryText(text, options = {}) {
  if (options.captureMode !== true) stop("INVENTORY_PARSE_REQUIRES_CAPTURE_MODE");
  const rows = [], secrets = new Set(), byUrl = new Set();
  const lines = String(text).replace(/\\\//g, "/").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    for (const match of lines[index].matchAll(/https?:\/\/[^\s"'`<>{}\[\]]+/gi)) {
      let parsed; try { parsed = new URL(match[0].replace(/[)>`,.;\]]+$/g, "")); } catch { continue; }
      if (!['http:', 'https:'].includes(parsed.protocol) || byUrl.has(parsed.href)) continue;
      const context = lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 4)).join("\n"), headers = {};
      for (const h of context.matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/gi)) headers[h[1].trim()] = h[2].trim();
      const origin = context.match(/\[origin:\s*([^\]\s]+)\]/i)?.[1]; if (origin) headers.origin = origin;
      rows.push({ url: parsed.href, headers }); byUrl.add(parsed.href);
      for (const item of [parsed.href, parsed.hostname, parsed.username, parsed.password, ...parsed.searchParams.values(), ...Object.values(headers), ...parsed.pathname.split("/").filter((x) => x.length >= 12)]) if (String(item).length >= 4) secrets.add(lower(item));
    }
  }
  return { rows: rows.slice(0, CAPS.qualificationCalls), secrets };
}

async function fetchTransport(endpoint, requestBytes, timeoutMs) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint.url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", accept: "application/json", ...endpoint.headers }, body: requestBytes, signal: controller.signal });
    if (!response.ok || !response.body?.getReader) stop("RPC_TRANSPORT_UNAVAILABLE");
    const reader = response.body.getReader(), chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > CAPS.responseBytesPerBatch) { await reader.cancel(); stop("RPC_RESPONSE_BATCH_CAP_EXCEEDED"); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof Stop) throw error;
    stop("RPC_TRANSPORT_UNAVAILABLE");
  } finally { clearTimeout(timer); }
}

let rpcId = 1;
async function rpcBatch(endpoint, calls, budget, options = {}) {
  if (!Array.isArray(calls)) stop("RPC_BATCH_CALL_CAP_EXCEEDED");
  enforceBatchCallCap(calls.length);
  const chain = options.chain || null, qualification = options.qualification === true;
  const requests = calls.map((entry) => {
    budget.reserve(entry.method, chain, qualification);
    return { jsonrpc: "2.0", id: rpcId++, method: entry.method, params: entry.params || [] };
  });
  const wire = requests.length === 1 ? requests[0] : requests;
  const request = Buffer.from(JSON.stringify(wire));
  enforceRequestByteCap(request.length);
  budget.addTransient(request.length); budget.batches++;
  const response = await (options.transport || fetchTransport)(endpoint, request, CAPS.timeoutMs);
  if (!Buffer.isBuffer(response)) stop("RPC_RESPONSE_NOT_BUFFER");
  enforceResponseByteCap(response.length);
  budget.addTransient(response.length);
  let parsed; try { parsed = JSON.parse(response.toString("utf8")); } catch { stop("RPC_RESPONSE_JSON_INVALID"); }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length !== requests.length) stop("RPC_RESPONSE_COUNT_MISMATCH");
  const byId = new Map(rows.map((row) => [row?.id, row]));
  return requests.map((requestRow) => {
    const row = byId.get(requestRow.id);
    if (!row || row.jsonrpc !== "2.0" || row.error || !Object.hasOwn(row, "result") || row.result === null) stop("RPC_LOGICAL_CALL_FAILED");
    return row.result;
  });
}

async function qualifyEndpoints(inventory, budget, transport) {
  const selected = {};
  for (const endpoint of inventory.rows) {
    if (selected.base && selected.ethereum) break;
    let result;
    try { [result] = await rpcBatch(endpoint, [{ method: "eth_chainId", params: [] }], budget, { qualification: true, transport }); }
    catch (error) { if (error instanceof Stop && error.code === "RPC_QUALIFICATION_CAP_EXCEEDED") throw error; continue; }
    const chainId = canonicalQuantity(lower(result));
    if (chainId === 8453n && !selected.base) { budget.attributeQualification("base"); selected.base = endpoint; }
    else if (chainId === 1n && !selected.ethereum) { budget.attributeQualification("ethereum"); selected.ethereum = endpoint; }
  }
  if (!selected.base) stop("BASE_ENDPOINT_UNAVAILABLE");
  if (!selected.ethereum) stop("ETHEREUM_ENDPOINT_UNAVAILABLE");
  return selected;
}

function spec(label, method, params, decode) { return { label, method, params, decode }; }
async function executeSpecs(endpoint, chain, pinTag, specs, budget, transport) {
  const out = {};
  for (let offset = 0; offset < specs.length; offset += CAPS.callsPerBatch) {
    const chunk = specs.slice(offset, offset + CAPS.callsPerBatch);
    const values = await rpcBatch(endpoint, chunk.map((row) => ({ method: row.method, params: row.params })), budget, { chain, transport });
    for (let index = 0; index < chunk.length; index++) out[chunk[index].label] = chunk[index].decode(values[index]);
  }
  return out;
}

const ethCallSpec = (label, to, selector, decode, words = [], tag) => spec(label, "eth_call", [{ to, data: callData(selector, words) }, tag], decode);
const codeSpec = (label, address, tag) => spec(label, "eth_getCode", [address, tag], summarizeCode);
const slotSpec = (label, address, slot, tag) => spec(label, "eth_getStorageAt", [address, slot, tag], (value) => `0x${decodeWord(value)}`);

async function resolveProxyRuntime(endpoint, chain, proxy, tag, budget, transport, label) {
  const specs = [];
  if (proxy.implementation) specs.push(codeSpec(`${label}ImplementationRuntime`, proxy.implementation, tag));
  if (proxy.beacon) {
    specs.push(codeSpec(`${label}BeaconRuntime`, proxy.beacon, tag));
    specs.push(ethCallSpec(`${label}BeaconImplementation`, proxy.beacon, SELECTORS.beacon.implementation, decodeAddress, [], tag));
  }
  const first = specs.length ? await executeSpecs(endpoint, chain, tag, specs, budget, transport) : {};
  if (proxy.beacon) {
    const implementation = first[`${label}BeaconImplementation`];
    if (implementation === ZERO) stop("BEACON_IMPLEMENTATION_ZERO");
    const second = await executeSpecs(endpoint, chain, tag, [codeSpec(`${label}ImplementationRuntime`, implementation, tag)], budget, transport);
    return { ...proxy, implementation, implementationRuntime: second[`${label}ImplementationRuntime`], beaconRuntime: first[`${label}BeaconRuntime`] };
  }
  return { ...proxy, implementationRuntime: proxy.implementation ? first[`${label}ImplementationRuntime`] : null, beaconRuntime: null };
}

async function captureBase(endpoint, budget, transport) {
  const [headerRaw] = await rpcBatch(endpoint, [{ method: "eth_getBlockByNumber", params: ["latest", false] }], budget, { chain: "base", transport });
  const header = strictHeader(headerRaw), tag = quantity(header.number), a = ADDRESSES.base;
  const initialSpecs = [
    codeSpec("poolRuntime", a.pool, tag), codeSpec("wrapperRuntime", a.wrapper, tag), codeSpec("receiverRuntime", a.receiver, tag),
    codeSpec("canonicalRuntime", a.canonical, tag), codeSpec("proxyAdminRuntime", a.proxyAdmin, tag),
    slotSpec("poolImplementationSlot", a.pool, SLOTS.implementation, tag), slotSpec("poolAdminSlot", a.pool, SLOTS.admin, tag), slotSpec("poolBeaconSlot", a.pool, SLOTS.beacon, tag),
    slotSpec("wrapperImplementationSlot", a.wrapper, SLOTS.implementation, tag), slotSpec("wrapperAdminSlot", a.wrapper, SLOTS.admin, tag), slotSpec("wrapperBeaconSlot", a.wrapper, SLOTS.beacon, tag),
    ethCallSpec("minterRole", a.wrapper, SELECTORS.wrapper.minterRole, (value) => `0x${decodeWord(value)}`, [], tag),
  ];
  const initial = await executeSpecs(endpoint, "base", tag, initialSpecs, budget, transport);
  let poolProxy = classifyProxy({ implementation: initial.poolImplementationSlot, admin: initial.poolAdminSlot, beacon: initial.poolBeaconSlot });
  let wrapperProxy = classifyProxy({ implementation: initial.wrapperImplementationSlot, admin: initial.wrapperAdminSlot, beacon: initial.wrapperBeaconSlot });
  poolProxy = await resolveProxyRuntime(endpoint, "base", poolProxy, tag, budget, transport, "pool");
  wrapperProxy = await resolveProxyRuntime(endpoint, "base", wrapperProxy, tag, budget, transport, "wrapper");

  const u = decodeUint, ad = decodeAddress, bo = decodeBool;
  const stateSpecs = [
    ethCallSpec("poolWrsETH", a.pool, SELECTORS.pool.wrsETH, ad, [], tag),
    ethCallSpec("poolOracle", a.pool, SELECTORS.pool.rsETHOracle, ad, [], tag),
    ethCallSpec("poolPaused", a.pool, SELECTORS.pool.paused, bo, [], tag),
    ethCallSpec("poolFeeBps", a.pool, SELECTORS.pool.feeBps, u, [], tag),
    ethCallSpec("poolDailyMintLimit", a.pool, SELECTORS.pool.dailyMintLimit, u, [], tag),
    ethCallSpec("poolDailyMintAmount", a.pool, SELECTORS.pool.dailyMintAmount, u, [], tag),
    ethCallSpec("poolLastMintDay", a.pool, SELECTORS.pool.lastMintDay, u, [], tag),
    ethCallSpec("poolStartTimestamp", a.pool, SELECTORS.pool.startTimestamp, u, [], tag),
    ethCallSpec("poolCurrentDay", a.pool, SELECTORS.pool.getCurrentDay, u, [], tag),
    ethCallSpec("poolRemaining", a.pool, SELECTORS.pool.remainingDailyMintLimit, u, [], tag),
    ethCallSpec("poolRate", a.pool, SELECTORS.pool.getRate, u, [], tag),
    ethCallSpec("wrapperHasMinter", a.wrapper, SELECTORS.wrapper.hasRole, bo, [bytes32Word(initial.minterRole), addressWord(a.pool)], tag),
    ethCallSpec("wrapperAllowsCanonical", a.wrapper, SELECTORS.wrapper.allowedTokens, bo, [addressWord(a.canonical)], tag),
    ethCallSpec("wrapperMaximumCanonical", a.wrapper, SELECTORS.wrapper.maxAmountToDepositBridgerAsset, u, [addressWord(a.canonical)], tag),
    ethCallSpec("wrapperTotalSupply", a.wrapper, SELECTORS.wrapper.totalSupply, u, [], tag),
    ethCallSpec("canonicalReserve", a.canonical, SELECTORS.token.balanceOf, u, [addressWord(a.wrapper)], tag),
    ethCallSpec("canonicalDecimals", a.canonical, SELECTORS.token.decimals, u, [], tag),
    ethCallSpec("receiverRate", a.receiver, SELECTORS.receiver.rate, u, [], tag),
    ethCallSpec("receiverLastUpdated", a.receiver, SELECTORS.receiver.lastUpdated, u, [], tag),
    ethCallSpec("receiverSourceChain", a.receiver, SELECTORS.receiver.srcChainId, u, [], tag),
    ethCallSpec("receiverProvider", a.receiver, SELECTORS.receiver.rateProvider, ad, [], tag),
    ethCallSpec("receiverEndpoint", a.receiver, SELECTORS.receiver.layerZeroEndpoint, ad, [], tag),
  ];
  const state = await executeSpecs(endpoint, "base", tag, stateSpecs, budget, transport);
  if (state.receiverEndpoint === ZERO) stop("BASE_CONFIGURED_ENDPOINT_ZERO");
  const [endpointRuntime] = Object.values(await executeSpecs(endpoint, "base", tag, [codeSpec("configuredEndpointRuntime", state.receiverEndpoint, tag)], budget, transport));
  return canonical({
    chainId: 8453, pin: { number: header.number.toString(), hash: header.hash, timestamp: header.timestamp.toString() },
    contracts: {
      pool: { address: a.pool, runtime: initial.poolRuntime, proxy: poolProxy },
      wrapper: { address: a.wrapper, runtime: initial.wrapperRuntime, proxy: wrapperProxy },
      receiver: { address: a.receiver, runtime: initial.receiverRuntime },
      canonical: { address: a.canonical, runtime: initial.canonicalRuntime },
      documentedProxyAdmin: { address: a.proxyAdmin, runtime: initial.proxyAdminRuntime },
      configuredLayerZeroEndpoint: { address: state.receiverEndpoint, runtime: endpointRuntime },
    },
    state: {
      pool: { wrsETH: state.poolWrsETH, rsETHOracle: state.poolOracle, paused: state.poolPaused, feeBps: state.poolFeeBps.toString(), dailyMintLimit: state.poolDailyMintLimit.toString(), dailyMintAmount: state.poolDailyMintAmount.toString(), lastMintDay: state.poolLastMintDay.toString(), startTimestamp: state.poolStartTimestamp.toString(), currentDay: state.poolCurrentDay.toString(), remainingDailyMintLimit: state.poolRemaining.toString(), rate: state.poolRate.toString() },
      wrapper: { minterRole: initial.minterRole, poolHasMinterRole: state.wrapperHasMinter, canonicalAllowed: state.wrapperAllowsCanonical, maxCanonicalDeposit: state.wrapperMaximumCanonical.toString(), totalSupply: state.wrapperTotalSupply.toString() },
      canonical: { decimals: state.canonicalDecimals.toString(), wrapperReserve: state.canonicalReserve.toString() },
      receiver: { rate: state.receiverRate.toString(), lastUpdated: state.receiverLastUpdated.toString(), srcChainId: state.receiverSourceChain.toString(), rateProvider: state.receiverProvider, layerZeroEndpoint: state.receiverEndpoint },
    },
  });
}

async function captureEthereum(endpoint, budget, transport) {
  const [headerRaw] = await rpcBatch(endpoint, [{ method: "eth_getBlockByNumber", params: ["latest", false] }], budget, { chain: "ethereum", transport });
  const header = strictHeader(headerRaw), tag = quantity(header.number), a = ADDRESSES.ethereum, u = decodeUint, ad = decodeAddress;
  const specs = [
    codeSpec("providerRuntime", a.provider, tag), codeSpec("lrtOracleRuntime", a.lrtOracle, tag),
    ethCallSpec("getLatestRate", a.provider, SELECTORS.provider.getLatestRate, u, [], tag),
    ethCallSpec("getRate", a.provider, SELECTORS.provider.getRate, u, [], tag),
    ethCallSpec("rate", a.provider, SELECTORS.provider.rate, u, [], tag),
    ethCallSpec("lastUpdated", a.provider, SELECTORS.provider.lastUpdated, u, [], tag),
    ethCallSpec("rsETHPriceOracle", a.provider, SELECTORS.provider.rsETHPriceOracle, ad, [], tag),
    ethCallSpec("rateReceivers", a.provider, SELECTORS.provider.getRateReceivers, decodeRateReceivers, [], tag),
    ethCallSpec("layerZeroEndpoint", a.provider, SELECTORS.provider.layerZeroEndpoint, ad, [], tag),
    ethCallSpec("rsETHPrice", a.lrtOracle, SELECTORS.lrtOracle.rsETHPrice, u, [], tag),
  ];
  const state = await executeSpecs(endpoint, "ethereum", tag, specs, budget, transport);
  if (state.layerZeroEndpoint === ZERO) stop("ETHEREUM_CONFIGURED_ENDPOINT_ZERO");
  const endpointState = await executeSpecs(endpoint, "ethereum", tag, [codeSpec("configuredEndpointRuntime", state.layerZeroEndpoint, tag)], budget, transport);
  return canonical({
    chainId: 1, pin: { number: header.number.toString(), hash: header.hash, timestamp: header.timestamp.toString() },
    contracts: {
      provider: { address: a.provider, runtime: state.providerRuntime },
      lrtOracle: { address: a.lrtOracle, runtime: state.lrtOracleRuntime },
      configuredEndpoint: { address: state.layerZeroEndpoint, runtime: endpointState.configuredEndpointRuntime },
    },
    state: { provider: { getLatestRate: state.getLatestRate.toString(), getRate: state.getRate.toString(), rate: state.rate.toString(), lastUpdated: state.lastUpdated.toString(), rsETHPriceOracle: state.rsETHPriceOracle, routeSummary: summarizeProviderRoute(state.rateReceivers), layerZeroEndpoint: state.layerZeroEndpoint }, lrtOracle: { rsETHPrice: state.rsETHPrice.toString() } },
  });
}

function decimal(value, code = "SANITIZED_DECIMAL_INVALID") {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) stop(code);
  return BigInt(value);
}
const same = (a, b) => lower(a) === lower(b);
const push = (rows, condition, code) => { if (!condition) rows.push(code); };

function divergence(staleRate, sourceRate, feeBps) {
  const stale = BigInt(staleRate), source = BigInt(sourceRate), fee = BigInt(feeBps);
  if (fee >= 10_000n) return { lhs: stale * 10_000n, rhs: 0n, profitable: false, signedMargin: -(stale * 10_000n) };
  const lhs = stale * 10_000n, rhs = source * (10_000n - fee);
  return { lhs, rhs, profitable: rhs > lhs, signedMargin: rhs - lhs };
}

function integerRoundedCase(inputWei, feeBps, staleRate, sourceRate) {
  const input = BigInt(inputWei), feeRate = BigInt(feeBps), stale = BigInt(staleRate), source = BigInt(sourceRate);
  if (input < 0n || feeRate >= 10_000n || stale === 0n) return null;
  const fee = input * feeRate / 10_000n, net = input - fee, minted = net * 10n ** 18n / stale;
  const candidateOutput = minted, currentValue = candidateOutput * source / 10n ** 18n, delta = currentValue - input;
  const marginBps = input === 0n || delta <= 0n ? 0n : delta * 10_000n / input;
  return { inputWei: input, feeWei: fee, netInputWei: net, mintedCanonicalUnits: minted, candidateOutputCanonicalUnits: candidateOutput, currentValueWei: currentValue, currentValueDeltaWei: delta, positiveMarginBps: marginBps };
}

function boundedFeasibleCase(headroom, reserve, staleRate, sourceRate, feeBps) {
  const mintCap = BigInt(headroom) < BigInt(reserve) ? BigInt(headroom) : BigInt(reserve);
  const maximumInput = BigInt(CAPS.maxCandidateInputWei);
  if (mintCap <= 0n || BigInt(staleRate) <= 0n || BigInt(sourceRate) <= 0n || BigInt(feeBps) >= 10_000n) return null;
  let low = 1n, high = maximumInput, selected = 0n;
  for (let step = 0; step < 96 && low <= high; step++) {
    const middle = (low + high) / 2n, row = integerRoundedCase(middle, feeBps, staleRate, sourceRate);
    if (row && row.mintedCanonicalUnits <= mintCap) { selected = middle; low = middle + 1n; }
    else high = middle - 1n;
  }
  if (selected === 0n) return null;
  const row = integerRoundedCase(selected, feeBps, staleRate, sourceRate);
  const constraints = {
    mintedPositive: row.mintedCanonicalUnits > 0n,
    withinCurrentDailyHeadroom: row.mintedCanonicalUnits <= BigInt(headroom),
    withinCanonicalReserve: row.mintedCanonicalUnits <= BigInt(reserve),
    minimumValueDeltaMet: row.currentValueDeltaWei >= BigInt(CAPS.minimumValueDeltaWei),
    minimumValueMarginMet: row.positiveMarginBps >= BigInt(CAPS.minimumValueMarginBps),
  };
  return canonical({ ...row, constraints, evidenceFeasible: Object.values(constraints).every((value) => value === true), canonicalTokenUnitAssumption: "18-decimal canonical rsETH units with 1:1 wrapper redemption" });
}

function terminalHeaderConsistency(initialPin, observed) {
  try {
    const parsed = strictHeader(observed);
    return parsed.number.toString() === initialPin.number && parsed.hash === initialPin.hash && parsed.timestamp.toString() === initialPin.timestamp;
  } catch { return false; }
}

function providerRouteKillReasons(summary) {
  if (!summary || summary.getterStatus !== "OBSERVED") return ["PROVIDER_ROUTE_UNVERIFIABLE"];
  const values = [summary.totalEntries, summary.baseDestinationEntries, summary.matchingBaseEntries, summary.conflictingBaseEntries];
  if (!values.every(Number.isSafeInteger) || values.some((value) => value < 0) || summary.totalEntries > CAPS.routeReceiverEntries || summary.matchingBaseEntries + summary.conflictingBaseEntries !== summary.baseDestinationEntries || summary.baseDestinationEntries > summary.totalEntries) return ["PROVIDER_ROUTE_UNVERIFIABLE"];
  if (summary.baseDestinationEntries === 0) return ["PROVIDER_BASE_ROUTE_ABSENT"];
  if (summary.baseDestinationEntries === 1 && summary.matchingBaseEntries === 0) return ["PROVIDER_BASE_ROUTE_RECEIVER_MISMATCH"];
  if (summary.conflictingBaseEntries > 0) return ["PROVIDER_BASE_ROUTE_CONFLICTING"];
  if (summary.matchingBaseEntries > 1) return ["PROVIDER_BASE_ROUTE_DUPLICATE"];
  return [];
}

async function terminalRecheck(endpoint, chain, pin, budget, transport) {
  try {
    const [observed] = await rpcBatch(endpoint, [{ method: "eth_getBlockByNumber", params: [quantity(pin.number), false] }], budget, { chain, transport });
    return terminalHeaderConsistency(pin, observed);
  } catch { return false; }
}

function evaluateCapture(chains) {
  const reasons = ["SOURCE_RUNTIME_UNATTESTED"], b = chains?.base, e = chains?.ethereum;
  if (!b || b.chainId !== 8453) reasons.push("CHAIN_BASE_MISMATCH");
  if (!e || e.chainId !== 1) reasons.push("CHAIN_ETHEREUM_MISMATCH");
  if (!b || b.chainId !== 8453 || !e || e.chainId !== 1) return { promotion: false, classification: "BLOCKED/SANITIZED-CAPTURE-INVALID", killReasons: [...new Set(reasons)].sort(), analysis: null };
  const bp = b.state.pool, bw = b.state.wrapper, bc = b.state.canonical, br = b.state.receiver, ep = e.state.provider, eo = e.state.lrtOracle;
  const baseTime = decimal(b.pin.timestamp), ethTime = decimal(e.pin.timestamp), start = decimal(bp.startTimestamp), lastUpdated = decimal(br.lastUpdated), providerUpdated = decimal(ep.lastUpdated);
  const fee = decimal(bp.feeBps), limit = decimal(bp.dailyMintLimit), minted = decimal(bp.dailyMintAmount), lastDay = decimal(bp.lastMintDay), currentDay = decimal(bp.currentDay), remaining = decimal(bp.remainingDailyMintLimit);
  const staleRate = decimal(br.rate), poolRate = decimal(bp.rate), latest = decimal(ep.getLatestRate), providerGet = decimal(ep.getRate), providerRate = decimal(ep.rate), oracleRate = decimal(eo.rsETHPrice);
  const reserve = decimal(bc.wrapperReserve), supply = decimal(bw.totalSupply), maxCanonical = decimal(bw.maxCanonicalDeposit);
  push(reasons, b.pin.terminalHeaderConsistent === true, "BASE_TERMINAL_HEADER_INCONSISTENT");
  push(reasons, e.pin.terminalHeaderConsistent === true, "ETHEREUM_TERMINAL_HEADER_INCONSISTENT");
  push(reasons, fee < 10_000n, "FEE_BPS_AT_OR_ABOVE_10000");
  push(reasons, start <= baseTime, "POOL_START_TIMESTAMP_FUTURE");
  push(reasons, lastUpdated <= baseTime, "RECEIVER_LAST_UPDATED_FUTURE");
  push(reasons, providerUpdated <= ethTime, "PROVIDER_LAST_UPDATED_FUTURE");
  const expectedDay = start <= baseTime ? (baseTime - start) / 86_400n : 0n;
  push(reasons, currentDay === expectedDay, "POOL_CURRENT_DAY_MISMATCH");
  const effectiveMinted = currentDay > lastDay ? 0n : minted;
  push(reasons, effectiveMinted <= limit, "POOL_DAILY_MINT_EXCEEDS_LIMIT");
  const expectedRemaining = effectiveMinted <= limit ? limit - effectiveMinted : 0n;
  push(reasons, remaining === expectedRemaining, "POOL_DAILY_HEADROOM_MISMATCH");
  push(reasons, limit > 0n, "DAILY_MINT_LIMIT_ZERO");
  push(reasons, remaining > 0n, "CURRENT_EFFECTIVE_DAILY_HEADROOM_ZERO");
  push(reasons, same(bp.wrsETH, ADDRESSES.base.wrapper), "POOL_WRAPPER_LINK_MISMATCH");
  push(reasons, same(bp.rsETHOracle, ADDRESSES.base.receiver), "POOL_RECEIVER_LINK_MISMATCH");
  push(reasons, same(br.rateProvider, ADDRESSES.ethereum.provider), "RECEIVER_PROVIDER_LINK_MISMATCH");
  push(reasons, same(ep.rsETHPriceOracle, ADDRESSES.ethereum.lrtOracle), "PROVIDER_ORACLE_LINK_MISMATCH");
  push(reasons, decimal(br.srcChainId) === BigInt(ROUTE.receiverExpectedSourceChainId), "RECEIVER_SOURCE_CHAIN_ID_MISMATCH");
  reasons.push(...providerRouteKillReasons(ep.routeSummary));
  push(reasons, bw.poolHasMinterRole === true, "POOL_MINTER_ROLE_MISSING");
  push(reasons, bw.canonicalAllowed === true, "CANONICAL_TOKEN_NOT_ALLOWED");
  push(reasons, bc.decimals === "18", "CANONICAL_DECIMALS_MISMATCH");
  push(reasons, reserve > 0n, "WRAPPER_CANONICAL_RESERVE_ZERO");
  const expectedMax = reserve > supply ? 0n : supply - reserve;
  push(reasons, maxCanonical === expectedMax, "WRAPPER_MAX_CANONICAL_DEPOSIT_MISMATCH");
  push(reasons, staleRate > 0n && poolRate > 0n && latest > 0n && providerGet > 0n && providerRate > 0n && oracleRate > 0n, "ZERO_RATE_OBSERVED");
  push(reasons, poolRate === staleRate, "POOL_RECEIVER_RATE_MISMATCH");
  push(reasons, latest === providerGet && latest === oracleRate, "SOURCE_RATE_VIEWS_MISMATCH");
  push(reasons, bp.paused === false, "POOL_PAUSED");
  push(reasons, b.contracts.pool.proxy.kind !== "DIRECT" && b.contracts.wrapper.proxy.kind !== "DIRECT", "POOL_OR_WRAPPER_NOT_EIP1967_PROXY");
  push(reasons, same(b.contracts.pool.proxy.admin || ZERO, ADDRESSES.base.proxyAdmin) && same(b.contracts.wrapper.proxy.admin || ZERO, ADDRESSES.base.proxyAdmin), "PROXY_ADMIN_MISMATCH");
  const receiverAge = lastUpdated <= baseTime ? baseTime - lastUpdated : 0n, providerAge = providerUpdated <= ethTime ? ethTime - providerUpdated : 0n;
  push(reasons, receiverAge >= BigInt(CAPS.staleThresholdSeconds), "RECEIVER_STALE_THRESHOLD_NOT_MET");
  const skew = baseTime > ethTime ? baseTime - ethTime : ethTime - baseTime;
  push(reasons, skew <= BigInt(CAPS.snapshotSkewSeconds), "CROSS_CHAIN_SNAPSHOT_SKEW_EXCEEDED");
  const d = divergence(staleRate, latest, fee);
  push(reasons, d.profitable, "DIVERGENCE_INEQUALITY_NOT_STRICT");
  const feasible = boundedFeasibleCase(remaining, reserve, staleRate, latest, fee);
  push(reasons, feasible !== null && feasible.evidenceFeasible === true, "BOUNDED_FEASIBLE_CASE_NOT_ESTABLISHED");
  const killReasons = [...new Set(reasons)].sort();
  return canonical({
    promotion: false,
    classification: killReasons.length === 1 && killReasons[0] === "SOURCE_RUNTIME_UNATTESTED" ? "BLOCKED/SOURCE-RUNTIME-UNATTESTED/DEPLOYMENT-EVIDENCE-ONLY" : "BLOCKED/DEPLOYMENT-BOUND/INVARIANT-OR-COVERAGE-FAILURE",
    killReasons,
    analysis: { receiverAgeSeconds: receiverAge.toString(), providerAgeSeconds: providerAge.toString(), snapshotSkewSeconds: skew.toString(), expectedCurrentDay: expectedDay.toString(), effectiveDailyMintAmount: effectiveMinted.toString(), expectedRemainingDailyMintLimit: expectedRemaining.toString(), divergenceLeft: d.lhs.toString(), divergenceRight: d.rhs.toString(), divergenceSignedMargin: d.signedMargin.toString(), divergenceStrict: d.profitable, boundedFeasibleCase: feasible },
  });
}

function leakScan(value, secrets = []) {
  const text = JSON.stringify(value), low = lower(text), findings = [];
  if (/(?:https?|wss?):\/\//i.test(text)) findings.push("URL_MATERIAL");
  if (/"(?:url|headers|authorization|apiKey|accessToken|secret|rawJson|rawRpc|rawResponse|responseBody|bytecode|deployedBytecode)"\s*:/i.test(text)) findings.push("FORBIDDEN_FIELD");
  if (/0x[0-9a-f]{66,}/i.test(text)) findings.push("RAW_HEX_OR_BYTECODE");
  if (/\bBearer\s+[A-Za-z0-9._~+\/-]+/i.test(text)) findings.push("AUTHORIZATION_TOKEN");
  for (const secret of secrets) if (String(secret).length >= 4 && low.includes(lower(secret))) findings.push("INVENTORY_MATERIAL");
  return { passed: findings.length === 0, findings: [...new Set(findings)].sort() };
}

async function executeCapture(options) {
  if (options?.captureMode !== true) stop("CAPTURE_MODE_REQUIRED");
  const inventory = parseInventoryText(options.inventoryText, { captureMode: true }), budget = new Budget(), transport = options.transport || fetchTransport;
  const selected = await qualifyEndpoints(inventory, budget, transport);
  const base = await captureBase(selected.base, budget, transport), ethereum = await captureEthereum(selected.ethereum, budget, transport);
  base.pin.terminalHeaderConsistent = await terminalRecheck(selected.base, "base", base.pin, budget, transport);
  ethereum.pin.terminalHeaderConsistent = await terminalRecheck(selected.ethereum, "ethereum", ethereum.pin, budget, transport);
  const outcome = evaluateCapture({ base, ethereum });
  const output = canonical({
    schemaVersion: SCHEMA_VERSION, findingId: FINDING_ID, sourceCommit: SOURCE_COMMIT, specSha256: SPEC_SHA256,
    sourceRuntimeAttested: SOURCE_RUNTIME_ATTESTED, captureMode: "READ_ONLY_LATEST_THEN_NUMBER_PINNED_WITH_TERMINAL_HEADER_CONSISTENCY", classification: outcome.classification, promotion: outcome.promotion,
    killReasons: outcome.killReasons, chains: { base, ethereum }, analysis: outcome.analysis,
    policy: { allowedMethods: ALLOWED_METHODS, caps: CAPS, plan: PLAN, retries: 0, stateOverrides: false, logs: false, traces: false, accounts: false, pinnedReadSemantics: "numeric block tags plus terminal same-number/hash/timestamp header consistency" },
    rpc: budget.summary(),
    safety: { inventoryReadInMemoryOnly: true, endpointMaterialPersisted: false, providerIdentityPersisted: false, rawRpcPersisted: false, rawBytecodePersisted: false, signing: false, transactions: false, broadcasts: false, stateMutation: false, networkOnlyInExplicitCaptureMode: true },
  });
  const leak = leakScan(output, inventory.secrets);
  if (!leak.passed) stop(`OUTPUT_LEAK_${leak.findings[0]}`);
  return output;
}

function staticCheck() {
  return { status: "PASS", mode: "offline-check-only", outputCreated: false, schemaVersion: SCHEMA_VERSION, sourceCommit: SOURCE_COMMIT, sourceRuntimeAttested: SOURCE_RUNTIME_ATTESTED, promotionPossibleDuringCapture: false, specSha256: SPEC_SHA256, allowedMethods: ALLOWED_METHODS.length, totalCallCap: CAPS.totalCalls };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--check-only")) {
    process.stdout.write(`${JSON.stringify(staticCheck())}\n`); return;
  }
  if (argv.length !== 1 || argv[0] !== "--capture") stop("CLI_ARGUMENTS_INVALID");
  if (fs.existsSync(OUTPUT)) stop("IMMUTABLE_OUTPUT_ALREADY_EXISTS");
  const inventoryText = fs.readFileSync(INVENTORY, "utf8");
  const output = await executeCapture({ captureMode: true, inventoryText });
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({ status: "PASS", classification: output.classification, promotion: output.promotion, rpcCalls: output.rpc.totalCalls, output: path.relative(ROOT, OUTPUT).replace(/\\/g, "/") })}\n`);
}

if (require.main === module) main().catch((error) => {
  const reason = error instanceof Stop ? error.code : "INTERNAL_FAILURE";
  process.stderr.write(`${JSON.stringify({ status: "STOPPED", reason })}\n`); process.exitCode = 1;
});

module.exports = {
  ROOT, OUTPUT, FINDING_ID, SCHEMA_VERSION, SOURCE_COMMIT, SOURCE_RUNTIME_ATTESTED, ZERO, ADDRESSES, ROUTE, SLOTS, SELECTORS, CAPS, PLAN,
  ALLOWED_METHODS, SPEC_SHA256, Stop, Budget, canonical, canonicalJson, specDescriptor, canonicalQuantity,
  strictHex, decodeWord, decodeUint, decodeAddress, decodeBool, strictHeader, addressWord, bytes32Word,
  decodeRateReceivers, summarizeProviderRoute, providerRouteKillReasons,
  callData, slotAddress, classifyProxy, summarizeCode, parseInventoryText, rpcBatch, divergence, decimal,
  enforceBatchCallCap, enforceRequestByteCap, enforceResponseByteCap, integerRoundedCase, boundedFeasibleCase,
  terminalHeaderConsistency, evaluateCapture, leakScan, executeCapture, staticCheck,
};
