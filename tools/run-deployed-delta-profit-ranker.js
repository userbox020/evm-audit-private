#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const feedModule = require("./build-fresh-deployed-delta-candidate-feed-v1.js");
const sentinelModule = require("./run-official-deployed-delta-sentinel.js");
const scopeModule = require("./deployed-delta-sentinel-scope.js");

const SCHEMA = "deployed-delta-profit-ranker/v1";
const ROUTE_ATTESTATION_SCHEMA = "deployed-delta-profit-route-attestations/v1";
const WORKSPACE = path.resolve(__dirname, "..");
const OUTPUT = path.join(WORKSPACE, "reports", "monitor", "deployed-delta-profit-ranker.json");
const SENTINEL_PATH = path.join(WORKSPACE, "reports", "monitor", "official-deployed-delta-sentinel.json");
const FEED_DIRECTORY = path.join(WORKSPACE, "reports", "monitor", "fresh-deployed-delta-candidate-feed-runs");
const ROUTE_ATTESTATION_PATH = path.join(WORKSPACE, "reports", "monitor", "deployed-delta-profit-route-attestations.json");
const MAX_FILES = 256;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const TRI = new Set(["true", "false", "unknown"]);
const ATTESTATION_GATE_KEYS = Object.freeze([
  "publicLoss", "selfContained", "permissionless", "reproducible", "economicsComplete", "conservativeNetPositive"
]);
const GATE_KEYS = Object.freeze([
  "sourceRuntimeBound", "deploymentFinalized", "publicAccountingPath", "publicLoss", "selfContained",
  "permissionless", "reproducible", "liquidExit", "economicsComplete", "conservativeNetPositive"
]);
const DIAGNOSTIC_ENUMS = Object.freeze({
  sentinelStatus: new Set(["VALID", "INCOMPLETE", "MISSING", "INVALID"]),
  feedStatus: new Set(["VALID", "INCOMPLETE", "MISSING", "INVALID", "MISMATCHED"]),
  feedFresh: new Set(["CURRENT", "STALE", "UNKNOWN"]),
  attestationStatus: new Set(["VALID", "NOT_REQUIRED", "MISSING", "INVALID", "MISMATCHED", "STALE"]),
  failureCode: new Set([
    "NONE", "SENTINEL_MISSING", "SENTINEL_INVALID", "SENTINEL_INCOMPLETE", "FEED_MISSING",
    "FEED_INVALID", "FEED_MISMATCH", "FEED_STALE", "FEED_INCOMPLETE", "ATTESTATION_MISSING",
    "ATTESTATION_INVALID", "ATTESTATION_MISMATCH", "ATTESTATION_STALE", "EVIDENCE_UNKNOWN"
  ])
});

class RankerError extends Error {
  constructor(code) { super(code); this.name = "RankerError"; this.code = code; }
}
function fail(code) { throw new RankerError(code); }
function ownObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) { return feedModule.exactKeys(value, keys); }
function iso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function tri(value) { return typeof value === "string" && TRI.has(value); }
function sha64(value, nullable = false) {
  return (nullable && value === null) || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}
function safeId(value, max = 160) {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && /^[A-Za-z0-9][A-Za-z0-9:_/@+.-]*$/.test(value) && !value.includes("..")
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function andTri(values) {
  if (values.includes("false")) return "false";
  return values.every((value) => value === "true") ? "true" : "unknown";
}
function compareReference(a, b) { return `${a.kind}\0${a.id}\0${a.sha256}`.localeCompare(`${b.kind}\0${b.id}\0${b.sha256}`); }
function mergeReferences(...groups) {
  const values = new Map();
  for (const group of groups) for (const item of group) values.set(feedModule.canonicalJson(item), item);
  return [...values.values()].sort(compareReference).map(feedModule.canonicalValue);
}
function leakFree(value) {
  const text = JSON.stringify(value);
  return !/(?:https?|wss?|ftp):\/\/|\bwww\.|0x[0-9a-f]{40}(?:[0-9a-f]{24})?|authorization\s*:|bearer\s|(?:api|access)[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?token|mnemonic|seed[_-]?phrase|rpc[_-]?(?:url|endpoint)|graphql[_-]?endpoint|\b(?:endpoint|secret|password|credential)s?\b|\.env\b/i.test(text);
}

function validateAttestations(value, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  if (!Number.isSafeInteger(now) || now < 0 || !exactKeys(value, ["schema", "generatedAt", "expiresAt", "feedId", "rows"])
      || value.schema !== ROUTE_ATTESTATION_SCHEMA || !iso(value.generatedAt) || !iso(value.expiresAt)
      || Date.parse(value.expiresAt) <= Date.parse(value.generatedAt)
      || Date.parse(value.generatedAt) > now + MAX_FUTURE_SKEW_MS || Date.parse(value.expiresAt) <= now
      || !sha64(value.feedId) || (options.feedId !== undefined && value.feedId !== options.feedId)
      || !Array.isArray(value.rows) || value.rows.length > MAX_FILES || !leakFree(value)) return false;
  let previous = null;
  for (const row of value.rows) {
    if (!exactKeys(row, ["candidateId", "gates", "references"]) || !sha64(row.candidateId)
        || !exactKeys(row.gates, ATTESTATION_GATE_KEYS) || !ATTESTATION_GATE_KEYS.every((key) => tri(row.gates[key]))
        || !feedModule.validateReferences(row.references) || (previous !== null && previous >= row.candidateId)) return false;
    previous = row.candidateId;
  }
  return feedModule.canonicalBytes(value).length <= MAX_BYTES;
}

function compareRanked(a, b) {
  const weight = { true: 2, unknown: 1, false: 0 };
  for (const key of ["sourceRuntimeBound", "publicLoss", "selfContained", "liquidExit", "conservativeNetPositive"]) {
    const difference = weight[b.gates[key]] - weight[a.gates[key]];
    if (difference) return difference;
  }
  return a.candidateId.localeCompare(b.candidateId);
}
function makeRankedRow(candidate, attestation) {
  const gates = {
    sourceRuntimeBound: andTri([
      candidate.stages.runtimeBound, candidate.stages.runtimeDeltaApplied,
      candidate.stages.sourceExact, candidate.stages.deploymentCurrent
    ]),
    deploymentFinalized: candidate.stages.deploymentFinalized,
    publicAccountingPath: candidate.stages.publicAccountingPath,
    publicLoss: attestation.gates.publicLoss,
    selfContained: attestation.gates.selfContained,
    permissionless: attestation.gates.permissionless,
    reproducible: attestation.gates.reproducible,
    liquidExit: candidate.stages.liquidExit,
    economicsComplete: attestation.gates.economicsComplete,
    conservativeNetPositive: attestation.gates.conservativeNetPositive
  };
  return {
    candidateId: candidate.candidateId,
    deltaId: candidate.deltaId,
    gates,
    blockers: GATE_KEYS.filter((key) => gates[key] !== "true"),
    rank: {
      ordinal: 0,
      runtimeCertainty: gates.sourceRuntimeBound,
      publicLoss: gates.publicLoss,
      selfContained: gates.selfContained,
      liquidExit: gates.liquidExit,
      conservativeNetPositive: gates.conservativeNetPositive
    },
    references: mergeReferences(candidate.references, attestation.references)
  };
}
function finishRanked(rows) {
  return rows.filter((row) => row.blockers.length === 0).sort(compareRanked).map((row, index) => ({
    ...row, rank: { ...row.rank, ordinal: index + 1 }
  }));
}

function baseArtifact(now, diagnostics, inputs = {}, counts = {}) {
  return {
    schema: SCHEMA,
    generatedAt: new Date(now).toISOString(),
    status: "INCOMPLETE",
    trigger: { status: "INCOMPLETE", positive: false, reason: "EVIDENCE_INCOMPLETE" },
    inputs: {
      sentinelCommitment: inputs.sentinelCommitment || null,
      feedCommitment: inputs.feedCommitment || null,
      attestationCommitment: inputs.attestationCommitment || null
    },
    counts: {
      feedCandidates: counts.feedCandidates || 0,
      attestedCandidates: counts.attestedCandidates || 0,
      rankedCandidates: 0
    },
    ranked: [],
    diagnostics,
    safety: {
      localOnly: true, networkAccess: false, rpcAccess: false, forkUse: false, pnlEvaluation: false,
      signing: false, transactions: false, automaticExecution: false
    }
  };
}
function setOutcome(artifact, status, ranked = []) {
  artifact.status = status;
  artifact.trigger = status === "READY"
    ? { status, positive: true, reason: "QUALIFYING_CANDIDATE_READY" }
    : status === "EMPTY"
      ? { status, positive: false, reason: "NO_QUALIFYING_CANDIDATE" }
      : { status, positive: false, reason: "EVIDENCE_INCOMPLETE" };
  artifact.ranked = status === "READY" ? ranked : [];
  artifact.counts.rankedCandidates = artifact.ranked.length;
  return artifact;
}

function rank(options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) fail("INVALID_NOW");
  const diagnostics = {
    sentinelStatus: options.sentinelState || "VALID",
    feedStatus: options.feedState || "VALID",
    feedFresh: options.feedFresh || "CURRENT",
    attestationStatus: options.attestationState || "VALID",
    failureCode: "NONE"
  };
  const sentinel = options.sentinel;
  const feed = options.feed;
  const attestations = options.attestations;
  const inputs = {
    sentinelCommitment: sentinel && sentinelModule.validateArtifact(sentinel) ? feedModule.sha256Canonical(sentinel) : null,
    feedCommitment: feed && feedModule.validateFeed(feed) ? feedModule.sha256Canonical(feed) : null,
    attestationCommitment: attestations && validateAttestations(attestations, { now }) ? feedModule.sha256Canonical(attestations) : null
  };
  const artifact = baseArtifact(now, diagnostics, inputs);
  const incomplete = (code) => { diagnostics.failureCode = code; return setOutcome(artifact, "INCOMPLETE"); };

  if (diagnostics.sentinelStatus === "MISSING" || !sentinel) return incomplete("SENTINEL_MISSING");
  if (diagnostics.sentinelStatus === "INVALID" || !sentinelModule.validateArtifact(sentinel)) return incomplete("SENTINEL_INVALID");
  if (diagnostics.sentinelStatus === "INCOMPLETE") return incomplete("SENTINEL_INCOMPLETE");
  // An `incomplete`/`rate-limited` sentinel is acceptable only when every failing
  // repository is a declared exclusion; otherwise fail closed as incomplete.
  if (!scopeModule.assessSentinelScope(sentinel, scopeModule.resolveScope(options.scope, options.scopeConfigPath)).ok) {
    diagnostics.sentinelStatus = "INCOMPLETE";
    return incomplete("SENTINEL_INCOMPLETE");
  }
  const sentinelCommitment = feedModule.sha256Canonical(sentinel);
  if (diagnostics.feedStatus === "INVALID") return incomplete("FEED_INVALID");
  if (diagnostics.feedStatus === "MISMATCHED") return incomplete("FEED_MISMATCH");
  if (diagnostics.feedStatus === "MISSING" || !feed) return incomplete("FEED_MISSING");
  if (!feedModule.validateFeed(feed)) return incomplete("FEED_INVALID");
  artifact.counts.feedCandidates = feed.candidates.length;
  if (feed.inputCommitments.sentinel !== sentinelCommitment || diagnostics.feedStatus === "MISMATCHED") {
    diagnostics.feedStatus = "MISMATCHED";
    return incomplete("FEED_MISMATCH");
  }
  const feedCurrent = Date.parse(feed.generatedAt) <= now + MAX_FUTURE_SKEW_MS && Date.parse(feed.expiresAt) > now;
  if (!feedCurrent || diagnostics.feedFresh === "STALE") {
    diagnostics.feedFresh = "STALE";
    return incomplete("FEED_STALE");
  }
  diagnostics.feedFresh = "CURRENT";
  if (feed.status === "incomplete" || diagnostics.feedStatus === "INCOMPLETE") {
    diagnostics.feedStatus = "INCOMPLETE";
    return incomplete("FEED_INCOMPLETE");
  }
  diagnostics.feedStatus = "VALID";

  if (!attestations) {
    if (diagnostics.attestationStatus === "INVALID") return incomplete("ATTESTATION_INVALID");
    if (diagnostics.attestationStatus === "STALE") return incomplete("ATTESTATION_STALE");
    if (feed.candidates.length === 0 && diagnostics.attestationStatus !== "INVALID") {
      diagnostics.attestationStatus = "NOT_REQUIRED";
      return setOutcome(artifact, "EMPTY");
    }
    diagnostics.attestationStatus = "MISSING";
    return incomplete("ATTESTATION_MISSING");
  }
  if (diagnostics.attestationStatus === "INVALID" || !validateAttestations(attestations, { now })) {
    diagnostics.attestationStatus = diagnostics.attestationStatus === "STALE" ? "STALE" : "INVALID";
    return incomplete(diagnostics.attestationStatus === "STALE" ? "ATTESTATION_STALE" : "ATTESTATION_INVALID");
  }
  artifact.inputs.attestationCommitment = feedModule.sha256Canonical(attestations);
  artifact.counts.attestedCandidates = attestations.rows.length;
  if (attestations.feedId !== feed.feedId || diagnostics.attestationStatus === "MISMATCHED") {
    diagnostics.attestationStatus = "MISMATCHED";
    return incomplete("ATTESTATION_MISMATCH");
  }
  const candidateIds = new Set(feed.candidates.map((row) => row.candidateId));
  if (attestations.rows.some((row) => !candidateIds.has(row.candidateId))) {
    diagnostics.attestationStatus = "MISMATCHED";
    return incomplete("ATTESTATION_MISMATCH");
  }
  diagnostics.attestationStatus = "VALID";
  const byCandidate = new Map(attestations.rows.map((row) => [row.candidateId, row]));
  const rows = [];
  for (const candidate of feed.candidates) {
    const attestation = byCandidate.get(candidate.candidateId);
    if (!attestation) {
      diagnostics.attestationStatus = "MISSING";
      return incomplete("ATTESTATION_MISSING");
    }
    if (ATTESTATION_GATE_KEYS.some((key) => attestation.gates[key] === "unknown")) return incomplete("EVIDENCE_UNKNOWN");
    const row = makeRankedRow(candidate, attestation);
    if (GATE_KEYS.some((key) => row.gates[key] === "unknown")) return incomplete("EVIDENCE_UNKNOWN");
    rows.push(row);
  }
  const ranked = finishRanked(rows);
  return setOutcome(artifact, ranked.length > 0 ? "READY" : "EMPTY", ranked);
}

function strictReadJson(filename, fsImpl = fs) {
  const stat = fsImpl.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_BYTES) fail("INPUT_INVALID");
  const raw = fsImpl.readFileSync(filename);
  if (!Buffer.isBuffer(raw) || raw.length <= 0 || raw.length > MAX_BYTES) fail("INPUT_INVALID");
  try { return JSON.parse(raw.toString("utf8")); } catch (_) { fail("INPUT_INVALID"); }
}
function loadSentinel(filename = SENTINEL_PATH, fsImpl = fs) {
  try {
    const value = strictReadJson(filename, fsImpl);
    return sentinelModule.validateArtifact(value) ? { state: "VALID", value } : { state: "INVALID", value: null };
  } catch (error) {
    if (error && error.code === "ENOENT") return { state: "MISSING", value: null };
    return { state: "INVALID", value: null };
  }
}
function loadFeed(directory, sentinelCommitment, fsImpl = fs) {
  let entries;
  try { entries = fsImpl.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { return error && error.code === "ENOENT" ? { state: "MISSING", value: null } : { state: "INVALID", value: null }; }
  if (entries.length > MAX_FILES || entries.some((entry) => !entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name))) {
    return { state: "INVALID", value: null };
  }
  const matching = [];
  try {
    for (const entry of entries) {
      const value = strictReadJson(path.join(directory, entry.name), fsImpl);
      if (!feedModule.validateFeed(value) || entry.name !== `${value.feedId}.json`) return { state: "INVALID", value: null };
      if (value.inputCommitments.sentinel === sentinelCommitment) matching.push(value);
    }
  } catch (_) { return { state: "INVALID", value: null }; }
  if (matching.length === 0) return { state: entries.length === 0 ? "MISSING" : "MISMATCHED", value: null };
  matching.sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt) || a.feedId.localeCompare(b.feedId));
  return { state: "VALID", value: matching[0] };
}
function loadAttestations(filename, fsImpl = fs) {
  try { return { state: "PRESENT", value: strictReadJson(filename, fsImpl) }; }
  catch (error) { return error && error.code === "ENOENT" ? { state: "MISSING", value: null } : { state: "INVALID", value: null }; }
}

function validateRankedRow(row, index) {
  if (!exactKeys(row, ["candidateId", "deltaId", "gates", "blockers", "rank", "references"])
      || !sha64(row.candidateId) || !safeId(row.deltaId) || !exactKeys(row.gates, GATE_KEYS)
      || !GATE_KEYS.every((key) => tri(row.gates[key])) || !GATE_KEYS.every((key) => row.gates[key] === "true")
      || !Array.isArray(row.blockers) || JSON.stringify(row.blockers) !== JSON.stringify(GATE_KEYS.filter((key) => row.gates[key] !== "true"))
      || !exactKeys(row.rank, ["ordinal", "runtimeCertainty", "publicLoss", "selfContained", "liquidExit", "conservativeNetPositive"])
      || row.rank.ordinal !== index + 1 || row.rank.runtimeCertainty !== row.gates.sourceRuntimeBound
      || row.rank.publicLoss !== row.gates.publicLoss || row.rank.selfContained !== row.gates.selfContained
      || row.rank.liquidExit !== row.gates.liquidExit || row.rank.conservativeNetPositive !== row.gates.conservativeNetPositive
      || !feedModule.validateReferences(row.references)) return false;
  return true;
}
function validateArtifact(value) {
  try {
    if (!exactKeys(value, ["schema", "generatedAt", "status", "trigger", "inputs", "counts", "ranked", "diagnostics", "safety"])
        || value.schema !== SCHEMA || !iso(value.generatedAt) || !["INCOMPLETE", "EMPTY", "READY"].includes(value.status)
        || !exactKeys(value.trigger, ["status", "positive", "reason"]) || value.trigger.status !== value.status
        || typeof value.trigger.positive !== "boolean"
        || !["EVIDENCE_INCOMPLETE", "NO_QUALIFYING_CANDIDATE", "QUALIFYING_CANDIDATE_READY"].includes(value.trigger.reason)
        || value.trigger.positive !== (value.status === "READY")
        || value.trigger.reason !== (value.status === "READY" ? "QUALIFYING_CANDIDATE_READY" : value.status === "EMPTY" ? "NO_QUALIFYING_CANDIDATE" : "EVIDENCE_INCOMPLETE")
        || !exactKeys(value.inputs, ["sentinelCommitment", "feedCommitment", "attestationCommitment"])
        || !Object.values(value.inputs).every((item) => sha64(item, true))
        || !exactKeys(value.counts, ["feedCandidates", "attestedCandidates", "rankedCandidates"])
        || Object.values(value.counts).some((item) => !Number.isSafeInteger(item) || item < 0 || item > MAX_FILES)
        || !Array.isArray(value.ranked) || value.ranked.length > MAX_FILES
        || value.ranked.some((row, index) => !validateRankedRow(row, index))
        || value.counts.rankedCandidates !== value.ranked.length
        || (value.status === "READY") !== (value.ranked.length > 0)
        || !exactKeys(value.diagnostics, ["sentinelStatus", "feedStatus", "feedFresh", "attestationStatus", "failureCode"])
        || Object.entries(DIAGNOSTIC_ENUMS).some(([key, values]) => !values.has(value.diagnostics[key]))
        || (value.status === "INCOMPLETE") !== (value.diagnostics.failureCode !== "NONE")
        || !exactKeys(value.safety, ["localOnly", "networkAccess", "rpcAccess", "forkUse", "pnlEvaluation", "signing", "transactions", "automaticExecution"])
        || value.safety.localOnly !== true || Object.entries(value.safety).some(([key, item]) => key !== "localOnly" && item !== false)
        || !leakFree(value) || feedModule.canonicalBytes(value).length > MAX_BYTES) return false;
    const projected = value.ranked.map((row) => ({ ...row, rank: { ...row.rank, ordinal: 0 } }));
    return JSON.stringify(projected) === JSON.stringify([...projected].sort(compareRanked))
      && new Set(value.ranked.map((row) => row.candidateId)).size === value.ranked.length;
  } catch (_) { return false; }
}

function publishAtomic(artifact, options = {}) {
  if (!validateArtifact(artifact)) fail("ARTIFACT_INVALID");
  const fsImpl = options.fsImpl || fs;
  const outputPath = path.resolve(options.outputPath || OUTPUT);
  const directory = path.dirname(outputPath);
  fsImpl.mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_BYTES) fail("OUTPUT_TOO_LARGE");
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
  const now = options.now === undefined ? Date.now() : (typeof options.now === "function" ? options.now() : options.now);
  const fsImpl = options.fsImpl || fs;
  const sentinelResult = loadSentinel(options.sentinelPath || SENTINEL_PATH, fsImpl);
  const sentinelCommitment = sentinelResult.value ? feedModule.sha256Canonical(sentinelResult.value) : null;
  const feedResult = sentinelCommitment
    ? loadFeed(options.feedDirectory || FEED_DIRECTORY, sentinelCommitment, fsImpl)
    : { state: "MISSING", value: null };
  const attestationResult = loadAttestations(options.attestationPath || ROUTE_ATTESTATION_PATH, fsImpl);
  let attestationState = attestationResult.state === "INVALID" ? "INVALID" : attestationResult.state === "MISSING" ? "MISSING" : "VALID";
  if (attestationResult.value && iso(attestationResult.value.expiresAt) && Date.parse(attestationResult.value.expiresAt) <= now) attestationState = "STALE";
  const artifact = rank({
    now,
    scope: options.scope,
    scopeConfigPath: options.scopeConfigPath,
    sentinel: sentinelResult.value,
    feed: feedResult.value,
    attestations: attestationResult.value,
    sentinelState: sentinelResult.state,
    feedState: feedResult.state,
    feedFresh: feedResult.value && Date.parse(feedResult.value.expiresAt) > now ? "CURRENT" : feedResult.value ? "STALE" : "UNKNOWN",
    attestationState
  });
  publishAtomic(artifact, { fsImpl, outputPath: options.outputPath || OUTPUT });
  return artifact;
}

async function main(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    process.stderr.write("deployed-delta-profit-ranker: unsupported arguments\n");
    process.exitCode = 2;
    return;
  }
  try {
    const artifact = runAndPublish();
    process.stdout.write(`deployed-delta-profit-ranker: ${artifact.status}\n`);
  } catch (error) {
    process.stderr.write(`deployed-delta-profit-ranker: ${error instanceof RankerError ? error.code : "FAILED"}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  SCHEMA, OUTPUT, SENTINEL_PATH, ROUTE_ATTESTATION_SCHEMA, ROUTE_ATTESTATION_PATH, FEED_DIRECTORY,
  MAX_FILES, MAX_BYTES, MAX_FUTURE_SKEW_MS, GATE_KEYS, ATTESTATION_GATE_KEYS, RankerError,
  validateArtifact, validateAttestations, rank, runAndPublish, main, publishAtomic, loadSentinel, loadFeed,
  loadAttestations, leakFree, makeRankedRow, finishRanked
});

if (require.main === module) void main();
