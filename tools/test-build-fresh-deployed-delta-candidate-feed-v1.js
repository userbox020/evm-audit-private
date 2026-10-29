#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sentinelModule = require("./run-official-deployed-delta-sentinel.js");
const feeder = require("./build-fresh-deployed-delta-candidate-feed-v1.js");

const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);
const iso = (offset) => new Date(NOW + offset).toISOString();
const sha40 = (number) => number.toString(16).padStart(40, "0");
const sha64 = (number) => number.toString(16).padStart(64, "0");
const ref = (id = "authority-1", number = 900) => ({ kind: "attestation", id, sha256: sha64(number) });

function sentinel(status = "candidate-change") {
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
    changedManifestPaths: index === 0 ? ["contracts/Vault.sol"] : [],
    changeHints: index === 0 ? ["implementation"] : [],
    chainTextHints: [],
    evidenceUrls: [],
    etagByUrl: {},
    pollStatus: status === "incomplete" || status === "rate-limited"
      ? status : (index === 0 ? "candidate-change" : "unchanged"),
    observedAt: iso(-60_000)
  }));
  return {
    schema: sentinelModule.SCHEMA,
    generatedAt: iso(-60_000),
    runId: "sentinel-run-1",
    status,
    baselineCreated: false,
    repositories
  };
}

function evidence(overrides = {}) {
  const sent = overrides._sentinel || sentinel();
  const repository = sent.repositories[0];
  const row = {
    schema: feeder.EVIDENCE_SCHEMA,
    evidenceId: "evidence-1",
    deltaId: "delta-1",
    observedAt: iso(-30_000),
    expiresAt: iso(60 * 60 * 1000),
    sentinelBinding: {
      runId: sent.runId,
      repositoryId: repository.id,
      previousHeadSha: repository.previousHeadSha,
      observedHeadSha: repository.observedHeadSha
    },
    identity: { protocol: "protocol-a", chainId: "1", targetCommitment: sha64(501) },
    delta: {
      classes: ["implementation"],
      affectedLocations: [{ path: "contracts/Vault.sol", startLine: 10, endLine: 20, symbol: "Vault.apply", side: "head" }]
    },
    source: { exact: "true", commit: repository.observedHeadSha, treeCommitment: sha64(502), references: [ref("source-1", 1)] },
    deployment: { current: "true", finalized: "true", pinCommitment: sha64(503), references: [ref("deployment-1", 2)] },
    runtime: { bound: "true", deltaApplied: "true", runtimeCommitment: sha64(504), references: [ref("runtime-1", 3)] },
    route: { publicAccountingPath: "unknown", liquidExit: "unknown", references: [] },
    novelty: { status: "unknown", references: [] }
  };
  delete overrides._sentinel;
  return deepAssign(row, overrides);
}

function suppression(overrides = {}) {
  return deepAssign({
    schema: feeder.SUPPRESSION_SCHEMA,
    indexId: "suppression-index-1",
    generatedAt: iso(-60_000),
    expiresAt: iso(2 * 60 * 60 * 1000),
    entries: []
  }, overrides);
}

function deepAssign(target, source) {
  const copy = structuredClone(target);
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value) && copy[key] && typeof copy[key] === "object" && !Array.isArray(copy[key])) {
      copy[key] = deepAssign(copy[key], value);
    } else copy[key] = structuredClone(value);
  }
  return copy;
}

function build(rows = [evidence()], sent = sentinel(), index = suppression(), now = NOW) {
  return feeder.buildFeed({ sentinel: sent, evidence: rows, suppression: index, now });
}
function throwsCode(fn, code) { assert.throws(fn, (error) => error && error.code === code); }
async function tempDirectory(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fresh-delta-feed-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("1 exact evidence, suppression, and feed schemas validate", () => {
  const row = evidence();
  assert.equal(feeder.validateEvidenceRow(row), true);
  assert.equal(feeder.validateSuppression(suppression()), true);
  assert.equal(feeder.validateFeed(build()), true);
  row.extra = "no";
  assert.equal(feeder.validateEvidenceRow(row), false);
});

test("2 sentinel validation and four-field binding are strict", () => {
  const sent = sentinel();
  assert.equal(feeder.validateSentinel(sent), true);
  const row = evidence({ _sentinel: sent, sentinelBinding: { runId: "other-run" } });
  throwsCode(() => build([row], sent), "SENTINEL_BINDING_MISMATCH");
});

test("3 every affected path must be in changedManifestPaths", () => {
  const row = evidence();
  row.delta.affectedLocations[0].path = "contracts/Other.sol";
  throwsCode(() => build([row]), "AFFECTED_PATH_NOT_CHANGED");
});

test("4 exact source must equal the observed head", () => {
  const row = evidence({ source: { commit: sha40(999) } });
  assert.equal(feeder.validateEvidenceRow(row), false);
  throwsCode(() => build([row]), "INVALID_EVIDENCE");
});

test("5 delta classes and locations are sorted, unique, and exact", () => {
  assert.equal(feeder.validateEvidenceRow(evidence({ delta: { classes: ["config", "implementation"] } })), true);
  assert.equal(feeder.validateEvidenceRow(evidence({ delta: { classes: ["implementation", "config"] } })), false);
  assert.equal(feeder.validateEvidenceRow(evidence({ delta: { classes: ["implementation", "implementation"] } })), false);
});

test("6 filename hints never infer unpause, module, or new-market classes", () => {
  const sent = sentinel();
  sent.repositories[0].changeHints = ["implementation", "pause-unpause-config"];
  const row = evidence({ _sentinel: sent });
  const feed = build([row], sent);
  assert.deepEqual(feed.candidates[0].delta.classes, ["implementation"]);
});

test("7 distinct deployment target commitments produce distinct candidate IDs", () => {
  const first = evidence();
  const second = evidence({ evidenceId: "evidence-2", deltaId: "delta-2", identity: { targetCommitment: sha64(777) } });
  const feed = build([first, second]);
  assert.equal(feed.candidates.length, 2);
  assert.notEqual(feed.candidates[0].candidateId, feed.candidates[1].candidateId);
});

test("8 all exact deployment stages make eligibility true", () => {
  const feed = build();
  assert.equal(feed.candidates[0].deploymentTriageEligible, "true");
  assert.deepEqual(feed.candidates[0].blockers, []);
});

test("9 any false controlling stage makes eligibility false", () => {
  const row = evidence({ runtime: { deltaApplied: "false" } });
  const feed = build([row]);
  assert.equal(feed.observations[0].deploymentTriageEligible, "false");
  assert.deepEqual(feed.observations[0].blockers, ["runtimeDeltaApplied"]);
});

test("10 otherwise unknown controlling stage makes eligibility unknown and status incomplete", () => {
  const row = evidence({ deployment: { finalized: "unknown" } });
  const feed = build([row]);
  assert.equal(feed.observations[0].deploymentTriageEligible, "unknown");
  assert.equal(feed.status, "incomplete");
});

test("11 route certainty changes rank only and cannot promote an ineligible row", () => {
  const row = evidence({ deployment: { current: "false" }, route: { publicAccountingPath: "true", liquidExit: "true" } });
  const feed = build([row]);
  assert.equal(feed.candidates.length, 0);
  assert.equal(feed.observations[0].deploymentTriageEligible, "false");
  assert.equal("routePositive" in feed.observations[0], false);
});

test("12 an exact active unexpired candidateKey suppresses", () => {
  const row = evidence();
  const entry = {
    suppressionId: "suppression-1", candidateKey: feeder.candidateKey(row), kind: "duplicate", active: "true",
    expiresAt: iso(30 * 60 * 1000), references: [ref("suppression-1", 88)]
  };
  const feed = build([row], sentinel(), suppression({ entries: [entry] }));
  assert.equal(feed.suppressed.length, 1);
  assert.equal(feed.candidates.length, 0);
});

test("13 an expired exact suppression entry does not suppress", () => {
  const row = evidence();
  const entry = {
    suppressionId: "suppression-1", candidateKey: feeder.candidateKey(row), kind: "closed-class", active: "true",
    expiresAt: iso(0), references: []
  };
  assert.equal(build([row], sentinel(), suppression({ entries: [entry] })).candidates.length, 1);
});

test("14 fuzzy or inactive suppression never suppresses", () => {
  const row = evidence();
  const entry = {
    suppressionId: "suppression-1", candidateKey: sha64(9999), kind: "duplicate", active: "true",
    expiresAt: iso(60_000), references: []
  };
  assert.equal(build([row], sentinel(), suppression({ entries: [entry] })).candidates.length, 1);
  entry.candidateKey = feeder.candidateKey(row);
  entry.active = "unknown";
  assert.equal(build([row], sentinel(), suppression({ entries: [entry] })).candidates.length, 1);
});

test("15 suppression absence never upgrades unknown novelty", () => {
  const feed = build();
  assert.equal(feed.candidates[0].stages.novelty, "unknown");
});

test("16 expiry boundaries are exact", () => {
  const row = evidence({ observedAt: iso(-60_000), expiresAt: iso(0) });
  const feed = build([row]);
  assert.equal(feed.observations[0].stages.fresh, "false");
  assert.equal(feed.expiresAt, iso(0));
});

test("17 feed expiry is the earliest controlling expiry", () => {
  const row = evidence({ expiresAt: iso(20 * 60 * 1000) });
  const feed = build([row], sentinel(), suppression({ expiresAt: iso(30 * 60 * 1000) }));
  assert.equal(feed.expiresAt, row.expiresAt);
});

test("18 future times obey the fixed five-minute skew rule", () => {
  const within = evidence({ observedAt: iso(feeder.MAX_FUTURE_SKEW_MS), expiresAt: iso(60 * 60 * 1000) });
  assert.equal(build([within]).observations[0].stages.fresh, "unknown");
  const beyond = evidence({ observedAt: iso(feeder.MAX_FUTURE_SKEW_MS + 1), expiresAt: iso(60 * 60 * 1000) });
  throwsCode(() => build([beyond]), "FUTURE_TIME");
});

test("19 ranking is deterministic without weighted or dollar scores", () => {
  const low = evidence({ evidenceId: "evidence-low", deltaId: "delta-low", identity: { targetCommitment: sha64(700) }, novelty: { status: "false" } });
  const high = evidence({ evidenceId: "evidence-high", deltaId: "delta-high", identity: { targetCommitment: sha64(701) }, novelty: { status: "true", references: [ref("novelty-1", 77)] } });
  const feed = build([low, high]);
  assert.equal(feed.candidates[0].deltaId, "delta-high");
  assert.equal(/score|usd|dollar/i.test(JSON.stringify(feed.candidates)), false);
});

test("20 input permutation preserves commitments, rows, and feedId", () => {
  const a = evidence();
  const b = evidence({ evidenceId: "evidence-2", deltaId: "delta-2", identity: { targetCommitment: sha64(702) } });
  assert.deepEqual(build([a, b]), build([b, a]));
});

test("21 boolean tri-state values are rejected", () => {
  assert.equal(feeder.validateEvidenceRow(evidence({ source: { exact: true } })), false);
});

test("22 numeric, null, and uppercase tri-state values are rejected", () => {
  for (const value of [1, null, "TRUE"]) assert.equal(feeder.validateEvidenceRow(evidence({ novelty: { status: value } })), false);
});

test("23 URLs and domains are rejected from injected inputs", () => {
  assert.equal(feeder.validateEvidenceRow(evidence({ evidenceId: "https://bad.invalid/x" })), false);
  assert.equal(feeder.validateSuppression(suppression({ indexId: "bad.example.com" })), false);
});

test("24 addresses, calldata, selectors, and transaction hashes are rejected", () => {
  for (const value of [`0x${"a".repeat(40)}`, "0x12345678", `0x${"b".repeat(64)}`]) {
    assert.equal(feeder.validateEvidenceRow(evidence({ delta: { affectedLocations: [{ path: "contracts/Vault.sol", startLine: 1, endLine: 1, symbol: value, side: "head" }] } })), false);
  }
  assert.equal(feeder.validateEvidenceRow(evidence({ identity: { targetCommitment: sha64(1) } })), true);
});

test("25 raw, diff, RPC, header, error, and provider fields are rejected recursively", () => {
  for (const key of ["rawSource", "diff", "rpc", "header", "error", "provider"]) {
    const row = evidence();
    row.route[key] = "fixture";
    assert.equal(feeder.validateEvidenceRow(row), false);
  }
});

test("26 economic, amount, gas, liquidity, profit, and PnL fields are rejected", () => {
  for (const key of ["amount", "usd", "gas", "liquidity", "profit", "pnl"]) {
    const index = suppression();
    index[key] = 0;
    assert.equal(feeder.validateSuppression(index), false);
  }
});

test("27 executable, routePositive, and promotion justification fields are rejected", () => {
  for (const key of ["executable", "routePositive", "promotionJustification"]) {
    const row = evidence();
    row[key] = false;
    assert.equal(feeder.validateEvidenceRow(row), false);
  }
});

test("28 safety asserts every prohibited side effect false", () => {
  const feed = build();
  assert.deepEqual(feed.safety, {
    networkAccess: false, rpcAccess: false, forkUse: false, pnlEvaluation: false,
    signing: false, transactions: false, promotion: false, automaticPromotion: false
  });
});

test("29 publication uses canonical bytes and atomic no-replace", async (t) => {
  const directory = await tempDirectory(t);
  const feed = build();
  const filename = await feeder.publishNoReplace(feed, { outputDirectory: directory, fsImpl: fs });
  assert.equal(path.basename(filename), `${feed.feedId}.json`);
  assert.deepEqual(await fs.promises.readFile(filename), feeder.canonicalBytes(feed));
  await assert.rejects(feeder.publishNoReplace(feed, { outputDirectory: directory, fsImpl: fs }), (error) => error.code === "OUTPUT_EXISTS");
});

test("30 pre-link stage failure leaves no output or temporary file", async (t) => {
  const directory = await tempDirectory(t);
  const feed = build();
  const api = Object.create(fs.promises);
  api.link = async () => { const error = new Error("stage fixture"); error.code = "EIO"; throw error; };
  await assert.rejects(feeder.publishNoReplace(feed, { outputDirectory: directory, fsImpl: api }));
  assert.deepEqual(await fs.promises.readdir(directory), []);
});

test("31 post-link failure leaves at most one complete immutable artifact", async (t) => {
  const directory = await tempDirectory(t);
  const feed = build();
  const api = Object.create(fs.promises);
  api.readFile = async () => { const error = new Error("post-link fixture"); error.code = "EIO"; throw error; };
  await assert.rejects(feeder.publishNoReplace(feed, { outputDirectory: directory, fsImpl: api }));
  const names = await fs.promises.readdir(directory);
  assert.deepEqual(names, [`${feed.feedId}.json`]);
  assert.equal(feeder.validateFeed(JSON.parse(await fs.promises.readFile(path.join(directory, names[0]), "utf8"))), true);
});

test("32 readback tampering is detected without mutable latest output", async (t) => {
  const directory = await tempDirectory(t);
  const feed = build();
  const api = Object.create(fs.promises);
  api.readFile = async (filename) => {
    const bytes = await fs.promises.readFile(filename);
    return Buffer.concat([bytes, Buffer.from(" ")]);
  };
  await assert.rejects(feeder.publishNoReplace(feed, { outputDirectory: directory, fsImpl: api }), (error) => error.code === "READBACK_MISMATCH");
  assert.equal((await fs.promises.readdir(directory)).some((name) => /latest|sentinel|ledger|evaluator/i.test(name)), false);
});

test("33 incomplete and rate-limited sentinels force incomplete feeds", () => {
  for (const status of ["incomplete", "rate-limited"]) {
    const sent = sentinel(status);
    const row = evidence({ _sentinel: sent });
    assert.equal(build([row], sent).status, "incomplete");
  }
});

test("34 dry run builds, validates, and append-only publishes without transport or evaluator hooks", async (t) => {
  let calls = 0;
  const directory = await tempDirectory(t);
  const options = {
    sentinel: sentinel(), evidence: [evidence()], suppression: suppression(), now: NOW,
    outputDirectory: directory, fsImpl: fs
  };
  Object.defineProperty(options, "transport", { enumerable: false, get() { calls += 1; throw new Error("transport invoked"); } });
  Object.defineProperty(options, "evaluator", { enumerable: false, get() { calls += 1; throw new Error("evaluator invoked"); } });
  const result = await feeder.runDry(options);
  assert.deepEqual(Object.keys(result).sort(), ["feed", "filename"]);
  assert.equal(feeder.validateFeed(result.feed), true);
  assert.equal(result.filename, path.join(directory, `${result.feed.feedId}.json`));
  assert.deepEqual(await fs.promises.readFile(result.filename), feeder.canonicalBytes(result.feed));
  assert.equal(calls, 0);
});

test("35 duplicate suppression candidateKeys are rejected independent of entry order", () => {
  const key = feeder.candidateKey(evidence());
  const entries = [
    {
      suppressionId: "suppression-duplicate-a", candidateKey: key, kind: "duplicate", active: "true",
      expiresAt: iso(30 * 60 * 1000), references: [ref("suppression-reference-a", 801)]
    },
    {
      suppressionId: "suppression-duplicate-b", candidateKey: key, kind: "closed-class", active: "unknown",
      expiresAt: iso(45 * 60 * 1000), references: [ref("suppression-reference-b", 802)]
    }
  ];
  for (const ordered of [entries, [...entries].reverse()]) {
    const index = suppression({ entries: ordered });
    assert.equal(feeder.validateSuppression(index), false);
    assert.throws(
      () => build([evidence()], sentinel(), index),
      (error) => error && error.name === "FeedError" && error.code === "INVALID_SUPPRESSION" && error.message === "INVALID_SUPPRESSION"
    );
  }
});
