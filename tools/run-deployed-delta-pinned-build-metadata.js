#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");

const SCHEMA = "deployed-delta-pinned-build-metadata/v1";
const WORKSPACE = path.resolve(__dirname, "..");
const OUTPUT = path.join(WORKSPACE, "reports", "monitor", "deployed-delta-pinned-build-metadata.json");
const MAX_RECORDS = 64;
const MAX_DECODED_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const TIMEOUT_MS = 15_000;
const CONTENT_KEYS = Object.freeze(["type", "path", "sha", "size", "encoding", "content"]);
const RECORD_KEYS = Object.freeze([
  "repositoryId", "metadataPath", "pinnedCommitSha", "upstreamExtractorCommitment", "upstreamRecordCommitment",
  "mappingCommitment", "metadataPathCommitment", "manifestBlobCommitment", "declarationCommitment",
  "sourceName", "contractName"
]);
const ROW_KEYS = Object.freeze([
  "upstreamRecordCommitment", "mappingCommitment", "metadataPathCommitment", "manifestBlobCommitment",
  "declarationCommitment", "metadataBlobCommitment", "compilerMetadataCommitment", "compilerSettingsCommitment",
  "standardInputCommitment", "deployedRuntimeCommitment", "buildMetadataCommitment", "status", "reason"
]);
const REASONS = new Set(["EXACT", "METADATA_MISSING", "METADATA_AMBIGUOUS", "METADATA_MALFORMED"]);
const ADDRESS_TEXT = /0x[0-9a-f]{40}(?:[0-9a-f]{24})?/i;
const DOMAIN_TEXT = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|xyz|finance|cloud|invalid)\b/i;
const LEAK_TEXT = /(?:https?|wss?|ftp):\/\/|\bwww\.|authorization\s*:|bearer\s|(?:api|access)[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?token|mnemonic|seed[_-]?phrase|rpc[_-]?(?:url|endpoint)|graphql[_-]?endpoint|\.env\b|\b(?:password|credential|secret)s?\b/i;

class MetadataError extends Error {
  constructor(code) { super(code); this.name = "MetadataError"; this.code = code; }
}

function fail(code) { throw new MetadataError(code); }
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
function sha40(value) { return typeof value === "string" && /^[0-9a-f]{40}$/.test(value); }
function iso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function normalizeNow(now) {
  const value = now === undefined ? Date.now() : (typeof now === "function" ? now() : now);
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) fail("INVALID_NOW");
  return value;
}
function safeRepositoryId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !value.includes("..");
}
function safeManifestPath(value) {
  return typeof value === "string" && value.length > 5 && value.length <= 1024 && value.endsWith(".json")
    && !value.startsWith("/") && !value.includes("\\") && !value.includes("//")
    && !value.split("/").includes("..") && !/[\u0000-\u001f\u007f]/.test(value)
    && !ADDRESS_TEXT.test(value) && !DOMAIN_TEXT.test(value) && !LEAK_TEXT.test(value);
}
function safeSelector(value) {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value) && !ADDRESS_TEXT.test(value) && !DOMAIN_TEXT.test(value)
    && !LEAK_TEXT.test(value));
}
function safetyFields(networkAccess) {
  return {
    localOnly: !networkAccess, networkAccess, rpcAccess: false, processExecution: false, forkUse: false,
    pnlEvaluation: false, signing: false, transactions: false, automaticExecution: false
  };
}
function leakFree(value) {
  const serialized = JSON.stringify(value);
  return !ADDRESS_TEXT.test(serialized) && !DOMAIN_TEXT.test(serialized) && !LEAK_TEXT.test(serialized)
    && !/(?:bytecode|\babi\b|rawCompiler|compilerOutput|sourceText|rawSource|sourceCode|targetAddress|calldata|metadataPath"|repositoryId|pinnedCommitSha)/i.test(serialized);
}

function validRecord(record, upstreamExtractorCommitment) {
  return exactKeys(record, RECORD_KEYS) && record.upstreamExtractorCommitment === upstreamExtractorCommitment
    && safeRepositoryId(record.repositoryId) && safeManifestPath(record.metadataPath) && sha40(record.pinnedCommitSha)
    && [record.upstreamRecordCommitment, record.mappingCommitment, record.metadataPathCommitment,
      record.manifestBlobCommitment, record.declarationCommitment].every((value) => sha64(value))
    && safeSelector(record.sourceName) && safeSelector(record.contractName);
}
function encodedPath(value) { return value.split("/").map(encodeURIComponent).join("/"); }
function contentsUrl(record) {
  if (!validRecord(record, record.upstreamExtractorCommitment)) fail("RECORD_INVALID");
  const repository = record.repositoryId.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${repository}/contents/${encodedPath(record.metadataPath)}?ref=${record.pinnedCommitSha}`;
}
function normalizedHeaders(headers) {
  const result = {};
  if (!ownObject(headers)) return result;
  for (const [key, value] of Object.entries(headers)) {
    result[String(key).toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return result;
}
function responseBytes(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (ownObject(body)) return Buffer.from(JSON.stringify(body), "utf8");
  fail("MALFORMED_RESPONSE");
}
function parseResponse(response, expectedPath) {
  if (!ownObject(response) || !Number.isInteger(response.status)) fail("MALFORMED_RESPONSE");
  if (response.status >= 300 && response.status < 400) fail("REDIRECT_REJECTED");
  if (response.status !== 200) fail("HTTP_FAILURE");
  const headers = normalizedHeaders(response.headers);
  if (!/^application\/(?:json|vnd\.github\+json)(?:\s*;|$)/i.test(headers["content-type"] || "")) {
    fail("CONTENT_TYPE_INVALID");
  }
  const bytes = responseBytes(response.body);
  if (bytes.length <= 0 || bytes.length > MAX_RESPONSE_BYTES) fail("RESPONSE_OVERSIZE");
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch (_) { fail("NON_JSON_RESPONSE"); }
  if (!exactKeys(value, CONTENT_KEYS) || value.type !== "file" || value.path !== expectedPath || !sha40(value.sha)
      || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_DECODED_BYTES
      || value.encoding !== "base64" || typeof value.content !== "string") fail("CONTENT_INVALID");
  return value;
}
function decodeBase64(content, expectedSize) {
  if (/\r(?!\n)/.test(content) || /[^A-Za-z0-9+/=\r\n]/.test(content)) fail("BASE64_INVALID");
  const normalized = content.replace(/\r?\n/g, "");
  if (normalized.length === 0) {
    if (expectedSize !== 0) fail("BASE64_INVALID");
    return Buffer.alloc(0);
  }
  if (normalized.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) fail("BASE64_INVALID");
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length !== expectedSize || decoded.length > MAX_DECODED_BYTES
      || decoded.toString("base64") !== normalized) fail("BASE64_INVALID");
  return decoded;
}
function gitBlobSha(bytes) {
  return crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function boundedJson(value, state = { nodes: 0 }) {
  state.nodes += 1;
  if (state.nodes > 100_000) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 65_536 && value.every((item) => boundedJson(item, state));
  if (!ownObject(value) || Object.keys(value).length > 65_536) return false;
  return Object.values(value).every((item) => boundedJson(item, state));
}
function validStandardInput(input) {
  if (!exactKeys(input, ["language", "sources", "settings"]) || input.language !== "Solidity"
      || !ownObject(input.sources) || Object.keys(input.sources).length === 0 || !ownObject(input.settings)
      || !boundedJson(input)) return false;
  return Object.values(input.sources).every((source) => exactKeys(source, ["content"])
    && typeof source.content === "string");
}
function validCompilerOutput(output) {
  if (!ownObject(output) || !Object.keys(output).every((key) => ["contracts", "sources", "errors"].includes(key))
      || !ownObject(output.contracts) || !ownObject(output.sources || {})) return false;
  if (output.errors !== undefined && !Array.isArray(output.errors)) return false;
  return boundedJson(output);
}
function normalizeBuildInfo(value) {
  if (!exactKeys(value, ["_format", "id", "solcVersion", "solcLongVersion", "input", "output"])
      || value._format !== "hh-sol-build-info-1" || typeof value.id !== "string" || value.id.length === 0
      || value.id.length > 512 || typeof value.solcVersion !== "string" || !/^0\.[0-9]+\.[0-9]+$/.test(value.solcVersion)
      || typeof value.solcLongVersion !== "string" || value.solcLongVersion.length === 0
      || value.solcLongVersion.length > 512 || !validStandardInput(value.input) || !validCompilerOutput(value.output)) return null;
  return {
    compiler: { format: value._format, version: value.solcVersion, longVersion: value.solcLongVersion },
    input: value.input,
    contracts: value.output.contracts
  };
}
function runtimeFromContract(contract) {
  const contractKeys = new Set(["abi", "metadata", "userdoc", "devdoc", "storageLayout", "evm", "ewasm", "ir", "irAst", "irOptimized", "irOptimizedAst"]);
  const evmKeys = new Set(["assembly", "legacyAssembly", "bytecode", "deployedBytecode", "gasEstimates", "methodIdentifiers"]);
  const bytecodeKeys = new Set(["functionDebugData", "generatedSources", "immutableReferences", "linkReferences", "object", "opcodes", "sourceMap"]);
  if (!ownObject(contract) || Object.keys(contract).some((key) => !contractKeys.has(key)) || !ownObject(contract.evm)
      || Object.keys(contract.evm).some((key) => !evmKeys.has(key)) || !ownObject(contract.evm.deployedBytecode)
      || Object.keys(contract.evm.deployedBytecode).some((key) => !bytecodeKeys.has(key))) return null;
  const object = contract.evm.deployedBytecode.object;
  if (typeof object !== "string") return null;
  const normalized = object.startsWith("0x") ? object.slice(2) : object;
  if (normalized.length === 0 || normalized.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(normalized)) return null;
  return Buffer.from(normalized, "hex");
}
function selectContract(contracts, sourceName, contractName) {
  const matches = [];
  for (const source of Object.keys(contracts).sort()) {
    if (!ownObject(contracts[source]) || (sourceName !== null && source !== sourceName)) continue;
    for (const name of Object.keys(contracts[source]).sort()) {
      if (contractName !== null && name !== contractName) continue;
      const runtime = runtimeFromContract(contracts[source][name]);
      if (runtime !== null) matches.push({ source, name, runtime });
    }
  }
  return matches;
}
function parseMetadata(bytes, record) {
  let text, value;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (_) {
    return { status: "UNKNOWN", reason: "METADATA_MALFORMED" };
  }
  try { value = JSON.parse(text); } catch (_) { return { status: "UNKNOWN", reason: "METADATA_MALFORMED" }; }
  const build = normalizeBuildInfo(value);
  if (build === null) return { status: "UNKNOWN", reason: "METADATA_MALFORMED" };
  const matches = selectContract(build.contracts, record.sourceName, record.contractName);
  if (matches.length === 0) return { status: "UNKNOWN", reason: "METADATA_MISSING" };
  if (matches.length !== 1) return { status: "UNKNOWN", reason: "METADATA_AMBIGUOUS" };
  return {
    status: "EXACT", reason: "EXACT",
    compilerMetadataCommitment: domainCommitment("compiler-metadata", build.compiler),
    compilerSettingsCommitment: domainCommitment("compiler-settings", build.input.settings),
    standardInputCommitment: domainCommitment("standard-input", build.input),
    deployedRuntimeCommitment: crypto.createHash("sha256").update(matches[0].runtime).digest("hex")
  };
}

function unknownRow(record, metadataBlobCommitment, reason) {
  return {
    upstreamRecordCommitment: record.upstreamRecordCommitment,
    mappingCommitment: record.mappingCommitment,
    metadataPathCommitment: record.metadataPathCommitment,
    manifestBlobCommitment: record.manifestBlobCommitment,
    declarationCommitment: record.declarationCommitment,
    metadataBlobCommitment,
    compilerMetadataCommitment: null,
    compilerSettingsCommitment: null,
    standardInputCommitment: null,
    deployedRuntimeCommitment: null,
    buildMetadataCommitment: null,
    status: "UNKNOWN",
    reason
  };
}
function exactRow(record, metadataBlobCommitment, parsed, upstreamExtractorCommitment) {
  const row = {
    upstreamRecordCommitment: record.upstreamRecordCommitment,
    mappingCommitment: record.mappingCommitment,
    metadataPathCommitment: record.metadataPathCommitment,
    manifestBlobCommitment: record.manifestBlobCommitment,
    declarationCommitment: record.declarationCommitment,
    metadataBlobCommitment,
    compilerMetadataCommitment: parsed.compilerMetadataCommitment,
    compilerSettingsCommitment: parsed.compilerSettingsCommitment,
    standardInputCommitment: parsed.standardInputCommitment,
    deployedRuntimeCommitment: parsed.deployedRuntimeCommitment
  };
  const body = {
    upstreamExtractorCommitment,
    pinnedProvenanceCommitment: domainCommitment("pinned-provenance", {
      repositoryId: record.repositoryId,
      pinnedCommitSha: record.pinnedCommitSha,
      metadataPath: record.metadataPath
    }),
    ...row
  };
  return { ...row, buildMetadataCommitment: domainCommitment("exact-build-metadata", body), status: "EXACT", reason: "EXACT" };
}
function compareRows(a, b) { return a.upstreamRecordCommitment.localeCompare(b.upstreamRecordCommitment); }
function validateRow(row) {
  if (!exactKeys(row, ROW_KEYS)
      || ![row.upstreamRecordCommitment, row.mappingCommitment, row.metadataPathCommitment,
        row.manifestBlobCommitment, row.declarationCommitment, row.metadataBlobCommitment].every((value) => sha64(value))
      || !sha64(row.compilerMetadataCommitment, true)
      || !sha64(row.compilerSettingsCommitment, true) || !sha64(row.standardInputCommitment, true)
      || !sha64(row.deployedRuntimeCommitment, true) || !sha64(row.buildMetadataCommitment, true)
      || !["EXACT", "UNKNOWN"].includes(row.status) || !REASONS.has(row.reason)) return false;
  const commitments = [row.compilerMetadataCommitment, row.compilerSettingsCommitment, row.standardInputCommitment,
    row.deployedRuntimeCommitment, row.buildMetadataCommitment];
  if (row.status === "UNKNOWN") return row.reason !== "EXACT" && commitments.every((item) => item === null);
  if (row.reason !== "EXACT" || commitments.some((item) => item === null)) return false;
  return true;
}
function validateArtifact(value) {
  try {
    if (!exactKeys(value, [
      "schema", "generatedAt", "status", "upstreamExtractorCommitment", "metadataBatchCommitment",
      "counts", "rows", "safety"
    ]) || value.schema !== SCHEMA || !iso(value.generatedAt) || !["EMPTY", "EXACT", "INCOMPLETE"].includes(value.status)
        || !sha64(value.upstreamExtractorCommitment) || !sha64(value.metadataBatchCommitment)
        || !exactKeys(value.counts, ["exact", "unknown"])
        || Object.values(value.counts).some((count) => !Number.isSafeInteger(count) || count < 0 || count > MAX_RECORDS)
        || !Array.isArray(value.rows) || value.rows.length > MAX_RECORDS
        || value.rows.some((row) => !validateRow(row))
        || JSON.stringify(value.rows) !== JSON.stringify([...value.rows].sort(compareRows))
        || new Set(value.rows.map((row) => row.upstreamRecordCommitment)).size !== value.rows.length
        || value.counts.exact !== value.rows.filter((row) => row.status === "EXACT").length
        || value.counts.unknown !== value.rows.filter((row) => row.status === "UNKNOWN").length
        || value.metadataBatchCommitment !== domainCommitment("metadata-batch", {
          upstreamExtractorCommitment: value.upstreamExtractorCommitment, rows: value.rows
        })
        || !exactKeys(value.safety, [
          "localOnly", "networkAccess", "rpcAccess", "processExecution", "forkUse", "pnlEvaluation",
          "signing", "transactions", "automaticExecution"
        ]) || value.safety.localOnly !== !value.safety.networkAccess
        || value.safety.networkAccess !== (value.rows.length > 0)
        || Object.entries(value.safety).some(([key, item]) => !["localOnly", "networkAccess"].includes(key) && item !== false)
        || !leakFree(value)) return false;
    if (value.rows.length !== value.counts.exact + value.counts.unknown) return false;
    return value.status === "EMPTY" ? value.rows.length === 0
      : value.status === "EXACT" ? value.rows.length > 0 && value.counts.unknown === 0
        : value.rows.length > 0 && value.counts.unknown > 0;
  } catch (_) { return false; }
}

function exactResolver(artifact) {
  if (!validateArtifact(artifact)) fail("ARTIFACT_INVALID");
  const exact = new Map(artifact.rows.filter((row) => row.status === "EXACT")
    .map((row) => [row.upstreamRecordCommitment, row]));
  return function resolve(transientRecord) {
    if (!ownObject(transientRecord) || !sha64(transientRecord.upstreamRecordCommitment)) return null;
    const row = exact.get(transientRecord.upstreamRecordCommitment);
    return row ? {
      buildMetadataCommitment: row.buildMetadataCommitment,
      metadataBlobCommitment: row.metadataBlobCommitment,
      compilerMetadataCommitment: row.compilerMetadataCommitment,
      compilerSettingsCommitment: row.compilerSettingsCommitment,
      standardInputCommitment: row.standardInputCommitment,
      deployedRuntimeCommitment: row.deployedRuntimeCommitment
    } : null;
  };
}

async function extractBatch(options = {}) {
  const now = normalizeNow(options.now);
  const upstreamExtractorCommitment = options.upstreamExtractorCommitment;
  if (!sha64(upstreamExtractorCommitment)) fail("UPSTREAM_EXTRACTOR_COMMITMENT_INVALID");
  const records = options.records;
  if (!Array.isArray(records) || records.length > MAX_RECORDS) fail("RECORDS_INVALID");
  if (records.some((record) => !validRecord(record, upstreamExtractorCommitment))) fail("RECORD_INVALID");
  if (new Set(records.map((record) => record.upstreamRecordCommitment)).size !== records.length) fail("RECORD_DUPLICATE");
  const sorted = [...records].sort((a, b) => a.upstreamRecordCommitment.localeCompare(b.upstreamRecordCommitment));
  if (sorted.length > 0 && typeof options.transport !== "function") fail("TRANSPORT_MISSING");
  const rows = [];
  for (const record of sorted) {
    const url = contentsUrl(record);
    let response;
    try { response = await options.transport(url, { headers: { accept: "application/vnd.github+json" }, timeoutMs: TIMEOUT_MS }); }
    catch (error) { if (error instanceof MetadataError) throw error; fail("TRANSPORT_FAILURE"); }
    const contents = parseResponse(response, record.metadataPath);
    const decoded = decodeBase64(contents.content, contents.size);
    if (gitBlobSha(decoded) !== contents.sha) fail("GIT_BLOB_MISMATCH");
    const metadataBlobCommitment = crypto.createHash("sha256").update(decoded).digest("hex");
    const parsed = parseMetadata(decoded, record);
    rows.push(parsed.status === "EXACT"
      ? exactRow(record, metadataBlobCommitment, parsed, upstreamExtractorCommitment)
      : unknownRow(record, metadataBlobCommitment, parsed.reason));
  }
  const status = rows.length === 0 ? "EMPTY" : rows.some((row) => row.status === "UNKNOWN") ? "INCOMPLETE" : "EXACT";
  const artifact = {
    schema: SCHEMA,
    generatedAt: new Date(now).toISOString(),
    status,
    upstreamExtractorCommitment,
    metadataBatchCommitment: domainCommitment("metadata-batch", { upstreamExtractorCommitment, rows }),
    counts: { exact: rows.filter((row) => row.status === "EXACT").length, unknown: rows.filter((row) => row.status === "UNKNOWN").length },
    rows,
    safety: safetyFields(rows.length > 0)
  };
  if (!validateArtifact(artifact)) fail("ARTIFACT_INVALID");
  return artifact;
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
async function runAndPublish(options = {}) {
  const artifact = await extractBatch(options);
  publishAtomic(artifact, { fsImpl: options.fsImpl || fs, outputPath: options.outputPath || OUTPUT });
  return artifact;
}
async function main(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    process.stderr.write("deployed-delta-pinned-build-metadata: unsupported arguments\n");
    process.exitCode = 2;
    return;
  }
  try {
    const upstreamExtractorCommitment = domainCommitment("empty-upstream-extractor", []);
    const artifact = await runAndPublish({ records: [], upstreamExtractorCommitment });
    process.stdout.write(`deployed-delta-pinned-build-metadata: EMPTY ${artifact.metadataBatchCommitment}\n`);
  } catch (error) {
    process.stderr.write(`deployed-delta-pinned-build-metadata: ${error instanceof MetadataError ? error.code : "FAILED"}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  SCHEMA, OUTPUT, MetadataError, domainCommitment, contentsUrl, gitBlobSha, parseMetadata,
  validateArtifact, exactResolver, extractBatch, publishAtomic, runAndPublish, main
});

if (require.main === module) main();
