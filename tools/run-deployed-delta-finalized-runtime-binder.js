#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SCHEMA = "deployed-delta-finalized-runtime-binder/v1";
const WORKSPACE = path.resolve(__dirname, "..");
const OUTPUT = path.join(WORKSPACE, "reports", "monitor", "deployed-delta-finalized-runtime-binder.json");
const MAX_RECORDS = 64;
const MAX_FAMILIES = 8;
const MAX_OUTPUT_BYTES = 256 * 1024;
const FAMILY_MINIMUM = 2;
const SUPPORTED_TOPOLOGIES = new Set(["DIRECT", "EIP1967_PROXY"]);
const STATUSES = new Set(["PASS", "FAIL", "UNKNOWN", "BLOCKED"]);
const REASONS = new Set([
  "COMPLETE_MATCH", "CORROBORATED_MISMATCH", "INSUFFICIENT_FAMILIES", "FINALIZED_HEADER_DISAGREEMENT",
  "TERMINAL_REREAD_UNSTABLE", "CHAIN_MISMATCH", "CANONICAL_BLOCK_HASH_UNPROVEN",
  "TOPOLOGY_UNSUPPORTED", "EXPECTED_COMMITMENT_MISSING", "OBSERVATION_INCOMPLETE",
  "OBSERVATION_DISAGREEMENT", "AUTHORITY_COMMITMENT_MISSING", "INPUT_INVALID", "QUALIFIER_MISSING",
  "UPSTREAM_COMMITMENT_DUPLICATE"
]);
const ADDRESS_TEXT = /0x[0-9a-f]{40}(?:[0-9a-f]{24})?/i;
const LEAK_TEXT = /(?:https?|wss?|ftp):\/\/|\bwww\.|authorization\s*:|bearer\s|(?:api|access)[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?token|mnemonic|seed[_-]?phrase|rpc[_-]?(?:url|endpoint)|graphql[_-]?endpoint|\.env\b|\b(?:password|credential|secret)s?\b|rawSource|sourceCode|slotValue/i;

class BinderError extends Error {
  constructor(code) { super(code); this.name = "BinderError"; this.code = code; }
}

function fail(code) { throw new BinderError(code); }
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
function iso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function sha64(value, nullable = false) {
  return (nullable && value === null) || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}
function hash32(value) { return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value); }
function numericString(value) { return typeof value === "string" && /^(?:0|[1-9][0-9]{0,19})$/.test(value); }
function chainId(value) { return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value); }
function address(value) { return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value); }
function normalizeNow(now) {
  const value = now === undefined ? Date.now() : (typeof now === "function" ? now() : now);
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) fail("INVALID_NOW");
  return value;
}
function safetyFields(networkAccess = false, rpcAccess = false) {
  return {
    localOnly: !networkAccess, networkAccess, rpcAccess, forkUse: false, pnlEvaluation: false,
    signing: false, transactions: false, automaticExecution: false
  };
}
function leakFree(value) {
  const serialized = JSON.stringify(value);
  return !ADDRESS_TEXT.test(serialized) && !LEAK_TEXT.test(serialized)
    && !/(?:endpoint|provider|address|bytecode|calldata|profit|liquidity|amount|sourceText)/i.test(serialized);
}

function recordMaterial(record) {
  try {
    if (!ownObject(record)) return { invalid: true };
    return {
      upstreamRecordCommitment: typeof record.upstreamRecordCommitment === "string" ? record.upstreamRecordCommitment : null,
      upstreamAuthorityCommitment: typeof record.upstreamAuthorityCommitment === "string" ? record.upstreamAuthorityCommitment : null,
      chainId: typeof record.chainId === "string" ? record.chainId : null,
      topology: typeof record.topology === "string" ? record.topology : null,
      expectedBuildCommitment: typeof record.expectedBuildCommitment === "string" ? record.expectedBuildCommitment : null,
      expectedRuntimeCommitment: typeof record.expectedRuntimeCommitment === "string" ? record.expectedRuntimeCommitment : null
    };
  } catch (_) { return { invalid: true }; }
}
function validRecord(record) {
  try {
    if (!ownObject(record)) return false;
    const allowed = new Set([
      "upstreamRecordCommitment", "upstreamAuthorityCommitment", "chainId", "address", "topology",
      "expectedBuildCommitment", "expectedRuntimeCommitment"
    ]);
    if (Object.keys(record).some((key) => !allowed.has(key)) || !sha64(record.upstreamRecordCommitment)
        || !chainId(record.chainId) || !address(record.address)
        || typeof record.topology !== "string" || record.topology.length === 0 || record.topology.length > 64) return false;
    return [record.upstreamAuthorityCommitment, record.expectedBuildCommitment, record.expectedRuntimeCommitment]
      .every((value) => value === undefined || value === null || sha64(value));
  } catch (_) { return false; }
}
function expectedMaterial(record) {
  if (!sha64(record.expectedBuildCommitment) || !sha64(record.expectedRuntimeCommitment)) return null;
  return { build: record.expectedBuildCommitment, runtime: record.expectedRuntimeCommitment };
}
function headerValid(header) {
  return exactKeys(header, ["number", "hash", "parentHash", "stateRoot", "timestamp"])
    && numericString(header.number) && hash32(header.hash) && hash32(header.parentHash)
    && hash32(header.stateRoot) && numericString(header.timestamp);
}
function normalizeObservation(value) {
  if (!exactKeys(value, [
    "family", "chainId", "header", "terminalHeader", "readBlockHash", "topology",
    "buildCommitment", "runtimeCommitment"
  ]) || typeof value.family !== "string" || value.family.length === 0 || value.family.length > 512
      || !chainId(value.chainId) || !headerValid(value.header) || !headerValid(value.terminalHeader)
      || !hash32(value.readBlockHash) || typeof value.topology !== "string" || value.topology.length > 64
      || !sha64(value.buildCommitment) || !sha64(value.runtimeCommitment)) return null;
  return {
    family: value.family,
    familyCommitment: domainCommitment("operator-family", value.family),
    chainId: value.chainId,
    header: canonicalValue(value.header),
    terminalHeader: canonicalValue(value.terminalHeader),
    readBlockHash: value.readBlockHash,
    topology: value.topology,
    buildCommitment: value.buildCommitment,
    runtimeCommitment: value.runtimeCommitment
  };
}
function observationProjection(observation) {
  return {
    familyCommitment: observation.familyCommitment,
    chainId: observation.chainId,
    header: observation.header,
    terminalHeader: observation.terminalHeader,
    readBlockHash: observation.readBlockHash,
    topology: observation.topology,
    buildCommitment: observation.buildCommitment,
    runtimeCommitment: observation.runtimeCommitment
  };
}
function commonProjection(observation) {
  return {
    chainId: observation.chainId,
    header: observation.header,
    terminalHeader: observation.terminalHeader,
    readBlockHash: observation.readBlockHash,
    topology: observation.topology,
    buildCommitment: observation.buildCommitment,
    runtimeCommitment: observation.runtimeCommitment
  };
}

function conclusion(inputCommitment, expectedCommitment, observationCommitment, status, reason, authorityCommitment = null) {
  const body = { inputCommitment, expectedCommitment, observationCommitment, authorityCommitment, status, reason };
  return { ...body, bindingCommitment: domainCommitment("binding", body) };
}
function resolveObservations(record, index, options) {
  if (typeof options.qualifier === "function") {
    try { return { present: true, value: options.qualifier(record, index) }; }
    catch (_) { return { present: true, value: null }; }
  }
  if (Array.isArray(options.observations)) {
    try { return { present: true, value: options.observations[index] }; }
    catch (_) { return { present: true, value: null }; }
  }
  return { present: false, value: null };
}

function bindRecord(record, index, options) {
  const material = recordMaterial(record);
  const inputCommitment = domainCommitment("transient-record", material);
  if (!validRecord(record)) return conclusion(inputCommitment, null, null, "BLOCKED", "INPUT_INVALID");
  if (options.duplicateUpstreams && options.duplicateUpstreams.has(material.upstreamRecordCommitment)) {
    return conclusion(inputCommitment, null, null, "BLOCKED", "UPSTREAM_COMMITMENT_DUPLICATE");
  }
  const qualifierPresent = typeof options.qualifier === "function" || Array.isArray(options.observations);
  if (!qualifierPresent) return conclusion(inputCommitment, null, null, "BLOCKED", "QUALIFIER_MISSING");
  const expected = expectedMaterial(material);
  const expectedCommitment = expected ? domainCommitment("expected-build-runtime", expected) : null;
  if (!expected) return conclusion(inputCommitment, null, null, "UNKNOWN", "EXPECTED_COMMITMENT_MISSING");
  const authorityCommitment = sha64(material.upstreamAuthorityCommitment) ? material.upstreamAuthorityCommitment : null;
  if (authorityCommitment === null) {
    return conclusion(inputCommitment, expectedCommitment, null, "UNKNOWN", "AUTHORITY_COMMITMENT_MISSING");
  }
  if (!SUPPORTED_TOPOLOGIES.has(material.topology)) {
    return conclusion(inputCommitment, expectedCommitment, null, "UNKNOWN", "TOPOLOGY_UNSUPPORTED", authorityCommitment);
  }
  const resolved = resolveObservations(record, index, options);
  if (!Array.isArray(resolved.value) || resolved.value.length === 0 || resolved.value.length > MAX_FAMILIES) {
    return conclusion(inputCommitment, expectedCommitment, null, "UNKNOWN", "OBSERVATION_INCOMPLETE", authorityCommitment);
  }
  let observations;
  try { observations = resolved.value.map(normalizeObservation); }
  catch (_) { return conclusion(inputCommitment, expectedCommitment, null, "UNKNOWN", "OBSERVATION_INCOMPLETE", authorityCommitment); }
  if (observations.some((item) => item === null)) {
    return conclusion(inputCommitment, expectedCommitment, null, "UNKNOWN", "OBSERVATION_INCOMPLETE", authorityCommitment);
  }
  observations.sort((a, b) => a.familyCommitment.localeCompare(b.familyCommitment));
  const observationCommitment = domainCommitment("finalized-observations", observations.map(observationProjection));
  const families = new Set(observations.map((item) => item.family));
  if (families.size < FAMILY_MINIMUM) {
    return conclusion(inputCommitment, expectedCommitment, observationCommitment, "UNKNOWN", "INSUFFICIENT_FAMILIES", authorityCommitment);
  }
  if (observations.some((item) => canonicalJson(item.header) !== canonicalJson(item.terminalHeader))) {
    return conclusion(inputCommitment, expectedCommitment, observationCommitment, "UNKNOWN", "TERMINAL_REREAD_UNSTABLE", authorityCommitment);
  }
  if (observations.some((item) => item.chainId !== material.chainId)) {
    return conclusion(inputCommitment, expectedCommitment, observationCommitment, "UNKNOWN", "CHAIN_MISMATCH", authorityCommitment);
  }
  if (observations.some((item) => item.readBlockHash !== item.header.hash)) {
    return conclusion(inputCommitment, expectedCommitment, observationCommitment, "UNKNOWN", "CANONICAL_BLOCK_HASH_UNPROVEN", authorityCommitment);
  }
  if (observations.some((item) => !SUPPORTED_TOPOLOGIES.has(item.topology) || item.topology !== material.topology)) {
    return conclusion(inputCommitment, expectedCommitment, observationCommitment, "UNKNOWN", "TOPOLOGY_UNSUPPORTED", authorityCommitment);
  }
  const firstHeader = canonicalJson(observations[0].header);
  if (observations.some((item) => canonicalJson(item.header) !== firstHeader)) {
    return conclusion(inputCommitment, expectedCommitment, observationCommitment, "UNKNOWN", "FINALIZED_HEADER_DISAGREEMENT", authorityCommitment);
  }
  const firstProjection = canonicalJson(commonProjection(observations[0]));
  if (observations.some((item) => canonicalJson(commonProjection(item)) !== firstProjection)) {
    return conclusion(inputCommitment, expectedCommitment, observationCommitment, "UNKNOWN", "OBSERVATION_DISAGREEMENT", authorityCommitment);
  }
  const matches = observations[0].buildCommitment === expected.build
    && observations[0].runtimeCommitment === expected.runtime;
  return conclusion(inputCommitment, expectedCommitment, observationCommitment,
    matches ? "PASS" : "FAIL", matches ? "COMPLETE_MATCH" : "CORROBORATED_MISMATCH", authorityCommitment);
}

function bindingWithoutCommitment(binding) {
  const { bindingCommitment, ...body } = binding;
  return body;
}
function validateBinding(binding) {
  if (!exactKeys(binding, [
    "inputCommitment", "expectedCommitment", "observationCommitment", "authorityCommitment", "status", "reason", "bindingCommitment"
  ]) || !sha64(binding.inputCommitment) || !sha64(binding.expectedCommitment, true)
      || !sha64(binding.observationCommitment, true) || !sha64(binding.authorityCommitment, true)
      || !STATUSES.has(binding.status) || !REASONS.has(binding.reason)
      || !sha64(binding.bindingCommitment)
      || binding.bindingCommitment !== domainCommitment("binding", bindingWithoutCommitment(binding))) return false;
  if (binding.status === "PASS") return binding.reason === "COMPLETE_MATCH" && binding.expectedCommitment !== null
    && binding.observationCommitment !== null && binding.authorityCommitment !== null;
  if (binding.status === "FAIL") return binding.reason === "CORROBORATED_MISMATCH" && binding.expectedCommitment !== null
    && binding.observationCommitment !== null && binding.authorityCommitment !== null;
  if (binding.status === "BLOCKED") return ["INPUT_INVALID", "QUALIFIER_MISSING", "UPSTREAM_COMMITMENT_DUPLICATE"].includes(binding.reason);
  if (binding.reason === "AUTHORITY_COMMITMENT_MISSING") return binding.authorityCommitment === null;
  return !["COMPLETE_MATCH", "CORROBORATED_MISMATCH", "INPUT_INVALID", "QUALIFIER_MISSING", "UPSTREAM_COMMITMENT_DUPLICATE"].includes(binding.reason);
}
function validateArtifact(value) {
  try {
    if (!exactKeys(value, [
      "schema", "generatedAt", "upstreamBatchCommitment", "inputBatchCommitment", "bindingBatchCommitment", "counts",
      "finalizedConsensusFamilyMinimum", "bindings", "safety"
    ]) || value.schema !== SCHEMA || !iso(value.generatedAt) || !sha64(value.inputBatchCommitment)
        || !sha64(value.bindingBatchCommitment) || value.finalizedConsensusFamilyMinimum !== FAMILY_MINIMUM
        || !exactKeys(value.counts, ["pass", "fail", "unknown", "blocked"])
        || Object.values(value.counts).some((count) => !Number.isSafeInteger(count) || count < 0 || count > MAX_RECORDS)
        || !Array.isArray(value.bindings) || value.bindings.length > MAX_RECORDS
        || value.bindings.some((binding) => !validateBinding(binding))
        || JSON.stringify(value.bindings) !== JSON.stringify([...value.bindings].sort((a, b) => a.inputCommitment.localeCompare(b.inputCommitment)))
        || value.counts.pass !== value.bindings.filter((binding) => binding.status === "PASS").length
        || value.counts.fail !== value.bindings.filter((binding) => binding.status === "FAIL").length
        || value.counts.unknown !== value.bindings.filter((binding) => binding.status === "UNKNOWN").length
        || value.counts.blocked !== value.bindings.filter((binding) => binding.status === "BLOCKED").length
        || !sha64(value.upstreamBatchCommitment)
        || value.bindingBatchCommitment !== domainCommitment("binding-batch", {
          upstreamBatchCommitment: value.upstreamBatchCommitment, bindings: value.bindings
        })
        || !exactKeys(value.safety, [
          "localOnly", "networkAccess", "rpcAccess", "forkUse", "pnlEvaluation", "signing", "transactions", "automaticExecution"
        ]) || typeof value.safety.localOnly !== "boolean" || typeof value.safety.networkAccess !== "boolean"
        || typeof value.safety.rpcAccess !== "boolean" || value.safety.localOnly !== !value.safety.networkAccess
        || (value.safety.rpcAccess && !value.safety.networkAccess)
        || Object.entries(value.safety).some(([key, item]) => !["localOnly", "networkAccess", "rpcAccess"].includes(key) && item !== false)
        || !leakFree(value)) return false;
    return value.bindings.length === Object.values(value.counts).reduce((sum, count) => sum + count, 0);
  } catch (_) { return false; }
}

function bindBatch(options = {}) {
  const now = normalizeNow(options.now);
  const upstreamBatchCommitment = options.upstreamBatchCommitment;
  if (!sha64(upstreamBatchCommitment)) fail("UPSTREAM_BATCH_COMMITMENT_INVALID");
  const networkAccess = options.networkAccess === undefined ? false : options.networkAccess;
  const rpcAccess = options.rpcAccess === undefined ? false : options.rpcAccess;
  if (typeof networkAccess !== "boolean" || typeof rpcAccess !== "boolean" || (rpcAccess && !networkAccess)) fail("INVALID_SAFETY");
  let records = options.records;
  if (!Array.isArray(records) || records.length > MAX_RECORDS) records = [{ invalidBatch: true }];
  const upstreamCounts = new Map();
  for (const record of records) {
    let upstream = null;
    try { if (ownObject(record) && sha64(record.upstreamRecordCommitment)) upstream = record.upstreamRecordCommitment; } catch (_) {}
    if (upstream !== null) upstreamCounts.set(upstream, (upstreamCounts.get(upstream) || 0) + 1);
  }
  const duplicateUpstreams = new Set([...upstreamCounts].filter(([, count]) => count > 1).map(([upstream]) => upstream));
  const normalizedInputs = records.map((record, index) => ({
    index,
    material: recordMaterial(record),
    commitment: domainCommitment("transient-record", recordMaterial(record))
  })).sort((a, b) => a.commitment.localeCompare(b.commitment));
  const inputBatchCommitment = domainCommitment("input-batch", {
    upstreamBatchCommitment,
    records: normalizedInputs.map((item) => item.material)
  });
  const bindingOptions = { ...options, duplicateUpstreams };
  const bindings = records.map((record, index) => bindRecord(record, index, bindingOptions))
    .sort((a, b) => a.inputCommitment.localeCompare(b.inputCommitment));
  const artifact = {
    schema: SCHEMA,
    generatedAt: new Date(now).toISOString(),
    upstreamBatchCommitment,
    inputBatchCommitment,
    bindingBatchCommitment: domainCommitment("binding-batch", { upstreamBatchCommitment, bindings }),
    counts: {
      pass: bindings.filter((binding) => binding.status === "PASS").length,
      fail: bindings.filter((binding) => binding.status === "FAIL").length,
      unknown: bindings.filter((binding) => binding.status === "UNKNOWN").length,
      blocked: bindings.filter((binding) => binding.status === "BLOCKED").length
    },
    finalizedConsensusFamilyMinimum: FAMILY_MINIMUM,
    bindings,
    safety: safetyFields(networkAccess, rpcAccess)
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
function runAndPublish(options = {}) {
  const artifact = bindBatch(options);
  publishAtomic(artifact, { fsImpl: options.fsImpl || fs, outputPath: options.outputPath || OUTPUT });
  return artifact;
}
function main(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    process.stderr.write("deployed-delta-finalized-runtime-binder: unsupported arguments\n");
    process.exitCode = 2;
    return;
  }
  try {
    const artifact = runAndPublish({
      records: [], observations: [], upstreamBatchCommitment: domainCommitment("empty-upstream-batch", [])
    });
    process.stdout.write(`deployed-delta-finalized-runtime-binder: EMPTY ${artifact.bindingBatchCommitment}\n`);
  } catch (error) {
    process.stderr.write(`deployed-delta-finalized-runtime-binder: ${error instanceof BinderError ? error.code : "FAILED"}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  SCHEMA, OUTPUT, FAMILY_MINIMUM, BinderError, domainCommitment, validateArtifact, bindBatch,
  publishAtomic, runAndPublish, main
});

if (require.main === module) main();
