#!/usr/bin/env node
"use strict";

// Offline by default. Only --capture may read the endpoint inventory, use
// fetch, or create the fixed immutable sanitized output.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { keccak256, solidityPackedKeccak256, toUtf8Bytes } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const OUTPUT = path.join(ROOT, "reports", "raw", "fast", "critical-rocketpool-v14-final-withdrawal-step2.json");
const FINDING_ID = "critical-rocketpool-v14-final-withdrawal-step2";
const SCHEMA_VERSION = "rocketpool-v14-final-withdrawal-step2/v1";
const SOURCE_ROOT = "targets/rocketpool-v1.4-fb7d9c4";
const SOURCE_COMMIT = "fb7d9c428dc3dddc3fbd3e634e3cb365655df89e";
const ROCKET_STORAGE = "0x1d8f8f00cfa6758d7be78336684788fb0ee0fa46";
const SOURCE_RUNTIME_ATTESTED = false;
const TRANSPORT_PROTOCOL = "https:";
const ZERO = "0x0000000000000000000000000000000000000000";
const ONE = 10n ** 18n;
const FULL_VALIDATOR_BALANCE = 32n * ONE;

const CONTRACTS = Object.freeze({
  rocketMegapoolDelegate: 1, rocketMegapoolFactory: 1, rocketMegapoolManager: 1,
  rocketMegapoolPenalties: 1, beaconStateVerifier: 1, rocketNetworkRevenues: 1,
  rocketNetworkBalances: 4, rocketNodeDeposit: 5, rocketNodeManager: 5,
  rocketDAONodeTrusted: 1, rocketDAOProtocolSettingsMegapool: 1,
  rocketDAOProtocolSettingsNode: 5, rocketDepositPool: 4, rocketTokenRETH: 1,
  rocketVault: 1, linkedListStorage: 1,
});
const CONTRACT_NAMES = Object.freeze(Object.keys(CONTRACTS));

const SIGNATURES = Object.freeze({
  registryGetAddress: "getAddress(bytes32)", storageGetString: "getString(bytes32)", version: "version()",
  nodeShare: "getCurrentNodeShare()", voterShare: "getCurrentVoterShare()", pdaoShare: "getCurrentProtocolDAOShare()",
  calculateSplit: "calculateSplit(uint64)", bondRequirement: "getBondRequirement(uint256)", reducedBond: "getReducedBond()",
  baseBondArray: "getBaseBondArray()", notifyThreshold: "getNotifyThreshold()", lateNotifyFine: "getLateNotifyFine()",
  userDistributeDelay: "getUserDistributeDelay()", userDistributeDelayShortfall: "getUserDistributeDelayWithShortfall()",
  penaltyThreshold: "getPenaltyThreshold()", validatorCount: "getValidatorCount()", nodeCount: "getNodeCount()",
  memberCount: "getMemberCount()", depositBalance: "getBalance()", depositNodeBalance: "getNodeBalance()",
  depositUserBalance: "getUserBalance()", depositExcessBalance: "getExcessBalance()", queueIndex: "getQueueIndex()",
  minipoolQueueLength: "getMinipoolQueueLength()", expressQueueLength: "getExpressQueueLength()",
  standardQueueLength: "getStandardQueueLength()", totalSupply: "totalSupply()", exchangeRate: "getExchangeRate()",
  totalCollateral: "getTotalCollateral()", collateralRate: "getCollateralRate()", totalEthBalance: "getTotalETHBalance()",
  totalRethSupply: "getTotalRETHSupply()",
});
const selector = (signature) => keccak256(toUtf8Bytes(signature)).slice(2, 10);
const SELECTORS = Object.freeze(Object.fromEntries(Object.entries(SIGNATURES).map(([key, value]) => [key, selector(value)])));

const CAPS = Object.freeze({
  ethCall: 68, getCode: 17, chainAndHeader: 3, totalLogicalCalls: 88,
  transportBatches: 6, elementsPerBatch: 16, retries: 0, ethCallGas: 1_000_000,
  resultBytes: 64 * 1024, aggregateBytes: 1024 * 1024, stringBytes: 128,
  arrayBytes: 512, codeBytes: 64 * 1024, inventoryCandidates: 1, timeoutMs: 10_000,
});
const PLAN = Object.freeze({ ethCall: 62, getCode: 17, chainAndHeader: 3, totalLogicalCalls: 82, transportBatches: 6 });
const ALLOWED_METHODS = Object.freeze(["eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_getCode"]);
const ALLOWED_SET = new Set(ALLOWED_METHODS);

class Stop extends Error { constructor(code) { super(code); this.code = code; } }
const stop = (code) => { throw new Stop(code); };
const lower = (value) => String(value).toLowerCase();
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  : typeof value === "bigint" ? value.toString() : value;
const canonicalJson = (value) => JSON.stringify(canonical(value));
function specDescriptor() { return canonical({ schemaVersion: SCHEMA_VERSION, sourceRoot: SOURCE_ROOT, sourceCommit: SOURCE_COMMIT, rocketStorage: ROCKET_STORAGE, transportProtocol: TRANSPORT_PROTOCOL, contracts: CONTRACTS, signatures: SIGNATURES, selectors: SELECTORS, caps: CAPS, plan: PLAN, allowedMethods: ALLOWED_METHODS }); }
const SPEC_SHA256 = sha256(Buffer.from(canonicalJson(specDescriptor())));

function registryKey(name) {
  if (!CONTRACT_NAMES.includes(name)) stop("REGISTRY_NAME_NOT_ALLOWED");
  return solidityPackedKeccak256(["string", "string"], ["contract.address", name]);
}
const protocolVersionKey = () => keccak256(toUtf8Bytes("protocol.version"));
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const calldata = (name, words = []) => `0x${SELECTORS[name]}${words.join("")}`;
const quantity = (value) => `0x${BigInt(value).toString(16)}`;

function strictHex(value, maxBytes = CAPS.resultBytes, code = "ABI_MALFORMED_OR_OVERSIZED") {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) stop(code);
  const bytes = (value.length - 2) / 2; if (bytes > maxBytes) stop(code);
  return { hex: lower(value), bytes };
}
function decodeWord(value) { const x = strictHex(value); if (x.bytes !== 32) stop("ABI_STATIC_NOT_32_BYTES"); return x.hex.slice(2); }
const decodeUint = (value) => BigInt(`0x${decodeWord(value)}`);
function decodeInt(value) { const x = decodeUint(value); return x >= (1n << 255n) ? x - (1n << 256n) : x; }
function decodeAddress(value) { const x = decodeWord(value); if (!/^0{24}[0-9a-f]{40}$/.test(x)) stop("ABI_ADDRESS_PADDING_INVALID"); return `0x${x.slice(24)}`; }
function decodeTuple4(value) { const x = strictHex(value); if (x.bytes !== 128) stop("ABI_TUPLE4_LENGTH_INVALID"); return [0, 1, 2, 3].map((i) => BigInt(`0x${x.hex.slice(2 + i * 64, 66 + i * 64)}`)); }
function decodeString(value) {
  const x = strictHex(value, CAPS.resultBytes); if (x.bytes < 64 || x.bytes % 32) stop("ABI_DYNAMIC_MALFORMED");
  const at = (i) => x.hex.slice(2 + i * 64, 66 + i * 64);
  if (BigInt(`0x${at(0)}`) !== 32n) stop("ABI_DYNAMIC_OFFSET_NONCANONICAL");
  const length = BigInt(`0x${at(1)}`); if (length > BigInt(CAPS.stringBytes)) stop("ABI_STRING_CAP_EXCEEDED");
  const padded = Number((length + 31n) / 32n * 32n), expected = 64 + padded; if (x.bytes !== expected) stop("ABI_DYNAMIC_LENGTH_MISMATCH");
  const body = x.hex.slice(130), used = Number(length) * 2; if (!/^0*$/.test(body.slice(used))) stop("ABI_DYNAMIC_PADDING_NONZERO");
  const out = Buffer.from(body.slice(0, used), "hex").toString("utf8"); if (Buffer.from(out, "utf8").toString("hex") !== body.slice(0, used)) stop("ABI_STRING_UTF8_INVALID"); return out;
}
function decodeUintArray(value) {
  const x = strictHex(value, CAPS.arrayBytes, "ABI_ARRAY_CAP_EXCEEDED"); if (x.bytes < 64 || x.bytes % 32) stop("ABI_DYNAMIC_MALFORMED");
  const at = (i) => x.hex.slice(2 + i * 64, 66 + i * 64); if (BigInt(`0x${at(0)}`) !== 32n) stop("ABI_DYNAMIC_OFFSET_NONCANONICAL");
  const length = BigInt(`0x${at(1)}`); if (length > BigInt((CAPS.arrayBytes - 64) / 32)) stop("ABI_ARRAY_CAP_EXCEEDED");
  if (x.bytes !== 64 + Number(length) * 32) stop("ABI_DYNAMIC_LENGTH_MISMATCH"); return Array.from({ length: Number(length) }, (_, i) => BigInt(`0x${at(i + 2)}`));
}
function summarizeCode(value) { const x = strictHex(value, CAPS.codeBytes, "CODE_MALFORMED_OR_OVERSIZED"); if (!x.bytes) stop("RUNTIME_MISSING"); return { bytes: x.bytes, keccak256: keccak256(x.hex) }; }
function canonicalQuantity(value) { if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(lower(value))) return null; try { return BigInt(value); } catch { return null; } }
function strictHeader(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) stop("FINALIZED_UNAVAILABLE_OR_MALFORMED");
  const number = canonicalQuantity(value.number), timestamp = canonicalQuantity(value.timestamp);
  if (number === null || timestamp === null || !/^0x[0-9a-fA-F]{64}$/.test(value.hash || "") || !/^0x[0-9a-fA-F]{64}$/.test(value.stateRoot || "")) stop("FINALIZED_UNAVAILABLE_OR_MALFORMED");
  return { number, hash: lower(value.hash), stateRoot: lower(value.stateRoot), timestamp };
}
function terminalHeaderConsistency(pin, raw) { try { const x = strictHeader(raw); return x.number.toString() === pin.number && x.hash === pin.hash && x.stateRoot === pin.stateRoot && x.timestamp.toString() === pin.timestamp; } catch { return false; } }

class Budget {
  constructor(caps = CAPS) { this.caps = caps; this.total = 0; this.batches = 0; this.bytes = 0; this.byMethod = {}; }
  reserveBatch(calls) {
    if (!Array.isArray(calls) || !calls.length || calls.length > this.caps.elementsPerBatch) stop("RPC_BATCH_CAP_EXCEEDED");
    if (++this.batches > this.caps.transportBatches) stop("RPC_TRANSPORT_BATCH_CAP_EXCEEDED");
    for (const call of calls) {
      if (!ALLOWED_SET.has(call.method)) stop("RPC_METHOD_NOT_ALLOWED"); this.total++; this.byMethod[call.method] = (this.byMethod[call.method] || 0) + 1;
      if (this.total > this.caps.totalLogicalCalls) stop("RPC_TOTAL_CAP_EXCEEDED");
      if ((this.byMethod.eth_call || 0) > this.caps.ethCall) stop("RPC_ETH_CALL_CAP_EXCEEDED");
      if ((this.byMethod.eth_getCode || 0) > this.caps.getCode) stop("RPC_CODE_CAP_EXCEEDED");
      if ((this.byMethod.eth_chainId || 0) + (this.byMethod.eth_getBlockByNumber || 0) > this.caps.chainAndHeader) stop("RPC_CHAIN_HEADER_CAP_EXCEEDED");
    }
  }
  addResult(value) { const bytes = typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value) ? (value.length - 2) / 2 : Buffer.byteLength(JSON.stringify(value)); if (bytes > this.caps.resultBytes) stop("RPC_RESULT_CAP_EXCEEDED"); this.bytes += bytes; if (this.bytes > this.caps.aggregateBytes) stop("RPC_AGGREGATE_CAP_EXCEEDED"); }
  summary() { return canonical({ totalLogicalCalls: this.total, transportBatches: this.batches, aggregateResultBytes: this.bytes, byMethod: this.byMethod }); }
}

async function fetchTransport(endpoint, body) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), CAPS.timeoutMs);
  try { const response = await fetch(endpoint.url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", accept: "application/json", ...endpoint.headers }, body, signal: controller.signal }); if (!response.ok) stop("RPC_TRANSPORT_UNAVAILABLE"); return Buffer.from(await response.arrayBuffer()); }
  catch (error) { if (error instanceof Stop) throw error; stop("RPC_TRANSPORT_UNAVAILABLE"); } finally { clearTimeout(timer); }
}
let rpcId = 1;
async function rpcBatch(endpoint, calls, budget, transport = fetchTransport) {
  budget.reserveBatch(calls); const requests = calls.map((x) => ({ jsonrpc: "2.0", id: rpcId++, method: x.method, params: x.params }));
  const response = await transport(endpoint, Buffer.from(JSON.stringify(requests))); if (!Buffer.isBuffer(response)) stop("RPC_RESPONSE_NOT_BUFFER");
  let rows; try { rows = JSON.parse(response.toString("utf8")); } catch { stop("RPC_RESPONSE_JSON_INVALID"); }
  if (!Array.isArray(rows) || rows.length !== requests.length) stop("RPC_RESPONSE_COUNT_MISMATCH"); const map = new Map(rows.map((x) => [x?.id, x]));
  return requests.map((request) => { const row = map.get(request.id); if (!row || row.jsonrpc !== "2.0" || row.error || row.result === null || !Object.hasOwn(row, "result")) stop("RPC_LOGICAL_CALL_FAILED"); budget.addResult(row.result); return row.result; });
}
function parseInventoryText(text, options = {}) {
  if (options.captureMode !== true) stop("INVENTORY_PARSE_REQUIRES_CAPTURE_MODE"); const rows = [], secrets = new Set();
  for (const match of String(text).matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>{}\[\]]+/gi)) { if (rows.length >= CAPS.inventoryCandidates) break; let url; try { url = new URL(match[0].replace(/[)>`,.;\]]+$/g, "")); } catch { continue; } if (url.protocol !== TRANSPORT_PROTOCOL) continue; rows.push({ url: url.href, headers: {} }); for (const x of [url.href, url.hostname, ...url.searchParams.values(), ...url.pathname.split("/")]) if (x.length >= 4) secrets.add(lower(x)); }
  if (!rows.length) stop("ETHEREUM_ENDPOINT_UNAVAILABLE"); return { rows, secrets };
}
const ethCall = (to, data, tag) => ({ method: "eth_call", params: [{ to, data, gas: quantity(CAPS.ethCallGas) }, tag] });
const getCode = (address, tag) => ({ method: "eth_getCode", params: [address, tag] });

function stateSpecs(addresses, tag, timestamp) {
  const rows = [
    [ROCKET_STORAGE, calldata("storageGetString", [protocolVersionKey().slice(2)]), decodeString, "protocolVersion"],
    [addresses.rocketNetworkRevenues, calldata("nodeShare"), decodeUint, "nodeShare"], [addresses.rocketNetworkRevenues, calldata("voterShare"), decodeUint, "voterShare"],
    [addresses.rocketNetworkRevenues, calldata("pdaoShare"), decodeUint, "pdaoShare"], [addresses.rocketNetworkRevenues, calldata("calculateSplit", [word(timestamp)]), decodeTuple4, "split"],
    [addresses.rocketNodeDeposit, calldata("bondRequirement", [word(1)]), decodeUint, "bondRequirement"], [addresses.rocketDAOProtocolSettingsNode, calldata("reducedBond"), decodeUint, "reducedBond"],
    [addresses.rocketDAOProtocolSettingsNode, calldata("baseBondArray"), decodeUintArray, "baseBondArray"],
    [addresses.rocketDAOProtocolSettingsMegapool, calldata("notifyThreshold"), decodeUint, "notifyThreshold"], [addresses.rocketDAOProtocolSettingsMegapool, calldata("lateNotifyFine"), decodeUint, "lateNotifyFine"],
    [addresses.rocketDAOProtocolSettingsMegapool, calldata("userDistributeDelay"), decodeUint, "userDistributeDelay"], [addresses.rocketDAOProtocolSettingsMegapool, calldata("userDistributeDelayShortfall"), decodeUint, "userDistributeDelayShortfall"],
    [addresses.rocketDAOProtocolSettingsMegapool, calldata("penaltyThreshold"), decodeUint, "penaltyThreshold"],
    [addresses.rocketMegapoolManager, calldata("validatorCount"), decodeUint, "validatorCount"], [addresses.rocketNodeManager, calldata("nodeCount"), decodeUint, "nodeCount"], [addresses.rocketDAONodeTrusted, calldata("memberCount"), decodeUint, "memberCount"],
    [addresses.rocketDepositPool, calldata("depositBalance"), decodeUint, "depositBalance"], [addresses.rocketDepositPool, calldata("depositNodeBalance"), decodeUint, "depositNodeBalance"],
    [addresses.rocketDepositPool, calldata("depositUserBalance"), decodeInt, "depositUserBalance"], [addresses.rocketDepositPool, calldata("depositExcessBalance"), decodeUint, "depositExcessBalance"],
    [addresses.rocketDepositPool, calldata("queueIndex"), decodeUint, "queueIndex"], [addresses.rocketDepositPool, calldata("minipoolQueueLength"), decodeUint, "minipoolQueueLength"],
    [addresses.rocketDepositPool, calldata("expressQueueLength"), decodeUint, "expressQueueLength"], [addresses.rocketDepositPool, calldata("standardQueueLength"), decodeUint, "standardQueueLength"],
    [addresses.rocketTokenRETH, calldata("totalSupply"), decodeUint, "rethTotalSupply"], [addresses.rocketTokenRETH, calldata("exchangeRate"), decodeUint, "rethExchangeRate"],
    [addresses.rocketTokenRETH, calldata("totalCollateral"), decodeUint, "rethTotalCollateral"], [addresses.rocketTokenRETH, calldata("collateralRate"), decodeUint, "rethCollateralRate"],
    [addresses.rocketNetworkBalances, calldata("totalEthBalance"), decodeUint, "networkTotalEthBalance"], [addresses.rocketNetworkBalances, calldata("totalRethSupply"), decodeUint, "networkTotalRethSupply"],
  ];
  return rows.map(([to, data, decode, label]) => ({ call: ethCall(to, data, tag), decode, label }));
}
function evaluateCapture(observed) {
  const reasons = ["EFFECTIVE_MEGAPOOL_DELEGATE_IDENTITY_UNAVAILABLE", "SOURCE_RUNTIME_UNATTESTED"];
  const push = (condition, code) => { if (!condition) reasons.push(code); }; const s = observed.state;
  push(observed.chainId === 1, "CHAIN_ID_MISMATCH"); push(observed.pin.terminalHeaderConsistent === true, "TERMINAL_HEADER_MISMATCH"); push(s.protocolVersion === "1.4", "PROTOCOL_VERSION_MISMATCH");
  const sum = s.nodeShare + s.voterShare + s.pdaoShare; push(sum <= ONE, "REVENUE_SHARE_SUM_OVERFLOW"); const rethShare = sum <= ONE ? ONE - sum : 0n;
  push(s.split.length === 4 && s.split[0] === s.nodeShare && s.split[1] === s.voterShare && s.split[2] === s.pdaoShare && s.split[3] === rethShare, "REVENUE_SPLIT_CROSSCHECK_MISMATCH");
  push(s.bondRequirement > 0n && s.bondRequirement <= FULL_VALIDATOR_BALANCE, "FIRST_VALIDATOR_BOND_OUT_OF_RANGE"); push(s.bondRequirement === 4n * ONE, "FIRST_VALIDATOR_BOND_NONDEFAULT");
  push(s.baseBondArray.length >= 1 && s.baseBondArray[0] === s.bondRequirement, "BASE_BOND_ARRAY_MISMATCH"); push(s.userDistributeDelay <= s.userDistributeDelayShortfall, "DISTRIBUTE_DELAY_ORDER_INVALID");
  push(s.validatorCount > 0n, "CUMULATIVE_VALIDATOR_RECORD_COUNT_ZERO");
  const borrowed = s.bondRequirement <= FULL_VALIDATOR_BALANCE ? FULL_VALIDATOR_BALANCE - s.bondRequirement : 0n;
  const voter = s.voterShare * borrowed / ONE, pdao = s.pdaoShare * borrowed / ONE, reth = rethShare * borrowed / ONE, node = FULL_VALIDATOR_BALANCE - voter - pdao - reth;
  const analysis = canonical({ impliedRethShare: rethShare, firstValidator: { principal: FULL_VALIDATOR_BALANCE, bond: s.bondRequirement, borrowed, nodeAllocation: node, nodeExcessOverBond: node >= s.bondRequirement ? node - s.bondRequirement : 0n, voterAllocation: voter, pdaoAllocation: pdao, rethAllocation: reth } });
  return canonical({ promotion: false, classification: "BLOCKED/AGGREGATE-DEPLOYMENT-EVIDENCE-ONLY", killReasons: [...new Set(reasons)].sort(), analysis });
}
function leakScan(value, secrets = []) { const text = JSON.stringify(value), low = lower(text), findings = []; if (/(?:https?|wss?):\/\//i.test(text)) findings.push("URL_MATERIAL"); if (/"(?:url|headers|authorization|apiKey|token|secret|rawResponse|rawRpc|responseBody|bytecode|operator|validatorAddress|challenger|caller)"\s*:/i.test(text)) findings.push("FORBIDDEN_FIELD"); if (/0x[0-9a-f]{66,}/i.test(text)) findings.push("RAW_HEX_OR_BYTECODE"); for (const x of secrets) if (x.length >= 4 && low.includes(lower(x))) findings.push("INVENTORY_MATERIAL"); return { passed: !findings.length, findings: [...new Set(findings)].sort() }; }
const sanitizedError = (error) => error instanceof Stop && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "INTERNAL_FAILURE";

async function executeCapture(options) {
  if (options?.captureMode !== true) stop("CAPTURE_MODE_REQUIRED"); const inventory = parseInventoryText(options.inventoryText, { captureMode: true }), endpoint = inventory.rows[0], budget = new Budget(), transport = options.transport || fetchTransport;
  const first = await rpcBatch(endpoint, [{ method: "eth_chainId", params: [] }, { method: "eth_getBlockByNumber", params: ["finalized", false] }], budget, transport);
  const chain = canonicalQuantity(first[0]); if (chain !== 1n) stop("CHAIN_ID_MISMATCH"); const header = strictHeader(first[1]), tag = quantity(header.number);
  const registryRaw = await rpcBatch(endpoint, CONTRACT_NAMES.map((name) => ethCall(ROCKET_STORAGE, calldata("registryGetAddress", [registryKey(name).slice(2)]), tag)), budget, transport);
  const addresses = {}; for (let i = 0; i < CONTRACT_NAMES.length; i++) { addresses[CONTRACT_NAMES[i]] = decodeAddress(registryRaw[i]); if (addresses[CONTRACT_NAMES[i]] === ZERO) stop("REGISTRY_ADDRESS_ZERO"); }
  const versionsRaw = await rpcBatch(endpoint, CONTRACT_NAMES.map((name) => ethCall(addresses[name], calldata("version"), tag)), budget, transport); const versions = {}; for (let i = 0; i < CONTRACT_NAMES.length; i++) { versions[CONTRACT_NAMES[i]] = Number(decodeUint(versionsRaw[i])); if (versions[CONTRACT_NAMES[i]] !== CONTRACTS[CONTRACT_NAMES[i]]) stop("CONTRACT_VERSION_MISMATCH"); }
  const codeTargets = [{ label: "rocketStorage", address: ROCKET_STORAGE }, ...CONTRACT_NAMES.map((name) => ({ label: name, address: addresses[name] }))];
  const codeA = await rpcBatch(endpoint, codeTargets.slice(0, 16).map((x) => getCode(x.address, tag)), budget, transport); const specs = stateSpecs(addresses, tag, header.timestamp);
  const batch5 = await rpcBatch(endpoint, [getCode(codeTargets[16].address, tag), ...specs.slice(0, 15).map((x) => x.call)], budget, transport);
  const batch6 = await rpcBatch(endpoint, [...specs.slice(15).map((x) => x.call), { method: "eth_getBlockByNumber", params: [tag, false] }], budget, transport);
  const runtimes = {}; for (let i = 0; i < 16; i++) runtimes[codeTargets[i].label] = summarizeCode(codeA[i]); runtimes[codeTargets[16].label] = summarizeCode(batch5[0]);
  const rawState = [...batch5.slice(1), ...batch6.slice(0, -1)], state = {}; for (let i = 0; i < specs.length; i++) state[specs[i].label] = specs[i].decode(rawState[i]);
  const pin = { number: header.number.toString(), hash: header.hash, stateRoot: header.stateRoot, timestamp: header.timestamp.toString(), terminalHeaderConsistent: terminalHeaderConsistency({ number: header.number.toString(), hash: header.hash, stateRoot: header.stateRoot, timestamp: header.timestamp.toString() }, batch6.at(-1)) };
  const observed = { chainId: 1, pin, state }, outcome = evaluateCapture(observed);
  const registry = {}; for (const name of CONTRACT_NAMES) registry[name] = { address: addresses[name], expectedVersion: CONTRACTS[name], observedVersion: versions[name], runtime: runtimes[name] };
  const output = canonical({ schemaVersion: SCHEMA_VERSION, findingId: FINDING_ID, source: { root: SOURCE_ROOT, commit: SOURCE_COMMIT }, rocketStorage: { address: ROCKET_STORAGE, runtime: runtimes.rocketStorage }, sourceRuntimeAttested: false, directRuntimeMatching: false, effectiveMegapoolDelegateIdentityEstablished: false, attestationReason: "No permitted aggregate getter establishes effective delegate identity across deployed EIP-1167 megapool proxies.", captureMode: "ETHEREUM_FINALIZED_NUMERIC_PIN_WITH_TERMINAL_HEADER_HASH_STATE_ROOT_TIMESTAMP_RECHECK", promotion: false, classification: outcome.classification, killReasons: outcome.killReasons, pin, registry, state: { protocolVersion: state.protocolVersion, economics: { nodeShare: state.nodeShare, voterShare: state.voterShare, protocolDAOShare: state.pdaoShare, calculateSplit: state.split, firstValidatorBond: state.bondRequirement, reducedBond: state.reducedBond, baseBondArray: state.baseBondArray }, exitSettings: { notifyThresholdEpochs: state.notifyThreshold, lateNotifyFineWei: state.lateNotifyFine, userDistributeDelayEpochs: state.userDistributeDelay, userDistributeDelayWithShortfallEpochs: state.userDistributeDelayShortfall, penaltyThreshold: state.penaltyThreshold }, aggregates: { megapoolValidatorRecords: { value: state.validatorCount, label: "cumulative validator records; not active validator count or TVL" }, nodeCount: state.nodeCount, trustedNodeCount: state.memberCount, depositPool: { balance: state.depositBalance, nodeBalance: state.depositNodeBalance, userBalanceSigned: state.depositUserBalance, excessBalance: state.depositExcessBalance, queueIndex: state.queueIndex, minipoolQueueLength: state.minipoolQueueLength, expressQueueLength: state.expressQueueLength, standardQueueLength: state.standardQueueLength }, reth: { totalSupply: state.rethTotalSupply, exchangeRate: state.rethExchangeRate, totalCollateral: state.rethTotalCollateral, collateralRate: state.rethCollateralRate }, network: { totalEthBalance: state.networkTotalEthBalance, totalRethSupply: state.networkTotalRethSupply } } }, analysis: outcome.analysis, policy: { allowedMethods: ALLOWED_METHODS, caps: CAPS, plan: PLAN, retries: 0, ethCallGas: CAPS.ethCallGas, signing: false, transactions: false, logs: false, storageReads: false, traces: false, accounts: false, arbitraryBalances: false, multicall: false }, rpc: budget.summary(), safety: { inventoryMemoryOnly: true, endpointMaterialPersisted: false, rawResponsesPersisted: false, rawBytecodePersisted: false, identifiersPersisted: false, networkOnlyInExplicitCaptureMode: true } });
  const leak = leakScan(output, inventory.secrets); if (!leak.passed) stop(`OUTPUT_LEAK_${leak.findings[0]}`); return output;
}
function staticCheck() { return { status: "PASS", mode: "offline-check-only", outputCreated: false, schemaVersion: SCHEMA_VERSION, sourceRoot: SOURCE_ROOT, sourceCommit: SOURCE_COMMIT, sourceRuntimeAttested: false, promotionPossible: false, transportProtocol: TRANSPORT_PROTOCOL, contractNames: CONTRACT_NAMES.length, selectors: Object.keys(SELECTORS).length, plannedCalls: PLAN.totalLogicalCalls, plannedBatches: PLAN.transportBatches, specSha256: SPEC_SHA256 }; }
async function main(argv = process.argv.slice(2)) { if (!argv.length || (argv.length === 1 && argv[0] === "--check-only")) { process.stdout.write(`${JSON.stringify(staticCheck())}\n`); return; } if (argv.length !== 1 || argv[0] !== "--capture") stop("CLI_ARGUMENTS_INVALID"); if (fs.existsSync(OUTPUT)) stop("IMMUTABLE_OUTPUT_ALREADY_EXISTS"); const output = await executeCapture({ captureMode: true, inventoryText: fs.readFileSync(INVENTORY, "utf8") }); fs.mkdirSync(path.dirname(OUTPUT), { recursive: true }); fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" }); process.stdout.write(`${JSON.stringify({ status: "PASS", promotion: false, rpcCalls: output.rpc.totalLogicalCalls, output: path.relative(ROOT, OUTPUT).replace(/\\/g, "/") })}\n`); }
if (require.main === module) main().catch((error) => { process.stderr.write(`${JSON.stringify({ status: "STOPPED", reason: sanitizedError(error) })}\n`); process.exitCode = 1; });

module.exports = { ROOT, OUTPUT, FINDING_ID, SCHEMA_VERSION, SOURCE_ROOT, SOURCE_COMMIT, ROCKET_STORAGE, SOURCE_RUNTIME_ATTESTED, TRANSPORT_PROTOCOL, ZERO, ONE, FULL_VALIDATOR_BALANCE, CONTRACTS, CONTRACT_NAMES, SIGNATURES, SELECTORS, CAPS, PLAN, ALLOWED_METHODS, SPEC_SHA256, Stop, Budget, canonical, canonicalJson, specDescriptor, selector, registryKey, protocolVersionKey, word, calldata, strictHex, decodeWord, decodeUint, decodeInt, decodeAddress, decodeTuple4, decodeString, decodeUintArray, summarizeCode, canonicalQuantity, strictHeader, terminalHeaderConsistency, parseInventoryText, rpcBatch, stateSpecs, evaluateCapture, leakScan, sanitizedError, executeCapture, staticCheck };
