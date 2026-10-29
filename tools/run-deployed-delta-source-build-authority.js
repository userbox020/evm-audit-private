#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SCHEMA = "deployed-delta-source-build-authority/v1";
const WORKSPACE = path.resolve(__dirname, "..");
const OUTPUT = path.join(WORKSPACE, "reports", "monitor", "deployed-delta-source-build-authority.json");
const MAX_RECORDS = 64;
const MAX_OUTPUT_BYTES = 256 * 1024;
const TOPOLOGIES = new Set(["DIRECT", "EIP1967_PROXY"]);
const STATUSES = new Set(["EXACT", "UNKNOWN"]);
const RECORD_KEYS = Object.freeze([
  "upstreamExtractorCommitment", "upstreamRecordCommitment", "sourceCommitment", "blobCommitment",
  "declarationCommitment", "compilerSettingsCommitment", "standardInputCommitment",
  "buildRuntimeCommitment", "upstreamMetadataCommitment", "topology"
]);
const ROW_KEYS = Object.freeze([
  "upstreamRecordCommitment", "expectedBuildCommitment", "expectedRuntimeCommitment",
  "metadataCommitment", "topology", "authorityCommitment", "status"
]);
const ADDRESS_TEXT = /0x[0-9a-f]{40}(?:[0-9a-f]{24})?/i;
const DOMAIN_TEXT = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|xyz|finance|cloud|invalid)\b/i;
const LEAK_TEXT = /(?:https?|wss?|ftp):\/\/|\bwww\.|authorization\s*:|bearer\s|(?:api|access)[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?token|mnemonic|seed[_-]?phrase|rpc[_-]?(?:url|endpoint)|graphql[_-]?endpoint|\.env\b|\b(?:password|credential|secret)s?\b/i;

class AuthorityError extends Error {
  constructor(code) { super(code); this.name = "AuthorityError"; this.code = code; }
}

function fail(code) { throw new AuthorityError(code); }
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
  return crypto.createHash("sha256")
    .update(`${SCHEMA}\0${domain}\0`, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
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
function safetyFields() {
  return {
    localOnly: true,
    networkAccess: false,
    rpcAccess: false,
    processExecution: false,
    forkUse: false,
    pnlEvaluation: false,
    signing: false,
    transactions: false,
    automaticExecution: false
  };
}
function leakFree(value) {
  const serialized = JSON.stringify(value);
  return !ADDRESS_TEXT.test(serialized) && !DOMAIN_TEXT.test(serialized) && !LEAK_TEXT.test(serialized)
    && !/(?:bytecode|\babi\b|rawCompiler|compilerOutput|sourceText|rawSource|targetAddress|calldata)/i.test(serialized);
}

function validAuthorityRecord(record, upstreamExtractorCommitment) {
  return exactKeys(record, RECORD_KEYS) && record.upstreamExtractorCommitment === upstreamExtractorCommitment
    && RECORD_KEYS.filter((key) => !["topology"].includes(key)).every((key) => sha64(record[key]))
    && TOPOLOGIES.has(record.topology);
}
function unknownRow(upstreamRecordCommitment) {
  return {
    upstreamRecordCommitment,
    expectedBuildCommitment: null,
    expectedRuntimeCommitment: null,
    metadataCommitment: null,
    topology: null,
    authorityCommitment: null,
    status: "UNKNOWN"
  };
}
function exactRow(record) {
  const authorityProjection = canonicalValue(record);
  return {
    upstreamRecordCommitment: record.upstreamRecordCommitment,
    expectedBuildCommitment: domainCommitment("expected-build", {
      upstreamRecordCommitment: record.upstreamRecordCommitment,
      sourceCommitment: record.sourceCommitment,
      blobCommitment: record.blobCommitment,
      declarationCommitment: record.declarationCommitment,
      compilerSettingsCommitment: record.compilerSettingsCommitment,
      standardInputCommitment: record.standardInputCommitment,
      upstreamMetadataCommitment: record.upstreamMetadataCommitment,
      topology: record.topology
    }),
    expectedRuntimeCommitment: record.buildRuntimeCommitment,
    metadataCommitment: record.upstreamMetadataCommitment,
    topology: record.topology,
    authorityCommitment: domainCommitment("exact-authority", authorityProjection),
    status: "EXACT"
  };
}
function compareRows(a, b) { return a.upstreamRecordCommitment.localeCompare(b.upstreamRecordCommitment); }
function validateRow(row) {
  if (!exactKeys(row, ROW_KEYS) || !sha64(row.upstreamRecordCommitment)
      || !sha64(row.expectedBuildCommitment, true) || !sha64(row.expectedRuntimeCommitment, true)
      || !sha64(row.metadataCommitment, true)
      || !(row.topology === null || TOPOLOGIES.has(row.topology)) || !sha64(row.authorityCommitment, true)
      || !STATUSES.has(row.status)) return false;
  return row.status === "EXACT"
    ? row.expectedBuildCommitment !== null && row.expectedRuntimeCommitment !== null
      && row.metadataCommitment !== null && row.topology !== null && row.authorityCommitment !== null
    : row.expectedBuildCommitment === null && row.expectedRuntimeCommitment === null
      && row.metadataCommitment === null && row.topology === null && row.authorityCommitment === null;
}
function validateArtifact(value) {
  try {
    if (!exactKeys(value, [
      "schema", "generatedAt", "upstreamExtractorCommitment", "authorityBatchCommitment",
      "counts", "rows", "safety"
    ]) || value.schema !== SCHEMA || !iso(value.generatedAt) || !sha64(value.upstreamExtractorCommitment)
        || !sha64(value.authorityBatchCommitment)
        || !exactKeys(value.counts, ["exact", "unknown"])
        || Object.values(value.counts).some((count) => !Number.isSafeInteger(count) || count < 0 || count > MAX_RECORDS)
        || !Array.isArray(value.rows) || value.rows.length > MAX_RECORDS || value.rows.some((row) => !validateRow(row))
        || JSON.stringify(value.rows) !== JSON.stringify([...value.rows].sort(compareRows))
        || new Set(value.rows.map((row) => row.upstreamRecordCommitment)).size !== value.rows.length
        || value.counts.exact !== value.rows.filter((row) => row.status === "EXACT").length
        || value.counts.unknown !== value.rows.filter((row) => row.status === "UNKNOWN").length
        || value.authorityBatchCommitment !== domainCommitment("authority-batch", {
          upstreamExtractorCommitment: value.upstreamExtractorCommitment,
          rows: value.rows
        })
        || !exactKeys(value.safety, [
          "localOnly", "networkAccess", "rpcAccess", "processExecution", "forkUse",
          "pnlEvaluation", "signing", "transactions", "automaticExecution"
        ]) || value.safety.localOnly !== true
        || Object.entries(value.safety).some(([key, item]) => key !== "localOnly" && item !== false)
        || !leakFree(value)) return false;
    return value.rows.length === value.counts.exact + value.counts.unknown;
  } catch (_) { return false; }
}

function resolveBatch(options = {}) {
  const now = normalizeNow(options.now);
  const upstreamExtractorCommitment = options.upstreamExtractorCommitment;
  if (!sha64(upstreamExtractorCommitment)) fail("UPSTREAM_EXTRACTOR_COMMITMENT_INVALID");
  let records = options.records;
  if (!Array.isArray(records) || records.length > MAX_RECORDS) records = [{}];
  const grouped = new Map();
  const invalid = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    let upstream = null;
    try { if (ownObject(record) && sha64(record.upstreamRecordCommitment)) upstream = record.upstreamRecordCommitment; } catch (_) {}
    if (upstream === null) {
      invalid.push({ index, upstreamRecordCommitment: domainCommitment("invalid-upstream-record", { ordinal: index }) });
      continue;
    }
    if (!grouped.has(upstream)) grouped.set(upstream, []);
    grouped.get(upstream).push(record);
  }
  const rows = invalid.map((item) => unknownRow(item.upstreamRecordCommitment));
  for (const [upstreamRecordCommitment, matches] of grouped) {
    rows.push(matches.length === 1 && validAuthorityRecord(matches[0], upstreamExtractorCommitment)
      ? exactRow(matches[0])
      : unknownRow(upstreamRecordCommitment));
  }
  rows.sort(compareRows);
  const artifact = {
    schema: SCHEMA,
    generatedAt: new Date(now).toISOString(),
    upstreamExtractorCommitment,
    authorityBatchCommitment: domainCommitment("authority-batch", { upstreamExtractorCommitment, rows }),
    counts: {
      exact: rows.filter((row) => row.status === "EXACT").length,
      unknown: rows.filter((row) => row.status === "UNKNOWN").length
    },
    rows,
    safety: safetyFields()
  };
  if (!validateArtifact(artifact)) fail("ARTIFACT_INVALID");
  return artifact;
}

function expectedResolver(artifact) {
  if (!validateArtifact(artifact)) fail("ARTIFACT_INVALID");
  const exact = new Map(artifact.rows.filter((row) => row.status === "EXACT")
    .map((row) => [row.upstreamRecordCommitment, row]));
  return function resolve(transientRecord) {
    let upstream = null;
    try {
      if (ownObject(transientRecord) && sha64(transientRecord.upstreamRecordCommitment)) {
        upstream = transientRecord.upstreamRecordCommitment;
      }
    } catch (_) { return null; }
    const row = upstream === null ? null : exact.get(upstream);
    return row ? {
      topology: row.topology,
      expectedBuildCommitment: row.expectedBuildCommitment,
      expectedRuntimeCommitment: row.expectedRuntimeCommitment,
      metadataCommitment: row.metadataCommitment,
      authorityCommitment: row.authorityCommitment
    } : null;
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
    process.stderr.write("deployed-delta-source-build-authority: unsupported arguments\n");
    process.exitCode = 2;
    return;
  }
  try {
    const artifact = runAndPublish({
      records: [], upstreamExtractorCommitment: domainCommitment("empty-upstream-extractor", [])
    });
    process.stdout.write(`deployed-delta-source-build-authority: EMPTY ${artifact.authorityBatchCommitment}\n`);
  } catch (error) {
    process.stderr.write(`deployed-delta-source-build-authority: ${error instanceof AuthorityError ? error.code : "FAILED"}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  SCHEMA, OUTPUT, AuthorityError, domainCommitment, validateArtifact, resolveBatch,
  expectedResolver, publishAtomic, runAndPublish, main
});

if (require.main === module) main();
