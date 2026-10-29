"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const ROOT = path.resolve(__dirname, "../..");
const TOOL_ROOT = path.join(ROOT, ".audit-tools/node");
const toolRequire = createRequire(path.join(TOOL_ROOT, "package.json"));
const PINS = Object.freeze([
  Object.freeze({ id: "proof-module", path: "tools/lib/base-paper-usdplus-r16-proof.js", bytes: 13575, sha256: "46f87d963b30869b62889136ba1b4529e84c840fbc202a6e632cb4e97a4c2dba", cap: 1024 * 1024, root: "workspace" }),
  Object.freeze({ id: "fixtures", path: "tools/fixtures/base-paper-usdplus-r16-proof-fixtures.json", bytes: 5430, sha256: "d28d7ec03e8178d487edc39ba9e2e158a3d79aeaa3523ca07cacdf53bf609641", cap: 2 * 1024 * 1024, root: "workspace" }),
  Object.freeze({ id: "manifest", path: "tools/manifests/base-paper-usdplus-r16-toolchain.json", bytes: 19241, sha256: "8ec40e65a917b7c45eb65026732a9cecad80d6b77a343de6b41c2d5101d38cba", cap: 2 * 1024 * 1024, root: "workspace" }),
  Object.freeze({ id: "independent-generator", path: "tools/generate-base-paper-usdplus-r16-independent-proof-vector.js", bytes: 3446, sha256: "945834391b0e974eb6c644316492112e237ee3ef02ab1102a15aaaa037f3648e", cap: 1024 * 1024, root: "workspace" }),
  Object.freeze({ id: "tool-lock", path: ".audit-tools/node/package-lock.json", bytes: 307263, sha256: "cde35f72dda2590e118280a05f2786134b536f4f73513027b3d1dcb2c698d974", cap: 2 * 1024 * 1024, root: "tool" }),
  Object.freeze({ id: "mpt-package", path: ".audit-tools/node/node_modules/@ethereumjs/mpt/package.json", bytes: 3057, sha256: "7850e6e6988a34f23cdd13c1a1abbd56b085d78f08a48770288916ef62c7ad89", cap: 128 * 1024, root: "tool" }),
  Object.freeze({ id: "mpt-entry", path: ".audit-tools/node/node_modules/@ethereumjs/mpt/dist/cjs/index.js", bytes: 1136, sha256: "f5440d3ff141c18fa450370eb2fa3f65932644c495be98f9ab4a963923ec9503", cap: 1024 * 1024, root: "tool" }),
  Object.freeze({ id: "util-package", path: ".audit-tools/node/node_modules/@ethereumjs/util/package.json", bytes: 3594, sha256: "3115f0b54ad8200c0dc8e38846ff7a57284b05e3b2d71566d001f62399597999", cap: 128 * 1024, root: "tool" }),
  Object.freeze({ id: "util-entry", path: ".audit-tools/node/node_modules/@ethereumjs/util/dist/cjs/index.js", bytes: 3405, sha256: "25ab2667a1b6b92f68cdae3385dab07fedaa15b5e5a89c0832045cfa33a4b096", cap: 1024 * 1024, root: "tool" }),
  Object.freeze({ id: "rlp-package", path: ".audit-tools/node/node_modules/@ethereumjs/rlp/package.json", bytes: 2700, sha256: "d742fd17c332dfb905e54df91bfd7f37b5dc0bd4d8852a2927ba050918535fc4", cap: 128 * 1024, root: "tool" }),
  Object.freeze({ id: "rlp-entry", path: ".audit-tools/node/node_modules/@ethereumjs/rlp/dist/cjs/index.js", bytes: 10761, sha256: "d0b0faf6acfe62d4602be2791c7ca6399d30cbfb8076733d29113c1e3b65d90c", cap: 1024 * 1024, root: "tool" }),
  Object.freeze({ id: "keccak-package", path: ".audit-tools/node/node_modules/ethereum-cryptography/package.json", bytes: 11297, sha256: "35687af30f8342f23dcde98ea0ad4ab020002199bafa5861f13f320a40678eed", cap: 128 * 1024, root: "tool" }),
  Object.freeze({ id: "keccak-entry", path: ".audit-tools/node/node_modules/ethereum-cryptography/keccak.js", bytes: 597, sha256: "865d796b859b2a5bf33ddcebecd367eb992649d9f03b1f9ac851a89577bd1053", cap: 1024 * 1024, root: "tool" }),
]);
const NODE = Object.freeze({ version: "v24.13.0", bytes: 89953280, sha256: "d14ba95cdce1ef7dc9ad3ac74949ca5db38b27378ee30f30a23cf26f9e875a11", cap: 128 * 1024 * 1024 });
const PUBLIC_EXPORTS = Object.freeze([
  Object.freeze({ request: "@ethereumjs/mpt", path: ".audit-tools/node/node_modules/@ethereumjs/mpt/dist/cjs/index.js", properties: Object.freeze(["verifyMerkleProof"]) }),
  Object.freeze({ request: "@ethereumjs/util", path: ".audit-tools/node/node_modules/@ethereumjs/util/dist/cjs/index.js", properties: Object.freeze(["bytesToHex"]) }),
  Object.freeze({ request: "@ethereumjs/rlp", path: ".audit-tools/node/node_modules/@ethereumjs/rlp/dist/cjs/index.js", properties: Object.freeze(["decode", "encode"]) }),
  Object.freeze({ request: "ethereum-cryptography/keccak.js", path: ".audit-tools/node/node_modules/ethereum-cryptography/keccak.js", properties: Object.freeze(["keccak256"]) }),
]);

class AnchorError extends Error { constructor(code) { super(code); this.name = "AnchorError"; this.code = code; } }
const fail = code => { throw new AnchorError(code); };
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const rel = file => path.relative(ROOT, file).replaceAll("\\", "/");
const folded = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const inside = (file, root) => { const candidate = folded(file), parent = folded(root); return candidate === parent || candidate.startsWith(`${parent}${path.sep}`); };
const sameStat = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].every(key => a[key] === b[key]);
function seams(options = {}) { return { readFile: options.readFile || fs.readFileSync, lstat: options.lstat || fs.lstatSync, realpath: options.realpath || fs.realpathSync, cache: options.cache || require.cache }; }
function secureIdentity(spec, options = {}) {
  const io = seams(options), file = spec.absolute || path.resolve(ROOT, ...spec.path.split("/")), permitted = spec.root === "tool" ? TOOL_ROOT : spec.root === "node" ? path.dirname(process.execPath) : ROOT;
  let before, after, realBefore, realAfter, bytes;
  try { before = io.lstat(file); realBefore = io.realpath(file); } catch (_) { fail("ANCHOR_FILE_MISSING"); }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("ANCHOR_FILE_TYPE_INVALID");
  if (!inside(realBefore, permitted) || path.resolve(realBefore) !== path.resolve(file)) fail("ANCHOR_REALPATH_ESCAPE");
  if (before.size !== spec.bytes || before.size > spec.cap) fail("ANCHOR_FILE_SIZE_MISMATCH");
  try { bytes = io.readFile(file); after = io.lstat(file); realAfter = io.realpath(file); } catch (_) { fail("ANCHOR_FILE_READ_FAILED"); }
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes); if (!sameStat(before, after) || realBefore !== realAfter || bytes.length !== before.size) fail("ANCHOR_FILE_CHANGED_DURING_READ");
  if (sha(bytes) !== spec.sha256) fail("ANCHOR_FILE_HASH_MISMATCH"); return { file, bytes, stat: after };
}
function resolvedEntries() {
  return PUBLIC_EXPORTS.map(row => { let resolved; try { resolved = toolRequire.resolve(row.request); } catch (_) { fail("ANCHOR_PUBLIC_EXPORT_RESOLUTION_FAILED"); }
    if (rel(resolved) !== row.path || !inside(resolved, TOOL_ROOT)) fail("ANCHOR_PUBLIC_EXPORT_RESOLUTION_MISMATCH"); return { ...row, resolved }; });
}
function validatePinnedSet(options = {}) {
  if (process.version !== NODE.version) fail("ANCHOR_NODE_VERSION_MISMATCH"); secureIdentity({ ...NODE, id: "node", absolute: process.execPath, root: "node" }, options);
  for (const pin of PINS) secureIdentity(pin, options); return true;
}
function parsePinnedManifest(options = {}) {
  const bytes = secureIdentity(PINS.find(row => row.id === "manifest"), options).bytes; let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch (_) { fail("ANCHOR_MANIFEST_INVALID"); }
  if (manifest.schema !== "base-paper-usdplus-r16-toolchain/v2" || manifest.externalAnchorRequired !== true || manifest.selfConsistentOnly !== true) fail("ANCHOR_MANIFEST_INVALID"); return manifest;
}
function validateCleanCache(manifest, options = {}) {
  const io = seams(options), proofPath = folded(path.join(ROOT, "tools/lib/base-paper-usdplus-r16-proof.js")); let toolRoot;
  try { toolRoot = folded(io.realpath(TOOL_ROOT)); } catch (_) { fail("ANCHOR_REALPATH_ESCAPE"); }
  const graphPaths = new Set(manifest.runtimeGraph.map(row => folded(path.resolve(ROOT, ...row.path.split("/")))));
  for (const key of Object.keys(io.cache)) {
    const lexical = folded(key); let canonical = lexical; try { canonical = folded(io.realpath(key)); } catch (_) { /* Existing cache keys can be checked lexically when a fault seam removes the file. */ }
    if (lexical === proofPath || canonical === proofPath || inside(lexical, toolRoot) || inside(canonical, toolRoot) || graphPaths.has(lexical) || graphPaths.has(canonical)) fail("ANCHOR_PRELOADED_MODULE_REJECTED");
  }
  return true;
}
function validateInitialState(options = {}) {
  validatePinnedSet(options); const manifest = parsePinnedManifest(options), entries = resolvedEntries(); validateCleanCache(manifest, options); return { entries, manifest };
}
function graphFiles(roots) {
  const seen = new Set();
  function walk(mod) { if (!mod || typeof mod.filename !== "string" || seen.has(mod.filename)) return; seen.add(mod.filename); if (!Array.isArray(mod.children)) fail("ANCHOR_CACHE_GRAPH_INVALID"); for (const child of mod.children) walk(child); }
  for (const root of roots) walk(root); return [...seen].sort();
}
function identityFromManifest(row, options = {}) {
  secureIdentity({ id: "graph", path: row.path, bytes: row.bytes, sha256: row.sha256, cap: 2 * 1024 * 1024, root: "tool" }, options);
}
function validateManifestFiles(manifest, options = {}) {
  for (const row of manifest.runtimeGraph) identityFromManifest(row, options);
  for (const row of manifest.packageMetadata) identityFromManifest(row, options);
  return true;
}
function validateGraph(roots, manifest, options = {}) {
  const files = graphFiles(roots), proofPath = path.join(ROOT, "tools/lib/base-paper-usdplus-r16-proof.js"), runtime = files.filter(file => path.resolve(file) !== path.resolve(proofPath));
  const expected = manifest.runtimeGraph.map(row => path.resolve(ROOT, ...row.path.split("/"))).sort();
  if (runtime.length !== expected.length || runtime.some((file, index) => path.resolve(file) !== expected[index])) fail("ANCHOR_RUNTIME_GRAPH_MISMATCH");
  validateManifestFiles(manifest, options); return runtime.length;
}

let state;
function initialize() {
  const initial = validateInitialState(), { entries, manifest } = initial; validateManifestFiles(manifest); validateCleanCache(manifest);
  const proofPath = path.join(ROOT, "tools/lib/base-paper-usdplus-r16-proof.js"), base = require(proofPath);
  if (!Object.isFrozen(base) || typeof base.verifyAccountProof !== "function" || typeof base.selfConsistencyAttestation !== "function") fail("ANCHOR_PROOF_EXPORT_INVALID");
  const self = base.selfConsistencyAttestation(); if (self.selfConsistent !== true || self.externalAnchorRequired !== true) fail("ANCHOR_SELF_CONSISTENCY_REJECTED");
  const roots = [require.cache[proofPath], ...entries.map(row => require.cache[row.resolved])], graphCount = validateGraph(roots, manifest); validatePinnedSet();
  const consumed = captureConsumedExports(base, proofPath, entries);
  state = { entries, manifest, base, proofPath, roots, graphCount, consumed };
  return state;
}
function descriptorEqual(a, b) {
  return !!a && !!b && a.value === b.value && a.get === b.get && a.set === b.set && a.writable === b.writable
    && a.enumerable === b.enumerable && a.configurable === b.configurable;
}
function consumedRow(module, property, owner) {
  if (!module || !module.exports || !Object.hasOwn(module.exports, property)) fail("ANCHOR_PROOF_EXPORT_INVALID");
  const descriptor = Object.getOwnPropertyDescriptor(module.exports, property), fn = module.exports[property]; if (typeof fn !== "function") fail("ANCHOR_PROOF_EXPORT_INVALID");
  return Object.freeze({ owner, property, module, exportsObject: module.exports, descriptor: Object.freeze({ ...descriptor }), functionReference: fn });
}
function captureConsumedExports(base, proofPath, entries) {
  const rows = [consumedRow(require.cache[proofPath], "verifyAccountProof", "proof"), consumedRow(require.cache[proofPath], "selfConsistencyAttestation", "proof")];
  for (const entry of entries) for (const property of entry.properties) rows.push(consumedRow(require.cache[entry.resolved], property, entry.request));
  return Object.freeze(rows);
}
function validateConsumedExports(snapshot = state.consumed) {
  if (!Array.isArray(snapshot) || snapshot.length !== state.consumed.length) fail("ANCHOR_CACHED_EXPORT_CHANGED");
  for (let index = 0; index < state.consumed.length; index++) {
    const expected = state.consumed[index], row = snapshot[index];
    if (row !== expected || require.cache[expected.module.filename] !== expected.module || expected.module.exports !== expected.exportsObject
      || !Object.hasOwn(expected.exportsObject, expected.property) || !descriptorEqual(Object.getOwnPropertyDescriptor(expected.exportsObject, expected.property), expected.descriptor)
      || expected.exportsObject[expected.property] !== expected.functionReference) fail("ANCHOR_CACHED_EXPORT_CHANGED");
  }
  return true;
}
function guard(options = {}) {
  if (!state) initialize(); validatePinnedSet(options);
  validateConsumedExports();
  validateGraph(state.roots, state.manifest, options); return true;
}
const attestationValue = Object.freeze({ reviewedIdentity: true, selfVerificationClaimed: false, externalAnchorRequired: true, anchorHashMustBePinnedBeforeRequire: true,
  futureRunnerInstruction: "PIN_REVIEWED_ANCHOR_SHA256_BEFORE_REQUIRE", nodeVersion: NODE.version, mptVersion: "10.1.1", utilVersion: "10.1.1", rlpVersion: "10.1.1",
  keccakVersion: "2.2.1", runtimeGraphFileCount: 0, wireOrderConformanceChecked: false,
  claims: Object.freeze({ cleanInitialPinnedGraphLoad: true, consumedExportMutationChecks: true, boundedHostileProofInputs: true, persistentOrdinaryMutationDetection: true }),
  nonclaims: Object.freeze({ raceFreeHashToRequireLoading: false, activeConcurrentAuthorizedFilesystemWriterResistance: false,
    transientAsyncSameProcessMutationRestoredBeforeGuardDetection: false, adminKernelCompromiseResistance: false }) });
function attestation() { guard(); return Object.freeze({ ...attestationValue, runtimeGraphFileCount: state.graphCount }); }
async function verifyAccountProof(input, policy) { guard(); try { return await state.base.verifyAccountProof(input, policy); } finally { guard(); } }

initialize();
module.exports = Object.freeze({ verifyAccountProof, attestation,
  _test: Object.freeze({ AnchorError, NODE, PINS, PUBLIC_EXPORTS, captureConsumedExports, descriptorEqual, graphFiles, guard, parsePinnedManifest, secureIdentity,
    validateCleanCache, validateConsumedExports, validateGraph, validateInitialState, validateManifestFiles, validatePinnedSet }) });
