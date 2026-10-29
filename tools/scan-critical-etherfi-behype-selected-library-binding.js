#!/usr/bin/env node
"use strict";

// Fresh fixed-pin, read-only LayerZero selected-library binding. Endpoint
// inventory values exist only in memory and are never logged, hashed, or
// persisted. No transaction, signing, fork, economics, or state mutation.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AbiCoder, Interface, getAddress, keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-selected-library-binding";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-22-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-22-${NAME}-handoff.md`;
const RPC_INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const GRAPHQL_INVENTORY = path.join(ROOT, "graphql_endpoints.txt");
const R6_RAW = "reports/raw/fast/critical-etherfi-behype-endpoint-coverage-repair.json";
const R6_MANIFEST = "reports/raw/fast/critical-etherfi-behype-endpoint-coverage-repair-manifest.json";
const LZ_SOURCES = [
  "targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts/MessageLibManager.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts/EndpointV2.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts/interfaces/IMessageLibManager.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts/interfaces/IMessageLib.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/messagelib/contracts/uln/uln302/SendUln302.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/messagelib/contracts/uln/uln302/ReceiveUln302.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/messagelib/contracts/SendLibBase.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/messagelib/contracts/uln/UlnBase.sol",
];
const REVISION = "etherfi-behype-selected-library-binding-r7-fixed-pin-sanitized";
const AGENT = "critical-etherfi-behype-library-binding-r7-20260722";
const CLASSIFICATION = "WATCH/COVERAGE_OPEN/SELECTED-LIBRARY-SEMANTICS-BOUND/EXACT-RUNTIME-PROVENANCE-QUALIFIED";
const LZ_COMMIT = "9c741e7f9790639537b1710a203bcdfd73b0b9ac";
const EXPECTED_VERSION = { major: "3", minor: 0, endpointVersion: 2 };
const WINDOW_BLOCKS = 64;
const CALL_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 5500;
const ABI = AbiCoder.defaultAbiCoder();

const CHAINS = {
  optimism: {
    chainId: 10,
    endpoint: "0x1a44076050125825900e736c501f859c50fe728c",
    routes: [
      { id: "optimism-whype-send-30367", asset: "WHYPE", direction: "send", app: "0xd83e3d560ba6f05094d9d8b3eb8aaea571d1864e", remoteEid: 30367, applicableConfigTypes: [1, 2] },
      { id: "optimism-behype-receive-30367", asset: "beHYPE", direction: "receive", app: "0xa519afbc91986c0e7501d7e34968fee51cd901ac", remoteEid: 30367, applicableConfigTypes: [2] },
    ],
  },
  hyperevm: {
    chainId: 999,
    endpoint: "0x3a73033c0b1407574c76bdbaac67f126f6b4a9aa9",
    routes: [
      { id: "hyperevm-whype-receive-30111", asset: "WHYPE", direction: "receive", app: "0x2b7e48511ea616101834f09945c11f7d78d9136d", remoteEid: 30111, applicableConfigTypes: [2] },
      { id: "hyperevm-behype-send-30111", asset: "beHYPE", direction: "send", app: "0x637de4a55cdd37700f9b54451b709b01040d48df", remoteEid: 30111, applicableConfigTypes: [1, 2] },
    ],
  },
};

const ENDPOINT_IFACE = new Interface([
  "function getSendLibrary(address,uint32) view returns(address)",
  "function isDefaultSendLibrary(address,uint32) view returns(bool)",
  "function getReceiveLibrary(address,uint32) view returns(address,bool)",
  "function isRegisteredLibrary(address) view returns(bool)",
  "function getConfig(address,address,uint32,uint32) view returns(bytes)",
]);
const LIB_IFACE = new Interface([
  "function messageLibType() view returns(uint8)",
  "function version() view returns(uint64,uint8,uint8)",
  "function isSupportedEid(uint32) view returns(bool)",
  "function getConfig(uint32,address,uint32) view returns(bytes)",
]);
const OAPP_IFACE = new Interface([
  "function endpoint() view returns(address)",
  "function peers(uint32) view returns(bytes32)",
]);
const BEACON_IFACE = new Interface(["function implementation() view returns(address)"]);
const EIP1967 = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e01970b5aee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
};
const MESSAGE_LIB_TYPES = { 0: "Send", 1: "Receive", 2: "SendAndReceive" };

const abs = (rel) => path.join(ROOT, rel);
const lower = (value) => typeof value === "string" ? value.toLowerCase() : value;
const hex = (value) => `0x${Number(value).toString(16)}`;
const num = (value) => typeof value === "string" && /^0x/i.test(value) ? Number(BigInt(value)) : Number(value);
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { path: rel, bytes: body.length, sha256: sha(body) }; };
const address = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? lower(getAddress(value)) : null;
const nonzeroAddressFromWord = (word) => { if (typeof word !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(word)) return null; const out = address(`0x${word.slice(-40)}`); return out === "0x0000000000000000000000000000000000000000" ? null : out; };

function writeOwned(rel, text) {
  if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error("write-refused");
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text, "utf8");
}

function errorClass(error) {
  const status = Number(error?.status); const code = Number(error?.code); const text = String(error?.message || error || "").toLowerCase();
  if (status === 401 || status === 403) return "auth-or-origin-rejected";
  if (status === 429 || text.includes("rate")) return "rate-limited";
  if (code === -32601 || text.includes("method not found")) return "method-unsupported";
  if (text.includes("abort") || text.includes("timeout")) return "timeout";
  if (status >= 400 && status < 500) return "http-4xx";
  if (status >= 500) return "http-5xx";
  if (text.includes("json")) return "invalid-json";
  return "rpc-or-transport-error";
}

let rpcId = 1;
async function rpc(url, method, params, timeout = CALL_TIMEOUT_MS) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) });
    if (!response.ok) throw Object.assign(new Error("HTTP failure"), { status: response.status });
    const json = await response.json();
    if (json.error) throw Object.assign(new Error("RPC failure"), { code: json.error.code });
    return json.result;
  } finally { clearTimeout(timer); }
}

function extractUrls(text) {
  const out = [];
  const normalizedText = String(text || "").replace(/\\\//g, "/");
  for (const match of normalizedText.matchAll(/(?:https?|wss?):\/\/[^\s"'`,;<>\]\[{}]+/gi)) {
    try {
      const parsed = new URL(match[0].replace(/[).]+$/, ""));
      if (parsed.protocol === "wss:") parsed.protocol = "https:";
      if (parsed.protocol === "http:" || parsed.protocol === "https:") out.push(parsed.href);
    } catch {}
  }
  for (const match of normalizedText.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s"'`,;<>\]\[{}]*)?/gi)) {
    try { out.push(new URL(`https:${"/"}${"/"}${match[0].replace(/[).]+$/, "")}`).href); } catch {}
  }
  return [...new Set(out)];
}

function familyKey(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".").filter(Boolean);
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

async function parallelMap(items, limit, fn) {
  const out = new Array(items.length); let cursor = 0;
  async function worker() { while (true) { const index = cursor++; if (index >= items.length) return; out[index] = await fn(items[index], index); } }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker));
  return out;
}

function increment(target, key) { target[key] = (target[key] || 0) + 1; }

async function probeCandidates(urls) {
  const failures = {};
  let rows = await parallelMap(urls.map((url) => ({ url, familyKey: familyKey(url) })), 28, async (candidate) => {
    try {
      const chainId = num(await rpc(candidate.url, "eth_chainId", [], PROBE_TIMEOUT_MS));
      if (![10, 999].includes(chainId)) return { ...candidate, chainId, status: "other-chain" };
      const finalized = await rpc(candidate.url, "eth_getBlockByNumber", ["finalized", false], PROBE_TIMEOUT_MS);
      if (!finalized || !finalized.hash || !finalized.number) return { ...candidate, chainId, status: "finalized-unavailable" };
      return { ...candidate, chainId, status: "finalized", finalizedNumber: num(finalized.number), finalizedHash: lower(finalized.hash), finalizedTimestamp: num(finalized.timestamp) };
    } catch (error) {
      const category = errorClass(error); increment(failures, category); return { ...candidate, status: category };
    }
  });
  // One bounded retry catches slow but usable inventory entries without
  // privileging a known endpoint or emitting its identity.
  rows = await parallelMap(rows, 20, async (row) => {
    if (Number.isInteger(row.chainId) || row.status === "other-chain") return row;
    try {
      const chainId = num(await rpc(row.url, "eth_chainId", [], 15000));
      if (![10, 999].includes(chainId)) return { ...row, chainId, status: "other-chain" };
      const finalized = await rpc(row.url, "eth_getBlockByNumber", ["finalized", false], 15000);
      if (!finalized || !finalized.hash || !finalized.number) return { ...row, chainId, status: "finalized-unavailable" };
      return { ...row, chainId, status: "finalized", finalizedNumber: num(finalized.number), finalizedHash: lower(finalized.hash), finalizedTimestamp: num(finalized.timestamp) };
    } catch (error) { return { ...row, status: errorClass(error) }; }
  });
  return { rows, failures };
}

function choosePin(chainRows, minimumFamilies) {
  const finalized = chainRows.filter((row) => row.status === "finalized" && Number.isSafeInteger(row.finalizedNumber));
  const heights = [...new Set(finalized.map((row) => row.finalizedNumber))].sort((a, b) => b - a);
  for (const height of heights) {
    const families = new Set(finalized.filter((row) => row.finalizedNumber >= height).map((row) => row.familyKey));
    if (families.size >= minimumFamilies) return { number: height, candidateFamilyCount: families.size };
  }
  if (heights.length) return { number: heights[0], candidateFamilyCount: 1 };
  return null;
}

async function bindPin(chainRows, pinNumber) {
  const eligible = chainRows.filter((row) => row.status === "finalized" && row.finalizedNumber >= pinNumber);
  const checked = await parallelMap(eligible, 12, async (row) => {
    try {
      const block = await rpc(row.url, "eth_getBlockByNumber", [hex(pinNumber), false]);
      if (!block || num(block.number) !== pinNumber || !block.hash) return { ...row, pinStatus: "pin-unavailable" };
      return { ...row, pinStatus: "exact-pin", pinHash: lower(block.hash), pinTimestamp: num(block.timestamp) };
    } catch (error) { return { ...row, pinStatus: errorClass(error) }; }
  });
  const byHash = new Map();
  for (const row of checked.filter((item) => item.pinStatus === "exact-pin")) {
    const families = byHash.get(row.pinHash) || new Set(); families.add(row.familyKey); byHash.set(row.pinHash, families);
  }
  const winner = [...byHash.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))[0];
  if (!winner) return null;
  return { number: pinNumber, hash: winner[0], timestamp: checked.find((row) => row.pinHash === winner[0])?.pinTimestamp ?? null, rows: checked.filter((row) => row.pinStatus === "exact-pin" && row.pinHash === winner[0]) };
}

async function strictCall(url, to, iface, functionName, args, blockNumber) {
  const fragment = iface.getFunction(functionName); const data = iface.encodeFunctionData(fragment, args);
  const raw = lower(await rpc(url, "eth_call", [{ to, data }, hex(blockNumber)]));
  if (typeof raw !== "string" || !/^0x[0-9a-f]*$/.test(raw) || raw.length % 2 !== 0) throw new Error("invalid-call-envelope");
  const decoded = iface.decodeFunctionResult(fragment, raw); const reencoded = lower(iface.encodeFunctionResult(fragment, [...decoded]));
  if (reencoded !== raw) throw new Error("noncanonical-call-envelope");
  return { raw, decoded };
}

async function tagged(stage, operation) {
  try { return await operation(); }
  catch (error) { const wrapped = new Error(stage); wrapped.bindingStage = stage; wrapped.originalClass = errorClass(error); throw wrapped; }
}

function cborMetadata(code) {
  if (typeof code !== "string" || !/^0x[0-9a-f]*$/i.test(code) || code.length < 6) return { present: false, length: null, digest: null };
  const body = code.slice(2); const length = parseInt(body.slice(-4), 16); const start = body.length - (length + 2) * 2;
  if (!length || start < 0) return { present: false, length, digest: null };
  const metadata = `0x${body.slice(start, body.length - 4)}`;
  return { present: true, length, digest: keccak256(metadata) };
}

function selectorEvidence(code) {
  const selectors = {
    messageLibType: LIB_IFACE.getFunction("messageLibType").selector,
    version: LIB_IFACE.getFunction("version").selector,
    isSupportedEid: LIB_IFACE.getFunction("isSupportedEid").selector,
    getConfig: LIB_IFACE.getFunction("getConfig").selector,
  };
  const normalized = lower(code || "0x");
  return { selectors, present: Object.fromEntries(Object.entries(selectors).map(([key, selector]) => [key, normalized.includes(selector.slice(2).toLowerCase())])) };
}

async function runtimeBinding(url, selectedLibrary, pinNumber) {
  const [code, implementationWord, adminWord, beaconWord] = await Promise.all([
    rpc(url, "eth_getCode", [selectedLibrary, hex(pinNumber)]),
    rpc(url, "eth_getStorageAt", [selectedLibrary, EIP1967.implementation, hex(pinNumber)]),
    rpc(url, "eth_getStorageAt", [selectedLibrary, EIP1967.admin, hex(pinNumber)]),
    rpc(url, "eth_getStorageAt", [selectedLibrary, EIP1967.beacon, hex(pinNumber)]),
  ]);
  if (typeof code !== "string" || code === "0x") throw new Error("selected-library-code-absent");
  const implementationSlot = nonzeroAddressFromWord(implementationWord);
  const admin = nonzeroAddressFromWord(adminWord);
  const beacon = nonzeroAddressFromWord(beaconWord);
  let beaconImplementation = null; let beaconResolution = beacon ? "unresolved" : "not-applicable";
  if (beacon) {
    try {
      const call = await strictCall(url, beacon, BEACON_IFACE, "implementation", [], pinNumber);
      beaconImplementation = address(call.decoded[0]); beaconResolution = beaconImplementation ? "resolved" : "invalid";
    } catch { beaconResolution = "failed"; }
  }
  const proxyAmbiguous = Boolean(implementationSlot && beacon) || Boolean(beacon && !beaconImplementation);
  const effectiveRuntimeAddress = implementationSlot || beaconImplementation || selectedLibrary;
  const effectiveCode = effectiveRuntimeAddress === selectedLibrary ? code : await rpc(url, "eth_getCode", [effectiveRuntimeAddress, hex(pinNumber)]);
  if (typeof effectiveCode !== "string" || effectiveCode === "0x") throw new Error("effective-runtime-code-absent");
  return {
    selectedAddress: selectedLibrary,
    selectedCodeBytes: (code.length - 2) / 2,
    selectedCodeHash: keccak256(code),
    proxy: { implementationSlot, admin, beacon, beaconImplementation, beaconResolution, proxyAmbiguous, effectiveRuntimeAddress },
    effectiveCodeBytes: (effectiveCode.length - 2) / 2,
    effectiveCodeHash: keccak256(effectiveCode),
    metadata: cborMetadata(effectiveCode),
    selectorEvidence: selectorEvidence(effectiveCode),
  };
}

function decodeConfigPayload(payload, configType) {
  const types = configType === 1 ? ["tuple(uint32 maxMessageSize,address executor)"] : ["tuple(uint64 confirmations,uint8 requiredDVNCount,uint8 optionalDVNCount,uint8 optionalDVNThreshold,address[] requiredDVNs,address[] optionalDVNs)"];
  const decoded = ABI.decode(types, payload); const reencoded = lower(ABI.encode(types, [...decoded]));
  if (reencoded !== lower(payload)) throw new Error("noncanonical-config-payload");
  const value = decoded[0];
  if (configType === 1) {
    const canonicalDecoded = { maxMessageSize: Number(value.maxMessageSize), executor: address(value.executor) };
    return { schema: "ExecutorConfig(uint32,address)", schemaDigest: digest(canonicalDecoded), summary: { maxMessageSize: canonicalDecoded.maxMessageSize, executorPresent: Boolean(canonicalDecoded.executor && canonicalDecoded.executor !== "0x0000000000000000000000000000000000000000") } };
  }
  const canonicalDecoded = { confirmations: value.confirmations.toString(), requiredDVNCount: Number(value.requiredDVNCount), optionalDVNCount: Number(value.optionalDVNCount), optionalDVNThreshold: Number(value.optionalDVNThreshold), requiredDVNs: [...value.requiredDVNs].map(address), optionalDVNs: [...value.optionalDVNs].map(address) };
  return { schema: "UlnConfig(uint64,uint8,uint8,uint8,address[],address[])", schemaDigest: digest(canonicalDecoded), summary: { confirmations: canonicalDecoded.confirmations, requiredDVNCount: canonicalDecoded.requiredDVNCount, optionalDVNCount: canonicalDecoded.optionalDVNCount, optionalDVNThreshold: canonicalDecoded.optionalDVNThreshold, requiredDVNArrayLength: canonicalDecoded.requiredDVNs.length, optionalDVNArrayLength: canonicalDecoded.optionalDVNs.length } };
}

async function configBinding(url, endpoint, app, selectedLibrary, remoteEid, configType, pinNumber) {
  const call = await strictCall(url, endpoint, ENDPOINT_IFACE, "getConfig", [app, selectedLibrary, remoteEid, configType], pinNumber);
  const payload = lower(call.decoded[0]);
  if (typeof payload !== "string" || !/^0x[0-9a-f]*$/.test(payload)) throw new Error("invalid-config-payload");
  const decoded = decodeConfigPayload(payload, configType);
  return {
    configType,
    endpointMethod: "getConfig(address,address,uint32,uint32)",
    rawEnvelopeBytes: (call.raw.length - 2) / 2,
    rawEnvelopeDigest: keccak256(call.raw),
    payloadBytes: (payload.length - 2) / 2,
    payloadDigest: keccak256(payload),
    decodedSchema: decoded.schema,
    decodedEffectiveSchemaDigest: decoded.schemaDigest,
    decodedSummary: decoded.summary,
    strictEnvelopeDecode: true,
    strictPayloadDecode: true,
    rawEnvelopePersisted: false,
    rawPayloadPersisted: false,
  };
}

async function routeBinding(url, chain, route, pinNumber) {
  const endpoint = chain.endpoint; const app = route["app"];
  const [appCode, endpointCode, endpointCall, peerCall] = await tagged("app-endpoint-peer-binding", () => Promise.all([
    rpc(url, "eth_getCode", [app, hex(pinNumber)]),
    rpc(url, "eth_getCode", [endpoint, hex(pinNumber)]),
    strictCall(url, app, OAPP_IFACE, "endpoint", [], pinNumber),
    strictCall(url, app, OAPP_IFACE, "peers", [route.remoteEid], pinNumber),
  ]));
  if (appCode === "0x" || endpointCode === "0x") throw new Error("route-code-absent");
  const observedEndpoint = address(endpointCall.decoded[0]); const peer = lower(peerCall.decoded[0]);
  const appEndpointMatches = observedEndpoint === endpoint;
  const peerNonzero = typeof peer === "string" && /^0x[0-9a-f]{64}$/.test(peer) && BigInt(peer) !== 0n;
  let selection;
  if (route.direction === "send") {
    const [libraryCall, defaultCall] = await tagged("send-selection", () => Promise.all([
      strictCall(url, endpoint, ENDPOINT_IFACE, "getSendLibrary", [app, route.remoteEid], pinNumber),
      strictCall(url, endpoint, ENDPOINT_IFACE, "isDefaultSendLibrary", [app, route.remoteEid], pinNumber),
    ]));
    selection = { method: "getSendLibrary(address,uint32)+isDefaultSendLibrary(address,uint32)", returnShape: ["address", "bool"], selectedLibrary: address(libraryCall.decoded[0]), isDefault: Boolean(defaultCall.decoded[0]), strictDecoded: true, rawResultPersisted: false };
  } else {
    const libraryCall = await tagged("receive-selection", () => strictCall(url, endpoint, ENDPOINT_IFACE, "getReceiveLibrary", [app, route.remoteEid], pinNumber));
    selection = { method: "getReceiveLibrary(address,uint32)", returnShape: ["address", "bool"], selectedLibrary: address(libraryCall.decoded[0]), isDefault: Boolean(libraryCall.decoded[1]), strictDecoded: true, rawResultPersisted: false };
  }
  if (!selection.selectedLibrary) throw new Error("selection-invalid");
  selection.tupleDigest = digest({ method: selection.method, selectedLibrary: selection.selectedLibrary, isDefault: selection.isDefault });
  const runtime = await tagged("selected-library-runtime", () => runtimeBinding(url, selection.selectedLibrary, pinNumber));
  const [typeCall, versionCall, supportedCall, registeredCall] = await tagged("selected-library-semantics", () => Promise.all([
    strictCall(url, selection.selectedLibrary, LIB_IFACE, "messageLibType", [], pinNumber),
    strictCall(url, selection.selectedLibrary, LIB_IFACE, "version", [], pinNumber),
    strictCall(url, selection.selectedLibrary, LIB_IFACE, "isSupportedEid", [route.remoteEid], pinNumber),
    strictCall(url, endpoint, ENDPOINT_IFACE, "isRegisteredLibrary", [selection.selectedLibrary], pinNumber),
  ]));
  const typeValue = Number(typeCall.decoded[0]); const messageLibType = MESSAGE_LIB_TYPES[typeValue] || null;
  const version = { major: versionCall.decoded[0].toString(), minor: Number(versionCall.decoded[1]), endpointVersion: Number(versionCall.decoded[2]) };
  const directionTypeMatches = route.direction === "send" ? messageLibType === "Send" || messageLibType === "SendAndReceive" : messageLibType === "Receive" || messageLibType === "SendAndReceive";
  const versionMatchesUln302 = version.major === EXPECTED_VERSION.major && version.minor === EXPECTED_VERSION.minor && version.endpointVersion === EXPECTED_VERSION.endpointVersion;
  const selectorSetComplete = Object.values(runtime.selectorEvidence.present).every(Boolean);
  const supportedEid = Boolean(supportedCall.decoded[0]); const registeredAtEndpoint = Boolean(registeredCall.decoded[0]);
  const configs = [];
  for (const configType of route.applicableConfigTypes) configs.push(await tagged(`config-type-${configType}`, () => configBinding(url, endpoint, app, selection.selectedLibrary, route.remoteEid, configType, pinNumber)));
  const configTypesExact = configs.map((row) => row.configType).join(",") === route.applicableConfigTypes.join(",");
  const semanticEvidenceComplete = directionTypeMatches && versionMatchesUln302 && selectorSetComplete && supportedEid && registeredAtEndpoint && !runtime.proxy.proxyAmbiguous && configTypesExact && configs.every((row) => row.strictEnvelopeDecode && row.strictPayloadDecode);
  const familyBindingStatus = semanticEvidenceComplete ? "ULN302-COMPATIBLE-SEMANTICS-BOUND/EXACT-OFFICIAL-RUNTIME-EQUIVALENCE-UNPROVEN" : "AMBIGUOUS-OR-UNSUPPORTED/FAIL-CLOSED";
  const codeVersionDigest = digest({ selectedCodeHash: runtime.selectedCodeHash, effectiveCodeHash: runtime.effectiveCodeHash, proxy: runtime.proxy, messageLibType, version, supportedEid, registeredAtEndpoint, selectorEvidence: runtime.selectorEvidence.present });
  const configDigest = digest(configs.map((row) => ({ configType: row.configType, rawEnvelopeDigest: row.rawEnvelopeDigest, payloadDigest: row.payloadDigest, decodedEffectiveSchemaDigest: row.decodedEffectiveSchemaDigest })));
  const routeStateDigest = digest({ route: route.id, app, remoteEid: route.remoteEid, direction: route.direction, appCodeHash: keccak256(appCode), endpointCodeHash: keccak256(endpointCode), appEndpointMatches, peerDigest: digest(peer), peerNonzero, selectionDigest: selection.tupleDigest, codeVersionDigest, configDigest, familyBindingStatus });
  return {
    routeId: route.id,
    binding: { app, remoteEid: route.remoteEid, direction: route.direction, asset: route.asset, endpoint, appEndpointObserved: observedEndpoint, appEndpointMatches, peerNonzero, peerDigest: digest(peer), appCodeHash: keccak256(appCode), endpointCodeHash: keccak256(endpointCode) },
    selection,
    runtime,
    semantics: { messageLibTypeValue: typeValue, messageLibType, version, supportedEid, registeredAtEndpoint, directionTypeMatches, versionMatchesUln302, selectorSetComplete, applicableConfigTypes: route.applicableConfigTypes, nonApplicableConfigTypesCalled: [], semanticEvidenceComplete, familyBindingStatus, exactOfficialSourceRuntimeEquivalence: null, exactRuntimeProvenanceBlocker: "offline compiler/artifact and deployment-verified metadata unavailable" },
    configs,
    digests: { selection: selection.tupleDigest, codeVersion: codeVersionDigest, config: configDigest, routeState: routeStateDigest },
    complete: appEndpointMatches && peerNonzero && semanticEvidenceComplete,
  };
}

function compactLogDigest(logs) {
  const rows = (logs || []).map((log) => ({ blockHash: lower(log.blockHash), transactionHash: lower(log.transactionHash), logIndex: num(log.logIndex), address: lower(log.address), topics: (log.topics || []).map(lower), dataDigest: digest(lower(log.data || "0x")) })).sort((a, b) => a.blockHash.localeCompare(b.blockHash) || a.transactionHash.localeCompare(b.transactionHash) || a.logIndex - b.logIndex);
  return { count: rows.length, digest: digest(rows), rawLogsPersisted: false };
}

async function providerObservation(row, chainName, chain, pin, providerId, familyId) {
  let failureStage = "route-start";
  try {
    const routes = [];
    for (const route of chain.routes) { failureStage = `route-${route.id}`; routes.push(await routeBinding(row.url, chain, route, pin.number)); }
    failureStage = "anchor-window";
    const fromBlock = Math.max(0, pin.number - WINDOW_BLOCKS + 1);
    const logs = await rpc(row.url, "eth_getLogs", [{ address: chain.endpoint, fromBlock: hex(fromBlock), toBlock: hex(pin.number) }]);
    if (!Array.isArray(logs)) throw new Error("anchor-log-response-invalid");
    const anchorWindow = { fromBlock, toBlock: pin.number, ...compactLogDigest(logs) };
    const selectionTupleDigest = digest(routes.map((route) => route.digests.selection));
    const codeVersionTupleDigest = digest(routes.map((route) => route.digests.codeVersion));
    const configTupleDigest = digest(routes.map((route) => route.digests.config));
    const retainedStateTupleDigest = digest(routes.map((route) => route.digests.routeState));
    const complete = routes.every((route) => route.complete);
    failureStage = "pin-recheck";
    const recheckBlock = await rpc(row.url, "eth_getBlockByNumber", [hex(pin.number), false]);
    const finalized = await rpc(row.url, "eth_getBlockByNumber", ["finalized", false]);
    const retainedHashStable = Boolean(recheckBlock && lower(recheckBlock.hash) === pin.hash && num(recheckBlock.number) === pin.number);
    const finalizedHeightBound = Boolean(finalized && num(finalized.number) >= pin.number);
    return { providerId, familyId, chain: chainName, exactPin: true, retainedHashStable, finalizedHeightBound, selectionTupleDigest, codeVersionTupleDigest, configTupleDigest, retainedStateTupleDigest, anchorWindow, routes, complete: complete && retainedHashStable && finalizedHeightBound, failureCategory: null };
  } catch (error) {
    return { providerId, familyId, chain: chainName, exactPin: true, retainedHashStable: false, finalizedHeightBound: false, selectionTupleDigest: null, codeVersionTupleDigest: null, configTupleDigest: null, retainedStateTupleDigest: null, anchorWindow: null, routes: [], complete: false, failureCategory: error.originalClass || errorClass(error), failureStage: error.bindingStage ? `${failureStage}/${error.bindingStage}` : failureStage };
  }
}

function familyRows(providers) {
  const grouped = new Map();
  for (const provider of providers) { const rows = grouped.get(provider.familyId) || []; rows.push(provider); grouped.set(provider.familyId, rows); }
  return [...grouped.entries()].map(([familyId, rows]) => {
    const equality = {};
    for (const key of ["selectionTupleDigest", "codeVersionTupleDigest", "configTupleDigest", "retainedStateTupleDigest"]) equality[key] = new Set(rows.map((row) => row[key]).filter(Boolean)).size === 1 && rows.every((row) => Boolean(row[key]));
    equality.anchorWindowDigest = new Set(rows.map((row) => row.anchorWindow?.digest).filter(Boolean)).size === 1 && rows.every((row) => Boolean(row.anchorWindow?.digest));
    const complete = rows.every((row) => row.complete) && Object.values(equality).every(Boolean);
    return { familyId, providerCount: rows.length, completeProviderCount: rows.filter((row) => row.complete).length, equality, complete, selectionTupleDigest: equality.selectionTupleDigest ? rows[0].selectionTupleDigest : null, codeVersionTupleDigest: equality.codeVersionTupleDigest ? rows[0].codeVersionTupleDigest : null, configTupleDigest: equality.configTupleDigest ? rows[0].configTupleDigest : null, retainedStateTupleDigest: equality.retainedStateTupleDigest ? rows[0].retainedStateTupleDigest : null, anchorWindowDigest: equality.anchorWindowDigest ? rows[0].anchorWindow.digest : null };
  }).sort((a, b) => a.familyId.localeCompare(b.familyId));
}

function consensusCount(families, keys) {
  const groups = new Map();
  for (const family of families.filter((row) => row.complete)) {
    const key = keys.map((name) => family[name]).join(":"); const set = groups.get(key) || new Set(); set.add(family.familyId); groups.set(key, set);
  }
  return Math.max(0, ...[...groups.values()].map((set) => set.size));
}

async function collectChain(chainName, chain, probedRows) {
  const correctRows = probedRows.filter((row) => row.chainId === chain.chainId && row.status === "finalized");
  const distinctCandidateFamilies = new Set(correctRows.map((row) => row.familyKey)).size;
  const pinChoice = choosePin(correctRows, chainName === "optimism" ? 2 : 1);
  if (!pinChoice) return { chainId: chain.chainId, endpoint: chain.endpoint, status: "NO-FINALIZED-PROVIDER", pin: null, routeDefinitions: chain.routes, metrics: { correctChainProviders: correctRows.length, candidateFamilies: distinctCandidateFamilies }, providers: [], families: [], consensus: { selection: 0, codeVersion: 0, config: 0, retainedState: 0, fullWithAnchor: 0 }, coverageReady: false };
  const pin = await bindPin(correctRows, pinChoice.number);
  if (!pin) return { chainId: chain.chainId, endpoint: chain.endpoint, status: "NO-EXACT-PIN", pin: null, routeDefinitions: chain.routes, metrics: { correctChainProviders: correctRows.length, candidateFamilies: distinctCandidateFamilies }, providers: [], families: [], consensus: { selection: 0, codeVersion: 0, config: 0, retainedState: 0, fullWithAnchor: 0 }, coverageReady: false };
  const familyKeys = [...new Set(pin.rows.map((row) => row.familyKey))].sort();
  const familyIds = new Map(familyKeys.map((key, index) => [key, `${chainName}-family-${String(index + 1).padStart(2, "0")}`]));
  const providers = await parallelMap(pin.rows, 5, (row, index) => providerObservation(row, chainName, chain, pin, `${chainName}-provider-${String(index + 1).padStart(2, "0")}`, familyIds.get(row.familyKey)));
  const families = familyRows(providers);
  const consensus = {
    selection: consensusCount(families, ["selectionTupleDigest", "anchorWindowDigest"]),
    codeVersion: consensusCount(families, ["codeVersionTupleDigest", "anchorWindowDigest"]),
    config: consensusCount(families, ["configTupleDigest", "anchorWindowDigest"]),
    retainedState: consensusCount(families, ["retainedStateTupleDigest", "anchorWindowDigest"]),
    fullWithAnchor: consensusCount(families, ["selectionTupleDigest", "codeVersionTupleDigest", "configTupleDigest", "retainedStateTupleDigest", "anchorWindowDigest"]),
  };
  const threshold = 2;
  const completeFamilies = families.filter((row) => row.complete).length;
  const failureCategories = {};
  for (const provider of providers.filter((row) => row.failureCategory)) increment(failureCategories, provider.failureCategory);
  return {
    chainId: chain.chainId,
    status: consensus.fullWithAnchor >= threshold ? "TWO-FAMILY-SELECTED-LIBRARY-CONSENSUS" : "COVERAGE_OPEN/FAMILY-THRESHOLD-NOT-MET",
    pin: { blockNumber: pin.number, blockHash: pin.hash, timestamp: pin.timestamp, selectionRule: chainName === "optimism" ? "freshest height finalized by at least two anonymous candidate families" : "freshest finalized height from available anonymous family", retainedHashRechecked: providers.some((row) => row.complete) && providers.filter((row) => row.complete).every((row) => row.retainedHashStable), finalizedHeightBound: providers.some((row) => row.complete) && providers.filter((row) => row.complete).every((row) => row.finalizedHeightBound), allAttemptedProvidersRetainedHashStable: providers.every((row) => row.retainedHashStable), allAttemptedProvidersFinalizedHeightBound: providers.every((row) => row.finalizedHeightBound) },
    routeDefinitions: chain.routes,
    metrics: { correctChainProviders: correctRows.length, candidateFamilies: distinctCandidateFamilies, exactPinProviders: pin.rows.length, exactPinFamilies: familyKeys.length, completeProviders: providers.filter((row) => row.complete).length, completeFamilies, failedProviderObservations: providers.filter((row) => !row.complete).length, failureCategories },
    providers,
    families,
    consensus,
    coverageReady: consensus.fullWithAnchor >= threshold,
  };
}

function reportText(raw) {
  const rows = Object.entries(raw.chains).map(([name, chain]) => `| ${name} | ${chain.pin?.blockNumber ?? "none"} | ${chain.metrics.correctChainProviders} | ${chain.metrics.exactPinFamilies || 0} | ${chain.metrics.completeFamilies || 0} | ${chain.consensus.selection} | ${chain.consensus.codeVersion} | ${chain.consensus.config} | ${chain.consensus.fullWithAnchor} | ${chain.coverageReady} |`).join("\n");
  const routeRows = Object.values(raw.chains).flatMap((chain) => {
    const exemplar = chain.providers.find((provider) => provider.complete);
    if (exemplar) return exemplar.routes.map((route) => `| ${route.routeId} | ${route.binding["app"]} | ${route.binding.remoteEid} | ${route.binding.direction} | ${route.selection.selectedLibrary} | ${route.selection.isDefault} | ${route.semantics.messageLibType} | ${route.semantics.version.major}.${route.semantics.version.minor}.${route.semantics.version.endpointVersion} | ${route.semantics.familyBindingStatus} |`);
    return (chain.routeDefinitions || []).map((route) => `| ${route.id} | ${route["app"]} | ${route.remoteEid} | ${route.direction} | unavailable | unavailable | unavailable | unavailable | FAIL-CLOSED/NO-FINALIZED-PROVIDER |`);
  }).join("\n");
  return `# 🟠 WATCH — EtherFi BeHYPE selected LayerZero library binding r7\n\n**Run:** \`${raw.runId}\`  \n**Revision:** \`${raw.revision}\`  \n**Classification:** \`${raw.classification}\`  \n**Gates:** \`0/0/false\`; \`fork=false\`\n\n## Result\n\nComplete fresh finalized Optimism observations bind both OApp/direction/EID routes to selected registered message libraries, strict library return shapes, runtime/code hashes, message-lib types, full version tuples, supported EIDs, direction-applicable effective config envelopes, and bounded endpoint log-window digests. HyperEVM route definitions are retained but fail closed because no current inventory candidate returned a finalized chain-999 header. Inventory endpoint material remained memory-only.\n\nR6 is preserved as rejected predecessor evidence because it normalized retained observations without selected-library code/version/runtime binding. R7 does not reuse that inference.\n\n| Chain | Pin | Correct-chain providers | Exact-pin families | Complete families | Selection consensus | Code/version consensus | Config consensus | Full+anchor consensus | Ready |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---|\n${rows}\n\n## Selected libraries\n\n| Route | App | EID | Direction | Selected library | Default | Message-lib type | Version | Binding status |\n|---|---|---:|---|---|---|---|---|---|\n${routeRows || "| unavailable | unavailable | 0 | unavailable | unavailable | false | unavailable | unavailable | fail-closed |"}\n\nThe family status intentionally says **ULN302-compatible semantics bound**, not exact official-runtime equivalence. The observed registered libraries expose matching direction, version 3.0.2, supported EID, strict applicable config schemas, and expected selectors when complete; exact compiler/runtime metadata equivalence remains unproven and is not inferred.\n\n## Qualifications and blockers\n\n- Provider and family identifiers are anonymous. No backend/operator independence beyond in-memory hostname-family grouping is claimed.\n- Raw config envelopes and payloads are not persisted; byte lengths and cryptographic digests plus strict decoded effective-schema digests are retained.\n- No receive-side config type 1 call was made. Send queried types 1 and 2; receive queried type 2 only.\n- Anchor windows are bounded ${WINDOW_BLOCKS}-block endpoint-log windows and may be empty; they are not full history.\n- Exact local source-runtime equivalence is null because an offline exact compiler/artifact and deployment-verified metadata were unavailable.\n- HyperEVM remains WATCH/COVERAGE_OPEN unless at least two anonymous families agree on full selected-library state plus anchor digest.\n- No economics, staking, message send, signing, fork, or mutation occurred.\n\n**nextReadOnlyStep:** ${raw.nextReadOnlyStep}\n`;
}

function assertNoLeak(text) {
  if (/(?:https?|wss?):\/\//i.test(text)) throw new Error("scheme-leak");
  if (/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|xyz|cloud|tech|finance|money|pro)\b/i.test(text)) throw new Error("host-leak");
  if (/(?:authorization|x-api-key|api-key|apikey|api_key|bearer|cookie|set-cookie)\s*[:=]\s*[^\s,}\]]+/i.test(text)) throw new Error("credential-leak");
  if (/"(?:url|domain|providerName|rawLine|headers?)"\s*:/i.test(text)) throw new Error("endpoint-field-leak");
}

async function main() {
  const generatedAt = new Date().toISOString();
  const rpcText = fs.readFileSync(RPC_INVENTORY, "utf8");
  const graphqlText = fs.readFileSync(GRAPHQL_INVENTORY, "utf8");
  const rpcUrls = extractUrls(rpcText); const graphqlUrls = extractUrls(graphqlText); const urls = [...new Set([...rpcUrls, ...graphqlUrls])]; const graphqlCandidateCount = graphqlUrls.length;
  const probe = await probeCandidates(urls);
  const chains = {};
  for (const [name, chain] of Object.entries(CHAINS)) chains[name] = await collectChain(name, chain, probe.rows);
  const hyperReady = chains.hyperevm.coverageReady;
  const classification = hyperReady ? "WATCH/SELECTED-LIBRARY-TWO-CHAIN-CONSENSUS/ECONOMICS-NOT-ASSESSED" : CLASSIFICATION;
  const nextReadOnlyStep = hyperReady ? "Review the two-chain selected-library package independently before any separate economics claim; no economics is established here." : "Provision a second usable independent HyperEVM provider family and repeat this exact fresh finalized fixed-pin selected-library binding; do not model economics before two-family HyperEVM full-plus-anchor agreement.";
  const officialSources = LZ_SOURCES.map(hashFile);
  const rejectedR6 = { status: "REJECTED/SUPERSEDED-FOR-SELECTED-LIBRARY-FAMILY-INFERENCE", reason: "retained observations did not bind selected library runtime, messageLibType, version, supported EID, or registered code", raw: hashFile(R6_RAW), manifest: hashFile(R6_MANIFEST) };
  const core = {
    schemaVersion: 1,
    revision: REVISION,
    generatedAt,
    scanner: SCANNER,
    agentId: AGENT,
    role: "critical-research",
    classification,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    fork: false,
    pins: Object.fromEntries(Object.entries(chains).map(([name, chain]) => [name, chain.pin])),
    inventory: { rpcInventoryRead: true, graphqlInventoryRead: true, rpcLineCount: rpcText.split(/\r?\n/).length, rpcCandidatesParsed: rpcUrls.length, graphqlLineCount: graphqlText.split(/\r?\n/).length, graphqlCandidatesParsed: graphqlCandidateCount, combinedUniqueCandidatesProbed: urls.length, graphqlCandidatesEligibleForJsonRpcProbe: true, graphqlCalls: 0, endpointValuesPersisted: false, providerDomainsPersisted: false, providerNamesPersisted: false, rawInventoryLinesPersisted: false, inventoryHashesPersisted: false },
    probe: { attempted: urls.length, chainIdResponses: probe.rows.filter((row) => Number.isInteger(row.chainId)).length, optimismChainIdProviders: probe.rows.filter((row) => row.chainId === 10).length, optimismFinalizedProviders: probe.rows.filter((row) => row.chainId === 10 && row.status === "finalized").length, hyperevmChainIdProviders: probe.rows.filter((row) => row.chainId === 999).length, hyperevmFinalizedProviders: probe.rows.filter((row) => row.chainId === 999 && row.status === "finalized").length, hyperevmNonFinalizedStatusCounts: probe.rows.filter((row) => row.chainId === 999 && row.status !== "finalized").reduce((out, row) => { increment(out, row.status); return out; }, {}), failureCategoryCounts: probe.failures, individualFailedCandidatesPersisted: false },
    officialLayerZero: { commit: LZ_COMMIT, sourceRecords: officialSources, sourceRuntimeExactBuildAvailable: false, exactSelectedLibraryRuntimeEquivalence: null, semanticBindingRequiresObservedTypeVersionCodeConfig: true },
    rejectedPredecessorR6: rejectedR6,
    chains,
    gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, optimismSelectedLibraryConsensus: chains.optimism.coverageReady, hyperevmSelectedLibraryConsensus: chains.hyperevm.coverageReady, bothChainsSelectedLibraryConsensus: chains.optimism.coverageReady && chains.hyperevm.coverageReady, economicsBlocked: true },
    safety: { readOnly: true, networkCalls: true, networkScope: "authorized endpoint inventories only", endpointInventoriesReadThisRun: true, endpointValuesEmitted: false, secretsPersisted: false, economicsCalls: false, stakeCalls: false, messageSendCalls: false, signing: false, transactions: false, forkCreated: false, mutation: false },
    nextReadOnlyStep,
  };
  const runId = `etherfi-behype-selected-library-r7-${digest(core).slice(0, 20)}-${hashFile(SCANNER).sha256.slice(0, 12)}`;
  const raw = { ...core, runId };
  writeOwned(RAW, JSON.stringify(canonical(raw), null, 2) + "\n");
  writeOwned(REPORT, reportText(raw));
  const inbox = { findingId: NAME, revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: classification, classification, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pins: raw.pins, chainMetrics: Object.fromEntries(Object.entries(chains).map(([name, chain]) => [name, { status: chain.status, metrics: chain.metrics, consensus: chain.consensus, coverageReady: chain.coverageReady }])), libraryBindingStatus: "ULN302-COMPATIBLE-SEMANTICS-BOUND/EXACT-OFFICIAL-RUNTIME-EQUIVALENCE-UNPROVEN", rejectedPredecessorR6: rejectedR6, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF, R6_RAW, R6_MANIFEST, ...LZ_SOURCES], nextAction: nextReadOnlyStep };
  writeOwned(INBOX, JSON.stringify(canonical(inbox), null, 2) + "\n");
  const handoff = `# EtherFi BeHYPE selected-library binding r7 handoff\n\n- Run \`${runId}\`; classification \`${classification}\`; gates \`0/0/false\`, fork=false.\n- Fresh pins: Optimism ${chains.optimism.pin?.blockNumber ?? "unavailable"} / \`${chains.optimism.pin?.blockHash ?? "unavailable"}\`; HyperEVM ${chains.hyperevm.pin?.blockNumber ?? "unavailable"} / \`${chains.hyperevm.pin?.blockHash ?? "unavailable"}\`.\n- Optimism exact-pin/complete families ${chains.optimism.metrics.exactPinFamilies || 0}/${chains.optimism.metrics.completeFamilies || 0}; selection/code/config/full consensus ${chains.optimism.consensus.selection}/${chains.optimism.consensus.codeVersion}/${chains.optimism.consensus.config}/${chains.optimism.consensus.fullWithAnchor}.\n- HyperEVM exact-pin/complete families ${chains.hyperevm.metrics.exactPinFamilies || 0}/${chains.hyperevm.metrics.completeFamilies || 0}; selection/code/config/full consensus ${chains.hyperevm.consensus.selection}/${chains.hyperevm.consensus.codeVersion}/${chains.hyperevm.consensus.config}/${chains.hyperevm.consensus.fullWithAnchor}.\n- Complete observations bind selected address/default status, code/proxy slots, type, full version, supported EID, endpoint registration, and only direction-applicable config schemas.\n- Library family status is ULN302-compatible semantics bound; exact official source-runtime equivalence remains null and is not inferred.\n- R6 is preserved but rejected for selected-library family inference.\n- Inventory values, domains, provider names, headers, keys, and raw lines were not persisted.\n- No economics/stake/send/signing/transaction/fork/mutation.\n- Next: ${nextReadOnlyStep}\n`;
  writeOwned(HANDOFF, handoff);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, R6_RAW, R6_MANIFEST, ...LZ_SOURCES].map(hashFile);
  const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  const manifest = { schemaVersion: 1, revision: REVISION, runId, generatedAt, classification, algorithm: "sha256", routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pins: raw.pins, inventorySafety: raw.inventory, officialLayerZero: raw.officialLayerZero, rejectedPredecessorR6: rejectedR6, chainMetrics: inbox.chainMetrics, gates: raw.gates, safety: raw.safety, records, aggregateSha256 };
  writeOwned(MANIFEST, JSON.stringify(canonical(manifest), null, 2) + "\n");
  for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF]) assertNoLeak(fs.readFileSync(abs(rel), "utf8"));
  process.stdout.write(JSON.stringify({ runId, classification, pins: raw.pins, families: Object.fromEntries(Object.entries(chains).map(([name, chain]) => [name, { exactPin: chain.metrics.exactPinFamilies || 0, complete: chain.metrics.completeFamilies || 0, consensus: chain.consensus }])), libraryBindingStatus: inbox.libraryBindingStatus, manifestAggregateSha256: aggregateSha256, gates: raw.gates, nextReadOnlyStep }) + "\n");
}

main().catch((error) => { process.stderr.write(`selected-library binding failed: ${errorClass(error)}\n`); process.exitCode = 1; });
