#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SCHEMA = "deployed-delta-build-mapping-resolver/v1";
const WORKSPACE = path.resolve(__dirname, "..");
const OUTPUT = path.join(WORKSPACE, "reports", "monitor", "deployed-delta-build-mapping-resolver.json");
const MAX_RECORDS = 64;
const MAX_MAPPING_NODES = 65_536;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAPPING_KEYS = new Set(["buildInfo", "buildInfoPath", "build_info"]);
const REASONS = new Set(["EXACT", "MAPPING_MISSING", "MAPPING_AMBIGUOUS", "MAPPING_MALFORMED"]);
const RECORD_KEYS = Object.freeze([
  "upstreamRecordCommitment", "manifestBlobCommitment", "declarationCommitment",
  "pinnedCommitCommitment", "parsedMapping"
]);
const ROW_KEYS = Object.freeze([
  "upstreamRecordCommitment", "mappingCommitment", "metadataPathCommitment",
  "sourceSelectorCommitment", "contractSelectorCommitment", "status", "reason"
]);
const ADDRESS_TEXT = /0x[0-9a-f]{40}(?:[0-9a-f]{24})?/i;
const DOMAIN_TEXT = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|xyz|finance|cloud|invalid)\b/i;
const LEAK_TEXT = /(?:https?|wss?|ftp):\/\/|\bwww\.|authorization\s*:|bearer\s|(?:api|access)[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?token|mnemonic|seed[_-]?phrase|rpc[_-]?(?:url|endpoint)|graphql[_-]?endpoint|\.env\b|\b(?:password|credential|secret)s?\b/i;
const TRANSIENT_DETAILS = new WeakMap();

class MappingError extends Error {
  constructor(code) { super(code); this.name = "MappingError"; this.code = code; }
}

function fail(code) { throw new MappingError(code); }
function ownObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) {
  return ownObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!ownObject(value)) return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key]);
  return result;
}
function canonicalJson(value) { return JSON.stringify(canonicalValue(value)); }
function domainCommitment(domain, value) {
  return crypto.createHash("sha256").update(`${SCHEMA}\0${domain}\0`, "utf8")
    .update(canonicalJson(value), "utf8").digest("hex");
}
function sha64(value, nullable = false) {
  return (nullable && value === null) || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}
function iso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function normalizeNow(now) {
  const value = now === undefined ? Date.now() : (typeof now === "function" ? now() : now);
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) fail("INVALID_NOW");
  return value;
}
function safeRelativeJsonPath(value) {
  return typeof value === "string" && value.length > 5 && value.length <= 1024 && value.endsWith(".json")
    && ["artifacts/", "build-info/", ".openzeppelin/", "deployments/"].some((prefix) => value.startsWith(prefix))
    && !value.startsWith("/") && !value.includes("\\") && !value.includes("//")
    && !value.split("/").includes("..") && !/[\u0000-\u001f\u007f]/.test(value)
    && !ADDRESS_TEXT.test(value) && !DOMAIN_TEXT.test(value) && !LEAK_TEXT.test(value);
}
function safeSelector(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value) && !ADDRESS_TEXT.test(value)
    && !DOMAIN_TEXT.test(value) && !LEAK_TEXT.test(value) && !value.includes("\\") && !value.includes("//");
}
function safetyFields() {
  return {
    localOnly: true, networkAccess: false, rpcAccess: false, processExecution: false, forkUse: false,
    pnlEvaluation: false, signing: false, transactions: false, automaticExecution: false
  };
}
function leakFree(value) {
  const serialized = JSON.stringify(value);
  return !ADDRESS_TEXT.test(serialized) && !DOMAIN_TEXT.test(serialized) && !LEAK_TEXT.test(serialized)
    && !/(?:bytecode|\babi\b|rawCompiler|compilerOutput|sourceText|rawSource|sourceCode|targetAddress|calldata|buildInfoPath|build_info|parsedMapping|manifestPath|metadataPath")/i.test(serialized);
}

function validRecord(record) {
  return exactKeys(record, RECORD_KEYS)
    && [record.upstreamRecordCommitment, record.manifestBlobCommitment,
      record.declarationCommitment, record.pinnedCommitCommitment].every((value) => sha64(value))
    && (ownObject(record.parsedMapping) || Array.isArray(record.parsedMapping));
}
function scanMapping(parsedMapping) {
  const stack = [parsedMapping];
  const seen = new Set();
  const candidates = [];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > MAX_MAPPING_NODES) return { reason: "MAPPING_MALFORMED", candidate: null };
    if (current === null || typeof current !== "object") continue;
    if (seen.has(current)) return { reason: "MAPPING_MALFORMED", candidate: null };
    seen.add(current);
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) stack.push(current[index]);
      continue;
    }
    const entries = Object.entries(current).sort(([left], [right]) => left.localeCompare(right));
    for (const [key, value] of entries) {
      if (!MAPPING_KEYS.has(key)) continue;
      if (!safeRelativeJsonPath(value)) return { reason: "MAPPING_MALFORMED", candidate: null };
      let sourceName = null, contractName = null;
      if (Object.prototype.hasOwnProperty.call(current, "sourceName")) {
        if (!safeSelector(current.sourceName)) return { reason: "MAPPING_MALFORMED", candidate: null };
        sourceName = current.sourceName;
      }
      if (Object.prototype.hasOwnProperty.call(current, "contractName")) {
        if (!safeSelector(current.contractName)) return { reason: "MAPPING_MALFORMED", candidate: null };
        contractName = current.contractName;
      }
      candidates.push({ metadataPath: value, sourceName, contractName });
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [, value] = entries[index];
      if (value !== null && typeof value === "object") stack.push(value);
    }
  }
  if (candidates.length === 0) return { reason: "MAPPING_MISSING", candidate: null };
  if (candidates.length !== 1) return { reason: "MAPPING_AMBIGUOUS", candidate: null };
  return { reason: "EXACT", candidate: candidates[0] };
}

function unknownRow(upstreamRecordCommitment, reason) {
  return {
    upstreamRecordCommitment,
    mappingCommitment: null,
    metadataPathCommitment: null,
    sourceSelectorCommitment: null,
    contractSelectorCommitment: null,
    status: "UNKNOWN",
    reason
  };
}
function exactRow(record, candidate, upstreamExtractorCommitment) {
  const metadataPathCommitment = domainCommitment("metadata-path", {
    manifestBlobCommitment: record.manifestBlobCommitment,
    declarationCommitment: record.declarationCommitment,
    pinnedCommitCommitment: record.pinnedCommitCommitment,
    metadataPath: candidate.metadataPath
  });
  const sourceSelectorCommitment = candidate.sourceName === null
    ? null : domainCommitment("source-selector", candidate.sourceName);
  const contractSelectorCommitment = candidate.contractName === null
    ? null : domainCommitment("contract-selector", candidate.contractName);
  const projection = {
    upstreamExtractorCommitment,
    upstreamRecordCommitment: record.upstreamRecordCommitment,
    metadataPathCommitment,
    sourceSelectorCommitment,
    contractSelectorCommitment
  };
  return {
    upstreamRecordCommitment: record.upstreamRecordCommitment,
    mappingCommitment: domainCommitment("exact-mapping", projection),
    metadataPathCommitment,
    sourceSelectorCommitment,
    contractSelectorCommitment,
    status: "EXACT",
    reason: "EXACT"
  };
}
function compareRows(left, right) {
  return left.upstreamRecordCommitment.localeCompare(right.upstreamRecordCommitment);
}
function validateRow(row, upstreamExtractorCommitment) {
  if (!exactKeys(row, ROW_KEYS) || !sha64(row.upstreamRecordCommitment) || !sha64(row.mappingCommitment, true)
      || !sha64(row.metadataPathCommitment, true) || !sha64(row.sourceSelectorCommitment, true)
      || !sha64(row.contractSelectorCommitment, true) || !["EXACT", "UNKNOWN"].includes(row.status)
      || !REASONS.has(row.reason)) return false;
  if (row.status === "UNKNOWN") {
    return row.reason !== "EXACT" && [row.mappingCommitment, row.metadataPathCommitment,
      row.sourceSelectorCommitment, row.contractSelectorCommitment].every((value) => value === null);
  }
  if (row.reason !== "EXACT" || row.mappingCommitment === null || row.metadataPathCommitment === null) return false;
  return row.mappingCommitment === domainCommitment("exact-mapping", {
    upstreamExtractorCommitment,
    upstreamRecordCommitment: row.upstreamRecordCommitment,
    metadataPathCommitment: row.metadataPathCommitment,
    sourceSelectorCommitment: row.sourceSelectorCommitment,
    contractSelectorCommitment: row.contractSelectorCommitment
  });
}
function validateArtifact(value) {
  try {
    if (!exactKeys(value, [
      "schema", "generatedAt", "upstreamExtractorCommitment", "mappingBatchCommitment", "counts", "rows", "safety"
    ]) || value.schema !== SCHEMA || !iso(value.generatedAt) || !sha64(value.upstreamExtractorCommitment)
        || !sha64(value.mappingBatchCommitment) || !exactKeys(value.counts, ["exact", "unknown"])
        || Object.values(value.counts).some((count) => !Number.isSafeInteger(count) || count < 0 || count > MAX_RECORDS)
        || !Array.isArray(value.rows) || value.rows.length > MAX_RECORDS
        || value.rows.some((row) => !validateRow(row, value.upstreamExtractorCommitment))
        || JSON.stringify(value.rows) !== JSON.stringify([...value.rows].sort(compareRows))
        || new Set(value.rows.map((row) => row.upstreamRecordCommitment)).size !== value.rows.length
        || value.counts.exact !== value.rows.filter((row) => row.status === "EXACT").length
        || value.counts.unknown !== value.rows.filter((row) => row.status === "UNKNOWN").length
        || value.rows.length !== value.counts.exact + value.counts.unknown
        || value.mappingBatchCommitment !== domainCommitment("mapping-batch", {
          upstreamExtractorCommitment: value.upstreamExtractorCommitment, rows: value.rows
        })
        || !exactKeys(value.safety, [
          "localOnly", "networkAccess", "rpcAccess", "processExecution", "forkUse", "pnlEvaluation",
          "signing", "transactions", "automaticExecution"
        ]) || value.safety.localOnly !== true
        || Object.entries(value.safety).some(([key, item]) => key !== "localOnly" && item !== false)
        || !leakFree(value)) return false;
    return true;
  } catch (_) { return false; }
}

function resolveBatch(options = {}) {
  const now = normalizeNow(options.now);
  const upstreamExtractorCommitment = options.upstreamExtractorCommitment;
  if (!sha64(upstreamExtractorCommitment)) fail("UPSTREAM_EXTRACTOR_COMMITMENT_INVALID");
  const records = options.records;
  if (!Array.isArray(records) || records.length > MAX_RECORDS) fail("RECORDS_INVALID");
  if (records.some((record) => !validRecord(record))) fail("RECORD_INVALID");
  const grouped = new Map();
  for (const record of records) {
    if (!grouped.has(record.upstreamRecordCommitment)) grouped.set(record.upstreamRecordCommitment, []);
    grouped.get(record.upstreamRecordCommitment).push(record);
  }
  const rows = [];
  const details = new Map();
  for (const [upstreamRecordCommitment, matches] of grouped) {
    if (matches.length !== 1) {
      rows.push(unknownRow(upstreamRecordCommitment, "MAPPING_AMBIGUOUS"));
      continue;
    }
    const record = matches[0];
    const scanned = scanMapping(record.parsedMapping);
    if (scanned.candidate === null) {
      rows.push(unknownRow(upstreamRecordCommitment, scanned.reason));
      continue;
    }
    const row = exactRow(record, scanned.candidate, upstreamExtractorCommitment);
    rows.push(row);
    details.set(upstreamRecordCommitment, Object.freeze({
      metadataPath: scanned.candidate.metadataPath,
      sourceName: scanned.candidate.sourceName,
      contractName: scanned.candidate.contractName,
      mappingCommitment: row.mappingCommitment,
      metadataPathCommitment: row.metadataPathCommitment,
      sourceSelectorCommitment: row.sourceSelectorCommitment,
      contractSelectorCommitment: row.contractSelectorCommitment
    }));
  }
  rows.sort(compareRows);
  const artifact = {
    schema: SCHEMA,
    generatedAt: new Date(now).toISOString(),
    upstreamExtractorCommitment,
    mappingBatchCommitment: domainCommitment("mapping-batch", { upstreamExtractorCommitment, rows }),
    counts: {
      exact: rows.filter((row) => row.status === "EXACT").length,
      unknown: rows.filter((row) => row.status === "UNKNOWN").length
    },
    rows,
    safety: safetyFields()
  };
  if (!validateArtifact(artifact)) fail("ARTIFACT_INVALID");
  TRANSIENT_DETAILS.set(artifact, details);
  return artifact;
}

function exactResolver(artifact) {
  if (!validateArtifact(artifact)) fail("ARTIFACT_INVALID");
  const details = TRANSIENT_DETAILS.get(artifact) || new Map();
  const exact = new Set(artifact.rows.filter((row) => row.status === "EXACT")
    .map((row) => row.upstreamRecordCommitment));
  return function resolve(transientRecord) {
    if (!ownObject(transientRecord) || !sha64(transientRecord.upstreamRecordCommitment)
        || !exact.has(transientRecord.upstreamRecordCommitment)) return null;
    const detail = details.get(transientRecord.upstreamRecordCommitment);
    return detail ? { ...detail } : null;
  };
}

function ensureDirectory(directory, fsImpl) {
  fsImpl.mkdirSync(directory, { recursive: true });
  const stat = fsImpl.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("OUTPUT_DIRECTORY_INVALID");
}
function publishAtomic(artifact, options = {}) {
  if (!validateArtifact(artifact)) fail("ARTIFACT_INVALID");
  const fsImpl = options.fsImpl || fs;
  const outputPath = path.resolve(options.outputPath || OUTPUT);
  const directory = path.dirname(outputPath);
  ensureDirectory(directory, fsImpl);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_OUTPUT_BYTES) fail("OUTPUT_TOO_LARGE");
  const temporary = path.join(directory, `.${path.basename(outputPath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = fsImpl.openSync(temporary, "wx", 0o600);
    fsImpl.writeFileSync(descriptor, bytes);
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    fsImpl.renameSync(temporary, outputPath);
    const readback = fsImpl.readFileSync(outputPath);
    if (!Buffer.isBuffer(readback) || !readback.equals(bytes)) fail("READBACK_INVALID");
    let parsed;
    try { parsed = JSON.parse(readback.toString("utf8")); } catch (_) { fail("READBACK_INVALID"); }
    if (!validateArtifact(parsed)) fail("READBACK_INVALID");
    return outputPath;
  } finally {
    if (descriptor !== undefined) try { fsImpl.closeSync(descriptor); } catch (_) {}
    try { if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary); } catch (_) {}
  }
}
function runAndPublish(options = {}) {
  const artifact = resolveBatch(options);
  publishAtomic(artifact, { fsImpl: options.fsImpl || fs, outputPath: options.outputPath || OUTPUT });
  return artifact;
}
function main(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    process.stderr.write("deployed-delta-build-mapping-resolver: unsupported arguments\n");
    process.exitCode = 2;
    return;
  }
  try {
    const upstreamExtractorCommitment = domainCommitment("empty-upstream-extractor", []);
    const artifact = runAndPublish({ records: [], upstreamExtractorCommitment });
    process.stdout.write(`deployed-delta-build-mapping-resolver: EMPTY ${artifact.mappingBatchCommitment}\n`);
  } catch (error) {
    process.stderr.write(`deployed-delta-build-mapping-resolver: ${error instanceof MappingError ? error.code : "FAILED"}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  SCHEMA, OUTPUT, MappingError, domainCommitment, validateArtifact, resolveBatch,
  exactResolver, publishAtomic, runAndPublish, main
});

if (require.main === module) main();
