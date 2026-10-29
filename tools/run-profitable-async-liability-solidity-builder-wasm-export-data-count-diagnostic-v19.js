#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const WORKSPACE = path.resolve(__dirname, "..");
const NAMESPACE = "profitable-async-liability-solidity-builder-wasm-export-data-count-diagnostic-v19";
const STATUS = "SEALED_OFFLINE_EXPORT_DATA_COUNT_DIAGNOSTIC_NO_EXECUTION_AUTHORITY";
const DIAGNOSE_FLAG = "--diagnose-fixed-v18-export-data-count";
const HELP_FLAG = "--help";
const EXACT_COMMAND = `node tools/run-${NAMESPACE}.js ${DIAGNOSE_FLAG}`;
const PACKAGE_REL = `tools/vendor/${NAMESPACE}`;
const V16 = "profitable-async-liability-solidity-builder-exit-validated-two-build-executor-v16-production-v1";
const RUN_ID = "3f979d5654c4c6ae9c565952e0d7546f";
const GENERATED_REL = `tools/vendor/${V16}/runs/${RUN_ID}/out-a/tree-sitter-solidity.wasm`;
const OUT_A_REL = `tools/vendor/${V16}/runs/${RUN_ID}/out-a`;
const OUT_B_REL = `tools/vendor/${V16}/runs/${RUN_ID}/out-b`;
const PUBLISHED_REL = "tools/vendor/profitable-async-liability-delta-detector-v1-parser-authority/sources/extracted/tree-sitter-solidity-1.2.13/package/tree-sitter-solidity.wasm";
const GENERATED_EXPECTED = Object.freeze({ bytes: 508585, sha256: "ac4d44dc54b7a475c2284ae27ab0af932043e2cfd4e200a416b2ac5d40f433d7" });
const PUBLISHED_EXPECTED = Object.freeze({ bytes: 508582, sha256: "07420813d7668445152a5d5d2017e0fb84cb27342257e1add3cc7462eec7f811" });
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_SECTIONS = 256;
const MAX_EXPORTS = 4096;
const MAX_EXPORT_NAME_BYTES = 1024;
const MAX_TOTAL_EXPORT_NAME_BYTES = 256 * 1024;
const HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const TREE_SITTER_NAME = "tree_sitter_solidity";
const KIND_NAMES = Object.freeze(["FUNCTION", "TABLE", "MEMORY", "GLOBAL", "TAG"]);
const CLASSIFICATIONS = Object.freeze({
  READ_INCOMPLETE: "READ_OR_IDENTITY_INCOMPLETE",
  BOTH_MODULES_INVALID: "BOTH_WASM_MODULES_INVALID",
  GENERATED_MODULE_INVALID: "GENERATED_WASM_MODULE_INVALID",
  PUBLISHED_MODULE_INVALID: "PUBLISHED_WASM_MODULE_INVALID",
  BOTH_EXPORTS_INVALID: "BOTH_EXPORT_PAYLOADS_INVALID",
  GENERATED_EXPORT_INVALID: "GENERATED_EXPORT_PAYLOAD_INVALID",
  PUBLISHED_EXPORT_INVALID: "PUBLISHED_EXPORT_PAYLOAD_INVALID",
  BOTH_COUNTS_INVALID: "BOTH_DATA_COUNT_DIAGNOSTICS_INVALID",
  GENERATED_COUNT_INVALID: "GENERATED_DATA_COUNT_DIAGNOSTIC_INVALID",
  PUBLISHED_COUNT_INVALID: "PUBLISHED_DATA_COUNT_DIAGNOSTIC_INVALID",
  BOTH_COUNT_INCONSISTENT: "BOTH_DECLARED_DATA_COUNTS_INCONSISTENT",
  GENERATED_COUNT_INCONSISTENT: "GENERATED_DECLARED_DATA_COUNT_INCONSISTENT",
  PUBLISHED_COUNT_INCONSISTENT: "PUBLISHED_DECLARED_DATA_COUNT_INCONSISTENT",
  EXPORT_AND_DATA_COUNT_DIFFERENCE: "EXPORT_AND_DATA_COUNT_DIFFERENCE",
  EXPORT_DIFFERENCE: "EXPORT_DIFFERENCE",
  DATA_COUNT_DIFFERENCE: "DATA_COUNT_DIFFERENCE",
  MATCH: "EXPORT_AND_DATA_COUNT_MATCH"
});
const CLASSIFICATION_PRECEDENCE = Object.freeze(Object.values(CLASSIFICATIONS));
const SECTION_NAMES = Object.freeze({ 0: "custom", 1: "type", 2: "import", 3: "function", 4: "table", 5: "memory", 6: "global", 7: "export", 8: "start", 9: "element", 10: "code", 11: "data", 12: "data_count", 13: "tag" });
const SECTION_RANK = Object.freeze({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 13: 5.5, 6: 6, 7: 7, 8: 8, 9: 9, 12: 9.5, 10: 10, 11: 11 });

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function exactKeys(value, keys, code = "PACKAGE_INVALID") { assert.equal(value && typeof value === "object" && !Array.isArray(value), true, code); assert.deepEqual(Object.keys(value), keys, code); }
function contained(target, root) { const relative = path.relative(path.resolve(root), path.resolve(target)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function nativeRealpath(target) { return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target); }
function safePath(relative, kind = null) {
  assert.match(relative, /^(?:\.|[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*)$/, "PATH_UNSAFE");
  const root = path.resolve(WORKSPACE), absolute = relative === "." ? root : path.resolve(root, ...relative.split("/")); assert.equal(contained(absolute, root), true, "PATH_UNSAFE");
  let cursor = root; for (const part of [null, ...path.relative(root, absolute).split(path.sep).filter(Boolean)]) { if (part !== null) cursor = path.join(cursor, part); const stat = fs.lstatSync(cursor); assert.equal(stat.isSymbolicLink(), false, "PATH_UNSAFE"); const real = path.resolve(nativeRealpath(cursor)); assert.equal(real, path.resolve(cursor), "PATH_UNSAFE"); assert.equal(contained(real, root), true, "PATH_UNSAFE"); }
  if (kind) { const stat = fs.lstatSync(absolute); assert.equal(kind === "file" ? stat.isFile() : stat.isDirectory(), true, "PATH_UNSAFE"); } return absolute;
}
function fileRecord(relative) { const bytes = fs.readFileSync(safePath(relative, "file")); return { path: relative, bytes: bytes.length, sha256: sha256(bytes) }; }
function verifyRecord(record) { exactKeys(record, ["path", "bytes", "sha256"]); assert.match(record.sha256, /^[0-9a-f]{64}$/, "PACKAGE_INVALID"); assert.deepEqual(fileRecord(record.path), record, `SEAL:${record.path}`); }
function validateSealedPackage() {
  const root = safePath(PACKAGE_REL, "directory"); assert.deepEqual(fs.readdirSync(root).sort(), ["diagnostic-policy.json", "manifests"], "PACKAGE_INVALID");
  const manifestsRoot = safePath(`${PACKAGE_REL}/manifests`, "directory"); assert.deepEqual(fs.readdirSync(manifestsRoot).sort(), ["authority-manifest.json", "authority-manifest.sha256", "package-manifest.json"], "PACKAGE_INVALID");
  const manifestRel = `${PACKAGE_REL}/manifests/package-manifest.json`, authorityRel = `${PACKAGE_REL}/manifests/authority-manifest.json`, detachedRel = `${PACKAGE_REL}/manifests/authority-manifest.sha256`;
  const manifest = JSON.parse(fs.readFileSync(safePath(manifestRel, "file")));
  exactKeys(manifest, ["schema", "namespace", "status", "diagnosticFlag", "exactCommand", "inputs", "limits", "classificationPrecedence", "successorRecords", "v18BindingRecords"]);
  assert.equal(manifest.schema, `${NAMESPACE}/package-manifest-v1`); assert.equal(manifest.namespace, NAMESPACE); assert.equal(manifest.status, STATUS); assert.equal(manifest.diagnosticFlag, DIAGNOSE_FLAG); assert.equal(manifest.exactCommand, EXACT_COMMAND);
  assert.deepEqual(manifest.inputs, { generated: { path: GENERATED_REL, ...GENERATED_EXPECTED }, published: { path: PUBLISHED_REL, ...PUBLISHED_EXPECTED } });
  assert.deepEqual(manifest.limits, { artifactReads: 2, maximumArtifactBytes: MAX_ARTIFACT_BYTES, chunkBytes: CHUNK_BYTES, maximumSections: MAX_SECTIONS, maximumExports: MAX_EXPORTS, maximumExportNameBytes: MAX_EXPORT_NAME_BYTES, maximumTotalExportNameBytes: MAX_TOTAL_EXPORT_NAME_BYTES, processCalls: 0, writes: 0, networkCalls: 0, wasmRuntimeCalls: 0 });
  assert.deepEqual(manifest.classificationPrecedence, CLASSIFICATION_PRECEDENCE); for (const records of [manifest.successorRecords, manifest.v18BindingRecords]) for (const record of records) verifyRecord(record);
  const policy = JSON.parse(fs.readFileSync(safePath(`${PACKAGE_REL}/diagnostic-policy.json`, "file")));
  exactKeys(policy, ["schema", "namespace", "status", "productionSurface", "readOnly", "inputs", "parser", "classificationPrecedence", "counters", "claims"]);
  assert.equal(policy.schema, `${NAMESPACE}/diagnostic-policy-v1`); assert.equal(policy.namespace, NAMESPACE); assert.equal(policy.status, STATUS); assert.equal(policy.productionSurface, "FIXED_CONSTANTS_EXACT_RESERVED_FLAG_NO_INJECTION"); assert.equal(policy.readOnly, true); assert.deepEqual(policy.inputs, manifest.inputs); assert.deepEqual(policy.classificationPrecedence, CLASSIFICATION_PRECEDENCE);
  assert.deepEqual(policy.parser, { fullModuleEnvelope: true, canonicalU32Leb: true, standardOrderAndDuplicates: true, exportVectorFullConsume: true, exportNameFatalUtf8: true, unknownExportNamesHashedOnly: true, exportKindBounded: true, exportIndexCanonical: true, dataCountFullConsume: true, dataSectionFirstSegmentCountOnly: true, duplicateSafeAlignment: true, maximumSections: MAX_SECTIONS, maximumExports: MAX_EXPORTS, maximumExportNameBytes: MAX_EXPORT_NAME_BYTES, maximumTotalExportNameBytes: MAX_TOTAL_EXPORT_NAME_BYTES });
  assert.deepEqual(policy.counters, { artifactReadsOnlyOnReservedFlag: 2, defaultArtifactReads: 0, helpArtifactReads: 0, processCalls: 0, writes: 0, networkCalls: 0, wasmRuntimeCalls: 0 }); assert.deepEqual(policy.claims, { execution: false, build: false, retry: false, reproducibility: false, parserPromotion: false, detectorRun: false, invocationAuthority: false });
  const authorityBytes = fs.readFileSync(safePath(authorityRel, "file")), detachedBytes = fs.readFileSync(safePath(detachedRel, "file")), match = /^([0-9a-f]{64})  authority-manifest\.json\n$/.exec(detachedBytes.toString("utf8")); assert.ok(match, "PACKAGE_INVALID"); assert.equal(sha256(authorityBytes), match[1], "PACKAGE_INVALID");
  const authority = JSON.parse(authorityBytes); exactKeys(authority, ["schema", "namespace", "status", "runner", "tests", "report", "policy", "packageManifest", "v18BindingRecords", "claims", "detachedChecksumRole"]);
  assert.equal(authority.schema, `${NAMESPACE}/authority-v1`); assert.equal(authority.namespace, NAMESPACE); assert.equal(authority.status, STATUS); ["runner", "tests", "report", "policy"].forEach((role, index) => assert.deepEqual(authority[role], manifest.successorRecords[index])); assert.deepEqual(authority.packageManifest, fileRecord(manifestRel)); assert.deepEqual(authority.v18BindingRecords, manifest.v18BindingRecords); assert.deepEqual(authority.claims, policy.claims); assert.equal(authority.detachedChecksumRole, "INTEGRITY_ONLY_NOT_INVOCATION_OR_EXECUTION_AUTHORITY");
  return { manifest, authority, packageManifestSha256: authority.packageManifest.sha256, authoritySha256: match[1], detachedSha256: sha256(detachedBytes) };
}
function validatePackage() { if (arguments.length !== 0) throw new Error("CALLER_DEPENDENCIES_REJECTED"); return validateSealedPackage(); }

function statType(stat) { if (stat && stat.isFile()) return "FILE"; if (stat && stat.isDirectory()) return "DIRECTORY"; return "OTHER"; }
function identity(stat) { return { dev: stat.dev, ino: stat.ino, type: statType(stat) }; }
function reliable(value) { return (typeof value === "number" && Number.isFinite(value) && value !== 0) || (typeof value === "bigint" && value !== 0n); }
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino && a.type === b.type; }
function sameMetadata(a, b) { return sameIdentity(identity(a), identity(b)) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
function capturePathChain(relative, finalType = "FILE") {
  assert.match(relative, /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/, "PATH_UNSAFE"); const root = path.resolve(WORKSPACE), absolute = path.resolve(root, ...relative.split("/")); assert.equal(contained(absolute, root), true, "PATH_UNSAFE");
  const components = []; let cursor = root; const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  for (let index = 0; index <= parts.length; index += 1) { if (index) cursor = path.join(cursor, parts[index - 1]); const stat = fs.lstatSync(cursor), type = statType(stat); assert.equal(stat.isSymbolicLink(), false, "PATH_UNSAFE"); assert.equal(type, index === parts.length ? finalType : "DIRECTORY", "PATH_UNSAFE"); const real = path.resolve(nativeRealpath(cursor)); assert.equal(real, path.resolve(cursor), "PATH_UNSAFE"); assert.equal(contained(real, root), true, "PATH_UNSAFE"); components.push(Object.freeze({ lexical: path.resolve(cursor), real, identity: identity(stat) })); }
  return Object.freeze({ absolute, components: Object.freeze(components), final: components.at(-1) });
}
function revalidatePathChain(chain) { try { for (const expected of chain.components) { const stat = fs.lstatSync(expected.lexical); if (stat.isSymbolicLink() || !sameIdentity(identity(stat), expected.identity)) return false; const real = path.resolve(nativeRealpath(expected.lexical)); if (real !== expected.real || !contained(real, WORKSPACE)) return false; } return true; } catch { return false; } }
function quarantineListingValid(outAChain, outBChain) { try { return JSON.stringify(fs.readdirSync(outAChain.absolute).sort()) === JSON.stringify(["tree-sitter-solidity.wasm"]) && fs.readdirSync(outBChain.absolute).length === 0; } catch { return false; } }
function readFixedArtifact(role, relative, expected, requireQuarantine) {
  let chain, outAChain = null, outBChain = null; try { if (requireQuarantine) { outAChain = capturePathChain(OUT_A_REL, "DIRECTORY"); outBChain = capturePathChain(OUT_B_REL, "DIRECTORY"); if (!quarantineListingValid(outAChain, outBChain)) return { ok: false, artifactReads: 0, code: "QUARANTINE_LISTING_INVALID" }; } chain = capturePathChain(relative); } catch { return { ok: false, artifactReads: 0, code: "ARTIFACT_PATH_UNSAFE" }; }
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" && fs.constants.O_NOFOLLOW !== 0, chains = [chain, outAChain, outBChain].filter(Boolean); if (!noFollow && !chains.every((item) => item.components.every((entry) => reliable(entry.identity.dev) && reliable(entry.identity.ino)))) return { ok: false, artifactReads: 0, code: "ARTIFACT_PATH_UNSAFE" };
  let fd; try { fd = fs.openSync(chain.absolute, fs.constants.O_RDONLY | (noFollow ? fs.constants.O_NOFOLLOW : 0)); } catch { return { ok: false, artifactReads: 1, code: "ARTIFACT_READ_FAILED" }; }
  let before, after, bytes = null, failed = false;
  try {
    try { before = fs.fstatSync(fd); } catch { return { ok: false, artifactReads: 1, code: "ARTIFACT_READ_FAILED" }; }
    if (!sameIdentity(identity(before), chain.final.identity) || identity(before).type !== "FILE" || !revalidatePathChain(chain) || (requireQuarantine && (!revalidatePathChain(outAChain) || !revalidatePathChain(outBChain) || !quarantineListingValid(outAChain, outBChain)))) return { ok: false, artifactReads: 1, code: "ARTIFACT_PATH_UNSAFE" };
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > MAX_ARTIFACT_BYTES) return { ok: false, artifactReads: 1, code: before.size > MAX_ARTIFACT_BYTES ? "ARTIFACT_TOO_LARGE" : "ARTIFACT_READ_FAILED" };
    bytes = Buffer.alloc(before.size); let offset = 0; while (offset < bytes.length) { let count; try { count = fs.readSync(fd, bytes, offset, Math.min(CHUNK_BYTES, bytes.length - offset), offset); } catch { failed = true; break; } if (!Number.isSafeInteger(count) || count <= 0) { failed = true; break; } offset += count; }
    try { after = fs.fstatSync(fd); } catch { failed = true; } if (failed || !after) return { ok: false, artifactReads: 1, code: "ARTIFACT_READ_FAILED" }; if (!sameMetadata(before, after) || !revalidatePathChain(chain) || (requireQuarantine && (!revalidatePathChain(outAChain) || !revalidatePathChain(outBChain) || !quarantineListingValid(outAChain, outBChain)))) return { ok: false, artifactReads: 1, code: "ARTIFACT_CHANGED_DURING_READ" };
  } finally { try { fs.closeSync(fd); } catch { failed = true; } }
  if (failed || bytes === null) return { ok: false, artifactReads: 1, code: "ARTIFACT_READ_FAILED" }; const observedSha256 = sha256(bytes); if (bytes.length !== expected.bytes || observedSha256 !== expected.sha256) return { ok: false, artifactReads: 1, code: "ARTIFACT_BINDING_MISMATCH", observedBytes: bytes.length, observedSha256 };
  return { ok: true, artifactReads: 1, role, bytes, observedBytes: bytes.length, observedSha256 };
}

function readU32Leb(bytes, offset, end) {
  let value = 0, shift = 0, cursor = offset; for (let count = 1; count <= 5; count += 1) { if (cursor >= end) return { ok: false, code: "LEB_TRUNCATED" }; const byte = bytes[cursor++]; if (count === 5 && (byte & 0xf0) !== 0) return { ok: false, code: "LEB_OVERFLOW" }; value += (byte & 0x7f) * (2 ** shift); if ((byte & 0x80) === 0) { const minimal = value < 0x80 ? 1 : value < 0x4000 ? 2 : value < 0x200000 ? 3 : value < 0x10000000 ? 4 : 5; if (count !== minimal) return { ok: false, code: "LEB_NON_CANONICAL" }; return { ok: true, value, next: cursor }; } shift += 7; } return { ok: false, code: "LEB_OVERFLOW" };
}
function invalidModule(code) { return { valid: false, code, exportPayload: null, dataCountPayload: null, dataPayload: null }; }
function parseModuleEnvelope(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || !bytes.subarray(0, 8).equals(HEADER)) return invalidModule(bytes && bytes.length >= 4 && bytes.subarray(0, 4).equals(HEADER.subarray(0, 4)) ? "VERSION_INVALID" : "MAGIC_INVALID");
  let offset = 8, count = 0, lastRank = 0; const seen = new Set(); let exportPayload = null, dataCountPayload = null, dataPayload = null;
  while (offset < bytes.length) { if (count++ >= MAX_SECTIONS) return invalidModule("SECTION_COUNT_CAP"); const id = bytes[offset++]; if (!Object.hasOwn(SECTION_NAMES, id)) return invalidModule("SECTION_ID_INVALID"); const length = readU32Leb(bytes, offset, bytes.length); if (!length.ok) return invalidModule(length.code); offset = length.next; const end = offset + length.value; if (!Number.isSafeInteger(end) || end > bytes.length) return invalidModule("SECTION_BOUNDARY_INVALID"); if (id !== 0) { if (seen.has(id)) return invalidModule("STANDARD_SECTION_DUPLICATE"); seen.add(id); if (SECTION_RANK[id] < lastRank) return invalidModule("STANDARD_SECTION_ORDER_INVALID"); lastRank = SECTION_RANK[id]; } if (id === 7) exportPayload = bytes.subarray(offset, end); if (id === 12) dataCountPayload = bytes.subarray(offset, end); if (id === 11) dataPayload = bytes.subarray(offset, end); offset = end; }
  return { valid: true, code: "VALID", exportPayload, dataCountPayload, dataPayload };
}
function invalidExport(code, present = true) { return { valid: false, present, code, count: null, payloadBytes: null, payloadSha256: null, entries: [] }; }
function parseExportPayload(payload) {
  if (payload === null) return { valid: true, present: false, code: "ABSENT", count: 0, payloadBytes: 0, payloadSha256: null, entries: [] };
  const vector = readU32Leb(payload, 0, payload.length); if (!vector.ok) return invalidExport(`VECTOR_${vector.code}`); if (vector.value > MAX_EXPORTS) return invalidExport("EXPORT_COUNT_CAP"); let offset = vector.next, totalNameBytes = 0; const entries = [];
  for (let ordinal = 0; ordinal < vector.value; ordinal += 1) { const length = readU32Leb(payload, offset, payload.length); if (!length.ok) return invalidExport(`NAME_${length.code}`); if (length.value > MAX_EXPORT_NAME_BYTES) return invalidExport("EXPORT_NAME_CAP"); const end = length.next + length.value; if (!Number.isSafeInteger(end) || end > payload.length) return invalidExport("EXPORT_NAME_BOUNDARY_INVALID"); totalNameBytes += length.value; if (totalNameBytes > MAX_TOTAL_EXPORT_NAME_BYTES) return invalidExport("TOTAL_EXPORT_NAME_CAP"); const nameBytes = payload.subarray(length.next, end); let name; try { name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes); } catch { return invalidExport("EXPORT_NAME_UTF8_INVALID"); } offset = end; if (offset >= payload.length) return invalidExport("EXPORT_KIND_TRUNCATED"); const kindByte = payload[offset++]; if (kindByte >= KIND_NAMES.length) return invalidExport("EXPORT_KIND_INVALID"); const index = readU32Leb(payload, offset, payload.length); if (!index.ok) return invalidExport(`INDEX_${index.code}`); offset = index.next; entries.push({ ordinal, nameToken: name === TREE_SITTER_NAME ? "TREE_SITTER_SOLIDITY" : "OTHER_EXPORT", nameBytes: nameBytes.length, nameSha256: sha256(nameBytes), kind: KIND_NAMES[kindByte], index: index.value }); }
  if (offset !== payload.length) return invalidExport("EXPORT_TRAILING_BYTES"); return { valid: true, present: true, code: "VALID", count: entries.length, payloadBytes: payload.length, payloadSha256: sha256(payload), entries };
}
function parseCountPayload(payload, label) { if (payload === null) return { valid: true, present: false, code: "ABSENT", count: null, payloadBytes: 0, payloadSha256: null }; const value = readU32Leb(payload, 0, payload.length); if (!value.ok) return { valid: false, present: true, code: `${label}_${value.code}`, count: null, payloadBytes: payload.length, payloadSha256: sha256(payload) }; if (value.next !== payload.length && label === "DATA_COUNT") return { valid: false, present: true, code: "DATA_COUNT_TRAILING_BYTES", count: null, payloadBytes: payload.length, payloadSha256: sha256(payload) }; return { valid: true, present: true, code: "VALID", count: value.value, payloadBytes: payload.length, payloadSha256: sha256(payload) }; }
function exportKey(entry) { return `${entry.nameToken}:${entry.nameBytes}:${entry.nameSha256}:${entry.kind}`; }
function alignExports(generated, published) {
  const queues = new Map(); for (const entry of published.entries) { const key = exportKey(entry); if (!queues.has(key)) queues.set(key, []); queues.get(key).push(entry); }
  const used = new Set(), rows = []; for (const entry of generated.entries) { const queue = queues.get(exportKey(entry)) || []; const other = queue.shift() || null; if (other) used.add(other.ordinal); rows.push({ nameToken: entry.nameToken, nameBytes: entry.nameBytes, nameSha256: entry.nameSha256, kind: entry.kind, generatedOrdinal: entry.ordinal, publishedOrdinal: other && other.ordinal, generatedIndex: entry.index, publishedIndex: other && other.index, indexMatch: !!other && entry.index === other.index, presence: other ? "BOTH" : "GENERATED_ONLY" }); }
  for (const entry of published.entries) if (!used.has(entry.ordinal)) rows.push({ nameToken: entry.nameToken, nameBytes: entry.nameBytes, nameSha256: entry.nameSha256, kind: entry.kind, generatedOrdinal: null, publishedOrdinal: entry.ordinal, generatedIndex: null, publishedIndex: entry.index, indexMatch: false, presence: "PUBLISHED_ONLY" }); return rows;
}
function exportSemanticsEqual(generated, published) { return generated.present === published.present && generated.entries.length === published.entries.length && generated.entries.every((entry, index) => { const other = published.entries[index]; return exportKey(entry) === exportKey(other) && entry.index === other.index; }); }
function countSemanticsEqual(generated, published) { return generated.dataCount.present === published.dataCount.present && generated.dataCount.count === published.dataCount.count && generated.dataSegments.present === published.dataSegments.present && generated.dataSegments.count === published.dataSegments.count; }
function countInconsistent(side) { return side.dataCount.present && (!side.dataSegments.present || side.dataCount.count !== side.dataSegments.count); }
function classify(generated, published) {
  if (!generated.module.valid && !published.module.valid) return CLASSIFICATIONS.BOTH_MODULES_INVALID; if (!generated.module.valid) return CLASSIFICATIONS.GENERATED_MODULE_INVALID; if (!published.module.valid) return CLASSIFICATIONS.PUBLISHED_MODULE_INVALID;
  if (!generated.exports.valid && !published.exports.valid) return CLASSIFICATIONS.BOTH_EXPORTS_INVALID; if (!generated.exports.valid) return CLASSIFICATIONS.GENERATED_EXPORT_INVALID; if (!published.exports.valid) return CLASSIFICATIONS.PUBLISHED_EXPORT_INVALID;
  const generatedCountValid = generated.dataCount.valid && generated.dataSegments.valid, publishedCountValid = published.dataCount.valid && published.dataSegments.valid; if (!generatedCountValid && !publishedCountValid) return CLASSIFICATIONS.BOTH_COUNTS_INVALID; if (!generatedCountValid) return CLASSIFICATIONS.GENERATED_COUNT_INVALID; if (!publishedCountValid) return CLASSIFICATIONS.PUBLISHED_COUNT_INVALID;
  const gi = countInconsistent(generated), pi = countInconsistent(published); if (gi && pi) return CLASSIFICATIONS.BOTH_COUNT_INCONSISTENT; if (gi) return CLASSIFICATIONS.GENERATED_COUNT_INCONSISTENT; if (pi) return CLASSIFICATIONS.PUBLISHED_COUNT_INCONSISTENT;
  const exportsEqual = exportSemanticsEqual(generated.exports, published.exports), countsEqual = countSemanticsEqual(generated, published); if (!exportsEqual && !countsEqual) return CLASSIFICATIONS.EXPORT_AND_DATA_COUNT_DIFFERENCE; if (!exportsEqual) return CLASSIFICATIONS.EXPORT_DIFFERENCE; if (!countsEqual) return CLASSIFICATIONS.DATA_COUNT_DIFFERENCE; return CLASSIFICATIONS.MATCH;
}
function parseArtifact(read) { const module = parseModuleEnvelope(read.bytes); if (!module.valid) return { role: read.role, observedBytes: read.observedBytes, observedSha256: read.observedSha256, module, exports: invalidExport("MODULE_INVALID", false), dataCount: { valid: false, present: false, code: "MODULE_INVALID", count: null, payloadBytes: null, payloadSha256: null }, dataSegments: { valid: false, present: false, code: "MODULE_INVALID", count: null, payloadBytes: null, payloadSha256: null } }; return { role: read.role, observedBytes: read.observedBytes, observedSha256: read.observedSha256, module: { valid: true, code: "VALID" }, exports: parseExportPayload(module.exportPayload), dataCount: parseCountPayload(module.dataCountPayload, "DATA_COUNT"), dataSegments: parseCountPayload(module.dataPayload, "DATA_SECTION") }; }
function diagnoseFixedArtifacts() {
  const generatedRead = readFixedArtifact("generated", GENERATED_REL, GENERATED_EXPECTED, true), publishedRead = readFixedArtifact("published", PUBLISHED_REL, PUBLISHED_EXPECTED, false), artifactReads = generatedRead.artifactReads + publishedRead.artifactReads;
  if (!generatedRead.ok || !publishedRead.ok) return { schema: `${NAMESPACE}/result-v1`, status: "DIAGNOSTIC_INCOMPLETE", classification: CLASSIFICATIONS.READ_INCOMPLETE, artifactReads, processCalls: 0, writes: 0, networkCalls: 0, wasmRuntimeCalls: 0, generated: { code: generatedRead.code }, published: { code: publishedRead.code }, comparison: null, claims: { invocationAuthority: false, parserPromotion: false, detectorRun: false } };
  const generated = parseArtifact(generatedRead), published = parseArtifact(publishedRead), classification = classify(generated, published), alignable = generated.exports.valid && published.exports.valid;
  return { schema: `${NAMESPACE}/result-v1`, status: "DIAGNOSTIC_COMPLETE", classification, classificationPrecedence: CLASSIFICATION_PRECEDENCE, artifactReads, processCalls: 0, writes: 0, networkCalls: 0, wasmRuntimeCalls: 0, generated, published, comparison: { exportSemanticsEqual: alignable ? exportSemanticsEqual(generated.exports, published.exports) : null, dataCountSemanticsEqual: generated.dataCount.valid && generated.dataSegments.valid && published.dataCount.valid && published.dataSegments.valid ? countSemanticsEqual(generated, published) : null, exportAlignment: alignable ? alignExports(generated.exports, published.exports) : [] }, claims: { invocationAuthority: false, parserPromotion: false, detectorRun: false } };
}
function passiveSummary(help = false) { return { schema: `${NAMESPACE}/${help ? "help" : "offline-summary"}-v1`, status: "PASS", packageStatus: STATUS, exactCommand: EXACT_COMMAND, invocationAuthorized: false, artifactReads: 0, packageReads: 0, processCalls: 0, writes: 0, networkCalls: 0, wasmRuntimeCalls: 0 }; }
function main(argv) { if (arguments.length !== 1) throw new Error("CALLER_DEPENDENCIES_REJECTED"); if (!Array.isArray(argv)) throw new Error("ARGUMENTS_REJECTED"); if (argv.length === 0) return passiveSummary(false); if (argv.length === 1 && argv[0] === HELP_FLAG) return passiveSummary(true); if (argv.length !== 1 || argv[0] !== DIAGNOSE_FLAG) throw new Error("ARGUMENTS_REJECTED"); validateSealedPackage(); return diagnoseFixedArtifacts(); }
if (require.main === module) { try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`); } catch (error) { process.stderr.write(`${JSON.stringify({ status: "FAIL", errorCode: error.message, artifactReads: 0, processCalls: 0, writes: 0, networkCalls: 0, wasmRuntimeCalls: 0 })}\n`); process.exitCode = 1; } }
module.exports = Object.freeze({ NAMESPACE, STATUS, DIAGNOSE_FLAG, HELP_FLAG, EXACT_COMMAND, CLASSIFICATIONS, CLASSIFICATION_PRECEDENCE, validatePackage, main });
