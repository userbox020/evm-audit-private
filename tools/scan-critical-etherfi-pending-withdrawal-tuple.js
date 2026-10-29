#!/usr/bin/env node
"use strict";

// Authorized defensive Step 2: exact-pin, read-only pending-withdrawal tuple discovery.
// Never persist endpoint inventory values, origins, domains, headers, or credentials.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { Interface, getAddress, toQuantity } = require("ethers");
const { loadRpcUrls, getOrigin } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cash-v3");
const SCANNER = "tools/scan-critical-etherfi-pending-withdrawal-tuple.js";
const TEST = "tools/test-critical-etherfi-pending-withdrawal-tuple.js";
const RAW = "reports/raw/fast/critical-etherfi-pending-withdrawal-tuple.json";
const MANIFEST = "reports/raw/fast/critical-etherfi-pending-withdrawal-tuple-manifest.json";
const REPORT = "reports/critical-etherfi-pending-withdrawal-tuple.md";
const INBOX = "coordination/inbox/critical/2026-07-21-critical-etherfi-pending-withdrawal-tuple.json";
const HANDOFF = "coordination/handoffs/2026-07-21-critical-etherfi-pending-withdrawal-tuple-handoff.md";
const STEP1 = "reports/raw/fast/critical-etherfi-pinbound-build-binding.json";
const CAPABILITY = "reports/raw/fast/critical-etherfi-default-module-capability.json";
const DEPLOYMENTS = "targets/cash-v3/deployments/mainnet/10/deployments.json";
const REVISION = "pending-withdrawal-tuple-step2-r2-reviewer-corrected";
const AGENT = "critical-etherfi-step2-r2-20260721";
const PIN = { chainId: 10, blockNumber: 154534581, blockHash: "0x9e2d47b4f179b068df84fe73f11601cfa0af372d769902848222dc3a6e3c8b13" };
const SOURCE_COMMIT = "e05bda2be27a6a606f3f1b8ff0d0791032fd0ff8";
const MAX_PROVIDER_ENDPOINTS = 200;
const MAX_PROVIDER_CALLS = 1000;
const MAX_RPC_READS = 5000;
const PROVIDER_TIMEOUT_MS = 5_000;
const RPC_TIMEOUT_MS = 20_000;
const BUILD_TIMEOUT_MS = 600_000;
const INITIAL_LOG_CHUNK = 100_000;
const MIN_LOG_CHUNK = 1_000;
const RETAINED_LOG_START_BLOCK = 154529180;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const ADDR = {
  CashModule: "0x7Ca0b75E67E33c0014325B739A8d019C4FE445F0",
  EtherFiDataProvider: "0xDC515Cb479a64552c5A11a57109C314E40A1A778",
  EtherFiLiquidModule: "0x9008d1987A6aE5d3fFD9109967F85E631191E7A5",
  EtherFiLiquidModuleWithReferrer: "0x80D4B367659bb925A3790C76bC4da0B4f02d8613",
  FraxModule: "0x6742AF68E4f45715480E06B81775Cdb5Ba167088",
  StargateModule: "0xee77DEB6991f5d5CcAE5a327debA32d292E85c1c",
  EtherFiStakeModule: "0xD908117461378323C68257d522DC2De5D7890A1B",
  LiquidUSDLiquifierModule: "0x39161A44588ec2327a18D4707EA5216C721ba539",
};

const MODULE_SPECS = [
  { name: "EtherFiLiquidModule", address: ADDR.EtherFiLiquidModule, artifactDir: "EtherFiLiquidModule.sol", artifact: "EtherFiLiquidModule.json", getter: "getPendingBridge", requestEvent: "LiquidBridgeRequested", kind: "liquid", source: "src/modules/etherfi/EtherFiLiquidModule.sol" },
  { name: "EtherFiLiquidModuleWithReferrer", address: ADDR.EtherFiLiquidModuleWithReferrer, artifactDir: "EtherFiLiquidModuleWithReferrer.sol", artifact: "EtherFiLiquidModuleWithReferrer.json", getter: "getPendingBridge", requestEvent: "LiquidBridgeRequested", kind: "liquid", source: "src/modules/etherfi/EtherFiLiquidModuleWithReferrer.sol" },
  { name: "FraxModule", address: ADDR.FraxModule, artifactDir: "FraxModule.sol", artifact: "FraxModule.json", getter: "getPendingWithdrawal", requestEvent: "AsyncWithdrawalRequested", kind: "frax", source: "src/modules/frax/FraxModule.sol" },
  { name: "StargateModule", address: ADDR.StargateModule, artifactDir: "StargateModule.sol", artifact: "StargateModule.json", getter: "getPendingBridge", requestEvent: "RequestBridgeWithStargate", kind: "stargate", source: "src/modules/stargate/StargateModule.sol" },
];

const SOURCE_FILES = [
  "targets/cash-v3/src/modules/etherfi/EtherFiLiquidModule.sol",
  "targets/cash-v3/src/modules/etherfi/EtherFiLiquidModuleWithReferrer.sol",
  "targets/cash-v3/src/modules/etherfi/EtherFiStakeModule.sol",
  "targets/cash-v3/src/modules/etherfi/LiquidUSDLiquifierOP.sol",
  "targets/cash-v3/src/modules/frax/FraxModule.sol",
  "targets/cash-v3/src/modules/stargate/StargateModule.sol",
  "targets/cash-v3/src/modules/cash/CashModuleCore.sol",
  "targets/cash-v3/src/modules/cash/CashModuleSetters.sol",
  "targets/cash-v3/src/modules/cash/CashModuleStorageContract.sol",
  "targets/cash-v3/src/interfaces/ICashModule.sol",
  "targets/cash-v3/src/libraries/SpendingLimitLib.sol",
];

function abs(rel) { return path.join(ROOT, rel); }
function sha(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function hashFile(rel) { const data = fs.readFileSync(abs(rel)); return { path: rel, bytes: data.length, sha256: sha(data) }; }
function canonical(v) { if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`; if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`; return JSON.stringify(v); }
function rawLogSetDigest(logs) { return sha(logs.map((x) => canonical({ address: String(x.address).toLowerCase(), blockNumber: String(x.blockNumber).toLowerCase(), blockHash: String(x.blockHash).toLowerCase(), transactionHash: String(x.transactionHash).toLowerCase(), logIndex: String(x.logIndex).toLowerCase(), topics: (x.topics || []).map((t) => String(t).toLowerCase()), data: String(x.data).toLowerCase() })).sort().join("\n")); }
function safeMessage(v) { const s = String(v == null ? "" : v).toLowerCase(); if (s.includes("lower height") || s.includes("historical") || s.includes("archive")) return "historical-data-unavailable"; if (s.includes("timeout") || s.includes("aborted")) return "timeout"; if (s.includes("fetch failed") || s.includes("network")) return "transport-failure"; if (s.includes("too many") || s.includes("range") || s.includes("limit")) return "query-range-rejected"; return "rpc-or-tool-failure"; }
function strip0x(v) { return String(v || "").replace(/^0x/i, "").toLowerCase(); }
function slotAddress(word) { const hex = strip0x(word); if (hex.length !== 64 || /^0+$/.test(hex)) return null; try { return getAddress(`0x${hex.slice(-40)}`); } catch { return null; } }
function zeroStorageWord(word) { return /^0x0{64}$/i.test(String(word || "")); }
function runtimePresent(code) { const hex = strip0x(code); return hex.length > 0 && !/^0+$/.test(hex); }
function asAddress(v) { try { return getAddress(String(v)); } catch { return null; } }
function sameAddress(a, b) { return Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase()); }
function toNumber(v) { return Number(typeof v === "bigint" ? v : BigInt(v)); }
function toStringValue(v) { return typeof v === "bigint" ? v.toString() : String(v); }
function writeOwned(rel, content) { if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused: ${rel}`); fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), content, "utf8"); }
function walkFiles(dir, predicate, out = []) { if (!fs.existsSync(dir)) return out; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walkFiles(full, predicate, out); else if (predicate(full)) out.push(full); } return out; }

async function rpcFetch(url, origin, method, params, timeoutMs) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { code: response.status });
  const body = await response.json(); if (body.error) throw body.error; return body.result;
}

function runBuild() {
  const tempRoot = path.join(os.tmpdir(), "opencode", "etherfi-pending-withdrawal-step2-build"); const outDir = path.join(tempRoot, "out"); const cacheDir = path.join(tempRoot, "cache"); const infoDir = path.join(tempRoot, "build-info");
  fs.rmSync(tempRoot, { recursive: true, force: true }); fs.mkdirSync(tempRoot, { recursive: true });
  const run = spawnSync("forge", ["build", "--root", TARGET, "--out", outDir, "--cache-path", cacheDir, "--build-info", "--build-info-path", infoDir, "--no-cache", "--offline"], { cwd: ROOT, encoding: "utf8", timeout: BUILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  const output = `${run.stdout || ""}\n${run.stderr || ""}`; const infoFiles = walkFiles(infoDir, (x) => x.endsWith(".json")); const buildInfo = infoFiles.length === 1 ? JSON.parse(fs.readFileSync(infoFiles[0], "utf8")) : null;
  const specs = [
    ...MODULE_SPECS,
    { name: "EtherFiStakeModule", artifactDir: "EtherFiStakeModule.sol", artifact: "EtherFiStakeModule.json" },
    { name: "LiquidUSDLiquifierModule", artifactDir: "LiquidUSDLiquifierOP.sol", artifact: "LiquidUSDLiquifierOPModule.json" },
    { name: "CashModuleCore", artifactDir: "CashModuleCore.sol", artifact: "CashModuleCore.json" },
    { name: "EtherFiDataProvider", artifactDir: "EtherFiDataProvider.sol", artifact: "EtherFiDataProvider.json" },
  ];
  const artifacts = {}; for (const spec of specs) { const file = path.join(outDir, spec.artifactDir, spec.artifact); artifacts[spec.name] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null; }
  const abiEvidence = Object.fromEntries(Object.entries(artifacts).map(([name, artifact]) => [name, artifact ? { available: true, abiSha256: sha(canonical(artifact.abi)), functionSignatures: artifact.abi.filter((x) => x.type === "function").map((x) => `${x.name}(${(x.inputs || []).map((i) => i.type).join(",")})`).sort(), eventSignatures: artifact.abi.filter((x) => x.type === "event").map((x) => `${x.name}(${(x.inputs || []).map((i) => i.type).join(",")})`).sort() } : { available: false }]));
  return { tempRoot, artifacts, buildInfo, result: { attempted: true, exitStatus: run.status, timedOut: run.error?.code === "ETIMEDOUT", outputBytes: Buffer.byteLength(output), outputSha256: sha(output), compiler: buildInfo ? { version: buildInfo.solcVersion, longVersion: buildInfo.solcLongVersion } : null, standardJsonInputSha256: buildInfo ? sha(canonical(buildInfo.input)) : null, sourceCount: Object.keys(buildInfo?.input?.sources || {}).length, abiEvidence } };
}

function collectImmutableNames(buildInfo) {
  const out = new Map(); function walk(node, sourcePath) { if (!node || typeof node !== "object") return; if (node.nodeType === "VariableDeclaration" && node.mutability === "immutable") out.set(String(node.id), { declarationName: node.name, sourcePath }); for (const value of Object.values(node)) { if (Array.isArray(value)) value.forEach((x) => walk(x, sourcePath)); else if (value && typeof value === "object") walk(value, sourcePath); } }
  for (const [sourcePath, item] of Object.entries(buildInfo.output?.sources || {})) walk(item.ast, sourcePath); return out;
}
function addressWord(address) { return Buffer.from(`${"0".repeat(24)}${strip0x(address)}`, "hex"); }
function reconstructRuntime(artifact, deployedCode, immutableNames, bindings) {
  const template = Buffer.from(strip0x(artifact?.deployedBytecode?.object), "hex"); const deployed = Buffer.from(strip0x(deployedCode), "hex"); const refs = artifact?.deployedBytecode?.immutableReferences || {}; const rows = []; let allIndependentlyBound = true; let allActualMatch = true;
  for (const [astId, positionsRaw] of Object.entries(refs)) {
    const declaration = immutableNames.get(String(astId)) || { declarationName: null, sourcePath: null }; const binding = bindings[declaration.declarationName] || null; const positions = positionsRaw.map((x) => ({ start: Number(x.start), length: Number(x.length) })); const independentlyBound = Boolean(binding?.value && binding?.source === "getter" && binding?.getterMatched === true); const word = binding?.value ? addressWord(binding.value) : null; const actualMatch = Boolean(word && positions.every((x) => x.length === 32 && deployed.subarray(x.start, x.start + x.length).equals(word)));
    if (!independentlyBound) allIndependentlyBound = false; if (!actualMatch) allActualMatch = false; if (word) for (const position of positions) word.copy(template, position.start);
    rows.push({ astId, declarationName: declaration.declarationName, sourcePath: declaration.sourcePath, positions, expectedValue: binding?.value || null, expectedValueSource: binding?.source || null, getterEvidence: binding?.evidence || null, getterObservedValue: binding?.observed || null, independentlyBound, actualMatch });
  }
  return { templateRuntimeBytes: Buffer.from(strip0x(artifact?.deployedBytecode?.object), "hex").length, deployedRuntimeBytes: deployed.length, templateExactWithoutImmutableReconstruction: strip0x(artifact?.deployedBytecode?.object) === strip0x(deployedCode), immutableAstRowCount: rows.length, immutableRows: rows, allImmutableRowsIndependentlyBound: allIndependentlyBound, allImmutableActualValuesMatch: allActualMatch, exactReconstructedRuntimeEqual: allIndependentlyBound && allActualMatch && template.equals(deployed), reconstructedRuntimeSha256: sha(template), deployedRuntimeSha256: sha(deployed) };
}

function loadR1Predecessor() {
  const rawText = fs.readFileSync(abs(RAW), "utf8"); const raw = JSON.parse(rawText);
  if (raw.revision === REVISION && raw.r1Predecessor) return raw.r1Predecessor;
  if (raw.revision !== "pending-withdrawal-tuple-step2-r1") throw new Error("Step 2 r1 predecessor unavailable");
  const manifestText = fs.readFileSync(abs(MANIFEST), "utf8"); const manifest = JSON.parse(manifestText); const reportText = fs.readFileSync(abs(REPORT), "utf8"); const inboxText = fs.readFileSync(abs(INBOX), "utf8"); const handoffText = fs.readFileSync(abs(HANDOFF), "utf8");
  return { revision: raw.revision, runId: raw.runId, classification: raw.classification, generatedAt: raw.generatedAt, captureProvenance: raw.captureProvenance, preservationMode: "summary-provenance-and-package-hashes-only", originalFilesManifestBoundInR2: false, disposition: "r1 is superseded in place; r2 preserves its summary/provenance and package hashes, not manifest-bound original files.", packageHashes: { rawSha256: sha(rawText), manifestSha256: sha(manifestText), reportSha256: sha(reportText), inboxSha256: sha(inboxText), handoffSha256: sha(handoffText), manifestAggregateSha256: manifest.aggregateSha256 } };
}

async function selectProvider(probeSpecs) {
  let inventory = []; let inventoryLoadSucceeded = false; try { inventory = loadRpcUrls(); inventoryLoadSucceeded = true; } catch (_) { /* fail closed */ }
  const candidates = inventory.slice(0, MAX_PROVIDER_ENDPOINTS); let endpointsTried = 0; let calls = 0; const rejectionCounts = {}; const retainedLogGroups = new Map();
  const reject = (kind) => { rejectionCounts[kind] = (rejectionCounts[kind] || 0) + 1; };
  const invoke = async (url, origin, method, params) => { if (calls >= MAX_PROVIDER_CALLS) throw Object.assign(new Error("provider-call-budget"), { selectionKind: "call-budget" }); calls++; return rpcFetch(url, origin, method, params, PROVIDER_TIMEOUT_MS); };
  for (let i = 0; i < candidates.length && calls < MAX_PROVIDER_CALLS; i++) {
    endpointsTried++; const url = candidates[i]; const origin = getOrigin(url);
    try {
      const chain = await invoke(url, origin, "eth_chainId", []); if (Number(BigInt(chain)) !== PIN.chainId) { reject("chain-mismatch"); continue; }
      const block = await invoke(url, origin, "eth_getBlockByNumber", [toQuantity(PIN.blockNumber), false]); if (block?.hash?.toLowerCase() !== PIN.blockHash.toLowerCase()) { reject("pin-unavailable-or-mismatch"); continue; }
      const code = await invoke(url, origin, "eth_getCode", [ADDR.CashModule, toQuantity(PIN.blockNumber)]); if (!runtimePresent(code)) { reject("historical-code-unavailable"); continue; }
      const impl = await invoke(url, origin, "eth_getStorageAt", [ADDR.CashModule, IMPL_SLOT, toQuantity(PIN.blockNumber)]); if (!slotAddress(impl)) { reject("historical-storage-unavailable"); continue; }
      const retainedLogs = []; const retainedCounts = {};
      for (const spec of probeSpecs) { const rows = await invoke(url, origin, "eth_getLogs", [{ address: spec.address, fromBlock: toQuantity(RETAINED_LOG_START_BLOCK), toBlock: toQuantity(PIN.blockNumber), topics: [spec.topicHash] }]); retainedCounts[spec.name] = rows.length; retainedLogs.push(...rows); }
      const retainedLogDigest = rawLogSetDigest(retainedLogs); const group = retainedLogGroups.get(retainedLogDigest) || []; group.push({ url, origin, selectedOrdinal: i, retainedCounts }); retainedLogGroups.set(retainedLogDigest, group);
      if (group.length >= 3) { const chosen = group[0]; return { ...chosen, inventoryCount: inventory.length, inventoryLoadSucceeded, endpointsTried, calls, selectedFromInventory: true, rejectionCounts, retainedLogDigest, retainedLogConsensusCount: group.length, retainedLogDigestVariantsObserved: retainedLogGroups.size, acceptance: { chainId: true, exactBlockHash: true, historicalCode: true, historicalImplementationSlot: true, perModuleExactEventRetainedLogs: true, retainedLogConsensus: true }, historicalLogProbeBlock: RETAINED_LOG_START_BLOCK }; }
    } catch (e) { if (e?.selectionKind === "call-budget") reject("call-budget"); else if (e?.name === "TimeoutError" || e?.name === "AbortError") reject("timeout"); else if (Number.isInteger(e?.code)) reject(`status-${e.code}`); else reject("transport-or-rpc-failure"); }
  }
  const best = [...retainedLogGroups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (best && best[1].length >= 2) { const [retainedLogDigest, group] = best; const chosen = group[0]; return { ...chosen, inventoryCount: inventory.length, inventoryLoadSucceeded, endpointsTried, calls, selectedFromInventory: true, rejectionCounts, retainedLogDigest, retainedLogConsensusCount: group.length, retainedLogDigestVariantsObserved: retainedLogGroups.size, acceptance: { chainId: true, exactBlockHash: true, historicalCode: true, historicalImplementationSlot: true, perModuleExactEventRetainedLogs: true, retainedLogConsensus: true }, historicalLogProbeBlock: RETAINED_LOG_START_BLOCK }; }
  return { url: null, origin: null, inventoryCount: inventory.length, inventoryLoadSucceeded, endpointsTried, calls, selectedOrdinal: null, selectedFromInventory: false, rejectionCounts, retainedLogDigest: null, retainedLogConsensusCount: best?.[1]?.length || 0, retainedLogDigestVariantsObserved: retainedLogGroups.size, acceptance: { chainId: false, exactBlockHash: false, historicalCode: false, historicalImplementationSlot: false, perModuleExactEventRetainedLogs: false, retainedLogConsensus: false }, historicalLogProbeBlock: RETAINED_LOG_START_BLOCK };
}

class Reader {
  constructor(selection) { this.selection = selection; this.count = 0; this.transcript = []; }
  async read(method, params, label, coverage = null) {
    if (this.count >= MAX_RPC_READS) throw new Error(`RPC read cap before ${label}`); const number = ++this.count;
    try { const result = await rpcFetch(this.selection.url, this.selection.origin, method, params, RPC_TIMEOUT_MS); this.transcript.push({ number, method, label, ok: true, coverage }); return { ok: true, result }; }
    catch (e) { this.transcript.push({ number, method, label, ok: false, coverage, code: Number.isInteger(e?.code) ? e.code : null, error: safeMessage(e?.message || e) }); return { ok: false, error: safeMessage(e?.message || e) }; }
  }
  async call(address, iface, fn, args, blockTag, label) {
    const response = await this.read("eth_call", [{ to: address, data: iface.encodeFunctionData(fn, args) }, blockTag], label); if (!response.ok) return { ok: false, error: response.error };
    try { return { ok: true, decoded: iface.decodeFunctionResult(fn, response.result) }; } catch { return { ok: false, error: "decode-failure" }; }
  }
}

async function scanRequestLogs(reader, startBlock, interfaces) {
  const logs = []; const ranges = []; const moduleCoverage = {}; let complete = true;
  for (const spec of MODULE_SPECS) {
    let cursor = startBlock; let chunk = INITIAL_LOG_CHUNK; let moduleComplete = true; const moduleRanges = [];
    const topicHash = interfaces[spec.name].getEvent(spec.requestEvent).topicHash;
    while (cursor <= PIN.blockNumber) {
      const end = Math.min(PIN.blockNumber, cursor + chunk - 1); const coverage = { module: spec.name, address: getAddress(spec.address), topicHash, fromBlock: cursor, toBlock: end };
      const r = await reader.read("eth_getLogs", [{ address: spec.address, fromBlock: toQuantity(cursor), toBlock: toQuantity(end), topics: [topicHash] }], `requests.${spec.name}.${cursor}-${end}`, coverage);
      if (!r.ok) { if (chunk > MIN_LOG_CHUNK) { chunk = Math.max(MIN_LOG_CHUNK, Math.floor(chunk / 2)); continue; } moduleComplete = false; complete = false; const failed = { ...coverage, ok: false }; ranges.push(failed); moduleRanges.push(failed); break; }
      const covered = { ...coverage, ok: true, logCount: r.result.length }; ranges.push(covered); moduleRanges.push(covered); logs.push(...r.result); cursor = end + 1;
    }
    moduleCoverage[spec.name] = { complete: moduleComplete, rangeCount: moduleRanges.length, startsAtRetainedWindow: moduleRanges.length > 0 && moduleRanges[0].fromBlock === startBlock, endsAtPin: moduleRanges.length > 0 && moduleRanges[moduleRanges.length - 1].toBlock === PIN.blockNumber, logCount: moduleRanges.reduce((sum, x) => sum + Number(x.logCount || 0), 0), finalChunkSize: chunk };
  }
  const parsed = [];
  for (const log of logs) {
    const spec = MODULE_SPECS.find((x) => x.address.toLowerCase() === String(log.address).toLowerCase()); if (!spec) continue;
    try {
      const event = interfaces[spec.name].parseLog({ topics: log.topics, data: log.data }); const args = event.args; const base = { module: spec.name, moduleAddress: getAddress(spec.address), event: event.name, safe: asAddress(args.safe), blockNumber: Number(BigInt(log.blockNumber)), blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: Number(BigInt(log.logIndex)) };
      if (spec.kind === "liquid") parsed.push({ ...base, tuple: { asset: asAddress(args.liquidAsset), amount: toStringValue(args.amount), destEid: toNumber(args.destEid), destRecipient: asAddress(args.destRecipient) } });
      else if (spec.kind === "frax") parsed.push({ ...base, tuple: { asset: null, amount: toStringValue(args.amountToWithdraw), destEid: toNumber(args.dstEid), destRecipient: asAddress(args.to) } });
      else parsed.push({ ...base, tuple: { asset: asAddress(args.asset), amount: toStringValue(args.amount), destEid: toNumber(args.destEid), destRecipient: asAddress(args.destRecipient), maxSlippageInBps: toStringValue(args.maxSlippageInBps) } });
    } catch (_) { /* topic was from another scoped ABI only if provider malformed; omit and count below */ }
  }
  parsed.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex || a.module.localeCompare(b.module));
  return { complete, moduleCoverage, ranges, rawLogCount: logs.length, rawLogSetDigest: rawLogSetDigest(logs), parsedLogs: parsed, parsedLogCount: parsed.length, parseComplete: parsed.length === logs.length };
}

function decodeModulePending(spec, decoded, fraxAsset) {
  const row = decoded[0];
  if (spec.kind === "liquid") return { key: { safe: null }, destEid: toNumber(row.destEid ?? row[0]), asset: asAddress(row.asset ?? row[1]), amount: toStringValue(row.amount ?? row[2]), destRecipient: asAddress(row.destRecipient ?? row[3]), maxSlippageInBps: null };
  if (spec.kind === "frax") return { key: { safe: null }, destEid: 30_101, asset: fraxAsset, amount: toStringValue(row.amount ?? row[0]), destRecipient: asAddress(row.recipient ?? row[1]), maxSlippageInBps: null };
  return { key: { safe: null }, destEid: toNumber(row.destEid ?? row[0]), asset: asAddress(row.asset ?? row[1]), amount: toStringValue(row.amount ?? row[2]), destRecipient: asAddress(row.destRecipient ?? row[3]), maxSlippageInBps: toStringValue(row.maxSlippageInBps ?? row[4]) };
}

function decodeCashData(decoded) {
  const data = decoded[0]; const withdrawal = data.pendingWithdrawalRequest ?? data[1];
  return { key: { safe: null }, tokens: Array.from(withdrawal.tokens ?? withdrawal[0]).map(asAddress), amounts: Array.from(withdrawal.amounts ?? withdrawal[1]).map(toStringValue), recipient: asAddress(withdrawal.recipient ?? withdrawal[2]), finalizeTime: toStringValue(withdrawal.finalizeTime ?? withdrawal[3]) };
}

function modulePendingPresent(row) { return Boolean(row && row.destRecipient && row.destRecipient !== getAddress("0x0000000000000000000000000000000000000000") && row.asset && row.asset !== getAddress("0x0000000000000000000000000000000000000000") && BigInt(row.amount) > 0n); }
function eventMatchesState(event, state) { if (!event || !state) return false; const common = sameAddress(event.tuple.asset, state.asset) && event.tuple.amount === state.amount && event.tuple.destEid === state.destEid && sameAddress(event.tuple.destRecipient, state.destRecipient); return common && (state.maxSlippageInBps == null || event.tuple.maxSlippageInBps === state.maxSlippageInBps); }
function compareTuples(moduleAddress, moduleState, cashState) {
  const checks = { cashHasOneToken: cashState.tokens.length === 1 && cashState.amounts.length === 1, recipientIsModule: sameAddress(cashState.recipient, moduleAddress), assetEqual: cashState.tokens.length === 1 && sameAddress(cashState.tokens[0], moduleState.asset), amountEqual: cashState.amounts.length === 1 && cashState.amounts[0] === moduleState.amount };
  return { checks, equal: Object.values(checks).every(Boolean), keying: { moduleRecordKey: "safe", cashPendingWithdrawalKey: "safe", requestIdentifier: null, requestIdentifierCaveat: "These four scoped module records have no separate request ID; matching uses safe plus module-specific asset/amount/destination fields and Cash recipient." } };
}

async function main() {
  const capturedAt = new Date().toISOString(); const scannerSha256 = hashFile(SCANNER).sha256;
  const r1Predecessor = loadR1Predecessor();
  const step1 = JSON.parse(fs.readFileSync(abs(STEP1), "utf8")); const capability = JSON.parse(fs.readFileSync(abs(CAPABILITY), "utf8"));
  if (step1.revision !== "pinbound-build-binding-step1-r3-reviewer-corrected" || step1.classification !== "exact" || step1.pin.blockNumber !== PIN.blockNumber || step1.pin.blockHash.toLowerCase() !== PIN.blockHash.toLowerCase()) throw new Error("Step 1 exact predecessor mismatch");
  const build = runBuild(); if (build.result.exitStatus !== 0 || !build.buildInfo) throw new Error("offline ABI build failed");
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: TARGET, encoding: "utf8", timeout: 15_000 }); const sourceCommit = git.status === 0 ? git.stdout.trim() : null;
  const interfaces = {}; for (const [name, artifact] of Object.entries(build.artifacts)) if (artifact) interfaces[name] = new Interface(artifact.abi);
  const stargateSourceText = fs.readFileSync(path.join(TARGET, "src", "modules", "stargate", "StargateModule.sol"), "utf8"); const cashStorageSourceText = fs.readFileSync(path.join(TARGET, "src", "modules", "cash", "CashModuleStorageContract.sol"), "utf8");
  const cashStep1Row = step1.componentResults.find((x) => x.name === "CashModuleCore");
  const guardSemantics = {
    stargateExecuteBridge: { sourcePath: "targets/cash-v3/src/modules/stargate/StargateModule.sol", sourceSha256: hashFile("targets/cash-v3/src/modules/stargate/StargateModule.sol").sha256, equalityGuardPresent: /withdrawalRequest\.recipient\s*!=\s*address\(this\)[\s\S]*withdrawalRequest\.tokens\.length\s*!=\s*1[\s\S]*withdrawalRequest\.tokens\[0\]\s*!=\s*withdrawal\.asset[\s\S]*withdrawalRequest\.amounts\[0\]\s*!=\s*withdrawal\.amount/.test(stargateSourceText), cashProcessCalledAfterEqualityGuard: stargateSourceText.indexOf("cashModule.processWithdrawal(safe)") > stargateSourceText.indexOf("withdrawalRequest.recipient != address(this)"), sourceReferences: ["StargateModule.sol:236-250"] },
    cashProcessWithdrawal: { sourcePath: "targets/cash-v3/src/modules/cash/CashModuleStorageContract.sol", sourceSha256: hashFile("targets/cash-v3/src/modules/cash/CashModuleStorageContract.sol").sha256, finalizeTimeGuardPresent: /pendingWithdrawalRequest\.finalizeTime\s*>\s*block\.timestamp\)\s*revert CannotWithdrawYet/.test(cashStorageSourceText), guardBeforeTransfers: cashStorageSourceText.indexOf("execTransactionFromModule", cashStorageSourceText.indexOf("pendingWithdrawalRequest.finalizeTime > block.timestamp")) > cashStorageSourceText.indexOf("pendingWithdrawalRequest.finalizeTime > block.timestamp"), step1CashRuntimeExact: Boolean(cashStep1Row?.proxyComparison?.exactRuntimeEqual && cashStep1Row?.implementationComparison?.exactReconstructedEqual), step1RunId: step1.runId, sourceReferences: ["CashModuleStorageContract.sol:298-330"] },
    buildLinkage: { sourceCommit, expectedSourceCommit: SOURCE_COMMIT, sourceCommitMatch: sourceCommit === SOURCE_COMMIT, standardJsonInputSha256: build.result.standardJsonInputSha256, step1StandardJsonInputSha256: step1.build.standardJsonInputSha256, standardJsonInputMatchesStep1: build.result.standardJsonInputSha256 === step1.build.standardJsonInputSha256, sourceCount: build.result.sourceCount },
  };
  const semanticInventory = {
    sourceCommit: SOURCE_COMMIT, sourceFiles: SOURCE_FILES.map(hashFile), compiledAbi: build.result.abiEvidence,
    qualifyingSafeKeyedModules: MODULE_SPECS.map((x) => ({ name: x.name, address: getAddress(x.address), mappingKey: "safe", getter: x.getter, requestEvent: x.requestEvent, executionCashMatch: { cashRecipient: "module address", tokenCount: 1, token: x.kind === "frax" ? "fraxusd immutable" : "module record asset", amount: "module record amount" } })),
    nonQualifyingScopedModules: [
      { name: "EtherFiStakeModule", reason: "Source and compiled ABI expose staking deposit only; no withdrawal request, safe-keyed pending record, or pending getter." },
      { name: "LiquidUSDLiquifierModule", reason: "withdrawLiquidUSD is role-gated and module-global against the Boring queue; it has no safe argument, safe-keyed pending record, or CashModule withdrawal request linkage." },
    ],
    cashGetData: { key: "safe", pendingTuple: ["tokens[]", "amounts[]", "recipient", "finalizeTime"], accessPredicate: "onlyEtherFiSafe(safe)", sourceReferences: ["ICashModule.sol:76-81,88-101,316", "CashModuleCore.sol:288-292", "CashModuleSetters.sol:193-207,329-348"] },
    discoveryJoin: { source: "scoped module request events in the provider-retained window", coverageStartBlock: RETAINED_LOG_START_BLOCK, join: "request-event safe -> module safe-keyed getter and CashModule.getData(safe) at exact pin", caveat: "This is sufficient to prove a selected current pending row but is not full-history absence coverage." },
  };
  const requestTopicSpecs = MODULE_SPECS.map((spec) => ({ name: spec.name, address: spec.address, topicHash: interfaces[spec.name].getEvent(spec.requestEvent).topicHash }));
  const selection = await selectProvider(requestTopicSpecs); if (!selection.url) throw new Error("ACCESS_BLOCKED: no sanitized inventory provider consensus passed exact-pin historical state/log capability checks");
  const reader = new Reader(selection); const blockTag = toQuantity(PIN.blockNumber);
  const chainR = await reader.read("eth_chainId", [], "pin.chainId"); const blockR = await reader.read("eth_getBlockByNumber", [blockTag, false], "pin.block");
  const pin = { ...PIN, timestamp: blockR.ok ? Number(BigInt(blockR.result.timestamp)) : null, chainIdVerified: chainR.ok && Number(BigInt(chainR.result)) === PIN.chainId, exactNumberHashVerified: blockR.ok && blockR.result?.hash?.toLowerCase() === PIN.blockHash.toLowerCase(), terminalSameNumberHashVerified: null };
  const stargateRuntimeR = await reader.read("eth_getCode", [ADDR.StargateModule, blockTag], "stargate.runtime");
  const stargateImplSlotR = await reader.read("eth_getStorageAt", [ADDR.StargateModule, IMPL_SLOT, blockTag], "stargate.implementationSlot"); const stargateAdminSlotR = await reader.read("eth_getStorageAt", [ADDR.StargateModule, ADMIN_SLOT, blockTag], "stargate.adminSlot"); const stargateBeaconSlotR = await reader.read("eth_getStorageAt", [ADDR.StargateModule, BEACON_SLOT, blockTag], "stargate.beaconSlot");
  const stargateDataProviderR = await reader.call(ADDR.StargateModule, interfaces.StargateModule, "etherFiDataProvider", [], blockTag, "stargate.etherFiDataProvider"); const stargateCashModuleR = await reader.call(ADDR.StargateModule, interfaces.StargateModule, "cashModule", [], blockTag, "stargate.cashModule");
  const stargateDataProvider = stargateDataProviderR.ok ? asAddress(stargateDataProviderR.decoded[0]) : null; const stargateCashModule = stargateCashModuleR.ok ? asAddress(stargateCashModuleR.decoded[0]) : null;
  const stargateImmutableBindings = { etherFiDataProvider: { value: ADDR.EtherFiDataProvider, source: "getter", evidence: "StargateModule.etherFiDataProvider() at fixed pin", observed: stargateDataProvider, getterMatched: sameAddress(stargateDataProvider, ADDR.EtherFiDataProvider) }, cashModule: { value: ADDR.CashModule, source: "getter", evidence: "StargateModule.cashModule() at fixed pin", observed: stargateCashModule, getterMatched: sameAddress(stargateCashModule, ADDR.CashModule) } };
  const stargateRuntimeComparison = stargateRuntimeR.ok ? reconstructRuntime(build.artifacts.StargateModule, stargateRuntimeR.result, collectImmutableNames(build.buildInfo), stargateImmutableBindings) : { exactReconstructedRuntimeEqual: false, immutableRows: [], reason: "runtime-unavailable" };
  const stargateSlots = { implementation: { readOk: stargateImplSlotR.ok, zero: stargateImplSlotR.ok && zeroStorageWord(stargateImplSlotR.result), address: stargateImplSlotR.ok ? slotAddress(stargateImplSlotR.result) : null }, admin: { readOk: stargateAdminSlotR.ok, zero: stargateAdminSlotR.ok && zeroStorageWord(stargateAdminSlotR.result), address: stargateAdminSlotR.ok ? slotAddress(stargateAdminSlotR.result) : null }, beacon: { readOk: stargateBeaconSlotR.ok, zero: stargateBeaconSlotR.ok && zeroStorageWord(stargateBeaconSlotR.result), address: stargateBeaconSlotR.ok ? slotAddress(stargateBeaconSlotR.result) : null } };
  const stargateStructure = Object.values(stargateSlots).every((x) => x.readOk && x.zero) ? "direct-deployment-no-eip1967-slots" : Object.values(stargateSlots).some((x) => x.address) ? "proxy-or-beacon-observed" : "deployment-structure-unbound";
  const stargateDeploymentBinding = { address: getAddress(ADDR.StargateModule), structure: stargateStructure, eip1967Slots: stargateSlots, getterBindings: stargateImmutableBindings, deployedRuntime: stargateRuntimeR.ok ? stargateRuntimeR.result : null, runtimeComparison: stargateRuntimeComparison };
  const scopedNames = ["EtherFiLiquidModule", "EtherFiLiquidModuleWithReferrer", "FraxModule", "StargateModule", "EtherFiStakeModule", "LiquidUSDLiquifierModule"];
  const defaultFlags = {}; for (const name of scopedNames) { const r = await reader.call(ADDR.EtherFiDataProvider, interfaces.EtherFiDataProvider, "isDefaultModule", [ADDR[name]], blockTag, `default.${name}`); defaultFlags[name] = r.ok ? Boolean(r.decoded[0]) : null; }
  const logScan = await scanRequestLogs(reader, RETAINED_LOG_START_BLOCK, interfaces);
  const candidates = [...new Set(logScan.parsedLogs.map((x) => `${x.module}:${x.safe.toLowerCase()}`))].sort();
  const fraxAssetR = await reader.call(ADDR.FraxModule, interfaces.FraxModule, "fraxusd", [], blockTag, "frax.fraxusd"); const fraxAsset = fraxAssetR.ok ? asAddress(fraxAssetR.decoded[0]) : null;
  const stateRows = [];
  for (const candidate of candidates) {
    const split = candidate.indexOf(":"); const moduleName = candidate.slice(0, split); const safe = getAddress(candidate.slice(split + 1)); const spec = MODULE_SPECS.find((x) => x.name === moduleName); const moduleCall = await reader.call(spec.address, interfaces[moduleName], spec.getter, [safe], blockTag, `${moduleName}.pending.${safe}`);
    if (!moduleCall.ok) { stateRows.push({ module: moduleName, safe, moduleReadOk: false, modulePending: null, cashReadOk: false, blocker: moduleCall.error }); continue; }
    const moduleState = decodeModulePending(spec, moduleCall.decoded, fraxAsset); moduleState.key.safe = safe; const pending = modulePendingPresent(moduleState);
    if (!pending) { stateRows.push({ module: moduleName, safe, moduleReadOk: true, modulePending: false, moduleState, cashReadOk: null, comparison: null }); continue; }
    const cashCall = await reader.call(ADDR.CashModule, interfaces.CashModuleCore, "getData", [safe], blockTag, `cash.getData.${safe}`); if (!cashCall.ok) { stateRows.push({ module: moduleName, safe, moduleReadOk: true, modulePending: true, moduleState, cashReadOk: false, blocker: cashCall.error }); continue; }
    const cashState = decodeCashData(cashCall.decoded); cashState.key.safe = safe; const comparison = compareTuples(spec.address, moduleState, cashState); const pairEvents = logScan.parsedLogs.filter((x) => x.module === moduleName && sameAddress(x.safe, safe)); const latestRequestEvent = pairEvents.length ? pairEvents[pairEvents.length - 1] : null; const latestRequestMatchesState = eventMatchesState(latestRequestEvent, moduleState); const matchingEvents = pairEvents.filter((x) => eventMatchesState(x, moduleState)); const lastMatchingEvent = matchingEvents.length ? matchingEvents[matchingEvents.length - 1] : null; const laterNonmatchingEventExists = Boolean(lastMatchingEvent && pairEvents.some((x) => (x.blockNumber > lastMatchingEvent.blockNumber || (x.blockNumber === lastMatchingEvent.blockNumber && x.logIndex > lastMatchingEvent.logIndex)) && !eventMatchesState(x, moduleState)));
    stateRows.push({ module: moduleName, moduleAddress: getAddress(spec.address), safe, moduleReadOk: true, modulePending: true, moduleState, cashReadOk: true, cashPending: cashState.tokens.length > 0, cashState, comparison, pairRequestEventCount: pairEvents.length, latestRequestEvent, latestRequestMatchesState, lastMatchingEvent, laterNonmatchingEventExists, finalizedAtPin: BigInt(cashState.finalizeTime) <= BigInt(pin.timestamp), observationBinding: { blockNumber: PIN.blockNumber, blockHash: PIN.blockHash } });
  }
  const qualifying = stateRows.filter((x) => x.modulePending && x.cashPending && x.latestRequestMatchesState && !x.laterNonmatchingEventExists && defaultFlags[x.module] === true); const selected = qualifying.find((x) => x.comparison.equal && x.module === "StargateModule") || qualifying.find((x) => x.comparison.equal) || qualifying[0] || null;
  let selectedEventBlockVerified = null; if (selected?.latestRequestEvent) { const eventBlock = await reader.read("eth_getBlockByNumber", [toQuantity(selected.latestRequestEvent.blockNumber), false], "selected.requestEvent.block"); selectedEventBlockVerified = eventBlock.ok && eventBlock.result?.hash?.toLowerCase() === selected.latestRequestEvent.blockHash.toLowerCase(); }
  const terminalR = await reader.read("eth_getBlockByNumber", [blockTag, false], "pin.terminal"); pin.terminalSameNumberHashVerified = terminalR.ok && terminalR.result?.hash?.toLowerCase() === PIN.blockHash.toLowerCase();
  const retainedWindowComplete = logScan.complete && logScan.parseComplete && selection.retainedLogConsensusCount >= 2 && logScan.rawLogSetDigest === selection.retainedLogDigest && MODULE_SPECS.every((x) => logScan.moduleCoverage[x.name]?.complete && logScan.moduleCoverage[x.name]?.startsAtRetainedWindow && logScan.moduleCoverage[x.name]?.endsAtPin);
  const stargateSemanticsExact = stargateDeploymentBinding.structure === "direct-deployment-no-eip1967-slots" && stargateRuntimeComparison.exactReconstructedRuntimeEqual === true && stargateRuntimeComparison.allImmutableRowsIndependentlyBound === true && stargateRuntimeComparison.allImmutableActualValuesMatch === true && guardSemantics.stargateExecuteBridge.equalityGuardPresent && guardSemantics.stargateExecuteBridge.cashProcessCalledAfterEqualityGuard && guardSemantics.cashProcessWithdrawal.finalizeTimeGuardPresent && guardSemantics.cashProcessWithdrawal.guardBeforeTransfers && guardSemantics.cashProcessWithdrawal.step1CashRuntimeExact && guardSemantics.buildLinkage.sourceCommitMatch && guardSemantics.buildLinkage.standardJsonInputMatchesStep1;
  const selectedEvidenceComplete = pin.chainIdVerified && pin.exactNumberHashVerified && pin.terminalSameNumberHashVerified && retainedWindowComplete && Boolean(selected) && selected.module === "StargateModule" && selected.comparison.equal && selected.latestRequestMatchesState && !selected.laterNonmatchingEventExists && selectedEventBlockVerified === true && stargateSemanticsExact && Object.values(defaultFlags).every((x) => x === true);
  const classification = selectedEvidenceComplete ? "exact-pending-tuple-equal" : !retainedWindowComplete ? "access-blocked-retained-window" : !selected ? "no-qualifying-pending-withdrawal-in-retained-window" : !stargateSemanticsExact ? "deployed-guard-semantics-unbound" : "pending-tuple-mismatch-or-latest-event-conflict";
  const runId = `etherfi-pending-withdrawal-tuple-${PIN.blockNumber}-${PIN.blockHash.slice(2, 14)}-${scannerSha256.slice(0, 12)}`;
  const captureProvenance = { runId, revision: REVISION, scannerSha256, capturedAt, pin, r1PredecessorRunId: r1Predecessor.runId, r1PredecessorRawSha256: r1Predecessor.packageHashes.rawSha256, step1RunId: step1.runId, step1RawSha256: hashFile(STEP1).sha256, capabilityRunId: capability.runId, capabilityRawSha256: hashFile(CAPABILITY).sha256 };
  const publicationProvenance = { currentPublicationScannerSha256: scannerSha256, capturePublicationScannerIdentical: true, mode: "r2-reviewer-corrected-network-capture-and-initial-publication", byteIdenticalPublicationClaimed: false };
  const evidenceSummary = selected ? `${selected.module} safe-keyed pending record and CashModule.getData are ${selected.comparison.equal ? "equal" : "mismatched"} at the exact pin for safe ${selected.safe}; the event is the latest request observed for that module+Safe in the retained window, matches current state, and its block hash is verified.` : `No qualifying pending withdrawal was proven in the explicitly bounded retained window ${RETAINED_LOG_START_BLOCK}-${PIN.blockNumber}; no full-history absence claim is made.`;
  const blockers = classification === "exact-pending-tuple-equal" ? ["Tuple equality does not prove valid-signature tuple isolation under adversarial signatures.", "Completeness is limited to the explicit retained window; full module history and archive-boundary completeness are false.", "No withdrawal execution, state transition, recipient receipt, bridge delivery, or financial route was tested."] : ["At least one deployed-binding, latest-request, selected-state, or retained-window gate is not proven.", "Completed, out-of-scope, CashModule-originated, and non-safe-keyed withdrawals were not substituted; no execution or mutation was performed."];
  const nextAction = selectedEvidenceComplete ? "Submit the reviewer-corrected r2 package for independent promotion; do not execute the withdrawal." : "Resolve the first failed deployed-binding, latest-event, or retained-window gate and rerun read-only; do not execute the withdrawal.";
  const result = {
    schemaVersion: 1, revision: REVISION, runId, generatedAt: capturedAt, scanner: SCANNER, agentId: AGENT, role: "critical-research", step: 2,
    scope: "One exact-pin pending withdrawal from the six named non-Cash default modules, with module safe-keyed record versus CashModule.getData comparison",
    classification, signal: classification === "exact-pending-tuple-equal" ? "⚪ CLEAN — EXACT TUPLE EQUALITY / DEPLOYED GUARDS BOUND" : "🟠 WATCH — FAIL CLOSED",
    routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false,
    safety: { readOnlyRpc: true, endpointInventoryRead: true, graphqlInventoryRead: false, endpointValuesPersisted: false, pendingWithdrawalsInspected: true, withdrawalExecutionAttempted: false, ethSendMethodsUsed: false, signingUsed: false, impersonationUsed: false, stateMutation: false, forkTransaction: false, fundsUsed: false },
    captureProvenance, publicationProvenance, r1Predecessor,
    predecessor: { step1: { path: STEP1, runId: step1.runId, revision: step1.revision, classification: step1.classification, sha256: hashFile(STEP1).sha256 }, capability: { path: CAPABILITY, runId: capability.runId, sha256: hashFile(CAPABILITY).sha256 } },
    build: build.result, semanticInventory, deployedSemanticsBinding: { stargate: stargateDeploymentBinding, guardSemantics, exact: stargateSemanticsExact },
    providerCoverage: { inventoryCount: selection.inventoryCount, inventoryLoadSucceeded: selection.inventoryLoadSucceeded, maxEndpoints: MAX_PROVIDER_ENDPOINTS, maxProviderCalls: MAX_PROVIDER_CALLS, endpointsTried: selection.endpointsTried, providerCalls: selection.calls, selectedOrdinal: selection.selectedOrdinal, historicalLogProbeBlock: selection.historicalLogProbeBlock, retainedLogConsensusCount: selection.retainedLogConsensusCount, retainedLogDigestVariantsObserved: selection.retainedLogDigestVariantsObserved, acceptance: selection.acceptance, rejectionCounts: selection.rejectionCounts, valuesPersisted: false },
    pin, defaultFlags, searchCoverage: { retainedWindowComplete, retainedWindowStartBlock: RETAINED_LOG_START_BLOCK, retainedWindowEndBlock: PIN.blockNumber, fullModuleHistoryCovered: false, fullHistoryCaveat: "Completeness applies only to the explicit retained window. No archive boundary or full-history completeness is claimed.", discoveryMethod: "multi-provider-consensus per-module exact-event retained-window queries joined to exact-pin module and Cash state", retainedLogConsensusCount: selection.retainedLogConsensusCount, retainedLogSetDigest: logScan.rawLogSetDigest, moduleCoverage: logScan.moduleCoverage, logRangeCount: logScan.ranges.length, rawLogCount: logScan.rawLogCount, parsedLogCount: logScan.parsedLogCount, candidateModuleSafeCount: candidates.length, candidateKeysAggregateSha256: sha(candidates.join("\n")), exactPinModuleStateRowsChecked: stateRows.length, qualifyingPendingRows: qualifying.length, selectedLatestRequestEventVerified: Boolean(selected?.latestRequestMatchesState && !selected?.laterNonmatchingEventExists), selectedEventBlockVerified, selectedEvidenceComplete, rpcReadsUsed: reader.count, maxRpcReads: MAX_RPC_READS },
    requestLogs: logScan.parsedLogs, stateRows, selected, evidenceSummary,
    implications: { equalityOrMismatch: selected?.comparison.equal === true ? "equal" : selected ? "mismatch" : "not-established", keying: selected?.comparison.keying || null, validSignatureIsolation: "Unproven. A matching successful request event and current equal stored tuples show one authentic accepted tuple, not isolation against a different validly signed tuple or signer/caller substitution.", executionImplication: selected?.comparison.equal === true ? "The source tuple-equality guard is satisfied by stored values at the pin, but finalize/authorization/external bridge execution was not attempted." : selected ? "The source tuple-equality guard is not satisfied and would be expected to revert before Cash processing." : "No qualifying tuple was available for execution-guard assessment.", remainsUnproven: ["valid-signature tuple isolation", "withdrawal execution", "recipient receipt", "bridge or redemption settlement", "positive economics", "permissionless value extraction"] },
    blockers, nextAction, transcript: reader.transcript,
  };
  fs.rmSync(build.tempRoot, { recursive: true, force: true });
  writeOwned(RAW, JSON.stringify(result, null, 2) + "\n");
  const selectedMd = selected ? `| Module | Safe key | Asset | Amount | Cash recipient=module | Token equal | Amount equal | Overall |\n|---|---|---|---:|---:|---:|---:|---:|\n| ${selected.module} | \`${selected.safe}\` | \`${selected.moduleState.asset}\` | \`${selected.moduleState.amount}\` | ${selected.comparison.checks.recipientIsModule} | ${selected.comparison.checks.assetEqual} | ${selected.comparison.checks.amountEqual} | ${selected.comparison.equal} |` : "No qualifying row.";
  const selectedDetails = selected ? `- Latest retained-window request event: block \`${selected.latestRequestEvent.blockNumber}\` / \`${selected.latestRequestEvent.blockHash}\`, transaction \`${selected.latestRequestEvent.transactionHash}\`, log index \`${selected.latestRequestEvent.logIndex}\`; block hash verified \`${selectedEventBlockVerified}\`.\n- Pair request events in retained window: \`${selected.pairRequestEventCount}\`; latest matches state \`${selected.latestRequestMatchesState}\`; later nonmatching event exists \`${selected.laterNonmatchingEventExists}\`.\n- Module tuple: destination EID \`${selected.moduleState.destEid}\`, destination recipient \`${selected.moduleState.destRecipient}\`, max slippage bps \`${selected.moduleState.maxSlippageInBps}\`.\n- Cash finalizeTime \`${selected.cashState.finalizeTime}\` versus pin timestamp \`${pin.timestamp}\`; not yet finalizable at pin \`${BigInt(selected.cashState.finalizeTime) > BigInt(pin.timestamp)}\`.` : "- No selected details.";
  const bindingDetails = `- Stargate deployment structure: \`${stargateDeploymentBinding.structure}\`; EIP-1967 implementation/admin/beacon slots independently read as zero: \`${stargateSlots.implementation.zero}/${stargateSlots.admin.zero}/${stargateSlots.beacon.zero}\`.\n- Stargate exact reconstructed runtime: \`${stargateRuntimeComparison.exactReconstructedRuntimeEqual}\`; immutable AST rows independently bound: \`${stargateRuntimeComparison.allImmutableRowsIndependentlyBound}\`.\n- \`executeBridge\` equality guard source-bound: \`${guardSemantics.stargateExecuteBridge.equalityGuardPresent && guardSemantics.stargateExecuteBridge.cashProcessCalledAfterEqualityGuard}\` (\`StargateModule.sol:236-250\`); Cash finalize-time guard Step-1-runtime-bound: \`${guardSemantics.cashProcessWithdrawal.finalizeTimeGuardPresent && guardSemantics.cashProcessWithdrawal.step1CashRuntimeExact}\` (\`CashModuleStorageContract.sol:298-330\`).\n- Standard-json input matches Step 1: \`${guardSemantics.buildLinkage.standardJsonInputMatchesStep1}\`; source commit matches: \`${guardSemantics.buildLinkage.sourceCommitMatch}\`.`;
  const report = `# ${result.signal} — EtherFi pending-withdrawal tuple Step 2\n\n**Classification:** \`${classification}\`  \n**Run:** \`${runId}\`  \n**Pin:** Optimism \`${PIN.blockNumber}\` / \`${PIN.blockHash}\`; terminal recheck \`${pin.terminalSameNumberHashVerified}\`  \n**Gates:** \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`, \`fork=false\`\n\n## Exact evidence\n\n${evidenceSummary}\n\n${selectedMd}\n\n${selectedDetails}\n\nThe four qualifying source surfaces are keyed only by \`safe\`; there is no separate request ID. EtherFiStakeModule has no withdrawal surface, and LiquidUSDLiquifierModule has only a role-gated module-global queue request, so neither was substituted.\n\n## Search coverage\n\n- Retained request-log window: ${RETAINED_LOG_START_BLOCK}-${PIN.blockNumber}; parsed logs: ${logScan.parsedLogCount}; candidate module/safe keys: ${candidates.length}; exact-pin state rows: ${stateRows.length}.\n- Full module history is not covered because the selected provider's receipt archive is bounded. This limits absence claims, but the selected row is independently bound by its request event, current module record, CashModule.getData, exact pin, and terminal hash recheck.\n- Inventory count/tried/selected ordinal: ${selection.inventoryCount}/${selection.endpointsTried}/${selection.selectedOrdinal}; values and domains not retained.\n- Six scoped modules default at pin: \`${Object.values(defaultFlags).every(Boolean)}\`.\n\n## Isolation implications\n\n- Equality/mismatch: \`${result.implications.equalityOrMismatch}\`.\n- ${result.implications.validSignatureIsolation}\n- ${result.implications.executionImplication}\n\n## Blockers\n\n${blockers.map((x) => `- ${x}`).join("\n")}\n\n## nextReadOnlyStep\n\n${nextAction}\n`;
  const reviewerReport = report
    .replace("— EtherFi pending-withdrawal tuple Step 2\n\n**Classification", `— EtherFi pending-withdrawal tuple Step 2 r2 reviewer-corrected\n\n**Revision:** \`${REVISION}\`  \n**Classification`)
    .replace(`${selectedDetails}\n\nThe four`, `${selectedDetails}\n\n## Deployed guard binding\n\n${bindingDetails}\n\nThe four`)
    .replace("- Retained request-log window:", `- Retained-window completeness: \`${retainedWindowComplete}\`; full-module-history coverage: \`false\`.\n- Retained request-log window:`)
    .replace("- Inventory count/tried/selected ordinal:", `- Retained log-set provider consensus: \`${selection.retainedLogConsensusCount}\`; sanitized digest variants observed: \`${selection.retainedLogDigestVariantsObserved}\`.\n- Inventory count/tried/selected ordinal:`)
    .replace("- Full module history is not covered because the selected provider's receipt archive is bounded. This limits absence claims, but the selected row is independently bound by its request event, current module record, CashModule.getData, exact pin, and terminal hash recheck.", "- Completeness is asserted only for this explicit retained window. No archive-boundary or full-history completeness is claimed; the selected row is independently bound by its retained-window request event, current module record, CashModule.getData, exact pin, and terminal hash recheck.");
  writeOwned(REPORT, reviewerReport);
  const inbox = { findingId: "etherfi-pending-withdrawal-tuple-step2", revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: classification, classification, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: evidenceSummary, artifacts: [RAW, MANIFEST, REPORT], blockers, nextAction, captureProvenance, publicationProvenance };
  const reviewerInbox = { ...inbox, r1Predecessor: { runId: r1Predecessor.runId, preservationMode: r1Predecessor.preservationMode, originalFilesManifestBoundInR2: false, rawSha256: r1Predecessor.packageHashes.rawSha256 }, retainedWindow: { startBlock: RETAINED_LOG_START_BLOCK, endBlock: PIN.blockNumber, complete: retainedWindowComplete, fullModuleHistoryCovered: false }, deployedSemanticsExact: stargateSemanticsExact, latestRetainedWindowRequestEventVerified: Boolean(selected?.latestRequestMatchesState && !selected?.laterNonmatchingEventExists && selectedEventBlockVerified) };
  writeOwned(INBOX, JSON.stringify(reviewerInbox, null, 2) + "\n");
  writeOwned(HANDOFF, `# 2026-07-21 EtherFi pending-withdrawal tuple Step 2 handoff\n\n- Run: \`${runId}\`; classification \`${classification}\`.\n- Exact pin and terminal recheck: \`${pin.exactNumberHashVerified}/${pin.terminalSameNumberHashVerified}\`.\n- Evidence: ${evidenceSummary}\n- Search: retained window ${RETAINED_LOG_START_BLOCK}-${PIN.blockNumber}, ${logScan.parsedLogCount} request logs, ${candidates.length} candidate keys, ${stateRows.length} exact-pin state rows, ${qualifying.length} qualifying pending rows.\n- Equality/mismatch: \`${result.implications.equalityOrMismatch}\`; valid-signature isolation remains unproven.\n- Gates: \`0/0/false\`; fork false. No execution, signing, mutation, impersonation, or funds.\n- Next: ${nextAction}\n`);
  const reviewerHandoff = `# 2026-07-21 EtherFi pending-withdrawal tuple Step 2 r2 reviewer-corrected handoff\n\n- Run: \`${runId}\`; classification \`${classification}\`.\n- Stargate deployed semantics exact: \`${stargateSemanticsExact}\`; structure \`${stargateDeploymentBinding.structure}\`; reconstructed runtime exact \`${stargateRuntimeComparison.exactReconstructedRuntimeEqual}\`.\n- executeBridge equality guard and Cash finalize-time guard bound: \`${guardSemantics.stargateExecuteBridge.equalityGuardPresent}/${guardSemantics.cashProcessWithdrawal.finalizeTimeGuardPresent}\`; Step 1 Cash runtime exact \`${guardSemantics.cashProcessWithdrawal.step1CashRuntimeExact}\`.\n- Latest retained-window request for module+Safe matches selected state: \`${selected?.latestRequestMatchesState}\`; later nonmatching retained-window event: \`${selected?.laterNonmatchingEventExists}\`; event block verified \`${selectedEventBlockVerified}\`.\n- Retained window ${RETAINED_LOG_START_BLOCK}-${PIN.blockNumber} complete: \`${retainedWindowComplete}\`; full module history covered: \`false\`.\n- r1 is superseded in place and retained only as summary/provenance plus package hashes.\n- Gates: \`0/0/false\`; fork false. No execution, signing, mutation, impersonation, or funds.\n- Next: ${nextAction}\n`;
  writeOwned(HANDOFF, reviewerHandoff);
  const records = [...new Set([SCANNER, TEST, RAW, REPORT, INBOX, HANDOFF, STEP1, CAPABILITY, DEPLOYMENTS, ...SOURCE_FILES])].map(hashFile); const aggregateSha256 = sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
  const manifest = { schemaVersion: 1, revision: REVISION, runId, generatedAt: capturedAt, algorithm: "sha256", captureProvenance, publicationProvenance, r1Predecessor, classification, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, retainedWindowComplete, retainedWindow: { startBlock: RETAINED_LOG_START_BLOCK, endBlock: PIN.blockNumber }, fullModuleHistoryCovered: false, selectedEvidenceComplete, selectedTupleEstablished: Boolean(selected), deployedSemanticsExact: stargateSemanticsExact, latestRetainedWindowRequestEventVerified: Boolean(selected?.latestRequestMatchesState && !selected?.laterNonmatchingEventExists && selectedEventBlockVerified), records, aggregateSha256 };
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ runId, revision: REVISION, classification, pin, exactBinding: { stargateSemanticsExact, structure: stargateDeploymentBinding.structure, runtimeReconstructedExact: stargateRuntimeComparison.exactReconstructedRuntimeEqual, immutableRows: stargateRuntimeComparison.immutableAstRowCount, equalityGuardBound: guardSemantics.stargateExecuteBridge.equalityGuardPresent, cashTimeGuardBound: guardSemantics.cashProcessWithdrawal.finalizeTimeGuardPresent && guardSemantics.cashProcessWithdrawal.step1CashRuntimeExact }, evidenceSummary, selected: selected ? { module: selected.module, safe: selected.safe, moduleState: selected.moduleState, cashState: selected.cashState, comparison: selected.comparison, latestRequestEvent: selected.latestRequestEvent, latestRequestMatchesState: selected.latestRequestMatchesState, laterNonmatchingEventExists: selected.laterNonmatchingEventExists, eventBlockVerified: selectedEventBlockVerified } : null, searchCoverage: { retainedWindowComplete, retainedLogStartBlock: RETAINED_LOG_START_BLOCK, requestLogs: logScan.parsedLogCount, candidates: candidates.length, stateRows: stateRows.length, qualifying: qualifying.length, fullModuleHistoryCovered: false }, rpcReads: reader.count, manifestAggregateSha256: aggregateSha256 }) + "\n");
}

main().catch((e) => { process.stderr.write(`scan failed: ${safeMessage(e?.message || e)}\n`); process.exitCode = 1; });
