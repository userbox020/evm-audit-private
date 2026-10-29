"use strict";

/*
 * trigger-fork-epoch.js — PHASE 1: pure offline epoch core (contracts/admission only).
 *
 * Design source: coordination/decisions/20261014-autopilot-identity-epoch-design.md
 * (accepted revision 2). This phase implements ONLY:
 *   - strict bounded parsing/validation of the epoch manifest (with a canonical,
 *     serialized-schema-compatible public manifest value and digest),
 *   - strict bounded parsing/validation of a source event and its offline adapter
 *     semantics, including the admission-context bindings (epoch, owner proposal,
 *     adapter/scenario digests, expected source digest) and separately recorded
 *     source/producer/observation/economic/header times,
 *   - deterministic semantic identity computation (transition + pin-quote kinds)
 *     that binds every concrete subject/route/pin/candidate datum and the fired
 *     status but excludes producer/adapter labels, epoch/owner context, source
 *     digests and all observation/wrapper times,
 *   - inherited/current consumed-identity (replay) evaluation against the manifest,
 *     with explicit predecessor epoch + ancestry lineage descriptors,
 *   - offline admission checks: lifecycle windows, remaining work+cleanup budget,
 *     context bindings, chain floors/pins/header-time coherence, original-transition
 *     consistency, known-gap exclusion coverage, replay/saturation, and
 *     freshness/skew/opening-cutoff gates.
 *
 * It does NOT implement (future phases): owner process, attended activation, the
 * append-only journal/outbox, containment, promotion, delivery, or any runtime.
 * No filesystem, network, scheduler, child or clock reads: every eligible time
 * comparison uses an injected `nowMs` safe integer. (`Date.parse`/`new Date(x)` are
 * applied only to fixed validated ISO strings to build deterministic comparison
 * values; the module never reads the wall clock.) Dependencies: `node:crypto` and
 * the pure `../lib/evm-call-inventory-v2/canonical.js` strict parser/canonicalizer
 * (reused, not reimplemented, not modified).
 *
 * A successful return (`status: "OFFLINE_VALID"`) is offline contract validity ONLY.
 * It is never READY, activation, owner/OS/canonical-RPC qualification, canonical-chain
 * proof, authenticated source provenance, profitability, or execution permission. No
 * ACTIVE owner assertion is ever invented: ownerBinding fields are proposed binding
 * data, not an owner. Supplied pins, floors, qualification assertions, route and
 * header data are offline data assertions, never proof of canonical chain history.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC EXPORTS
 *   DESIGN_LIMITS            frozen design maxima; manifest bounds may only narrow.
 *   BLOCKERS                 frozen fixed blocker codes (no raw-input echo anywhere).
 *   ADAPTER_REGISTRY         frozen OFFLINE adapter semantics table. Only adapters
 *                            whose offline semantics are concretely defined here may
 *                            be used; no real producer adapter is wired or qualified
 *                            in this phase. Producers/allowlists are manifest data.
 *   MANIFEST_SCHEMA, EVENT_SCHEMA, CONSUMED_SCHEMA, IDENTITY_SCHEMA,
 *   IDENTITY_SCHEMA_VERSION, POLICY_VERSION, OWNER_POLICY_VERSION,
 *   INDEPENDENCE_POLICY_VERSION, LEGACY_DISPOSITION, UNKNOWN_GAP_POLICY,
 *   LEGACY_RATIONALE_CODES, LEGACY_SEARCH_POLICY_CODES   fixed schema/version/code
 *                            constants (no free-form text fields exist).
 *   consumedSetDigest(recordsText)  bounded, shape-validated, order-independent set
 *                            digest helper for record writers (see below).
 *   parseEpochManifest(manifestText) -> registered handle { manifest, digest } or BLOCKED
 *   parseSourceEvent(eventText)      -> { event, semanticEventId } or BLOCKED
 *   admitEvent({ manifest, event, consumed, inherited, expectedSourceDigest, nowMs })
 *
 * ---------------------------------------------------------------------------
 * VALIDATED-MANIFEST HANDLE (correction: unforgeable)
 * `parseEpochManifest` returns a frozen wrapper `{ manifest, digest }` whose exact
 * object is registered in a private WeakSet. `admitEvent` accepts ONLY such a
 * registered handle: prototype-inherited lookalikes (`Object.create(handle)`), copied
 * Symbol markers, forged digests, raw inner manifest objects and accessor-bearing
 * stand-ins are all rejected (PARAM_MANIFEST_UNVALIDATED) without reading any of
 * their properties, so no accessor can run. The public `handle.manifest` is a plain
 * schema-shaped object with NO derived fields: it re-serializes and re-parses to the
 * same canonical digest (`parseEpochManifest(JSON.stringify(handle.manifest)).digest
 * === handle.digest`); admission re-derives all time values from the strings.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC INPUT CONTRACT
 * - Event and consumed/inherited set inputs are SERIALIZED JSON strings so the
 *   strict reused parser (duplicate decoded keys — including escaped-key duplicates —
 *   unsafe numeric forms, control characters, lone surrogates) cannot be bypassed.
 *   `consumed` and `inherited` MUST be explicit serialized arrays ("[]" when empty);
 *   null/undefined/missing values are refused (no silent empty reset).
 * - `expectedSourceDigest` is a required per-admission-call binding: the caller's
 *   independently bound expected source-envelope digest; a mismatch fails closed.
 * - `nowMs` is the injected safe-integer clock. The option object's exact key set is
 *   enforced; unknown parameters fail closed.
 *
 * ---------------------------------------------------------------------------
 * BOUND LAYER (enforced before recursive parsing/canonicalization)
 * - Serialized inputs: byte size (manifest 65536, event 16384, consumed/inherited
 *   sets 65536), then a NON-parsing depth pre-scan (maxDepth 8), then
 *   parseStrictJson, then a structural bound walk: nesting depth <= 8, object keys
 *   <= 24 (each <= 40 chars), array items <= 128, string chars <= 256, safe-integer
 *   numbers only, plain objects/arrays/booleans/null only.
 * - Errors from the reused parser (they may quote input keys) are caught and mapped
 *   to the fixed `PARSE_BLOCKED` code; raw input NEVER appears in any output.
 *
 * ---------------------------------------------------------------------------
 * MANIFEST SCHEMA — "trigger-fork-epoch-manifest/v1"; exact top-level fields
 * { schema, epochId, policyVersion, identitySchemaVersion, ownerBinding, createdAt,
 *   notBefore, expiresAt, bounds, scope, chains, legacy, predecessor }
 * with NO extra or missing fields at any nested object:
 *   epochId                "EP-<id chars>" (max 67 total chars)
 *   policyVersion          "trigger-fork-epoch-policy/v1"
 *   identitySchemaVersion  exactly 1
 *   ownerBinding           { policyVersion: "trigger-fork-owner/v1",
 *                            proposalDigest: <hash32> } — PROPOSED binding datum
 *                          only; NOT an owner/OS/activation qualification. Events
 *                          and current consumed records must restate it exactly.
 *   createdAt/notBefore/expiresAt  strict ISO-8601 UTC "YYYY-MM-DDTHH:MM:SS.mmmZ";
 *                          createdAt <= notBefore < expiresAt; both
 *                          (expiresAt-notBefore) and (expiresAt-createdAt) <= 8h.
 *   bounds    exactly { maxConsumedIdentities 1..128, sourceMaxAgeMs 1..600000,
 *             observationMaxAgeMs 1..600000, floorQualificationMaxAgeMs 1..600000,
 *             futureSkewMs 0..60000, promotionMaxAgeMs 1..120000,
 *             forkBudgetMs 1..210000, cleanupBudgetMs 0..210000, maxInFlight===1 };
 *             widening beyond the design maxima fails BOUND_EXCEEDS_DESIGN. The
 *             inherited consumed count is additionally enforced against the
 *             manifest's own narrowed capacity at validation time.
 *   scope     exactly { primaryChainId 1..2^32-1, companionChainIds unique ints
 *             (primary excluded, count<=8), adapterId in ADAPTER_REGISTRY,
 *             scenarioId "SC-<id>" (max 35), adapterDigest <hash32>,
 *             scenarioDigest <hash32>, producerAllowlist non-empty unique bounded
 *             producer-id strings, firedStatusAllowlist non-empty unique subset of
 *             the adapter's statuses }.
 *   chains    object keyed EXACTLY by the decimal string of every required chainId
 *             (primary + every companion). Each value exactly:
 *             { floorBlockNumber <canonical decimal qty>, floorBlockHash <hash32>,
 *               floorHeaderTime <ts>, qualifiedAt <ts>,
 *               independence: { policyVersion: "trigger-fork-independence/v1",
 *                 qualifyingSourceCount: int >= 2, distinctOperationalControl: true,
 *                 distinctUpstreamPath: true, unknownSharedProvenance: false } }.
 *             Validated independence DATA (failed criteria are how same-upstream
 *             aliases are represented), never independence proof.
 *   legacy    exactly { disposition: "LEGACY_INCOMPLETE", archiveDigest <hash32>,
 *             rationaleCode in LEGACY_RATIONALE_CODES, searchPolicyCode in
 *             LEGACY_SEARCH_POLICY_CODES }. The code arrays are exported frozen;
 *             mutation cannot widen the accepted vocabulary. No free-form text
 *             field exists; nothing free-form can enter canonicalization, hashes
 *             or results.
 *   predecessor exactly one of two explicit modes:
 *             SUCCESSOR mode: { predecessorEpochId "EP-...", lineageDigest,
 *             ancestry: [ { epochId, lineageDigest } ] where the FIRST entry must
 *             equal the immediate predecessor binding, each epochId binds exactly
 *             once (two digests for one epoch are contradictory), entries unique
 *             (1..8), no entry may name the current epoch, ... }.
 *             LEGACY-ONLY ROOT mode (the first epoch after an incomplete archive):
 *             { predecessorEpochId: null, ancestry: [],
 *               lineageDigest === legacy.archiveDigest, ... } — inheritable only
 *             through correctly bound LEGACY_ARCHIVE records; predecessor/current
 *             records cannot masquerade as root history; no historical identity is
 *             invented.
 *             Shared fields: inheritedConsumedCount <= bounds.maxConsumedIdentities,
 *             inheritedConsumedDigest <hash32>, identitySchemaVersion===1,
 *             unknownGapPolicy: "EXCLUDE_UNTIL_PROVED_CUTOFF" (only supported
 *             value), gaps: array (order-insensitive) of
 *             { gapDigest <hash32>, cutoff <ts>, excludedByCutoff: true,
 *               excludedByAdapterScope: false } — the adapter-scope exemption is
 *             NOT supported in this phase (bare scope booleans cannot waive a gap),
 *             cutoffs must be <= notBefore (GAP_CUTOFF_INVALID otherwise), and
 *             duplicates in gaps fail. Gap records export the EXACT input schema
 *             (cutoff milliseconds are re-derived on admission), so valid gap
 *             manifests roundtrip through their own JSON. A gap record is a
 *             recorded data binding that REDUCES what may be admitted; it is never
 *             permission to admit a possible event.
 * The returned handle.manifest is a frozen normalized rebuild (arrays order-
 * canonicalized) with a canonical "0x"+sha256 `digest` over it: reordering the
 * allowlists, companions or gaps cannot create another manifest identity, and the
 * public value roundtrips through its own JSON serialization with the same digest.
 *
 * ---------------------------------------------------------------------------
 * EVENT SCHEMA "trigger-fork-epoch-event/v1" — exact fields:
 *   { schema, identitySchemaVersion===1, adapterId, adapterDigest, producerId,
 *     firedStatus, scenarioId, scenarioDigest, epochId, ownerProposalDigest,
 *     source: { digest <hash32>, observedAt <ts> },
 *     producer: { generatedAt <ts> },           // separate producer-generated time
 *     observation: { at <ts> },
 *     primary: { chainId, blockNumber <qty>, blockHash <hash32>, headerTime <ts> },
 *     companions: [ same pin shape ] (unique chainIds, primary excluded; for
 *                 admission this set must EXACTLY cover the manifest companion set;
 *                 order-insensitive),
 *     routeKey (derived OUTPUT, never an input field): for PIN_QUOTE,
 *                 "0x" + sha256(canonicalize({ schema:
 *                 "trigger-fork-epoch-route/v1", chainId, route })) computed from
 *                 the already validated canonical route fields and the event chain
 *                 id; explicitly null for STATE_TRANSITION (design section 3:
 *                 required for route-bearing adapters, explicit null only for
 *                 reviewed non-route adapters). Recomputed on every parse from the
 *                 concrete route; NOT part of the semantic identity, which binds
 *                 the route object itself; no caller route-key input exists.
 *     target: one of
 *       { kind:"STATE_TRANSITION", chainId, subject:{ contract <address> },
 *         conditionId, transition:{ blockNumber <qty>, blockHash <hash32>,
 *         headerTime <ts> } } — subject contract + original change bind the
 *         identity. Admission requires floor < transition block <= observed pin
 *         block, hash agreement at equal height (TRANSITION_PIN_MISMATCH), a
 *         coherent original header time (floorHeader < transitionHeader <=
 *         observed pin header), and the transition header strictly within the
 *         opening cutoff and skew bounds — a future or pre-cutoff transition
 *         cannot be refreshed by a new observation. Identity stability holds when
 *         the same original transition is reobserved later.
 *       { kind:"PIN_QUOTE", chainId, pin:{blockNumber,blockHash},
 *         route: { tokenIn, tokenOut, poolA, poolB: <lowercase address>,
 *                  direction: "POOL_A_TO_POOL_B" | "POOL_B_TO_POOL_A" },
 *         candidate:{ amountInRaw <qty>, expectedOutRaw <qty>,
 *                     economicsObservedAt <ts> } } — the normalized route key is
 *         RECOMPUTED from these concrete allowlisted fields; no opaque caller route
 *         hash is accepted. The quote pin must EQUAL the primary observation pin;
 *         all economics stay bound to that exact pin. *   semanticEventId (optional) — if present it MUST be the correct type and equal
 *       the recomputed identity; a well-formed but different caller ID fails
 *       IDENTITY_RECOMPUTE_MISMATCH, a wrong type fails HASH_INVALID (no
 *       null-as-absent shortcut). Caller IDs are never trusted as identity.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISTIC SEMANTIC IDENTITY (recorded contract)
 * canonical("trigger-fork-epoch-identity/v1") object with identityVersion 1:
 *   STATE_TRANSITION: { schema, identityVersion, kind:"STATE_TRANSITION", chainId,
 *       firedStatus, subjectContract, conditionId, transitionBlockNumber,
 *       transitionBlockHash }
 *   PIN_QUOTE: { schema, identityVersion, kind:"PIN_QUOTE", chainId, firedStatus,
 *       pinBlockNumber, pinBlockHash, route:{ direction, poolA, poolB, tokenIn,
 *       tokenOut }, amountInRaw, expectedOutRaw }
 * semanticEventId = "0x" + sha256(canonicalize(identity object)); every digest/ID
 * field carries the 0x prefix. The identity does NOT and MUST NOT include
 * producerId, adapterId, epoch, owner, pass, source digests, generation or
 * observation times: two allowed producers observing the same defined semantic
 * event share one identity (duplicate observations cannot bypass dedupe), and
 * wrappers/reorderings/new observation times cannot create another identity.
 * Changing any concrete subject/route/pin/candidate/status datum changes it.
 *
 * ---------------------------------------------------------------------------
 * CONSUMED RECORD SCHEMA "trigger-fork-epoch-consumed/v1" — exact fields:
 *   { schema, identitySchemaVersion===1, semanticEventId <hash32>,
 *     outcome: "SUCCESS"|"FAILED"|"UNCERTAIN"|"REJECTED",
 *     provenance:
 *       PREDECESSOR_EPOCH: { source, epochId, lineageDigest } — the pair must match
 *         one verified ancestry descriptor of the manifest predecessor; the current
 *         epoch can never impersonate a predecessor and arbitrary foreign labels
 *         sharing a digest are refused.
 *       LEGACY_ARCHIVE:    { source, lineageDigest } — equal to legacy.archiveDigest.
 *       CURRENT_EPOCH:     { source, epochId, ownerProposalDigest } — binds BOTH the
 *         manifest epoch and the owner proposal digest. }
 * All successful/failed/uncertain (and rejected) attempts are consumed data. There
 * is NO eviction, implicit reset, operator-override parameter, or implicit schema
 * mapping; unmappable identity versions fail closed. Set digest (order-independent,
 * shared with writers through the bounded helper):
 *   consumedSetDigest(recordsText) = "0x" + sha256(canonically(JSON array of the
 *   per-record canonical sha256 hex digests, sorted lexically)) — computed ONLY
 *   after strict bounded shape/schema/outcome/provenance validation; mixed
 *   LEGACY_ARCHIVE + PREDECESSOR_EPOCH origins are legitimate in one inherited set,
 *   CURRENT_EPOCH may only form an all-current set, and duplicate semantic
 *   identities inside the array are refused before any digest exists.
 *
 * ---------------------------------------------------------------------------
 * ADMISSION CHECK ORDER (deterministic):
 *   1 parameter validation: the exact option key set is enforced via property
 *   descriptors (enumerable own DATA properties only; accessors/symbol
 *   keys/nonenumerable extras fail before any value is read), clock/handle
 *   validation → 2 lifecycle window (notBefore/expiresAt) and remaining
 *   work+cleanup budget → 3 bounded event parse + mandatory identity recompute →
 *   4 admission-context bindings (epoch, owner proposal, adapter and scenario
 *   digests, producer and fired-status allowlists, primary chain, expected source
 *   digest; adapter ids are string-typed before registry lookup) → 5 per-chain
 *   qualification staleness → 6 companion-set exact coverage, floors (strictly
 *   above; equality/older/conflicting pins fail), pin-vs-floor header guards and
 *   header freshness → 6b original-transition consistency (floor < transition <=
 *   observed pin; equal height binds BOTH block hash and header timestamp; the
 *   observed hash is not reusable at another height; coherent header time with the
 *   same max-age gate TRANSITION_STALE, then cutoff/future bounds) → 7
 *   consumed-set parse + lineage/digest/count/version/capacity bindings,
 *   duplicate/overflow checks → 8 replay → 9 saturation (combined
 *   inherited+current) → 10 freshness/future-skew/opening cutoffs for source
 *   envelope, producer row, fired observation and pin-quote economics (each
 *   independently; a fresh wrapper cannot rescue any stale or pre-cutoff datum) →
 *   11 known-gap coverage under the STRICT after-gap rule: source, producer,
 *   observation, pin-quote economics, every observed pin header time and the
 *   original-transition header time must lie strictly inside each declared gap
 *   cutoff's covered region (equality overlaps the gap; a gap cutoff may equal
 *   notBefore, in which case event equality with it is still overlap). Ordinary
 *   notBefore equality without a gap keeps the inclusive documented rule.
 * Every blocker code is in BLOCKERS; no raw input text, endpoint, key or free-form
 * payload ever leaves the module in a result.
 */

const { createHash } = require("node:crypto");
const { parseStrictJson, canonicalize } = require("./evm-call-inventory-v2/canonical.js");

/* ---------------------------------- schemas --------------------------------- */
const MANIFEST_SCHEMA = "trigger-fork-epoch-manifest/v1";
const EVENT_SCHEMA = "trigger-fork-epoch-event/v1";
const CONSUMED_SCHEMA = "trigger-fork-epoch-consumed/v1";
const IDENTITY_SCHEMA = "trigger-fork-epoch-identity/v1";
const IDENTITY_SCHEMA_VERSION = 1;
const POLICY_VERSION = "trigger-fork-epoch-policy/v1";
const OWNER_POLICY_VERSION = "trigger-fork-owner/v1";
const INDEPENDENCE_POLICY_VERSION = "trigger-fork-independence/v1";
const LEGACY_DISPOSITION = "LEGACY_INCOMPLETE";
const UNKNOWN_GAP_POLICY = "EXCLUDE_UNTIL_PROVED_CUTOFF";
const LEGACY_RATIONALE_CODES = Object.freeze(["LEGACY_V1_INCOMPLETE"]);
const LEGACY_SEARCH_POLICY_CODES = Object.freeze(["MANUAL_RUNS_OUT_OF_SCOPE", "NO_RECOVERABLE_IDS"]);

/* ------------------------------- design maxima ------------------------------ */
const DESIGN_LIMITS = Object.freeze({
  manifestBytes: 65536,
  eventBytes: 16384,
  consumedSetBytes: 65536,
  maxDepth: 8,
  maxObjectKeys: 24,
  maxKeyChars: 40,
  maxArrayItems: 128,
  maxStringChars: 256,
  maxQuantityDigits: 40,
  epochLifetimeMs: 28800000, /* 8h */
  companionChains: 8,
  maxConsumedIdentities: 128,
  sourceMaxAgeMs: 600000, /* 10m */
  observationMaxAgeMs: 600000, /* 10m */
  floorQualificationMaxAgeMs: 600000, /* 10m */
  futureSkewMs: 60000, /* 60s */
  promotionMaxAgeMs: 120000, /* 2m (recorded; live enforcement belongs to later phases) */
  forkBudgetMs: 210000, /* 210s */
  cleanupBudgetMs: 210000,
  maxInFlight: 1,
  ancestryEntries: 8,
  maxGaps: 16
});

/* ------------------------------- blocker codes ------------------------------ */
const BLOCKERS = Object.freeze({
  PARSE_BLOCKED: "PARSE_BLOCKED",
  BOUNDARY_SIZE: "BOUNDARY_SIZE",
  BOUNDARY_DEPTH: "BOUNDARY_DEPTH",
  BOUNDARY_STRUCTURE: "BOUNDARY_STRUCTURE",
  FIELD_MISSING: "FIELD_MISSING",
  FIELD_UNKNOWN: "FIELD_UNKNOWN",
  FIELD_TYPE: "FIELD_TYPE",
  VALUE_INVALID: "VALUE_INVALID",
  QUANTITY_NONCANONICAL: "QUANTITY_NONCANONICAL",
  TIMESTAMP_NONCANONICAL: "TIMESTAMP_NONCANONICAL",
  HASH_INVALID: "HASH_INVALID",
  STRING_INVALID: "STRING_INVALID",
  STRING_TOO_LONG: "STRING_TOO_LONG",
  COLLECTION_TOO_LARGE: "COLLECTION_TOO_LARGE",
  SCHEMA_UNSUPPORTED: "SCHEMA_UNSUPPORTED",
  LIFETIME_EXCEEDED: "LIFETIME_EXCEEDED",
  BOUND_EXCEEDS_DESIGN: "BOUND_EXCEEDS_DESIGN",
  ADAPTER_UNSUPPORTED: "ADAPTER_UNSUPPORTED",
  STATUS_NOT_IN_ADAPTER: "STATUS_NOT_IN_ADAPTER",
  KIND_UNSUPPORTED: "KIND_UNSUPPORTED",
  CONDITION_UNSUPPORTED: "CONDITION_UNSUPPORTED",
  ROUTE_FIELD_INVALID: "ROUTE_FIELD_INVALID",
  INDEPENDENCE_INSUFFICIENT: "INDEPENDENCE_INSUFFICIENT",
  INDEPENDENCE_UNPROVEN: "INDEPENDENCE_UNPROVEN",
  GAP_POLICY_UNSUPPORTED: "GAP_POLICY_UNSUPPORTED",
  GAP_EXCLUSION_UNSUPPORTED: "GAP_EXCLUSION_UNSUPPORTED",
  GAP_CUTOFF_INVALID: "GAP_CUTOFF_INVALID",
  GAP_OVERLAP: "GAP_OVERLAP",
  ANCESTRY_INCOHERENT: "ANCESTRY_INCOHERENT",
  PREDECESSOR_MISMATCH: "PREDECESSOR_MISMATCH",
  CLOCK_INVALID: "CLOCK_INVALID",
  PARAM_FIELD_INVALID: "PARAM_FIELD_INVALID",
  PARAM_MANIFEST_UNVALIDATED: "PARAM_MANIFEST_UNVALIDATED",
  NOT_YET_ACTIVE: "NOT_YET_ACTIVE",
  EPOCH_EXPIRED: "EPOCH_EXPIRED",
  BUDGET_INSUFFICIENT: "BUDGET_INSUFFICIENT",
  QUALIFICATION_STALE: "QUALIFICATION_STALE",
  QUALIFICATION_FUTURE_SKEW: "QUALIFICATION_FUTURE_SKEW",
  EPOCH_MISMATCH: "EPOCH_MISMATCH",
  OWNER_MISMATCH: "OWNER_MISMATCH",
  ADAPTER_MISMATCH: "ADAPTER_MISMATCH",
  ADAPTER_DIGEST_MISMATCH: "ADAPTER_DIGEST_MISMATCH",
  SCENARIO_MISMATCH: "SCENARIO_MISMATCH",
  SCENARIO_DIGEST_MISMATCH: "SCENARIO_DIGEST_MISMATCH",
  PRODUCER_NOT_ALLOWLISTED: "PRODUCER_NOT_ALLOWLISTED",
  STATUS_NOT_ALLOWLISTED: "STATUS_NOT_ALLOWLISTED",
  SOURCE_DIGEST_MISMATCH: "SOURCE_DIGEST_MISMATCH",
  IDENTITY_RECOMPUTE_MISMATCH: "IDENTITY_RECOMPUTE_MISMATCH",
  CHAIN_SCOPE_MISMATCH: "CHAIN_SCOPE_MISMATCH",
  COMPANION_CHAIN_MISSING: "COMPANION_CHAIN_MISSING",
  COMPANION_CHAIN_UNEXPECTED: "COMPANION_CHAIN_UNEXPECTED",
  PIN_BELOW_FLOOR: "PIN_BELOW_FLOOR",
  FLOOR_INEQUALITY: "FLOOR_INEQUALITY",
  PIN_CONFLICT: "PIN_CONFLICT",
  PIN_HEADER_INCONSISTENT: "PIN_HEADER_INCONSISTENT",
  PIN_TARGET_MISMATCH: "PIN_TARGET_MISMATCH",
  HEADER_STALE: "HEADER_STALE",
  HEADER_FUTURE_SKEW: "HEADER_FUTURE_SKEW",
  TRANSITION_ABOVE_OBSERVATION: "TRANSITION_ABOVE_OBSERVATION",
  TRANSITION_PIN_MISMATCH: "TRANSITION_PIN_MISMATCH",
  TRANSITION_STALE: "TRANSITION_STALE",
  TRANSITION_BEFORE_CUTOFF: "TRANSITION_BEFORE_CUTOFF",
  TRANSITION_FUTURE_SKEW: "TRANSITION_FUTURE_SKEW",
  SOURCE_STALE: "SOURCE_STALE",
  SOURCE_FUTURE_SKEW: "SOURCE_FUTURE_SKEW",
  SOURCE_BEFORE_CUTOFF: "SOURCE_BEFORE_CUTOFF",
  PRODUCER_STALE: "PRODUCER_STALE",
  PRODUCER_FUTURE_SKEW: "PRODUCER_FUTURE_SKEW",
  PRODUCER_BEFORE_CUTOFF: "PRODUCER_BEFORE_CUTOFF",
  OBSERVATION_STALE: "OBSERVATION_STALE",
  OBSERVATION_FUTURE_SKEW: "OBSERVATION_FUTURE_SKEW",
  OBSERVATION_BEFORE_CUTOFF: "OBSERVATION_BEFORE_CUTOFF",
  ECONOMICS_STALE: "ECONOMICS_STALE",
  ECONOMICS_FUTURE_SKEW: "ECONOMICS_FUTURE_SKEW",
  ECONOMICS_BEFORE_CUTOFF: "ECONOMICS_BEFORE_CUTOFF",
  INHERITED_SET_MISSING: "INHERITED_SET_MISSING",
  INHERITED_COUNT_MISMATCH: "INHERITED_COUNT_MISMATCH",
  INHERITED_DIGEST_MISMATCH: "INHERITED_DIGEST_MISMATCH",
  LINEAGE_PROVENANCE_MISMATCH: "LINEAGE_PROVENANCE_MISMATCH",
  CONSUMED_SCHEMA_UNSUPPORTED: "CONSUMED_SCHEMA_UNSUPPORTED",
  CONSUMED_PROVENANCE_INVALID: "CONSUMED_PROVENANCE_INVALID",
  CONSUMED_OUTCOME_INVALID: "CONSUMED_OUTCOME_INVALID",
  CONSUMED_EPOCH_MISMATCH: "CONSUMED_EPOCH_MISMATCH",
  CONSUMED_OWNER_MISMATCH: "CONSUMED_OWNER_MISMATCH",
  DUPLICATE_CONSUMED: "DUPLICATE_CONSUMED",
  IDENTITY_VERSION_UNSUPPORTED: "IDENTITY_VERSION_UNSUPPORTED",
  REPLAY_CONSUMED: "REPLAY_CONSUMED",
  DENY_SET_OVERFLOW: "DENY_SET_OVERFLOW",
  DENY_SET_SATURATED: "DENY_SET_SATURATED",
  INTERNAL_BLOCKED: "INTERNAL_BLOCKED"
});
const STATUS_OFFLINE_VALID = "OFFLINE_VALID";

/* -------------------- offline adapter semantics (defined only) ---------------- */
/* Only these offline adapter semantics exist in this phase. Each is fully defined
 * (identity kind, allowed fired statuses, allowlisted transition conditions or a
 * concrete recomputed route shape). No real producer adapter is wired, and no
 * producer roster is invented here: producers and their allowlists are manifest
 * data. */
const IDENTITY_KIND_TRANSITION = "STATE_TRANSITION";
const IDENTITY_KIND_QUOTE = "PIN_QUOTE";
const ROUTE_KEY_SCHEMA = "trigger-fork-epoch-route/v1";
const ROUTE_DIRECTIONS = Object.freeze(["POOL_A_TO_POOL_B", "POOL_B_TO_POOL_A"]);
const ADAPTER_REGISTRY = Object.freeze({
  "cross-venue-route-v1": Object.freeze({
    routeBearing: true, identityKinds: Object.freeze([IDENTITY_KIND_QUOTE]),
    statuses: Object.freeze(["ATOMIC_FORK_REQUIRED"]), conditions: null
  }),
  "pool-unpause-watch-v1": Object.freeze({
    routeBearing: false, identityKinds: Object.freeze([IDENTITY_KIND_TRANSITION]),
    statuses: Object.freeze(["TRIGGER_UNPAUSE"]),
    conditions: Object.freeze(["POOL_UNPAUSED"])
  })
});

/* --------------------------------- patterns --------------------------------- */
const UTC_MS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EPOCH_ID_PATTERN = /^EP-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCENARIO_ID_PATTERN = /^SC-[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const PRODUCER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const QTY_PATTERN = /^[0-9]{1,40}$/;
const HASH32_PATTERN = /^0x[0-9a-f]{64}$/; /* all digest/identifier fields carry the 0x prefix */
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

/* ----------------------------- internal machinery ---------------------------- */
class ContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "TriggerForkEpochContractError";
    this.code = code;
  }
}
function fail(code) { throw new ContractError(code); }

function blockResult(error) {
  const code = error && typeof error.code === "string" ? error.code : BLOCKERS.INTERNAL_BLOCKED;
  return Object.freeze({ status: "BLOCKED", code, semanticEventId: null, digest: null });
}
function okResult(semanticEventId) {
  return Object.freeze({ status: STATUS_OFFLINE_VALID, code: STATUS_OFFLINE_VALID, semanticEventId });
}
function guard(fn) {
  try {
    return fn();
  } catch (error) {
    return blockResult(error instanceof ContractError ? error : null);
  }
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value);
  }
  return value;
}

/* Digest helper: strictly internal use on already-validated, bounded, plain data.
 * Never exposed for arbitrary caller objects (no getter seam). */
function canonicalDigestOf(value) {
  return `0x${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

function assertPlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(code);
  return value;
}
function assertInt(value, min, max, code) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) fail(code);
  return value;
}
function assertString(value, code, pattern, maxChars) {
  if (typeof value !== "string" || value.length === 0) fail(typeof value === "string" ? code : BLOCKERS.FIELD_TYPE);
  if (value.length > (maxChars === undefined ? DESIGN_LIMITS.maxStringChars : maxChars)) {
    fail(BLOCKERS.STRING_TOO_LONG);
  }
  if (pattern !== undefined && !pattern.test(value)) fail(code);
  return value;
}
function assertExactKeys(object, keys, code) {
  assertPlainObject(object, code);
  const wants = new Set(keys);
  const got = Object.keys(object);
  if (got.length !== wants.size) fail(code);
  for (const key of got) if (!wants.has(key)) fail(code);
  return object;
}
function assertHash32(value) {
  if (typeof value !== "string" || !HASH32_PATTERN.test(value)) {
    fail(typeof value === "string" ? BLOCKERS.HASH_INVALID : BLOCKERS.FIELD_TYPE);
  }
  return value;
}
function assertAddress(value) {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    fail(typeof value === "string" ? BLOCKERS.ROUTE_FIELD_INVALID : BLOCKERS.FIELD_TYPE);
  }
  return value;
}
function assertQuantity(value, code) {
  if (typeof value !== "string" || !QTY_PATTERN.test(value)) {
    fail(typeof value === "string" ? (code === undefined ? BLOCKERS.QUANTITY_NONCANONICAL : code) : BLOCKERS.FIELD_TYPE);
  }
  if (value.length > 1 && value[0] === "0") fail(BLOCKERS.QUANTITY_NONCANONICAL);
  return value;
}
function parseUtcMs(value, code) {
  if (typeof value !== "string" || value.length !== 24 || !UTC_MS_PATTERN.test(value)) {
    fail(typeof value === "string" ? (code === undefined ? BLOCKERS.TIMESTAMP_NONCANONICAL : code) : BLOCKERS.FIELD_TYPE);
  }
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || new Date(ms).toISOString() !== value) {
    fail(code === undefined ? BLOCKERS.TIMESTAMP_NONCANONICAL : code);
  }
  return ms;
}
function compareDecimals(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
function assertUniqueInts(list, code, max) {
  if (!Array.isArray(list)) fail(code);
  if (list.length > (max === undefined ? DESIGN_LIMITS.companionChains : max)) {
    fail(BLOCKERS.COLLECTION_TOO_LARGE);
  }
  const seen = new Set();
  for (const item of list) {
    assertInt(item, 1, 4294967295, code);
    if (seen.has(item)) fail(code);
    seen.add(item);
  }
  return list;
}
function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/* ----------------------------- boundary layer ------------------------------- */
function prescanDepth(text) {
  let depth = 0;
  let max = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") {
      depth += 1;
      if (depth > max) max = depth;
    } else if (ch === "}" || ch === "]") depth -= 1;
  }
  return max;
}
function boundedParse(text, maxBytes) {
  if (typeof text !== "string") fail(BLOCKERS.PARAM_FIELD_INVALID);
  if (Buffer.byteLength(text, "utf8") > maxBytes) fail(BLOCKERS.BOUNDARY_SIZE);
  if (prescanDepth(text) > DESIGN_LIMITS.maxDepth) fail(BLOCKERS.BOUNDARY_DEPTH);
  let parsed;
  try {
    parsed = parseStrictJson(text);
  } catch (error) {
    fail(BLOCKERS.PARSE_BLOCKED);
  }
  walkBounds(parsed, 1);
  return parsed;
}
function walkBounds(node, depth) {
  if (node === null || typeof node === "boolean" || typeof node === "number") {
    if (typeof node === "number" && !Number.isSafeInteger(node)) fail(BLOCKERS.PARSE_BLOCKED);
    return;
  }
  if (typeof node === "string") {
    if (node.length > DESIGN_LIMITS.maxStringChars) fail(BLOCKERS.STRING_TOO_LONG);
    return;
  }
  if (depth > DESIGN_LIMITS.maxDepth) fail(BLOCKERS.BOUNDARY_DEPTH);
  if (Array.isArray(node)) {
    if (node.length > DESIGN_LIMITS.maxArrayItems) fail(BLOCKERS.COLLECTION_TOO_LARGE);
    for (const item of node) walkBounds(item, depth + 1);
    return;
  }
  if (Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null) {
    fail(BLOCKERS.BOUNDARY_STRUCTURE);
  }
  if (Object.keys(node).length > DESIGN_LIMITS.maxObjectKeys) fail(BLOCKERS.COLLECTION_TOO_LARGE);
  for (const key of Object.keys(node)) {
    if (typeof key !== "string" || key.length > DESIGN_LIMITS.maxKeyChars) fail(BLOCKERS.STRING_TOO_LONG);
    walkBounds(node[key], depth + 1);
  }
}

/* -------------------------------- pins -------------------------------------- */
function parsePin(object) {
  assertExactKeys(object, ["chainId", "blockNumber", "blockHash", "headerTime"],
    BLOCKERS.FIELD_UNKNOWN);
  return Object.freeze({
    chainId: assertInt(object.chainId, 1, 4294967295, BLOCKERS.VALUE_INVALID),
    blockNumber: assertQuantity(object.blockNumber),
    blockHash: assertHash32(object.blockHash),
    headerTime: object.headerTime,
    headerTimeMs: parseUtcMs(object.headerTime)
  });
}

/* ------------------------------- manifest layer ------------------------------ */
const HANDLES = new WeakSet();
function parseManifestObject(raw) {
  assertPlainObject(raw, BLOCKERS.BOUNDARY_STRUCTURE);
  assertExactKeys(raw, ["schema", "epochId", "policyVersion", "identitySchemaVersion",
    "ownerBinding", "createdAt", "notBefore", "expiresAt", "bounds", "scope", "chains",
    "legacy", "predecessor"], BLOCKERS.FIELD_UNKNOWN);
  if (raw.schema !== MANIFEST_SCHEMA) fail(BLOCKERS.SCHEMA_UNSUPPORTED);
  const epochId = assertString(raw.epochId, BLOCKERS.VALUE_INVALID, EPOCH_ID_PATTERN, 67);
  if (raw.policyVersion !== POLICY_VERSION) fail(BLOCKERS.SCHEMA_UNSUPPORTED);
  if (raw.identitySchemaVersion !== IDENTITY_SCHEMA_VERSION) fail(BLOCKERS.SCHEMA_UNSUPPORTED);
  assertExactKeys(raw.ownerBinding, ["policyVersion", "proposalDigest"], BLOCKERS.FIELD_UNKNOWN);
  if (raw.ownerBinding.policyVersion !== OWNER_POLICY_VERSION) fail(BLOCKERS.SCHEMA_UNSUPPORTED);
  assertHash32(raw.ownerBinding.proposalDigest);
  const createdAtMs = parseUtcMs(raw.createdAt);
  const notBeforeMs = parseUtcMs(raw.notBefore);
  const expiresAtMs = parseUtcMs(raw.expiresAt);
  if (!(createdAtMs <= notBeforeMs && notBeforeMs < expiresAtMs)) fail(BLOCKERS.VALUE_INVALID);
  if (expiresAtMs - notBeforeMs > DESIGN_LIMITS.epochLifetimeMs
      || expiresAtMs - createdAtMs > DESIGN_LIMITS.epochLifetimeMs) fail(BLOCKERS.LIFETIME_EXCEEDED);
  parseBounds(raw.bounds);
  const scope = parseScope(raw.scope);
  const chains = parseChains(raw.chains, scope.companionChainIds.concat(scope.primaryChainId));
  const legacy = parseLegacy(raw.legacy);
  const predecessor = parsePredecessor(raw.predecessor, raw.bounds, epochId, notBeforeMs,
    raw.legacy.archiveDigest);
  return buildManifest(raw, { epochId, scope, chains, legacy, predecessor });
}
function parseBounds(raw) {
  assertExactKeys(raw, ["maxConsumedIdentities", "sourceMaxAgeMs", "observationMaxAgeMs",
    "floorQualificationMaxAgeMs", "futureSkewMs", "promotionMaxAgeMs", "forkBudgetMs",
    "cleanupBudgetMs", "maxInFlight"], BLOCKERS.FIELD_UNKNOWN);
  const spec = [
    ["maxConsumedIdentities", 1, DESIGN_LIMITS.maxConsumedIdentities],
    ["sourceMaxAgeMs", 1, DESIGN_LIMITS.sourceMaxAgeMs],
    ["observationMaxAgeMs", 1, DESIGN_LIMITS.observationMaxAgeMs],
    ["floorQualificationMaxAgeMs", 1, DESIGN_LIMITS.floorQualificationMaxAgeMs],
    ["futureSkewMs", 0, DESIGN_LIMITS.futureSkewMs],
    ["promotionMaxAgeMs", 1, DESIGN_LIMITS.promotionMaxAgeMs],
    ["forkBudgetMs", 1, DESIGN_LIMITS.forkBudgetMs],
    ["cleanupBudgetMs", 0, DESIGN_LIMITS.cleanupBudgetMs]
  ];
  for (const [field, min, max] of spec) assertInt(raw[field], min, max, BLOCKERS.BOUND_EXCEEDS_DESIGN);
  if (raw.maxInFlight !== DESIGN_LIMITS.maxInFlight) fail(BLOCKERS.BOUND_EXCEEDS_DESIGN);
}
function parseScope(raw) {
  assertPlainObject(raw, BLOCKERS.FIELD_UNKNOWN);
  assertExactKeys(raw, ["primaryChainId", "companionChainIds", "adapterId", "scenarioId",
    "adapterDigest", "scenarioDigest", "producerAllowlist", "firedStatusAllowlist"],
    BLOCKERS.FIELD_UNKNOWN);
  const primaryChainId = assertInt(raw.primaryChainId, 1, 4294967295, BLOCKERS.VALUE_INVALID);
  const companionChainIds = assertUniqueInts(raw.companionChainIds, BLOCKERS.VALUE_INVALID,
    DESIGN_LIMITS.companionChains).slice();
  if (companionChainIds.includes(primaryChainId)) fail(BLOCKERS.CHAIN_SCOPE_MISMATCH);
  if (typeof raw.adapterId !== "string") fail(BLOCKERS.ADAPTER_UNSUPPORTED);
  const adapter = hasOwn(ADAPTER_REGISTRY, raw.adapterId) ? ADAPTER_REGISTRY[raw.adapterId] : null;
  if (!adapter) fail(BLOCKERS.ADAPTER_UNSUPPORTED);
  const scenarioId = assertString(raw.scenarioId, BLOCKERS.VALUE_INVALID, SCENARIO_ID_PATTERN, 35);
  assertHash32(raw.adapterDigest);
  assertHash32(raw.scenarioDigest);
  const producerAllowlist = parseProducerAllowlist(raw.producerAllowlist);
  const firedStatusAllowlist = parseStatusAllowlist(raw.firedStatusAllowlist, adapter.statuses);
  producerAllowlist.sort();
  firedStatusAllowlist.sort();
  companionChainIds.sort((a, b) => a - b);
  return {
    primaryChainId,
    companionChainIds,
    adapterId: raw.adapterId,
    scenarioId,
    adapterDigest: raw.adapterDigest,
    scenarioDigest: raw.scenarioDigest,
    producerAllowlist,
    firedStatusAllowlist
  };
}
function parseProducerAllowlist(list) {
  if (!Array.isArray(list) || list.length === 0) fail(BLOCKERS.VALUE_INVALID);
  const seen = new Set();
  for (const item of list) {
    assertString(item, BLOCKERS.VALUE_INVALID, PRODUCER_ID_PATTERN, 64);
    if (seen.has(item)) fail(BLOCKERS.VALUE_INVALID);
    seen.add(item);
  }
  return list.slice();
}
function parseStatusAllowlist(list, adapterStatuses) {
  if (!Array.isArray(list) || list.length === 0) fail(BLOCKERS.VALUE_INVALID);
  const adapterSet = new Set(adapterStatuses);
  const seen = new Set();
  for (const item of list) {
    assertString(item, BLOCKERS.VALUE_INVALID, undefined, 64);
    if (!adapterSet.has(item)) fail(BLOCKERS.STATUS_NOT_IN_ADAPTER);
    if (seen.has(item)) fail(BLOCKERS.VALUE_INVALID);
    seen.add(item);
  }
  return list.slice();
}
function parseChains(raw, requiredChainIds) {
  assertPlainObject(raw, BLOCKERS.FIELD_UNKNOWN);
  const wanted = new Set(requiredChainIds.map((id) => String(id)));
  const got = new Set(Object.keys(raw));
  for (const key of wanted) if (!got.has(key)) fail(BLOCKERS.FIELD_MISSING);
  if (got.size !== wanted.size) fail(BLOCKERS.FIELD_UNKNOWN);
  const chainsByKey = Object.create(null);
  for (const key of wanted) {
    chainsByKey[key] = parseChainRecord(raw[key]);
  }
  return chainsByKey;
}
function parseChainRecord(record) {
  assertPlainObject(record, BLOCKERS.FIELD_UNKNOWN);
  assertExactKeys(record, ["floorBlockNumber", "floorBlockHash", "floorHeaderTime", "qualifiedAt",
    "independence"], BLOCKERS.FIELD_UNKNOWN);
  const floorBlockNumber = assertQuantity(record.floorBlockNumber);
  assertHash32(record.floorBlockHash);
  parseUtcMs(record.floorHeaderTime);
  parseUtcMs(record.qualifiedAt);
  const independence = parseIndependence(record.independence);
  return {
    floorBlockNumber,
    floorBlockHash: record.floorBlockHash,
    floorHeaderTime: record.floorHeaderTime,
    qualifiedAt: record.qualifiedAt,
    independence
  };
}
function parseIndependence(raw) {
  assertExactKeys(raw, ["policyVersion", "qualifyingSourceCount", "distinctOperationalControl",
    "distinctUpstreamPath", "unknownSharedProvenance"], BLOCKERS.FIELD_UNKNOWN);
  if (raw.policyVersion !== INDEPENDENCE_POLICY_VERSION) fail(BLOCKERS.SCHEMA_UNSUPPORTED);
  assertInt(raw.qualifyingSourceCount, 2, 4096, BLOCKERS.INDEPENDENCE_INSUFFICIENT);
  if (raw.distinctOperationalControl !== true || raw.distinctUpstreamPath !== true) {
    fail(BLOCKERS.INDEPENDENCE_UNPROVEN);
  }
  if (raw.unknownSharedProvenance !== false) fail(BLOCKERS.INDEPENDENCE_UNPROVEN);
  return {
    policyVersion: INDEPENDENCE_POLICY_VERSION,
    qualifyingSourceCount: raw.qualifyingSourceCount,
    distinctOperationalControl: true,
    distinctUpstreamPath: true,
    unknownSharedProvenance: false
  };
}
function parseLegacy(raw) {
  assertPlainObject(raw, BLOCKERS.FIELD_UNKNOWN);
  assertExactKeys(raw, ["disposition", "archiveDigest", "rationaleCode", "searchPolicyCode"],
    BLOCKERS.FIELD_UNKNOWN);
  if (raw.disposition !== LEGACY_DISPOSITION) fail(BLOCKERS.SCHEMA_UNSUPPORTED);
  assertHash32(raw.archiveDigest);
  if (!LEGACY_RATIONALE_CODES.includes(raw.rationaleCode)) fail(BLOCKERS.VALUE_INVALID);
  if (!LEGACY_SEARCH_POLICY_CODES.includes(raw.searchPolicyCode)) fail(BLOCKERS.VALUE_INVALID);
  return {
    disposition: LEGACY_DISPOSITION,
    archiveDigest: raw.archiveDigest,
    rationaleCode: raw.rationaleCode,
    searchPolicyCode: raw.searchPolicyCode
  };
}
function parsePredecessor(raw, bounds, epochId, notBeforeMs, archiveDigest) {
  assertPlainObject(raw, BLOCKERS.FIELD_UNKNOWN);
  assertExactKeys(raw, ["predecessorEpochId", "lineageDigest", "ancestry",
    "inheritedConsumedCount", "inheritedConsumedDigest", "identitySchemaVersion",
    "unknownGapPolicy", "gaps"], BLOCKERS.FIELD_UNKNOWN);
  if (raw.identitySchemaVersion !== IDENTITY_SCHEMA_VERSION) fail(BLOCKERS.SCHEMA_UNSUPPORTED);
  if (raw.unknownGapPolicy !== UNKNOWN_GAP_POLICY) fail(BLOCKERS.GAP_POLICY_UNSUPPORTED);
  let predecessorEpochId;
  let lineageDigest;
  const ancestry = [];
  if (raw.predecessorEpochId === null) {
    /* Legacy-only root mode: the FIRST epoch after an incomplete legacy archive may
     * bind its lineage directly to the recorded legacy archive digest and carry NO
     * predecessor epoch. It can inherit only correctly bound LEGACY_ARCHIVE records;
     * predecessor/current records cannot masquerade as root history. This invents
     * no historical identity. */
    if (!Array.isArray(raw.ancestry) || raw.ancestry.length !== 0) fail(BLOCKERS.ANCESTRY_INCOHERENT);
    if (typeof raw.lineageDigest !== "string" || raw.lineageDigest !== archiveDigest) {
      fail(BLOCKERS.ANCESTRY_INCOHERENT);
    }
    predecessorEpochId = null;
    lineageDigest = archiveDigest;
  } else {
    predecessorEpochId = assertString(raw.predecessorEpochId, BLOCKERS.PREDECESSOR_MISMATCH,
      EPOCH_ID_PATTERN, 67);
    if (predecessorEpochId === epochId) fail(BLOCKERS.PREDECESSOR_MISMATCH);
    assertHash32(raw.lineageDigest);
    if (!Array.isArray(raw.ancestry) || raw.ancestry.length < 1) fail(BLOCKERS.ANCESTRY_INCOHERENT);
    if (raw.ancestry.length > DESIGN_LIMITS.ancestryEntries) fail(BLOCKERS.COLLECTION_TOO_LARGE);
    const seenAncestryEpochs = new Set();
    for (let i = 0; i < raw.ancestry.length; i += 1) {
      const entry = raw.ancestry[i];
      assertExactKeys(entry, ["epochId", "lineageDigest"], BLOCKERS.FIELD_UNKNOWN);
      const entryEpochId = assertString(entry.epochId, BLOCKERS.LINEAGE_PROVENANCE_MISMATCH,
        EPOCH_ID_PATTERN, 67);
      if (entryEpochId === epochId) fail(BLOCKERS.PREDECESSOR_MISMATCH);
      /* each epochId binds once: two different digests for one epoch are contradictory */
      if (seenAncestryEpochs.has(entryEpochId)) fail(BLOCKERS.ANCESTRY_INCOHERENT);
      seenAncestryEpochs.add(entryEpochId);
      assertHash32(entry.lineageDigest);
      ancestry.push({ epochId: entryEpochId, lineageDigest: entry.lineageDigest });
    }
    if (ancestry[0].epochId !== predecessorEpochId || ancestry[0].lineageDigest !== raw.lineageDigest) {
      fail(BLOCKERS.ANCESTRY_INCOHERENT);
    }
    lineageDigest = raw.lineageDigest;
  }
  assertInt(raw.inheritedConsumedCount, 0, bounds.maxConsumedIdentities,
    BLOCKERS.BOUND_EXCEEDS_DESIGN);
  assertHash32(raw.inheritedConsumedDigest);
  if (!Array.isArray(raw.gaps)) fail(BLOCKERS.FIELD_TYPE);
  if (raw.gaps.length > DESIGN_LIMITS.maxGaps) fail(BLOCKERS.COLLECTION_TOO_LARGE);
  const gaps = [];
  const seenGaps = new Set();
  for (const gap of raw.gaps) {
    assertExactKeys(gap, ["gapDigest", "cutoff", "excludedByCutoff", "excludedByAdapterScope"],
      BLOCKERS.FIELD_UNKNOWN);
    assertHash32(gap.gapDigest);
    if (seenGaps.has(gap.gapDigest)) fail(BLOCKERS.VALUE_INVALID);
    seenGaps.add(gap.gapDigest);
    const cutoffMs = parseUtcMs(gap.cutoff);
    if (typeof gap.excludedByCutoff !== "boolean" || typeof gap.excludedByAdapterScope !== "boolean") {
      fail(BLOCKERS.FIELD_TYPE);
    }
    if (gap.excludedByCutoff !== true) fail(BLOCKERS.GAP_EXCLUSION_UNSUPPORTED);
    if (gap.excludedByAdapterScope !== false) fail(BLOCKERS.GAP_EXCLUSION_UNSUPPORTED);
    if (cutoffMs > notBeforeMs) fail(BLOCKERS.GAP_CUTOFF_INVALID);
    /* export the EXACT input-schema field shape so valid gap manifests roundtrip;
     * cutoff milliseconds are re-derived on admission */
    gaps.push({
      gapDigest: gap.gapDigest,
      cutoff: gap.cutoff,
      excludedByCutoff: gap.excludedByCutoff,
      excludedByAdapterScope: gap.excludedByAdapterScope
    });
  }
  gaps.sort((a, b) => (a.gapDigest < b.gapDigest ? -1 : a.gapDigest > b.gapDigest ? 1 : 0));
  return {
    predecessorEpochId,
    lineageDigest,
    ancestry,
    inheritedConsumedCount: raw.inheritedConsumedCount,
    inheritedConsumedDigest: raw.inheritedConsumedDigest,
    identitySchemaVersion: IDENTITY_SCHEMA_VERSION,
    unknownGapPolicy: UNKNOWN_GAP_POLICY,
    gaps
  };
}
function buildManifest(raw, parsed) {
  /* Public normalized rebuild: schema-shaped, order-canonicalized arrays, no
   * derived fields — JSON of this value re-parses to the same canonical digest. */
  const chainsPublic = {};
  for (const key of Object.keys(parsed.chains).sort((a, b) => Number(a) - Number(b))) {
    chainsPublic[key] = parsed.chains[key];
  }
  const manifest = {
    schema: MANIFEST_SCHEMA,
    epochId: parsed.epochId,
    policyVersion: POLICY_VERSION,
    identitySchemaVersion: IDENTITY_SCHEMA_VERSION,
    ownerBinding: {
      policyVersion: OWNER_POLICY_VERSION,
      proposalDigest: raw.ownerBinding.proposalDigest
    },
    createdAt: raw.createdAt,
    notBefore: raw.notBefore,
    expiresAt: raw.expiresAt,
    bounds: {
      maxConsumedIdentities: raw.bounds.maxConsumedIdentities,
      sourceMaxAgeMs: raw.bounds.sourceMaxAgeMs,
      observationMaxAgeMs: raw.bounds.observationMaxAgeMs,
      floorQualificationMaxAgeMs: raw.bounds.floorQualificationMaxAgeMs,
      futureSkewMs: raw.bounds.futureSkewMs,
      promotionMaxAgeMs: raw.bounds.promotionMaxAgeMs,
      forkBudgetMs: raw.bounds.forkBudgetMs,
      cleanupBudgetMs: raw.bounds.cleanupBudgetMs,
      maxInFlight: raw.bounds.maxInFlight
    },
    scope: parsed.scope,
    chains: chainsPublic,
    legacy: parsed.legacy,
    predecessor: parsed.predecessor
  };
  const digest = canonicalDigestOf(manifest);
  deepFreeze(manifest);
  const handle = deepFreeze({ manifest, digest });
  HANDLES.add(handle);
  return handle;
}
function requireValidatedManifestHandle(candidate) {
  /* WeakSet membership is identity-based: inherited lookalikes, copied markers,
   * forged wrappers and raw inner objects are never members. No property of an
   * unregistered object is read, so no accessor can run. */
  if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
      && HANDLES.has(candidate)) {
    return candidate;
  }
  fail(BLOCKERS.PARAM_MANIFEST_UNVALIDATED);
  return null; /* unreachable */
}

/* -------------------------------- event layer -------------------------------- */
const EVENT_BASE_KEYS = ["schema", "identitySchemaVersion", "adapterId", "adapterDigest",
  "producerId", "firedStatus", "scenarioId", "scenarioDigest", "epochId",
  "ownerProposalDigest", "source", "producer", "observation", "primary", "companions",
  "target"];
function parseEventObject(raw) {
  assertPlainObject(raw, BLOCKERS.BOUNDARY_STRUCTURE);
  if (raw.schema !== EVENT_SCHEMA) fail(BLOCKERS.SCHEMA_UNSUPPORTED);
  if (raw.identitySchemaVersion !== IDENTITY_SCHEMA_VERSION) fail(BLOCKERS.SCHEMA_UNSUPPORTED);
  if (typeof raw.adapterId !== "string") fail(BLOCKERS.ADAPTER_UNSUPPORTED);
  const adapter = hasOwn(ADAPTER_REGISTRY, raw.adapterId) ? ADAPTER_REGISTRY[raw.adapterId] : null;
  if (!adapter) fail(BLOCKERS.ADAPTER_UNSUPPORTED);
  const hasCallerId = hasOwn(raw, "semanticEventId");
  assertExactKeys(raw, hasCallerId ? EVENT_BASE_KEYS.concat(["semanticEventId"]) : EVENT_BASE_KEYS,
    BLOCKERS.FIELD_UNKNOWN);
  let callerId;
  if (hasCallerId) callerId = assertHash32(raw.semanticEventId);
  assertString(raw.producerId, BLOCKERS.VALUE_INVALID, PRODUCER_ID_PATTERN, 64);
  assertString(raw.firedStatus, BLOCKERS.VALUE_INVALID, undefined, 64);
  if (!adapter.statuses.includes(raw.firedStatus)) fail(BLOCKERS.STATUS_NOT_IN_ADAPTER);
  const scenarioId = assertString(raw.scenarioId, BLOCKERS.VALUE_INVALID, SCENARIO_ID_PATTERN, 35);
  assertHash32(raw.adapterDigest);
  assertHash32(raw.scenarioDigest);
  assertString(raw.epochId, BLOCKERS.VALUE_INVALID, EPOCH_ID_PATTERN, 67);
  assertHash32(raw.ownerProposalDigest);
  assertExactKeys(raw.source, ["digest", "observedAt"], BLOCKERS.FIELD_UNKNOWN);
  assertHash32(raw.source.digest);
  const sourceObservedAtMs = parseUtcMs(raw.source.observedAt);
  assertExactKeys(raw.producer, ["generatedAt"], BLOCKERS.FIELD_UNKNOWN);
  const producerGeneratedAtMs = parseUtcMs(raw.producer.generatedAt);
  assertExactKeys(raw.observation, ["at"], BLOCKERS.FIELD_UNKNOWN);
  const observationAtMs = parseUtcMs(raw.observation.at);
  const primary = parsePin(raw.primary);
  if (!Array.isArray(raw.companions)) fail(BLOCKERS.FIELD_TYPE);
  const companions = [];
  const seenCompanionChains = new Set();
  for (const companionPin of raw.companions) {
    const pin = parsePin(companionPin);
    if (pin.chainId === primary.chainId) fail(BLOCKERS.CHAIN_SCOPE_MISMATCH);
    if (seenCompanionChains.has(pin.chainId)) fail(BLOCKERS.CHAIN_SCOPE_MISMATCH);
    seenCompanionChains.add(pin.chainId);
    companions.push(pin);
  }
  const target = parseTarget(raw.target, adapter, primary);
  /* Derived offline datum (design section 3): route-bearing adapters carry a
   * recomputed domain-separated route key; reviewed non-route adapters carry the
   * explicit null. This is ALWAYS recomputed from already-validated fields — it is
   * a parse result, not an input field, and is not part of the semantic identity
   * (the identity binds the concrete route object itself). */
  const routeKey = target.kind === IDENTITY_KIND_QUOTE
    ? computeRouteKey(target.route, target.chainId)
    : null;
  const event = deepFreeze({
    schema: EVENT_SCHEMA,
    identitySchemaVersion: IDENTITY_SCHEMA_VERSION,
    adapterId: raw.adapterId,
    adapterDigest: raw.adapterDigest,
    producerId: raw.producerId,
    firedStatus: raw.firedStatus,
    scenarioId,
    scenarioDigest: raw.scenarioDigest,
    epochId: raw.epochId,
    ownerProposalDigest: raw.ownerProposalDigest,
    source: { digest: raw.source.digest, observedAt: raw.source.observedAt, observedAtMs: sourceObservedAtMs },
    producer: { generatedAt: raw.producer.generatedAt, generatedAtMs: producerGeneratedAtMs },
    observation: { at: raw.observation.at, atMs: observationAtMs },
    primary,
    companions,
    target,
    routeKey
  });
  const semanticEventId = computeSemanticEventId(event, callerId);
  return { event, semanticEventId };
}
/* Route-key composition (recorded): "0x" + sha256(canonicalize(
 * { schema: "trigger-fork-epoch-route/v1", chainId, route })) — computed from the
 * already validated canonical route fields and the event chain identifier only. */
function computeRouteKey(route, chainId) {
  return canonicalDigestOf({ schema: ROUTE_KEY_SCHEMA, chainId, route });
}
function computeSemanticEventId(event, callerId) {
  /* Producer/adapter labels, epoch/owner context, source digests and observation
   * times are deliberately EXCLUDED; two allowed producers observing the same
   * defined semantic event share one identity. */
  if (event.target.kind === IDENTITY_KIND_TRANSITION) {
    const semanticEventId = canonicalDigestOf({
      schema: IDENTITY_SCHEMA,
      identityVersion: IDENTITY_SCHEMA_VERSION,
      kind: IDENTITY_KIND_TRANSITION,
      chainId: event.target.chainId,
      firedStatus: event.firedStatus,
      subjectContract: event.target.subject.contract,
      conditionId: event.target.conditionId,
      transitionBlockNumber: event.target.transition.blockNumber,
      transitionBlockHash: event.target.transition.blockHash
    });
    if (callerId !== undefined && callerId !== semanticEventId) fail(BLOCKERS.IDENTITY_RECOMPUTE_MISMATCH);
    return semanticEventId;
  }
  const semanticEventId = canonicalDigestOf({
    schema: IDENTITY_SCHEMA,
    identityVersion: IDENTITY_SCHEMA_VERSION,
    kind: IDENTITY_KIND_QUOTE,
    chainId: event.target.chainId,
    firedStatus: event.firedStatus,
    pinBlockNumber: event.target.pin.blockNumber,
    pinBlockHash: event.target.pin.blockHash,
    route: event.target.route,
    amountInRaw: event.target.candidate.amountInRaw,
    expectedOutRaw: event.target.candidate.expectedOutRaw
  });
  if (callerId !== undefined && callerId !== semanticEventId) fail(BLOCKERS.IDENTITY_RECOMPUTE_MISMATCH);
  return semanticEventId;
}
function parseRoute(raw) {
  assertExactKeys(raw, ["tokenIn", "tokenOut", "poolA", "poolB", "direction"],
    BLOCKERS.ROUTE_FIELD_INVALID);
  assertAddress(raw.tokenIn);
  assertAddress(raw.tokenOut);
  assertAddress(raw.poolA);
  assertAddress(raw.poolB);
  if (!ROUTE_DIRECTIONS.includes(raw.direction)) fail(BLOCKERS.ROUTE_FIELD_INVALID);
  /* Canonical input rule: pools must be distinct and lowercase lexically ordered
   * (poolA < poolB); direction then carries the actual execution order. Producer
   * adapters must normalize ordered pool references before building this contract;
   * the swapped-pool equivalent (order preserved by flipping direction) is the same
   * real route and is rejected rather than aliasing into a second semantic identity. */
  if (raw.poolA >= raw.poolB) fail(BLOCKERS.ROUTE_FIELD_INVALID);
  return Object.freeze({
    tokenIn: raw.tokenIn,
    tokenOut: raw.tokenOut,
    poolA: raw.poolA,
    poolB: raw.poolB,
    direction: raw.direction
  });
}
function parseTarget(raw, adapter, primary) {
  assertPlainObject(raw, BLOCKERS.FIELD_UNKNOWN);
  if (!adapter.identityKinds.includes(raw.kind)) fail(BLOCKERS.KIND_UNSUPPORTED);
  assertInt(raw.chainId, 1, 4294967295, BLOCKERS.VALUE_INVALID);
  if (raw.chainId !== primary.chainId) fail(BLOCKERS.CHAIN_SCOPE_MISMATCH);
  if (raw.kind === IDENTITY_KIND_TRANSITION) {
    assertExactKeys(raw, ["kind", "chainId", "subject", "conditionId", "transition"],
      BLOCKERS.FIELD_UNKNOWN);
    assertExactKeys(raw.subject, ["contract"], BLOCKERS.FIELD_UNKNOWN);
    assertAddress(raw.subject.contract);
    assertString(raw.conditionId, BLOCKERS.CONDITION_UNSUPPORTED, undefined, 64);
    if (!adapter.conditions.includes(raw.conditionId)) fail(BLOCKERS.CONDITION_UNSUPPORTED);
    assertExactKeys(raw.transition, ["blockNumber", "blockHash", "headerTime"], BLOCKERS.FIELD_UNKNOWN);
    return {
      kind: IDENTITY_KIND_TRANSITION,
      route: null,
      chainId: raw.chainId,
      subject: { contract: raw.subject.contract },
      conditionId: raw.conditionId,
      transition: {
        blockNumber: assertQuantity(raw.transition.blockNumber),
        blockHash: assertHash32(raw.transition.blockHash),
        headerTime: raw.transition.headerTime,
        headerTimeMs: parseUtcMs(raw.transition.headerTime)
      },
      pin: null,
      candidate: null
    };
  }
  /* PIN_QUOTE: route-bearing adapters only; the normalized route key is recomputed
   * from the concrete allowlisted route fields; all economics stay bound to the pin. */
  assertExactKeys(raw, ["kind", "chainId", "pin", "route", "candidate"], BLOCKERS.FIELD_UNKNOWN);
  assertExactKeys(raw.pin, ["blockNumber", "blockHash"], BLOCKERS.FIELD_UNKNOWN);
  const pinBlockNumber = assertQuantity(raw.pin.blockNumber);
  const pinBlockHash = assertHash32(raw.pin.blockHash);
  if (pinBlockNumber !== primary.blockNumber || pinBlockHash !== primary.blockHash) {
    fail(BLOCKERS.PIN_TARGET_MISMATCH);
  }
  const route = parseRoute(raw.route);
  assertExactKeys(raw.candidate, ["amountInRaw", "expectedOutRaw", "economicsObservedAt"],
    BLOCKERS.FIELD_UNKNOWN);
  const economicsObservedAtMs = parseUtcMs(raw.candidate.economicsObservedAt);
  return {
    kind: IDENTITY_KIND_QUOTE,
    route,
    chainId: raw.chainId,
    subject: null,
    conditionId: null,
    transition: null,
    pin: { blockNumber: pinBlockNumber, blockHash: pinBlockHash },
    candidate: {
      amountInRaw: assertQuantity(raw.candidate.amountInRaw),
      expectedOutRaw: assertQuantity(raw.candidate.expectedOutRaw),
      economicsObservedAt: raw.candidate.economicsObservedAt,
      economicsObservedAtMs
    }
  };
}

/* ------------------------------- consumed layer ------------------------------ */
const CONSUMED_KEYS = ["schema", "identitySchemaVersion", "semanticEventId", "outcome", "provenance"];
const OUTCOME_SET = Object.freeze(["SUCCESS", "FAILED", "UNCERTAIN", "REJECTED"]);
function validateConsumedRecordShape(record) {
  /* Strict shape/schema/outcome/provenance validation WITHOUT any manifest binding —
   * used by the writer-side digest helper. Cross-binding remains admission's job. */
  assertExactKeys(record, CONSUMED_KEYS, BLOCKERS.CONSUMED_SCHEMA_UNSUPPORTED);
  if (record.schema !== CONSUMED_SCHEMA) fail(BLOCKERS.CONSUMED_SCHEMA_UNSUPPORTED);
  if (record.identitySchemaVersion !== IDENTITY_SCHEMA_VERSION) fail(BLOCKERS.IDENTITY_VERSION_UNSUPPORTED);
  assertHash32(record.semanticEventId);
  if (typeof record.outcome !== "string" || !OUTCOME_SET.includes(record.outcome)) {
    fail(BLOCKERS.CONSUMED_OUTCOME_INVALID);
  }
  assertPlainObject(record.provenance, BLOCKERS.CONSUMED_PROVENANCE_INVALID);
  const source = record.provenance.source;
  if (source === "PREDECESSOR_EPOCH") {
    assertExactKeys(record.provenance, ["source", "epochId", "lineageDigest"],
      BLOCKERS.CONSUMED_PROVENANCE_INVALID);
    assertString(record.provenance.epochId, BLOCKERS.CONSUMED_PROVENANCE_INVALID, EPOCH_ID_PATTERN, 67);
    assertHash32(record.provenance.lineageDigest);
  } else if (source === "LEGACY_ARCHIVE") {
    assertExactKeys(record.provenance, ["source", "lineageDigest"],
      BLOCKERS.CONSUMED_PROVENANCE_INVALID);
    assertHash32(record.provenance.lineageDigest);
  } else if (source === "CURRENT_EPOCH") {
    assertExactKeys(record.provenance, ["source", "epochId", "ownerProposalDigest"],
      BLOCKERS.CONSUMED_PROVENANCE_INVALID);
    assertString(record.provenance.epochId, BLOCKERS.CONSUMED_PROVENANCE_INVALID, EPOCH_ID_PATTERN, 67);
    assertHash32(record.provenance.ownerProposalDigest);
  } else {
    fail(BLOCKERS.CONSUMED_PROVENANCE_INVALID);
  }
  return source;
}
function consumedSetDigestOfParsedRecords(records) {
  const perRecord = records.map((record) => canonicalDigestOf(record));
  perRecord.sort();
  return canonicalDigestOf(perRecord);
}
function consumedSetDigest(recordsText) {
  return guard(() => {
    const parsed = boundedParse(recordsText, DESIGN_LIMITS.consumedSetBytes);
    if (!Array.isArray(parsed)) fail(BLOCKERS.FIELD_TYPE);
    /* Every record is validated individually. Mixed LEGACY_ARCHIVE +
     * PREDECESSOR_EPOCH origins are legitimate in one inherited set (historical
     * preservation binds both); CURRENT_EPOCH may only form an all-current set.
     * Duplicate semantic identities are refused before any digest exists. */
    let role = null;
    const seen = new Set();
    for (const record of parsed) {
      const source = validateConsumedRecordShape(record);
      const recordRole = source === "CURRENT_EPOCH" ? "CURRENT_EPOCH" : "INHERITED";
      if (role === null) role = recordRole;
      else if (role !== recordRole) fail(BLOCKERS.CONSUMED_PROVENANCE_INVALID);
      if (seen.has(record.semanticEventId)) fail(BLOCKERS.DUPLICATE_CONSUMED);
      seen.add(record.semanticEventId);
    }
    return Object.freeze({ digest: consumedSetDigestOfParsedRecords(parsed) });
  });
}
function parseConsumedRecordAgainstManifest(record, isCurrent, manifest) {
  const source = validateConsumedRecordShape(record);
  if (isCurrent) {
    if (source !== "CURRENT_EPOCH") fail(BLOCKERS.CONSUMED_PROVENANCE_INVALID);
    if (record.provenance.epochId !== manifest.epochId) fail(BLOCKERS.CONSUMED_EPOCH_MISMATCH);
    if (record.provenance.ownerProposalDigest !== manifest.ownerBinding.proposalDigest) {
      fail(BLOCKERS.CONSUMED_OWNER_MISMATCH);
    }
  } else if (source === "CURRENT_EPOCH") {
    /* CURRENT_EPOCH provenance cannot masquerade as inherited history */
    fail(BLOCKERS.CONSUMED_PROVENANCE_INVALID);
  } else if (source === "PREDECESSOR_EPOCH") {
    const pairKey = `${record.provenance.epochId}|${record.provenance.lineageDigest}`;
    const matched = manifest.predecessor.ancestry.some((entry) => (
      `${entry.epochId}|${entry.lineageDigest}` === pairKey));
    if (!matched) fail(BLOCKERS.LINEAGE_PROVENANCE_MISMATCH);
  } else if (record.provenance.lineageDigest !== manifest.legacy.archiveDigest) {
    fail(BLOCKERS.LINEAGE_PROVENANCE_MISMATCH);
  }
  return record.semanticEventId;
}

/* ------------------------------ public functions ----------------------------- */
function parseEpochManifest(manifestText) {
  return guard(() => parseManifestObject(boundedParse(manifestText, DESIGN_LIMITS.manifestBytes)));
}
function parseSourceEvent(eventText) {
  return guard(() => {
    const parsed = parseEventObject(boundedParse(eventText, DESIGN_LIMITS.eventBytes));
    return Object.freeze({ event: parsed.event, semanticEventId: parsed.semanticEventId });
  });
}
function admitEvent(input) {
  return guard(() => {
    /* C1: enforce the exact own-key set via property descriptors BEFORE reading any
     * option value: only enumerable own data properties are accepted; accessors,
     * setters, symbol keys and nonenumerable extras fail PARAM_FIELD_INVALID without
     * executing any getter. This is ordinary accessor rejection, not a sandbox
     * claim against hostile Proxy/host code. */
    assertPlainObject(input, BLOCKERS.PARAM_FIELD_INVALID);
    const OPTIONS_WANT = ["manifest", "event", "consumed", "inherited", "expectedSourceDigest", "nowMs"];
    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.length !== OPTIONS_WANT.length) fail(BLOCKERS.PARAM_FIELD_INVALID);
    for (const key of ownKeys) {
      if (typeof key === "symbol") fail(BLOCKERS.PARAM_FIELD_INVALID);
      if (!OPTIONS_WANT.includes(key)) fail(BLOCKERS.PARAM_FIELD_INVALID);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || descriptor.enumerable !== true) fail(BLOCKERS.PARAM_FIELD_INVALID);
      if (typeof descriptor.get === "function" || typeof descriptor.set === "function") {
        fail(BLOCKERS.PARAM_FIELD_INVALID);
      }
    }
    if (typeof input.nowMs !== "number" || !Number.isSafeInteger(input.nowMs)) fail(BLOCKERS.CLOCK_INVALID);
    const handle = requireValidatedManifestHandle(input.manifest);
    if (typeof input.event !== "string") fail(BLOCKERS.PARAM_FIELD_INVALID);
    /* consumed/inherited must be explicit serialized arrays; no null/undefined reset */
    if (typeof input.consumed !== "string") fail(BLOCKERS.PARAM_FIELD_INVALID);
    if (typeof input.inherited !== "string") fail(BLOCKERS.PARAM_FIELD_INVALID);
    const expectedSourceDigest = assertHash32(input.expectedSourceDigest);
    return runAdmission(handle.manifest, input.event, input.consumed, input.inherited,
      expectedSourceDigest, input.nowMs);
  });
}

function runAdmission(manifest, eventText, consumedText, inheritedText, expectedSourceDigest, nowMs) {
  const bounds = manifest.bounds;
  const notBeforeMs = parseUtcMs(manifest.notBefore);
  const expiresAtMs = parseUtcMs(manifest.expiresAt);
  /* stage 2 — lifecycle window + remaining work+cleanup budget */
  if (nowMs < notBeforeMs) fail(BLOCKERS.NOT_YET_ACTIVE);
  if (nowMs >= expiresAtMs) fail(BLOCKERS.EPOCH_EXPIRED);
  if (expiresAtMs - nowMs < bounds.forkBudgetMs + bounds.cleanupBudgetMs) fail(BLOCKERS.BUDGET_INSUFFICIENT);
  /* stage 3 — bounded event parse + mandatory identity recompute */
  const parsedEvent = parseEventObject(boundedParse(eventText, DESIGN_LIMITS.eventBytes));
  const event = parsedEvent.event;
  const semanticEventId = parsedEvent.semanticEventId;
  /* stage 4 — admission-context bindings */
  if (event.epochId !== manifest.epochId) fail(BLOCKERS.EPOCH_MISMATCH);
  if (event.ownerProposalDigest !== manifest.ownerBinding.proposalDigest) fail(BLOCKERS.OWNER_MISMATCH);
  if (event.adapterId !== manifest.scope.adapterId) fail(BLOCKERS.ADAPTER_MISMATCH);
  if (event.adapterDigest !== manifest.scope.adapterDigest) fail(BLOCKERS.ADAPTER_DIGEST_MISMATCH);
  if (event.scenarioId !== manifest.scope.scenarioId) fail(BLOCKERS.SCENARIO_MISMATCH);
  if (event.scenarioDigest !== manifest.scope.scenarioDigest) fail(BLOCKERS.SCENARIO_DIGEST_MISMATCH);
  if (!manifest.scope.producerAllowlist.includes(event.producerId)) fail(BLOCKERS.PRODUCER_NOT_ALLOWLISTED);
  if (!manifest.scope.firedStatusAllowlist.includes(event.firedStatus)) fail(BLOCKERS.STATUS_NOT_ALLOWLISTED);
  if (event.source.digest !== expectedSourceDigest) fail(BLOCKERS.SOURCE_DIGEST_MISMATCH);
  if (event.primary.chainId !== manifest.scope.primaryChainId) fail(BLOCKERS.CHAIN_SCOPE_MISMATCH);
  /* stage 5 — per-chain qualification staleness */
  const chainRecords = new Map();
  for (const key of Object.keys(manifest.chains)) {
    const chain = manifest.chains[key];
    const chainId = Number(key);
    const qualifiedAtMs = parseUtcMs(chain.qualifiedAt);
    if (nowMs - qualifiedAtMs > bounds.floorQualificationMaxAgeMs) fail(BLOCKERS.QUALIFICATION_STALE);
    if (qualifiedAtMs - nowMs > bounds.futureSkewMs) fail(BLOCKERS.QUALIFICATION_FUTURE_SKEW);
    chainRecords.set(chainId, {
      floorBlockNumber: chain.floorBlockNumber,
      floorBlockHash: chain.floorBlockHash,
      floorHeaderTimeMs: parseUtcMs(chain.floorHeaderTime)
    });
  }
  /* stage 6 — companion-set exact coverage, floors, pin/header guards */
  const wantedCompanions = new Set(manifest.scope.companionChainIds);
  const seenCompanionChains = new Set();
  for (const pin of event.companions) {
    if (!wantedCompanions.has(pin.chainId)) fail(BLOCKERS.COMPANION_CHAIN_UNEXPECTED);
    if (seenCompanionChains.has(pin.chainId)) fail(BLOCKERS.CHAIN_SCOPE_MISMATCH);
    seenCompanionChains.add(pin.chainId);
  }
  for (const chainId of wantedCompanions) {
    if (!seenCompanionChains.has(chainId)) fail(BLOCKERS.COMPANION_CHAIN_MISSING);
  }
  for (const pin of [event.primary].concat(event.companions)) {
    const chainRecord = chainRecords.get(pin.chainId);
    if (!chainRecord) fail(BLOCKERS.FIELD_MISSING);
    const order = compareDecimals(pin.blockNumber, chainRecord.floorBlockNumber);
    if (order === 0) fail(BLOCKERS.FLOOR_INEQUALITY);
    if (order < 0) fail(BLOCKERS.PIN_BELOW_FLOOR);
    if (pin.blockHash === chainRecord.floorBlockHash) {
      fail(BLOCKERS.PIN_CONFLICT); /* a floor component reappearing at another height */
    }
    if (pin.headerTimeMs <= chainRecord.floorHeaderTimeMs) fail(BLOCKERS.PIN_HEADER_INCONSISTENT);
    if (nowMs - pin.headerTimeMs > bounds.observationMaxAgeMs) fail(BLOCKERS.HEADER_STALE);
    if (pin.headerTimeMs - nowMs > bounds.futureSkewMs) fail(BLOCKERS.HEADER_FUTURE_SKEW);
  }
  /* stage 6b — original-transition consistency */
  if (event.target.kind === IDENTITY_KIND_TRANSITION) {
    const transition = event.target.transition;
    const chainRecord = chainRecords.get(event.target.chainId);
    if (!chainRecord) fail(BLOCKERS.FIELD_MISSING);
    const floorOrder = compareDecimals(transition.blockNumber, chainRecord.floorBlockNumber);
    if (floorOrder === 0) fail(BLOCKERS.FLOOR_INEQUALITY);
    if (floorOrder < 0) fail(BLOCKERS.PIN_BELOW_FLOOR);
    if (transition.blockHash === chainRecord.floorBlockHash) fail(BLOCKERS.PIN_CONFLICT);
    const observeOrder = compareDecimals(transition.blockNumber, event.primary.blockNumber);
    if (observeOrder > 0) fail(BLOCKERS.TRANSITION_ABOVE_OBSERVATION);
    if (observeOrder === 0) {
      /* equal height binds BOTH the block hash and the observed header timestamp */
      if (transition.blockHash !== event.primary.blockHash) fail(BLOCKERS.TRANSITION_PIN_MISMATCH);
      if (transition.headerTimeMs !== event.primary.headerTimeMs) fail(BLOCKERS.TRANSITION_PIN_MISMATCH);
    } else if (transition.blockHash === event.primary.blockHash) {
      /* the observed block hash may not be reused at another height */
      fail(BLOCKERS.TRANSITION_PIN_MISMATCH);
    }
    const transitionHeaderMs = transition.headerTimeMs;
    if (transitionHeaderMs <= chainRecord.floorHeaderTimeMs) fail(BLOCKERS.PIN_HEADER_INCONSISTENT);
    if (transitionHeaderMs > event.primary.headerTimeMs) fail(BLOCKERS.PIN_HEADER_INCONSISTENT);
    /* the original transition header is evidence: same max-age gate as other evidence */
    if (nowMs - transitionHeaderMs > bounds.observationMaxAgeMs) fail(BLOCKERS.TRANSITION_STALE);
    if (transitionHeaderMs < notBeforeMs) fail(BLOCKERS.TRANSITION_BEFORE_CUTOFF);
    if (transitionHeaderMs - nowMs > bounds.futureSkewMs) fail(BLOCKERS.TRANSITION_FUTURE_SKEW);
  }
  /* stage 7 — consumed sets, bindings, digest/count/identity-version/capacity */
  const seenSemantics = new Set();
  const inheritedParsed = parseInheritedSet(inheritedText, manifest);
  for (const record of inheritedParsed) {
    const id = parseConsumedRecordAgainstManifest(record, false, manifest);
    if (seenSemantics.has(id)) fail(BLOCKERS.DUPLICATE_CONSUMED);
    seenSemantics.add(id);
  }
  const inheritedDigest = consumedSetDigestOfParsedRecords(inheritedParsed);
  if (inheritedDigest !== manifest.predecessor.inheritedConsumedDigest) {
    fail(BLOCKERS.INHERITED_DIGEST_MISMATCH);
  }
  const currentParsed = boundedParse(consumedText, DESIGN_LIMITS.consumedSetBytes);
  if (!Array.isArray(currentParsed)) fail(BLOCKERS.FIELD_TYPE);
  for (const record of currentParsed) {
    const id = parseConsumedRecordAgainstManifest(record, true, manifest);
    if (seenSemantics.has(id)) fail(BLOCKERS.DUPLICATE_CONSUMED);
    seenSemantics.add(id);
  }
  const combined = inheritedParsed.length + currentParsed.length;
  if (combined > bounds.maxConsumedIdentities) fail(BLOCKERS.DENY_SET_OVERFLOW);
  /* stage 8 — replay */
  if (seenSemantics.has(semanticEventId)) fail(BLOCKERS.REPLAY_CONSUMED);
  /* stage 9 — saturation without eviction */
  if (combined >= bounds.maxConsumedIdentities) fail(BLOCKERS.DENY_SET_SATURATED);
  /* stage 10 — freshness/future-skew/opening cutoffs, each time independently */
  checkFreshTime(event.source.observedAtMs, nowMs, notBeforeMs, bounds.sourceMaxAgeMs,
    bounds.futureSkewMs, BLOCKERS.SOURCE_STALE, BLOCKERS.SOURCE_FUTURE_SKEW,
    BLOCKERS.SOURCE_BEFORE_CUTOFF);
  checkFreshTime(event.producer.generatedAtMs, nowMs, notBeforeMs, bounds.observationMaxAgeMs,
    bounds.futureSkewMs, BLOCKERS.PRODUCER_STALE, BLOCKERS.PRODUCER_FUTURE_SKEW,
    BLOCKERS.PRODUCER_BEFORE_CUTOFF);
  checkFreshTime(event.observation.atMs, nowMs, notBeforeMs, bounds.observationMaxAgeMs,
    bounds.futureSkewMs, BLOCKERS.OBSERVATION_STALE, BLOCKERS.OBSERVATION_FUTURE_SKEW,
    BLOCKERS.OBSERVATION_BEFORE_CUTOFF);
  if (event.target.kind === IDENTITY_KIND_QUOTE) {
    checkFreshTime(event.target.candidate.economicsObservedAtMs, nowMs, notBeforeMs,
      bounds.observationMaxAgeMs, bounds.futureSkewMs, BLOCKERS.ECONOMICS_STALE,
      BLOCKERS.ECONOMICS_FUTURE_SKEW, BLOCKERS.ECONOMICS_BEFORE_CUTOFF);
  }
  /* stage 11 — known-gap coverage: STRICT after-gap rule. Source, producer,
   * observation and pin-quote economics times, every observed pin header time and,
   * for transition events, the original-transition header time must lie strictly
   * inside each declared cutoff's covered region; equality overlaps the gap.
   * Cutoff milliseconds are re-derived here from the serialized-schema gap records. */
  for (const gap of manifest.predecessor.gaps) {
    const gapCutoffMs = parseUtcMs(gap.cutoff);
    if (event.source.observedAtMs <= gapCutoffMs
        || event.producer.generatedAtMs <= gapCutoffMs
        || event.observation.atMs <= gapCutoffMs) {
      fail(BLOCKERS.GAP_OVERLAP);
    }
    if (event.target.kind === IDENTITY_KIND_QUOTE
        && event.target.candidate.economicsObservedAtMs <= gapCutoffMs) {
      fail(BLOCKERS.GAP_OVERLAP);
    }
    for (const pin of [event.primary].concat(event.companions)) {
      if (pin.headerTimeMs <= gapCutoffMs) fail(BLOCKERS.GAP_OVERLAP);
    }
    if (event.target.kind === IDENTITY_KIND_TRANSITION
        && event.target.transition.headerTimeMs <= gapCutoffMs) {
      fail(BLOCKERS.GAP_OVERLAP);
    }
  }
  return okResult(semanticEventId);
}
function checkFreshTime(timeMs, nowMs, notBeforeMs, maxAgeMs, maxSkewMs, staleCode, skewCode, cutoffCode) {
  if (nowMs - timeMs > maxAgeMs) fail(staleCode);
  if (timeMs - nowMs > maxSkewMs) fail(skewCode);
  if (timeMs < notBeforeMs) fail(cutoffCode);
}

function parseInheritedSet(inheritedText, manifest) {
  const expectedCount = manifest.predecessor.inheritedConsumedCount;
  if (inheritedText === "[]") {
    if (expectedCount > 0) fail(BLOCKERS.INHERITED_SET_MISSING);
    return [];
  }
  const inheritedParsed = boundedParse(inheritedText, DESIGN_LIMITS.consumedSetBytes);
  if (!Array.isArray(inheritedParsed)) fail(BLOCKERS.FIELD_TYPE);
  if (inheritedParsed.length !== expectedCount) {
    if (expectedCount > 0 && inheritedParsed.length === 0) fail(BLOCKERS.INHERITED_SET_MISSING);
    fail(BLOCKERS.INHERITED_COUNT_MISMATCH);
  }
  return inheritedParsed;
}

/* --------------------------------- exports ---------------------------------- */
module.exports = Object.freeze({
  DESIGN_LIMITS,
  BLOCKERS,
  ADAPTER_REGISTRY,
  MANIFEST_SCHEMA,
  EVENT_SCHEMA,
  CONSUMED_SCHEMA,
  IDENTITY_SCHEMA,
  IDENTITY_SCHEMA_VERSION,
  POLICY_VERSION,
  OWNER_POLICY_VERSION,
  INDEPENDENCE_POLICY_VERSION,
  LEGACY_DISPOSITION,
  UNKNOWN_GAP_POLICY,
  LEGACY_RATIONALE_CODES,
  LEGACY_SEARCH_POLICY_CODES,
  consumedSetDigest,
  parseEpochManifest,
  parseSourceEvent,
  admitEvent
});
