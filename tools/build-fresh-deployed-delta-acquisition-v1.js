#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sentinelModule = require("./run-official-deployed-delta-sentinel.js");

const EVENT_SCHEMA = "fresh-deployed-delta-acquisition/change-event-observation/v1";
const REGISTRY_SCHEMA = "fresh-deployed-delta-acquisition/target-registry/v1";
const SUPPRESSION_SCHEMA = "fresh-deployed-delta-acquisition/suppression-index/v1";
const ACQUISITION_SCHEMA = "fresh-deployed-delta-acquisition/v1";
const EVENT_CLASSES = Object.freeze([
  "proxy-upgrade", "beacon-upgrade", "diamond-cut", "new-market", "new-vault",
  "oracle-replacement", "module-replacement", "unpause", "config", "queue-epoch"
]);
const EVENT_TO_DELTA_CLASS = Object.freeze({
  "proxy-upgrade": "implementation",
  "beacon-upgrade": "implementation",
  "diamond-cut": "implementation",
  "new-market": "new-market",
  "new-vault": "new-market",
  "oracle-replacement": "oracle",
  "module-replacement": "module",
  unpause: "unpause",
  config: "config",
  "queue-epoch": "queue"
});
const TRI = new Set(["true", "false", "unknown"]);
const SENTINEL_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_EVENT_OBSERVATIONS = 512;
const MAX_REGISTRY_ENTRIES = 1024;
const MAX_SUPPRESSION_ENTRIES = 1024;
const MAX_REFERENCES = 32;
const MAX_OUTPUT_REFERENCES = 128;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const REFERENCE_KINDS = new Set(["attestation"]);
const PROHIBITED_REFERENCE_TERMS = Object.freeze([
  "provider", "operator", "family", "familylabel", "endpoint", "rpc", "host", "domain", "url", "transport"
]);
const AUTHORITY_KEYS = Object.freeze([
  "sentinelBound", "targetRegistryBound", "sourcePathCorrelated", "finalized", "terminalRecheck",
  "twoFamilyAgreement", "independentFamilies", "fresh"
]);
const EVENT_KEYS = Object.freeze([
  "schema", "observationId", "observedAt", "expiresAt", "chainId", "eventClass", "targetCommitment",
  "eventCommitment", "finality", "familyEvidence", "references"
]);
const OUTPUT_ROW_KEYS = Object.freeze([
  "acquisitionCandidateId", "eventClass", "suggestedDeltaClass", "identity", "sourceDelta", "event",
  "authority", "acquisitionEligible", "blockers", "ordinal", "references"
]);
const SAFETY_KEYS = Object.freeze([
  "networkAccess", "rpcAccess", "inventoryAccess", "sourceDiscovery", "forkUse", "feederInvocation",
  "rankerInvocation", "evaluatorInvocation", "pnlEvaluation", "signing", "transactions", "promotion",
  "automaticPromotion"
]);

class AcquisitionError extends Error {
  constructor(code) {
    super(code);
    this.name = "AcquisitionError";
    this.code = code;
  }
}

function fail(code) { throw new AcquisitionError(code); }
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
function safeRepositoryId(value) {
  return safeText(value, 200) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !value.includes("..");
}
function safeChainId(value) { return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value); }
function safeChangedPath(value) {
  return safeText(value, 1024) && !value.startsWith("/") && !value.endsWith("/") && !value.includes("\\")
    && !value.includes("//") && !value.split("/").includes("..");
}
function safeSourcePrefix(value) {
  return safeText(value, 1024) && !value.startsWith("/") && !value.includes("\\") && !value.includes("//")
    && !value.split("/").includes("..") && value !== "/";
}
function sortedUniqueStrings(value, comparator = (a, b) => a.localeCompare(b)) {
  return Array.isArray(value) && new Set(value).size === value.length
    && JSON.stringify(value) === JSON.stringify([...value].sort(comparator));
}
function referenceComparator(a, b) {
  return `${a.kind}\0${a.id}\0${a.sha256}`.localeCompare(`${b.kind}\0${b.id}\0${b.sha256}`);
}
function hasProhibitedReferenceTerm(value) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return PROHIBITED_REFERENCE_TERMS.some((term) => normalized.includes(term));
}
function validateReferences(value, max = MAX_REFERENCES) {
  return Array.isArray(value) && value.length <= max
    && value.every((item) => exactKeys(item, ["kind", "id", "sha256"])
      && REFERENCE_KINDS.has(item.kind) && safeId(item.id, 200)
      && !hasProhibitedReferenceTerm(item.kind) && !hasProhibitedReferenceTerm(item.id) && sha64(item.sha256))
    && new Set(value.map(canonicalJson)).size === value.length
    && JSON.stringify(value) === JSON.stringify([...value].sort(referenceComparator));
}

const FORBIDDEN_KEY = /^(?:url|urls|domain|domains|endpoint|endpoints|provider|providers|familyLabel|familyLabels|familyName|familyNames|address|addresses|topic|topics|selector|selectors|calldata|transactionHash|transactionHashes|txHash|txHashes|raw|rawLog|rawLogs|logBody|rpc|rpcUrl|header|headers|error|errors|sourceBody|sourceCode|diff|patch|actor|actors|amount|amounts|usd|gas|liquidity|pnl|profit|threshold|economic|economics|routePositive|executable|promotionJustification|execution)$/i;
const SAFETY_KEY_SET = new Set(SAFETY_KEYS);
function hasForbiddenShape(value, location = "") {
  if (typeof value === "string") return hasUnsafeText(value);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasForbiddenShape(item, location));
  return Object.entries(value).some(([key, child]) => {
    const allowedSafety = location === "safety" && SAFETY_KEY_SET.has(key);
    if (FORBIDDEN_KEY.test(key) && !allowedSafety) return true;
    if (/(?:promotion|signing|transaction|feeder|ranker|evaluator)/i.test(key) && !allowedSafety) return true;
    return hasForbiddenShape(child, key === "safety" ? "safety" : location);
  });
}

function eventClassComparator(a, b) { return EVENT_CLASSES.indexOf(a) - EVENT_CLASSES.indexOf(b); }
function validateEventObservation(row) {
  if (!exactKeys(row, EVENT_KEYS) || row.schema !== EVENT_SCHEMA || !safeId(row.observationId)
      || !iso(row.observedAt) || !iso(row.expiresAt) || time(row.expiresAt) <= time(row.observedAt)
      || !safeChainId(row.chainId) || !EVENT_CLASSES.includes(row.eventClass)
      || !sha64(row.targetCommitment) || !sha64(row.eventCommitment)
      || !exactKeys(row.finality, ["finalized", "commonPinCommitment", "terminalRecheck", "references"])
      || !tri(row.finality.finalized) || !sha64(row.finality.commonPinCommitment, true)
      || !tri(row.finality.terminalRecheck) || !validateReferences(row.finality.references)
      || !exactKeys(row.familyEvidence, [
        "twoFamilyAgreement", "independentFamilies", "observedFamilyCount", "agreementCommitment", "references"
      ]) || !tri(row.familyEvidence.twoFamilyAgreement) || !tri(row.familyEvidence.independentFamilies)
      || !Number.isSafeInteger(row.familyEvidence.observedFamilyCount)
      || row.familyEvidence.observedFamilyCount < 0 || row.familyEvidence.observedFamilyCount > 16
      || !sha64(row.familyEvidence.agreementCommitment, true)
      || !validateReferences(row.familyEvidence.references) || !validateReferences(row.references)
      || hasForbiddenShape(row)) return false;
  if (row.finality.finalized === "true"
      && (row.finality.commonPinCommitment === null || row.finality.references.length === 0)) return false;
  if (row.finality.terminalRecheck === "true"
      && (row.finality.finalized !== "true" || row.finality.references.length === 0)) return false;
  if (row.familyEvidence.twoFamilyAgreement === "true"
      && (row.familyEvidence.observedFamilyCount < 2 || row.familyEvidence.agreementCommitment === null
        || row.familyEvidence.references.length === 0)) return false;
  return true;
}

function validateTargetRegistry(registry) {
  if (!exactKeys(registry, ["schema", "registryId", "generatedAt", "expiresAt", "entries"])
      || registry.schema !== REGISTRY_SCHEMA || !safeId(registry.registryId) || !iso(registry.generatedAt)
      || !iso(registry.expiresAt) || time(registry.expiresAt) <= time(registry.generatedAt)
      || !Array.isArray(registry.entries) || registry.entries.length > MAX_REGISTRY_ENTRIES
      || hasForbiddenShape(registry)) return false;
  const ids = new Set(), pairs = new Set();
  for (const entry of registry.entries) {
    if (!exactKeys(entry, [
      "registryEntryId", "registryEntryCommitment", "chainId", "targetCommitment", "protocol", "repositoryId",
      "authority", "sourcePathPrefixes", "supportedEventClasses", "references"
    ]) || !safeId(entry.registryEntryId) || ids.has(entry.registryEntryId)
        || !sha64(entry.registryEntryCommitment)
        || !safeChainId(entry.chainId) || !sha64(entry.targetCommitment) || !safeId(entry.protocol, 120)
        || !safeRepositoryId(entry.repositoryId) || !tri(entry.authority)
        || !Array.isArray(entry.sourcePathPrefixes) || entry.sourcePathPrefixes.length < 1
        || entry.sourcePathPrefixes.length > 128 || entry.sourcePathPrefixes.some((item) => !safeSourcePrefix(item))
        || !sortedUniqueStrings(entry.sourcePathPrefixes)
        || !Array.isArray(entry.supportedEventClasses) || entry.supportedEventClasses.length < 1
        || entry.supportedEventClasses.length > EVENT_CLASSES.length
        || entry.supportedEventClasses.some((item) => !EVENT_CLASSES.includes(item))
        || !sortedUniqueStrings(entry.supportedEventClasses, eventClassComparator)
        || !validateReferences(entry.references)) return false;
    const pair = `${entry.chainId}\0${entry.targetCommitment}`;
    if (pairs.has(pair)) return false;
    ids.add(entry.registryEntryId);
    pairs.add(pair);
  }
  return true;
}

function validateSuppression(suppression) {
  if (!exactKeys(suppression, ["schema", "indexId", "generatedAt", "expiresAt", "entries"])
      || suppression.schema !== SUPPRESSION_SCHEMA || !safeId(suppression.indexId)
      || !iso(suppression.generatedAt) || !iso(suppression.expiresAt)
      || time(suppression.expiresAt) <= time(suppression.generatedAt)
      || !Array.isArray(suppression.entries) || suppression.entries.length > MAX_SUPPRESSION_ENTRIES
      || hasForbiddenShape(suppression)) return false;
  const ids = new Set(), candidateIds = new Set();
  for (const entry of suppression.entries) {
    if (!exactKeys(entry, ["suppressionId", "acquisitionCandidateId", "kind", "active", "expiresAt", "references"])
        || !safeId(entry.suppressionId) || ids.has(entry.suppressionId)
        || !sha64(entry.acquisitionCandidateId) || candidateIds.has(entry.acquisitionCandidateId)
        || !["duplicate", "closed-class"].includes(entry.kind) || !tri(entry.active)
        || !iso(entry.expiresAt) || !validateReferences(entry.references)) return false;
    ids.add(entry.suppressionId);
    candidateIds.add(entry.acquisitionCandidateId);
  }
  return true;
}

function validateSentinel(sentinel) {
  return Boolean(sentinelModule && typeof sentinelModule.validateArtifact === "function"
    && sentinelModule.validateArtifact(sentinel));
}
function validateNow(now) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) fail("INVALID_NOW");
}
function futureState(timestamp, now) {
  const parsed = time(timestamp);
  if (parsed > now + MAX_FUTURE_SKEW_MS) fail("FUTURE_TIME");
  return parsed > now ? "unknown" : "true";
}
function expiringState(generatedOrObservedAt, expiresAt, now) {
  const future = futureState(generatedOrObservedAt, now);
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
function eligibility(authority) { return andTri(AUTHORITY_KEYS.map((key) => authority[key])); }
function matchingPaths(changedPaths, prefixes) {
  return [...changedPaths].filter((changedPath) => prefixes.some((prefix) => (
    prefix.endsWith("/") ? changedPath.startsWith(prefix) : changedPath === prefix
  ))).sort((a, b) => a.localeCompare(b));
}
function normalizeReferences(groups) {
  const unique = new Map();
  for (const group of groups) for (const item of group) unique.set(canonicalJson(item), item);
  return [...unique.values()].sort(referenceComparator).map(canonicalValue);
}
function normalizedEvents(events) {
  return [...events].sort((a, b) => a.observationId.localeCompare(b.observationId) || canonicalJson(a).localeCompare(canonicalJson(b)));
}
function normalizedRegistry(registry) {
  return {
    ...registry,
    entries: [...registry.entries].sort((a, b) => a.registryEntryId.localeCompare(b.registryEntryId) || canonicalJson(a).localeCompare(canonicalJson(b)))
  };
}
function normalizedSuppression(suppression) {
  return {
    ...suppression,
    entries: [...suppression.entries].sort((a, b) => a.suppressionId.localeCompare(b.suppressionId) || canonicalJson(a).localeCompare(canonicalJson(b)))
  };
}
function acquisitionCandidateId(material) {
  const keys = [
    "repositoryId", "previousHeadSha", "observedHeadSha", "chainId", "targetCommitment", "eventClass",
    "eventCommitment", "registryEntryCommitment"
  ];
  if (!exactKeys(material, keys)
      || !(material.repositoryId === null || safeRepositoryId(material.repositoryId))
      || !sha40(material.previousHeadSha, true) || !sha40(material.observedHeadSha, true)
      || !safeChainId(material.chainId) || !sha64(material.targetCommitment)
      || !EVENT_CLASSES.includes(material.eventClass) || !sha64(material.eventCommitment)
      || !sha64(material.registryEntryCommitment, true)) fail("INVALID_CANDIDATE_MATERIAL");
  return sha256Canonical(material);
}
function bodyWithoutId(acquisition) {
  const body = {};
  for (const [key, value] of Object.entries(acquisition)) if (key !== "acquisitionId") body[key] = value;
  return body;
}
function compareOutputRows(a, b) {
  return time(b.event.observedAt) - time(a.event.observedAt)
    || eventClassComparator(a.eventClass, b.eventClass)
    || a.acquisitionCandidateId.localeCompare(b.acquisitionCandidateId);
}
function finishRows(rows) {
  rows.sort(compareOutputRows);
  return rows.map((row, index) => ({ ...row, ordinal: index + 1 }));
}

function buildAcquisition({ sentinel, eventObservations, targetRegistry, suppression, now } = {}) {
  validateNow(now);
  if (!validateSentinel(sentinel)) fail("INVALID_SENTINEL");
  if (!Array.isArray(eventObservations) || eventObservations.length > MAX_EVENT_OBSERVATIONS
      || eventObservations.some((row) => !validateEventObservation(row))) fail("INVALID_EVENT_OBSERVATIONS");
  if (!validateTargetRegistry(targetRegistry)) fail("INVALID_TARGET_REGISTRY");
  if (!validateSuppression(suppression)) fail("INVALID_SUPPRESSION");
  if (canonicalBytes(sentinel).length > MAX_INPUT_BYTES || canonicalBytes(eventObservations).length > MAX_INPUT_BYTES
      || canonicalBytes(targetRegistry).length > MAX_INPUT_BYTES || canonicalBytes(suppression).length > MAX_INPUT_BYTES) {
    fail("INPUT_TOO_LARGE");
  }
  const observationIds = new Set();
  for (const observation of eventObservations) {
    if (observationIds.has(observation.observationId)) fail("DUPLICATE_OBSERVATION_ID");
    observationIds.add(observation.observationId);
  }

  const sentinelFresh = sentinelFreshness(sentinel, now);
  const registryFresh = expiringState(targetRegistry.generatedAt, targetRegistry.expiresAt, now);
  const suppressionFresh = expiringState(suppression.generatedAt, suppression.expiresAt, now);
  const sentinelComplete = !["incomplete", "rate-limited"].includes(sentinel.status);
  const globalAuthority = andTri([
    sentinelFresh,
    registryFresh,
    suppressionFresh,
    sentinelComplete ? "true" : "unknown"
  ]);
  let authorityGap = globalAuthority !== "true";
  const controllingExpiries = [
    time(sentinel.generatedAt) + SENTINEL_MAX_AGE_MS,
    time(targetRegistry.expiresAt),
    time(suppression.expiresAt)
  ];
  const registryByTarget = new Map(targetRegistry.entries.map((entry) => [`${entry.chainId}\0${entry.targetCommitment}`, entry]));
  const activeSuppressions = new Map();
  if (suppressionFresh === "true") {
    for (const entry of suppression.entries) {
      if (entry.active === "true" && now < time(entry.expiresAt)) activeSuppressions.set(entry.acquisitionCandidateId, entry);
    }
  }
  const candidates = [], blocked = [], suppressedRows = [], materialIds = new Set();

  for (const observation of normalizedEvents(eventObservations)) {
    const registryEntry = registryByTarget.get(`${observation.chainId}\0${observation.targetCommitment}`) || null;
    const repository = registryEntry
      ? sentinel.repositories.find((entry) => entry.id === registryEntry.repositoryId) || null
      : null;
    const matchedPaths = registryEntry && repository
      ? matchingPaths(repository.changedManifestPaths, registryEntry.sourcePathPrefixes)
      : [];
    const eventFresh = expiringState(observation.observedAt, observation.expiresAt, now);
    controllingExpiries.push(time(observation.expiresAt));

    let targetRegistryBound = "unknown";
    if (registryEntry) {
      if (registryEntry.authority === "false" || !registryEntry.supportedEventClasses.includes(observation.eventClass)) {
        targetRegistryBound = "false";
      } else targetRegistryBound = registryEntry.authority;
    }
    let sentinelBound = "unknown";
    if (registryEntry) {
      if (!sentinelComplete || sentinelFresh === "unknown") sentinelBound = "unknown";
      else if (!repository || repository.pollStatus !== "candidate-change"
          || repository.previousHeadSha === null || repository.observedHeadSha === null) sentinelBound = "false";
      else sentinelBound = "true";
    }
    let sourcePathCorrelated = "unknown";
    if (registryEntry) sourcePathCorrelated = repository && matchedPaths.length > 0 ? "true" : "false";
    const fresh = andTri([sentinelFresh, registryFresh, suppressionFresh, eventFresh]);
    const authority = {
      sentinelBound,
      targetRegistryBound,
      sourcePathCorrelated,
      finalized: observation.finality.finalized,
      terminalRecheck: observation.finality.terminalRecheck,
      twoFamilyAgreement: observation.familyEvidence.twoFamilyAgreement,
      independentFamilies: observation.familyEvidence.independentFamilies,
      fresh
    };
    const eligible = eligibility(authority);
    if (fresh !== "true") authorityGap = true;
    const material = {
      repositoryId: registryEntry ? registryEntry.repositoryId : null,
      previousHeadSha: repository ? repository.previousHeadSha : null,
      observedHeadSha: repository ? repository.observedHeadSha : null,
      chainId: observation.chainId,
      targetCommitment: observation.targetCommitment,
      eventClass: observation.eventClass,
      eventCommitment: observation.eventCommitment,
      registryEntryCommitment: registryEntry ? registryEntry.registryEntryCommitment : null
    };
    const candidateId = acquisitionCandidateId(material);
    if (materialIds.has(candidateId)) fail("DUPLICATE_MATERIAL_CANDIDATE_ID");
    materialIds.add(candidateId);
    const suppressionEntry = activeSuppressions.get(candidateId);
    if (suppressionEntry) controllingExpiries.push(time(suppressionEntry.expiresAt));
    const outputRow = {
      acquisitionCandidateId: candidateId,
      eventClass: observation.eventClass,
      suggestedDeltaClass: EVENT_TO_DELTA_CLASS[observation.eventClass],
      identity: {
        protocol: registryEntry ? registryEntry.protocol : null,
        chainId: observation.chainId,
        targetCommitment: observation.targetCommitment,
        repositoryId: registryEntry ? registryEntry.repositoryId : null
      },
      sourceDelta: {
        previousHeadSha: repository ? repository.previousHeadSha : null,
        observedHeadSha: repository ? repository.observedHeadSha : null,
        changedPaths: matchedPaths
      },
      event: { eventCommitment: observation.eventCommitment, observedAt: observation.observedAt },
      authority,
      acquisitionEligible: eligible,
      blockers: AUTHORITY_KEYS.filter((key) => authority[key] !== "true"),
      ordinal: 0,
      references: normalizeReferences([
        observation.references,
        observation.finality.references,
        observation.familyEvidence.references,
        registryEntry ? registryEntry.references : [],
        suppressionEntry ? suppressionEntry.references : []
      ])
    };
    if (suppressionEntry && eligible === "true") suppressedRows.push(outputRow);
    else if (eligible === "true" && globalAuthority === "true") candidates.push(outputRow);
    else blocked.push(outputRow);
  }

  let status;
  if (authorityGap) status = "incomplete";
  else if (candidates.length > 0) status = "ready";
  else status = "empty";
  const acquisition = {
    schema: ACQUISITION_SCHEMA,
    acquisitionId: "",
    generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(...controllingExpiries)).toISOString(),
    status,
    inputCommitments: {
      sentinel: sha256Canonical(sentinel),
      eventObservations: sha256Canonical(normalizedEvents(eventObservations)),
      targetRegistry: sha256Canonical(normalizedRegistry(targetRegistry)),
      suppression: sha256Canonical(normalizedSuppression(suppression))
    },
    counts: {
      eventObservations: eventObservations.length,
      candidates: candidates.length,
      blocked: blocked.length,
      suppressed: suppressedRows.length
    },
    candidates: finishRows(candidates),
    blocked: finishRows(blocked),
    suppressed: finishRows(suppressedRows),
    safety: Object.fromEntries(SAFETY_KEYS.map((key) => [key, false]))
  };
  acquisition.acquisitionId = sha256Canonical(bodyWithoutId(acquisition));
  if (!validateAcquisition(acquisition)) fail("ACQUISITION_VALIDATION_FAILED");
  return acquisition;
}

function validateIdentity(value) {
  if (!exactKeys(value, ["protocol", "chainId", "targetCommitment", "repositoryId"])
      || !safeChainId(value.chainId) || !sha64(value.targetCommitment)) return false;
  const unmatched = value.protocol === null && value.repositoryId === null;
  const matched = safeId(value.protocol, 120) && safeRepositoryId(value.repositoryId);
  return unmatched || matched;
}
function validateSourceDelta(value, identity) {
  if (!exactKeys(value, ["previousHeadSha", "observedHeadSha", "changedPaths"])
      || !sha40(value.previousHeadSha, true) || !sha40(value.observedHeadSha, true)
      || !Array.isArray(value.changedPaths) || value.changedPaths.length > 256
      || value.changedPaths.some((item) => !safeChangedPath(item))
      || !sortedUniqueStrings(value.changedPaths)) return false;
  if (identity.repositoryId === null) return value.previousHeadSha === null && value.observedHeadSha === null && value.changedPaths.length === 0;
  return true;
}
function validateAuthority(value) {
  return exactKeys(value, AUTHORITY_KEYS) && Object.values(value).every(tri);
}
function validateOutputRow(row) {
  return exactKeys(row, OUTPUT_ROW_KEYS) && sha64(row.acquisitionCandidateId)
    && EVENT_CLASSES.includes(row.eventClass) && row.suggestedDeltaClass === EVENT_TO_DELTA_CLASS[row.eventClass]
    && validateIdentity(row.identity) && validateSourceDelta(row.sourceDelta, row.identity)
    && exactKeys(row.event, ["eventCommitment", "observedAt"])
    && sha64(row.event.eventCommitment) && iso(row.event.observedAt)
    && validateAuthority(row.authority) && tri(row.acquisitionEligible)
    && row.acquisitionEligible === eligibility(row.authority)
    && Array.isArray(row.blockers)
    && JSON.stringify(row.blockers) === JSON.stringify(AUTHORITY_KEYS.filter((key) => row.authority[key] !== "true"))
    && Number.isSafeInteger(row.ordinal) && row.ordinal >= 1
    && validateReferences(row.references, MAX_OUTPUT_REFERENCES) && !hasForbiddenShape(row);
}
function validateOutputList(rows, category) {
  if (!Array.isArray(rows) || rows.some((row) => !validateOutputRow(row))) return false;
  if (category === "candidates" && rows.some((row) => row.acquisitionEligible !== "true")) return false;
  if (category === "blocked" && rows.some((row) => row.acquisitionEligible === "true")) return false;
  if (category === "suppressed" && rows.some((row) => row.acquisitionEligible !== "true")) return false;
  if (category !== "blocked" && rows.some((row) => row.identity.protocol === null || row.identity.repositoryId === null
      || row.sourceDelta.previousHeadSha === null || row.sourceDelta.observedHeadSha === null
      || row.sourceDelta.changedPaths.length === 0)) return false;
  if (rows.some((row) => row.identity.repositoryId === null
      && (category !== "blocked" || row.authority.targetRegistryBound !== "unknown"
        || row.authority.sentinelBound !== "unknown" || row.authority.sourcePathCorrelated !== "unknown"))) return false;
  if (rows.some((row, index) => row.ordinal !== index + 1)) return false;
  return JSON.stringify(rows) === JSON.stringify([...rows].sort(compareOutputRows));
}
function validateAcquisition(acquisition) {
  if (!exactKeys(acquisition, [
    "schema", "acquisitionId", "generatedAt", "expiresAt", "status", "inputCommitments", "counts",
    "candidates", "blocked", "suppressed", "safety"
  ]) || acquisition.schema !== ACQUISITION_SCHEMA || !sha64(acquisition.acquisitionId)
      || !iso(acquisition.generatedAt) || !iso(acquisition.expiresAt)
      || !["ready", "empty", "incomplete"].includes(acquisition.status)
      || !exactKeys(acquisition.inputCommitments, ["sentinel", "eventObservations", "targetRegistry", "suppression"])
      || !Object.values(acquisition.inputCommitments).every((item) => sha64(item))
      || !exactKeys(acquisition.counts, ["eventObservations", "candidates", "blocked", "suppressed"])
      || Object.values(acquisition.counts).some((item) => !Number.isSafeInteger(item) || item < 0)
      || !validateOutputList(acquisition.candidates, "candidates")
      || !validateOutputList(acquisition.blocked, "blocked")
      || !validateOutputList(acquisition.suppressed, "suppressed")
      || acquisition.counts.candidates !== acquisition.candidates.length
      || acquisition.counts.blocked !== acquisition.blocked.length
      || acquisition.counts.suppressed !== acquisition.suppressed.length
      || acquisition.counts.eventObservations !== acquisition.candidates.length + acquisition.blocked.length + acquisition.suppressed.length
      || !exactKeys(acquisition.safety, SAFETY_KEYS)
      || Object.values(acquisition.safety).some((value) => value !== false)
      || hasForbiddenShape(acquisition) || canonicalBytes(acquisition).length > MAX_OUTPUT_BYTES) return false;
  const ids = [...acquisition.candidates, ...acquisition.blocked, ...acquisition.suppressed]
    .map((row) => row.acquisitionCandidateId);
  if (new Set(ids).size !== ids.length) return false;
  if (acquisition.status === "ready" && acquisition.candidates.length === 0) return false;
  if (acquisition.status === "empty" && acquisition.candidates.length !== 0) return false;
  return acquisition.acquisitionId === sha256Canonical(bodyWithoutId(acquisition));
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
async function publishNoReplace(acquisition, { outputDirectory, fsImpl = fs } = {}) {
  if (!validateAcquisition(acquisition)) fail("INVALID_ACQUISITION");
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0 || outputDirectory.includes("\u0000")) {
    fail("INVALID_OUTPUT_DIRECTORY");
  }
  const api = fsImpl.promises || fsImpl;
  if (!api || typeof api.open !== "function" || typeof api.link !== "function"
      || typeof api.readFile !== "function" || typeof api.unlink !== "function") fail("INVALID_FS_IMPL");
  const filename = path.join(outputDirectory, `${acquisition.acquisitionId}.json`);
  const temporary = path.join(outputDirectory, `.${acquisition.acquisitionId}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const bytes = canonicalBytes(acquisition);
  let handle;
  try {
    handle = await api.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    if (typeof handle.sync === "function") await handle.sync();
    await handle.close();
    handle = null;
    try {
      await api.link(temporary, filename);
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
    if (!validateAcquisition(parsed) || !canonicalBytes(parsed).equals(actual)) fail("READBACK_INVALID");
    return filename;
  } finally {
    if (handle && typeof handle.close === "function") await handle.close().catch(() => {});
    await api.unlink(temporary).catch(() => {});
  }
}

async function runDry({ sentinel, eventObservations, targetRegistry, suppression, now, outputDirectory, fsImpl } = {}) {
  const acquisition = buildAcquisition({ sentinel, eventObservations, targetRegistry, suppression, now });
  const filename = await publishNoReplace(acquisition, { outputDirectory, fsImpl });
  return { acquisition, filename };
}

module.exports = {
  EVENT_SCHEMA, REGISTRY_SCHEMA, SUPPRESSION_SCHEMA, ACQUISITION_SCHEMA, EVENT_CLASSES, EVENT_TO_DELTA_CLASS,
  SENTINEL_MAX_AGE_MS, MAX_FUTURE_SKEW_MS, MAX_EVENT_OBSERVATIONS, MAX_REGISTRY_ENTRIES,
  MAX_SUPPRESSION_ENTRIES, MAX_REFERENCES, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES,
  AcquisitionError, exactKeys, canonicalValue, canonicalJson, canonicalBytes, sha256Bytes, sha256Canonical,
  validateReferences, validateEventObservation, validateTargetRegistry, validateSuppression, validateSentinel,
  acquisitionCandidateId, buildAcquisition, validateAcquisition, publishNoReplace, runDry
};
