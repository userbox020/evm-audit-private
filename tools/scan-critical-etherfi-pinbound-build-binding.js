#!/usr/bin/env node
"use strict";

// Authorized defensive Step 1: fixed-pin source/build/runtime binding only.
// Endpoint inventory values and public-source request locations remain memory-only.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const { Interface, getAddress, keccak256, toQuantity } = require("ethers");
const { loadRpcUrls, getOrigin } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cash-v3");
const SCANNER = "tools/scan-critical-etherfi-pinbound-build-binding.js";
const TEST = "tools/test-critical-etherfi-pinbound-build-binding.js";
const RAW = "reports/raw/fast/critical-etherfi-pinbound-build-binding.json";
const MANIFEST = "reports/raw/fast/critical-etherfi-pinbound-build-binding-manifest.json";
const REPRO = "reports/raw/fast/critical-etherfi-pinbound-build-binding-reproduction.json";
const REPORT = "reports/critical-etherfi-pinbound-build-binding.md";
const INBOX = "coordination/inbox/critical/2026-07-21-critical-etherfi-pinbound-build-binding.json";
const HANDOFF = "coordination/handoffs/2026-07-21-critical-etherfi-pinbound-build-binding-handoff.md";
const PREDECESSOR = "reports/raw/fast/critical-etherfi-default-module-capability.json";
const AGENT = "critical-etherfi-pinbound-binding-20260721";
const REVISION = "pinbound-build-binding-step1-r3-reviewer-corrected";
const PIN = { chainId: 10, blockNumber: 154534581, blockHash: "0x9e2d47b4f179b068df84fe73f11601cfa0af372d769902848222dc3a6e3c8b13" };
const SOURCE_COMMIT = "e05bda2be27a6a606f3f1b8ff0d0791032fd0ff8";
const MAX_PROVIDER_ENDPOINTS = 80;
const MAX_PROVIDER_CALLS = 320;
const MAX_RPC_READS = 90;
const PROVIDER_TIMEOUT_MS = 5_000;
const RPC_TIMEOUT_MS = 20_000;
const BUILD_TIMEOUT_MS = 600_000;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const ADDR = {
  EtherFiDataProvider: "0xDC515Cb479a64552c5A11a57109C314E40A1A778",
  EtherFiSafeFactory: "0xF4e147Db314947fC1275a8CbB6Cde48c510cd8CF",
  EtherFiHook: "0x5D3c4f5CF2208bB54e8fd129730d01D82d4611b3",
  CashModuleCore: "0x7Ca0b75E67E33c0014325B739A8d019C4FE445F0",
  DebtManagerCore: "0x0078C5a459132e279056B2371fE8A8eC973A9553",
  LiquidUSDLiquifierModule: "0x39161A44588ec2327a18D4707EA5216C721ba539",
};

const COMPONENTS = [
  { name: "EtherFiDataProvider", proxy: ADDR.EtherFiDataProvider, artifactDir: "EtherFiDataProvider.sol", artifact: "EtherFiDataProvider.json", constructorBindings: {} },
  { name: "EtherFiSafeFactory", proxy: ADDR.EtherFiSafeFactory, artifactDir: "EtherFiSafeFactory.sol", artifact: "EtherFiSafeFactory.json", constructorBindings: {} },
  { name: "EtherFiHook", proxy: ADDR.EtherFiHook, artifactDir: "EtherFiHook.sol", artifact: "EtherFiHook.json", constructorBindings: { dataProvider: ADDR.EtherFiDataProvider } },
  { name: "CashModuleCore", proxy: ADDR.CashModuleCore, artifactDir: "CashModuleCore.sol", artifact: "CashModuleCore.json", constructorBindings: { etherFiDataProvider: ADDR.EtherFiDataProvider } },
  { name: "DebtManagerCore", proxy: ADDR.DebtManagerCore, artifactDir: "DebtManagerCore.sol", artifact: "DebtManagerCore.json", constructorBindings: { etherFiDataProvider: ADDR.EtherFiDataProvider } },
  { name: "LiquidUSDLiquifierModule", proxy: ADDR.LiquidUSDLiquifierModule, artifactDir: "LiquidUSDLiquifierOP.sol", artifact: "LiquidUSDLiquifierOPModule.json", constructorBindings: { cashModule: ADDR.CashModuleCore, debtManager: ADDR.DebtManagerCore, etherFiDataProvider: ADDR.EtherFiDataProvider } },
];

const COMMON_I = new Interface(["function roleRegistry() view returns (address)"]);
const HOOK_I = new Interface(["function dataProvider() view returns (address)"]);
const DATA_PROVIDER_GETTER_I = new Interface(["function etherFiDataProvider() view returns (address)"]);
const LIQUIFIER_I = new Interface(["function cashModule() view returns (address)", "function debtManager() view returns (address)", "function etherFiDataProvider() view returns (address)"]);

function abs(rel) { return path.join(ROOT, rel); }
function sha(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function hashFile(rel) { const data = fs.readFileSync(abs(rel)); return { path: rel, bytes: data.length, sha256: sha(data) }; }
function safeMessage(v) { return String(v == null ? "" : v).replace(/https?:\/\/[^\s"']+/gi, "[source-or-endpoint-redacted]").replace(/[?&](?:key|token|api_key|apikey)=[^\s&"']+/gi, "[credential-redacted]").slice(0, 800); }
function writeOwned(rel, content) { if (![RAW, MANIFEST, REPRO, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused: ${rel}`); fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), content, "utf8"); }
function jsonReplacer(_k, v) { return typeof v === "bigint" ? v.toString() : v; }
function canonical(v) { if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`; if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`; return JSON.stringify(v); }
function strip0x(v) { return String(v || "").replace(/^0x/i, "").toLowerCase(); }
function addressEqual(a, b) { return Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase()); }
function runtimeInfo(code) { const hex = strip0x(code); const present = hex.length > 0 && !/^0+$/.test(hex); return { present, bytes: present ? hex.length / 2 : 0, keccak256: present ? keccak256(`0x${hex}`) : null }; }
function slotAddress(word) { const hex = strip0x(word); if (hex.length !== 64 || /^0+$/.test(hex)) return null; try { return getAddress(`0x${hex.slice(-40)}`); } catch { return null; } }
function findRevertData(v, depth = 0) { if (depth > 5 || v == null) return null; if (typeof v === "string" && /^0x[0-9a-f]*$/i.test(v)) return v; if (typeof v !== "object") return null; for (const k of ["data", "result", "output", "error"]) { const x = findRevertData(v[k], depth + 1); if (x) return x; } return null; }

async function rpcFetch(url, origin, method, params, timeoutMs) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { code: response.status });
  const body = await response.json(); if (body.error) throw body.error; return body.result;
}

async function selectProvider() {
  let inventory = []; let inventoryLoadSucceeded = false;
  try { inventory = loadRpcUrls(); inventoryLoadSucceeded = true; } catch (_) { /* fail closed without persisting inventory details */ }
  const candidates = inventory.slice(0, MAX_PROVIDER_ENDPOINTS); let endpointsTried = 0; let calls = 0; const rejectionCounts = {};
  const reject = (kind) => { rejectionCounts[kind] = (rejectionCounts[kind] || 0) + 1; };
  const invoke = async (url, origin, method, params) => { if (calls >= MAX_PROVIDER_CALLS) throw Object.assign(new Error("provider-call-budget"), { selectionKind: "call-budget" }); calls++; return rpcFetch(url, origin, method, params, PROVIDER_TIMEOUT_MS); };
  for (let i = 0; i < candidates.length && calls < MAX_PROVIDER_CALLS; i++) {
    endpointsTried++; const url = candidates[i]; const origin = getOrigin(url);
    try {
      const chain = await invoke(url, origin, "eth_chainId", []);
      if (Number(BigInt(chain)) !== PIN.chainId) { reject("chain-mismatch"); continue; }
      const block = await invoke(url, origin, "eth_getBlockByNumber", [toQuantity(PIN.blockNumber), false]);
      if (block?.hash?.toLowerCase() !== PIN.blockHash.toLowerCase()) { reject("pin-unavailable-or-mismatch"); continue; }
      const code = await invoke(url, origin, "eth_getCode", [ADDR.EtherFiDataProvider, toQuantity(PIN.blockNumber)]);
      if (!runtimeInfo(code).present) { reject("representative-code-unavailable"); continue; }
      const implWord = await invoke(url, origin, "eth_getStorageAt", [ADDR.EtherFiDataProvider, IMPL_SLOT, toQuantity(PIN.blockNumber)]);
      if (!slotAddress(implWord)) { reject("representative-storage-unavailable"); continue; }
      return { url, origin, inventoryCount: inventory.length, inventoryLoadSucceeded, selectedFromInventory: true, fallbackUsed: false, selectedOrdinal: i, endpointsTried, calls, rejectionCounts, acceptance: { chainId: true, exactBlockHash: true, representativeHistoricalCode: true, representativeHistoricalImplementationSlot: true } };
    } catch (e) {
      if (e?.selectionKind === "call-budget") reject("call-budget");
      else if (e?.name === "TimeoutError" || e?.name === "AbortError") reject("timeout");
      else if (Number.isInteger(e?.code)) reject(`status-${e.code}`);
      else reject("transport-or-rpc-failure");
    }
  }
  return { url: null, origin: null, inventoryCount: inventory.length, inventoryLoadSucceeded, selectedFromInventory: false, fallbackUsed: false, selectedOrdinal: null, endpointsTried, calls, rejectionCounts, acceptance: { chainId: false, exactBlockHash: false, representativeHistoricalCode: false, representativeHistoricalImplementationSlot: false } };
}

class RpcReader {
  constructor(selection) { this.selection = selection; this.count = 0; this.transcript = []; }
  async read(method, params, label, tag = "pin") {
    if (this.count >= MAX_RPC_READS) throw new Error(`RPC read cap reached before ${label}`);
    const number = ++this.count;
    try { const result = await rpcFetch(this.selection.url, this.selection.origin, method, params, RPC_TIMEOUT_MS); this.transcript.push({ number, label, method, tag, ok: true }); return { ok: true, result }; }
    catch (e) { const data = findRevertData(e); this.transcript.push({ number, label, method, tag, ok: false, code: Number.isInteger(e?.code) ? e.code : null, revertDataPresent: Boolean(data), error: safeMessage(e?.message || e) }); return { ok: false, data, error: safeMessage(e?.message || e) }; }
  }
  async call(address, iface, fn, args, blockTag, label) {
    const r = await this.read("eth_call", [{ to: address, data: iface.encodeFunctionData(fn, args || []) }, blockTag], label);
    if (!r.ok) return null;
    try { const out = iface.decodeFunctionResult(fn, r.result); return out.length === 1 ? normalize(out[0]) : normalize(Array.from(out)); } catch { return null; }
  }
}
function normalize(v) { if (typeof v === "bigint") return v.toString(); if (Array.isArray(v)) return v.map(normalize); if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !/^\d+$/.test(k)).map(([k, x]) => [k, normalize(x)])); return v; }

function metadataSplit(code) {
  const hex = strip0x(code); if (hex.length < 4) return { full: hex, core: hex, metadata: "", metadataBytes: 0, valid: false };
  const payloadBytes = parseInt(hex.slice(-4), 16); const totalBytes = payloadBytes + 2; const chars = totalBytes * 2; const valid = payloadBytes >= 0 && chars <= hex.length;
  return valid ? { full: hex, core: hex.slice(0, -chars), metadata: hex.slice(-chars), metadataBytes: totalBytes, valid: true } : { full: hex, core: hex, metadata: "", metadataBytes: 0, valid: false };
}
function mismatchDetails(aCode, bCode, limit = 64) {
  const a = strip0x(aCode); const b = strip0x(bCode); const n = Math.min(a.length, b.length) / 2; const offsets = [];
  for (let i = 0; i < n; i++) if (a.slice(i * 2, i * 2 + 2) !== b.slice(i * 2, i * 2 + 2)) offsets.push(i);
  const lengthDeltaBytes = (a.length - b.length) / 2;
  return { mismatchByteCountWithinOverlap: offsets.length, lengthDeltaBytes, totalMismatchMeasure: offsets.length + Math.abs(lengthDeltaBytes), firstMismatchOffsets: offsets.slice(0, limit), truncated: offsets.length > limit };
}
function maskRanges(code, ranges) { const bytes = Buffer.from(strip0x(code), "hex"); for (const r of ranges) bytes.fill(0, r.start, r.start + r.length); return `0x${bytes.toString("hex")}`; }
function addressWord(address) { return Buffer.from(`${"0".repeat(24)}${strip0x(address)}`, "hex"); }
function patchRanges(code, ranges, value) { const bytes = Buffer.from(strip0x(code), "hex"); const word = addressWord(value); for (const r of ranges) { if (r.length !== 32) throw new Error(`unsupported immutable length ${r.length}`); word.copy(bytes, r.start); } return `0x${bytes.toString("hex")}`; }
function flattenImmutableRefs(refs) { return Object.entries(refs || {}).flatMap(([astId, ranges]) => ranges.map((r) => ({ astId, start: Number(r.start), length: Number(r.length) }))); }

function collectAstImmutableNames(buildInfo) {
  const map = new Map();
  function walk(node, sourcePath) { if (!node || typeof node !== "object") return; if (node.nodeType === "VariableDeclaration" && node.mutability === "immutable") map.set(String(node.id), { name: node.name, sourcePath }); for (const value of Object.values(node)) { if (Array.isArray(value)) value.forEach((x) => walk(x, sourcePath)); else if (value && typeof value === "object") walk(value, sourcePath); } }
  for (const [sourcePath, item] of Object.entries(buildInfo.output?.sources || {})) walk(item.ast, sourcePath);
  return map;
}

function compareArtifactRuntime(artifact, deployedCode, expectedBindings, implementationAddress, immutableNames) {
  const template = artifact.deployedBytecode?.object;
  if (!template) return { buildArtifactAvailable: false, exactRuntimeEqual: null, reason: "deployed bytecode absent" };
  const refsById = artifact.deployedBytecode.immutableReferences || {}; const ranges = flattenImmutableRefs(refsById);
  const exactRuntimeEqual = strip0x(template) === strip0x(deployedCode);
  const metadataA = metadataSplit(template); const metadataB = metadataSplit(deployedCode);
  const metadataStrippedEqual = metadataA.core === metadataB.core;
  const immutableMaskedEqual = strip0x(maskRanges(template, ranges)) === strip0x(maskRanges(deployedCode, ranges));
  const immutableMaskedMetadataStrippedEqual = metadataSplit(maskRanges(template, ranges)).core === metadataSplit(maskRanges(deployedCode, ranges)).core;
  let reconstructed = `0x${strip0x(template)}`; const immutableRows = []; let allExpected = true; let allIndependentlyBound = true; let allActualValuesMatch = true;
  for (const [astId, positions] of Object.entries(refsById)) {
    const declaration = immutableNames.get(String(astId)) || { name: null, sourcePath: null };
    const supplied = declaration.name === "__self"
      ? { value: implementationAddress, source: "implementation-address", evidence: "pin-bound-eip1967-implementation-slot", independentlyBound: Boolean(implementationAddress) }
      : (expectedBindings[declaration.name] || null);
    const normalizedBinding = typeof supplied === "string" ? { value: supplied, source: "independently-fixed-deployed-address", evidence: "fixed-scope-deployment-map", independentlyBound: true } : supplied;
    const expected = normalizedBinding?.value || null;
    const bindingSourceAllowed = ["getter", "implementation-address", "independently-fixed-deployed-address"].includes(normalizedBinding?.source);
    const independentlyBound = Boolean(expected && bindingSourceAllowed && normalizedBinding?.independentlyBound === true);
    const values = positions.map((r) => `0x${strip0x(deployedCode).slice(Number(r.start) * 2, (Number(r.start) + Number(r.length)) * 2)}`);
    const valuesConsistent = values.length > 0 && values.every((x) => x === values[0]);
    const expectedWord = expected ? `0x${addressWord(expected).toString("hex")}` : null;
    const actualMatchesExpected = Boolean(expectedWord && valuesConsistent && values[0] === expectedWord);
    if (!expected) allExpected = false;
    if (!independentlyBound) allIndependentlyBound = false;
    if (!actualMatchesExpected) allActualValuesMatch = false;
    if (expected) reconstructed = patchRanges(reconstructed, positions, expected);
    immutableRows.push({ astId, declarationName: declaration.name, sourcePath: declaration.sourcePath, positions: positions.map((x) => ({ start: Number(x.start), length: Number(x.length) })), expectedValue: expected, expectedValueSource: normalizedBinding?.source || null, expectedValueEvidence: normalizedBinding?.evidence || null, independentlyBound, observedGetterValue: normalizedBinding?.observedGetterValue || null, actualValueSha256: valuesConsistent ? sha(Buffer.from(strip0x(values[0]), "hex")) : null, valuesConsistent, actualMatchesExpected });
  }
  const exactReconstructedEqual = allExpected && allIndependentlyBound && allActualValuesMatch && strip0x(reconstructed) === strip0x(deployedCode);
  return {
    buildArtifactAvailable: true, templateRuntime: runtimeInfo(template), deployedRuntime: runtimeInfo(deployedCode), exactRuntimeEqual,
    metadata: { templateBytes: metadataA.metadataBytes, deployedBytes: metadataB.metadataBytes, templateMetadataSha256: metadataA.metadata ? sha(Buffer.from(metadataA.metadata, "hex")) : null, deployedMetadataSha256: metadataB.metadata ? sha(Buffer.from(metadataB.metadata, "hex")) : null, metadataExact: metadataA.metadata === metadataB.metadata },
    metadataStrippedEqual, immutableReferenceCount: ranges.length, immutableRows, allImmutableExpectedBindingsKnown: allExpected, allImmutableRowsIndependentlyBound: allIndependentlyBound, allImmutableActualValuesMatchExpected: allActualValuesMatch,
    immutableMaskedEqual, immutableMaskedMetadataStrippedEqual, exactReconstructedEqual,
    exactMismatch: mismatchDetails(template, deployedCode), reconstructedMismatch: mismatchDetails(reconstructed, deployedCode),
    linkReferences: artifact.deployedBytecode.linkReferences || {}, linkedLibraryReferenceCount: Object.values(artifact.deployedBytecode.linkReferences || {}).reduce((n, file) => n + Object.values(file).reduce((m, rows) => m + rows.length, 0), 0),
    sufficiency: exactReconstructedEqual ? "Exact deployed runtime reconstructed from the compiler template using independently expected immutable addresses; no normalization-only promotion." : immutableMaskedEqual ? "Partial only: immutable-masked equality does not establish exact runtime unless every immutable is independently bound and exact reconstruction succeeds." : "Runtime differs outside declared immutable positions.",
  };
}

function walkFiles(dir, predicate, out = []) { if (!fs.existsSync(dir)) return out; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walkFiles(full, predicate, out); else if (predicate(full)) out.push(full); } return out; }
function parseRemappings() { return fs.readFileSync(path.join(TARGET, "remappings.txt"), "utf8").split(/\r?\n/).map((x) => x.trim()).filter((x) => x.includes("=")).map((x) => { const i = x.indexOf("="); return { prefix: x.slice(0, i), replacement: x.slice(i + 1) }; }).sort((a, b) => b.prefix.length - a.prefix.length); }
function sourceClosure(seeds) {
  const remappings = parseRemappings(); const queue = seeds.map((x) => path.resolve(TARGET, x)); const seen = new Set(); const unresolved = [];
  while (queue.length) { const file = queue.shift(); if (seen.has(file)) continue; if (!file.startsWith(TARGET + path.sep) || !fs.existsSync(file)) { unresolved.push(path.relative(TARGET, file).replace(/\\/g, "/")); continue; } seen.add(file); const text = fs.readFileSync(file, "utf8"); for (const m of text.matchAll(/import\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']\s*;/g)) { const spec = m[1]; let resolved; if (spec.startsWith(".")) resolved = path.resolve(path.dirname(file), spec); else { const remap = remappings.find((x) => spec.startsWith(x.prefix)); resolved = remap ? path.resolve(TARGET, remap.replacement, spec.slice(remap.prefix.length)) : path.resolve(TARGET, spec); } if (fs.existsSync(resolved)) queue.push(resolved); else unresolved.push(`${path.relative(TARGET, file).replace(/\\/g, "/")} -> ${spec}`); } }
  const files = [...seen].map((x) => `targets/cash-v3/${path.relative(TARGET, x).replace(/\\/g, "/")}`).sort().map((rel) => { const record = hashFile(rel); const compilerInputTextSha256 = sha(fs.readFileSync(abs(rel), "utf8").replace(/\r\n/g, "\n")); return { ...record, compilerInputTextSha256 }; }); const missing = [...new Set(unresolved)].sort();
  return { method: "deterministic-recursive-solidity-import-resolution-with-remappings", seeds, complete: missing.length === 0, unresolved: missing, files, aggregateSha256: sha(files.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")), compilerInputTextAggregateSha256: sha(files.map((x) => `${x.path}\0${x.compilerInputTextSha256}`).join("\n")) };
}

function linkClosureToBuildInput(closure, buildInfo) {
  const inputSources = buildInfo?.input?.sources || {}; const prefix = "targets/cash-v3/";
  const rows = closure.files.map((file) => {
    const buildInputPath = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path;
    const content = inputSources[buildInputPath]?.content;
    const buildInputSha256 = typeof content === "string" ? sha(content) : null;
    return { closurePath: file.path, buildInputPath, closureRawFileSha256: file.sha256, closureCompilerInputTextSha256: file.compilerInputTextSha256, buildInputSha256, present: typeof content === "string", contentHashMatch: buildInputSha256 === file.compilerInputTextSha256 };
  });
  const closureInputPaths = new Set(rows.map((x) => x.buildInputPath));
  const additionalBuildInputSourceCount = Object.keys(inputSources).filter((x) => !closureInputPaths.has(x)).length;
  return {
    scopedClosureFileCount: rows.length, standardJsonBuildInputSourceCount: Object.keys(inputSources).length, matchedClosureFileCount: rows.filter((x) => x.present && x.contentHashMatch).length,
    allClosureFilesPresentWithMatchingHash: rows.every((x) => x.present && x.contentHashMatch), additionalBuildInputSourceCount,
    explanation: "The 80-file set is the recursive import closure of the bounded Step 1 seeds, not the full Foundry build input. Forge compiles the whole configured project, including unrelated contracts, tests, scripts, and their dependencies, so the standard-json input is broader. Raw file hashes remain manifest-bound; compiler-input text hashes normalize CRLF to LF to match Foundry's standard-json source content.",
    rows,
  };
}

function runBuild() {
  const tempRoot = path.join(os.tmpdir(), "opencode", "etherfi-pinbound-build-binding"); const outDir = path.join(tempRoot, "out"); const cacheDir = path.join(tempRoot, "cache"); const infoDir = path.join(tempRoot, "build-info");
  fs.rmSync(tempRoot, { recursive: true, force: true }); fs.mkdirSync(tempRoot, { recursive: true });
  const run = spawnSync("forge", ["build", "--root", TARGET, "--out", outDir, "--cache-path", cacheDir, "--build-info", "--build-info-path", infoDir, "--no-cache", "--offline"], { cwd: ROOT, encoding: "utf8", timeout: BUILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  const output = `${run.stdout || ""}\n${run.stderr || ""}`; const infoFiles = walkFiles(infoDir, (x) => x.endsWith(".json"));
  let buildInfo = null; if (infoFiles.length === 1) buildInfo = JSON.parse(fs.readFileSync(infoFiles[0], "utf8"));
  const artifacts = {};
  const specs = [...COMPONENTS, { name: "UUPSProxy", artifactDir: "UUPSProxy.sol", artifact: "UUPSProxy.json" }, { name: "CashModuleSetters", artifactDir: "CashModuleSetters.sol", artifact: "CashModuleSetters.json" }];
  for (const spec of specs) { const file = path.join(outDir, spec.artifactDir, spec.artifact); artifacts[spec.name] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null; }
  const input = buildInfo?.input || null; const sourceRows = input ? Object.entries(input.sources || {}).map(([sourcePath, item]) => ({ sourcePath, bytes: Buffer.byteLength(item.content || ""), sha256: sha(item.content || "") })).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)) : [];
  const result = {
    attempted: true, exitStatus: run.status, timedOut: Boolean(run.error?.code === "ETIMEDOUT"), outputBytes: Buffer.byteLength(output), outputSha256: sha(output), sanitizedFailure: run.status === 0 ? null : safeMessage(run.error?.message || "forge build failed"),
    compiler: buildInfo ? { version: buildInfo.solcVersion, longVersion: buildInfo.solcLongVersion } : null,
    settings: input?.settings || null, settingsSha256: input ? sha(canonical(input.settings || {})) : null, standardJsonInputSha256: input ? sha(canonical(input)) : null,
    sourceCount: sourceRows.length, sourceSetAggregateSha256: sha(sourceRows.map((x) => `${x.sourcePath}\0${x.bytes}\0${x.sha256}`).join("\n")), buildInfoOutputSha256: buildInfo ? sha(canonical(buildInfo.output || {})) : null,
    expectedSettings: { compiler: "0.8.28", optimizerEnabled: true, optimizerRuns: 0, viaIR: false, evmVersion: "cancun", metadataBytecodeHash: "none" },
    artifactAvailability: Object.fromEntries(Object.entries(artifacts).map(([name, artifact]) => [name, Boolean(artifact)])),
  };
  return { result, artifacts, buildInfo, tempRoot };
}

async function proxyBinding(reader, spec, blockTag) {
  const [code, implWord, adminWord, beaconWord, latestImpl] = await Promise.all([
    reader.read("eth_getCode", [spec.proxy, blockTag], `${spec.name}.proxyRuntime`), reader.read("eth_getStorageAt", [spec.proxy, IMPL_SLOT, blockTag], `${spec.name}.implementationSlot`),
    reader.read("eth_getStorageAt", [spec.proxy, ADMIN_SLOT, blockTag], `${spec.name}.adminSlot`), reader.read("eth_getStorageAt", [spec.proxy, BEACON_SLOT, blockTag], `${spec.name}.beaconSlot`),
    reader.read("eth_getStorageAt", [spec.proxy, IMPL_SLOT, "latest"], `${spec.name}.latestImplementationSlot`, "latest-diagnostic"),
  ]);
  const implementation = implWord.ok ? slotAddress(implWord.result) : null; const implementationCode = implementation ? await reader.read("eth_getCode", [implementation, blockTag], `${spec.name}.implementationRuntime`) : null;
  const latestImplementation = latestImpl.ok ? slotAddress(latestImpl.result) : null;
  const implementationSameAtLatest = implementation && latestImplementation ? latestImplementation.toLowerCase() === implementation.toLowerCase() : null;
  return { name: spec.name, proxy: getAddress(spec.proxy), proxyRuntime: code.ok ? runtimeInfo(code.result) : null, proxyCode: code.ok ? code.result : null, implementation, implementationRuntime: implementationCode?.ok ? runtimeInfo(implementationCode.result) : null, implementationCode: implementationCode?.ok ? implementationCode.result : null, eip1967Admin: adminWord.ok ? slotAddress(adminWord.result) : null, eip1967Beacon: beaconWord.ok ? slotAddress(beaconWord.result) : null, latestImplementation, implementationSameAtLatest };
}

function unavailableBinding(spec) {
  return { name: spec.name, proxy: getAddress(spec.proxy), proxyRuntime: null, proxyCode: null, implementation: null, implementationRuntime: null, implementationCode: null, eip1967Admin: null, eip1967Beacon: null, latestImplementation: null, implementationSameAtLatest: null };
}

function loadPredecessorSummaries() {
  const currentRawText = fs.readFileSync(abs(RAW), "utf8"); const currentRaw = JSON.parse(currentRawText);
  if (currentRaw.revision === REVISION && currentRaw.r1Predecessor && currentRaw.r2Predecessor) return { r1Predecessor: currentRaw.r1Predecessor, r2Predecessor: currentRaw.r2Predecessor };
  if (currentRaw.revision !== "pinbound-build-binding-step1-r2") throw new Error("r2 predecessor package unavailable");
  const manifestText = fs.readFileSync(abs(MANIFEST), "utf8"); const manifest = JSON.parse(manifestText);
  const reportText = fs.readFileSync(abs(REPORT), "utf8"); const inboxText = fs.readFileSync(abs(INBOX), "utf8"); const handoffText = fs.readFileSync(abs(HANDOFF), "utf8");
  const r1Predecessor = {
    ...currentRaw.r1Predecessor,
    preservationMode: "summary-provenance-and-package-hashes-only", originalFilesManifestBoundInR3: false,
    disposition: "The r1 originals were overwritten before r3; r3 preserves only the r1 summary/provenance and previously computed package hashes. Those original files are not manifest-bound by r3.",
  };
  const r2Predecessor = {
    revision: currentRaw.revision, runId: currentRaw.runId, classification: currentRaw.classification, generatedAt: currentRaw.generatedAt,
    captureProvenance: currentRaw.captureProvenance, publicationProvenance: currentRaw.publicationProvenance,
    step2SafeToBegin: currentRaw.step2SafeToBegin, routePositive: currentRaw.routePositive, executableNow: currentRaw.executableNow, signedActionJustified: currentRaw.signedActionJustified, fork: currentRaw.fork,
    preservationMode: "summary-provenance-and-package-hashes-only", originalFilesManifestBoundInR3: false,
    disposition: "The r2 originals are superseded by r3 at the same paths; r3 preserves only their summary/provenance and package hashes. Those original files are not manifest-bound by r3.",
    packageHashes: { rawSha256: sha(currentRawText), manifestSha256: sha(manifestText), reportSha256: sha(reportText), inboxSha256: sha(inboxText), handoffSha256: sha(handoffText), manifestAggregateSha256: manifest.aggregateSha256 },
  };
  return { r1Predecessor, r2Predecessor };
}

async function main() {
  const captureTimestamp = new Date().toISOString(); const scannerSha256 = hashFile(SCANNER).sha256;
  const { r1Predecessor, r2Predecessor } = loadPredecessorSummaries();
  const predecessor = JSON.parse(fs.readFileSync(abs(PREDECESSOR), "utf8"));
  if (predecessor.pin.blockNumber !== PIN.blockNumber || predecessor.pin.blockHash.toLowerCase() !== PIN.blockHash.toLowerCase() || predecessor.source.commit !== SOURCE_COMMIT) throw new Error("predecessor identity mismatch");
  const selection = await selectProvider();
  const reader = new RpcReader(selection); const blockTag = toQuantity(PIN.blockNumber);
  let chainR = null; let blockR = null; let pin = { ...PIN, timestamp: null, chainIdVerified: false, exactNumberHashVerified: false, terminalSameNumberHashVerified: false };
  const bindings = [];
  if (selection.url) {
    chainR = await reader.read("eth_chainId", [], "pin.chainId"); blockR = await reader.read("eth_getBlockByNumber", [blockTag, false], "pin.exactBlock");
    pin = { ...PIN, timestamp: blockR?.ok && blockR.result?.timestamp ? Number(BigInt(blockR.result.timestamp)) : null, chainIdVerified: Boolean(chainR?.ok && Number(BigInt(chainR.result)) === PIN.chainId), exactNumberHashVerified: Boolean(blockR?.ok && blockR.result?.hash?.toLowerCase() === PIN.blockHash.toLowerCase()), terminalSameNumberHashVerified: null };
    for (const spec of COMPONENTS) bindings.push(await proxyBinding(reader, spec, blockTag));
  } else for (const spec of COMPONENTS) bindings.push(unavailableBinding(spec));

  const roleRegistries = {}; for (const spec of COMPONENTS) roleRegistries[spec.name] = selection.url ? await reader.call(spec.proxy, COMMON_I, "roleRegistry", [], blockTag, `${spec.name}.roleRegistry`) : null;
  const immutableGetters = selection.url ? {
    EtherFiHook: { dataProvider: await reader.call(ADDR.EtherFiHook, HOOK_I, "dataProvider", [], blockTag, "hook.dataProvider") },
    CashModuleCore: { etherFiDataProvider: await reader.call(ADDR.CashModuleCore, DATA_PROVIDER_GETTER_I, "etherFiDataProvider", [], blockTag, "cash.etherFiDataProvider") },
    DebtManagerCore: { etherFiDataProvider: await reader.call(ADDR.DebtManagerCore, DATA_PROVIDER_GETTER_I, "etherFiDataProvider", [], blockTag, "debt.etherFiDataProvider") },
    LiquidUSDLiquifierModule: { cashModule: await reader.call(ADDR.LiquidUSDLiquifierModule, LIQUIFIER_I, "cashModule", [], blockTag, "liquifier.cashModule"), debtManager: await reader.call(ADDR.LiquidUSDLiquifierModule, LIQUIFIER_I, "debtManager", [], blockTag, "liquifier.debtManager"), etherFiDataProvider: await reader.call(ADDR.LiquidUSDLiquifierModule, LIQUIFIER_I, "etherFiDataProvider", [], blockTag, "liquifier.dataProvider") },
  } : { EtherFiHook: { dataProvider: null }, CashModuleCore: { etherFiDataProvider: null }, DebtManagerCore: { etherFiDataProvider: null }, LiquidUSDLiquifierModule: { cashModule: null, debtManager: null, etherFiDataProvider: null } };

  const build = runBuild(); const immutableNames = build.buildInfo ? collectAstImmutableNames(build.buildInfo) : new Map();
  const proxyArtifact = build.artifacts.UUPSProxy;
  const getterBinding = (value, observedGetterValue, evidence) => ({ value, source: "getter", evidence, observedGetterValue, independentlyBound: addressEqual(value, observedGetterValue) });
  const independentBindings = {
    EtherFiDataProvider: {}, EtherFiSafeFactory: {},
    EtherFiHook: { dataProvider: getterBinding(ADDR.EtherFiDataProvider, immutableGetters.EtherFiHook.dataProvider, "EtherFiHook.dataProvider() at fixed pin") },
    CashModuleCore: { etherFiDataProvider: getterBinding(ADDR.EtherFiDataProvider, immutableGetters.CashModuleCore.etherFiDataProvider, "CashModuleCore.etherFiDataProvider() at fixed pin") },
    DebtManagerCore: { etherFiDataProvider: getterBinding(ADDR.EtherFiDataProvider, immutableGetters.DebtManagerCore.etherFiDataProvider, "DebtManagerCore.etherFiDataProvider() at fixed pin") },
    LiquidUSDLiquifierModule: {
      cashModule: getterBinding(ADDR.CashModuleCore, immutableGetters.LiquidUSDLiquifierModule.cashModule, "LiquidUSDLiquifierModule.cashModule() at fixed pin"),
      debtManager: getterBinding(ADDR.DebtManagerCore, immutableGetters.LiquidUSDLiquifierModule.debtManager, "LiquidUSDLiquifierModule.debtManager() at fixed pin"),
      etherFiDataProvider: getterBinding(ADDR.EtherFiDataProvider, immutableGetters.LiquidUSDLiquifierModule.etherFiDataProvider, "LiquidUSDLiquifierModule.etherFiDataProvider() at fixed pin"),
    },
  };
  const componentResults = [];
  for (const spec of COMPONENTS) {
    const binding = bindings.find((x) => x.name === spec.name); const artifact = build.artifacts[spec.name];
    const expected = independentBindings[spec.name] || {};
    const buildComparison = artifact && binding?.implementationCode ? compareArtifactRuntime(artifact, binding.implementationCode, expected, binding.implementation, immutableNames) : { buildArtifactAvailable: false, exactRuntimeEqual: null };
    const proxyComparison = proxyArtifact && binding?.proxyCode ? compareArtifactRuntime(proxyArtifact, binding.proxyCode, {}, binding.proxy, immutableNames) : { buildArtifactAvailable: false, exactRuntimeEqual: null };
    componentResults.push({ name: spec.name, proxy: binding.proxy, proxyRuntime: binding.proxyRuntime, implementation: binding.implementation, implementationRuntime: binding.implementationRuntime, eip1967Admin: binding.eip1967Admin, eip1967Beacon: binding.eip1967Beacon, implementationSameAtLatest: binding.implementationSameAtLatest, proxyComparison, implementationComparison: buildComparison, fixedExpectedAddresses: spec.constructorBindings, independentImmutableBindings: expected });
  }
  const publicSourceRows = componentResults.map((x) => ({ name: x.name, address: x.implementation, available: null, provenanceLabel: "not-queried", reason: "No compliant source-service input was authorized for this bounded run; local pinned source and compiler evidence are evaluated independently." }));

  let terminalR = null;
  if (selection.url) for (let attempt = 1; attempt <= 3; attempt++) { terminalR = await reader.read("eth_getBlockByNumber", [blockTag, false], `pin.terminalSameNumber.attempt${attempt}`); if (terminalR?.ok && terminalR.result?.hash?.toLowerCase() === PIN.blockHash.toLowerCase()) break; }
  pin.terminalSameNumberHashVerified = Boolean(terminalR?.ok && terminalR.result?.hash?.toLowerCase() === PIN.blockHash.toLowerCase());
  const seedSources = ["src/data-provider/EtherFiDataProvider.sol", "src/safe/EtherFiSafeFactory.sol", "src/hook/EtherFiHook.sol", "src/modules/cash/CashModuleCore.sol", "src/modules/cash/CashModuleSetters.sol", "src/debt-manager/DebtManagerCore.sol", "src/modules/etherfi/LiquidUSDLiquifierOP.sol", "src/UUPSProxy.sol"];
  const closure = sourceClosure(seedSources);
  const closureBuildLinkage = linkClosureToBuildInput(closure, build.buildInfo);
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: TARGET, encoding: "utf8", timeout: 15_000 }); const commit = git.status === 0 ? git.stdout.trim() : null;
  const immutableGetterChecks = {
    hookDataProvider: addressEqual(immutableGetters.EtherFiHook.dataProvider, ADDR.EtherFiDataProvider),
    cashDataProvider: addressEqual(immutableGetters.CashModuleCore.etherFiDataProvider, ADDR.EtherFiDataProvider),
    debtDataProvider: addressEqual(immutableGetters.DebtManagerCore.etherFiDataProvider, ADDR.EtherFiDataProvider),
    liquifierCashModule: addressEqual(immutableGetters.LiquidUSDLiquifierModule.cashModule, ADDR.CashModuleCore),
    liquifierDebtManager: addressEqual(immutableGetters.LiquidUSDLiquifierModule.debtManager, ADDR.DebtManagerCore),
    liquifierDataProvider: addressEqual(immutableGetters.LiquidUSDLiquifierModule.etherFiDataProvider, ADDR.EtherFiDataProvider),
  };
  const immutableGetterBindingsExact = Object.values(immutableGetterChecks).every(Boolean);
  const immutableProvenanceRows = componentResults.flatMap((component) => (component.implementationComparison.immutableRows || []).map((row) => ({ component: component.name, astId: row.astId, declarationName: row.declarationName, sourcePath: row.sourcePath, expectedValueSource: row.expectedValueSource, expectedValueEvidence: row.expectedValueEvidence, independentlyBound: row.independentlyBound, actualMatchesExpected: row.actualMatchesExpected, placementCount: row.positions.length })));
  const immutableProvenanceCoverage = {
    astImmutableRowCount: immutableProvenanceRows.length,
    independentlyBoundRowCount: immutableProvenanceRows.filter((x) => x.independentlyBound).length,
    actualValueMatchedRowCount: immutableProvenanceRows.filter((x) => x.actualMatchesExpected).length,
    allRowsIndependentlyBound: immutableProvenanceRows.length > 0 && immutableProvenanceRows.every((x) => x.independentlyBound),
    allRowsActualValuesMatch: immutableProvenanceRows.length > 0 && immutableProvenanceRows.every((x) => x.actualMatchesExpected),
    sourceCounts: immutableProvenanceRows.reduce((out, row) => { out[row.expectedValueSource || "unbound"] = (out[row.expectedValueSource || "unbound"] || 0) + 1; return out; }, {}),
    rows: immutableProvenanceRows,
  };
  const primaryExact = componentResults.every((x) => x.proxyComparison.exactRuntimeEqual === true && x.implementationComparison.exactReconstructedEqual === true);
  const anyPartial = componentResults.some((x) => x.implementationComparison.immutableMaskedEqual === true || x.implementationComparison.metadataStrippedEqual === true);
  const pinComplete = pin.chainIdVerified && pin.exactNumberHashVerified && pin.terminalSameNumberHashVerified;
  const sourceCommitMatch = commit === SOURCE_COMMIT;
  const classification = pinComplete && sourceCommitMatch && build.result.exitStatus === 0 && closure.complete && closureBuildLinkage.allClosureFilesPresentWithMatchingHash && primaryExact && immutableGetterBindingsExact && immutableProvenanceCoverage.allRowsIndependentlyBound && immutableProvenanceCoverage.allRowsActualValuesMatch ? "exact" : (pinComplete && sourceCommitMatch && build.result.exitStatus === 0 && anyPartial ? "partial" : "access-blocked");
  const step2SafeToBegin = classification === "exact";
  const pinDriftRows = componentResults.filter((x) => x.implementationSameAtLatest === false).map((x) => x.name);
  const pinDriftUnresolvedRows = componentResults.filter((x) => x.implementationSameAtLatest == null).map((x) => x.name);
  const runtimeAccessBlockedRows = componentResults.filter((x) => !x.proxyRuntime || !x.implementation || !x.implementationRuntime).map((x) => x.name);
  const rootCause = classification === "exact" && pinDriftRows.length === 0
    ? "Prior mismatch was caused by immutable-address comparison in the repository verifier: locally deployed UUPS implementations embed a different OpenZeppelin __self address, and constructor immutables likewise differ. The verifier compared full/metadata-trimmed runtime without immutable reconstruction. Proxy-vs-implementation confusion, build-setting drift, source drift, and pin drift are not observed for this bounded scope."
    : runtimeAccessBlockedRows.length > 0
      ? `Fixed-pin block identity was verified, but historical runtime/storage reads were access-blocked for ${runtimeAccessBlockedRows.length}/${componentResults.length} scoped components; no source/runtime equivalence or prior-mismatch root cause is claimed.`
      : "Prior mismatch root cause remains partially unresolved; see per-component exact, masked, metadata, immutable, and latest-drift rows.";
  const runId = `etherfi-pinbound-binding-${PIN.blockNumber}-${PIN.blockHash.slice(2, 14)}-${scannerSha256.slice(0, 12)}`;
  const captureProvenance = { runId, revision: REVISION, scannerSha256, capturedAt: captureTimestamp, pin, predecessorRunId: r2Predecessor.runId, predecessorRawSha256: r2Predecessor.packageHashes.rawSha256, capabilityPredecessorRunId: predecessor.runId, capabilityPredecessorCaptureScannerSha256: predecessor.captureProvenance?.captureScannerSha256 || null, r1PredecessorRunId: r1Predecessor.runId, r1PredecessorRawSha256: r1Predecessor.packageHashes.rawSha256 };
  const publicationProvenance = { currentPublicationScannerSha256: scannerSha256, mode: "r3-reviewer-corrected-network-capture-and-initial-publication", byteIdenticalPublicationClaimed: false, capturePublicationScannerIdentical: true, statement: "This exact scanner generated the r3 network capture and initial publication. The manifest-bound reproduction artifact supports deterministic offline bytecode recomputation; timestamped publication bytes are not claimed identical across reruns." };
  const reproduction = {
    schemaVersion: 1, revision: REVISION, runId, purpose: "Manifest-bound offline reconstruction evidence; contains public fixed-pin bytecode and independently bound immutable values only.",
    pin, sourceCommit: commit,
    buildInputLinkage: { compiler: build.result.compiler, standardJsonInputSha256: build.result.standardJsonInputSha256, settingsSha256: build.result.settingsSha256, sourceSetAggregateSha256: build.result.sourceSetAggregateSha256, standardJsonBuildInputSourceCount: build.result.sourceCount, scopedClosureAggregateSha256: closure.aggregateSha256, closureBuildLinkage },
    proxyArtifact: { artifactDir: "UUPSProxy.sol", artifact: "UUPSProxy.json" },
    components: COMPONENTS.map((spec) => {
      const binding = bindings.find((x) => x.name === spec.name); const resultRow = componentResults.find((x) => x.name === spec.name);
      return {
        name: spec.name, proxy: binding.proxy, implementation: binding.implementation,
        implementationArtifact: { artifactDir: spec.artifactDir, artifact: spec.artifact },
        proxyRuntime: binding.proxyCode, implementationRuntime: binding.implementationCode,
        immutableRows: (resultRow.implementationComparison.immutableRows || []).map((row) => ({ astId: row.astId, declarationName: row.declarationName, sourcePath: row.sourcePath, positions: row.positions, expectedValue: row.expectedValue, expectedValueSource: row.expectedValueSource, expectedValueEvidence: row.expectedValueEvidence, independentlyBound: row.independentlyBound, observedGetterValue: row.observedGetterValue, actualMatchesExpected: row.actualMatchesExpected })),
      };
    }),
    expectedOutcome: { componentCount: COMPONENTS.length, proxyExactCount: componentResults.filter((x) => x.proxyComparison.exactRuntimeEqual).length, implementationExactReconstructionCount: componentResults.filter((x) => x.implementationComparison.exactReconstructedEqual).length, allImmutableRowsIndependentlyBound: immutableProvenanceCoverage.allRowsIndependentlyBound, closureLinkedToBuildInput: closureBuildLinkage.allClosureFilesPresentWithMatchingHash },
    safety: { liveEndpointDataIncluded: false, secretsIncluded: false, privateDataIncluded: false, publicFixedPinRuntimeBytesIncluded: true },
  };
  const reproductionText = JSON.stringify(reproduction, null, 2) + "\n";
  const reproductionRecord = { path: REPRO, bytes: Buffer.byteLength(reproductionText), sha256: sha(reproductionText) };
  const blockers = classification === "exact" ? ["No exploit or route evidence was evaluated; this subbranch establishes build/runtime binding only.", "Public verified-source coverage may be incomplete even where deterministic local source reconstruction is exact."] : runtimeAccessBlockedRows.length > 0 ? ["The selected inventory provider did not complete all fixed-pin runtime/storage reads; affected components remain unbound.", "Step 2 must not begin until fixed-pin runtime access and exact reconstruction are established."] : ["At least one scoped component lacks exact reconstructed runtime equality or independent provenance/linkage.", "Step 2 must not begin until unresolved component/build/provenance/access rows are closed."];
  const nextAction = step2SafeToBegin ? "Submit the reviewer-corrected r3 package for independent promotion; do not start Step 2 in this run." : runtimeAccessBlockedRows.length > 0 ? "Rerun Step 1 with an authorized read-only Optimism provider that serves historical code and storage at the exact pin; then rerun the offline reproduction suite." : "Resolve the first non-exact binding/provenance/linkage row and rerun the network capture plus offline reproduction suite.";
  const result = {
    schemaVersion: 1, revision: REVISION, runId, generatedAt: captureTimestamp, scanner: SCANNER, agentId: AGENT, role: "critical-research", step: 1,
    scope: "Fixed-pin source/build/runtime equivalence for EtherFiDataProvider, EtherFiSafeFactory, EtherFiHook, CashModuleCore, DebtManagerCore, and LiquidUSDLiquifierModule; CashModuleSetters is source-closure-only",
    classification, signal: classification === "exact" ? "⚪ CLEAN — EXACT BINDING" : classification === "partial" ? "🟠 WATCH — PARTIAL BINDING" : "🟠 WATCH — ACCESS BLOCKED",
    routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, step2SafeToBegin,
    safety: { readOnlyRpc: true, endpointInventoryRead: true, endpointValuesPersisted: false, graphqlInventoryRead: false, publicSourceServiceQueried: false, envFilesRead: false, privateKeysRead: false, walletsUsed: false, signedActions: false, broadcasts: false, productionMutation: false, pendingWithdrawalsInspected: false, exploitFork: false, buildTempRetained: false },
    captureProvenance, publicationProvenance,
    predecessor: { path: PREDECESSOR, runId: predecessor.runId, pin: predecessor.pin, sourceCommit: predecessor.source.commit, rawSha256: hashFile(PREDECESSOR).sha256 },
    r1Predecessor, r2Predecessor,
    budgets: { providerSelection: { inventoryCandidateCount: selection.inventoryCount, inventoryLoadSucceeded: selection.inventoryLoadSucceeded, maxEndpoints: MAX_PROVIDER_ENDPOINTS, maxCalls: MAX_PROVIDER_CALLS, endpointsTried: selection.endpointsTried, calls: selection.calls, timeoutMs: PROVIDER_TIMEOUT_MS, selectedFromInventory: selection.selectedFromInventory, fallbackUsed: selection.fallbackUsed, selectedOrdinal: selection.selectedOrdinal, rejectionCounts: selection.rejectionCounts, acceptance: selection.acceptance }, rpc: { maxReads: MAX_RPC_READS, readsUsed: reader.count, timeoutMs: RPC_TIMEOUT_MS }, publicSource: { maxRequests: 0, requestsUsed: 0, timeoutMs: null }, build: { timeoutMs: BUILD_TIMEOUT_MS } },
    pin, source: { commit, expectedCommit: SOURCE_COMMIT, commitMatch: commit === SOURCE_COMMIT, scopedRecursiveClosure: closure, closureBuildLinkage }, build: build.result,
    componentResults,
    dependencies: { roleRegistries, immutableGetters, immutableGetterChecks, immutableGetterBindingsExact, immutableProvenanceCoverage, cashModuleSettersIncludedAsSourceClosureOnly: true },
    offlineReproduction: reproductionRecord,
    publicVerifiedSource: { rows: publicSourceRows, transcript: [], caveat: "No public source service was queried. Local pinned source, build-info, and fixed-pin runtime evidence are retained without any request location." },
    diagnosis: { priorVerifierPinBound: false, fixedPinImplementationsSameAtLatest: pinDriftUnresolvedRows.length > 0 ? null : pinDriftRows.length === 0, pinDriftRows, pinDriftUnresolvedRows, runtimeAccessBlockedRows, proxyVsImplementationConfusionObserved: primaryExact ? false : null, buildSettingsDriftObserved: primaryExact ? false : null, sourceDriftObserved: primaryExact ? false : null, immutableMismatchObserved: componentResults.some((x) => x.implementationComparison.immutableReferenceCount > 0), immutableProvenanceComplete: immutableProvenanceCoverage.allRowsIndependentlyBound && immutableProvenanceCoverage.allRowsActualValuesMatch, closureBuildLinkageComplete: closureBuildLinkage.allClosureFilesPresentWithMatchingHash, rootCause },
    blockers, nextAction, transcript: reader.transcript,
  };
  fs.rmSync(build.tempRoot, { recursive: true, force: true });
  writeOwned(REPRO, reproductionText);
  writeOwned(RAW, JSON.stringify(result, jsonReplacer, 2) + "\n");
  const rowsMd = componentResults.map((x) => `| ${x.name} | ${x.proxyComparison.exactRuntimeEqual ?? null} | ${x.implementationComparison.exactRuntimeEqual ?? null} | ${x.implementationComparison.immutableMaskedEqual ?? null} | ${x.implementationComparison.exactReconstructedEqual ?? null} | ${x.implementationSameAtLatest ?? null} |`).join("\n");
  const impactText = step2SafeToBegin ? "Source/build/runtime equivalence is established for the bounded six-component scope. This does not establish an exploit or authorize Step 2 execution in this run." : "Source/runtime equivalence and the prior mismatch diagnosis remain unproven; Step 2 is not authorized by this evidence. No asset loss or permissionless route is claimed.";
  const report = `# ${result.signal} — EtherFi pin-bound build binding Step 1 r2\n\n**Classification:** \`${classification}\`  \n**Run:** \`${runId}\`  \n**Pin:** Optimism \`${PIN.blockNumber}\` / \`${PIN.blockHash}\`; terminal recheck \`${pin.terminalSameNumberHashVerified}\`  \n**Gates:** \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`, \`fork=false\`  \n**Step 2 safe to begin after separate review/claim:** \`${step2SafeToBegin}\`\n\n## Result\n\n${rootCause}\n\n| Component | Proxy exact | Impl template exact | Immutable-masked | Exact reconstructed | Same impl at latest |\n|---|---:|---:|---:|---:|---:|\n${rowsMd}\n\nNormalized or metadata-stripped similarity is never treated as exact. Exact classification requires byte-identical proxy runtime plus byte-identical implementation runtime reconstructed from the compiler template using independently bound immutable values.\n\n## Archive-provider coverage\n\n- Endpoint inventory loaded: \`${selection.inventoryLoadSucceeded}\`; inventory count \`${selection.inventoryCount}\`; bounded candidates \`${MAX_PROVIDER_ENDPOINTS}\`.\n- Endpoints tried: \`${selection.endpointsTried}\`; calls \`${selection.calls}/${MAX_PROVIDER_CALLS}\`; selected ordinal \`${selection.selectedOrdinal}\`.\n- Acceptance checks: \`${canonical(selection.acceptance)}\`.\n- Rejection counts: \`${canonical(selection.rejectionCounts)}\`.\n- No endpoint value, domain, key, header, origin, or inventory content is retained.\n\n## Preconditions and impact\n\n- Precondition: an exact-pin provider must serve chain identity, the exact block/hash, representative historical code/storage, and all six scoped bindings.\n- Impact: ${impactText}\n\n## Evidence and defensive test\n\n- Source commit: \`${commit}\`; closure complete \`${closure.complete}\` across ${closure.files.length} files.\n- Compiler: \`${build.result.compiler?.longVersion || "unknown"}\`; standard-json input SHA-256 \`${build.result.standardJsonInputSha256}\`; settings SHA-256 \`${build.result.settingsSha256}\`.\n- Capture scanner SHA-256: \`${scannerSha256}\`; capture/publication scanner identity \`true\`.\n- Public-source requests: 0; no source-service request location was used or retained.\n- RPC reads: ${reader.count}/${MAX_RPC_READS}; provider selection calls ${selection.calls}/${MAX_PROVIDER_CALLS}.\n- Offline validation: \`node tools/test-critical-etherfi-pinbound-build-binding.js\`.\n\n## Preserved r1 predecessor\n\n- r1 run \`${r1Predecessor.runId}\`, classification \`${r1Predecessor.classification}\`, raw SHA-256 \`${r1Predecessor.packageHashes.rawSha256}\`, manifest aggregate \`${r1Predecessor.packageHashes.manifestAggregateSha256}\`.\n- r1 is preserved as predecessor provenance and is superseded only as the current Step 1 conclusion.\n\n## Blockers and mitigation\n\n${blockers.map((x) => `- ${x}`).join("\n")}\n\n## nextReadOnlyStep\n\n${nextAction}\n`;
  const reviewerReport = [
    `# ${result.signal} — EtherFi pin-bound build binding Step 1 r3 reviewer-corrected`,
    "", `**Classification:** \`${classification}\`  `, `**Revision:** \`${REVISION}\`  `, `**Run:** \`${runId}\`  `,
    `**Pin:** Optimism \`${PIN.blockNumber}\` / \`${PIN.blockHash}\`; terminal recheck \`${pin.terminalSameNumberHashVerified}\`  `,
    "**Gates:** `routePositive=0`, `executableNow=0`, `signedActionJustified=false`, `fork=false`  ",
    `**Step 2 safe after r3 promotion:** \`${step2SafeToBegin}\`; Step 2 was not started.`,
    "", "## Result", "", rootCause, "",
    "| Component | Proxy exact | Impl template exact | Immutable-masked | Exact reconstructed | Same impl at latest |",
    "|---|---:|---:|---:|---:|---:|", rowsMd, "",
    "Exact requires byte-identical proxy runtime and byte-identical implementation runtime after reconstructing every compiler-declared immutable from an independent source. Normalized or metadata-stripped similarity alone is never exact.",
    "", "## Independent getter and immutable provenance", "",
    `- Getter checks: \`${canonical(immutableGetterChecks)}\`; all passed \`${immutableGetterBindingsExact}\`.`,
    `- AST immutable rows: \`${immutableProvenanceCoverage.astImmutableRowCount}\`; independently bound \`${immutableProvenanceCoverage.independentlyBoundRowCount}\`; actual values matched \`${immutableProvenanceCoverage.actualValueMatchedRowCount}\`.`,
    `- Binding-source counts: \`${canonical(immutableProvenanceCoverage.sourceCounts)}\`.`,
    "- Every row records a fixed-pin getter source or the pin-bound EIP-1967 implementation address for OpenZeppelin `__self`.",
    "", "## Offline reproduction", "",
    `- Artifact: \`${REPRO}\`; bytes \`${reproductionRecord.bytes}\`; SHA-256 \`${reproductionRecord.sha256}\`.`,
    "- It retains fixed-pin proxy/implementation runtime bytes, implementation addresses, immutable ranges and independent values, artifact locators, and build-input linkage.",
    "- The offline test runs a fresh `forge build --offline`, reads all six implementation artifacts plus `UUPSProxy` and build-info, reconstructs every immutable placement, and compares resulting bytes to captured runtimes.",
    "", "## Scoped closure to full build input", "",
    `- Recursive scoped closure: \`${closure.files.length}\` files; standard-json build input: \`${build.result.sourceCount}\` sources.`,
    `- Matched closure rows: \`${closureBuildLinkage.matchedClosureFileCount}/${closureBuildLinkage.scopedClosureFileCount}\`; additional build-input sources: \`${closureBuildLinkage.additionalBuildInputSourceCount}\`.`,
    `- ${closureBuildLinkage.explanation}`,
    "", "## Archive-provider coverage", "",
    `- Inventory loaded \`${selection.inventoryLoadSucceeded}\`; count \`${selection.inventoryCount}\`; tried \`${selection.endpointsTried}/${MAX_PROVIDER_ENDPOINTS}\`; calls \`${selection.calls}/${MAX_PROVIDER_CALLS}\`; selected ordinal \`${selection.selectedOrdinal}\`.`,
    `- Acceptance: \`${canonical(selection.acceptance)}\`; rejection counts: \`${canonical(selection.rejectionCounts)}\`.`,
    "- No endpoint value, domain, key, header, origin, or raw inventory content is retained.",
    "", "## Provenance and predecessor wording", "",
    `- Capture scanner SHA-256: \`${scannerSha256}\`; capture/publication scanner identical \`true\`.`,
    `- r2 \`${r2Predecessor.runId}\` and r1 \`${r1Predecessor.runId}\` are preserved only as summary/provenance plus package hashes. Their overwritten original files are not manifest-bound by r3.`,
    `- r2 raw SHA-256 \`${r2Predecessor.packageHashes.rawSha256}\`; r1 raw SHA-256 \`${r1Predecessor.packageHashes.rawSha256}\`.`,
    "", "## Impact and blockers", "", `- ${impactText}`, ...blockers.map((x) => `- ${x}`),
    "", "## nextReadOnlyStep", "", nextAction, "",
  ].join("\n");
  writeOwned(REPORT, reviewerReport);
  const inbox = { findingId: "etherfi-pinbound-build-binding", revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: classification, classification, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, step2SafeToBegin, summary: rootCause, archiveProviderCoverage: { inventoryCount: selection.inventoryCount, endpointsTried: selection.endpointsTried, calls: selection.calls, selectedOrdinal: selection.selectedOrdinal, acceptance: selection.acceptance }, r1Predecessor: { runId: r1Predecessor.runId, classification: r1Predecessor.classification, rawSha256: r1Predecessor.packageHashes.rawSha256, manifestAggregateSha256: r1Predecessor.packageHashes.manifestAggregateSha256 }, artifacts: [RAW, MANIFEST, REPORT], nextAction, captureProvenance, publicationProvenance };
  const reviewerInbox = { findingId: "etherfi-pinbound-build-binding", revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: classification, classification, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, step2SafeToBegin, summary: rootCause, archiveProviderCoverage: { inventoryCount: selection.inventoryCount, endpointsTried: selection.endpointsTried, calls: selection.calls, selectedOrdinal: selection.selectedOrdinal, acceptance: selection.acceptance }, independentGetterChecks: immutableGetterChecks, immutableProvenanceCoverage: { astImmutableRowCount: immutableProvenanceCoverage.astImmutableRowCount, independentlyBoundRowCount: immutableProvenanceCoverage.independentlyBoundRowCount, sourceCounts: immutableProvenanceCoverage.sourceCounts }, closureBuildLinkage: { scopedClosureFileCount: closureBuildLinkage.scopedClosureFileCount, standardJsonBuildInputSourceCount: closureBuildLinkage.standardJsonBuildInputSourceCount, matchedClosureFileCount: closureBuildLinkage.matchedClosureFileCount, additionalBuildInputSourceCount: closureBuildLinkage.additionalBuildInputSourceCount }, offlineReproduction: reproductionRecord, r1Predecessor: { runId: r1Predecessor.runId, preservationMode: r1Predecessor.preservationMode, originalFilesManifestBoundInR3: false, rawSha256: r1Predecessor.packageHashes.rawSha256 }, r2Predecessor: { runId: r2Predecessor.runId, preservationMode: r2Predecessor.preservationMode, originalFilesManifestBoundInR3: false, rawSha256: r2Predecessor.packageHashes.rawSha256 }, artifacts: [RAW, MANIFEST, REPRO, REPORT], nextAction, captureProvenance, publicationProvenance };
  writeOwned(INBOX, JSON.stringify(reviewerInbox, null, 2) + "\n");
  writeOwned(HANDOFF, `# 2026-07-21 EtherFi pin-bound build binding r2 handoff\n\n- Run: \`${runId}\`; revision \`${REVISION}\`; classification \`${classification}\`.\n- Pin: Optimism \`${PIN.blockNumber}\` / \`${PIN.blockHash}\`; terminal recheck \`${pin.terminalSameNumberHashVerified}\`.\n- Capture scanner SHA-256: \`${scannerSha256}\`; capture/publication scanner identity is exact.\n- Archive provider: inventory count \`${selection.inventoryCount}\`, tried \`${selection.endpointsTried}\`, calls \`${selection.calls}/${MAX_PROVIDER_CALLS}\`, selected ordinal \`${selection.selectedOrdinal}\`; values/domains/headers not retained.\n- Components exact: ${componentResults.filter((x) => x.proxyComparison.exactRuntimeEqual && x.implementationComparison.exactReconstructedEqual).length}/${componentResults.length}. CashModuleSetters is included only in the source closure.\n- r1 predecessor preserved: \`${r1Predecessor.runId}\`; raw SHA-256 \`${r1Predecessor.packageHashes.rawSha256}\`; manifest aggregate \`${r1Predecessor.packageHashes.manifestAggregateSha256}\`.\n- Root cause: ${rootCause}\n- Gates: route/executable/signing/fork \`0/0/false/false\`.\n- Step 2 safe to begin after separate review/claim: \`${step2SafeToBegin}\`; Step 2 was not started.\n- Next: ${nextAction}\n`);
  const reviewerHandoff = [
    "# 2026-07-21 EtherFi pin-bound build binding r3 reviewer-corrected handoff", "",
    `- Run: \`${runId}\`; revision \`${REVISION}\`; classification \`${classification}\`.`,
    `- Pin: Optimism \`${PIN.blockNumber}\` / \`${PIN.blockHash}\`; terminal recheck \`${pin.terminalSameNumberHashVerified}\`.`,
    `- Capture scanner SHA-256: \`${scannerSha256}\`; capture/publication scanner identity is exact.`,
    `- Archive provider: inventory count \`${selection.inventoryCount}\`, tried \`${selection.endpointsTried}\`, calls \`${selection.calls}/${MAX_PROVIDER_CALLS}\`, selected ordinal \`${selection.selectedOrdinal}\`; values/domains/headers not retained.`,
    `- Components exact: ${componentResults.filter((x) => x.proxyComparison.exactRuntimeEqual && x.implementationComparison.exactReconstructedEqual).length}/${componentResults.length}.`,
    `- Independent getters: \`${canonical(immutableGetterChecks)}\`; immutable provenance \`${immutableProvenanceCoverage.independentlyBoundRowCount}/${immutableProvenanceCoverage.astImmutableRowCount}\` rows.`,
    `- Offline reproduction: \`${REPRO}\`, SHA-256 \`${reproductionRecord.sha256}\`; fresh offline rebuild/recomparison is enforced by the test.`,
    `- Closure/build linkage: \`${closureBuildLinkage.matchedClosureFileCount}/${closureBuildLinkage.scopedClosureFileCount}\` scoped files match within \`${closureBuildLinkage.standardJsonBuildInputSourceCount}\` build-input sources; the scoped closure is not the full build input.`,
    "- r1 and r2 are retained only as summary/provenance plus package hashes; their overwritten originals are not manifest-bound in r3.",
    `- Root cause: ${rootCause}`, "- Gates: route/executable/signing/fork `0/0/false/false`; Step 2 and pending-withdrawal inspection were not started.",
    `- Step 2 safe after r3 promotion: \`${step2SafeToBegin}\`.`, `- Next: ${nextAction}`, "",
  ].join("\n");
  writeOwned(HANDOFF, reviewerHandoff);
  const records = [...new Set([SCANNER, TEST, RAW, REPRO, REPORT, INBOX, HANDOFF, PREDECESSOR, "targets/cash-v3/foundry.toml", "targets/cash-v3/remappings.txt", ...closure.files.map((x) => x.path)])].map(hashFile);
  const aggregateSha256 = sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
  const manifest = { schemaVersion: 1, revision: REVISION, runId, generatedAt: captureTimestamp, algorithm: "sha256", captureProvenance, publicationProvenance, r1Predecessor, r2Predecessor, classification, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, step2SafeToBegin, sourceClosureComplete: closure.complete, closureBuildLinkageComplete: closureBuildLinkage.allClosureFilesPresentWithMatchingHash, immutableProvenanceComplete: immutableProvenanceCoverage.allRowsIndependentlyBound && immutableProvenanceCoverage.allRowsActualValuesMatch, offlineReproduction: reproductionRecord, records, aggregateSha256 };
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ runId, revision: REVISION, pin, classification, step2SafeToBegin, archiveProviderCoverage: { inventoryCount: selection.inventoryCount, endpointsTried: selection.endpointsTried, calls: selection.calls, selectedOrdinal: selection.selectedOrdinal, acceptance: selection.acceptance }, independentGetterChecks: immutableGetterChecks, immutableProvenanceCoverage: { astImmutableRowCount: immutableProvenanceCoverage.astImmutableRowCount, independentlyBoundRowCount: immutableProvenanceCoverage.independentlyBoundRowCount, sourceCounts: immutableProvenanceCoverage.sourceCounts }, closureBuildLinkage: { scopedClosureFileCount: closureBuildLinkage.scopedClosureFileCount, standardJsonBuildInputSourceCount: closureBuildLinkage.standardJsonBuildInputSourceCount, matchedClosureFileCount: closureBuildLinkage.matchedClosureFileCount, additionalBuildInputSourceCount: closureBuildLinkage.additionalBuildInputSourceCount }, offlineReproduction: reproductionRecord, componentExact: componentResults.map((x) => ({ name: x.name, proxyExact: x.proxyComparison.exactRuntimeEqual === true, implementationTemplateExact: x.implementationComparison.exactRuntimeEqual === true, immutableMaskedEqual: x.implementationComparison.immutableMaskedEqual === true, exactReconstructed: x.implementationComparison.exactReconstructedEqual === true })), rootCause, rpcReads: reader.count, sourceRequests: 0, manifestAggregateSha256: aggregateSha256 }) + "\n");
}

main().catch((e) => { process.stderr.write(`scan failed: ${safeMessage(e?.message || e)}\n`); process.exitCode = 1; });
