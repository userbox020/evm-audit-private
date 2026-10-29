"use strict";

const { isDeepStrictEqual } = require("node:util");

const AAVE_SOURCE_COVERAGE_SCHEMA = "aave-source-coverage/v1";
const AAVE_SOURCE_COVERAGE_SCHEMA_VERSION = 1;
const BOUNDED_OBSERVATIONAL = "BOUNDED_OBSERVATIONAL";
const EXHAUSTIVE_COMPLETE = "EXHAUSTIVE_COMPLETE";
const SOURCE_INCOMPLETE = "SOURCE_INCOMPLETE";
// Additive classification: the live sample for this cycle is still bounded
// (sampleComplete stays false), but the candidate universe it draws from has a
// separately proven full historical coverage artifact.
const SAMPLE_INCOMPLETE_HISTORICAL_COVERAGE_PROVEN = "SAMPLE_INCOMPLETE_HISTORICAL_COVERAGE_PROVEN";
const HISTORICAL_COVERAGE_PROOF_SCHEMA = "aave-v3-borrower-universe/v1";
const COUNT_FIELDS = [
  "chainsExpected", "chainsObserved", "logChunksAttempted", "logChunksSucceeded", "logChunksFailed",
  "discoveredBorrowers", "checkedBorrowers", "accountReadsAttempted", "accountReadsSucceeded",
  "accountReadsFailed", "reserveReadsAttempted", "reserveReadsSucceeded", "reserveReadsFailed",
  "stateReadsAttempted", "stateReadsSucceeded", "stateReadsFailed",
];

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function count(value) {
  return isCount(value) ? value : 0;
}

function uniqueErrors(errors) {
  return [...new Set((Array.isArray(errors) ? errors : []).filter(value => typeof value === "string" && value))];
}

function exactExhaustiveProof(proof) {
  return proof !== null && typeof proof === "object" && !Array.isArray(proof)
    && proof.exact === true
    && typeof proof.type === "string" && proof.type.length > 0
    && typeof proof.evidence === "string" && proof.evidence.trim().length > 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// A verified historical-coverage proof: the exact schema plus the recorded
// universe hash and the timestamp of the fresh local rehash that confirmed it.
function validHistoricalCoverageProof(proof) {
  return proof !== null && typeof proof === "object" && !Array.isArray(proof)
    && proof.schema === HISTORICAL_COVERAGE_PROOF_SCHEMA
    && isNonEmptyString(proof.artifact)
    && typeof proof.universeSha256 === "string" && /^[0-9a-f]{64}$/i.test(proof.universeSha256)
    && typeof proof.verifiedAt === "string" && Number.isFinite(Date.parse(proof.verifiedAt));
}

// A declared-static V4 topology is only acceptable when it is bound to a pinned,
// versioned registry with intact provenance. A bound-but-unprovenanced universe
// fails closed instead of being treated as merely observational.
function boundTopologyProvenanceFailure(universe) {
  if (!universe || typeof universe !== "object" || Array.isArray(universe) || universe.type !== "DECLARED_STATIC_HUB_SET") return "topology-universe";
  if (universe.bound !== true) return "topology-universe-unbound";
  if (!isNonEmptyString(universe.registry) || !isNonEmptyString(universe.version)
    || !(typeof universe.commit === "string" && /^[0-9a-f]{40}$/i.test(universe.commit))
    || !isNonEmptyString(universe.source)
    || !(isNonEmptyString(universe.pinBlock) || (Number.isSafeInteger(universe.pinBlock) && universe.pinBlock > 0))
    || !(typeof universe.inventoryDigest === "string" && /^[0-9a-f]{64}$/i.test(universe.inventoryDigest))) return "topology-universe-provenance";
  return null;
}

function buildAaveSourceCoverage(protocolVersion, coverageKind, input = {}) {
  if (!new Set(["V3", "V4"]).has(protocolVersion)) throw new Error("invalid-aave-protocol-version");
  if (typeof coverageKind !== "string" || !coverageKind) throw new Error("invalid-aave-coverage-kind");
  const errors = uniqueErrors(input.errors);
  const wasTruncated = input.wasTruncated === true;
  const sampleComplete = input.sampleComplete === true && errors.length === 0 && !wasTruncated;
  const exhaustive = input.fullHistoryProven === true && exactExhaustiveProof(input.exhaustiveProof);
  const complete = input.complete === true && sampleComplete && exhaustive;
  // Additive: a bounded per-cycle sample whose candidate universe carries a
  // verified full-historical proof is classified distinctly, never as complete.
  const historicalCoverageProven = input.historicalCoverageProven === true
    && input.coverageProofVerified === true && input.fullHistoryProven === true;
  const classification = complete
    ? EXHAUSTIVE_COMPLETE
    : sampleComplete && !exhaustive ? BOUNDED_OBSERVATIONAL
      : !sampleComplete && historicalCoverageProven ? SAMPLE_INCOMPLETE_HISTORICAL_COVERAGE_PROVEN
        : SOURCE_INCOMPLETE;
  const proof = complete ? input.exhaustiveProof : {
    type: classification === BOUNDED_OBSERVATIONAL ? "BOUNDED_OBSERVATION"
      : classification === SAMPLE_INCOMPLETE_HISTORICAL_COVERAGE_PROVEN ? "HISTORICAL_COVERAGE_PROVEN"
        : "INCOMPLETE_SOURCE",
    exact: false,
    evidence: typeof input.blocker === "string" && input.blocker.trim()
      ? input.blocker.trim()
      : errors.join(",") || "coverage-not-exhaustive",
  };
  const counts = Object.fromEntries(COUNT_FIELDS.map(field => [field, count(input[field])]));
  return {
    schema: AAVE_SOURCE_COVERAGE_SCHEMA,
    schemaVersion: AAVE_SOURCE_COVERAGE_SCHEMA_VERSION,
    protocolVersion,
    coverageKind,
    producerKind: coverageKind,
    classification,
    complete,
    sampleComplete,
    promotionEligible: false,
    exhaustiveProof: exhaustive ? input.exhaustiveProof : null,
    proof,
    promotionClosure: { eligible: false, routePositive: false, executableNow: false, signedActionJustified: false },
    ...counts,
    ...input,
    schema: AAVE_SOURCE_COVERAGE_SCHEMA,
    schemaVersion: AAVE_SOURCE_COVERAGE_SCHEMA_VERSION,
    protocolVersion,
    coverageKind,
    producerKind: coverageKind,
    classification,
    complete,
    sampleComplete,
    promotionEligible: false,
    exhaustiveProof: exhaustive ? input.exhaustiveProof : null,
    proof,
    promotionClosure: { eligible: false, routePositive: false, executableNow: false, signedActionJustified: false },
    ...counts,
    errors,
    wasTruncated,
  };
}

function exactPromotionClosure(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "eligible,executableNow,routePositive,signedActionJustified"
    && value.eligible === false && value.routePositive === false
    && value.executableNow === false && value.signedActionJustified === false;
}

function linkKey(row) {
  if (!row || typeof row !== "object") return null;
  const hub = typeof row.hubAddress === "string" ? row.hubAddress.toLowerCase() : null;
  const spoke = typeof row.spoke === "string" ? row.spoke.toLowerCase() : null;
  const assetId = isCount(row.assetId) ? row.assetId : null;
  const reserveId = isCount(row.reserveId) ? row.reserveId : null;
  return hub && spoke && assetId !== null && reserveId !== null ? `${hub}:${assetId}:${spoke}:${reserveId}` : null;
}

function validateV4ReserveLinks(value, fail) {
  const aggregates = value.spokeReserveLinks;
  const consumed = value.consumedReserveLinks;
  const globalCounts = [value.reserveLinksExpected, value.reserveLinksObserved, value.reserveLinksConsumed, value.reserveLinksCap];
  if (!Array.isArray(aggregates) || !Array.isArray(consumed) || !globalCounts.every(isCount) || value.reserveLinksCap === 0) {
    fail("reserve-link-envelope");
    return;
  }
  if (typeof value.reserveLinksTruncated !== "boolean") fail("reserve-link-truncation");
  if (value.coverageKind === "topology" && value.reserveLinksTruncated !== value.wasTruncated) fail("reserve-link-truncation");
  if (!value.reserveLinksTruncated && value.reserveLinksExpected > value.reserveLinksCap) fail("reserve-link-cap");
  const consumedKeys = consumed.map(linkKey);
  if (consumedKeys.some(key => key === null) || new Set(consumedKeys).size !== consumedKeys.length) fail("reserve-link-uniqueness");
  if (consumed.length !== value.reserveLinksConsumed) fail("reserve-link-consumed-count");
  const spokes = new Set();
  const aggregateKeys = [];
  let expected = 0;
  let observed = 0;
  let aggregateConsumed = 0;
  for (const row of aggregates) {
    const spoke = typeof row?.spoke === "string" && row.spoke ? row.spoke.toLowerCase() : null;
    if (!spoke || spokes.has(spoke)) fail("reserve-link-spoke-uniqueness");
    if (spoke) spokes.add(spoke);
    if (![row?.expected, row?.observed, row?.consumed, row?.cap].every(isCount) || row.cap === 0 || !Array.isArray(row.links)) {
      fail("reserve-link-aggregate");
      continue;
    }
    if (row.wasTruncated !== value.reserveLinksTruncated) fail("reserve-link-aggregate-truncation");
    if (!row.wasTruncated && row.expected > row.cap) fail("reserve-link-aggregate-cap");
    // Completeness equality only applies when the envelope actually claims a
    // complete sample. A SOURCE_INCOMPLETE topology legitimately reports
    // observed < expected because some enumerated reserve reads failed; that is
    // already encoded by the producer's own error list and must not be treated
    // as a structural defect.
    if (value.sampleComplete === true && !row.wasTruncated && (row.expected !== row.observed || row.observed !== row.consumed)) fail("reserve-link-aggregate-equality");
    const keys = row.links.map(linkKey);
    if (keys.some(key => key === null) || new Set(keys).size !== keys.length || row.links.some(link => link.spoke.toLowerCase() !== spoke)) fail("reserve-link-aggregate-uniqueness");
    if (row.links.length !== row.consumed) fail("reserve-link-aggregate-consumed");
    aggregateKeys.push(...keys);
    expected += row.expected;
    observed += row.observed;
    aggregateConsumed += row.consumed;
  }
  if (expected !== value.reserveLinksExpected || observed !== value.reserveLinksObserved || aggregateConsumed !== value.reserveLinksConsumed) fail("reserve-link-aggregate-sum");
  if (aggregateKeys.length !== consumedKeys.length || new Set(aggregateKeys).size !== aggregateKeys.length
    || aggregateKeys.some(key => !consumedKeys.includes(key))) fail("reserve-link-topology-linkage");
  if (value.sampleComplete === true && !value.reserveLinksTruncated && (value.reserveLinksExpected !== value.reserveLinksObserved
    || value.reserveLinksObserved !== value.reserveLinksConsumed)) fail("reserve-link-equality");
  if (value.sampleComplete === true) {
    if (value.reserveLinksExpected !== value.reserveLinksObserved || value.reserveLinksObserved !== value.reserveLinksConsumed) fail("reserve-link-equality");
    if (value.spokesExpected !== aggregates.length || value.spokesObserved !== aggregates.length) fail("reserve-link-spoke-count");
  }
  if (aggregates.length === 0 && (value.reserveLinksExpected !== 0 || value.reserveLinksObserved !== 0 || value.reserveLinksConsumed !== 0)) fail("reserve-link-empty-not-authoritative-zero");
}

function validateAaveSourceCoverageEnvelope(value, options = {}) {
  const failures = [];
  const fail = code => failures.push(code);
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, failures: ["coverage-not-object"] };
  if (value.schema !== AAVE_SOURCE_COVERAGE_SCHEMA || value.schemaVersion !== AAVE_SOURCE_COVERAGE_SCHEMA_VERSION) fail("schema-version");
  if (!new Set(["V3", "V4"]).has(value.protocolVersion) || (options.protocolVersion && value.protocolVersion !== options.protocolVersion)) fail("protocol-version");
  if (typeof value.coverageKind !== "string" || !value.coverageKind || value.producerKind !== value.coverageKind
    || (options.coverageKind && value.coverageKind !== options.coverageKind)) fail("producer-kind");
  if (value.promotionEligible !== false || !exactPromotionClosure(value.promotionClosure)) fail("promotion-open");
  const sourceErrors = Array.isArray(value.errors) ? value.errors : [];
  if (!Array.isArray(value.errors) || sourceErrors.some(error => typeof error !== "string" || !error)) fail("source-errors-shape");
  if (typeof value.wasTruncated !== "boolean") fail("truncation-shape");
  if (!isCount(value.truncationLimit) || value.truncationLimit === 0) fail("invalid-cap");
  if (!COUNT_FIELDS.every(field => isCount(value[field]))) fail("count-shape");
  for (const [attempted, succeeded, failed] of [
    ["logChunksAttempted", "logChunksSucceeded", "logChunksFailed"],
    ["accountReadsAttempted", "accountReadsSucceeded", "accountReadsFailed"],
    ["reserveReadsAttempted", "reserveReadsSucceeded", "reserveReadsFailed"],
    ["stateReadsAttempted", "stateReadsSucceeded", "stateReadsFailed"],
  ]) if (isCount(value[attempted]) && value[succeeded] + value[failed] !== value[attempted]) fail(`${attempted}-sum`);
  const boundedProof = value.proof && value.proof.exact === false && typeof value.proof.type === "string" && typeof value.proof.evidence === "string" && value.proof.evidence.trim();
  if (value.classification === EXHAUSTIVE_COMPLETE) {
    if (value.complete !== true || value.sampleComplete !== true || !exactExhaustiveProof(value.exhaustiveProof)
      || JSON.stringify(value.proof) !== JSON.stringify(value.exhaustiveProof)) fail("exhaustive-semantics");
  } else if (value.classification === BOUNDED_OBSERVATIONAL) {
    if (value.complete !== false || value.sampleComplete !== true || value.exhaustiveProof !== null || !boundedProof || value.proof.type !== "BOUNDED_OBSERVATION") fail("observational-semantics");
  } else if (value.classification === SOURCE_INCOMPLETE) {
    if (value.complete !== false || value.sampleComplete !== false || value.exhaustiveProof !== null || !boundedProof || value.proof.type !== "INCOMPLETE_SOURCE") fail("incomplete-semantics");
  } else if (value.classification === SAMPLE_INCOMPLETE_HISTORICAL_COVERAGE_PROVEN) {
    if (value.complete !== false || value.sampleComplete !== false || value.exhaustiveProof !== null
      || !boundedProof || value.proof.type !== "HISTORICAL_COVERAGE_PROVEN"
      || value.fullHistoryProven !== true || value.coverageProofVerified !== true
      || !validHistoricalCoverageProof(value.coverageProof)) fail("historical-coverage-proven-semantics");
  } else fail("classification");
  if (value.sampleComplete === true && (sourceErrors.length !== 0 || value.wasTruncated)) fail("sample-completeness");
  if (options.requireSampleComplete === true && value.sampleComplete !== true) fail("upstream-incomplete");
  if (value.protocolVersion === "V4") {
    validateV4ReserveLinks(value, fail);
    if (value.coverageKind === "topology") {
      if (value.topologySourceCoverage != null) fail("topology-evidence-nesting");
    } else {
      const topologyEvidence = value.topologySourceCoverage;
      if (topologyEvidence != null) {
        const topologyEnvelope = topologyEvidence.coverageKind === "topology"
          ? validateAaveSourceCoverageEnvelope(topologyEvidence, { protocolVersion: "V4", coverageKind: "topology" })
          : { valid: false };
        if (!topologyEnvelope.valid) fail("topology-evidence-invalid");
        else {
          for (const field of ["topologyUniverse", "spokeReserveLinks", "consumedReserveLinks", "reserveLinksExpected",
            "reserveLinksObserved", "reserveLinksConsumed", "reserveLinksCap", "reserveLinksTruncated", "spokesExpected"]) {
            if (!isDeepStrictEqual(value[field], topologyEvidence[field])) fail("topology-evidence-linkage");
          }
          if (value.topologySourceComplete !== topologyEvidence.complete
            || value.topologySourceSampleComplete !== topologyEvidence.sampleComplete) fail("topology-evidence-linkage");
        }
      }
      if (value.complete === true || value.classification === EXHAUSTIVE_COMPLETE) {
        const evidence = validateV4ExhaustiveEvidence(value);
        if (!evidence.valid) failures.push(...evidence.failures);
        else if (!isDeepStrictEqual(value.exhaustiveProof, evidence.proof)) fail("exhaustive-proof-linkage");
      }
    }
  }
  return { valid: failures.length === 0, failures: [...new Set(failures)] };
}

// Authority for a declared topology is not an assertion about borrower history.
// This verifies the full supporting envelope, never a standalone `bound` flag.
function validateV4TopologyAuthority(value) {
  if (!value || value.coverageKind !== "topology") return { valid: false, failures: ["topology-evidence-missing"] };
  const envelope = validateAaveSourceCoverageEnvelope(value, {
    protocolVersion: "V4", coverageKind: "topology", requireSampleComplete: true,
  });
  const failures = envelope.failures.map(code => `topology-${code}`);
  const provenance = boundTopologyProvenanceFailure(value.topologyUniverse);
  if (provenance) failures.push(provenance);
  if (!isCount(value.hubsExpected) || value.hubsExpected === 0 || value.hubsObserved !== value.hubsExpected
    || value.topologyUniverse?.hubsDeclared !== value.hubsExpected) failures.push("topology-hub-coverage");
  if (!isCount(value.assetsExpected) || value.assetsObserved !== value.assetsExpected) failures.push("topology-asset-coverage");
  if (value.reserveLinksDeclared !== value.reserveLinksExpected) failures.push("topology-directory-coverage");
  if (!healthyTriplet(value, "stateReadsAttempted", "stateReadsSucceeded", "stateReadsFailed", false)) failures.push("topology-state-reads");
  return { valid: failures.length === 0, failures: [...new Set(failures)] };
}

function fullV4HistoryProven(value) {
  const range = value?.observedRange;
  if (!isCount(range?.fromBlock) || !isCount(range?.toBlock) || range.toBlock < range.fromBlock) return false;
  if (range.fromBlock === 0) return value.historyScope === "GENESIS_TO_TIP";
  const boundary = value.historyStartBound;
  return value.historyScope === "DEPLOYMENT_TO_PIN" && value.fullHistoryProven === true
    && boundary?.proven === true && boundary.block === range.fromBlock && isNonEmptyString(boundary.proof);
}

function validV4ObservationPin(value) {
  const pin = value?.observationPin;
  return pin?.schema === "aave-v4-state-pin/v1" && pin.chainId === 1
    && isCount(pin.blockNumber) && typeof pin.blockHash === "string"
    && /^0x[0-9a-f]{64}$/i.test(pin.blockHash) && !/^0x0{64}$/i.test(pin.blockHash)
    && pin.finality === "finalized" && pin.terminalBlockNumber === pin.blockNumber
    && typeof pin.terminalBlockHash === "string" && pin.terminalBlockHash.toLowerCase() === pin.blockHash.toLowerCase()
    && isCount(pin.stateReadsPinned) && pin.stateReadsPinned === value.stateReadsAttempted
    && healthyTriplet(value, "stateReadsAttempted", "stateReadsSucceeded", "stateReadsFailed");
}

// Evidence-shape validation for trusted local producers, not a cryptographic
// chain proof. Current latest-tag scanners do not emit these pin attestations.
function validateV4ExhaustiveEvidence(value) {
  const topology = value?.topologySourceCoverage;
  const authority = validateV4TopologyAuthority(topology);
  const failures = authority.failures.slice();
  if (value?.fullHistoryProven !== true || !fullV4HistoryProven(value)) failures.push("borrower-history-unproven");
  if (!validV4ObservationPin(topology)) failures.push("topology-observation-pin");
  if (!validV4ObservationPin(value)) failures.push("borrower-observation-pin");
  const pin = value?.observationPin;
  const topologyPin = topology?.observationPin;
  if (validV4ObservationPin(topology) && validV4ObservationPin(value)
    && (pin.blockNumber !== topologyPin.blockNumber || pin.blockHash.toLowerCase() !== topologyPin.blockHash.toLowerCase())) failures.push("observation-pin-mismatch");
  if (!pin || value?.observedRange?.toBlock !== pin.blockNumber) failures.push("history-pin-mismatch");
  if (value?.sampleComplete !== true || value.wasTruncated !== false || !isCount(value.truncationLimit) || value.truncationLimit === 0
    || !Array.isArray(value.errors) || value.errors.length
    || !Array.isArray(value.excludedSpokes) || value.excludedSpokes.length || value.spokeFilteringApplied === true) failures.push("borrower-sample-incomplete");
  if (value?.chainsExpected !== 1 || value.chainsObserved !== 1
    || !isCount(value.spokesExpected) || value.spokesObserved !== value.spokesExpected
    || value.spokesExpected !== topology?.spokesExpected) failures.push("borrower-source-counts");
  if (!isCount(value?.discoveredBorrowers) || value.checkedBorrowers !== value.discoveredBorrowers
    || value.accountReadsAttempted !== value.checkedBorrowers) failures.push("borrower-counts");
  for (const [attempted, succeeded, failed, allowZero] of [
    ["logChunksAttempted", "logChunksSucceeded", "logChunksFailed", false],
    ["accountReadsAttempted", "accountReadsSucceeded", "accountReadsFailed", true],
    ["reserveReadsAttempted", "reserveReadsSucceeded", "reserveReadsFailed", true],
  ]) if (!healthyTriplet(value, attempted, succeeded, failed, allowZero)) failures.push("borrower-read-counts");
  if (value?.stateReadsAttempted !== value?.accountReadsAttempted + value?.reserveReadsAttempted
    || value?.stateReadsSucceeded !== value?.accountReadsSucceeded + value?.reserveReadsSucceeded
    || value?.stateReadsFailed !== value?.accountReadsFailed + value?.reserveReadsFailed) failures.push("borrower-state-read-sum");
  if (failures.length) return { valid: false, failures: [...new Set(failures)], proof: null };
  const universe = topology.topologyUniverse;
  return {
    valid: true, failures: [], proof: {
      type: "V4_BOUND_REGISTRY_AND_FULL_BORROW_HISTORY", exact: true,
      // A machine label survives the monitor's unsafe-context sanitizer; the
      // structured registry commit/digest below retain the exact binding.
      evidence: "v4-bound-registry-and-full-borrow-history",
      registryCommit: universe.commit, inventoryDigest: universe.inventoryDigest,
      chainId: pin.chainId, blockNumber: pin.blockNumber, blockHash: pin.blockHash.toLowerCase(),
      fromBlock: value.observedRange.fromBlock, toBlock: value.observedRange.toBlock,
    },
  };
}

function healthyTriplet(value, attempted, succeeded, failed, allowZero = true) {
  return [value?.[attempted], value?.[succeeded], value?.[failed]].every(isCount)
    && (allowZero || value[attempted] > 0)
    && value[succeeded] + value[failed] === value[attempted]
    && value[succeeded] === value[attempted]
    && value[failed] === 0;
}

function exactCountSet(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected)
    && actual.length === expected.length && new Set(actual).size === actual.length
    && expected.every(value => actual.includes(value));
}

function timestampFresh(value, freshnessMinutes, nowMs) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  const age = (nowMs - time) / 60_000;
  return age >= -5 && age <= freshnessMinutes;
}

function validateAaveSourceCoverage(value, options = {}) {
  const envelope = validateAaveSourceCoverageEnvelope(value, options);
  const failures = envelope.failures.slice();
  const fail = code => failures.push(code);
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, readiness: "invalid", failures: [...new Set(failures)] };
  if (value.promotionEligible !== false) fail("promotion-open");
  if (value.wasTruncated !== false) fail("truncated");
  if (!Array.isArray(value.errors) || value.errors.length !== 0) fail("source-errors");
  if (!isCount(value.chainsExpected) || value.chainsExpected !== options.expectedChains || value.chainsObserved !== value.chainsExpected) fail("chain-coverage");
  if (!healthyTriplet(value, "logChunksAttempted", "logChunksSucceeded", "logChunksFailed", false)) fail("log-coverage");
  if (!healthyTriplet(value, "accountReadsAttempted", "accountReadsSucceeded", "accountReadsFailed")) fail("account-reads");
  if (!healthyTriplet(value, "reserveReadsAttempted", "reserveReadsSucceeded", "reserveReadsFailed")) fail("reserve-reads");
  if (!healthyTriplet(value, "stateReadsAttempted", "stateReadsSucceeded", "stateReadsFailed")) fail("state-reads");
  if (!isCount(value.discoveredBorrowers) || value.checkedBorrowers !== value.discoveredBorrowers || value.accountReadsAttempted !== value.checkedBorrowers) fail("borrower-coverage");
  if (!isCount(value.truncationLimit) || value.truncationLimit === 0) fail("invalid-cap");

  const freshnessMinutes = options.freshnessMinutes || 5;
  const nowMs = options.nowMs ?? Date.now();
  if (value.protocolVersion === "V3") {
    if (!timestampFresh(value.routeGeneratedAt, freshnessMinutes, nowMs) || !timestampFresh(value.readinessGeneratedAt, freshnessMinutes, nowMs)) fail("stale-input");
    if (!Number.isFinite(value.maxSourceAgeMs) || value.maxSourceAgeMs <= 0 || value.maxSourceAgeMs > freshnessMinutes * 60_000) fail("invalid-max-age");
    if (value.routeRefreshAttempted !== true || value.routeRefreshOk !== true) fail("refresh-incomplete");
    if (!exactCountSet(value.requiredChainIds, options.requiredChainIds) || !exactCountSet(value.observedChainIds, options.requiredChainIds)) fail("chain-set");
    if (!healthyTriplet(value, "readinessStateReadsAttempted", "readinessStateReadsSucceeded", "readinessStateReadsFailed", false)) fail("readiness-reads");
    if (!healthyTriplet(value, "readinessAccountReadsAttempted", "readinessAccountReadsSucceeded", "readinessAccountReadsFailed", false)) fail("readiness-account-reads");
    if (value.stateReadsAttempted !== value.accountReadsAttempted + value.reserveReadsAttempted + value.readinessStateReadsAttempted
      || value.stateReadsSucceeded !== value.accountReadsSucceeded + value.reserveReadsSucceeded + value.readinessStateReadsSucceeded
      || value.stateReadsFailed !== value.accountReadsFailed + value.reserveReadsFailed + value.readinessStateReadsFailed) fail("state-read-sum");
  } else {
    if (!timestampFresh(value.topologyGeneratedAt, freshnessMinutes, nowMs)) fail("stale-topology");
    if (!Number.isFinite(value.topologyAgeMs) || value.topologyAgeMs < -60_000 || value.topologyAgeMs > freshnessMinutes * 60_000) fail("topology-age");
    if (typeof value.topologyRefreshAttempted !== "boolean" || value.topologyRefreshOk !== true) fail("topology-refresh");
    if (!isCount(value.spokesExpected) || value.spokesObserved !== value.spokesExpected) fail("spoke-coverage");
    const topologyUniverseFailure = boundTopologyProvenanceFailure(value.topologyUniverse);
    if (topologyUniverseFailure) fail(topologyUniverseFailure);
    if (!Array.isArray(value.spokeReserveLinks) || value.spokeReserveLinks.some(row => !isCount(row?.expected) || row.observed !== row.expected || !isCount(row.cap) || row.cap === 0 || row.wasTruncated !== false)) fail("reserve-links");
    if (value.stateReadsAttempted !== value.accountReadsAttempted + value.reserveReadsAttempted
      || value.stateReadsSucceeded !== value.accountReadsSucceeded + value.reserveReadsSucceeded
      || value.stateReadsFailed !== value.accountReadsFailed + value.reserveReadsFailed) fail("state-read-sum");
  }

  const mode = options.mode || BOUNDED_OBSERVATIONAL;
  if (mode === BOUNDED_OBSERVATIONAL) {
    if (value.classification !== BOUNDED_OBSERVATIONAL || value.complete !== false || value.sampleComplete !== true || value.exhaustiveProof !== null) fail("observational-semantics");
  } else if (value.classification !== EXHAUSTIVE_COMPLETE || value.complete !== true || value.sampleComplete !== true || !exactExhaustiveProof(value.exhaustiveProof)) {
    fail("exhaustive-semantics");
  }
  return { valid: failures.length === 0, readiness: failures.length ? "invalid" : mode === BOUNDED_OBSERVATIONAL ? "ready-observational" : "ready", failures: [...new Set(failures)] };
}

module.exports = {
  AAVE_SOURCE_COVERAGE_SCHEMA,
  AAVE_SOURCE_COVERAGE_SCHEMA_VERSION,
  BOUNDED_OBSERVATIONAL,
  EXHAUSTIVE_COMPLETE,
  SOURCE_INCOMPLETE,
  SAMPLE_INCOMPLETE_HISTORICAL_COVERAGE_PROVEN,
  HISTORICAL_COVERAGE_PROOF_SCHEMA,
  buildAaveSourceCoverage,
  boundTopologyProvenanceFailure,
  validateV4TopologyAuthority,
  validateV4ExhaustiveEvidence,
  validV4ObservationPin,
  fullV4HistoryProven,
  validateAaveSourceCoverageEnvelope,
  validateAaveSourceCoverage,
  exactExhaustiveProof,
  validHistoricalCoverageProof,
  count,
};
