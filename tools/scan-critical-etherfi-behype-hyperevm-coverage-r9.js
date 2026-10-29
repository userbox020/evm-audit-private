#!/usr/bin/env node
"use strict";

// HyperEVM R9 read-only coverage. The declared official endpoint is supplied
// only through process memory. Inventory and endpoint identifiers are never
// emitted, hashed, or persisted.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AbiCoder, Interface, getAddress, id, keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-hyperevm-coverage-r9";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-22-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-22-${NAME}-handoff.md`;
const R8_RAW = "reports/raw/fast/critical-etherfi-behype-receive-type1-negative-check.json";
const R8_MANIFEST = "reports/raw/fast/critical-etherfi-behype-receive-type1-negative-check-manifest.json";
const RPC_INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const LZ_SOURCES = [
  "targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts/MessageLibManager.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts/EndpointV2.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts/interfaces/IMessageLibManager.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts/interfaces/IMessageLib.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/messagelib/contracts/uln/uln302/SendUln302.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/messagelib/contracts/uln/uln302/ReceiveUln302.sol",
];
const REVISION = "etherfi-behype-hyperevm-coverage-r9-fresh-conservative-pin";
const AGENT = "critical-etherfi-behype-hyper-coverage-r9-20260722";
const QUALIFICATION = "Agreeing groups are distinct declared/observed provider-family groups; backend/operator independence is not established.";
const CHAIN_ID = 999;
const ENDPOINT = "0x3a73033c0b1407574c76bdbaac67f126f6b4a9aa9";
const RECEIVER = "0xe6a3bcd93e9d56e5252db47ff512629fd3cc9b54";
const ANCHOR_BLOCKS = 50;
const RETAINED_DEPTH = 8;
const ABI = AbiCoder.defaultAbiCoder();
const ERROR_SIGNATURE = "LZ_ULN_InvalidConfigType(uint32)";
const ERROR_SELECTOR = id(ERROR_SIGNATURE).slice(0, 10).toLowerCase();
const ROUTES = [
  { id: "hyperevm-whype-receive-30111", asset: "WHYPE", direction: "receive", app: "0x2b7e48511ea616101834f09945c11f7d78d9136d", remoteEid: 30111, applicableConfigTypes: [2] },
  { id: "hyperevm-behype-send-30111", asset: "beHYPE", direction: "send", app: "0x637de4a55cdd37700f9b54451b709b01040d48df", remoteEid: 30111, applicableConfigTypes: [1, 2] },
];

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
const OAPP_IFACE = new Interface(["function endpoint() view returns(address)", "function peers(uint32) view returns(bytes32)"]);
const ADAPTER_IFACE = new Interface(["function token() view returns(address)", "function approvalRequired() view returns(bool)"]);
const ERC20_IFACE = new Interface(["function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)"]);
const EIP1967 = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e01970b5aee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
};

const abs = (rel) => path.join(ROOT, rel);
const lower = (value) => typeof value === "string" ? value.toLowerCase() : value;
const hex = (value) => `0x${Number(value).toString(16)}`;
const num = (value) => typeof value === "string" && /^0x/i.test(value) ? Number(BigInt(value)) : Number(value);
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { path: rel, bytes: body.length, sha256: sha(body) }; };
const address = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? lower(getAddress(value)) : null;
const fromWord = (word) => { if (typeof word !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(word)) return null; const out = address(`0x${word.slice(-40)}`); return out === "0x0000000000000000000000000000000000000000" ? null : out; };

function writeOwned(rel, body) {
  if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error("write-refused");
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body, "utf8");
}

function errorClass(error) {
  const status = Number(error?.status); const code = Number(error?.code); const text = String(error?.message || error || "").toLowerCase();
  if (status === 401 || status === 403) return "auth-or-origin-rejected";
  if (status === 429 || text.includes("rate")) return "rate-limited";
  if (code === -32601) return "method-unsupported";
  if (text.includes("abort") || text.includes("timeout")) return "timeout";
  if (status >= 400 && status < 500) return "http-4xx";
  if (status >= 500) return "http-5xx";
  return "rpc-or-transport-error";
}

let rpcId = 1;
async function rpcResponse(url, method, params, timeout = 10000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) });
    if (!response.ok) throw Object.assign(new Error("HTTP failure"), { status: response.status });
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function rpc(url, method, params, timeout = 10000) {
  const json = await rpcResponse(url, method, params, timeout);
  if (json?.error) throw Object.assign(new Error("RPC failure"), { code: json.error.code });
  return json?.result;
}

function extractUrls(text) {
  const normalized = String(text || "").replace(/\\\//g, "/"); const out = [];
  for (const match of normalized.matchAll(/(?:https?|wss?):\/\/[^\s"'`,;<>\]\[{}]+/gi)) try { const parsed = new URL(match[0].replace(/[).]+$/, "")); if (parsed.protocol === "wss:") parsed.protocol = "https:"; if (["http:", "https:"].includes(parsed.protocol)) out.push(parsed.href); } catch {}
  for (const match of normalized.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s"'`,;<>\]\[{}]*)?/gi)) try { out.push(new URL(`https:${"/"}${"/"}${match[0].replace(/[).]+$/, "")}`).href); } catch {}
  return [...new Set(out)];
}

function hostFamily(url) {
  const host = new URL(url).hostname.toLowerCase(); const parts = host.split(".").filter(Boolean);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return host;
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

function inventoryAuthHint(url) {
  const parsed = new URL(url);
  return Boolean(parsed.username || parsed.password || parsed.search || parsed.pathname.split("/").filter(Boolean).some((part) => part.length >= 20));
}

async function parallelMap(items, limit, fn) {
  const out = new Array(items.length); let cursor = 0;
  async function worker() { while (true) { const index = cursor++; if (index >= items.length) return; out[index] = await fn(items[index], index); } }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker)); return out;
}

async function probeCandidates(candidates) {
  return parallelMap(candidates, 24, async (candidate) => {
    try {
      const chainId = num(await rpc(candidate.url, "eth_chainId", [], 8000));
      if (chainId !== CHAIN_ID) return { ...candidate, chainId, status: "other-chain" };
      const headNumber = num(await rpc(candidate.url, "eth_blockNumber", [], 8000));
      const head = await rpc(candidate.url, "eth_getBlockByNumber", [hex(headNumber), false], 8000);
      if (!head?.hash || num(head.number) !== headNumber) return { ...candidate, chainId, status: "head-unavailable" };
      let finalizedSupported = false; let finalizedNumber = null; let finalizedHash = null; let finalizedProbeCategory = null;
      try {
        const finalized = await rpc(candidate.url, "eth_getBlockByNumber", ["finalized", false], 8000);
        if (finalized?.hash && Number.isSafeInteger(num(finalized.number))) { finalizedSupported = true; finalizedNumber = num(finalized.number); finalizedHash = lower(finalized.hash); }
        else finalizedProbeCategory = "empty-or-invalid-finalized-response";
      } catch (error) { finalizedProbeCategory = errorClass(error); }
      const safeHeight = finalizedSupported ? finalizedNumber : Math.max(0, headNumber - RETAINED_DEPTH);
      return { ...candidate, chainId, status: "chain-head", headNumber, headHash: lower(head.hash), headTimestamp: num(head.timestamp), finalizedSupported, finalizedNumber, finalizedHash, finalizedProbeCategory, safeHeight, safeHeightRule: finalizedSupported ? "reported-finalized-height" : `head-minus-${RETAINED_DEPTH}-retained-blocks` };
    } catch (error) { return { ...candidate, status: errorClass(error) }; }
  });
}

function choosePin(rows) {
  const usable = rows.filter((row) => row.status === "chain-head" && Number.isSafeInteger(row.safeHeight));
  const familyHeights = new Map();
  for (const row of usable) familyHeights.set(row.familyKey, Math.max(familyHeights.get(row.familyKey) || 0, row.safeHeight));
  const heights = [...familyHeights.values()].sort((a, b) => b - a);
  if (!heights.length) return null;
  return { blockNumber: heights.length >= 2 ? heights[1] : heights[0], targetFamilyCount: heights.length >= 2 ? 2 : 1 };
}

async function bindPin(rows, pinNumber) {
  const eligible = rows.filter((row) => row.status === "chain-head" && row.safeHeight >= pinNumber);
  const checked = await parallelMap(eligible, 10, async (row) => {
    try { const block = await rpc(row.url, "eth_getBlockByNumber", [hex(pinNumber), false], 10000); return block?.hash && num(block.number) === pinNumber ? { ...row, exactPin: true, pinHash: lower(block.hash), pinTimestamp: num(block.timestamp) } : { ...row, exactPin: false }; }
    catch (error) { return { ...row, exactPin: false, pinFailure: errorClass(error) }; }
  });
  const groups = new Map();
  for (const row of checked.filter((item) => item.exactPin)) { const set = groups.get(row.pinHash) || new Set(); set.add(row.familyKey); groups.set(row.pinHash, set); }
  const winner = [...groups.entries()].sort((a, b) => b[1].size - a[1].size)[0];
  if (!winner) return null;
  return { blockNumber: pinNumber, blockHash: winner[0], timestamp: checked.find((row) => row.pinHash === winner[0]).pinTimestamp, rows: checked.filter((row) => row.exactPin && row.pinHash === winner[0]), agreeingCandidateFamilies: winner[1].size };
}

async function strictCall(url, to, iface, name, args, block) {
  const fragment = iface.getFunction(name); const data = iface.encodeFunctionData(fragment, args); const raw = lower(await rpc(url, "eth_call", [{ to, data }, hex(block)]));
  if (typeof raw !== "string" || !/^0x[0-9a-f]*$/.test(raw)) throw new Error("invalid-envelope");
  const decoded = iface.decodeFunctionResult(fragment, raw); if (lower(iface.encodeFunctionResult(fragment, [...decoded])) !== raw) throw new Error("noncanonical-envelope");
  return { raw, decoded };
}

function decodeConfig(payload, type) {
  const types = type === 1 ? ["tuple(uint32 maxMessageSize,address executor)"] : ["tuple(uint64 confirmations,uint8 requiredDVNCount,uint8 optionalDVNCount,uint8 optionalDVNThreshold,address[] requiredDVNs,address[] optionalDVNs)"];
  const decoded = ABI.decode(types, payload); if (lower(ABI.encode(types, [...decoded])) !== lower(payload)) throw new Error("noncanonical-config");
  const value = decoded[0]; const semantic = type === 1 ? { maxMessageSize: Number(value.maxMessageSize), executor: address(value.executor) } : { confirmations: value.confirmations.toString(), requiredDVNCount: Number(value.requiredDVNCount), optionalDVNCount: Number(value.optionalDVNCount), optionalDVNThreshold: Number(value.optionalDVNThreshold), requiredDVNs: [...value.requiredDVNs].map(address), optionalDVNs: [...value.optionalDVNs].map(address) };
  return { schema: type === 1 ? "ExecutorConfig(uint32,address)" : "UlnConfig(uint64,uint8,uint8,uint8,address[],address[])", decodedDigest: digest(semantic), summary: type === 1 ? { maxMessageSize: semantic.maxMessageSize, executorPresent: Boolean(semantic.executor) } : { confirmations: semantic.confirmations, requiredDVNCount: semantic.requiredDVNCount, optionalDVNCount: semantic.optionalDVNCount, optionalDVNThreshold: semantic.optionalDVNThreshold, requiredDVNArrayLength: semantic.requiredDVNs.length, optionalDVNArrayLength: semantic.optionalDVNs.length } };
}

async function configCall(url, route, library, type, block) {
  const call = await strictCall(url, ENDPOINT, ENDPOINT_IFACE, "getConfig", [route["app"], library, route.remoteEid, type], block); const payload = lower(call.decoded[0]); const decoded = decodeConfig(payload, type);
  return { configType: type, rawEnvelopeBytes: (call.raw.length - 2) / 2, rawEnvelopeDigest: keccak256(call.raw), payloadBytes: (payload.length - 2) / 2, payloadDigest: keccak256(payload), decodedSchema: decoded.schema, decodedEffectiveSchemaDigest: decoded.decodedDigest, decodedSummary: decoded.summary, strictEnvelopeDecode: true, strictPayloadDecode: true, rawEnvelopePersisted: false, rawPayloadPersisted: false };
}

function collectHex(value, depth = 0, out = []) {
  if (depth > 8 || value == null) return out;
  if (typeof value === "string") { if (/^0x[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) out.push(lower(value)); return out; }
  if (Array.isArray(value)) for (const item of value) collectHex(item, depth + 1, out); else if (typeof value === "object") for (const item of Object.values(value)) collectHex(item, depth + 1, out);
  return out;
}

async function receiveType1Check(url, route, library, block) {
  const data = ENDPOINT_IFACE.encodeFunctionData("getConfig", [route["app"], library, route.remoteEid, 1]); let response;
  try { response = await rpcResponse(url, "eth_call", [{ to: ENDPOINT, data }, hex(block)], 12000); }
  catch (error) { return { category: "provider-transport-or-http-failure", transportCategory: errorClass(error), expected: false, revertDataBytes: null, revertDataDigest: null, selector: null, expectedSelector: ERROR_SELECTOR, selectorMatches: false, decodedArgument: null, argumentMatches: false, strictCustomErrorEncoding: false, rawRevertDataPersisted: false }; }
  if (typeof response?.result === "string") return { category: "unexpected-success", expected: false, successEnvelopeBytes: (response.result.length - 2) / 2, successEnvelopeDigest: /^0x[0-9a-fA-F]*$/.test(response.result) ? keccak256(response.result) : null, revertDataBytes: null, revertDataDigest: null, selector: null, expectedSelector: ERROR_SELECTOR, selectorMatches: false, decodedArgument: null, argumentMatches: false, strictCustomErrorEncoding: false, rawRevertDataPersisted: false };
  const candidates = [...new Set(collectHex(response?.error?.data))];
  if (candidates.length !== 1) return { category: "provider-wrapped-or-ambiguous-revert", expected: false, revertCandidateCount: candidates.length, revertDataBytes: null, revertDataDigest: null, selector: null, expectedSelector: ERROR_SELECTOR, selectorMatches: false, decodedArgument: null, argumentMatches: false, strictCustomErrorEncoding: false, rawRevertDataPersisted: false };
  const revertData = candidates[0]; const bytes = (revertData.length - 2) / 2; const selector = revertData.slice(0, 10); let decodedArgument = null; let strict = false;
  try { if (bytes === 36) { decodedArgument = Number(ABI.decode(["uint32"], `0x${revertData.slice(10)}`)[0]); strict = lower(`${selector}${ABI.encode(["uint32"], [decodedArgument]).slice(2)}`) === revertData; } } catch {}
  const selectorMatches = selector === ERROR_SELECTOR; const argumentMatches = decodedArgument === 1; const expected = strict && selectorMatches && argumentMatches;
  return { category: expected ? "expected-custom-error" : "unexpected-revert-data", expected, revertDataBytes: bytes, revertDataDigest: keccak256(revertData), selector, expectedSelector: ERROR_SELECTOR, selectorMatches, decodedArgument, expectedArgument: 1, argumentMatches, strictCustomErrorEncoding: strict, rawRevertDataPersisted: false };
}

async function contractState(url, target, block) {
  const [code, balance] = await Promise.all([rpc(url, "eth_getCode", [target, hex(block)]), rpc(url, "eth_getBalance", [target, hex(block)])]);
  if (!code || code === "0x") throw new Error("contract-code-absent");
  const words = {}; let proxyResolutionComplete = true;
  for (const [name, slot] of Object.entries(EIP1967)) try { words[name] = await rpc(url, "eth_getStorageAt", [target, slot, hex(block)]); } catch { words[name] = null; proxyResolutionComplete = false; }
  const proxy = { implementationSlot: fromWord(words.implementation), admin: fromWord(words.admin), beacon: fromWord(words.beacon), proxyResolutionComplete }; proxy.proxyAmbiguous = !proxyResolutionComplete || Boolean(proxy.implementationSlot && proxy.beacon);
  return { address: target, codeBytes: (code.length - 2) / 2, codeHash: keccak256(code), proxy, nativeBalance: BigInt(balance).toString() };
}

async function routeObservation(url, route, block) {
  const app = route["app"];
  const [appState, endpointCall, peerCall] = await Promise.all([contractState(url, app, block), strictCall(url, app, OAPP_IFACE, "endpoint", [], block), strictCall(url, app, OAPP_IFACE, "peers", [route.remoteEid], block)]);
  let selection;
  if (route.direction === "send") {
    const [selected, defaultCall] = await Promise.all([strictCall(url, ENDPOINT, ENDPOINT_IFACE, "getSendLibrary", [app, route.remoteEid], block), strictCall(url, ENDPOINT, ENDPOINT_IFACE, "isDefaultSendLibrary", [app, route.remoteEid], block)]);
    selection = { method: "getSendLibrary(address,uint32)+isDefaultSendLibrary(address,uint32)", returnShape: ["address", "bool"], selectedLibrary: address(selected.decoded[0]), isDefault: Boolean(defaultCall.decoded[0]), strictDecoded: true };
  } else {
    const selected = await strictCall(url, ENDPOINT, ENDPOINT_IFACE, "getReceiveLibrary", [app, route.remoteEid], block);
    selection = { method: "getReceiveLibrary(address,uint32)", returnShape: ["address", "bool"], selectedLibrary: address(selected.decoded[0]), isDefault: Boolean(selected.decoded[1]), strictDecoded: true };
  }
  const libraryState = await contractState(url, selection.selectedLibrary, block);
  const [typeCall, versionCall, supportedCall, registeredCall] = await Promise.all([strictCall(url, selection.selectedLibrary, LIB_IFACE, "messageLibType", [], block), strictCall(url, selection.selectedLibrary, LIB_IFACE, "version", [], block), strictCall(url, selection.selectedLibrary, LIB_IFACE, "isSupportedEid", [route.remoteEid], block), strictCall(url, ENDPOINT, ENDPOINT_IFACE, "isRegisteredLibrary", [selection.selectedLibrary], block)]);
  const typeValue = Number(typeCall.decoded[0]); const messageLibType = ({ 0: "Send", 1: "Receive", 2: "SendAndReceive" })[typeValue] || null; const version = { major: versionCall.decoded[0].toString(), minor: Number(versionCall.decoded[1]), endpointVersion: Number(versionCall.decoded[2]) };
  const configs = []; for (const type of route.applicableConfigTypes) configs.push(await configCall(url, route, selection.selectedLibrary, type, block));
  const negative = route.direction === "receive" ? await receiveType1Check(url, route, selection.selectedLibrary, block) : null;
  const directionMatches = route.direction === "send" ? ["Send", "SendAndReceive"].includes(messageLibType) : ["Receive", "SendAndReceive"].includes(messageLibType); const versionMatches = version.major === "3" && version.minor === 0 && version.endpointVersion === 2;
  const binding = { app, remoteEid: route.remoteEid, direction: route.direction, asset: route.asset, endpoint: ENDPOINT, appEndpointObserved: address(endpointCall.decoded[0]), appEndpointMatches: address(endpointCall.decoded[0]) === ENDPOINT, peerNonzero: BigInt(peerCall.decoded[0]) !== 0n, peerDigest: digest(lower(peerCall.decoded[0])) };
  const semantics = { messageLibTypeValue: typeValue, messageLibType, version, supportedEid: Boolean(supportedCall.decoded[0]), registeredAtEndpoint: Boolean(registeredCall.decoded[0]), directionMatches, versionMatches, exactOfficialRuntimeEquivalence: null, behavioralFamilyStatus: directionMatches && versionMatches && Boolean(supportedCall.decoded[0]) && Boolean(registeredCall.decoded[0]) && (route.direction !== "receive" || negative.expected) ? "ULN302-COMPATIBLE-BEHAVIOR-BOUND" : "BEHAVIOR-UNPROVEN/FAIL-CLOSED" };
  selection.tupleDigest = digest({ selectedLibrary: selection.selectedLibrary, isDefault: selection.isDefault, method: selection.method });
  const codeVersionDigest = digest({ appState, libraryState, semantics }); const configDigest = digest(configs.map((row) => ({ type: row.configType, envelope: row.rawEnvelopeDigest, decoded: row.decodedEffectiveSchemaDigest }))); const negativeDigest = negative ? digest(negative) : null; const stateDigest = digest({ binding, selection: selection.tupleDigest, codeVersionDigest, configDigest, negativeDigest });
  const complete = binding.appEndpointMatches && binding.peerNonzero && appState.proxy.proxyResolutionComplete && libraryState.proxy.proxyResolutionComplete && !appState.proxy.proxyAmbiguous && !libraryState.proxy.proxyAmbiguous && semantics.behavioralFamilyStatus !== "BEHAVIOR-UNPROVEN/FAIL-CLOSED" && configs.every((row) => row.strictPayloadDecode);
  return { routeId: route.id, binding, selection, appState, selectedLibraryState: libraryState, semantics, applicableConfigs: configs, receiveType1NegativeCheck: negative, digests: { selection: selection.tupleDigest, codeVersion: codeVersionDigest, config: configDigest, negativeType1: negativeDigest, state: stateDigest }, complete };
}

async function integrationState(url, routes, block) {
  const endpointState = await contractState(url, ENDPOINT, block); const receiverState = await contractState(url, RECEIVER, block); const adapters = [];
  for (const route of routes) {
    let token; let tokenResolution;
    try { const tokenCall = await strictCall(url, route.binding["app"], ADAPTER_IFACE, "token", [], block); token = address(tokenCall.decoded[0]); tokenResolution = "adapter-token-getter"; }
    catch { token = route.binding["app"]; tokenResolution = "self-token-after-token-getter-unavailable"; }
    let approvalRequired = null; try { approvalRequired = Boolean((await strictCall(url, route.binding["app"], ADAPTER_IFACE, "approvalRequired", [], block)).decoded[0]); } catch {}
    const [tokenCode, receiverBalance, adapterBalance, allowance] = await Promise.all([rpc(url, "eth_getCode", [token, hex(block)]), strictCall(url, token, ERC20_IFACE, "balanceOf", [RECEIVER], block), strictCall(url, token, ERC20_IFACE, "balanceOf", [route.binding["app"]], block), strictCall(url, token, ERC20_IFACE, "allowance", [RECEIVER, route.binding["app"]], block)]);
    if (!tokenCode || tokenCode === "0x") throw new Error("adapter-token-code-absent");
    adapters.push({ routeId: route.routeId, adapter: route.binding["app"], adapterCodeHash: route.appState.codeHash, token, tokenResolution, tokenCodeHash: keccak256(tokenCode), approvalRequired, receiverTokenBalance: receiverBalance.decoded[0].toString(), adapterTokenBalance: adapterBalance.decoded[0].toString(), receiverAllowanceToAdapter: allowance.decoded[0].toString() });
  }
  return { endpointState, receiverState, adapters, digest: digest({ endpointState, receiverState, adapters }) };
}

async function providerObservation(row, pin, providerId, familyId) {
  let stage = "routes"; let partialRoutes = [];
  try {
    const routes = []; for (const route of ROUTES) { stage = `route-${route.id}`; routes.push(await routeObservation(row.url, route, pin.blockNumber)); partialRoutes = [...routes]; }
    stage = "integration";
    const integration = await integrationState(row.url, routes, pin.blockNumber);
    const anchorAddresses = [...new Set([ENDPOINT, RECEIVER, ...routes.map((route) => route.binding["app"]), ...integration.adapters.map((item) => item.token)])]; const fromBlock = Math.max(0, pin.blockNumber - ANCHOR_BLOCKS + 1);
    stage = "anchor-logs";
    const logs = [];
    for (const target of anchorAddresses) { const rows = await rpc(row.url, "eth_getLogs", [{ address: target, fromBlock: hex(fromBlock), toBlock: hex(pin.blockNumber) }], 15000); if (!Array.isArray(rows)) throw new Error("anchor-logs-invalid"); logs.push(...rows); }
    const logRows = logs.map((log) => ({ blockHash: lower(log.blockHash), txHash: lower(log.transactionHash), index: num(log.logIndex), address: lower(log.address), topics: (log.topics || []).map(lower), dataDigest: digest(lower(log.data || "0x")) })).sort((a, b) => a.blockHash.localeCompare(b.blockHash) || a.txHash.localeCompare(b.txHash) || a.index - b.index);
    const anchorWindow = { fromBlock, toBlock: pin.blockNumber, blockCount: pin.blockNumber - fromBlock + 1, logCount: logs.length, digest: digest(logRows), rawLogsPersisted: false };
    stage = "pin-recheck"; const recheck = await rpc(row.url, "eth_getBlockByNumber", [hex(pin.blockNumber), false], 10000); const retainedHashStable = lower(recheck?.hash) === pin.blockHash;
    let finalityQualification;
    if (row.finalizedSupported) finalityQualification = { mode: "reported-finalized-height-bound", finalizedSupported: true, finalizedHeight: row.finalizedNumber, finalizedHeightAtLeastPin: row.finalizedNumber >= pin.blockNumber };
    else finalityQualification = { mode: "finalized-unsupported/retained-hash-stability-only", finalizedSupported: false, finalizedHeight: null, finalizedHeightAtLeastPin: null, finalizedProbeCategory: row.finalizedProbeCategory };
    const receive = routes.find((route) => route.binding.direction === "receive");
    const tuple = { selection: digest(routes.map((route) => route.digests.selection)), codeVersion: digest(routes.map((route) => route.digests.codeVersion)), config: digest(routes.map((route) => route.digests.config)), state: digest({ routes: routes.map((route) => route.digests.state), integration: integration.digest }), negativeType1: receive.digests.negativeType1, integration: integration.digest };
    const complete = routes.every((route) => route.complete) && retainedHashStable && (row.finalizedSupported ? row.finalizedNumber >= pin.blockNumber : true);
    return { providerId, familyId, familyClass: row.familyClass, exactPin: true, headNumber: row.headNumber, headDistanceAtPin: row.headNumber - pin.blockNumber, retainedHashStable, finalityQualification, archiveProbe: row.archiveProbe, routes, integration, anchorWindow, tuple, complete, failureCategory: null };
  } catch (error) {
    const finalityQualification = row.finalizedSupported ? { mode: "reported-finalized-height-bound", finalizedSupported: true, finalizedHeight: row.finalizedNumber, finalizedHeightAtLeastPin: row.finalizedNumber >= pin.blockNumber } : { mode: "finalized-unsupported/retained-hash-stability-only", finalizedSupported: false, finalizedHeight: null, finalizedHeightAtLeastPin: null, finalizedProbeCategory: row.finalizedProbeCategory };
    return { providerId, familyId, familyClass: row.familyClass, exactPin: true, retainedHashStable: false, finalityQualification, archiveProbe: row.archiveProbe, routes: partialRoutes, integration: null, anchorWindow: null, tuple: null, complete: false, failureCategory: errorClass(error), failureStage: stage };
  }
}

function aggregateFamilies(providers) {
  const grouped = new Map(); for (const provider of providers) { const rows = grouped.get(provider.familyId) || []; rows.push(provider); grouped.set(provider.familyId, rows); }
  return [...grouped.entries()].map(([familyId, rows]) => {
    const keys = ["selection", "codeVersion", "config", "state", "negativeType1", "integration"]; const equality = Object.fromEntries(keys.map((key) => [key, rows.every((row) => row.tuple?.[key]) && new Set(rows.map((row) => row.tuple[key])).size === 1])); equality.anchor = rows.every((row) => row.anchorWindow?.digest) && new Set(rows.map((row) => row.anchorWindow.digest)).size === 1;
    const complete = rows.every((row) => row.complete) && Object.values(equality).every(Boolean);
    return { familyId, familyClass: rows[0].familyClass, providerCount: rows.length, completeProviderCount: rows.filter((row) => row.complete).length, equality, complete, tuple: complete ? rows[0].tuple : null, anchorDigest: complete ? rows[0].anchorWindow.digest : null, finalityModes: [...new Set(rows.map((row) => row.finalityQualification?.mode).filter(Boolean))], authenticatedArchiveUsable: rows.some((row) => row.archiveProbe?.authenticatedHint && row.archiveProbe?.historicalStateAvailable) };
  }).sort((a, b) => a.familyId.localeCompare(b.familyId));
}

function consensus(families, keys) {
  const groups = new Map();
  for (const family of families.filter((row) => row.complete)) { const key = keys.map((item) => item === "anchor" ? family.anchorDigest : family.tuple[item]).join(":"); const set = groups.get(key) || new Set(); set.add(family.familyId); groups.set(key, set); }
  return Math.max(0, ...[...groups.values()].map((set) => set.size));
}

function assertNoLeak(text) {
  if (/(?:https?|wss?):\/\//i.test(text)) throw new Error("scheme-leak");
  if (/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|xyz|cloud|tech|finance|money|pro)\b/i.test(text)) throw new Error("host-leak");
  if (/(?:authorization|x-api-key|api-key|apikey|api_key|bearer|cookie|set-cookie)\s*[:=]\s*[^\s,}\]]+/i.test(text)) throw new Error("credential-leak");
  if (/"(?:url|domain|providerName|rawLine|headers?)"\s*:/i.test(text)) throw new Error("endpoint-field-leak");
}

function report(raw) {
  const rows = raw.exemplar?.routes.map((route) => `| ${route.routeId} | ${route.binding["app"]} | ${route.binding.remoteEid} | ${route.binding.direction} | ${route.selection.selectedLibrary} | ${route.selection.isDefault} | ${route.semantics.messageLibType} | ${route.semantics.version.major}.${route.semantics.version.minor}.${route.semantics.version.endpointVersion} | ${route.semantics.behavioralFamilyStatus} |`).join("\n") || "| unavailable | unavailable | 0 | unavailable | unavailable | unavailable | unavailable | unavailable | fail-closed |";
  const evidenceText = raw.exemplar ? `- Receive config type 1 completed the strict \`${ERROR_SIGNATURE}\` argument 1 check.\n- Send config types 1/2 and receive type 2 succeeded and strictly decoded.\n- Receiver, adapters, endpoint, token balances, and receiver-to-adapter allowances are retained as public state or digests.\n- Anchor coverage is bounded to ${ANCHOR_BLOCKS} blocks and is not full history.` : `- The sole chain-999 candidate failed closed at stage \`${raw.providers[0]?.failureStage || "unresolved"}\`; no selected-library/config/integration/anchor behavioral tuple is claimed.\n- Receive type 1, receive type 2, send types 1/2, balances, allowances, and bounded anchor equality therefore remain unproven in R9.`;
  return `# 🟠 WATCH — EtherFi BeHYPE HyperEVM selected-library coverage r9\n\n**Run:** \`${raw.runId}\`  \n**Revision:** \`${raw.revision}\`  \n**Classification:** \`${raw.classification}\`  \n**Gates:** \`0/0/false\`; \`fork=false\`\n\n## Result\n\n${QUALIFICATION}\n\nA fresh conservative numeric HyperEVM pin was selected at ${raw.pin.blockNumber} / \`${raw.pin.blockHash}\`. Finality is qualified per observed group: reported-finalized only where supported; otherwise retained-hash stability only.\n\n| Metric | Count |\n|---|---:|\n| Authorized candidates tested | ${raw.metrics.authorizedCandidatesTested} |\n| Chain-999 candidates | ${raw.metrics.chain999Candidates} |\n| Exact-pin groups | ${raw.metrics.exactPinFamilies} |\n| Complete groups | ${raw.metrics.completeFamilies} |\n| Full behavioral + anchor agreement | ${raw.consensus.full} |\n\n| Route | App | EID | Direction | Selected library | Default | Type | Version | Status |\n|---|---|---:|---|---|---|---|---|---|\n${rows}\n\n${evidenceText}\n- Exact official runtime equivalence remains null; behavioral binding only.\n- Authenticated archive family status: \`${raw.authenticatedArchiveFamilyStatus}\`.\n- No economics, stake, send, message, retry, sweep, signing, fork, transaction, or mutation occurred.\n\n**nextReadOnlyStep:** ${raw.nextReadOnlyStep}\n`;
}

function offlineFinalize() {
  const raw = JSON.parse(fs.readFileSync(abs(RAW), "utf8"));
  raw.offlineFinalization = { networkCalls: false, endpointInventoryReads: false, evidenceValuesChanged: false, wordingCorrectionOnly: true, finalizedAt: new Date().toISOString() };
  delete raw.runId;
  raw.runId = `etherfi-behype-hyperevm-r9-${digest(raw).slice(0, 20)}-${hashFile(SCANNER).sha256.slice(0, 12)}`;
  writeOwned(RAW, JSON.stringify(canonical(raw), null, 2) + "\n"); writeOwned(REPORT, report(raw));
  const inbox = canonical({ findingId: NAME, revision: REVISION, runId: raw.runId, agentId: AGENT, role: "critical-research", status: raw.classification, classification: raw.classification, providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: raw.pin, metrics: raw.metrics, finalitySummary: raw.finalitySummary, consensus: raw.consensus, coverageReady: raw.coverageReady, authenticatedArchiveFamilyStatus: raw.authenticatedArchiveFamilyStatus, immutablePredecessorR8: raw.immutablePredecessorR8, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF, R8_RAW, R8_MANIFEST, ...LZ_SOURCES], nextAction: raw.nextReadOnlyStep });
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  const handoff = `# EtherFi BeHYPE HyperEVM R9 handoff\n\n- Run \`${raw.runId}\`; classification \`${raw.classification}\`; gates \`0/0/false\`, fork=false.\n- ${QUALIFICATION}\n- Conservative pin ${raw.pin.blockNumber} / \`${raw.pin.blockHash}\`; exact-pin/complete groups ${raw.metrics.exactPinFamilies}/${raw.metrics.completeFamilies}.\n- Full behavioral agreement=${raw.consensus.full}; coverageReady=${raw.coverageReady}.\n- Sole chain-999 candidate failed closed at stage \`${raw.providers[0]?.failureStage || "unresolved"}\`; no route/config/integration/anchor tuple is claimed.\n- Candidate reported finalized height >= pin, but there is no complete-family finality or retained-hash claim.\n- Authenticated archive status=\`${raw.authenticatedArchiveFamilyStatus}\`. Exact official runtime equivalence remains null.\n- Optimism R8-r2 is immutable predecessor only and was not rerun. No endpoint identifiers or secrets persisted.\n- Offline finalization changed wording only; no additional network/inventory calls.\n- Next: ${raw.nextReadOnlyStep}\n`;
  writeOwned(HANDOFF, handoff);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, R8_RAW, R8_MANIFEST, ...LZ_SOURCES].map(hashFile); const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  const manifest = canonical({ schemaVersion: 1, revision: REVISION, runId: raw.runId, generatedAt: raw.generatedAt, classification: raw.classification, algorithm: "sha256", providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: raw.pin, metrics: raw.metrics, finalitySummary: raw.finalitySummary, consensus: raw.consensus, coverageReady: raw.coverageReady, authenticatedArchiveFamilyStatus: raw.authenticatedArchiveFamilyStatus, immutablePredecessorR8: raw.immutablePredecessorR8, officialLayerZero: raw.officialLayerZero, gates: raw.gates, safety: raw.safety, offlineFinalization: raw.offlineFinalization, records, aggregateSha256 });
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF]) assertNoLeak(fs.readFileSync(abs(rel), "utf8"));
  process.stdout.write(JSON.stringify({ runId: raw.runId, classification: raw.classification, pin: raw.pin, familyCounts: { exactPin: raw.metrics.exactPinFamilies, complete: raw.metrics.completeFamilies }, finalitySummary: raw.finalitySummary, consensus: raw.consensus, coverageReady: raw.coverageReady, authenticatedArchiveFamilyStatus: raw.authenticatedArchiveFamilyStatus, manifestAggregateSha256: aggregateSha256, offlineFinalization: raw.offlineFinalization, gates: raw.gates, nextReadOnlyStep: raw.nextReadOnlyStep }) + "\n");
}

async function main() {
  const officialUrl = process.env.HYPEREVM_OFFICIAL_RPC;
  if (!officialUrl) throw new Error("official-endpoint-memory-input-missing");
  const generatedAt = new Date().toISOString(); const inventoryText = fs.readFileSync(RPC_INVENTORY, "utf8"); const inventoryUrls = extractUrls(inventoryText).filter((url) => url !== officialUrl);
  const candidates = [{ url: officialUrl, familyKey: "declared-official-family", familyClass: "declared-official-public", authenticatedHint: false }, ...inventoryUrls.map((url) => ({ url, familyKey: `inventory:${hostFamily(url)}`, familyClass: "observed-inventory", authenticatedHint: inventoryAuthHint(url) }))];
  const probed = await probeCandidates(candidates);
  const chainRows = probed.filter((row) => row.chainId === CHAIN_ID && row.status === "chain-head");
  for (const row of chainRows) {
    let historicalStateAvailable = false;
    if (row.familyClass === "observed-inventory" && row.authenticatedHint) {
      try { const old = Math.max(1, row.headNumber - 100000); const code = await rpc(row.url, "eth_getCode", [ENDPOINT, hex(old)], 10000); historicalStateAvailable = typeof code === "string"; } catch {}
    }
    row.archiveProbe = { authenticatedHint: row.authenticatedHint, attempted: row.familyClass === "observed-inventory" && row.authenticatedHint, historicalStateAvailable };
  }
  const pinChoice = choosePin(chainRows); if (!pinChoice) throw new Error("no-chain999-pin-candidate"); const pin = await bindPin(chainRows, pinChoice.blockNumber); if (!pin) throw new Error("numeric-pin-unavailable");
  const familyKeys = [...new Set(pin.rows.map((row) => row.familyKey))].sort((a, b) => a === "declared-official-family" ? -1 : b === "declared-official-family" ? 1 : a.localeCompare(b)); const familyIds = new Map(familyKeys.map((key, index) => [key, `hyperevm-family-${String(index + 1).padStart(2, "0")}`]));
  const providers = await parallelMap(pin.rows, 5, (row, index) => providerObservation(row, pin, `hyperevm-provider-${String(index + 1).padStart(2, "0")}`, familyIds.get(row.familyKey)));
  const families = aggregateFamilies(providers);
  const counts = { selection: consensus(families, ["selection", "anchor"]), codeVersion: consensus(families, ["codeVersion", "anchor"]), config: consensus(families, ["config", "anchor"]), integration: consensus(families, ["integration", "anchor"]), state: consensus(families, ["state", "anchor"]), negativeType1: consensus(families, ["negativeType1", "anchor"]), full: consensus(families, ["selection", "codeVersion", "config", "integration", "state", "negativeType1", "anchor"]) };
  const coverageReady = counts.full >= 2; const officialFamilyComplete = families.some((family) => family.familyClass === "declared-official-public" && family.complete); const inventoryFamilyComplete = families.some((family) => family.familyClass === "observed-inventory" && family.complete);
  const authenticatedArchiveFamilyUsable = families.some((family) => family.familyClass === "observed-inventory" && family.authenticatedArchiveUsable);
  const authenticatedInventoryCandidates = chainRows.filter((row) => row.familyClass === "observed-inventory" && row.authenticatedHint).length;
  const authenticatedArchiveFamilyStatus = authenticatedArchiveFamilyUsable ? "observed-authenticated-archive-family-usable" : authenticatedInventoryCandidates ? "authenticated-inventory-candidate-observed-but-archive-family-unusable-or-incomplete" : "authenticated-archive-family-absent-or-unusable-in-authorized-inventory";
  const classification = coverageReady ? "WATCH/TWO-GROUP-HYPEREVM-BEHAVIORAL-CONSENSUS/NO-BACKEND-INDEPENDENCE-CLAIM/ECONOMICS-UNREVIEWED" : "WATCH/COVERAGE_OPEN/HYPEREVM-FAMILY-THRESHOLD-NOT-MET/NO-BACKEND-INDEPENDENCE-CLAIM";
  const nextReadOnlyStep = coverageReady ? "Perform independent audit review of the combined immutable Optimism R8-r2 and HyperEVM R9 behavioral evidence before any economics work; no economics is established by this package." : "Provision a second distinct declared/observed usable HyperEVM provider-family group, preferably an authenticated archive-capable group, and repeat one bounded fresh-pin binding without repeated retries.";
  const predecessorR8 = { status: "IMMUTABLE-PREDECESSOR/OPTIMISM-R8-R2", raw: hashFile(R8_RAW), manifest: hashFile(R8_MANIFEST) };
  const raw = {
    schemaVersion: 1, revision: REVISION, generatedAt, scanner: SCANNER, agentId: AGENT, role: "critical-research", classification, providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false,
    routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false,
    pin: { blockNumber: pin.blockNumber, blockHash: pin.blockHash, timestamp: pin.timestamp, selectionRule: "second-highest distinct-family conservative safe height when two groups exist; otherwise sole-family conservative safe height", conservativeDepthWhenFinalizedUnsupported: RETAINED_DEPTH, retainedHashStableAcrossCompleteFamilies: providers.some((row) => row.complete) && providers.filter((row) => row.complete).every((row) => row.retainedHashStable), finalizedClaimedForAllFamilies: families.some((row) => row.complete) && families.filter((row) => row.complete).every((row) => row.finalityModes.every((mode) => mode === "reported-finalized-height-bound")) },
    routeDefinitions: ROUTES,
    metrics: { authorizedCandidatesTested: candidates.length, inventoryCandidatesParsed: inventoryUrls.length, chain999Candidates: chainRows.length, chain999ObservedFamilies: new Set(chainRows.map((row) => row.familyKey)).size, chain999ReportedFinalizedCandidates: chainRows.filter((row) => row.finalizedSupported).length, chain999RetainedHashOnlyCandidates: chainRows.filter((row) => !row.finalizedSupported).length, exactPinProviders: pin.rows.length, exactPinFamilies: familyKeys.length, completeProviders: providers.filter((row) => row.complete).length, completeFamilies: families.filter((row) => row.complete).length, officialFamilyComplete, inventoryFamilyComplete, authenticatedInventoryCandidates },
    providers, families, consensus: counts, coverageReady, exemplar: providers.find((provider) => provider.complete) || null,
    finalitySummary: { reportedFinalizedCandidatesAtPin: pin.rows.filter((row) => row.finalizedSupported && row.finalizedNumber >= pin.blockNumber).length, retainedHashOnlyCandidatesAtPin: pin.rows.filter((row) => !row.finalizedSupported).length, reportedFinalizedCompleteFamilies: families.filter((family) => family.complete && family.finalityModes.every((mode) => mode === "reported-finalized-height-bound")).length, retainedHashOnlyCompleteFamilies: families.filter((family) => family.complete && family.finalityModes.includes("finalized-unsupported/retained-hash-stability-only")).length, noUniversalFinalityClaim: true },
    authenticatedArchiveFamilyStatus,
    officialFamilyBinding: { familyClass: "declared-official-public", endpointIdentifierPersisted: false, officialDocsIdentificationProvidedByUser: true, complete: officialFamilyComplete },
    inventoryFamilyBinding: { familyClass: "observed-inventory", endpointIdentifiersPersisted: false, completeFamilyCount: families.filter((family) => family.familyClass === "observed-inventory" && family.complete).length },
    immutablePredecessorR8: predecessorR8,
    officialLayerZero: { exactOfficialRuntimeEquivalence: null, qualification: "behavioral binding only", sourceRecords: LZ_SOURCES.map(hashFile) },
    gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, hyperevmTwoGroupBehavioralConsensus: coverageReady, optimismPredecessorBehavioralConsensus: true, reviewedTwoChainConsensus: false, economicsBlocked: true },
    safety: { readOnly: true, officialEndpointUsedFromProcessMemory: true, rpcInventoryRead: true, endpointIdentifiersPersisted: false, providerNamesPersisted: false, providerDomainsPersisted: false, keysPersisted: false, headersPersisted: false, rawInventoryLinesPersisted: false, economicsCalls: false, transactions: false, stakeCalls: false, messageSendCalls: false, retryCalls: false, sweepCalls: false, signing: false, forkCreated: false, mutation: false },
    nextReadOnlyStep,
  };
  const runId = `etherfi-behype-hyperevm-r9-${digest(raw).slice(0, 20)}-${hashFile(SCANNER).sha256.slice(0, 12)}`; raw.runId = runId;
  writeOwned(RAW, JSON.stringify(canonical(raw), null, 2) + "\n"); writeOwned(REPORT, report(raw));
  const inbox = canonical({ findingId: NAME, revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: classification, classification, providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: raw.pin, metrics: raw.metrics, finalitySummary: raw.finalitySummary, consensus: counts, coverageReady, authenticatedArchiveFamilyStatus, immutablePredecessorR8: predecessorR8, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF, R8_RAW, R8_MANIFEST, ...LZ_SOURCES], nextAction: nextReadOnlyStep });
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  const handoff = `# EtherFi BeHYPE HyperEVM R9 handoff\n\n- Run \`${runId}\`; classification \`${classification}\`; gates \`0/0/false\`, fork=false.\n- ${QUALIFICATION}\n- Conservative pin ${pin.blockNumber} / \`${pin.blockHash}\`; exact-pin/complete groups ${raw.metrics.exactPinFamilies}/${raw.metrics.completeFamilies}.\n- Selection/code/config/integration/state/negative/full agreement ${counts.selection}/${counts.codeVersion}/${counts.config}/${counts.integration}/${counts.state}/${counts.negativeType1}/${counts.full}.\n- Finality: reported-finalized complete groups=${raw.finalitySummary.reportedFinalizedCompleteFamilies}; retained-hash-only complete groups=${raw.finalitySummary.retainedHashOnlyCompleteFamilies}; no universal finality claim.\n- Official declared family complete=${officialFamilyComplete}; observed inventory complete groups=${raw.inventoryFamilyBinding.completeFamilyCount}; authenticated archive status=\`${authenticatedArchiveFamilyStatus}\`.\n- Exact official runtime equivalence remains null. Optimism R8-r2 is immutable predecessor only and was not rerun.\n- No endpoint identifiers/provider names/domains/keys/headers/raw inventory persisted. No economics/transaction/stake/send/message/retry/sweep/signing/fork/mutation.\n- Next: ${nextReadOnlyStep}\n`;
  writeOwned(HANDOFF, handoff);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, R8_RAW, R8_MANIFEST, ...LZ_SOURCES].map(hashFile); const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  const manifest = canonical({ schemaVersion: 1, revision: REVISION, runId, generatedAt, classification, algorithm: "sha256", providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: raw.pin, metrics: raw.metrics, finalitySummary: raw.finalitySummary, consensus: counts, coverageReady, authenticatedArchiveFamilyStatus, immutablePredecessorR8: predecessorR8, officialLayerZero: raw.officialLayerZero, gates: raw.gates, safety: raw.safety, records, aggregateSha256 });
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF]) assertNoLeak(fs.readFileSync(abs(rel), "utf8"));
  process.stdout.write(JSON.stringify({ runId, classification, pin: raw.pin, familyCounts: { chain999Observed: raw.metrics.chain999ObservedFamilies, exactPin: raw.metrics.exactPinFamilies, complete: raw.metrics.completeFamilies, officialComplete: officialFamilyComplete, inventoryComplete: raw.inventoryFamilyBinding.completeFamilyCount }, finalitySummary: raw.finalitySummary, consensus: counts, coverageReady, authenticatedArchiveFamilyStatus, manifestAggregateSha256: aggregateSha256, gates: raw.gates, nextReadOnlyStep }) + "\n");
}

if (process.argv.includes("--offline-finalize")) {
  try { offlineFinalize(); } catch { process.stderr.write("HyperEVM R9 offline finalization failed: sanitized internal error\n"); process.exitCode = 1; }
} else main().catch((error) => { process.stderr.write(`HyperEVM R9 failed: ${errorClass(error)}\n`); process.exitCode = 1; });
