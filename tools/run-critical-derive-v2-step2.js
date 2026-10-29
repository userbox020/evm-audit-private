#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets/derive-v2-core");
const OUT = path.join(ROOT, "reports/raw/fast/critical-derive-v2-cash-pnl-deployment-economics-step2.json");
const INVENTORIES = ["rpc_endpoints.txt", "graphql_endpoints.txt"];
const CHAINS = [957, 901];
const SCOPE_ID = "derive-v2-step2-readonly-scope-20260728";
const ALLOWED_RPC_METHODS = [
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_call",
  "eth_estimateGas",
  "eth_getLogs",
  "eth_gasPrice",
];
const SYNTHETIC_CALLER = "0x000000000000000000000000000000000000dEaD";
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BALANCE_ADJUSTED_TOPIC = "0x503ec09c1b4597d114eca849f7013c8c457988802d1dc5da49a0c461b5f88658";
const PA_WRONG_MANAGER = "0x534e40d8";
const LIMITS = {
  inventoryFiles: 2,
  endpointCandidatesProbed: 360,
  timeoutMs: 9000,
  rpcLogicalCalls: 6000,
  logCallsPerChain: 320,
  logsPerChain: 30000,
  discoveredAccountsPerChain: 1200,
  selectedFamiliesPerChain: 4,
  finalityProbeFamiliesPerChain: 12,
  responseBytes: 12 * 1024 * 1024,
};

const RUN_OPAQUE_KEY = crypto.randomBytes(32);
const sensitiveValues = new Set();
let rpcLogicalCalls = 0;
let rpcDispatchedCalls = 0;
let requestId = 1;

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function json(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8"));
}

function artifact(name) {
  return json(`targets/derive-v2-core/out/${name}.sol/${name}.json`);
}

function selector(name, signature) {
  const value = artifact(name).methodIdentifiers?.[signature];
  if (!value) fail(`missing local method identifier: ${name}.${signature}`);
  return `0x${value}`;
}

function wordUint(value) {
  const v = BigInt(value);
  if (v < 0n) fail("negative uint encoding");
  return v.toString(16).padStart(64, "0");
}

function wordAddress(value) {
  return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function calldata(methodSelector, words = []) {
  return `${methodSelector}${words.join("")}`;
}

function words(data) {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data) || (data.length - 2) % 64 !== 0) {
    fail("invalid ABI return data");
  }
  const hex = data.slice(2);
  return Array.from({ length: hex.length / 64 }, (_, i) => hex.slice(i * 64, (i + 1) * 64));
}

function uintWord(word) {
  return BigInt(`0x${word}`);
}

function intWord(word) {
  const value = uintWord(word);
  return value >= (1n << 255n) ? value - (1n << 256n) : value;
}

function addressWord(word) {
  return `0x${word.slice(24)}`.toLowerCase();
}

function quantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function parseCanonicalQuantity(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function parseGasEstimateResponse(response) {
  if (!response || response.ok !== true) return null;
  return parseCanonicalQuantity(response.result);
}

function parseGasPriceResponse(response) {
  if (!response || response.ok !== true) return null;
  return parseCanonicalQuantity(response.result);
}

function invalidGasPromotionOutcome() {
  return {
    grossBorrowerBenefitCash18: null,
    gasEstimate: null,
    gasPriceWei: null,
    gasCostCash18: null,
    attributedGrossCash18: null,
    callerRevenueCash18: null,
    callerNetCash18: null,
    netCash18: null,
    economicsBindingLiteralTrue: false,
    beneficiaryControlProofLiteralTrue: false,
    operationalPromotionLiteralTrue: false,
    executableNow: false,
  };
}

function validateBlockHeader(block, expectedNumber = null) {
  if (!block || typeof block !== "object" || Array.isArray(block)) return { ok: false, reason: "MALFORMED_HEADER" };
  const number = parseCanonicalQuantity(block.number);
  const timestamp = parseCanonicalQuantity(block.timestamp);
  if (number == null) return { ok: false, reason: "NONCANONICAL_BLOCK_NUMBER" };
  if (timestamp == null) return { ok: false, reason: "NONCANONICAL_TIMESTAMP" };
  if (!/^0x[0-9a-f]{64}$/.test(block.hash || "")) return { ok: false, reason: "MALFORMED_BLOCK_HASH" };
  if (expectedNumber != null && number !== BigInt(expectedNumber)) return { ok: false, reason: "RETURNED_NUMBER_MISMATCH" };
  return { ok: true, number, timestamp, hash: block.hash };
}

function terminalHeaderMatches(block, expectedNumber, expectedHash) {
  const header = validateBlockHeader(block, expectedNumber);
  return header.ok && header.hash === expectedHash;
}

function opaqueId(prefix, value, key = RUN_OPAQUE_KEY) {
  return `${prefix}-${crypto.createHmac("sha256", key).update(String(value), "utf8").digest("hex").slice(0, 24)}`;
}

function familyOpaqueId(url, key = RUN_OPAQUE_KEY) {
  return opaqueId("family", new URL(url).hostname.toLowerCase(), key);
}

function createLogicalBudget(limit) {
  return {
    limit,
    reserved: 0,
    dispatched: 0,
    reserve(count) {
      if (!Number.isSafeInteger(count) || count < 0 || this.reserved + count > this.limit) return false;
      this.reserved += count;
      return true;
    },
    dispatchReserved(count) {
      if (!Number.isSafeInteger(count) || count < 0 || this.dispatched + count > this.reserved) return false;
      this.dispatched += count;
      return true;
    },
  };
}

const logicalBudget = createLogicalBudget(LIMITS.rpcLogicalCalls);

function extractRevertSelector(error) {
  const seen = new Set();
  function walk(value) {
    if (value == null || seen.has(value)) return null;
    if (typeof value === "object") {
      seen.add(value);
      for (const child of Object.values(value)) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    }
    if (typeof value === "string") {
      const match = value.match(/0x[0-9a-fA-F]{8,}/);
      if (match) return match[0].slice(0, 10).toLowerCase();
    }
    return null;
  }
  return walk(error);
}

function parseInventoryText(text, sourceName, opaqueKey = RUN_OPAQUE_KEY) {
  const records = text.replace(/\\\//g, "/").split(/\r?\n[ \t]*\r?\n/);
  const parsed = [];
  for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
    const record = records[recordIndex];
    const urls = [...record.matchAll(/https?:\/\/[^\s"'`<>{}\[\]]+/gi)];
    if (!urls.length) continue;
    const headers = {};
    const origin = record.match(/\[origin:\s*([^\]\s]+)\]/i)?.[1];
    if (origin) headers.origin = origin;
    for (const header of record.matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/gi)) {
      headers[header[1].trim().toLowerCase()] = header[2].trim();
    }
    for (const match of urls) {
      let url;
      try {
        url = new URL(match[0].replace(/[)>`,.;\]]+$/g, "")).href;
      } catch {
        continue;
      }
      parsed.push({
        url,
        headers: { ...headers },
        sourceName,
        recordIndex,
        family: familyOpaqueId(url, opaqueKey),
        score: /\b(957|901)\b|derive|lyra/i.test(record) ? 10 : 0,
      });
    }
  }
  return parsed;
}

function parseInventory() {
  const byUrl = new Map();
  for (const rel of INVENTORIES) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const candidate of parseInventoryText(text, rel)) {
      const parsedUrl = new URL(candidate.url);
      sensitiveValues.add(candidate.url);
      sensitiveValues.add(parsedUrl.hostname.toLowerCase());
      if (parsedUrl.username) sensitiveValues.add(parsedUrl.username);
      if (parsedUrl.password) sensitiveValues.add(parsedUrl.password);
      for (const value of Object.values(candidate.headers)) if (value) sensitiveValues.add(value);
      const previous = byUrl.get(candidate.url);
      if (!previous || candidate.score > previous.score) byUrl.set(candidate.url, candidate);
    }
  }
  return [...byUrl.values()]
    .sort((a, b) => b.score - a.score || Buffer.compare(Buffer.from(a.family), Buffer.from(b.family)))
    .slice(0, LIMITS.endpointCandidatesProbed);
}

async function readResponseWithCeiling(response, ceiling) {
  if (!response.body || typeof response.body.getReader !== "function") return { ok: false, errorClass: "missing-stream" };
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > ceiling) {
      await reader.cancel();
      return { ok: false, errorClass: "response-cap" };
    }
    chunks.push(Buffer.from(value));
  }
  return { ok: true, bytes: Buffer.concat(chunks, bytes) };
}

async function post(candidate, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.timeoutMs);
  try {
    const response = await fetch(candidate.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...candidate.headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) return { ok: false, errorClass: `http-${response.status}` };
    const body = await readResponseWithCeiling(response, LIMITS.responseBytes);
    if (!body.ok) return body;
    let parsed;
    try {
      parsed = JSON.parse(body.bytes.toString("utf8"));
    } catch {
      return { ok: false, errorClass: "invalid-json" };
    }
    return { ok: true, parsed };
  } catch (error) {
    return { ok: false, errorClass: error?.name === "AbortError" ? "timeout" : "transport" };
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(candidate, method, params = [], reservation = null) {
  if (!ALLOWED_RPC_METHODS.includes(method)) return { ok: false, errorClass: "method-not-allowed" };
  if (reservation == null && !logicalBudget.reserve(1)) return { ok: false, errorClass: "logical-call-budget" };
  if (!logicalBudget.dispatchReserved(1)) return { ok: false, errorClass: "logical-call-budget" };
  rpcLogicalCalls = logicalBudget.reserved;
  rpcDispatchedCalls = logicalBudget.dispatched;
  const response = await post(candidate, { jsonrpc: "2.0", id: requestId++, method, params });
  if (!response.ok) return response;
  const parsed = response.parsed;
  if (parsed?.error) {
    return { ok: false, errorClass: "rpc-error", revertSelector: extractRevertSelector(parsed.error) };
  }
  if (!Object.prototype.hasOwnProperty.call(parsed || {}, "result")) return { ok: false, errorClass: "missing-result" };
  return { ok: true, result: parsed.result };
}

async function batch(candidate, calls) {
  if (calls.some((call) => !ALLOWED_RPC_METHODS.includes(call.method))) return calls.map(() => ({ ok: false, errorClass: "method-not-allowed" }));
  if (!logicalBudget.reserve(calls.length)) return calls.map(() => ({ ok: false, errorClass: "logical-call-budget" }));
  const reservation = { count: calls.length };
  if (!logicalBudget.dispatchReserved(calls.length)) return calls.map(() => ({ ok: false, errorClass: "logical-call-budget" }));
  rpcLogicalCalls = logicalBudget.reserved;
  rpcDispatchedCalls = logicalBudget.dispatched;
  const payload = calls.map((call) => ({ jsonrpc: "2.0", id: requestId++, method: call.method, params: call.params || [] }));
  const ids = payload.map((entry) => entry.id);
  const response = await post(candidate, payload);
  if (!response.ok || !Array.isArray(response.parsed)) {
    const out = [];
    for (const call of calls) {
      const fallback = await post(candidate, { jsonrpc: "2.0", id: requestId++, method: call.method, params: call.params || [] });
      if (!fallback.ok) out.push(fallback);
      else if (fallback.parsed?.error) out.push({ ok: false, errorClass: "rpc-error", revertSelector: extractRevertSelector(fallback.parsed.error) });
      else if (!Object.prototype.hasOwnProperty.call(fallback.parsed || {}, "result")) out.push({ ok: false, errorClass: "missing-result" });
      else out.push({ ok: true, result: fallback.parsed.result });
    }
    return out;
  }
  const byId = new Map(response.parsed.map((entry) => [entry.id, entry]));
  return ids.map((id) => {
    const entry = byId.get(id);
    if (!entry) return { ok: false, errorClass: "missing-result" };
    if (entry.error) return { ok: false, errorClass: "rpc-error", revertSelector: extractRevertSelector(entry.error) };
    return { ok: true, result: entry.result };
  });
}

async function ethCall(candidate, to, data, blockTag, from = SYNTHETIC_CALLER) {
  return rpc(candidate, "eth_call", [{ from, to, data }, blockTag]);
}

async function readStatic(candidate, to, data, blockTag, decoder) {
  const result = await ethCall(candidate, to, data, blockTag);
  if (!result.ok) return result;
  try {
    return { ok: true, value: decoder(words(result.result)) };
  } catch {
    return { ok: false, errorClass: "decode" };
  }
}

function oneUint(ws) { return uintWord(ws[0]); }
function oneInt(ws) { return intWord(ws[0]); }
function oneAddress(ws) { return addressWord(ws[0]); }

function localRuntimeComparison(runtimeHex, artifactName) {
  const localArtifact = artifact(artifactName);
  const object = localArtifact.deployedBytecode?.object;
  if (typeof object !== "string") return { status: "LOCAL_ARTIFACT_MISSING_RUNTIME" };
  const deployedHex = runtimeHex.replace(/^0x/, "").toLowerCase();
  const localChars = object.replace(/^0x/, "").split("");
  for (let i = 0; i < localChars.length; i++) if (!/[0-9a-fA-F]/.test(localChars[i])) localChars[i] = "0";
  const localHex = localChars.join("").toLowerCase();
  if (localHex.length !== deployedHex.length) {
    return { status: "QUALIFIED_LENGTH_MISMATCH", artifact: artifactName, deployedBytes: deployedHex.length / 2, localBytes: localHex.length / 2 };
  }
  const mask = [];
  for (const refs of Object.values(localArtifact.deployedBytecode.immutableReferences || {})) mask.push(...refs);
  for (const fileRefs of Object.values(localArtifact.deployedBytecode.linkReferences || {})) {
    for (const refs of Object.values(fileRefs)) mask.push(...refs);
  }
  const deployed = Buffer.from(deployedHex, "hex");
  const local = Buffer.from(localHex, "hex");
  for (const ref of mask) {
    deployed.fill(0, ref.start, ref.start + ref.length);
    local.fill(0, ref.start, ref.start + ref.length);
  }
  const deployedNormalizedSha256 = sha256(deployed);
  const localNormalizedSha256 = sha256(local);
  return {
    status: deployedNormalizedSha256 === localNormalizedSha256 ? "NORMALIZED_RUNTIME_MATCH" : "QUALIFIED_NORMALIZED_MISMATCH",
    artifact: artifactName,
    deployedBytes: deployed.length,
    localBytes: local.length,
    maskRanges: mask.length,
    deployedNormalizedSha256,
    localNormalizedSha256,
  };
}

function implementationFromSlot(value) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value || "")) return null;
  const address = `0x${value.slice(-40)}`.toLowerCase();
  return /^0x0{40}$/.test(address) ? null : address;
}

function classifyQualification({ inventoryCount, rpcFailures, parseableChainIds, targetMatches }) {
  if (inventoryCount === 0) return "EMPTY_INVENTORY";
  if (parseableChainIds === 0) return "NO_PARSEABLE_RESPONSES";
  if (targetMatches === 0) return "NO_TARGET_CHAIN_ID_MATCH";
  return "TARGET_CHAIN_ID_MATCH";
}

function classifyFinality(targetMatches, strictFinalizedHeaders) {
  if (targetMatches === 0) return "NO_TARGET_CHAIN_ID_MATCH";
  if (strictFinalizedHeaders === 0) return "TARGET_MATCH_NO_FINALIZED_PIN";
  return "TARGET_MATCH_FINALIZED_HEADER_AVAILABLE";
}

async function qualifyEndpoints() {
  const candidates = parseInventory();
  const qualified = { 957: [], 901: [] };
  const failureCounts = {};
  let rpcFailures = 0;
  let parseableChainIds = 0;
  let nonTargetChainIds = 0;
  let malformedChainIds = 0;
  let targetMatches = 0;
  for (const candidate of candidates) {
    const result = await rpc(candidate, "eth_chainId", []);
    if (!result.ok) {
      failureCounts[result.errorClass] = (failureCounts[result.errorClass] ?? 0) + 1;
      rpcFailures += 1;
      continue;
    }
    const parsed = parseCanonicalQuantity(result.result);
    if (parsed == null || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
      malformedChainIds += 1;
      continue;
    }
    parseableChainIds += 1;
    const chainId = Number(parsed);
    if (!CHAINS.includes(chainId)) {
      nonTargetChainIds += 1;
      continue;
    }
    targetMatches += 1;
    if (qualified[chainId].some((entry) => entry.family === candidate.family)) continue;
    qualified[chainId].push(candidate);
  }
  return {
    inventoryEmpty: candidates.length === 0,
    candidatesParsed: candidates.length,
    candidatesProbed: candidates.length,
    probesReserved: candidates.length,
    probesDispatched: candidates.length,
    rpcFailures,
    parseableChainIds,
    nonTargetChainIds,
    malformedChainIds,
    targetMatches,
    status: classifyQualification({ inventoryCount: candidates.length, rpcFailures, parseableChainIds, targetMatches }),
    failureCounts,
    qualified,
  };
}

async function selectPin(chainId, candidates) {
  const observations = [];
  const finalityFailureCounts = {};
  for (const candidate of candidates.slice(0, LIMITS.finalityProbeFamiliesPerChain)) {
    const result = await rpc(candidate, "eth_getBlockByNumber", ["finalized", false]);
    const header = result.ok ? validateBlockHeader(result.result) : null;
    if (!result.ok || !header?.ok) {
      const reason = result.ok ? header.reason : result.errorClass;
      finalityFailureCounts[reason] = (finalityFailureCounts[reason] ?? 0) + 1;
      continue;
    }
    observations.push({ candidate, finalizedNumber: header.number, finalizedHash: header.hash, finalizedTimestamp: header.timestamp });
  }
  if (!observations.length) return { ok: false, reason: "TARGET_MATCH_NO_FINALIZED_PIN", observations: 0, qualifiedFamilies: candidates.length, finalityFailureCounts };
  const commonNumber = observations.reduce((minimum, item) => item.finalizedNumber < minimum ? item.finalizedNumber : minimum, observations[0].finalizedNumber);
  const blockTag = quantity(commonNumber);
  const byHash = new Map();
  for (const observation of observations) {
    const block = await rpc(observation.candidate, "eth_getBlockByNumber", [blockTag, false]);
    const header = block.ok ? validateBlockHeader(block.result, commonNumber) : null;
    if (!block.ok || !header?.ok) continue;
    const hash = header.hash;
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push({ candidate: observation.candidate, block: block.result, header });
  }
  const groups = [...byHash.entries()].sort((a, b) => b[1].length - a[1].length);
  if (!groups.length) return { ok: false, reason: "COMMON_PIN_UNAVAILABLE", observations: observations.length, qualifiedFamilies: candidates.length, finalityFailureCounts };
  const [hash, selectedAll] = groups[0];
  const selected = selectedAll.slice(0, LIMITS.selectedFamiliesPerChain);
  return {
    ok: true,
    chainId,
    blockNumber: commonNumber,
    blockTag,
    blockHash: hash,
    timestamp: selected[0].header.timestamp,
    baseFeePerGas: selected[0].block.baseFeePerGas != null ? parseCanonicalQuantity(selected[0].block.baseFeePerGas) : null,
    selected,
    reportedFinalizedFamilies: observations.length,
    matchingFamilies: selected.length,
    qualifiedFamilies: candidates.length,
    finalityFailureCounts,
  };
}

function deployment(chainId) {
  const base = `targets/derive-v2-core/deployments/${chainId}`;
  return {
    core: json(`${base}/core.json`),
    eth: json(`${base}/ETH.json`),
    eth2: json(`${base}/ETH_2.json`),
    btc2: json(`${base}/BTC_2.json`),
  };
}

async function basicState(candidate, pin, dep) {
  const cash = dep.core.cash;
  const calls = [
    ["wrappedAsset", "CashAsset", "wrappedAsset()", oneAddress],
    ["rateModel", "CashAsset", "rateModel()", oneAddress],
    ["smId", "CashAsset", "smId()", oneUint],
    ["totalSupply", "CashAsset", "totalSupply()", oneUint],
    ["totalBorrow", "CashAsset", "totalBorrow()", oneUint],
    ["netSettledCash", "CashAsset", "netSettledCash()", oneInt],
    ["accruedSmFees", "CashAsset", "accruedSmFees()", oneUint],
    ["borrowIndex", "CashAsset", "borrowIndex()", oneUint],
    ["supplyIndex", "CashAsset", "supplyIndex()", oneUint],
    ["lastTimestamp", "CashAsset", "lastTimestamp()", oneUint],
    ["smFeePercentage", "CashAsset", "smFeePercentage()", oneUint],
    ["cashToStableExchangeRate", "CashAsset", "getCashToStableExchangeRate()", oneUint],
  ];
  const responses = await batch(candidate, calls.map((entry) => ({
    method: "eth_call",
    params: [{ from: SYNTHETIC_CALLER, to: cash, data: selector(entry[1], entry[2]) }, pin.blockTag],
  })));
  const state = {};
  for (let i = 0; i < calls.length; i++) {
    if (!responses[i].ok) return { ok: false, reason: `CASH_CALL_${calls[i][0]}` };
    try { state[calls[i][0]] = calls[i][3](words(responses[i].result)); } catch { return { ok: false, reason: `CASH_DECODE_${calls[i][0]}` }; }
  }
  const rateAddress = state.rateModel;
  const rateCalls = ["minRate()", "rateMultiplier()", "highRateMultiplier()", "optimalUtil()"];
  for (const signature of rateCalls) {
    const value = await readStatic(candidate, rateAddress, selector("InterestRateModel", signature), pin.blockTag, oneUint);
    if (!value.ok) return { ok: false, reason: `RATE_CALL_${signature}` };
    state[signature.slice(0, -2)] = value.value;
  }
  const lastAccount = await readStatic(candidate, dep.core.subAccounts, selector("SubAccounts", "lastAccountId()"), pin.blockTag, oneUint);
  if (!lastAccount.ok) return { ok: false, reason: "SUBACCOUNTS_LAST_ID" };
  state.lastAccountId = lastAccount.value;
  const stableSpot = await readStatic(candidate, dep.core.stableFeed, selector("LyraSpotFeed", "getSpot()"), pin.blockTag, (ws) => ({ price: uintWord(ws[0]), confidence: uintWord(ws[1]) }));
  const ethSpot = await readStatic(candidate, dep.eth.spotFeed, selector("LyraSpotFeed", "getSpot()"), pin.blockTag, (ws) => ({ price: uintWord(ws[0]), confidence: uintWord(ws[1]) }));
  state.stableSpot = stableSpot.ok ? stableSpot.value : null;
  state.nativeSpot = ethSpot.ok ? ethSpot.value : null;
  return { ok: true, state };
}

function stateDigest(state) {
  function serial(value) {
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) return value.map(serial);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serial(v)]));
    return value;
  }
  return sha256(Buffer.from(JSON.stringify(serial(state)), "utf8"));
}

async function managerAndPerpDiscovery(candidate, pin, dep) {
  const managers = [
    { type: "STANDARD", address: dep.core.srm.toLowerCase(), documented: true },
    { type: "LEGACY_PMRM_ETH", address: dep.eth.pmrm.toLowerCase(), documented: true, perp: dep.eth.perp.toLowerCase() },
    { type: "PMRM2_ETH", address: dep.eth2.pmrm2.toLowerCase(), documented: true },
    { type: "PMRM2_BTC", address: dep.btc2.pmrm2.toLowerCase(), documented: true },
  ];
  const lastMarket = await readStatic(candidate, dep.core.srm, selector("StandardManager", "lastMarketId()"), pin.blockTag, oneUint);
  if (lastMarket.ok) {
    managers[0].lastMarketId = lastMarket.value;
    const perps = [];
    for (let id = 1n; id <= lastMarket.value && id <= 64n; id++) {
      const result = await readStatic(
        candidate,
        dep.core.srm,
        calldata(selector("StandardManager", "assetMap(uint256,uint8)"), [wordUint(id), wordUint(2)]),
        pin.blockTag,
        oneAddress,
      );
      if (result.ok && result.value !== "0x0000000000000000000000000000000000000000") perps.push(result.value);
    }
    managers[0].perps = [...new Set(perps)];
  }
  for (const manager of managers.filter((entry) => entry.type.startsWith("PMRM2"))) {
    const result = await readStatic(candidate, manager.address, selector("PMRM_2", "perp()"), pin.blockTag, oneAddress);
    if (result.ok) manager.perp = result.value;
  }
  managers[1].perps = [managers[1].perp];
  for (const manager of managers.filter((entry) => entry.perp)) manager.perps = [manager.perp];
  return managers;
}

async function bindRuntimes(pin, dep, managers) {
  const primary = pin.selected[0].candidate;
  const contracts = [
    { role: "CashAsset", address: dep.core.cash.toLowerCase(), artifacts: ["CashAsset"] },
    { role: "PerpAsset_ETH", address: dep.eth.perp.toLowerCase(), artifacts: ["PerpAsset"] },
    { role: "StandardManager", address: dep.core.srm.toLowerCase(), artifacts: ["StandardManager"] },
    { role: "LegacyPMRM_ETH", address: dep.eth.pmrm.toLowerCase(), artifacts: ["PMRM"] },
    { role: "PMRM2_ETH", address: dep.eth2.pmrm2.toLowerCase(), artifacts: ["PMRM_2_1", "PMRM_2"] },
    { role: "PMRM2_BTC", address: dep.btc2.pmrm2.toLowerCase(), artifacts: ["PMRM_2_1", "PMRM_2"] },
    { role: "SubAccounts", address: dep.core.subAccounts.toLowerCase(), artifacts: ["SubAccounts"] },
    { role: "InterestRateModel", address: dep.core.rateModel.toLowerCase(), artifacts: ["InterestRateModel"] },
    { role: "SecurityModule", address: dep.core.securityModule.toLowerCase(), artifacts: ["SecurityModule"] },
  ];
  for (const manager of managers) {
    for (const perp of manager.perps || []) {
      if (!contracts.some((entry) => entry.address === perp)) contracts.push({ role: `PerpAsset_${manager.type}`, address: perp, artifacts: ["PerpAsset"] });
    }
  }
  const wrapped = await readStatic(primary, dep.core.cash, selector("CashAsset", "wrappedAsset()"), pin.blockTag, oneAddress);
  if (wrapped.ok) contracts.push({ role: "RelevantERC20", address: wrapped.value, artifacts: ["LyraERC20"] });
  const unique = [...new Map(contracts.map((entry) => [entry.address, entry])).values()];
  const results = [];
  for (const contract of unique) {
    const familyObservations = [];
    for (const selected of pin.selected) {
      const code = await rpc(selected.candidate, "eth_getCode", [contract.address, pin.blockTag]);
      const slot = await rpc(selected.candidate, "eth_getStorageAt", [contract.address, EIP1967_IMPLEMENTATION_SLOT, pin.blockTag]);
      familyObservations.push({
        family: selected.candidate.family,
        codePresent: code.ok && typeof code.result === "string" && code.result !== "0x",
        codeSha256: code.ok ? sha256(Buffer.from(code.result.replace(/^0x/, ""), "hex")) : null,
        implementation: slot.ok ? implementationFromSlot(slot.result) : null,
      });
    }
    const agreed = familyObservations.every((entry) => entry.codeSha256 === familyObservations[0].codeSha256 && entry.implementation === familyObservations[0].implementation);
    const implementation = familyObservations[0]?.implementation;
    const runtimeAddress = implementation || contract.address;
    const runtime = await rpc(primary, "eth_getCode", [runtimeAddress, pin.blockTag]);
    const comparisons = runtime.ok ? contract.artifacts.map((name) => localRuntimeComparison(runtime.result, name)) : [];
    const best = comparisons.find((entry) => entry.status === "NORMALIZED_RUNTIME_MATCH") || comparisons[0] || { status: "RUNTIME_UNAVAILABLE" };
    results.push({
      role: contract.role,
      address: contract.address,
      proxyImplementation: implementation,
      familyAgreement: agreed,
      familiesObserved: familyObservations.length,
      runtimeCodeSha256: runtime.ok ? sha256(Buffer.from(runtime.result.replace(/^0x/, ""), "hex")) : null,
      comparison: best,
    });
  }
  return results;
}

async function earliestCodeBlock(candidate, address, pinNumber) {
  let low = 0n;
  let high = pinNumber;
  const atPin = await rpc(candidate, "eth_getCode", [address, quantity(pinNumber)]);
  if (!atPin.ok || atPin.result === "0x") return null;
  while (low < high) {
    const mid = (low + high) >> 1n;
    const result = await rpc(candidate, "eth_getCode", [address, quantity(mid)]);
    if (!result.ok) return null;
    if (result.result === "0x") low = mid + 1n;
    else high = mid;
  }
  return low;
}

async function logsAdaptive(candidate, filter, from, to, budgetState) {
  if (from > to || budgetState.calls >= LIMITS.logCallsPerChain || budgetState.logs >= LIMITS.logsPerChain) return [];
  budgetState.calls += 1;
  const result = await rpc(candidate, "eth_getLogs", [{ ...filter, fromBlock: quantity(from), toBlock: quantity(to) }]);
  if (result.ok && Array.isArray(result.result)) {
    budgetState.logs += result.result.length;
    return result.result.slice(0, Math.max(0, LIMITS.logsPerChain - (budgetState.logs - result.result.length)));
  }
  if (from === to || budgetState.calls >= LIMITS.logCallsPerChain) return [];
  const mid = (from + to) >> 1n;
  const left = await logsAdaptive(candidate, filter, from, mid, budgetState);
  const right = await logsAdaptive(candidate, filter, mid + 1n, to, budgetState);
  return left.concat(right);
}

async function discoverCandidateAccounts(pin, dep, managers) {
  const primary = pin.selected[0].candidate;
  const subAccountsStart = await earliestCodeBlock(primary, dep.core.subAccounts, pin.blockNumber);
  const budget = { calls: 0, logs: 0 };
  const perps = [...new Set(managers.flatMap((manager) => manager.perps || []))];
  const byPerp = new Map();
  if (subAccountsStart != null) {
    for (const perp of perps) {
      const assetTopic = `0x${perp.slice(2).toLowerCase()}${"0".repeat(24)}`;
      const logs = await logsAdaptive(primary, {
        address: dep.core.subAccounts,
        topics: [BALANCE_ADJUSTED_TOPIC, null, null, assetTopic],
      }, subAccountsStart, pin.blockNumber, budget);
      const ids = [];
      for (const log of logs) {
        if (Array.isArray(log.topics) && log.topics[1]) ids.push(BigInt(log.topics[1]));
      }
      byPerp.set(perp, [...new Set(ids.map(String))].map(BigInt));
    }
  }
  const discoveredTotal = [...new Set([...byPerp.values()].flat().map(String))].length;
  const capped = discoveredTotal > LIMITS.discoveredAccountsPerChain;
  const records = [];
  let remaining = LIMITS.discoveredAccountsPerChain;
  for (const [perp, idsAll] of byPerp.entries()) {
    const ids = idsAll.slice(-remaining);
    remaining -= ids.length;
    if (!ids.length) continue;
    const calls = [];
    for (const id of ids) {
      calls.push({ method: "eth_call", params: [{ to: dep.core.subAccounts, data: calldata(selector("SubAccounts", "manager(uint256)"), [wordUint(id)]) }, pin.blockTag] });
      calls.push({ method: "eth_call", params: [{ to: dep.core.subAccounts, data: calldata(selector("SubAccounts", "getBalance(uint256,address,uint256)"), [wordUint(id), wordAddress(perp), wordUint(0)]) }, pin.blockTag] });
    }
    const first = await batch(primary, calls);
    for (let i = 0; i < ids.length; i++) {
      const managerResult = first[i * 2];
      const balanceResult = first[i * 2 + 1];
      if (!managerResult.ok || !balanceResult.ok) continue;
      let manager;
      let positionSize;
      try {
        manager = oneAddress(words(managerResult.result));
        positionSize = oneInt(words(balanceResult.result));
      } catch {
        continue;
      }
      if (positionSize === 0n) continue;
      const eligibleManager = managers.find((entry) => entry.address === manager && (entry.perps || []).includes(perp));
      if (!eligibleManager) continue;
      records.push({ id: ids[i], manager, managerType: eligibleManager.type, perp, positionSize });
    }
  }
  const detailCalls = [];
  for (const record of records) {
    detailCalls.push({ method: "eth_call", params: [{ to: record.perp, data: calldata(selector("PerpAsset", "positions(uint256)"), [wordUint(record.id)]) }, pin.blockTag] });
    detailCalls.push({ method: "eth_call", params: [{ to: record.perp, data: calldata(selector("PerpAsset", "getUnsettledAndUnrealizedCash(uint256)"), [wordUint(record.id)]) }, pin.blockTag] });
    detailCalls.push({ method: "eth_call", params: [{ from: SYNTHETIC_CALLER, to: record.manager, data: calldata("0x5d935799", [wordUint(record.id)]) }, pin.blockTag] });
    detailCalls.push({ method: "eth_estimateGas", params: [{ from: SYNTHETIC_CALLER, to: record.manager, data: calldata("0x5d935799", [wordUint(record.id)]) }, pin.blockTag] });
    detailCalls.push({ method: "eth_call", params: [{ from: SYNTHETIC_CALLER, to: record.perp, data: calldata("0x7540fec3", [wordUint(record.id)]) }, pin.blockTag] });
    detailCalls.push({ method: "eth_call", params: [{ from: SYNTHETIC_CALLER, to: dep.core.cash, data: calldata(selector("CashAsset", "calculateBalanceWithInterest(uint256)"), [wordUint(record.id)]) }, pin.blockTag] });
  }
  const details = await batch(primary, detailCalls);
  const candidates = [];
  for (let i = 0; i < records.length; i++) {
    const offset = i * 6;
    const [position, unsettled, managerCall, gas, directPerpCall, cashBalance] = details.slice(offset, offset + 6);
    if (!position.ok || !unsettled.ok) continue;
    let positionWords;
    let pendingNetCash;
    try {
      positionWords = words(position.result);
      pendingNetCash = oneInt(words(unsettled.result));
    } catch {
      continue;
    }
    const commitment = opaqueId("account", `${pin.chainId}|${pin.blockHash}|${records[i].id}`);
    candidates.push({
      accountCommitment: commitment,
      managerType: records[i].managerType,
      manager: records[i].manager,
      perp: records[i].perp,
      positionSize: records[i].positionSize,
      storedFunding: intWord(positionWords[1]),
      storedPnl: intWord(positionWords[2]),
      lastAggregatedFunding: intWord(positionWords[3]),
      pendingNetCash,
      managerSettlementEthCall: managerCall.ok ? "SUCCESS" : `REVERT_${managerCall.revertSelector || "UNCLASSIFIED"}`,
      gasEstimate: parseGasEstimateResponse(gas),
      directPerpSyntheticCall: directPerpCall.ok ? "UNEXPECTED_SUCCESS" : directPerpCall.revertSelector === PA_WRONG_MANAGER ? "PA_WRONG_MANAGER" : `REVERT_${directPerpCall.revertSelector || "UNCLASSIFIED"}`,
      cashBalanceWithInterest: cashBalance.ok ? oneInt(words(cashBalance.result)) : null,
    });
  }
  return {
    deploymentStartBlock: subAccountsStart,
    logCalls: budget.calls,
    logsObserved: budget.logs,
    discoveredAccountIds: discoveredTotal,
    scanCapped: capped,
    activeEligiblePositions: records.length,
    candidates,
  };
}

function unavailableEconomics(status, extras = {}) {
  return {
    status,
    ...invalidGasPromotionOutcome(),
    ...extras,
  };
}

async function calculateEconomics(pin, dep, state, discovery) {
  const primary = pin.selected[0].candidate;
  const valid = discovery.candidates.filter((entry) => entry.managerSettlementEthCall === "SUCCESS" && entry.pendingNetCash !== 0n);
  const losing = valid.filter((entry) => entry.pendingNetCash < 0n).sort((a, b) => a.pendingNetCash < b.pendingNetCash ? -1 : 1);
  const winning = valid.filter((entry) => entry.pendingNetCash > 0n).sort((a, b) => a.pendingNetCash > b.pendingNetCash ? -1 : 1);
  if (!losing.length || !winning.length) {
    return unavailableEconomics("NO_CURRENT_OPPOSITE_VALID_SETTLEMENT_PAIR", {
      validUnsettledCount: valid.length,
      losingCount: losing.length,
      winningCount: winning.length,
    });
  }
  const loser = losing[0];
  const winner = winning[0];
  const elapsed = pin.timestamp > state.lastTimestamp ? pin.timestamp - state.lastTimestamp : 0n;
  if (state.totalBorrow === 0n || elapsed === 0n) {
    return unavailableEconomics("NO_NONZERO_BORROW_AND_ELAPSED_INTEREST", {
      validUnsettledCount: valid.length,
      losingCount: losing.length,
      winningCount: winning.length,
      elapsedSeconds: elapsed,
      grossBorrowerBenefitCash18: "0",
    });
  }
  const baselineNet = state.netSettledCash;
  const loserNet = baselineNet + loser.pendingNetCash;
  const baselineRealSupply = state.totalSupply + (baselineNet < 0n ? -baselineNet : 0n);
  const loserRealSupply = state.totalSupply + (loserNet < 0n ? -loserNet : 0n);
  async function deployedUint(signature, args) {
    return readStatic(primary, state.rateModel, calldata(selector("InterestRateModel", signature), args.map(wordUint)), pin.blockTag, oneUint);
  }
  const baselineRate = await deployedUint("getBorrowRate(uint256,uint256)", [baselineRealSupply, state.totalBorrow]);
  const loserRate = await deployedUint("getBorrowRate(uint256,uint256)", [loserRealSupply, state.totalBorrow]);
  if (!baselineRate.ok || !loserRate.ok) return unavailableEconomics("DEPLOYED_RATE_CALL_UNAVAILABLE");
  const baselineFactor = await deployedUint("getBorrowInterestFactor(uint256,uint256)", [elapsed, baselineRate.value]);
  const loserFactor = await deployedUint("getBorrowInterestFactor(uint256,uint256)", [elapsed, loserRate.value]);
  if (!baselineFactor.ok || !loserFactor.ok) return unavailableEconomics("DEPLOYED_INTEREST_FACTOR_UNAVAILABLE");
  const baselineInterest = state.totalBorrow * baselineFactor.value / 10n ** 18n;
  const loserInterest = state.totalBorrow * loserFactor.value / 10n ** 18n;
  const gross = baselineInterest > loserInterest ? baselineInterest - loserInterest : 0n;
  const smDelta = gross * state.smFeePercentage / 10n ** 18n;
  const supplierDelta = gross - smDelta;
  if (loser.gasEstimate == null || winner.gasEstimate == null) {
    return unavailableEconomics("GAS_ESTIMATE_INVALID_OR_NONCANONICAL");
  }
  const gasEstimate = loser.gasEstimate + winner.gasEstimate;
  const gasPrice = await rpc(primary, "eth_gasPrice", []);
  const gasPriceWei = parseGasPriceResponse(gasPrice);
  if (gasPriceWei == null) {
    return unavailableEconomics("GAS_PRICE_INVALID_OR_NONCANONICAL");
  }
  let gasCostCash = null;
  if (gasPriceWei != null && state.nativeSpot?.price && state.stableSpot?.price && state.cashToStableExchangeRate > 0n) {
    const gasCostUsd18 = gasEstimate * gasPriceWei * state.nativeSpot.price / 10n ** 18n;
    const cashUsd18 = state.cashToStableExchangeRate * state.stableSpot.price / 10n ** 18n;
    gasCostCash = (gasCostUsd18 * 10n ** 18n + cashUsd18 - 1n) / cashUsd18;
  }
  const beneficiaryControlProofLiteralTrue = false;
  const attributedGross = null;
  const net = null;
  return {
    status: "CURRENT_PAIR_ANALYTICAL_SOURCE_BOUND_NO_SEQUENTIAL_STATE_EXECUTION",
    computationMode: "analytical using pinned deployed getters; independent eth_call cannot sequence settlement state",
    loserCommitment: loser.accountCommitment,
    winnerCommitment: winner.accountCommitment,
    loserManagerType: loser.managerType,
    winnerManagerType: winner.managerType,
    loserPendingNetCash18: loser.pendingNetCash,
    winnerPendingNetCash18: winner.pendingNetCash,
    loserValidCurrent: true,
    winnerValidCurrent: true,
    idempotenceUnsatisfiedAtPin: true,
    validUnsettledCount: valid.length,
    losingCount: losing.length,
    winningCount: winning.length,
    elapsedSeconds: elapsed,
    totalSupply18: state.totalSupply,
    totalBorrow18: state.totalBorrow,
    currentNetSettledCash18: state.netSettledCash,
    baselineRealSupply18: baselineRealSupply,
    loserFirstRealSupply18: loserRealSupply,
    baselineBorrowRate18: baselineRate.value,
    loserFirstBorrowRate18: loserRate.value,
    baselineInterestFactor18: baselineFactor.value,
    loserFirstInterestFactor18: loserFactor.value,
    baselineInterest18: baselineInterest,
    loserFirstInterest18: loserInterest,
    grossBorrowerBenefitCash18: gross,
    smLossCash18: smDelta,
    supplierLossCash18: supplierDelta,
    gasEstimate,
    gasPriceWei,
    nativeTokenPriceUsd18: state.nativeSpot?.price ?? null,
    stableTokenPriceUsd18: state.stableSpot?.price ?? null,
    cashToStableExchangeRate18: state.cashToStableExchangeRate,
    gasCostCash18: gasCostCash,
    attributedBorrowerCommitment: null,
    attributedBorrowerDebtCash18: null,
    attributedGrossCash18: attributedGross,
    netCash18: net,
    callerRevenueCash18: null,
    callerNetCash18: null,
    beneficiaryControlProofLiteralTrue,
    economicsBindingLiteralTrue: gross > 0n && gasCostCash != null,
    callerAttribution: "aggregate borrower benefit may exist, but control or receipt by the synthetic caller is unproven; caller revenue and net remain null",
    competition: "both settlement calls are public and caller-independent; no exclusivity, ordering can be raced, and pin opportunity is ephemeral",
    setupDistinction: "only current nonzero positions and pending settlement values at the fixed pin are counted; no position opening or exogenous setup is included",
  };
}

function serial(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serial);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, serial(child)]));
  return value;
}

function leakGuard(texts, secrets = sensitiveValues) {
  for (const [label, text] of texts) {
    if (/https?:\/\/|wss?:\/\//i.test(text)) return { ok: false, reason: `URL_LEAK_${label}` };
    if (/\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/i.test(text)) {
      return { ok: false, reason: `CREDENTIAL_LEAK_${label}` };
    }
    const lower = text.toLowerCase();
    for (const secret of secrets) {
      if (typeof secret === "string" && secret.length >= 4 && lower.includes(secret.toLowerCase())) {
        return { ok: false, reason: `INVENTORY_VALUE_LEAK_${label}` };
      }
    }
  }
  return { ok: true };
}

async function terminalRecheck(pin) {
  const observations = [];
  for (const selected of pin.selected) {
    const block = await rpc(selected.candidate, "eth_getBlockByNumber", [pin.blockTag, false]);
    observations.push({ family: selected.candidate.family, pass: block.ok && terminalHeaderMatches(block.result, pin.blockNumber, pin.blockHash) });
  }
  return observations;
}

function documentedAddresses(dep) {
  return {
    cash: dep.core.cash,
    rateModel: dep.core.rateModel,
    securityModule: dep.core.securityModule,
    standardManager: dep.core.srm,
    subAccounts: dep.core.subAccounts,
    ethPerp: dep.eth.perp,
    legacyPmrm: dep.eth.pmrm,
    ethPmrm2: dep.eth2.pmrm2,
    btcPmrm2: dep.btc2.pmrm2,
    relevantErc20: null,
  };
}

function blockedChainResult(chainId, dep, options = {}) {
  return {
    chainId,
    coverage: "BLOCKED",
    status: options.status ?? "NO_TARGET_CHAIN_ID_MATCH",
    reason: options.reason ?? "NO_TARGET_CHAIN_ID_MATCH",
    qualifiedFamilies: options.qualifiedFamilies ?? 0,
    finalityAttempted: options.finalityAttempted ?? false,
    reportedFinalizedFamilies: options.reportedFinalizedFamilies ?? 0,
    finalityFailureCounts: options.finalityFailureCounts ?? {},
    documentedAddresses: documentedAddresses(dep),
    pin: null,
    runtimeBindings: null,
    currentState: null,
    currentSupply18: null,
    currentBorrow18: null,
    currentAccountCandidateCount: null,
    activeEligiblePositionCount: null,
    orderSensitivePairCount: null,
    economics: {
      grossBorrowerBenefitCash18: null,
      gasEstimate: null,
      gasPriceWei: null,
      gasCostCash18: null,
      attributedGrossCash18: null,
      netCash18: null,
      callerRevenueCash18: null,
      callerNetCash18: null,
      beneficiaryControlProofLiteralTrue: false,
      economicsBindingLiteralTrue: false,
    },
    gates: {
      strictTargetQualificationLiteralTrue: options.strictTargetQualificationLiteralTrue ?? false,
      finalizedPinLiteralTrue: options.finalizedPinLiteralTrue ?? false,
      terminalExactHeaderLiteralTrue: options.terminalExactHeaderLiteralTrue ?? false,
      allSelectedFamilyReadsSucceededLiteralTrue: options.allSelectedFamilyReadsSucceededLiteralTrue ?? false,
      allSelectedFamilyStateAgreementLiteralTrue: options.allSelectedFamilyStateAgreementLiteralTrue ?? false,
      allRequiredNormalizedRuntimeMatchLiteralTrue: options.allRequiredNormalizedRuntimeMatchLiteralTrue ?? false,
      economicsBindingLiteralTrue: options.economicsBindingLiteralTrue ?? false,
      beneficiaryCallerControlLiteralTrue: options.beneficiaryCallerControlLiteralTrue ?? false,
      operationalPromotionLiteralTrue: false,
    },
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    fork: false,
  };
}

async function runChain(chainId, qualified) {
  const dep = deployment(chainId);
  if (!qualified.length) return blockedChainResult(chainId, dep, { status: "NO_TARGET_CHAIN_ID_MATCH", reason: "NO_TARGET_CHAIN_ID_MATCH", qualifiedFamilies: 0, finalityAttempted: false });
  const pin = await selectPin(chainId, qualified);
  if (!pin.ok) return blockedChainResult(chainId, dep, {
    status: classifyFinality(qualified.length, 0),
    reason: classifyFinality(qualified.length, 0),
    qualifiedFamilies: pin.qualifiedFamilies,
    finalityAttempted: true,
    strictTargetQualificationLiteralTrue: true,
    reportedFinalizedFamilies: pin.observations,
    finalityFailureCounts: pin.finalityFailureCounts,
  });
  const familyStates = [];
  for (const selected of pin.selected) {
    const snapshot = await basicState(selected.candidate, pin, dep);
    familyStates.push({ family: selected.candidate.family, ok: snapshot.ok, digest: snapshot.ok ? stateDigest(snapshot.state) : null, state: snapshot.ok ? snapshot.state : null });
  }
  const allSelectedFamilyReadsSucceeded = familyStates.length === pin.selected.length && familyStates.every((entry) => entry.ok);
  if (!allSelectedFamilyReadsSucceeded) return blockedChainResult(chainId, dep, {
    status: "SELECTED_FAMILY_STATE_READ_FAILED",
    reason: "SELECTED_FAMILY_STATE_READ_FAILED",
    qualifiedFamilies: pin.qualifiedFamilies,
    finalityAttempted: true,
    strictTargetQualificationLiteralTrue: true,
    finalizedPinLiteralTrue: true,
    reportedFinalizedFamilies: pin.reportedFinalizedFamilies,
    finalityFailureCounts: pin.finalityFailureCounts,
  });
  const stateAgreement = familyStates.every((entry) => entry.digest === familyStates[0].digest);
  if (!stateAgreement) return blockedChainResult(chainId, dep, {
    status: "SELECTED_FAMILY_STATE_DISAGREEMENT",
    reason: "SELECTED_FAMILY_STATE_DISAGREEMENT",
    qualifiedFamilies: pin.qualifiedFamilies,
    finalityAttempted: true,
    strictTargetQualificationLiteralTrue: true,
    finalizedPinLiteralTrue: true,
    allSelectedFamilyReadsSucceededLiteralTrue: true,
    reportedFinalizedFamilies: pin.reportedFinalizedFamilies,
    finalityFailureCounts: pin.finalityFailureCounts,
  });
  const state = familyStates[0].state;
  const managers = await managerAndPerpDiscovery(pin.selected[0].candidate, pin, dep);
  const runtimeBindings = await bindRuntimes(pin, dep, managers);
  const discovery = await discoverCandidateAccounts(pin, dep, managers);
  const economics = await calculateEconomics(pin, dep, state, discovery);
  const terminal = await terminalRecheck(pin);
  const terminalPass = terminal.length > 0 && terminal.every((entry) => entry.pass);
  const runtimeAllAgreed = runtimeBindings.every((entry) => entry.familyAgreement);
  const allRequiredNormalizedRuntimeMatch = runtimeBindings.length > 0 && runtimeBindings.every((entry) => entry.familyAgreement && entry.comparison?.status === "NORMALIZED_RUNTIME_MATCH");
  const economicsBinding = economics.economicsBindingLiteralTrue === true;
  const beneficiaryControl = economics.beneficiaryControlProofLiteralTrue === true;
  const operationalPositive = terminalPass && allSelectedFamilyReadsSucceeded && stateAgreement && runtimeAllAgreed
    && allRequiredNormalizedRuntimeMatch && economicsBinding && beneficiaryControl && economics.callerNetCash18 != null
    && economics.callerNetCash18 > 0n && pin.matchingFamilies >= 2;
  return {
    chainId,
    coverage: pin.matchingFamilies >= 2 ? "MULTI_FAMILY_REPORTED_FINALIZED" : "SINGLE_FAMILY_REPORTED_FINALIZED",
    noBackendIndependenceClaim: true,
    pin: {
      blockNumber: pin.blockNumber,
      blockHash: pin.blockHash,
      timestamp: pin.timestamp,
      reportedFinalizedFamilies: pin.reportedFinalizedFamilies,
      matchingFamilies: pin.matchingFamilies,
      familyOpaqueIds: pin.selected.map((entry) => entry.candidate.family),
      terminalRecheck: terminal,
      literalTrue: terminalPass,
    },
    documentedAddresses: { ...documentedAddresses(dep), relevantErc20: state.wrappedAsset },
    stateAgreement: { literalTrue: stateAgreement, agreeingFamilies: familyStates.length, observedFamilies: familyStates.length, digest: familyStates[0].digest },
    currentState: state,
    managers,
    runtimeBindings,
    runtimeFamilyAgreementLiteralTrue: runtimeAllAgreed,
    discovery,
    economics,
    routePositive: operationalPositive ? 1 : 0,
    executableNow: operationalPositive ? 1 : 0,
    signedActionJustified: false,
    fork: false,
    gates: {
      strictTargetQualificationLiteralTrue: true,
      finalizedPinLiteralTrue: true,
      terminalExactHeaderLiteralTrue: terminalPass,
      allSelectedFamilyReadsSucceededLiteralTrue: allSelectedFamilyReadsSucceeded,
      allSelectedFamilyStateAgreementLiteralTrue: stateAgreement,
      allRequiredNormalizedRuntimeMatchLiteralTrue: allRequiredNormalizedRuntimeMatch,
      economicsBindingLiteralTrue: economicsBinding,
      beneficiaryCallerControlLiteralTrue: beneficiaryControl,
      operationalPromotionLiteralTrue: operationalPositive,
    },
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const qualification = await qualifyEndpoints();
  const chains = [];
  for (const chainId of CHAINS) chains.push(await runChain(chainId, qualification.qualified[chainId]));
  const routePositive = chains.some((entry) => entry.routePositive === 1) ? 1 : 0;
  const coveredChains = chains.filter((entry) => entry.coverage !== "BLOCKED").length;
  const classification = coveredChains === 0 && qualification.status === "NO_TARGET_CHAIN_ID_MATCH"
    ? "SOURCE-PROVEN/DEPLOYMENT-COVERAGE-BLOCKED/NO-TARGET-CHAIN-ID-MATCH/NO-CURRENT-STATE-OR-ECONOMICS-BINDING"
    : coveredChains === 0
      ? "SOURCE-PROVEN/DEPLOYMENT-COVERAGE-BLOCKED/NO-CURRENT-STATE-OR-ECONOMICS-BINDING"
    : routePositive
      ? "CURRENT-ROUTE-POSITIVE-READ-ONLY-BINDING/FORK-DEFERRED"
      : "SOURCE-PROVEN/CURRENT-EXPOSURE-BOUND/NO-OPERATIONAL-POSITIVE-ROUTE-ESTABLISHED";
  const result = {
    schemaVersion: 2,
    runId: `derive-v2-step2-${startedAt.replace(/[-:.TZ]/g, "")}`,
    generatedAt: new Date().toISOString(),
    classification,
    predecessor: {
      step1ManifestPath: "reports/raw/fast/critical-derive-v2-cash-wrapped-pnl-funding-step1-manifest.json",
      step1ManifestSha256: sha256(fs.readFileSync(path.join(ROOT, "reports/raw/fast/critical-derive-v2-cash-wrapped-pnl-funding-step1-manifest.json"))),
      step1AggregateSha256: json("reports/raw/fast/critical-derive-v2-cash-wrapped-pnl-funding-step1-manifest.json").aggregateSha256,
      sourceCommit: "96796a61dcb1dc852e25518b00cc1a79fb3caeeb",
    },
    authorizationProvenance: {
      scopeId: SCOPE_ID,
      authorizedInventoryFilenames: [...INVENTORIES],
      allowedRpcMethods: [...ALLOWED_RPC_METHODS],
      budgets: { ...LIMITS },
      prohibitedOperations: ["network outside authorized inventories", "transactions", "signing", "broadcast", "state mutation", "state override", "live exploit calls", "fork before independently reviewable positive economics"],
    },
    captureSafety: {
      redirectsRejected: true,
      streamingResponseByteCeiling: true,
      endpointMaterialPersisted: false,
      rawResponsesPersisted: false,
      victimIdentitiesPersisted: false,
      opaqueIdentityMode: "run-scoped HMAC with random in-memory nonpersisted key",
      preWriteLeakGuardLiteralTrue: true,
      signedTransactions: false,
      transactions: false,
      stateMutation: false,
      liveExploitCalls: false,
      stateOverrides: false,
      fork: false,
    },
    qualification: {
      status: qualification.status,
      inventoryEmpty: qualification.inventoryEmpty,
      candidatesParsed: qualification.candidatesParsed,
      candidatesProbed: qualification.candidatesProbed,
      probesReserved: qualification.probesReserved,
      probesDispatched: qualification.probesDispatched,
      rpcFailures: qualification.rpcFailures,
      parseableSuccessfulChainIds: qualification.parseableChainIds,
      successfulNonTargetChainIds: qualification.nonTargetChainIds,
      malformedOrNullChainIdsRejected: qualification.malformedChainIds,
      targetChainIdMatches: qualification.targetMatches,
      finalityAttempted: qualification.targetMatches > 0,
      failureCounts: qualification.failureCounts,
    },
    budgets: {
      limits: LIMITS,
      actual: {
        inventoryReads: INVENTORIES.length,
        candidatesParsed: qualification.candidatesParsed,
        probesReserved: qualification.probesReserved,
        probesDispatched: qualification.probesDispatched,
        rpcLogicalCallsReserved: rpcLogicalCalls,
        rpcLogicalCallsDispatched: rpcDispatchedCalls,
      },
    },
    chains,
    gates: {
      routePositive,
      executableNow: routePositive,
      signedActionJustified: false,
      fork: false,
      inventoryNonEmptyLiteralTrue: !qualification.inventoryEmpty,
      strictQualificationCompletedLiteralTrue: true,
      targetChainIdMatchedLiteralTrue: qualification.targetMatches > 0,
      finalityAttemptedLiteralTrue: qualification.targetMatches > 0,
      finalizedPinLiteralTrue: coveredChains > 0,
      terminalExactHeaderLiteralTrue: coveredChains > 0 && chains.filter((entry) => entry.coverage !== "BLOCKED").every((entry) => entry.gates?.terminalExactHeaderLiteralTrue === true),
      allSelectedFamilyReadsSucceededLiteralTrue: coveredChains > 0 && chains.filter((entry) => entry.coverage !== "BLOCKED").every((entry) => entry.gates?.allSelectedFamilyReadsSucceededLiteralTrue === true),
      allSelectedFamilyStateAgreementLiteralTrue: coveredChains > 0 && chains.filter((entry) => entry.coverage !== "BLOCKED").every((entry) => entry.gates?.allSelectedFamilyStateAgreementLiteralTrue === true),
      allRequiredNormalizedRuntimeMatchLiteralTrue: coveredChains > 0 && chains.filter((entry) => entry.coverage !== "BLOCKED").every((entry) => entry.gates?.allRequiredNormalizedRuntimeMatchLiteralTrue === true),
      economicsBindingLiteralTrue: coveredChains > 0 && chains.filter((entry) => entry.coverage !== "BLOCKED").every((entry) => entry.gates?.economicsBindingLiteralTrue === true),
      beneficiaryCallerControlLiteralTrue: coveredChains > 0 && chains.filter((entry) => entry.coverage !== "BLOCKED").every((entry) => entry.gates?.beneficiaryCallerControlLiteralTrue === true),
      operationalPromotionLiteralTrue: chains.some((entry) => entry.gates?.operationalPromotionLiteralTrue === true),
    },
    limitations: [
      "Run-scoped opaque family IDs do not establish backend or operator independence.",
      "Settlement order is computed analytically from pinned deployed getters because independent eth_call does not preserve sequential state.",
      "Candidate discovery is bounded by log and account caps; any cap is explicit per chain.",
      "Account identifiers and owners are not persisted; future successful captures use run-scoped opaque HMAC IDs with a random nonpersisted key.",
      "Gas price is a read-only current observation while all state/economics inputs are fixed-pin unless stated otherwise.",
    ],
  };
  const outputText = `${JSON.stringify(serial(result), null, 2)}\n`;
  const artifactTexts = [["capture", outputText]];
  for (const rel of [
    "reports/critical-derive-v2-cash-pnl-deployment-economics-step2.md",
    "coordination/inbox/critical/20260728-critical-derive-v2-cash-pnl-deployment-economics-step2.json",
    "coordination/handoffs/20260728-critical-derive-v2-cash-pnl-deployment-economics-step2-handoff.md",
  ]) {
    const absolute = path.join(ROOT, ...rel.split("/"));
    if (fs.existsSync(absolute)) artifactTexts.push([rel, fs.readFileSync(absolute, "utf8")]);
  }
  const leakCheck = leakGuard(artifactTexts);
  if (!leakCheck.ok) fail("pre-write leak guard rejected output");
  fs.writeFileSync(OUT, outputText, "utf8");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    classification: result.classification,
    qualificationStatus: qualification.status,
    chainCoverage: chains.map((entry) => ({
      chainId: entry.chainId,
      coverage: entry.coverage,
      pin: entry.pin?.blockNumber ?? null,
      candidates: entry.currentAccountCandidateCount ?? null,
      routePositive: entry.routePositive,
    })),
    routePositive,
    fork: false,
    output: path.relative(ROOT, OUT).replace(/\\/g, "/"),
  })}\n`);
  setTimeout(() => process.exit(0), 0);
}

if (require.main === module) main().catch((error) => {
  const safe = /budget/i.test(error?.message || "") ? "budget" : "internal";
  process.stderr.write(`derive-v2-step2 failed:${safe}\n`);
  process.exit(1);
});

module.exports = {
  blockedChainResult,
  classifyFinality,
  classifyQualification,
  createLogicalBudget,
  leakGuard,
  opaqueId,
  invalidGasPromotionOutcome,
  parseCanonicalQuantity,
  parseGasEstimateResponse,
  parseGasPriceResponse,
  parseInventoryText,
  readResponseWithCeiling,
  terminalHeaderMatches,
  validateBlockHeader,
};
