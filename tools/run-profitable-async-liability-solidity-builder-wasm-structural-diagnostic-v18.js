#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const WORKSPACE = path.resolve(__dirname, "..");
const NAMESPACE = "profitable-async-liability-solidity-builder-wasm-structural-diagnostic-v18";
const STATUS = "SEALED_READ_ONLY_TWO_INPUT_WASM_STRUCTURAL_DIAGNOSTIC";
const DIAGNOSE_FLAG = "--diagnose-fixed-v16-generated-published-wasm-structure";
const EXACT_COMMAND = `node tools/run-${NAMESPACE}.js ${DIAGNOSE_FLAG}`;
const PACKAGE_REL = `tools/vendor/${NAMESPACE}`;
const V16 = "profitable-async-liability-solidity-builder-exit-validated-two-build-executor-v16-production-v1";
const V17 = "profitable-async-liability-solidity-builder-quarantined-output-diagnostic-v17";
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
const MAX_CUSTOM_NAME_BYTES = 256;
const HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const CUSTOM_TOKENS = Object.freeze(new Set(["name", "producers", "sourceMappingURL", "dylink.0", "target_features", "linking", "reloc.CODE", "reloc.DATA", "emscripten_metadata"]));
const CLASSIFICATIONS = Object.freeze({
  IDENTICAL: "BYTE_IDENTICAL",
  METADATA: "CUSTOM_METADATA_ONLY_DIFFERENCE",
  CODE: "CODE_SECTION_DIFFERENCE",
  STANDARD: "STANDARD_SECTION_CONTENT_DIFFERENCE",
  STRUCTURE: "SECTION_STRUCTURE_DIFFERENCE",
  GENERATED_INVALID: "GENERATED_WASM_INVALID",
  PUBLISHED_INVALID: "PUBLISHED_WASM_INVALID",
  BOTH_INVALID: "BOTH_WASM_INVALID",
  INCOMPLETE: "READ_OR_IDENTITY_INCOMPLETE"
});
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
  exactKeys(manifest, ["schema", "namespace", "status", "diagnosticFlag", "inputs", "limits", "successorRecords", "v17BindingRecords", "v16ManifestRecords"]);
  assert.equal(manifest.schema, `${NAMESPACE}/package-manifest-v1`); assert.equal(manifest.namespace, NAMESPACE); assert.equal(manifest.status, STATUS); assert.equal(manifest.diagnosticFlag, DIAGNOSE_FLAG);
  assert.deepEqual(manifest.inputs, { generated: { path: GENERATED_REL, ...GENERATED_EXPECTED }, published: { path: PUBLISHED_REL, ...PUBLISHED_EXPECTED } });
  assert.deepEqual(manifest.limits, { artifactReads: 2, maximumArtifactBytes: MAX_ARTIFACT_BYTES, chunkBytes: CHUNK_BYTES, maximumSections: MAX_SECTIONS, maximumCustomNameBytes: MAX_CUSTOM_NAME_BYTES, processCalls: 0, writes: 0, networkCalls: 0, wasmRuntimeCalls: 0 });
  for (const records of [manifest.v17BindingRecords, manifest.v16ManifestRecords, manifest.successorRecords]) for (const record of records) verifyRecord(record);
  const policy = JSON.parse(fs.readFileSync(safePath(`${PACKAGE_REL}/diagnostic-policy.json`, "file")));
  exactKeys(policy, ["schema", "namespace", "status", "productionSurface", "readOnly", "inputs", "v17Observation", "parser", "classifications", "counters", "claims"]);
  assert.equal(policy.schema, `${NAMESPACE}/diagnostic-policy-v1`); assert.equal(policy.namespace, NAMESPACE); assert.equal(policy.status, STATUS); assert.equal(policy.productionSurface, "FIXED_CONSTANTS_NO_INJECTION"); assert.equal(policy.readOnly, true);
  assert.deepEqual(policy.inputs, manifest.inputs); assert.deepEqual(policy.v17Observation, { resultCode: "OBSERVED_BYTES_MISMATCH", observedBytes: GENERATED_EXPECTED.bytes, observedSha256: GENERATED_EXPECTED.sha256, expectedBytes: PUBLISHED_EXPECTED.bytes, expectedSha256: PUBLISHED_EXPECTED.sha256, wasmHeaderValid: true, artifactReads: 1 });
  assert.deepEqual(policy.parser, { fullModule: true, canonicalU32Leb: true, sectionBoundaries: true, standardOrderAndDuplicates: true, customNameUtf8: true, unknownCustomNamesHashedOnly: true, maximumSections: MAX_SECTIONS, maximumCustomNameBytes: MAX_CUSTOM_NAME_BYTES });
  assert.deepEqual(policy.classifications, Object.values(CLASSIFICATIONS)); assert.deepEqual(policy.counters, { artifactReads: 2, processCalls: 0, writes: 0, networkCalls: 0, wasmRuntimeCalls: 0 });
  assert.deepEqual(policy.claims, { execution: false, build: false, retry: false, reproducibility: false, parserPromotion: false, detectorRun: false });
  const authorityBytes = fs.readFileSync(safePath(authorityRel, "file")), detachedBytes = fs.readFileSync(safePath(detachedRel, "file")), match = /^([0-9a-f]{64})  authority-manifest\.json\n$/.exec(detachedBytes.toString("utf8")); assert.ok(match, "PACKAGE_INVALID"); assert.equal(sha256(authorityBytes), match[1], "PACKAGE_INVALID");
  const authority = JSON.parse(authorityBytes); exactKeys(authority, ["schema", "namespace", "status", "runner", "tests", "report", "policy", "packageManifest", "v17BindingRecords", "v16ManifestRecords", "claims", "detachedChecksumRole"]);
  assert.equal(authority.schema, `${NAMESPACE}/authority-v1`); assert.equal(authority.namespace, NAMESPACE); assert.equal(authority.status, STATUS); ["runner", "tests", "report", "policy"].forEach((role, index) => assert.deepEqual(authority[role], manifest.successorRecords[index])); assert.deepEqual(authority.packageManifest, fileRecord(manifestRel)); assert.deepEqual(authority.v17BindingRecords, manifest.v17BindingRecords); assert.deepEqual(authority.v16ManifestRecords, manifest.v16ManifestRecords); assert.deepEqual(authority.claims, policy.claims); assert.equal(authority.detachedChecksumRole, "INTEGRITY_ONLY_NOT_EXECUTION_AUTHORITY");
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
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" && fs.constants.O_NOFOLLOW !== 0;
  const identityChains = [chain, outAChain, outBChain].filter(Boolean);
  if (!noFollow && !identityChains.every((item) => item.components.every((entry) => reliable(entry.identity.dev) && reliable(entry.identity.ino)))) return { ok: false, artifactReads: 0, code: "ARTIFACT_PATH_UNSAFE" };
  let fd; try { fd = fs.openSync(chain.absolute, fs.constants.O_RDONLY | (noFollow ? fs.constants.O_NOFOLLOW : 0)); } catch { return { ok: false, artifactReads: 0, code: "ARTIFACT_READ_FAILED" }; }
  let before, after, bytes = null, readFailed = false, pathChanged = false;
  try {
    try { before = fs.fstatSync(fd); } catch { return { ok: false, artifactReads: 1, code: "ARTIFACT_READ_FAILED" }; }
    if (!sameIdentity(identity(before), chain.final.identity) || identity(before).type !== "FILE") return { ok: false, artifactReads: 1, code: "ARTIFACT_PATH_UNSAFE" };
    if (!revalidatePathChain(chain) || (requireQuarantine && (!revalidatePathChain(outAChain) || !revalidatePathChain(outBChain) || !quarantineListingValid(outAChain, outBChain)))) return { ok: false, artifactReads: 1, code: "ARTIFACT_PATH_UNSAFE" };
    if (!Number.isSafeInteger(before.size) || before.size < 0) return { ok: false, artifactReads: 1, code: "ARTIFACT_READ_FAILED" };
    if (before.size > MAX_ARTIFACT_BYTES) { try { after = fs.fstatSync(fd); } catch { return { ok: false, artifactReads: 1, code: "ARTIFACT_READ_FAILED" }; } pathChanged = !revalidatePathChain(chain) || (requireQuarantine && (!revalidatePathChain(outAChain) || !revalidatePathChain(outBChain) || !quarantineListingValid(outAChain, outBChain))); if (pathChanged || !sameMetadata(before, after)) return { ok: false, artifactReads: 1, code: "ARTIFACT_CHANGED_DURING_READ" }; return { ok: false, artifactReads: 1, code: "ARTIFACT_TOO_LARGE", observedBytes: before.size }; }
    bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { let count; try { count = fs.readSync(fd, bytes, offset, Math.min(CHUNK_BYTES, bytes.length - offset), offset); } catch { readFailed = true; break; } if (!Number.isSafeInteger(count) || count <= 0) { readFailed = true; break; } offset += count; }
    try { after = fs.fstatSync(fd); } catch { readFailed = true; }
    pathChanged = !revalidatePathChain(chain) || (requireQuarantine && (!revalidatePathChain(outAChain) || !revalidatePathChain(outBChain) || !quarantineListingValid(outAChain, outBChain)));
    if (readFailed || !after) return { ok: false, artifactReads: 1, code: "ARTIFACT_READ_FAILED" };
    if (pathChanged || !sameMetadata(before, after)) return { ok: false, artifactReads: 1, code: "ARTIFACT_CHANGED_DURING_READ" };
  } finally { try { fs.closeSync(fd); } catch { readFailed = true; } }
  if (readFailed || bytes === null) return { ok: false, artifactReads: 1, code: "ARTIFACT_READ_FAILED" };
  const observedSha256 = sha256(bytes); return { ok: true, artifactReads: 1, role, bytes, observedBytes: bytes.length, observedSha256, expectedBytesMatch: bytes.length === expected.bytes, expectedSha256Match: observedSha256 === expected.sha256 };
}

function readU32Leb(bytes, offset, end) {
  let value = 0, shift = 0, cursor = offset;
  for (let count = 1; count <= 5; count += 1) { if (cursor >= end) return { ok: false, code: "LEB_TRUNCATED" }; const byte = bytes[cursor++]; if (count === 5 && (byte & 0xf0) !== 0) return { ok: false, code: "LEB_OVERFLOW" }; value += (byte & 0x7f) * (2 ** shift); if ((byte & 0x80) === 0) { const minimal = value < 0x80 ? 1 : value < 0x4000 ? 2 : value < 0x200000 ? 3 : value < 0x10000000 ? 4 : 5; if (count !== minimal) return { ok: false, code: "LEB_NON_CANONICAL" }; return { ok: true, value, next: cursor, bytes: count }; } shift += 7; }
  return { ok: false, code: "LEB_OVERFLOW" };
}
function invalidParse(code) { return { valid: false, parseCode: code, sectionCount: 0, sectionProjectionSha256: null, hasImportSection: false, hasExportSection: false, hasCodeSection: false, hasDataSection: false, sections: [] }; }
function parseWasm(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || !bytes.subarray(0, 8).equals(HEADER)) return invalidParse(bytes && bytes.length >= 4 && bytes.subarray(0, 4).equals(HEADER.subarray(0, 4)) ? "VERSION_INVALID" : "MAGIC_INVALID");
  const sections = [], seen = new Set(); let offset = 8, lastRank = 0;
  while (offset < bytes.length) {
    if (sections.length >= MAX_SECTIONS) return invalidParse("SECTION_COUNT_CAP");
    const sectionOffset = offset, id = bytes[offset++]; if (!Object.hasOwn(SECTION_NAMES, id)) return invalidParse("SECTION_ID_INVALID");
    const length = readU32Leb(bytes, offset, bytes.length); if (!length.ok) return invalidParse(length.code); offset = length.next;
    const payloadOffset = offset, payloadEnd = payloadOffset + length.value; if (!Number.isSafeInteger(payloadEnd) || payloadEnd > bytes.length) return invalidParse("SECTION_BOUNDARY_INVALID");
    let customNameToken = null, customNameBytes = null, customNameSha256 = null;
    if (id === 0) {
      const nameLength = readU32Leb(bytes, payloadOffset, payloadEnd); if (!nameLength.ok) return invalidParse(`CUSTOM_NAME_${nameLength.code}`); if (nameLength.value > MAX_CUSTOM_NAME_BYTES) return invalidParse("CUSTOM_NAME_CAP"); const nameEnd = nameLength.next + nameLength.value; if (nameEnd > payloadEnd) return invalidParse("CUSTOM_NAME_BOUNDARY_INVALID"); const nameBytes = bytes.subarray(nameLength.next, nameEnd); let decoded; try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes); } catch { return invalidParse("CUSTOM_NAME_UTF8_INVALID"); } customNameBytes = nameBytes.length; customNameSha256 = sha256(nameBytes); customNameToken = CUSTOM_TOKENS.has(decoded) ? decoded : "UNKNOWN";
    } else {
      if (seen.has(id)) return invalidParse("STANDARD_SECTION_DUPLICATE"); seen.add(id); const rank = SECTION_RANK[id]; if (rank < lastRank) return invalidParse("STANDARD_SECTION_ORDER_INVALID"); lastRank = rank;
    }
    const sectionEnd = payloadEnd, sectionBytes = bytes.subarray(sectionOffset, sectionEnd), payload = bytes.subarray(payloadOffset, payloadEnd);
    sections.push({ index: sections.length, id, type: SECTION_NAMES[id], offset: sectionOffset, totalBytes: sectionEnd - sectionOffset, payloadBytes: length.value, sectionSha256: sha256(sectionBytes), payloadSha256: sha256(payload), customNameToken, customNameBytes, customNameSha256 }); offset = sectionEnd;
  }
  const projection = sections.map((section) => ({ id: section.id, payloadBytes: section.payloadBytes, sectionSha256: section.sectionSha256, customNameToken: section.customNameToken, customNameBytes: section.customNameBytes, customNameSha256: section.customNameSha256 }));
  return { valid: true, parseCode: "VALID", sectionCount: sections.length, sectionProjectionSha256: sha256(Buffer.from(JSON.stringify(projection))), hasImportSection: seen.has(2), hasExportSection: seen.has(7), hasCodeSection: seen.has(10), hasDataSection: seen.has(11), sections };
}
function sectionEqual(a, b, id) { const left = a.sections.find((section) => section.id === id), right = b.sections.find((section) => section.id === id); return left == null && right == null ? true : left != null && right != null && left.sectionSha256 === right.sectionSha256; }
function commonSpans(generated, published) {
  let prefix = 0; while (prefix < generated.length && prefix < published.length && generated[prefix] === published[prefix]) prefix += 1;
  let suffix = 0, maximum = Math.min(generated.length, published.length) - prefix; while (suffix < maximum && generated[generated.length - 1 - suffix] === published[published.length - 1 - suffix]) suffix += 1;
  return { commonPrefix: { bytes: prefix, sha256: sha256(generated.subarray(0, prefix)) }, commonSuffix: { bytes: suffix, generatedOffset: generated.length - suffix, publishedOffset: published.length - suffix, sha256: sha256(generated.subarray(generated.length - suffix)) } };
}
function compareStructures(generatedBytes, publishedBytes, generated, published) {
  const spans = commonSpans(generatedBytes, publishedBytes), standardG = generated.sections.filter((x) => x.id !== 0), standardP = published.sections.filter((x) => x.id !== 0), standardSequenceAligned = JSON.stringify(standardG.map((x) => x.id)) === JSON.stringify(standardP.map((x) => x.id));
  const maximum = Math.max(generated.sections.length, published.sections.length), sectionComparisons = []; let aligned = 0, differing = 0, generatedOnly = 0, publishedOnly = 0;
  for (let index = 0; index < maximum; index += 1) { const g = generated.sections[index] || null, p = published.sections[index] || null, identityAligned = !!g && !!p && g.id === p.id && (g.id !== 0 || (g.customNameToken === p.customNameToken && g.customNameSha256 === p.customNameSha256)); const hashMatch = !!g && !!p && g.sectionSha256 === p.sectionSha256; if (identityAligned) aligned += 1; if (!hashMatch) differing += 1; if (g && !p) generatedOnly += 1; if (p && !g) publishedOnly += 1; sectionComparisons.push({ index, generatedId: g && g.id, publishedId: p && p.id, identityAligned, sizeDelta: g && p ? g.totalBytes - p.totalBytes : null, hashMatch }); }
  const importSectionEqual = sectionEqual(generated, published, 2), exportSectionEqual = sectionEqual(generated, published, 7), codeSectionEqual = sectionEqual(generated, published, 10), dataSectionEqual = sectionEqual(generated, published, 11), standardHashesEqual = standardSequenceAligned && standardG.every((section, index) => section.sectionSha256 === standardP[index].sectionSha256);
  let classification;
  if (generatedBytes.equals(publishedBytes)) classification = CLASSIFICATIONS.IDENTICAL;
  else if (!standardSequenceAligned) classification = CLASSIFICATIONS.STRUCTURE;
  else if (!codeSectionEqual) classification = CLASSIFICATIONS.CODE;
  else if (!standardHashesEqual) classification = CLASSIFICATIONS.STANDARD;
  else classification = CLASSIFICATIONS.METADATA;
  return { classification, byteLengthDelta: generatedBytes.length - publishedBytes.length, ...spans, sectionSequenceAligned: JSON.stringify(generated.sections.map((x) => x.id)) === JSON.stringify(published.sections.map((x) => x.id)), standardSequenceAligned, alignedSectionCount: aligned, differingSectionCount: differing, generatedOnlySectionCount: generatedOnly, publishedOnlySectionCount: publishedOnly, importSectionEqual, exportSectionEqual, codeSectionEqual, dataSectionEqual, projectionEqual: generated.sectionProjectionSha256 === published.sectionProjectionSha256, sectionComparisons };
}
function safeArtifact(read, parsed) { return { role: read.role, expectedBytes: read.role === "generated" ? GENERATED_EXPECTED.bytes : PUBLISHED_EXPECTED.bytes, expectedSha256: read.role === "generated" ? GENERATED_EXPECTED.sha256 : PUBLISHED_EXPECTED.sha256, observedBytes: read.observedBytes, observedSha256: read.observedSha256, expectedBytesMatch: read.expectedBytesMatch, expectedSha256Match: read.expectedSha256Match, wasmValid: parsed.valid, parseCode: parsed.parseCode, sectionCount: parsed.sectionCount, sectionProjectionSha256: parsed.sectionProjectionSha256, hasImportSection: parsed.hasImportSection, hasExportSection: parsed.hasExportSection, hasCodeSection: parsed.hasCodeSection, hasDataSection: parsed.hasDataSection, sections: parsed.sections } }
function incompleteResult(generatedRead, publishedRead) { return { schema: `${NAMESPACE}/structural-result-v1`, status: "DIAGNOSTIC_INCOMPLETE", classification: CLASSIFICATIONS.INCOMPLETE, artifactReads: generatedRead.artifactReads + publishedRead.artifactReads, processCalls: 0, writes: 0, networkCalls: 0, wasmRuntimeCalls: 0, generated: { code: generatedRead.code }, published: { code: publishedRead.code }, comparison: null, claims: { execution: false, parserPromotion: false, detectorRun: false } }; }
function diagnoseFixedArtifacts() {
  const generatedRead = readFixedArtifact("generated", GENERATED_REL, GENERATED_EXPECTED, true), publishedRead = readFixedArtifact("published", PUBLISHED_REL, PUBLISHED_EXPECTED, false); if (!generatedRead.ok || !publishedRead.ok) return incompleteResult(generatedRead, publishedRead);
  const generatedParsed = parseWasm(generatedRead.bytes), publishedParsed = parseWasm(publishedRead.bytes); let comparison = null, classification;
  if (!generatedParsed.valid && !publishedParsed.valid) classification = CLASSIFICATIONS.BOTH_INVALID; else if (!generatedParsed.valid) classification = CLASSIFICATIONS.GENERATED_INVALID; else if (!publishedParsed.valid) classification = CLASSIFICATIONS.PUBLISHED_INVALID; else { comparison = compareStructures(generatedRead.bytes, publishedRead.bytes, generatedParsed, publishedParsed); classification = comparison.classification; }
  return { schema: `${NAMESPACE}/structural-result-v1`, status: generatedParsed.valid && publishedParsed.valid ? "DIAGNOSTIC_COMPLETE" : "DIAGNOSTIC_INVALID_WASM", classification, artifactReads: 2, processCalls: 0, writes: 0, networkCalls: 0, wasmRuntimeCalls: 0, generated: safeArtifact(generatedRead, generatedParsed), published: safeArtifact(publishedRead, publishedParsed), comparison, claims: { execution: false, parserPromotion: false, detectorRun: false } };
}
function defaultSummary(base) { return { schema: `${NAMESPACE}/offline-summary-v1`, status: "PASS", packageStatus: STATUS, artifactReads: 0, processCalls: 0, writes: 0, networkCalls: 0, wasmRuntimeCalls: 0, packageManifestSha256: base.packageManifestSha256, authoritySha256: base.authoritySha256, detachedSha256: base.detachedSha256 }; }
function orchestrate(argv) { if (!Array.isArray(argv) || (argv.length !== 0 && (argv.length !== 1 || argv[0] !== DIAGNOSE_FLAG))) throw new Error("ARGUMENTS_REJECTED"); const base = validateSealedPackage(); return argv.length === 0 ? defaultSummary(base) : diagnoseFixedArtifacts(); }
function main(argv) { if (arguments.length !== 1) throw new Error("CALLER_DEPENDENCIES_REJECTED"); return orchestrate(argv); }
if (require.main === module) { try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`); } catch (error) { process.stderr.write(`${JSON.stringify({ status: "FAIL", errorCode: error.message, artifactReads: 0, processCalls: 0, writes: 0, networkCalls: 0, wasmRuntimeCalls: 0 })}\n`); process.exitCode = 1; } }
module.exports = Object.freeze({ NAMESPACE, STATUS, DIAGNOSE_FLAG, EXACT_COMMAND, CLASSIFICATIONS, validatePackage, main });
