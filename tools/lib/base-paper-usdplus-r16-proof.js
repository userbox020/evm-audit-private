"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const ROOT = path.resolve(__dirname, "../..");
const TOOL_ROOT = path.join(ROOT, ".audit-tools/node");
const MANIFEST_FILE = path.join(ROOT, "tools/manifests/base-paper-usdplus-r16-toolchain.json");
const toolRequire = createRequire(path.join(TOOL_ROOT, "package.json"));
const LIMITS = Object.freeze({ maxTotalProofNodes: 128, maxNodeBytes: 64 * 1024, maxTotalProofBytes: 1024 * 1024, maxStorageEntries: 32, maxCodeBytes: 128 * 1024 });
const POLICIES = Object.freeze({ REQUIRED_EXISTING: "REQUIRED_EXISTING", ALLOW_EXCLUSION: "ALLOW_EXCLUSION" });
const EMPTY_TRIE_ROOT_HEX = "56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421";
const DIRECT = Object.freeze([
  Object.freeze({ name: "@ethereumjs/mpt", request: "@ethereumjs/mpt", version: "10.1.1" }),
  Object.freeze({ name: "@ethereumjs/util", request: "@ethereumjs/util", version: "10.1.1" }),
  Object.freeze({ name: "@ethereumjs/rlp", request: "@ethereumjs/rlp", version: "10.1.1" }),
  Object.freeze({ name: "ethereum-cryptography", request: "ethereum-cryptography/keccak.js", version: "2.2.1" }),
]);
const KECCAK_EXPORT = "ethereum-cryptography/keccak.js#keccak256";

class ProofError extends Error { constructor(code) { super(code); this.name = "ProofError"; this.code = code; } }
const fail = code => { throw new ProofError(code); };
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const relative = file => path.relative(ROOT, file).replaceAll("\\", "/");
const equalBytes = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const isInside = (file, root) => { const rel = path.relative(root, file); return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel); };

function parseData(value, exactBytes = null, maximumBytes = null) {
  if (typeof value !== "string") fail("DATA_INVALID");
  if (exactBytes !== null && value.length !== 2 + exactBytes * 2) fail("DATA_LENGTH_INVALID");
  if (maximumBytes !== null && value.length > 2 + maximumBytes * 2) fail("DATA_SIZE_EXCEEDED");
  if (value.length < 2 || (value.length - 2) % 2 !== 0) fail("DATA_INVALID");
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) fail("DATA_INVALID");
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}
function parseQuantity(value) {
  if (typeof value !== "string") fail("QUANTITY_INVALID");
  if (value.length > 66) fail("QUANTITY_SIZE_EXCEEDED");
  if (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) fail("QUANTITY_INVALID"); return BigInt(value);
}
function bytesToBigInt(bytes) { return bytes.length === 0 ? 0n : BigInt(`0x${Buffer.from(bytes).toString("hex")}`); }
function aggregateCommitment(rows) { return sha(Buffer.from(rows.map(row => `${row.path}\0${row.sha256}\0${row.bytes}\n`).join(""), "utf8")); }
function validRelative(value) {
  if (typeof value !== "string" || value.includes("\\") || path.posix.isAbsolute(value) || value.split("/").includes("..")) fail("TOOLCHAIN_PATH_INVALID");
  const full = path.resolve(ROOT, ...value.split("/")); if (!isInside(full, ROOT)) fail("TOOLCHAIN_PATH_INVALID"); return full;
}
function identity(readFile, row) {
  const file = validRelative(row.path); let bytes; try { bytes = readFile(file); } catch (_) { fail("TOOLCHAIN_FILE_MISSING"); }
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes); if (bytes.length !== row.bytes || sha(bytes) !== row.sha256) fail("TOOLCHAIN_FILE_HASH_MISMATCH"); return bytes;
}
function loadManifest(readFile) { try { return JSON.parse(readFile(MANIFEST_FILE, "utf8")); } catch (_) { fail("TOOLCHAIN_MANIFEST_INVALID"); } }

function verifyManifestSelfConsistency(options = {}) {
  const readFile = options.readFile || fs.readFileSync, manifest = options.manifest || loadManifest(readFile);
  if (!manifest || manifest.schema !== "base-paper-usdplus-r16-toolchain/v2" || manifest.externalAnchorRequired !== true || manifest.selfConsistentOnly !== true
    || manifest.node?.version !== process.version || manifest.keccak?.export !== KECCAK_EXPORT || !Array.isArray(manifest.directPackages)
    || !Array.isArray(manifest.runtimeGraph) || !Array.isArray(manifest.packageMetadata) || !Array.isArray(manifest.permittedRoots)
    || Object.hasOwn(manifest, "bindings")) fail("TOOLCHAIN_MANIFEST_INVALID");
  if (manifest.node.executableSha256 !== sha(readFile(process.execPath))) fail("NODE_EXECUTABLE_MISMATCH"); identity(readFile, manifest.packageLock);
  for (const expected of DIRECT) {
    const row = manifest.directPackages.find(item => item.name === expected.name); if (!row || row.request !== expected.request || row.version !== expected.version) fail("TOOLCHAIN_VERSION_MISMATCH");
    let resolved; try { resolved = toolRequire.resolve(expected.request); } catch (_) { fail("TOOLCHAIN_RESOLUTION_FAILED"); }
    if (relative(resolved) !== row.resolvedEntry.path || !isInside(resolved, TOOL_ROOT)) fail("TOOLCHAIN_RESOLUTION_MISMATCH"); identity(readFile, row.resolvedEntry);
    const pkg = JSON.parse(identity(readFile, row.packageJson).toString("utf8")); if (pkg.name !== expected.name || pkg.version !== expected.version) fail("TOOLCHAIN_VERSION_MISMATCH");
  }
  for (const field of ["runtimeGraph", "packageMetadata"]) {
    const rows = manifest[field], paths = rows.map(row => row.path); if (new Set(paths).size !== paths.length || [...paths].sort().some((value, index) => value !== paths[index])) fail("TOOLCHAIN_CLOSURE_INVALID");
    for (const row of rows) identity(readFile, row);
  }
  if (manifest.runtimeGraphAggregateSha256 !== aggregateCommitment(manifest.runtimeGraph) || manifest.packageMetadataAggregateSha256 !== aggregateCommitment(manifest.packageMetadata)) fail("TOOLCHAIN_CLOSURE_AGGREGATE_MISMATCH");
  const directRows = manifest.directPackages.flatMap(row => [row.packageJson, row.resolvedEntry]).sort((a, b) => a.path.localeCompare(b.path));
  if (manifest.directAggregateSha256 !== aggregateCommitment(directRows)) fail("TOOLCHAIN_DIRECT_AGGREGATE_MISMATCH");
  return Object.freeze({ selfConsistent: true, externalAnchorRequired: true, nodeVersion: process.version, mptVersion: "10.1.1", utilVersion: "10.1.1", rlpVersion: "10.1.1",
    keccakVersion: "2.2.1", runtimeGraphFileCount: manifest.runtimeGraph.length, wireOrderConformanceChecked: false });
}
function loadPackages() {
  const mpt = toolRequire("@ethereumjs/mpt"), util = toolRequire("@ethereumjs/util"), rlp = toolRequire("@ethereumjs/rlp"), keccak = toolRequire("ethereum-cryptography/keccak.js");
  if (typeof mpt.verifyMerkleProof !== "function" || typeof util.bytesToHex !== "function" || typeof rlp.decode !== "function" || typeof rlp.encode !== "function" || typeof keccak.keccak256 !== "function") fail("TOOLCHAIN_EXPORT_INVALID");
  return Object.freeze({ mpt, util, rlp, keccak256: keccak.keccak256 });
}
let trusted;
function initializeToolchain() { if (!trusted) { const attestation = verifyManifestSelfConsistency(); trusted = Object.freeze({ packages: loadPackages(), attestation }); } return trusted.attestation; }
function runtime() { initializeToolchain(); return trusted.packages; }

function newBudget() { return { nodes: 0, bytes: 0 }; }
function parseProofNodes(values, budget) {
  if (!Array.isArray(values)) fail("PROOF_NODE_COUNT_INVALID"); if (budget.nodes + values.length > LIMITS.maxTotalProofNodes) fail("PROOF_TOTAL_NODE_COUNT_EXCEEDED");
  const nodes = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length < 2 || (value.length - 2) % 2 !== 0) fail("DATA_INVALID");
    if (value.length > 2 + LIMITS.maxNodeBytes * 2) fail("PROOF_NODE_BYTES_EXCEEDED");
    const encodedBytes = (value.length - 2) / 2; if (budget.bytes + encodedBytes > LIMITS.maxTotalProofBytes) fail("PROOF_TOTAL_BYTES_EXCEEDED");
    const node = parseData(value); if (node.length === 0) fail("PROOF_NODE_EMPTY"); budget.nodes++; budget.bytes += node.length; nodes.push(node);
  }
  return nodes;
}
function decodeCanonical(bytes, expectList) {
  const { rlp } = runtime(); let decoded;
  try { const streamed = rlp.decode(bytes, true); if (streamed.remainder.length) fail("RLP_TRAILING_BYTES"); decoded = streamed.data; if (!equalBytes(rlp.encode(decoded), bytes)) fail("RLP_NONCANONICAL"); }
  catch (error) { if (error instanceof ProofError) throw error; fail("RLP_INVALID"); }
  if (expectList ? !Array.isArray(decoded) : Array.isArray(decoded)) fail("RLP_TYPE_INVALID"); return decoded;
}
function canonicalInteger(bytes) { if (!(bytes instanceof Uint8Array) || (bytes.length && bytes[0] === 0)) fail("RLP_INTEGER_NONCANONICAL"); return bytesToBigInt(bytes); }
function decodeAccountRlp(value) {
  const bytes = value instanceof Uint8Array ? value : parseData(value), decoded = decodeCanonical(bytes, true);
  if (decoded.length !== 4 || decoded.some(field => !(field instanceof Uint8Array))) fail("ACCOUNT_RLP_SHAPE_INVALID");
  const nonce = canonicalInteger(decoded[0]), balance = canonicalInteger(decoded[1]); if (decoded[2].length !== 32 || decoded[3].length !== 32) fail("ACCOUNT_RLP_HASH_LENGTH_INVALID");
  return { nonce, balance, storageRoot: decoded[2], codeHash: decoded[3] };
}
function decodeStorageScalar(value) { const bytes = value instanceof Uint8Array ? value : parseData(value), decoded = decodeCanonical(bytes, false); return canonicalInteger(decoded); }
function emptyRoot(root) { return Buffer.from(root).toString("hex") === EMPTY_TRIE_ROOT_HEX; }
async function mptValue(key, proofValues, root, budget) {
  const nodes = parseProofNodes(proofValues, budget); if (nodes.length === 0) { if (!emptyRoot(root)) fail("EMPTY_PROOF_NONEMPTY_ROOT"); return null; }
  const { mpt, keccak256 } = runtime(); if (!equalBytes(keccak256(nodes[0]), root)) fail("PROOF_ROOT_NODE_NOT_FIRST");
  try { return await mpt.verifyMerkleProof(key, nodes, { root, useKeyHashing: true }); } catch (_) { fail("MERKLE_PROOF_INVALID"); }
}
async function verifyStorageEntry(entry, storageRoot, budget) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("STORAGE_ENTRY_INVALID");
  const key = parseData(entry.key, 32), reported = parseQuantity(entry.value), value = await mptValue(key, entry.proof, storageRoot, budget);
  if (value === null) { if (reported !== 0n) fail("STORAGE_EXCLUSION_NONZERO_MISMATCH"); return Object.freeze({ inclusionProven: false, exclusionProven: true, reportedZero: true }); }
  const actual = decodeStorageScalar(value); if (actual === 0n) fail("STORAGE_INCLUDED_ZERO"); if (actual !== reported) fail("STORAGE_VALUE_MISMATCH");
  return Object.freeze({ inclusionProven: true, exclusionProven: false, reportedZero: false });
}
function safeResult(toolchain, included, excluded, budget, storage) {
  return Object.freeze({ toolchain, accountIncluded: included, accountExclusionProven: excluded, rpcAccountMatched: included, codeHashMatched: included,
    proofNodeCount: budget.nodes, proofBytes: budget.bytes, storageProofCount: storage.length, storage: Object.freeze(storage), wireOrderConformanceChecked: false });
}
async function verifyAccountProof(input, policy) {
  if (policy !== POLICIES.REQUIRED_EXISTING && policy !== POLICIES.ALLOW_EXCLUSION) fail("ACCOUNT_POLICY_INVALID");
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("ACCOUNT_INPUT_INVALID");
  if (input.storageProof !== undefined && !Array.isArray(input.storageProof)) fail("STORAGE_PROOF_ARRAY_INVALID");
  if (Array.isArray(input.storageProof) && input.storageProof.length > LIMITS.maxStorageEntries) fail("STORAGE_ENTRY_COUNT_EXCEEDED");
  const budget = newBudget(), address = parseData(input.address, 20), stateRoot = parseData(input.stateRoot, 32), value = await mptValue(address, input.accountProof, stateRoot, budget), toolchain = initializeToolchain();
  if (value === null) { if (policy === POLICIES.REQUIRED_EXISTING) fail("REQUIRED_ACCOUNT_ABSENT"); return safeResult(toolchain, false, true, budget, []); }
  const account = decodeAccountRlp(value), nonce = parseQuantity(input.nonce), balance = parseQuantity(input.balance), storageHash = parseData(input.storageHash, 32), reportedCodeHash = parseData(input.codeHash, 32);
  if (account.nonce !== nonce) fail("ACCOUNT_NONCE_MISMATCH"); if (account.balance !== balance) fail("ACCOUNT_BALANCE_MISMATCH"); if (!equalBytes(account.storageRoot, storageHash)) fail("ACCOUNT_STORAGE_ROOT_MISMATCH");
  if (!equalBytes(account.codeHash, reportedCodeHash)) fail("ACCOUNT_CODE_HASH_MISMATCH");
  if (typeof input.code !== "string" || input.code.length > 2 + LIMITS.maxCodeBytes * 2) fail("CODE_SIZE_EXCEEDED");
  const code = parseData(input.code, null, LIMITS.maxCodeBytes), actualCodeHash = runtime().keccak256(code); if (!equalBytes(actualCodeHash, account.codeHash) || !equalBytes(actualCodeHash, reportedCodeHash)) fail("ACCOUNT_CODE_BYTES_MISMATCH");
  if (!Array.isArray(input.storageProof)) fail("STORAGE_PROOF_ARRAY_INVALID");
  const storage = []; for (const entry of input.storageProof) storage.push(await verifyStorageEntry(entry, account.storageRoot, budget));
  return safeResult(toolchain, true, false, budget, storage);
}

module.exports = Object.freeze({ verifyAccountProof, selfConsistencyAttestation: initializeToolchain,
  _test: Object.freeze({ DIRECT, EMPTY_TRIE_ROOT_HEX, KECCAK_EXPORT, LIMITS, POLICIES, ProofError, aggregateCommitment, decodeAccountRlp, decodeStorageScalar,
    initializeToolchain, newBudget, parseData, parseProofNodes, parseQuantity, verifyManifestSelfConsistency, verifyStorageEntry }) });
