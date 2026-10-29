#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sentinelModule = require("./run-official-deployed-delta-sentinel.js");

const EVIDENCE_SCHEMA = "fresh-deployed-delta-candidate-feed/candidate-evidence/v1";
const SUPPRESSION_SCHEMA = "fresh-deployed-delta-candidate-feed/suppression-index/v1";
const FEED_SCHEMA = "fresh-deployed-delta-candidate-feed/v1";
const SENTINEL_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_EVIDENCE_ROWS = 256;
const MAX_SUPPRESSION_ENTRIES = 1024;
const MAX_REFERENCES = 32;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TRI = new Set(["true", "false", "unknown"]);
const CLASSES = new Set(["implementation", "config", "unpause", "oracle", "module", "new-market", "queue"]);
const CRITICAL_STAGES = Object.freeze([
  "sourceExact", "deploymentCurrent", "deploymentFinalized", "runtimeBound", "runtimeDeltaApplied", "fresh"
]);

const EVIDENCE_KEYS = Object.freeze([
  "schema", "evidenceId", "deltaId", "observedAt", "expiresAt", "sentinelBinding", "identity", "delta",
  "source", "deployment", "runtime", "route", "novelty"
]);
const ROW_KEYS = Object.freeze([
  "candidateId", "deltaId", "identity", "delta", "stages", "deploymentTriageEligible", "blockers", "rank", "references"
]);

class FeedError extends Error {
  constructor(code) {
    super(code);
    this.name = "FeedError";
    this.code = code;
  }
}

function fail(code) { throw new FeedError(code); }
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
function canonicalBytes(value) { return Buffer.from(`${canonicalJson(value)}\n`, "utf8"); }
function sha256Bytes(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function sha256Canonical(value) { return sha256Bytes(canonicalBytes(value)); }
function iso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function time(value) { return iso(value) ? Date.parse(value) : NaN; }
function tri(value) { return typeof value === "string" && TRI.has(value); }
function sha40(value, nullable = false) {
  return (nullable && value === null) || (typeof value === "string" && /^[0-9a-f]{40}$/.test(value));
}
function sha64(value, nullable = false) {
  return (nullable && value === null) || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}
function hasUnsafeText(value) {
  return /[\u0000-\u001f\u007f]/.test(value)
    || /(?:https?|wss?|ftp):\/\/|\bwww\./i.test(value)
    || /0x[0-9a-f]{8,}/i.test(value)
    || /(?:ghp_|github_pat_|private[_-]?key|client[_-]?secret|access[_-]?token|authorization\s*:)/i.test(value)
    || /^(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|xyz|finance|cloud|invalid)$/i.test(value);
}
function safeText(value, max = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= max && !hasUnsafeText(value);
}
function safeId(value, max = 160) {
  return safeText(value, max) && /^[A-Za-z0-9][A-Za-z0-9:_/@+.-]*$/.test(value) && !value.includes("..");
}
function safeRepoId(value) {
  return safeText(value, 200) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !value.includes("..");
}
function safePath(value) {
  return safeText(value, 1024) && !value.startsWith("/") && !value.includes("\\")
    && !value.split("/").includes("..") && !value.includes("//");
}
function safeSymbol(value) { return safeText(value, 256) && !/[\r\n]/.test(value); }
function safeChainId(value) { return typeof value === "string" && /^(?:[1-9][0-9]{0,19})$/.test(value); }
function sortedUnique(values, comparator) {
  if (!Array.isArray(values)) return false;
  const sorted = [...values].sort(comparator);
  return JSON.stringify(values) === JSON.stringify(sorted) && new Set(values.map((item) => canonicalJson(item))).size === values.length;
}
function compareReference(a, b) { return `${a.kind}\0${a.id}\0${a.sha256}`.localeCompare(`${b.kind}\0${b.id}\0${b.sha256}`); }
function validateReferences(value) {
  return Array.isArray(value) && value.length <= MAX_REFERENCES
    && value.every((item) => exactKeys(item, ["kind", "id", "sha256"])
      && safeId(item.kind, 64) && safeId(item.id, 200) && sha64(item.sha256))
    && sortedUnique(value, compareReference);
}
function validateIdentity(value) {
  return exactKeys(value, ["protocol", "chainId", "targetCommitment"])
    && safeId(value.protocol, 120) && safeChainId(value.chainId) && sha64(value.targetCommitment);
}
function validateDelta(value) {
  if (!exactKeys(value, ["classes", "affectedLocations"]) || !Array.isArray(value.classes)
      || value.classes.length < 1 || value.classes.length > CLASSES.size
      || value.classes.some((item) => !CLASSES.has(item))
      || !sortedUnique(value.classes, (a, b) => a.localeCompare(b))
      || !Array.isArray(value.affectedLocations) || value.affectedLocations.length < 1
      || value.affectedLocations.length > 256) return false;
  const locationsValid = value.affectedLocations.every((item) => exactKeys(item, ["path", "startLine", "endLine", "symbol", "side"])
    && safePath(item.path) && Number.isSafeInteger(item.startLine) && item.startLine >= 1
    && Number.isSafeInteger(item.endLine) && item.endLine >= item.startLine && item.endLine <= 10_000_000
    && safeSymbol(item.symbol) && item.side === "head");
  return locationsValid && sortedUnique(value.affectedLocations, (a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}
function validateEvidenceRow(row) {
  if (!exactKeys(row, EVIDENCE_KEYS) || row.schema !== EVIDENCE_SCHEMA || !safeId(row.evidenceId)
      || !safeId(row.deltaId) || !iso(row.observedAt) || !iso(row.expiresAt)
      || time(row.expiresAt) <= time(row.observedAt)
      || !exactKeys(row.sentinelBinding, ["runId", "repositoryId", "previousHeadSha", "observedHeadSha"])
      || !safeId(row.sentinelBinding.runId) || !safeRepoId(row.sentinelBinding.repositoryId)
      || !sha40(row.sentinelBinding.previousHeadSha, true) || !sha40(row.sentinelBinding.observedHeadSha)
      || !validateIdentity(row.identity) || !validateDelta(row.delta)
      || !exactKeys(row.source, ["exact", "commit", "treeCommitment", "references"])
      || !tri(row.source.exact) || !sha40(row.source.commit, true) || !sha64(row.source.treeCommitment, true)
      || !validateReferences(row.source.references)
      || !exactKeys(row.deployment, ["current", "finalized", "pinCommitment", "references"])
      || !tri(row.deployment.current) || !tri(row.deployment.finalized)
      || !sha64(row.deployment.pinCommitment, true) || !validateReferences(row.deployment.references)
      || !exactKeys(row.runtime, ["bound", "deltaApplied", "runtimeCommitment", "references"])
      || !tri(row.runtime.bound) || !tri(row.runtime.deltaApplied)
      || !sha64(row.runtime.runtimeCommitment, true) || !validateReferences(row.runtime.references)
      || !exactKeys(row.route, ["publicAccountingPath", "liquidExit", "references"])
      || !tri(row.route.publicAccountingPath) || !tri(row.route.liquidExit) || !validateReferences(row.route.references)
      || !exactKeys(row.novelty, ["status", "references"]) || !tri(row.novelty.status)
      || !validateReferences(row.novelty.references)) return false;
  if (row.source.exact === "true" && row.source.commit !== row.sentinelBinding.observedHeadSha) return false;
  if (row.source.exact === "true" && (row.source.treeCommitment === null || row.source.references.length === 0)) return false;
  if (row.deployment.current === "true" && (row.deployment.pinCommitment === null || row.deployment.references.length === 0)) return false;
  if (row.deployment.finalized === "true" && row.deployment.references.length === 0) return false;
  if ((row.runtime.bound === "true" || row.runtime.deltaApplied === "true")
      && (row.runtime.runtimeCommitment === null || row.runtime.references.length === 0)) return false;
  return !hasForbiddenShape(row);
}

const FORBIDDEN_KEY = /^(?:url|urls|domain|address|addresses|calldata|selector|selectors|transaction|transactions|tx|txHash|actor|actors|raw|rawSource|sourceCode|diff|patch|rpc|rpcUrl|header|headers|error|errors|provider|providers|secret|secrets|amount|amounts|usd|gas|liquidity|profit|pnl|routePositive|executable|economicThreshold|threshold|promotionJustification)$/i;
const SAFETY_KEYS = new Set(["networkAccess", "rpcAccess", "forkUse", "pnlEvaluation", "signing", "transactions", "promotion", "automaticPromotion"]);
function hasForbiddenShape(value, location = "") {
  if (typeof value === "string") return hasUnsafeText(value);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasForbiddenShape(item, location));
  return Object.entries(value).some(([key, child]) => {
    if (FORBIDDEN_KEY.test(key) && !(location === "safety" && SAFETY_KEYS.has(key))) return true;
    if (/promotion/i.test(key) && !(location === "safety" && ["promotion", "automaticPromotion"].includes(key))) return true;
    return hasForbiddenShape(child, key === "safety" ? "safety" : location);
  });
}

function validateSuppression(value) {
  if (!exactKeys(value, ["schema", "indexId", "generatedAt", "expiresAt", "entries"])
      || value.schema !== SUPPRESSION_SCHEMA || !safeId(value.indexId) || !iso(value.generatedAt) || !iso(value.expiresAt)
      || time(value.expiresAt) <= time(value.generatedAt) || !Array.isArray(value.entries)
      || value.entries.length > MAX_SUPPRESSION_ENTRIES || hasForbiddenShape(value)) return false;
  const ids = new Set();
  const candidateKeys = new Set();
  for (const entry of value.entries) {
    if (!exactKeys(entry, ["suppressionId", "candidateKey", "kind", "active", "expiresAt", "references"])
        || !safeId(entry.suppressionId) || ids.has(entry.suppressionId) || !sha64(entry.candidateKey)
        || candidateKeys.has(entry.candidateKey)
        || !["duplicate", "closed-class"].includes(entry.kind) || !tri(entry.active) || !iso(entry.expiresAt)
        || !validateReferences(entry.references)) return false;
    ids.add(entry.suppressionId);
    candidateKeys.add(entry.candidateKey);
  }
  return true;
}

function validateSentinel(value) {
  return Boolean(sentinelModule && typeof sentinelModule.validateArtifact === "function"
    && sentinelModule.validateArtifact(value));
}
function validateNow(now) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) fail("INVALID_NOW");
}
function ensureBoundedInput(sentinel, evidence, suppression) {
  if (canonicalBytes(sentinel).length > MAX_INPUT_BYTES || canonicalBytes(evidence).length > MAX_INPUT_BYTES
      || canonicalBytes(suppression).length > MAX_INPUT_BYTES) fail("INPUT_TOO_LARGE");
}
function futureState(timestamp, now) {
  const parsed = time(timestamp);
  if (parsed > now + MAX_FUTURE_SKEW_MS) fail("FUTURE_TIME");
  return parsed > now ? "unknown" : "true";
}
function freshnessState(observedAt, expiresAt, now) {
  const future = futureState(observedAt, now);
  if (now >= time(expiresAt)) return "false";
  return future;
}
function sentinelFreshness(sentinel, now) {
  const future = futureState(sentinel.generatedAt, now);
  if (now >= time(sentinel.generatedAt) + SENTINEL_MAX_AGE_MS) return "false";
  return future;
}
function andTri(values) {
  if (values.includes("false")) return "false";
  return values.every((value) => value === "true") ? "true" : "unknown";
}
function eligibility(stages) { return andTri(CRITICAL_STAGES.map((name) => stages[name])); }
function runtimeCertainty(stages) { return andTri([stages.runtimeBound, stages.runtimeDeltaApplied]); }
function candidateKey(row) {
  return sha256Canonical({ identity: row.identity, deltaId: row.deltaId, delta: row.delta, targetCommitment: row.identity.targetCommitment });
}
function normalizeReferences(groups) {
  const byValue = new Map();
  for (const group of groups) for (const reference of group) byValue.set(canonicalJson(reference), reference);
  return [...byValue.values()].sort(compareReference).map((item) => canonicalValue(item));
}
function compareTri(a, b) {
  const value = { true: 2, unknown: 1, false: 0 };
  return value[b] - value[a];
}
function compareRank(a, b) {
  return compareTri(a.stages.novelty, b.stages.novelty)
    || compareTri(runtimeCertainty(a.stages), runtimeCertainty(b.stages))
    || compareTri(a.stages.publicAccountingPath, b.stages.publicAccountingPath)
    || compareTri(a.stages.liquidExit, b.stages.liquidExit)
    || time(b._observedAt) - time(a._observedAt)
    || a.candidateId.localeCompare(b.candidateId);
}
function finishRows(rows) {
  rows.sort(compareRank);
  return rows.map((row, index) => {
    const result = {
      candidateId: row.candidateId,
      deltaId: row.deltaId,
      identity: canonicalValue(row.identity),
      delta: canonicalValue(row.delta),
      stages: canonicalValue(row.stages),
      deploymentTriageEligible: row.deploymentTriageEligible,
      blockers: [...row.blockers],
      rank: {
        ordinal: index + 1,
        novelty: row.stages.novelty,
        runtimeCertainty: runtimeCertainty(row.stages),
        publicAccountingPath: row.stages.publicAccountingPath,
        liquidExit: row.stages.liquidExit,
        observedAt: row._observedAt
      },
      references: row.references.map(canonicalValue)
    };
    return result;
  });
}
function normalizedEvidence(evidence) {
  return [...evidence].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId) || canonicalJson(a).localeCompare(canonicalJson(b)));
}
function normalizedSuppression(suppression) {
  return {
    ...suppression,
    entries: [...suppression.entries].sort((a, b) => a.suppressionId.localeCompare(b.suppressionId) || canonicalJson(a).localeCompare(canonicalJson(b)))
  };
}
function bodyWithoutFeedId(feed) {
  const body = {};
  for (const [key, value] of Object.entries(feed)) if (key !== "feedId") body[key] = value;
  return body;
}

function buildFeed({ sentinel, evidence, suppression, now, sentinelComplete } = {}) {
  validateNow(now);
  if (!validateSentinel(sentinel)) fail("INVALID_SENTINEL");
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE_ROWS
      || evidence.some((row) => !validateEvidenceRow(row))) fail("INVALID_EVIDENCE");
  if (!validateSuppression(suppression)) fail("INVALID_SUPPRESSION");
  ensureBoundedInput(sentinel, evidence, suppression);

  const evidenceIds = new Set();
  for (const row of evidence) {
    if (evidenceIds.has(row.evidenceId)) fail("DUPLICATE_EVIDENCE_ID");
    evidenceIds.add(row.evidenceId);
  }
  const sentinelFresh = sentinelFreshness(sentinel, now);
  const suppressionFuture = futureState(suppression.generatedAt, now);
  const suppressionCurrent = now < time(suppression.expiresAt) ? suppressionFuture : "false";
  const activeSuppressions = new Map();
  if (suppressionCurrent === "true") {
    for (const entry of suppression.entries) {
      if (entry.active === "true" && now < time(entry.expiresAt)) activeSuppressions.set(entry.candidateKey, entry);
    }
  }

  const candidates = [], observations = [], suppressedRows = [];
  let authorityGap = sentinelFresh !== "true" || suppressionCurrent !== "true";
  const controllingExpiries = [time(sentinel.generatedAt) + SENTINEL_MAX_AGE_MS, time(suppression.expiresAt)];
  for (const row of normalizedEvidence(evidence)) {
    const repository = sentinel.repositories.find((entry) => entry.id === row.sentinelBinding.repositoryId);
    if (!repository || row.sentinelBinding.runId !== sentinel.runId
        || row.sentinelBinding.previousHeadSha !== repository.previousHeadSha
        || row.sentinelBinding.observedHeadSha !== repository.observedHeadSha) fail("SENTINEL_BINDING_MISMATCH");
    if (row.delta.affectedLocations.some((location) => !repository.changedManifestPaths.includes(location.path))) fail("AFFECTED_PATH_NOT_CHANGED");
    if (row.source.exact === "true" && row.source.commit !== repository.observedHeadSha) fail("SOURCE_HEAD_MISMATCH");
    const fresh = andTri([sentinelFresh, freshnessState(row.observedAt, row.expiresAt, now)]);
    if (fresh !== "true") authorityGap = true;
    controllingExpiries.push(time(row.expiresAt));
    const stages = {
      sourceExact: row.source.exact,
      deploymentCurrent: row.deployment.current,
      deploymentFinalized: row.deployment.finalized,
      runtimeBound: row.runtime.bound,
      runtimeDeltaApplied: row.runtime.deltaApplied,
      fresh,
      publicAccountingPath: row.route.publicAccountingPath,
      liquidExit: row.route.liquidExit,
      novelty: row.novelty.status
    };
    const eligible = eligibility(stages);
    if (eligible === "unknown") authorityGap = true;
    const key = candidateKey(row);
    const suppressionEntry = activeSuppressions.get(key);
    if (suppressionEntry) controllingExpiries.push(time(suppressionEntry.expiresAt));
    const outputRow = {
      candidateId: key,
      deltaId: row.deltaId,
      identity: row.identity,
      delta: row.delta,
      stages,
      deploymentTriageEligible: eligible,
      blockers: CRITICAL_STAGES.filter((name) => stages[name] !== "true"),
      _observedAt: row.observedAt,
      references: normalizeReferences([
        row.source.references, row.deployment.references, row.runtime.references,
        row.route.references, row.novelty.references, suppressionEntry ? suppressionEntry.references : []
      ])
    };
    if (suppressionEntry) suppressedRows.push(outputRow);
    else if (eligible === "true") candidates.push(outputRow);
    else observations.push(outputRow);
  }

  // `sentinelComplete` lets an exclusion-aware caller confirm that every in-scope
  // repository poll succeeded even when the sentinel's own status is incomplete/rate-limited
  // because a declared-excluded repository failed. Default preserves raw-status behavior.
  const completeSentinel = sentinelComplete === undefined
    ? !["incomplete", "rate-limited"].includes(sentinel.status)
    : sentinelComplete === true;
  let status;
  if (!completeSentinel || authorityGap) status = "incomplete";
  else if (candidates.length > 0) status = "ready";
  else status = "empty";
  const feed = {
    schema: FEED_SCHEMA,
    feedId: "",
    generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(...controllingExpiries)).toISOString(),
    status,
    inputCommitments: {
      sentinel: sha256Canonical(sentinel),
      evidence: sha256Canonical(normalizedEvidence(evidence)),
      suppression: sha256Canonical(normalizedSuppression(suppression))
    },
    policy: { sentinelMaxAgeMs: SENTINEL_MAX_AGE_MS, maxFutureSkewMs: MAX_FUTURE_SKEW_MS },
    counts: {
      evidence: evidence.length,
      observations: observations.length,
      candidates: candidates.length,
      suppressed: suppressedRows.length
    },
    observations: finishRows(observations),
    candidates: finishRows(candidates),
    suppressed: finishRows(suppressedRows),
    safety: {
      networkAccess: false,
      rpcAccess: false,
      forkUse: false,
      pnlEvaluation: false,
      signing: false,
      transactions: false,
      promotion: false,
      automaticPromotion: false
    }
  };
  feed.feedId = sha256Canonical(bodyWithoutFeedId(feed));
  if (!validateFeed(feed)) fail("FEED_VALIDATION_FAILED");
  return feed;
}

function validateStages(value) {
  return exactKeys(value, [
    "sourceExact", "deploymentCurrent", "deploymentFinalized", "runtimeBound", "runtimeDeltaApplied", "fresh",
    "publicAccountingPath", "liquidExit", "novelty"
  ]) && Object.values(value).every(tri);
}
function validateRank(value) {
  return exactKeys(value, ["ordinal", "novelty", "runtimeCertainty", "publicAccountingPath", "liquidExit", "observedAt"])
    && Number.isSafeInteger(value.ordinal) && value.ordinal >= 1 && tri(value.novelty) && tri(value.runtimeCertainty)
    && tri(value.publicAccountingPath) && tri(value.liquidExit) && iso(value.observedAt);
}
function validateOutputRow(row) {
  if (!exactKeys(row, ROW_KEYS) || !sha64(row.candidateId) || !safeId(row.deltaId) || !validateIdentity(row.identity)
      || !validateDelta(row.delta) || !validateStages(row.stages) || !tri(row.deploymentTriageEligible)
      || row.deploymentTriageEligible !== eligibility(row.stages)
      || !Array.isArray(row.blockers)
      || JSON.stringify(row.blockers) !== JSON.stringify(CRITICAL_STAGES.filter((name) => row.stages[name] !== "true"))
      || !validateRank(row.rank) || row.rank.novelty !== row.stages.novelty
      || row.rank.runtimeCertainty !== runtimeCertainty(row.stages)
      || row.rank.publicAccountingPath !== row.stages.publicAccountingPath
      || row.rank.liquidExit !== row.stages.liquidExit || !validateReferences(row.references)) return false;
  return row.candidateId === sha256Canonical({ identity: row.identity, deltaId: row.deltaId, delta: row.delta, targetCommitment: row.identity.targetCommitment });
}
function validateRankedRows(rows, expectedEligibility) {
  if (!Array.isArray(rows) || rows.some((row) => !validateOutputRow(row))) return false;
  if (rows.some((row) => expectedEligibility && row.deploymentTriageEligible !== expectedEligibility)) return false;
  if (rows.some((row, index) => row.rank.ordinal !== index + 1)) return false;
  const projected = rows.map((row) => ({ ...row, _observedAt: row.rank.observedAt }));
  return JSON.stringify(projected) === JSON.stringify([...projected].sort(compareRank));
}
function validateFeed(feed) {
  if (!exactKeys(feed, [
    "schema", "feedId", "generatedAt", "expiresAt", "status", "inputCommitments", "policy", "counts",
    "observations", "candidates", "suppressed", "safety"
  ]) || feed.schema !== FEED_SCHEMA || !sha64(feed.feedId) || !iso(feed.generatedAt) || !iso(feed.expiresAt)
      || !["ready", "empty", "incomplete"].includes(feed.status)
      || !exactKeys(feed.inputCommitments, ["sentinel", "evidence", "suppression"])
      || !Object.values(feed.inputCommitments).every((item) => sha64(item))
      || !exactKeys(feed.policy, ["sentinelMaxAgeMs", "maxFutureSkewMs"])
      || feed.policy.sentinelMaxAgeMs !== SENTINEL_MAX_AGE_MS || feed.policy.maxFutureSkewMs !== MAX_FUTURE_SKEW_MS
      || !exactKeys(feed.counts, ["evidence", "observations", "candidates", "suppressed"])
      || Object.values(feed.counts).some((item) => !Number.isSafeInteger(item) || item < 0)
      || !validateRankedRows(feed.candidates, "true") || !validateRankedRows(feed.observations)
      || feed.observations.some((row) => row.deploymentTriageEligible === "true")
      || !validateRankedRows(feed.suppressed)
      || feed.counts.observations !== feed.observations.length || feed.counts.candidates !== feed.candidates.length
      || feed.counts.suppressed !== feed.suppressed.length
      || feed.counts.evidence !== feed.observations.length + feed.candidates.length + feed.suppressed.length
      || !exactKeys(feed.safety, [
        "networkAccess", "rpcAccess", "forkUse", "pnlEvaluation", "signing", "transactions", "promotion", "automaticPromotion"
      ]) || Object.values(feed.safety).some((item) => item !== false)
      || hasForbiddenShape(feed) || canonicalBytes(feed).length > MAX_OUTPUT_BYTES) return false;
  const allIds = [...feed.observations, ...feed.candidates, ...feed.suppressed].map((row) => row.candidateId);
  if (new Set(allIds).size !== allIds.length) return false;
  if (feed.status === "ready" && feed.candidates.length === 0) return false;
  if (feed.status === "empty" && feed.candidates.length !== 0) return false;
  return feed.feedId === sha256Canonical(bodyWithoutFeedId(feed));
}

async function syncDirectory(api, directory) {
  if (typeof api.open !== "function") return;
  let handle;
  try {
    handle = await api.open(directory, "r");
    if (handle && typeof handle.sync === "function") await handle.sync();
  } catch (error) {
    if (!error || !["EINVAL", "EPERM", "EISDIR", "ENOTSUP", "EBADF"].includes(error.code)) throw error;
  } finally {
    if (handle && typeof handle.close === "function") await handle.close().catch(() => {});
  }
}
async function publishNoReplace(feed, { outputDirectory, fsImpl = fs } = {}) {
  if (!validateFeed(feed)) fail("INVALID_FEED");
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0 || outputDirectory.includes("\u0000")) fail("INVALID_OUTPUT_DIRECTORY");
  const api = fsImpl.promises || fsImpl;
  if (!api || typeof api.open !== "function" || typeof api.link !== "function"
      || typeof api.readFile !== "function" || typeof api.unlink !== "function") fail("INVALID_FS_IMPL");
  const filename = path.join(outputDirectory, `${feed.feedId}.json`);
  const temporary = path.join(outputDirectory, `.${feed.feedId}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const bytes = canonicalBytes(feed);
  let linked = false;
  let handle;
  try {
    handle = await api.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    if (typeof handle.sync === "function") await handle.sync();
    await handle.close();
    handle = null;
    try {
      await api.link(temporary, filename);
      linked = true;
    } catch (error) {
      if (error && error.code === "EEXIST") fail("OUTPUT_EXISTS");
      throw error;
    }
    await syncDirectory(api, outputDirectory);
    const readback = await api.readFile(filename);
    const actual = Buffer.isBuffer(readback) ? readback : Buffer.from(readback);
    if (!actual.equals(bytes)) fail("READBACK_MISMATCH");
    let parsed;
    try { parsed = JSON.parse(actual.toString("utf8")); } catch (_) { fail("READBACK_INVALID"); }
    if (!validateFeed(parsed) || !canonicalBytes(parsed).equals(actual)) fail("READBACK_INVALID");
    return filename;
  } finally {
    if (handle && typeof handle.close === "function") await handle.close().catch(() => {});
    await api.unlink(temporary).catch(() => {});
    // Once linked, failures deliberately leave the one immutable complete artifact in place.
    void linked;
  }
}

async function runDry({ sentinel, evidence, suppression, now, outputDirectory, fsImpl } = {}) {
  const feed = buildFeed({ sentinel, evidence, suppression, now });
  const filename = await publishNoReplace(feed, { outputDirectory, fsImpl });
  return { feed, filename };
}

module.exports = {
  EVIDENCE_SCHEMA, SUPPRESSION_SCHEMA, FEED_SCHEMA, SENTINEL_MAX_AGE_MS, MAX_FUTURE_SKEW_MS,
  MAX_EVIDENCE_ROWS, MAX_SUPPRESSION_ENTRIES, MAX_REFERENCES, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES,
  FeedError, canonicalValue, canonicalJson, canonicalBytes, sha256Canonical, exactKeys,
  validateReferences, validateEvidenceRow, validateSuppression, validateSentinel, candidateKey,
  validateFeed, buildFeed, publishNoReplace, runDry
};
