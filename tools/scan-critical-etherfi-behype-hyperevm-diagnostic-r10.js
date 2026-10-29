#!/usr/bin/env node
"use strict";

// One-pass HyperEVM diagnostic. Endpoint and target addresses are loaded into
// process memory from authorized/private inventory and retained evidence. No
// URL, domain, provider identity, raw response, or target address is emitted.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AbiCoder, Interface, getAddress, id, keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-hyperevm-diagnostic-r10";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-22-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-22-${NAME}-handoff.md`;
const R9_RAW = "reports/raw/fast/critical-etherfi-behype-hyperevm-coverage-r9.json";
const R9_MANIFEST = "reports/raw/fast/critical-etherfi-behype-hyperevm-coverage-r9-manifest.json";
const R8_RAW = "reports/raw/fast/critical-etherfi-behype-receive-type1-negative-check.json";
const R8_MANIFEST = "reports/raw/fast/critical-etherfi-behype-receive-type1-negative-check-manifest.json";
const STEP4 = "reports/raw/fast/critical-etherfi-behype-staker-layerzero-binding.json";
const RPC_INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const REVISION = "etherfi-behype-hyperevm-diagnostic-r10-substage-partial-evidence";
const AGENT = "critical-etherfi-behype-hyper-diagnostic-r10-20260722";
const CLASSIFICATION = "WATCH/COVERAGE_OPEN/HYPEREVM-DIAGNOSTIC-FAIL-CLOSED/NO-BACKEND-INDEPENDENCE-CLAIM";
const QUALIFICATION = "Observed groups are declared/hostname-derived provider-family groups; backend/operator independence is not established.";
const CHAIN_ID = 999;
const ANCHOR_BLOCKS = 50;
const RETAINED_DEPTH = 8;
const SUBSTAGES = ["app-runtime", "app-endpoint-peer", "library-selection", "library-runtime", "library-semantics", "applicable-config", "receive-type1-negative", "integration", "anchor", "pin-recheck"];
const ABI = AbiCoder.defaultAbiCoder();
const ERROR_SELECTOR = id("LZ_ULN_InvalidConfigType(uint32)").slice(0, 10).toLowerCase();

const ENDPOINT_IFACE = new Interface([
  "function getSendLibrary(address,uint32) view returns(address)",
  "function isDefaultSendLibrary(address,uint32) view returns(bool)",
  "function getReceiveLibrary(address,uint32) view returns(address,bool)",
  "function isRegisteredLibrary(address) view returns(bool)",
  "function getConfig(address,address,uint32,uint32) view returns(bytes)",
]);
const LIB_IFACE = new Interface(["function messageLibType() view returns(uint8)", "function version() view returns(uint64,uint8,uint8)", "function isSupportedEid(uint32) view returns(bool)"]);
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
const fromWord = (word) => { if (typeof word !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(word)) return null; const out = address(`0x${word.slice(-40)}`); return out && !/^0x0{40}$/.test(out) ? out : null; };

function writeOwned(rel, body) {
  if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error("write-refused");
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body, "utf8");
}

function errorCategory(error) {
  const status = Number(error?.status); const code = Number(error?.code); const text = String(error?.message || error || "").toLowerCase();
  if (status === 401 || status === 403) return "auth-or-origin-rejected";
  if (status === 429 || text.includes("rate")) return "rate-limited";
  if (code === -32601) return "method-unsupported";
  if (text.includes("abort") || text.includes("timeout")) return "timeout";
  if (text.includes("revert")) return "contract-revert";
  if (status >= 400 && status < 500) return "http-4xx";
  if (status >= 500) return "http-5xx";
  if (text.includes("decode") || text.includes("canonical") || text.includes("envelope")) return "decode-or-schema-failure";
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
  const result = await rpcResponse(url, method, params, timeout);
  if (result?.error) throw Object.assign(new Error("RPC failure"), { code: result.error.code });
  return result?.result;
}

function extractUrls(text) {
  const normalized = String(text || "").replace(/\\\//g, "/"); const out = [];
  for (const match of normalized.matchAll(/(?:https?|wss?):\/\/[^\s"'`,;<>\]\[{}]+/gi)) try { const parsed = new URL(match[0].replace(/[).]+$/, "")); if (parsed.protocol === "wss:") parsed.protocol = "https:"; if (["http:", "https:"].includes(parsed.protocol)) out.push(parsed.href); } catch {}
  for (const match of normalized.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s"'`,;<>\]\[{}]*)?/gi)) try { out.push(new URL(`https:${"/"}${"/"}${match[0].replace(/[).]+$/, "")}`).href); } catch {}
  return [...new Set(out)];
}

function familyKey(url) {
  const host = new URL(url).hostname.toLowerCase(); const parts = host.split(".").filter(Boolean);
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

async function parallelMap(items, limit, fn) {
  const out = new Array(items.length); let cursor = 0;
  async function worker() { while (true) { const index = cursor++; if (index >= items.length) return; out[index] = await fn(items[index], index); } }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker)); return out;
}

async function probe(candidates) {
  return parallelMap(candidates, 24, async (row) => {
    try {
      const chainId = num(await rpc(row.url, "eth_chainId", [], 8000));
      if (chainId !== CHAIN_ID) return { ...row, chainId, status: "other-chain" };
      const headNumber = num(await rpc(row.url, "eth_blockNumber", [], 8000)); const head = await rpc(row.url, "eth_getBlockByNumber", [hex(headNumber), false], 8000);
      if (!head?.hash) return { ...row, chainId, status: "head-unavailable" };
      let finalizedSupported = false; let finalizedNumber = null; let finalizedCategory = null;
      try { const finalized = await rpc(row.url, "eth_getBlockByNumber", ["finalized", false], 8000); if (finalized?.hash) { finalizedSupported = true; finalizedNumber = num(finalized.number); } else finalizedCategory = "empty-finalized"; }
      catch (error) { finalizedCategory = errorCategory(error); }
      return { ...row, chainId, status: "chain-head", headNumber, headHash: lower(head.hash), finalizedSupported, finalizedNumber, finalizedCategory, safeHeight: finalizedSupported ? finalizedNumber : Math.max(0, headNumber - RETAINED_DEPTH) };
    } catch (error) { return { ...row, status: errorCategory(error) }; }
  });
}

function choosePin(rows) {
  const usable = rows.filter((row) => row.status === "chain-head"); const familyHeights = new Map();
  for (const row of usable) familyHeights.set(row.familyKey, Math.max(familyHeights.get(row.familyKey) || 0, row.safeHeight));
  const heights = [...familyHeights.values()].sort((a, b) => b - a); return heights.length ? (heights.length >= 2 ? heights[1] : heights[0]) : null;
}

async function bindPin(rows, pinNumber) {
  const eligible = rows.filter((row) => row.status === "chain-head" && row.safeHeight >= pinNumber);
  const checked = await parallelMap(eligible, 10, async (row) => {
    try { const block = await rpc(row.url, "eth_getBlockByNumber", [hex(pinNumber), false], 10000); return block?.hash && num(block.number) === pinNumber ? { ...row, exactPin: true, pinHash: lower(block.hash), pinTimestamp: num(block.timestamp) } : { ...row, exactPin: false }; }
    catch (error) { return { ...row, exactPin: false, pinCategory: errorCategory(error) }; }
  });
  const groups = new Map(); for (const row of checked.filter((item) => item.exactPin)) { const set = groups.get(row.pinHash) || new Set(); set.add(row.familyKey); groups.set(row.pinHash, set); }
  const winner = [...groups.entries()].sort((a, b) => b[1].size - a[1].size)[0]; if (!winner) return null;
  return { blockNumber: pinNumber, blockHash: winner[0], timestamp: checked.find((row) => row.pinHash === winner[0]).pinTimestamp, rows: checked.filter((row) => row.exactPin && row.pinHash === winner[0]), familyCount: winner[1].size };
}

async function strictCall(url, to, iface, name, args, block) {
  const fragment = iface.getFunction(name); const data = iface.encodeFunctionData(fragment, args); const raw = lower(await rpc(url, "eth_call", [{ to, data }, hex(block)]));
  if (typeof raw !== "string" || !/^0x[0-9a-f]*$/.test(raw)) throw new Error("invalid-envelope"); const decoded = iface.decodeFunctionResult(fragment, raw);
  if (lower(iface.encodeFunctionResult(fragment, [...decoded])) !== raw) throw new Error("noncanonical-envelope"); return { raw, decoded };
}

function newCheck(substage) { return { substage, status: "pending", category: null, successfulBooleanCount: 0, digestCount: 0, digests: {} }; }
function succeed(check, category, fields = {}, digests = {}) { Object.assign(check, { status: "success", category, ...fields, digests, successfulBooleanCount: Object.values(fields).filter((value) => value === true).length, digestCount: Object.keys(digests).length }); }
function fail(check, category, fields = {}, digests = {}) { Object.assign(check, { status: "failed", category, ...fields, digests, successfulBooleanCount: Object.values(fields).filter((value) => value === true).length, digestCount: Object.keys(digests).length }); }
function block(check, category) { Object.assign(check, { status: "blocked", category }); }
function notApplicable(check) { Object.assign(check, { status: "not-applicable", category: "direction-not-applicable" }); }

async function runtimeCheck(url, target, block, check) {
  try {
    const code = await rpc(url, "eth_getCode", [target, hex(block)]); if (!code || code === "0x") return fail(check, "code-absent", { codePresent: false });
    const words = {}; let slotsComplete = true;
    for (const [name, slot] of Object.entries(EIP1967)) try { words[name] = await rpc(url, "eth_getStorageAt", [target, slot, hex(block)]); } catch { words[name] = null; slotsComplete = false; }
    const proxy = { implementationPresent: Boolean(fromWord(words.implementation)), adminPresent: Boolean(fromWord(words.admin)), beaconPresent: Boolean(fromWord(words.beacon)), slotsComplete };
    const proxyAmbiguous = proxy.implementationPresent && proxy.beaconPresent;
    const fields = { codePresent: true, proxySlotsComplete: slotsComplete, proxyAmbiguous };
    const digests = { codeHash: keccak256(code), runtimeDigest: digest({ codeHash: keccak256(code), proxy }) };
    if (!slotsComplete) fail(check, "proxy-slots-partial", fields, digests);
    else if (proxyAmbiguous) fail(check, "proxy-ambiguous", fields, digests);
    else succeed(check, "runtime-and-proxy-slots-bound", fields, digests);
    check._address = target; check._code = code;
  } catch (error) { fail(check, errorCategory(error)); }
}

function decodeConfig(payload, type) {
  const types = type === 1 ? ["tuple(uint32 maxMessageSize,address executor)"] : ["tuple(uint64 confirmations,uint8 requiredDVNCount,uint8 optionalDVNCount,uint8 optionalDVNThreshold,address[] requiredDVNs,address[] optionalDVNs)"];
  const decoded = ABI.decode(types, payload); if (lower(ABI.encode(types, [...decoded])) !== lower(payload)) throw new Error("noncanonical-config"); return digest(canonical(decoded[0]));
}

function collectHex(value, depth = 0, out = []) {
  if (depth > 8 || value == null) return out;
  if (typeof value === "string") { if (/^0x[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) out.push(lower(value)); return out; }
  if (Array.isArray(value)) for (const item of value) collectHex(item, depth + 1, out); else if (typeof value === "object") for (const item of Object.values(value)) collectHex(item, depth + 1, out); return out;
}

async function diagnoseRoute(url, route, targets, pin) {
  const checks = Object.fromEntries(SUBSTAGES.map((name) => [name, newCheck(name)]));
  const app = route["app"]; const eid = route.eid; const direction = route.direction;
  await runtimeCheck(url, app, pin.blockNumber, checks["app-runtime"]);

  try {
    const [endpointCall, peerCall] = await Promise.all([strictCall(url, app, OAPP_IFACE, "endpoint", [], pin.blockNumber), strictCall(url, app, OAPP_IFACE, "peers", [eid], pin.blockNumber)]);
    const endpointMatches = address(endpointCall.decoded[0]) === targets.endpoint; const peerNonzero = BigInt(peerCall.decoded[0]) !== 0n;
    const bindingDigests = { peerDigest: digest(lower(peerCall.decoded[0])), bindingDigest: digest({ endpointMatches, peerNonzero }) };
    endpointMatches && peerNonzero ? succeed(checks["app-endpoint-peer"], "endpoint-and-peer-bound", { endpointMatches, peerNonzero }, bindingDigests) : fail(checks["app-endpoint-peer"], endpointMatches ? "peer-empty-or-mismatch" : "endpoint-mismatch", { endpointMatches, peerNonzero }, bindingDigests);
  } catch (error) { fail(checks["app-endpoint-peer"], errorCategory(error)); }

  let library = null;
  try {
    if (direction === "send") {
      const [selected, defaultCall] = await Promise.all([strictCall(url, targets.endpoint, ENDPOINT_IFACE, "getSendLibrary", [app, eid], pin.blockNumber), strictCall(url, targets.endpoint, ENDPOINT_IFACE, "isDefaultSendLibrary", [app, eid], pin.blockNumber)]);
      library = address(selected.decoded[0]); const fields = { selectedAddressValid: Boolean(library), isDefault: Boolean(defaultCall.decoded[0]), strictReturnShape: true }; const digests = { selectionDigest: digest({ method: "send-library-plus-default", selected: library, isDefault: Boolean(defaultCall.decoded[0]) }) };
      library ? succeed(checks["library-selection"], "send-address-plus-default-decoded", fields, digests) : fail(checks["library-selection"], "selected-library-invalid", fields, digests);
    } else {
      const selected = await strictCall(url, targets.endpoint, ENDPOINT_IFACE, "getReceiveLibrary", [app, eid], pin.blockNumber); library = address(selected.decoded[0]); const fields = { selectedAddressValid: Boolean(library), isDefault: Boolean(selected.decoded[1]), strictReturnShape: true }; const digests = { selectionDigest: digest({ method: "receive-library", selected: library, isDefault: Boolean(selected.decoded[1]) }) };
      library ? succeed(checks["library-selection"], "receive-address-bool-decoded", fields, digests) : fail(checks["library-selection"], "selected-library-invalid", fields, digests);
    }
  } catch (error) { fail(checks["library-selection"], errorCategory(error)); }

  if (library) await runtimeCheck(url, library, pin.blockNumber, checks["library-runtime"]); else block(checks["library-runtime"], "library-selection-unavailable");

  if (library) {
    try {
      const [typeCall, versionCall, supportedCall, registeredCall] = await Promise.all([strictCall(url, library, LIB_IFACE, "messageLibType", [], pin.blockNumber), strictCall(url, library, LIB_IFACE, "version", [], pin.blockNumber), strictCall(url, library, LIB_IFACE, "isSupportedEid", [eid], pin.blockNumber), strictCall(url, targets.endpoint, ENDPOINT_IFACE, "isRegisteredLibrary", [library], pin.blockNumber)]);
      const typeValue = Number(typeCall.decoded[0]); const typeLabel = ({ 0: "Send", 1: "Receive", 2: "SendAndReceive" })[typeValue] || "Unknown"; const version = { major: versionCall.decoded[0].toString(), minor: Number(versionCall.decoded[1]), endpointVersion: Number(versionCall.decoded[2]) }; const directionMatches = direction === "send" ? ["Send", "SendAndReceive"].includes(typeLabel) : ["Receive", "SendAndReceive"].includes(typeLabel); const versionMatches = version.major === "3" && version.minor === 0 && version.endpointVersion === 2; const supported = Boolean(supportedCall.decoded[0]); const registered = Boolean(registeredCall.decoded[0]);
      const fields = { directionMatches, versionMatches, supportedEid: supported, registeredAtEndpoint: registered, messageLibType: typeLabel, version }; const digests = { semanticsDigest: digest({ typeLabel, version, supported, registered }) };
      directionMatches && versionMatches && supported && registered ? succeed(checks["library-semantics"], "type-version-eid-registration-bound", fields, digests) : fail(checks["library-semantics"], "semantic-value-mismatch", fields, digests);
    } catch (error) { fail(checks["library-semantics"], errorCategory(error)); }
  } else block(checks["library-semantics"], "library-selection-unavailable");

  if (library) {
    const configRows = [];
    for (const type of route.configTypes) {
      try { const call = await strictCall(url, targets.endpoint, ENDPOINT_IFACE, "getConfig", [app, library, eid, type], pin.blockNumber); const payload = lower(call.decoded[0]); configRows.push({ configType: type, status: "success", envelopeBytes: (call.raw.length - 2) / 2, payloadBytes: (payload.length - 2) / 2, envelopeDigest: keccak256(call.raw), payloadDigest: keccak256(payload), decodedDigest: decodeConfig(payload, type) }); }
      catch (error) { configRows.push({ configType: type, status: "failed", category: errorCategory(error) }); }
    }
    const configFields = { expectedConfigCount: route.configTypes.length, successfulConfigCount: configRows.filter((row) => row.status === "success").length }; const configDigests = { configTupleDigest: digest(configRows) };
    configRows.every((row) => row.status === "success") ? succeed(checks["applicable-config"], "all-direction-applicable-configs-decoded", configFields, configDigests) : fail(checks["applicable-config"], "one-or-more-applicable-configs-failed", configFields, configDigests);
    checks["applicable-config"].configRows = configRows;
  } else block(checks["applicable-config"], "library-selection-unavailable");

  if (direction === "receive" && library) {
    try {
      const data = ENDPOINT_IFACE.encodeFunctionData("getConfig", [app, library, eid, 1]); const response = await rpcResponse(url, "eth_call", [{ to: targets.endpoint, data }, hex(pin.blockNumber)], 12000);
      if (typeof response?.result === "string") fail(checks["receive-type1-negative"], "unexpected-success", { expectedError: false });
      else {
        const candidates = [...new Set(collectHex(response?.error?.data))];
        if (candidates.length !== 1) fail(checks["receive-type1-negative"], "provider-wrapped-or-ambiguous-revert", { revertCandidateCount: candidates.length });
        else {
          const dataHex = candidates[0]; const bytes = (dataHex.length - 2) / 2; const selector = dataHex.slice(0, 10); let argument = null; let strict = false;
          try { if (bytes === 36) { argument = Number(ABI.decode(["uint32"], `0x${dataHex.slice(10)}`)[0]); strict = lower(`${selector}${ABI.encode(["uint32"], [argument]).slice(2)}`) === dataHex; } } catch {}
          const fields = { selectorMatches: selector === ERROR_SELECTOR, argumentMatches: argument === 1, strictEncoding: strict, revertDataBytes: bytes }; const digests = { revertDataDigest: keccak256(dataHex), semanticDigest: digest({ selector, argument, strict }) };
          selector === ERROR_SELECTOR && argument === 1 && strict ? succeed(checks["receive-type1-negative"], "expected-custom-error", fields, digests) : fail(checks["receive-type1-negative"], "unexpected-revert-data", fields, digests);
        }
      }
    } catch (error) { fail(checks["receive-type1-negative"], errorCategory(error)); }
  } else if (direction === "send") notApplicable(checks["receive-type1-negative"]); else block(checks["receive-type1-negative"], "library-selection-unavailable");

  try {
    const receiverRuntime = await rpc(url, "eth_getCode", [targets.receiver, hex(pin.blockNumber)]); const nativeBalance = await rpc(url, "eth_getBalance", [targets.receiver, hex(pin.blockNumber)]);
    let token = app; let tokenResolution = "self-token-after-getter-unavailable";
    try { token = address((await strictCall(url, app, ADAPTER_IFACE, "token", [], pin.blockNumber)).decoded[0]); tokenResolution = "adapter-token-getter"; } catch {}
    const [tokenCode, receiverBalance, adapterBalance, allowance] = await Promise.all([rpc(url, "eth_getCode", [token, hex(pin.blockNumber)]), strictCall(url, token, ERC20_IFACE, "balanceOf", [targets.receiver], pin.blockNumber), strictCall(url, token, ERC20_IFACE, "balanceOf", [app], pin.blockNumber), strictCall(url, token, ERC20_IFACE, "allowance", [targets.receiver, app], pin.blockNumber)]);
    if (!receiverRuntime || receiverRuntime === "0x" || !tokenCode || tokenCode === "0x") fail(checks.integration, "receiver-or-token-code-absent", { receiverCodePresent: Boolean(receiverRuntime && receiverRuntime !== "0x"), tokenCodePresent: Boolean(tokenCode && tokenCode !== "0x") }, { partialIntegrationDigest: digest({ receiverCodePresent: Boolean(receiverRuntime && receiverRuntime !== "0x"), tokenCodePresent: Boolean(tokenCode && tokenCode !== "0x"), tokenResolution }) });
    else { succeed(checks.integration, "receiver-adapter-balance-allowance-bound", { receiverCodePresent: true, tokenCodePresent: true, tokenResolution, balanceFieldsDecoded: true, allowanceDecoded: true }, { receiverCodeHash: keccak256(receiverRuntime), tokenCodeHash: keccak256(tokenCode), integrationDigest: digest({ nativeBalance: BigInt(nativeBalance).toString(), receiverBalance: receiverBalance.decoded[0].toString(), adapterBalance: adapterBalance.decoded[0].toString(), allowance: allowance.decoded[0].toString(), tokenResolution }) }); checks.integration._token = token; }
  } catch (error) { fail(checks.integration, errorCategory(error)); }

  try {
    const anchorTargets = [targets.endpoint, targets.receiver, app]; if (checks.integration._token) anchorTargets.push(checks.integration._token); const logs = [];
    const fromBlock = Math.max(0, pin.blockNumber - ANCHOR_BLOCKS + 1);
    for (const target of [...new Set(anchorTargets)]) { const rows = await rpc(url, "eth_getLogs", [{ address: target, fromBlock: hex(fromBlock), toBlock: hex(pin.blockNumber) }], 15000); if (!Array.isArray(rows)) throw new Error("invalid-log-response"); logs.push(...rows); }
    const compact = logs.map((log) => ({ blockHash: lower(log.blockHash), txHash: lower(log.transactionHash), index: num(log.logIndex), topics: (log.topics || []).map(lower), dataDigest: digest(lower(log.data || "0x")) }));
    succeed(checks.anchor, "bounded-anchor-logs-bound", { blockCount: pin.blockNumber - fromBlock + 1, queriedTargetCount: new Set(anchorTargets).size, logCount: logs.length }, { anchorDigest: digest(compact) });
  } catch (error) { fail(checks.anchor, errorCategory(error)); }

  try { const header = await rpc(url, "eth_getBlockByNumber", [hex(pin.blockNumber), false], 10000); const hashStable = lower(header?.hash) === pin.blockHash; hashStable ? succeed(checks["pin-recheck"], "same-number-hash-stable", { hashStable: true }) : fail(checks["pin-recheck"], "same-number-hash-mismatch", { hashStable: false }); }
  catch (error) { fail(checks["pin-recheck"], errorCategory(error)); }

  for (const check of Object.values(checks)) { delete check._address; delete check._code; delete check._token; }
  const successfulSubstages = SUBSTAGES.filter((name) => checks[name].status === "success" || checks[name].status === "not-applicable"); const failures = SUBSTAGES.filter((name) => checks[name].status === "failed"); const firstFailure = failures.length ? { failureSubstage: failures[0], failureCategory: checks[failures[0]].category } : null;
  const requiredComplete = SUBSTAGES.every((name) => checks[name].status === "success" || name === "receive-type1-negative" && direction === "send" && checks[name].status === "not-applicable");
  return { routeLabel: route.label, routeIdentityDigest: route.identityDigest, step4IdentityComparison: route.step4IdentityComparison, configuredFieldLabels: ["app", "remoteEid", "direction", "applicableConfigTypes"], substageOrder: SUBSTAGES, checks, successfulSubstages, successfulSubstageCount: successfulSubstages.length, failedSubstageCount: failures.length, firstFailure, routeComplete: requiredComplete, noRawResponsesPersisted: true, noAddressesPersisted: true };
}

function loadTargets() {
  const step4 = JSON.parse(fs.readFileSync(abs(STEP4), "utf8")); const r9 = JSON.parse(fs.readFileSync(abs(R9_RAW), "utf8"));
  const expected = {
    endpoint: address(step4.currentBindings.destinationReceiver.endpoint),
    receiver: address(step4.currentBindings.destinationReceiver.address),
    routes: {
      "whype-receive-30111": { app: address(step4.currentBindings.peers.destinationWhypeToSourceWhype.local), eid: Number(step4.currentBindings.peers.destinationWhypeToSourceWhype.eid), direction: "receive", configTypes: [2] },
      "behype-send-30111": { app: address(step4.currentBindings.peers.destinationBehypeToSourceBehype.local), eid: Number(step4.currentBindings.peers.destinationBehypeToSourceBehype.eid), direction: "send", configTypes: [1, 2] },
    },
  };
  const configuredRows = new Map(r9.routeDefinitions.map((row) => [row.direction === "receive" ? "whype-receive-30111" : "behype-send-30111", row]));
  const routes = [];
  for (const [label, expectedRoute] of Object.entries(expected.routes)) {
    const configured = configuredRows.get(label); const configuredRoute = configured ? { app: address(configured["app"]), eid: Number(configured.remoteEid), direction: configured.direction, configTypes: configured.applicableConfigTypes.map(Number) } : null;
    const fields = configuredRoute ? { appMatches: configuredRoute["app"] === expectedRoute["app"], eidMatches: configuredRoute.eid === expectedRoute.eid, directionMatches: configuredRoute.direction === expectedRoute.direction, configTypesMatch: JSON.stringify(configuredRoute.configTypes) === JSON.stringify(expectedRoute.configTypes) } : { appMatches: false, eidMatches: false, directionMatches: false, configTypesMatch: false };
    const match = Object.values(fields).every(Boolean); const mismatchCategory = !configuredRoute ? "configured-route-missing" : !fields.appMatches ? "configured-app-mismatch" : !fields.eidMatches ? "configured-eid-mismatch" : !fields.directionMatches ? "configured-direction-mismatch" : !fields.configTypesMatch ? "configured-config-types-mismatch" : "retained-step4-route-match";
    const active = match ? configuredRoute : expectedRoute;
    routes.push({ label, ...active, identityDigest: digest(active), step4IdentityComparison: { match, category: mismatchCategory, ...fields } });
  }
  return { endpoint: expected.endpoint, receiver: expected.receiver, routes, step4Hash: hashFile(STEP4) };
}

function aggregateFamilies(providers) {
  const grouped = new Map(); for (const provider of providers) { const rows = grouped.get(provider.familyId) || []; rows.push(provider); grouped.set(provider.familyId, rows); }
  return [...grouped.entries()].map(([familyId, rows]) => ({ familyId, familyClass: rows[0].familyClass, providerCount: rows.length, routeCompleteCount: rows.reduce((sum, row) => sum + row.routes.filter((route) => route.routeComplete).length, 0), complete: rows.every((row) => row.routes.every((route) => route.routeComplete)), provisionalFinalityModes: [...new Set(rows.map((row) => row.provisionalFinality.mode))] })).sort((a, b) => a.familyId.localeCompare(b.familyId));
}

function assertNoLeak(text) {
  if (/(?:https?|wss?):\/\//i.test(text)) throw new Error("scheme-leak");
  if (/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|xyz|cloud|tech|finance|money|pro)\b/i.test(text)) throw new Error("host-leak");
  if (/(?:authorization|x-api-key|api-key|apikey|api_key|bearer|cookie|set-cookie)\s*[:=]\s*[^\s,}\]]+/i.test(text)) throw new Error("credential-leak");
  if (/"(?:url|domain|providerName|rawLine|headers?|address)"\s*:/i.test(text)) throw new Error("identifier-field-leak");
}

function safetySnapshot() {
  const explicitCorrectedRetryAuthorized = process.env.R10_EXPLICIT_RETRY === "1";
  return { readOnly: true, oneBoundedPass: !explicitCorrectedRetryAuthorized, currentInvocationBoundedPass: true, boundedPassCount: explicitCorrectedRetryAuthorized ? 2 : 1, priorFailedPassCount: explicitCorrectedRetryAuthorized ? 1 : 0, repeatedRetries: explicitCorrectedRetryAuthorized, explicitCorrectedRetryAuthorized, officialEndpointFromProcessMemory: true, rpcInventoryRead: true, rawResponsesPersisted: false, targetAddressesPersisted: false, endpointIdentifiersPersisted: false, providerNamesPersisted: false, providerDomainsPersisted: false, keysPersisted: false, headersPersisted: false, rawInventoryLinesPersisted: false, economicsCalls: false, transactions: false, stakeCalls: false, messageSendCalls: false, protocolRetryCalls: false, sweepCalls: false, signing: false, forkCreated: false, mutation: false };
}

function nextStepFor(providers) {
  return providers.length > 0 && providers.every((provider) => provider.allRoutesComplete)
    ? "Obtain a second distinct declared/observed usable HyperEVM provider-family group and repeat a fresh fixed-pin full behavioral tuple plus anchor comparison; do not begin economics."
    : "Use the precise R10 failure substage/category to correct only the failing route assumption or RPC capability, then run one new bounded diagnostic with a second distinct declared/observed HyperEVM provider-family group; do not begin economics.";
}

function report(raw) {
  if (raw.topLevelFailure) return `# 🟠 WATCH — EtherFi BeHYPE HyperEVM diagnostic R10\n\n**Run:** \`${raw.runId}\`  \n**Classification:** \`${raw.classification}\`  \n**Gates:** \`0/0/false\`; \`fork=false\`\n\n${QUALIFICATION}\n\nThe bounded diagnostic stopped before pin binding at sanitized top-level stage \`${raw.topLevelFailure.stage}\` / \`${raw.topLevelFailure.category}\`. No route substage was reached, no route evidence is claimed, and the pin remains unavailable.\n\nThe fixed route substage enum remains: ${SUBSTAGES.join(", ")}. No raw responses, target addresses, endpoint identifiers, provider identities, URLs, domains, keys, or headers are retained.\n\nR9 and Optimism R8-r2 are immutable predecessors. No economics, stake, send, message, signing, fork, transaction, or mutation occurred.\n\n**nextReadOnlyStep:** ${raw.nextReadOnlyStep}\n`;
  const routeRows = raw.providers[0]?.routes.map((route) => `| ${route.routeLabel} | ${route.successfulSubstageCount} | ${route.successfulSubstages.join(", ") || "none"} | ${route.firstFailure?.failureSubstage || "none"} | ${route.firstFailure?.failureCategory || "none"} |`).join("\n") || "| none | 0 | none | none | none |";
  const pinQualification = raw.pin.qualification === "sole-family-provisional-reported-finalized-candidate" ? "a sole-family provisional reported-finalized candidate" : "a provisional numeric candidate";
  return `# 🟠 WATCH — EtherFi BeHYPE HyperEVM diagnostic R10\n\n**Run:** \`${raw.runId}\`  \n**Classification:** \`${raw.classification}\`  \n**Gates:** \`0/0/false\`; \`fork=false\`\n\n${QUALIFICATION}\n\nR10 used ${raw.safety.explicitCorrectedRetryAuthorized ? "one explicitly authorized corrected bounded retry after one pre-pin failed pass" : "one bounded official-plus-inventory pass"} and selected provisional numeric pin ${raw.pin.blockNumber} / \`${raw.pin.blockHash}\`. This is ${pinQualification}, not cross-family finality or hash consensus.\n\n| Route label | Successful substages | Successful evidence | First failure substage | Category |\n|---|---:|---|---|---|\n${routeRows}\n\nEach route was diagnosed independently through the fixed enum: ${SUBSTAGES.join(", ")}. Partial successful booleans, counts, and digests survive later failures. No raw responses, target addresses, endpoint identifiers, provider identities, URLs, domains, keys, or headers are retained.\n\nR9 and Optimism R8-r2 are immutable predecessors. No economics, stake, send, message, protocol retry, sweep, signing, fork, transaction, or mutation occurred.\n\n**nextReadOnlyStep:** ${raw.nextReadOnlyStep}\n`;
}

function publishPrePinBlocker(stage, category, context) {
  const generatedAt = new Date().toISOString(); const targets = context.targets || null;
  const r9Predecessor = { status: "IMMUTABLE-PREDECESSOR/HYPEREVM-R9", raw: hashFile(R9_RAW), manifest: hashFile(R9_MANIFEST) }; const r8Predecessor = { status: "IMMUTABLE-PREDECESSOR/OPTIMISM-R8-R2", raw: hashFile(R8_RAW), manifest: hashFile(R8_MANIFEST) };
  const nextReadOnlyStep = `Resolve only the sanitized pre-pin blocker ${stage}/${category}, then require fresh current-turn authorization before any further network pass; do not begin economics.`;
  const metrics = { authorizedCandidatesTested: context.authorizedCandidatesTested || 0, inventoryCandidatesParsed: context.inventoryCandidatesParsed || 0, chain999Candidates: context.chain999Candidates || 0, exactPinProviders: 0, exactPinFamilies: 0, diagnosedRouteCount: 0, completeRouteCount: 0 };
  const routeDefinitionComparison = targets ? targets.routes.map((route) => ({ routeLabel: route.label, routeIdentityDigest: route.identityDigest, step4IdentityComparison: route.step4IdentityComparison })) : [];
  const safety = safetySnapshot(); const gates = { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, hyperRoutesDiagnosticallyComplete: false, crossFamilyConsensus: false, reviewedTwoChainConsensus: false, economicsBlocked: true };
  const raw = canonical({ schemaVersion: 1, revision: REVISION, generatedAt, scanner: SCANNER, agentId: AGENT, role: "critical-research", classification: CLASSIFICATION, providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, failureSubstageEnum: SUBSTAGES, failureCategoryEnum: ["auth-or-origin-rejected", "rate-limited", "method-unsupported", "timeout", "contract-revert", "http-4xx", "http-5xx", "decode-or-schema-failure", "rpc-or-transport-error"], topLevelFailure: { stage, category, routeSubstageReached: false }, pin: null, routeDefinitionComparison, metrics, providers: [], families: [], immutablePredecessorR9: r9Predecessor, immutablePredecessorR8: r8Predecessor, retainedStep4Binding: { status: "OFFLINE-ROUTE-DEFINITION-COMPARISON", artifact: hashFile(STEP4), rawAddressesPersistedInR10: false }, gates, safety, nextReadOnlyStep });
  raw.runId = `etherfi-behype-hyperevm-diagnostic-r10-${digest(raw).slice(0, 20)}-${hashFile(SCANNER).sha256.slice(0, 12)}`;
  writeOwned(RAW, JSON.stringify(raw, null, 2) + "\n"); writeOwned(REPORT, report(raw));
  const routeDiagnostics = routeDefinitionComparison.map((route) => ({ routeLabel: route.routeLabel, successfulSubstages: [], firstFailure: null, routeComplete: false, topLevelBlocked: true }));
  const inbox = canonical({ findingId: NAME, revision: REVISION, runId: raw.runId, agentId: AGENT, role: "critical-research", status: CLASSIFICATION, classification: CLASSIFICATION, providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: null, topLevelFailure: raw.topLevelFailure, metrics, routeDiagnostics, immutablePredecessorR9: r9Predecessor, immutablePredecessorR8: r8Predecessor, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF, R9_RAW, R9_MANIFEST, R8_RAW, R8_MANIFEST, STEP4], nextAction: nextReadOnlyStep });
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  writeOwned(HANDOFF, `# EtherFi BeHYPE HyperEVM diagnostic R10 handoff\n\n- Run \`${raw.runId}\`; classification \`${CLASSIFICATION}\`; gates \`0/0/false\`, fork=false.\n- ${QUALIFICATION}\n- The corrected bounded pass stopped before pin binding at \`${stage}/${category}\`; no route substage was reached and no route evidence is claimed.\n- R9 and R8-r2 are immutable predecessors; no endpoint identifiers, raw responses, secrets, economics, transaction, stake, send, message, signing, fork, or mutation.\n- Next: ${nextReadOnlyStep}\n`);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, R9_RAW, R9_MANIFEST, R8_RAW, R8_MANIFEST, STEP4].map(hashFile); const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  const manifest = canonical({ schemaVersion: 1, revision: REVISION, runId: raw.runId, generatedAt, classification: CLASSIFICATION, algorithm: "sha256", providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: null, topLevelFailure: raw.topLevelFailure, metrics, failureSubstageEnum: SUBSTAGES, routeDiagnostics, immutablePredecessorR9: r9Predecessor, immutablePredecessorR8: r8Predecessor, retainedStep4Binding: raw.retainedStep4Binding, gates, safety, records, aggregateSha256 });
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n"); for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF]) assertNoLeak(fs.readFileSync(abs(rel), "utf8"));
  process.stdout.write(JSON.stringify({ runId: raw.runId, classification: CLASSIFICATION, topLevelFailure: raw.topLevelFailure, metrics, manifestAggregateSha256: aggregateSha256, gates, nextReadOnlyStep }) + "\n");
}

function offlineFinalize() {
  const raw = JSON.parse(fs.readFileSync(abs(RAW), "utf8"));
  raw.nextReadOnlyStep = nextStepFor(raw.providers);
  raw.safety.protocolRetryCalls = false; raw.safety.sweepCalls = false;
  raw.offlineFinalization = { networkCalls: false, endpointInventoryReads: false, evidenceValuesChanged: false, reason: "publication-leak-regex-and-next-step-correction", finalizedAt: new Date().toISOString() };
  delete raw.runId; raw.runId = `etherfi-behype-hyperevm-diagnostic-r10-${digest(raw).slice(0, 20)}-${hashFile(SCANNER).sha256.slice(0, 12)}`;
  writeOwned(RAW, JSON.stringify(canonical(raw), null, 2) + "\n"); writeOwned(REPORT, report(raw));
  const routeDiagnostics = raw.providers.flatMap((provider) => provider.routes.map((route) => ({ routeLabel: route.routeLabel, successfulSubstages: route.successfulSubstages, firstFailure: route.firstFailure, routeComplete: route.routeComplete })));
  const inbox = canonical({ findingId: NAME, revision: REVISION, runId: raw.runId, agentId: AGENT, role: "critical-research", status: CLASSIFICATION, classification: CLASSIFICATION, providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: raw.pin, metrics: raw.metrics, routeDiagnostics, immutablePredecessorR9: raw.immutablePredecessorR9, immutablePredecessorR8: raw.immutablePredecessorR8, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF, R9_RAW, R9_MANIFEST, R8_RAW, R8_MANIFEST, STEP4], nextAction: raw.nextReadOnlyStep });
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  const routeSummary = raw.providers[0]?.routes.map((route) => `${route.routeLabel}: success=[${route.successfulSubstages.join(",")}], failure=${route.firstFailure?.failureSubstage || "none"}/${route.firstFailure?.failureCategory || "none"}`).join("; ") || "none";
  writeOwned(HANDOFF, `# EtherFi BeHYPE HyperEVM diagnostic R10 handoff\n\n- Run \`${raw.runId}\`; classification \`${CLASSIFICATION}\`; gates \`0/0/false\`, fork=false.\n- ${QUALIFICATION}\n- Provisional pin ${raw.pin.blockNumber} / \`${raw.pin.blockHash}\`; qualification \`${raw.pin.qualification}\`; no cross-family finality/hash consensus.\n- Route diagnostics: ${routeSummary}.\n- Both routes were evaluated independently; partial booleans/counts/digests survive later failures.\n- One explicitly authorized corrected retry followed one pre-pin failed pass; no endpoint identifiers, raw responses, secrets, economics, transaction, stake, send, message, signing, fork, or mutation.\n- Offline finalization changed publication notation/hashes only; no network or inventory read and no evidence value changed.\n- Next: ${raw.nextReadOnlyStep}\n`);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, R9_RAW, R9_MANIFEST, R8_RAW, R8_MANIFEST, STEP4].map(hashFile); const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  const manifest = canonical({ schemaVersion: 1, revision: REVISION, runId: raw.runId, generatedAt: raw.generatedAt, classification: CLASSIFICATION, algorithm: "sha256", providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: raw.pin, metrics: raw.metrics, failureSubstageEnum: SUBSTAGES, routeDiagnostics, immutablePredecessorR9: raw.immutablePredecessorR9, immutablePredecessorR8: raw.immutablePredecessorR8, retainedStep4Binding: raw.retainedStep4Binding, gates: raw.gates, safety: raw.safety, offlineFinalization: raw.offlineFinalization, records, aggregateSha256 });
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n"); for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF]) assertNoLeak(fs.readFileSync(abs(rel), "utf8"));
  process.stdout.write(JSON.stringify({ runId: raw.runId, classification: CLASSIFICATION, pin: raw.pin, familyCounts: { exactPin: raw.metrics.exactPinFamilies }, routeDiagnostics, manifestAggregateSha256: aggregateSha256, offlineFinalization: raw.offlineFinalization, gates: raw.gates, nextReadOnlyStep: raw.nextReadOnlyStep }) + "\n");
}

async function main() {
  if (process.env.R10_OFFLINE_FINALIZE === "1") return offlineFinalize();
  let stage = "official-memory-input"; const context = { targets: null, authorizedCandidatesTested: 0, inventoryCandidatesParsed: 0, chain999Candidates: 0 };
  try {
  const officialUrl = process.env.HYPEREVM_OFFICIAL_RPC; if (!officialUrl) throw new Error("official-memory-input-missing"); stage = "target-load"; const targets = loadTargets(); context.targets = targets; stage = "inventory-read"; const inventoryText = fs.readFileSync(RPC_INVENTORY, "utf8"); const inventoryUrls = extractUrls(inventoryText).filter((url) => url !== officialUrl); context.inventoryCandidatesParsed = inventoryUrls.length;
  const candidates = [{ url: officialUrl, familyKey: "declared-official", familyClass: "declared-official-public" }, ...inventoryUrls.map((url) => ({ url, familyKey: `inventory:${familyKey(url)}`, familyClass: "observed-inventory" }))];
  context.authorizedCandidatesTested = candidates.length; stage = "candidate-probe"; const probed = await probe(candidates); const chainRows = probed.filter((row) => row.chainId === CHAIN_ID && row.status === "chain-head"); context.chain999Candidates = chainRows.length; stage = "pin-selection"; const pinNumber = choosePin(chainRows); if (!pinNumber) throw new Error("no-chain999-pin"); stage = "pin-bind"; const pin = await bindPin(chainRows, pinNumber); if (!pin) throw new Error("pin-unavailable"); stage = "route-diagnostics";
  const keys = [...new Set(pin.rows.map((row) => row.familyKey))].sort((a, b) => a === "declared-official" ? -1 : b === "declared-official" ? 1 : a.localeCompare(b)); const familyIds = new Map(keys.map((key, index) => [key, `hyperevm-family-${String(index + 1).padStart(2, "0")}`]));
  const providers = [];
  for (let index = 0; index < pin.rows.length; index++) {
    const row = pin.rows[index]; const routes = [];
    for (const route of targets.routes) routes.push(await diagnoseRoute(row.url, route, targets, pin));
    const provisionalFinality = row.finalizedSupported ? { mode: "sole-family-provisional-reported-finalized-candidate", finalizedSupported: true, finalizedHeightAtLeastPin: row.finalizedNumber >= pin.blockNumber } : { mode: "sole-family-provisional-retained-hash-candidate", finalizedSupported: false, finalizedHeightAtLeastPin: null, finalizedProbeCategory: row.finalizedCategory };
    providers.push({ providerId: `hyperevm-provider-${String(index + 1).padStart(2, "0")}`, familyId: familyIds.get(row.familyKey), familyClass: row.familyClass, provisionalFinality, routes, completeRouteCount: routes.filter((route) => route.routeComplete).length, allRoutesComplete: routes.every((route) => route.routeComplete), noIdentifiersPersisted: true });
  }
  const families = aggregateFamilies(providers); const r9Predecessor = { status: "IMMUTABLE-PREDECESSOR/HYPEREVM-R9", raw: hashFile(R9_RAW), manifest: hashFile(R9_MANIFEST) }; const r8Predecessor = { status: "IMMUTABLE-PREDECESSOR/OPTIMISM-R8-R2", raw: hashFile(R8_RAW), manifest: hashFile(R8_MANIFEST) };
  const nextReadOnlyStep = nextStepFor(providers);
  const raw = {
    schemaVersion: 1, revision: REVISION, generatedAt: new Date().toISOString(), scanner: SCANNER, agentId: AGENT, role: "critical-research", classification: CLASSIFICATION, providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false,
    routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false,
    failureSubstageEnum: SUBSTAGES, failureCategoryEnum: ["auth-or-origin-rejected", "rate-limited", "method-unsupported", "timeout", "contract-revert", "http-4xx", "http-5xx", "decode-or-schema-failure", "rpc-or-transport-error", "code-absent", "proxy-slots-partial", "proxy-ambiguous", "endpoint-mismatch", "peer-empty-or-mismatch", "selected-library-invalid", "semantic-value-mismatch", "one-or-more-applicable-configs-failed", "unexpected-success", "provider-wrapped-or-ambiguous-revert", "unexpected-revert-data", "receiver-or-token-code-absent", "same-number-hash-mismatch"],
    pin: { blockNumber: pin.blockNumber, blockHash: pin.blockHash, timestamp: pin.timestamp, qualification: pin.familyCount === 1 && pin.rows[0].finalizedSupported ? "sole-family-provisional-reported-finalized-candidate" : "provisional-numeric-candidate", crossFamilyFinalityConsensus: false, crossFamilyHashConsensus: false },
    routeDefinitionComparison: targets.routes.map((route) => ({ routeLabel: route.label, routeIdentityDigest: route.identityDigest, step4IdentityComparison: route.step4IdentityComparison })),
    metrics: { authorizedCandidatesTested: candidates.length, inventoryCandidatesParsed: inventoryUrls.length, chain999Candidates: chainRows.length, exactPinProviders: pin.rows.length, exactPinFamilies: keys.length, diagnosedRouteCount: providers.reduce((sum, provider) => sum + provider.routes.length, 0), completeRouteCount: providers.reduce((sum, provider) => sum + provider.completeRouteCount, 0) },
    providers, families,
    immutablePredecessorR9: r9Predecessor, immutablePredecessorR8: r8Predecessor, retainedStep4Binding: { status: "OFFLINE-ROUTE-DEFINITION-COMPARISON", artifact: targets.step4Hash, rawAddressesPersistedInR10: false },
    gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, hyperRoutesDiagnosticallyComplete: providers.length > 0 && providers.every((provider) => provider.allRoutesComplete), crossFamilyConsensus: false, reviewedTwoChainConsensus: false, economicsBlocked: true },
    safety: safetySnapshot(),
    nextReadOnlyStep,
  };
  const runId = `etherfi-behype-hyperevm-diagnostic-r10-${digest(raw).slice(0, 20)}-${hashFile(SCANNER).sha256.slice(0, 12)}`; raw.runId = runId;
  writeOwned(RAW, JSON.stringify(canonical(raw), null, 2) + "\n"); writeOwned(REPORT, report(raw));
  const inbox = canonical({ findingId: NAME, revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: CLASSIFICATION, classification: CLASSIFICATION, providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: raw.pin, metrics: raw.metrics, routeDiagnostics: providers.flatMap((provider) => provider.routes.map((route) => ({ routeLabel: route.routeLabel, successfulSubstages: route.successfulSubstages, firstFailure: route.firstFailure, routeComplete: route.routeComplete }))), immutablePredecessorR9: r9Predecessor, immutablePredecessorR8: r8Predecessor, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF, R9_RAW, R9_MANIFEST, R8_RAW, R8_MANIFEST, STEP4], nextAction: nextReadOnlyStep });
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  const routeSummary = providers[0]?.routes.map((route) => `${route.routeLabel}: success=[${route.successfulSubstages.join(",")}], failure=${route.firstFailure?.failureSubstage || "none"}/${route.firstFailure?.failureCategory || "none"}`).join("; ") || "none";
  const handoff = `# EtherFi BeHYPE HyperEVM diagnostic R10 handoff\n\n- Run \`${runId}\`; classification \`${CLASSIFICATION}\`; gates \`0/0/false\`, fork=false.\n- ${QUALIFICATION}\n- Provisional pin ${pin.blockNumber} / \`${pin.blockHash}\`; qualification \`${raw.pin.qualification}\`; no cross-family finality/hash consensus.\n- Route diagnostics: ${routeSummary}.\n- Both routes were evaluated independently; partial booleans/counts/digests survive later failures.\n- R9 and R8-r2 are immutable predecessors; Step4 route definitions were compared offline without persisting addresses.\n- One bounded pass; no repeated retries, endpoint identifiers, raw responses, secrets, economics, transaction, stake, send, message, signing, fork, or mutation.\n- Next: ${nextReadOnlyStep}\n`;
  writeOwned(HANDOFF, handoff);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, R9_RAW, R9_MANIFEST, R8_RAW, R8_MANIFEST, STEP4].map(hashFile); const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  const manifest = canonical({ schemaVersion: 1, revision: REVISION, runId, generatedAt: raw.generatedAt, classification: CLASSIFICATION, algorithm: "sha256", providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: raw.pin, metrics: raw.metrics, failureSubstageEnum: SUBSTAGES, routeDiagnostics: inbox.routeDiagnostics, immutablePredecessorR9: r9Predecessor, immutablePredecessorR8: r8Predecessor, retainedStep4Binding: raw.retainedStep4Binding, gates: raw.gates, safety: raw.safety, records, aggregateSha256 });
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF]) assertNoLeak(fs.readFileSync(abs(rel), "utf8"));
  process.stdout.write(JSON.stringify({ runId, classification: CLASSIFICATION, pin: raw.pin, familyCounts: { chain999: chainRows.length, exactPin: keys.length }, routeDiagnostics: inbox.routeDiagnostics, manifestAggregateSha256: aggregateSha256, gates: raw.gates, nextReadOnlyStep }) + "\n");
  } catch (error) {
    if (["official-memory-input", "target-load", "inventory-read", "candidate-probe", "pin-selection", "pin-bind"].includes(stage)) return publishPrePinBlocker(stage, errorCategory(error), context);
    throw error;
  }
}

main().catch((error) => { process.stderr.write(`HyperEVM R10 failed: ${errorCategory(error)}\n`); process.exitCode = 1; });
