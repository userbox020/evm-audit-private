#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sentinelModule = require("./run-official-deployed-delta-sentinel.js");
const feederModule = require("./build-fresh-deployed-delta-candidate-feed-v1.js");
const acquisitionModule = require("./build-fresh-deployed-delta-acquisition-v1.js");

const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);
const iso = (offset) => new Date(NOW + offset).toISOString();
const sha40 = (number) => number.toString(16).padStart(40, "0");
const sha64 = (number) => number.toString(16).padStart(64, "0");
const reference = (id = "authority-1", number = 900) => ({ kind: "attestation", id, sha256: sha64(number) });

function deepAssign(target, source) {
  const copy = structuredClone(target);
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)
        && copy[key] && typeof copy[key] === "object" && !Array.isArray(copy[key])) {
      copy[key] = deepAssign(copy[key], value);
    } else copy[key] = structuredClone(value);
  }
  return copy;
}

function sentinel(overrides = {}) {
  const generatedAt = overrides.generatedAt || iso(-60_000);
  const status = overrides.status || "candidate-change";
  const firstPollStatus = overrides.firstPollStatus
    || (["incomplete", "rate-limited"].includes(status) ? status : "candidate-change");
  const firstPaths = overrides.firstPaths || ["config/markets.json", "contracts/proxy/Proxy.sol"];
  const repositories = sentinelModule.REPOSITORIES.map((repository, index) => ({
    id: repository.id,
    officialUrl: repository.officialUrl,
    defaultBranch: "main",
    sourceClass: repository.sourceClass,
    observedHeadSha: sha40(index + 101),
    previousHeadSha: sha40(index + 1),
    releaseIds: [],
    tags: [],
    configuredManifestPaths: [...sentinelModule.MANIFEST_PREFIXES],
    changedManifestPaths: index === 0 ? [...firstPaths] : [],
    changeHints: index === 0 ? ["implementation"] : [],
    chainTextHints: [],
    evidenceUrls: [],
    etagByUrl: {},
    pollStatus: index === 0 ? firstPollStatus : (["incomplete", "rate-limited"].includes(status) ? status : "unchanged"),
    observedAt: generatedAt
  }));
  if (overrides.repositoryMutator) overrides.repositoryMutator(repositories);
  return {
    schema: sentinelModule.SCHEMA,
    generatedAt,
    runId: overrides.runId || "sentinel-run-1",
    status,
    baselineCreated: false,
    repositories
  };
}

function eventObservation(overrides = {}) {
  return deepAssign({
    schema: acquisitionModule.EVENT_SCHEMA,
    observationId: "observation-1",
    observedAt: iso(-30_000),
    expiresAt: iso(60 * 60 * 1000),
    chainId: "1",
    eventClass: "proxy-upgrade",
    targetCommitment: sha64(501),
    eventCommitment: sha64(502),
    finality: {
      finalized: "true",
      commonPinCommitment: sha64(503),
      terminalRecheck: "true",
      references: [reference("finality-1", 1)]
    },
    familyEvidence: {
      twoFamilyAgreement: "true",
      independentFamilies: "true",
      observedFamilyCount: 2,
      agreementCommitment: sha64(504),
      references: [reference("agreement-1", 2)]
    },
    references: [reference("event-1", 3)]
  }, overrides);
}

function registryEntry(overrides = {}) {
  return deepAssign({
    registryEntryId: "registry-entry-1",
    registryEntryCommitment: sha64(601),
    chainId: "1",
    targetCommitment: sha64(501),
    protocol: "protocol-a",
    repositoryId: sentinelModule.REPOSITORIES[0].id,
    authority: "true",
    sourcePathPrefixes: ["contracts/proxy/"],
    supportedEventClasses: ["proxy-upgrade"],
    references: [reference("registry-1", 4)]
  }, overrides);
}

function targetRegistry(overrides = {}) {
  return deepAssign({
    schema: acquisitionModule.REGISTRY_SCHEMA,
    registryId: "target-registry-1",
    generatedAt: iso(-60_000),
    expiresAt: iso(2 * 60 * 60 * 1000),
    entries: [registryEntry()]
  }, overrides);
}

function suppression(overrides = {}) {
  return deepAssign({
    schema: acquisitionModule.SUPPRESSION_SCHEMA,
    indexId: "suppression-index-1",
    generatedAt: iso(-60_000),
    expiresAt: iso(2 * 60 * 60 * 1000),
    entries: []
  }, overrides);
}

function build(events = [eventObservation()], sent = sentinel(), registry = targetRegistry(), index = suppression(), now = NOW) {
  return acquisitionModule.buildAcquisition({
    sentinel: sent, eventObservations: events, targetRegistry: registry, suppression: index, now
  });
}
function candidateMaterial(observation = eventObservation(), entry = registryEntry(), sent = sentinel()) {
  const repository = sent.repositories.find((item) => item.id === entry.repositoryId) || null;
  return {
    repositoryId: entry ? entry.repositoryId : null,
    previousHeadSha: repository ? repository.previousHeadSha : null,
    observedHeadSha: repository ? repository.observedHeadSha : null,
    chainId: observation.chainId,
    targetCommitment: observation.targetCommitment,
    eventClass: observation.eventClass,
    eventCommitment: observation.eventCommitment,
    registryEntryCommitment: entry ? entry.registryEntryCommitment : null
  };
}
function throwsCode(fn, code) {
  assert.throws(fn, (error) => error && error.name === "AcquisitionError" && error.code === code && error.message === code);
}
async function tempDirectory(t, suffix = "") {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), `fresh-delta-acquisition-${suffix}`));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("1 exports exact schemas and strict top-level validators", () => {
  assert.equal(acquisitionModule.EVENT_SCHEMA, "fresh-deployed-delta-acquisition/change-event-observation/v1");
  assert.equal(acquisitionModule.REGISTRY_SCHEMA, "fresh-deployed-delta-acquisition/target-registry/v1");
  assert.equal(acquisitionModule.SUPPRESSION_SCHEMA, "fresh-deployed-delta-acquisition/suppression-index/v1");
  assert.equal(acquisitionModule.ACQUISITION_SCHEMA, "fresh-deployed-delta-acquisition/v1");
  const acquisition = build();
  assert.equal(acquisitionModule.validateAcquisition(acquisition), true);
  acquisition.extra = "rejected";
  assert.equal(acquisitionModule.validateAcquisition(acquisition), false);
});

test("2 event exact keys and lowercase string tri-states are enforced", () => {
  assert.equal(acquisitionModule.validateEventObservation(eventObservation()), true);
  for (const value of [true, false, 1, null, "TRUE"]) {
    assert.equal(acquisitionModule.validateEventObservation(eventObservation({ finality: { finalized: value } })), false);
  }
  const extra = eventObservation();
  extra.familyEvidence.derived = "true";
  assert.equal(acquisitionModule.validateEventObservation(extra), false);
});

test("3 event enum order and suggestion mapping are exact, including lossy new-vault", () => {
  assert.deepEqual(acquisitionModule.EVENT_CLASSES, [
    "proxy-upgrade", "beacon-upgrade", "diamond-cut", "new-market", "new-vault",
    "oracle-replacement", "module-replacement", "unpause", "config", "queue-epoch"
  ]);
  assert.deepEqual(Object.values(acquisitionModule.EVENT_TO_DELTA_CLASS), [
    "implementation", "implementation", "implementation", "new-market", "new-market",
    "oracle", "module", "unpause", "config", "queue"
  ]);
  assert.equal(acquisitionModule.validateEventObservation(eventObservation({ eventClass: "upgrade" })), false);
  const newVault = build(
    [eventObservation({ eventClass: "new-vault" })],
    sentinel(),
    targetRegistry({ entries: [registryEntry({ supportedEventClasses: ["new-vault"] })] })
  ).candidates[0];
  assert.equal(newVault.suggestedDeltaClass, "new-market");
  assert.equal(feederModule.validateEvidenceRow(newVault), false);
});

test("4 finalized true requires common pin commitment and references", () => {
  assert.equal(acquisitionModule.validateEventObservation(eventObservation({ finality: { commonPinCommitment: null } })), false);
  assert.equal(acquisitionModule.validateEventObservation(eventObservation({ finality: { references: [] } })), false);
  assert.equal(acquisitionModule.validateEventObservation(eventObservation({
    finality: { finalized: "unknown", terminalRecheck: "unknown", commonPinCommitment: null, references: [] }
  })), true);
});

test("5 terminal recheck true requires finalized true and references", () => {
  assert.equal(acquisitionModule.validateEventObservation(eventObservation({ finality: { finalized: "false" } })), false);
  assert.equal(acquisitionModule.validateEventObservation(eventObservation({
    finality: { finalized: "false", terminalRecheck: "false", commonPinCommitment: null, references: [] }
  })), true);
});

test("6 two-family agreement true requires count, commitment, and references", () => {
  for (const patch of [
    { observedFamilyCount: 1 }, { agreementCommitment: null }, { references: [] }
  ]) assert.equal(acquisitionModule.validateEventObservation(eventObservation({ familyEvidence: patch })), false);
  assert.equal(acquisitionModule.validateEventObservation(eventObservation({ familyEvidence: { observedFamilyCount: 16 } })), true);
  assert.equal(acquisitionModule.validateEventObservation(eventObservation({ familyEvidence: { observedFamilyCount: 17 } })), false);
});

test("7 independence is accepted only as injected tri-state and family labels are rejected", () => {
  const unknown = build([eventObservation({ familyEvidence: { independentFamilies: "unknown" } })]);
  assert.equal(unknown.blocked[0].authority.independentFamilies, "unknown");
  const labeled = eventObservation();
  labeled.familyEvidence.familyLabels = ["one", "two"];
  assert.equal(acquisitionModule.validateEventObservation(labeled), false);
});

test("8 registry exact keys and unique chain-target pairs are enforced", () => {
  assert.equal(acquisitionModule.validateTargetRegistry(targetRegistry()), true);
  const duplicate = registryEntry({ registryEntryId: "registry-entry-2", registryEntryCommitment: sha64(602) });
  assert.equal(acquisitionModule.validateTargetRegistry(targetRegistry({ entries: [registryEntry(), duplicate] })), false);
  const extra = targetRegistry();
  extra.entries[0].targetAddress = "hidden";
  assert.equal(acquisitionModule.validateTargetRegistry(extra), false);
});

test("9 source prefixes and supported classes are sorted and unique", () => {
  const valid = registryEntry({
    sourcePathPrefixes: ["config/markets.json", "contracts/proxy/"],
    supportedEventClasses: ["proxy-upgrade", "new-market"]
  });
  assert.equal(acquisitionModule.validateTargetRegistry(targetRegistry({ entries: [valid] })), true);
  assert.equal(acquisitionModule.validateTargetRegistry(targetRegistry({ entries: [registryEntry({
    sourcePathPrefixes: ["contracts/proxy/", "config/markets.json"]
  })] })), false);
  assert.equal(acquisitionModule.validateTargetRegistry(targetRegistry({ entries: [registryEntry({
    supportedEventClasses: ["new-market", "proxy-upgrade"]
  })] })), false);
});

test("10 exact-file source prefix correlation is eligible", () => {
  const registry = targetRegistry({ entries: [registryEntry({ sourcePathPrefixes: ["contracts/proxy/Proxy.sol"] })] });
  const acquisition = build([eventObservation()], sentinel(), registry);
  assert.equal(acquisition.candidates[0].authority.sourcePathCorrelated, "true");
  assert.deepEqual(acquisition.candidates[0].sourceDelta.changedPaths, ["contracts/proxy/Proxy.sol"]);
});

test("11 directory source prefix correlation is boundary-safe and eligible", () => {
  const acquisition = build();
  assert.equal(acquisition.candidates.length, 1);
  assert.equal(acquisition.candidates[0].authority.sourcePathCorrelated, "true");
});

test("12 lookalike prefixes do not correlate", () => {
  const registry = targetRegistry({ entries: [registryEntry({ sourcePathPrefixes: ["contracts/prox/"] })] });
  const acquisition = build([eventObservation()], sentinel(), registry);
  assert.equal(acquisition.candidates.length, 0);
  assert.equal(acquisition.blocked[0].authority.sourcePathCorrelated, "false");
});

test("13 missing registry target is deterministic unknown blocked identity", () => {
  const acquisition = build([eventObservation()], sentinel(), targetRegistry({ entries: [] }));
  const row = acquisition.blocked[0];
  assert.equal(row.authority.targetRegistryBound, "unknown");
  assert.deepEqual(row.identity, { protocol: null, chainId: "1", targetCommitment: sha64(501), repositoryId: null });
  assert.deepEqual(row.sourceDelta, { previousHeadSha: null, observedHeadSha: null, changedPaths: [] });
  assert.equal(acquisition.status, "empty");
});

test("14 unknown registry authority remains unknown and never becomes eligible", () => {
  const registry = targetRegistry({ entries: [registryEntry({ authority: "unknown" })] });
  const acquisition = build([eventObservation()], sentinel(), registry);
  assert.equal(acquisition.blocked[0].authority.targetRegistryBound, "unknown");
  assert.equal(acquisition.blocked[0].acquisitionEligible, "unknown");
});

test("15 false registry authority or unsupported class is explicitly blocked", () => {
  const falseRegistry = targetRegistry({ entries: [registryEntry({ authority: "false" })] });
  assert.equal(build([eventObservation()], sentinel(), falseRegistry).blocked[0].authority.targetRegistryBound, "false");
  const unsupported = targetRegistry({ entries: [registryEntry({ supportedEventClasses: ["config"] })] });
  assert.equal(build([eventObservation()], sentinel(), unsupported).blocked[0].authority.targetRegistryBound, "false");
});

test("16 registry repository absent from sentinel is false blocked with unavailable source", () => {
  const registry = targetRegistry({ entries: [registryEntry({ repositoryId: "missing/repository" })] });
  const row = build([eventObservation()], sentinel(), registry).blocked[0];
  assert.equal(row.authority.sentinelBound, "false");
  assert.deepEqual(row.sourceDelta, { previousHeadSha: null, observedHeadSha: null, changedPaths: [] });
});

test("17 non-candidate repository poll status is false blocked", () => {
  const sent = sentinel({ firstPollStatus: "unchanged" });
  const row = build([eventObservation()], sent).blocked[0];
  assert.equal(row.authority.sentinelBound, "false");
  assert.equal(row.acquisitionEligible, "false");
});

test("18 incomplete and rate-limited sentinel authority yields no candidates and incomplete status", () => {
  for (const status of ["incomplete", "rate-limited"]) {
    const sent = sentinel({ status });
    const acquisition = build([eventObservation()], sent);
    assert.equal(acquisition.status, "incomplete");
    assert.equal(acquisition.candidates.length, 0);
    assert.equal(acquisition.blocked[0].authority.sentinelBound, "unknown");
  }
});

test("19 fully correlated finalized two-family observation creates one ready candidate", () => {
  const acquisition = build();
  assert.equal(acquisition.status, "ready");
  assert.equal(acquisition.counts.candidates, 1);
  assert.equal(acquisition.candidates[0].acquisitionEligible, "true");
  assert.deepEqual(acquisition.candidates[0].blockers, []);
});

test("20 insufficient family count and injected non-independence cannot qualify", () => {
  const insufficient = eventObservation({
    familyEvidence: {
      twoFamilyAgreement: "false", independentFamilies: "unknown", observedFamilyCount: 1,
      agreementCommitment: null, references: []
    }
  });
  const first = build([insufficient]).blocked[0];
  assert.equal(first.authority.twoFamilyAgreement, "false");
  const dependent = build([eventObservation({ familyEvidence: { independentFamilies: "false" } })]).blocked[0];
  assert.equal(dependent.authority.independentFamilies, "false");
});

test("21 event freshness uses exact expiry boundaries", () => {
  const expired = eventObservation({ observedAt: iso(-60_000), expiresAt: iso(0) });
  const acquisition = build([expired]);
  assert.equal(acquisition.blocked[0].authority.fresh, "false");
  assert.equal(acquisition.expiresAt, iso(0));
  assert.equal(acquisition.status, "incomplete");
});

test("22 sentinel, registry, and suppression expiry are controlling and minimum", () => {
  const sent = sentinel({ generatedAt: iso(-7 * 60 * 60 * 1000) });
  const registry = targetRegistry({ expiresAt: iso(45 * 60 * 1000) });
  const index = suppression({ expiresAt: iso(30 * 60 * 1000) });
  const acquisition = build([eventObservation()], sent, registry, index);
  assert.equal(acquisition.expiresAt, iso(30 * 60 * 1000));
  const staleRegistry = targetRegistry({ generatedAt: iso(-60_000), expiresAt: iso(0) });
  assert.equal(build([eventObservation()], sentinel(), staleRegistry).candidates.length, 0);
});

test("23 future timestamps use the fixed five-minute skew rule", () => {
  const within = eventObservation({ observedAt: iso(acquisitionModule.MAX_FUTURE_SKEW_MS), expiresAt: iso(60 * 60 * 1000) });
  assert.equal(build([within]).blocked[0].authority.fresh, "unknown");
  const beyond = eventObservation({ observedAt: iso(acquisitionModule.MAX_FUTURE_SKEW_MS + 1), expiresAt: iso(60 * 60 * 1000) });
  throwsCode(() => build([beyond]), "FUTURE_TIME");
});

test("24 exact active unexpired suppression moves an otherwise eligible row", () => {
  const observation = eventObservation();
  const id = acquisitionModule.acquisitionCandidateId(candidateMaterial(observation));
  const entry = {
    suppressionId: "suppression-1", acquisitionCandidateId: id, kind: "duplicate", active: "true",
    expiresAt: iso(30 * 60 * 1000), references: [reference("suppression-1", 88)]
  };
  const acquisition = build([observation], sentinel(), targetRegistry(), suppression({ entries: [entry] }));
  assert.equal(acquisition.suppressed.length, 1);
  assert.equal(acquisition.candidates.length, 0);
  assert.equal(acquisition.suppressed[0].acquisitionEligible, "true");
});

test("25 expired, inactive, and fuzzy suppressions never suppress", () => {
  const observation = eventObservation();
  const exactId = acquisitionModule.acquisitionCandidateId(candidateMaterial(observation));
  for (const entry of [
    { suppressionId: "expired", acquisitionCandidateId: exactId, kind: "duplicate", active: "true", expiresAt: iso(0), references: [] },
    { suppressionId: "inactive", acquisitionCandidateId: exactId, kind: "duplicate", active: "false", expiresAt: iso(60_000), references: [] },
    { suppressionId: "fuzzy", acquisitionCandidateId: sha64(9999), kind: "closed-class", active: "true", expiresAt: iso(60_000), references: [] }
  ]) assert.equal(build([observation], sentinel(), targetRegistry(), suppression({ entries: [entry] })).candidates.length, 1);
});

test("26 duplicate suppression acquisitionCandidateIds are rejected independent of order", () => {
  const id = acquisitionModule.acquisitionCandidateId(candidateMaterial());
  const entries = [
    { suppressionId: "one", acquisitionCandidateId: id, kind: "duplicate", active: "true", expiresAt: iso(60_000), references: [reference("one", 1)] },
    { suppressionId: "two", acquisitionCandidateId: id, kind: "closed-class", active: "unknown", expiresAt: iso(120_000), references: [reference("two", 2)] }
  ];
  for (const ordered of [entries, [...entries].reverse()]) {
    const index = suppression({ entries: ordered });
    assert.equal(acquisitionModule.validateSuppression(index), false);
    throwsCode(() => build([eventObservation()], sentinel(), targetRegistry(), index), "INVALID_SUPPRESSION");
  }
});

test("27 acquisition output contains no novelty, route, feeder authority, or economics", () => {
  const output = structuredClone(build());
  delete output.safety;
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(serialized, /novelty|routePositive|liquidExit|sourceExact|deploymentCurrent|runtimeBound|profit|pnl|usd|gas/i);
});

test("28 input permutations preserve commitments, rows, and acquisitionId", () => {
  const firstEvent = eventObservation();
  const secondEvent = eventObservation({ observationId: "observation-2", targetCommitment: sha64(511), eventCommitment: sha64(512) });
  const firstEntry = registryEntry();
  const secondEntry = registryEntry({
    registryEntryId: "registry-entry-2", registryEntryCommitment: sha64(611), targetCommitment: sha64(511)
  });
  const a = build([firstEvent, secondEvent], sentinel(), targetRegistry({ entries: [firstEntry, secondEntry] }));
  const b = build([secondEvent, firstEvent], sentinel(), targetRegistry({ entries: [secondEntry, firstEntry] }));
  assert.deepEqual(a, b);
});

test("29 duplicate observationIds are rejected", () => {
  const duplicate = eventObservation({ eventCommitment: sha64(777), targetCommitment: sha64(778) });
  throwsCode(() => build([eventObservation(), duplicate]), "DUPLICATE_OBSERVATION_ID");
});

test("30 duplicate material candidate IDs are rejected despite distinct observation metadata", () => {
  const duplicate = eventObservation({ observationId: "observation-2", observedAt: iso(-20_000), references: [reference("event-2", 33)] });
  throwsCode(() => build([eventObservation(), duplicate]), "DUPLICATE_MATERIAL_CANDIDATE_ID");
});

test("31 distinct target, head, event, and registry commitments remain distinct", () => {
  const baseEvent = eventObservation();
  const baseEntry = registryEntry();
  const baseSentinel = sentinel();
  const base = acquisitionModule.acquisitionCandidateId(candidateMaterial(baseEvent, baseEntry, baseSentinel));
  const variants = [];
  variants.push(acquisitionModule.acquisitionCandidateId(candidateMaterial(eventObservation({ targetCommitment: sha64(700) }), registryEntry({ targetCommitment: sha64(700) }), baseSentinel)));
  const changedHeadSentinel = sentinel({ repositoryMutator: (rows) => { rows[0].observedHeadSha = sha40(999); } });
  variants.push(acquisitionModule.acquisitionCandidateId(candidateMaterial(baseEvent, baseEntry, changedHeadSentinel)));
  variants.push(acquisitionModule.acquisitionCandidateId(candidateMaterial(eventObservation({ eventCommitment: sha64(701) }), baseEntry, baseSentinel)));
  variants.push(acquisitionModule.acquisitionCandidateId(candidateMaterial(baseEvent, registryEntry({ registryEntryCommitment: sha64(702) }), baseSentinel)));
  assert.equal(new Set([base, ...variants]).size, 5);
});

test("32 deterministic ordering is newest, enum order, then ID with list-local ordinals", () => {
  const events = [
    eventObservation({ observationId: "three", eventClass: "diamond-cut", eventCommitment: sha64(803), observedAt: iso(-10_000) }),
    eventObservation({ observationId: "one", eventClass: "proxy-upgrade", eventCommitment: sha64(801), observedAt: iso(-10_000) }),
    eventObservation({ observationId: "two", eventClass: "beacon-upgrade", eventCommitment: sha64(802), observedAt: iso(-5_000) })
  ];
  const registry = targetRegistry({ entries: [registryEntry({ supportedEventClasses: ["proxy-upgrade", "beacon-upgrade", "diamond-cut"] })] });
  const rows = build(events, sentinel(), registry).candidates;
  assert.deepEqual(rows.map((row) => row.eventClass), ["beacon-upgrade", "proxy-upgrade", "diamond-cut"]);
  assert.deepEqual(rows.map((row) => row.ordinal), [1, 2, 3]);
});

test("33 URLs, domains, endpoint/provider fields, and family labels are rejected", () => {
  assert.equal(acquisitionModule.validateEventObservation(eventObservation({ observationId: "https://bad.invalid" })), false);
  assert.equal(acquisitionModule.validateTargetRegistry(targetRegistry({ registryId: "bad.example.com" })), false);
  for (const key of ["endpoint", "provider", "familyLabels"]) {
    const observation = eventObservation();
    observation.familyEvidence[key] = "forbidden";
    assert.equal(acquisitionModule.validateEventObservation(observation), false);
  }
});

test("34 addresses, topics, selectors, calldata, and transaction hashes are rejected without rejecting commitments", () => {
  for (const value of [`0x${"a".repeat(40)}`, "0x12345678", `0x${"b".repeat(64)}`]) {
    assert.equal(acquisitionModule.validateEventObservation(eventObservation({ observationId: value })), false);
  }
  assert.equal(acquisitionModule.validateEventObservation(eventObservation()), true);
  assert.equal(sentinelModule.validateArtifact(sentinel()), true);
});

test("35 raw logs, RPC/header/error material, and source bodies or diffs are rejected", () => {
  for (const key of ["rawLog", "rpc", "header", "error", "sourceBody", "diff"]) {
    const observation = eventObservation();
    observation[key] = "forbidden";
    assert.equal(acquisitionModule.validateEventObservation(observation), false);
  }
});

test("36 actors, amounts, USD, gas, liquidity, PnL, execution, signing, and promotion fields are rejected", () => {
  for (const key of ["actor", "amount", "usd", "gas", "liquidity", "pnl", "profit", "threshold", "execution", "signing", "promotionJustification"]) {
    const registry = targetRegistry();
    registry.entries[0][key] = false;
    assert.equal(acquisitionModule.validateTargetRegistry(registry), false);
  }
});

test("37 output cannot validate as feeder evidence and every safety assertion is false", () => {
  const acquisition = build();
  assert.equal(feederModule.validateEvidenceRow(acquisition.candidates[0]), false);
  assert.deepEqual(Object.keys(acquisition.safety), [
    "networkAccess", "rpcAccess", "inventoryAccess", "sourceDiscovery", "forkUse", "feederInvocation",
    "rankerInvocation", "evaluatorInvocation", "pnlEvaluation", "signing", "transactions", "promotion", "automaticPromotion"
  ]);
  assert.equal(Object.values(acquisition.safety).every((value) => value === false), true);
});

test("38 publication is canonical no-replace and detects stage failure and readback tampering", async (t) => {
  const acquisition = build();
  const successDirectory = await tempDirectory(t, "success-");
  const filename = await acquisitionModule.publishNoReplace(acquisition, { outputDirectory: successDirectory, fsImpl: fs });
  assert.equal(filename, path.join(successDirectory, `${acquisition.acquisitionId}.json`));
  assert.deepEqual(await fs.promises.readFile(filename), acquisitionModule.canonicalBytes(acquisition));
  await assert.rejects(
    acquisitionModule.publishNoReplace(acquisition, { outputDirectory: successDirectory, fsImpl: fs }),
    (error) => error.code === "OUTPUT_EXISTS"
  );

  const failureDirectory = await tempDirectory(t, "failure-");
  const failedApi = Object.create(fs.promises);
  failedApi.link = async () => { const error = new Error("stage fixture"); error.code = "EIO"; throw error; };
  await assert.rejects(acquisitionModule.publishNoReplace(acquisition, { outputDirectory: failureDirectory, fsImpl: failedApi }));
  assert.deepEqual(await fs.promises.readdir(failureDirectory), []);

  const tamperDirectory = await tempDirectory(t, "tamper-");
  const tamperedApi = Object.create(fs.promises);
  tamperedApi.readFile = async (target) => Buffer.concat([await fs.promises.readFile(target), Buffer.from(" ")]);
  await assert.rejects(
    acquisitionModule.publishNoReplace(acquisition, { outputDirectory: tamperDirectory, fsImpl: tamperedApi }),
    (error) => error.code === "READBACK_MISMATCH"
  );
  assert.deepEqual(await fs.promises.readdir(tamperDirectory), [`${acquisition.acquisitionId}.json`]);
});

test("39 build and dry-run do not access transport, RPC, feeder, evaluator, fork, or signer hooks", async (t) => {
  let calls = 0;
  const directory = await tempDirectory(t, "hooks-");
  const options = {
    sentinel: sentinel(), eventObservations: [eventObservation()], targetRegistry: targetRegistry(),
    suppression: suppression(), now: NOW, outputDirectory: directory, fsImpl: fs
  };
  for (const key of ["transport", "rpc", "feeder", "evaluator", "fork", "signer"]) {
    Object.defineProperty(options, key, { enumerable: false, get() { calls += 1; throw new Error(`${key} invoked`); } });
  }
  const result = await acquisitionModule.runDry(options);
  assert.equal(acquisitionModule.validateAcquisition(result.acquisition), true);
  assert.equal(calls, 0);
  await assert.rejects(
    acquisitionModule.runDry({ ...options, outputDirectory: undefined }),
    (error) => error.code === "INVALID_OUTPUT_DIRECTORY"
  );
  assert.equal(calls, 0);
});

test("40 synthetic ready dry-run publishes one proxy candidate and second publication is OUTPUT_EXISTS", async (t) => {
  const directory = await tempDirectory(t, "dry-");
  const options = {
    sentinel: sentinel(), eventObservations: [eventObservation()], targetRegistry: targetRegistry(),
    suppression: suppression(), now: NOW, outputDirectory: directory, fsImpl: fs
  };
  const result = await acquisitionModule.runDry(options);
  assert.deepEqual(Object.keys(result).sort(), ["acquisition", "filename"]);
  assert.equal(result.acquisition.status, "ready");
  assert.equal(result.acquisition.candidates.length, 1);
  assert.equal(result.acquisition.candidates[0].eventClass, "proxy-upgrade");
  assert.equal(feederModule.validateEvidenceRow(result.acquisition.candidates[0]), false);
  assert.equal(result.filename, path.join(directory, `${result.acquisition.acquisitionId}.json`));
  assert.deepEqual(await fs.promises.readFile(result.filename), acquisitionModule.canonicalBytes(result.acquisition));
  await assert.rejects(acquisitionModule.runDry(options), (error) => error.code === "OUTPUT_EXISTS");
});

test("41 reference kinds and IDs reject provider and family labels across nested authorities", () => {
  const topKind = eventObservation();
  topKind.references = [{ kind: "provider", id: "evidence-a", sha256: sha64(901) }];
  assert.equal(acquisitionModule.validateEventObservation(topKind), false);

  const topId = eventObservation();
  topId.references = [{ kind: "attestation", id: "provider-a", sha256: sha64(902) }];
  assert.equal(acquisitionModule.validateEventObservation(topId), false);

  const finalityKind = eventObservation();
  finalityKind.finality.references = [{ kind: "familyLabel", id: "evidence-b", sha256: sha64(903) }];
  assert.equal(acquisitionModule.validateEventObservation(finalityKind), false);

  const familyId = eventObservation();
  familyId.familyEvidence.references = [{ kind: "attestation", id: "family-label-b", sha256: sha64(904) }];
  assert.equal(acquisitionModule.validateEventObservation(familyId), false);

  const registry = targetRegistry();
  registry.entries[0].references = [{ kind: "attestation", id: "endpoint-host-a", sha256: sha64(905) }];
  assert.equal(acquisitionModule.validateTargetRegistry(registry), false);

  const index = suppression({ entries: [{
    suppressionId: "suppression-reference-test",
    acquisitionCandidateId: acquisitionModule.acquisitionCandidateId(candidateMaterial()),
    kind: "duplicate",
    active: "true",
    expiresAt: iso(60_000),
    references: [{ kind: "attestation", id: "rpc-transport-a", sha256: sha64(906) }]
  }] });
  assert.equal(acquisitionModule.validateSuppression(index), false);
});
