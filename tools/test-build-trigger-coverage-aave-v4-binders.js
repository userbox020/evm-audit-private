#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const audit = require("./audit-trigger-coverage-universe.js");
const builder = require("./build-trigger-coverage-aave-v4-binders.js");
const topologyProducer = require("./scan-aave-v4-hubs.js");
const borrowerProducer = require("./scan-aave-v4-spoke-borrowers.js");
const watchProducer = require("./watch-aave-v4-liquidation-triggers.js");

const WORKSPACE = builder.WORKSPACE;
const CONFIG_PATH = builder.CONFIG_PATH;
const TOPOLOGY_REL = "reports/raw/fast/aave-v4-hubs.json";
const MONITOR_REL = "reports/raw/fast/aave-v4-liquidation-watch.json";
const FIXTURE_TIME = "2026-09-20T00:00:00.000Z";

function realConfig() { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
function realUniverse() { return JSON.parse(fs.readFileSync(audit.UNIVERSE_PATH, "utf8")); }
function fixtureMonitor() {
  const topology = normalizedTopology();
  const coverage = borrowerProducer.buildSourceCoverage({
    upstreamCoverage: topology.sourceCoverage, topologyGeneratedAt: FIXTURE_TIME,
    chainsExpected: 1, chainsObserved: 1, spokesObserved: 1,
    observedRange: { fromBlock: 90, toBlock: 100 }, historyScope: "RECENT_BLOCK_SUFFIX",
    logChunksAttempted: 1, logChunksSucceeded: 1, logChunksFailed: 0,
    discoveredBorrowers: 2, checkedBorrowers: 1, accountReadsAttempted: 1,
    accountReadsSucceeded: 1, accountReadsFailed: 0, wasTruncated: true,
  }, Date.parse(FIXTURE_TIME));
  const snapshot = watchProducer.summarizeBorrowers({
    generatedAt: FIXTURE_TIME, chain: { id: 1 }, sourceCoverage: coverage,
    summary: { activeBorrowers: 1, liquidatable: 0, routePositive: 0 }, topUsers: [],
  }, { nowMs: Date.parse(FIXTURE_TIME) });
  return watchProducer.buildWatchArtifact(snapshot, [], {}, { generatedAt: FIXTURE_TIME });
}

function tempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode", "tc-aave-v4-binders-"));
  fs.mkdirSync(path.join(root, "reports", "raw", "fast"), { recursive: true });
  fs.mkdirSync(path.join(root, "reports", "monitor"), { recursive: true });
  return root;
}
function writeArtifacts(root, topology, monitor) {
  fs.writeFileSync(path.join(root, TOPOLOGY_REL), `${JSON.stringify(topology)}\n`, "utf8");
  fs.writeFileSync(path.join(root, MONITOR_REL), `${JSON.stringify(monitor)}\n`, "utf8");
}
function universeRow(universe, id) {
  const row = universe.rows.find((entry) => entry.id === id);
  assert.ok(row, `missing row ${id}`);
  return row;
}
function normalizedTopology() {
  // Synthetic producer-shaped fixture: live monitor refreshes must not change a
  // unit test's happy-path input or require private/read-only network access.
  const registry = topologyProducer.loadAaveV4EthereumRegistry();
  const hubs = registry.hubs.map(hub => ({ ...hub, assetCountReadOk: true, assetCount: 0, assetScanTruncated: false, assets: [], listedSpokeDependencies: [] }));
  const spoke = "0x0000000000000000000000000000000000000009";
  const reserve = { reserveId: 0, reserveIdError: null, errors: {}, reserve: { hub: hubs[0].address, assetId: "0", underlying: null },
    oracleData: { spoke, address: spoke, source: spoke, price: 1, referencePriceUsd: 1, errors: {} } };
  hubs[0].assetCount = 1;
  hubs[0].assets = [{ assetId: 0, status: "ok", spokeDirectory: { count: 1, truncated: false, error: null, rows: [{ address: spoke, listed: true, listedError: null, config: { error: null }, reserve }] } }];
  hubs[0].listedSpokeDependencies = [{ address: spoke, linkedAssets: [{ assetId: 0, reserve }] }];
  return { scanner: "tools/scan-aave-v4-hubs.js", generatedAt: FIXTURE_TIME, chain: { id: 1 }, hubs,
    sourceCoverage: topologyProducer.buildTopologySourceCoverage(hubs, registry) };
}

test("registry-bound sample-complete topology covers O but incomplete evidence leaves enabled borrower L MISSING", () => {
  const root = tempWorkspace();
  const topology = normalizedTopology();
  writeArtifacts(root, topology, fixtureMonitor());
  const universe = realUniverse();
  const result = builder.buildBinders({ workspace: root, universe, apply: true });

  assert.equal(result.binders.length, 2);
  assert.equal(result.covered, 1);
  assert.equal(result.blocked, 1);
  assert.equal(result.written.length, 2);

  const observedAt = new Date(Date.parse(topology.generatedAt)).toISOString();
  const o = result.binders.find((binder) => binder.id === "ethereum-aave-v4-o");
  const l = result.binders.find((binder) => binder.id === "ethereum-aave-v4-l");
  assert.ok(o && l);

  // O: honest bounded registry-anchored oracle coverage.
  assert.equal(o.value.observedAt, observedAt);
  assert.equal(o.value.chainId, 1);
  assert.equal(o.value.family, "Aave V4");
  assert.equal(o.value.triggerClass, "O");
  assert.equal(o.value.enumeration.kind, universeRow(universe, o.id).enumerationKind);
  assert.equal(o.value.enumeration.ref, universeRow(universe, o.id).enumerationRef);
  assert.equal(o.value.enumeration.boundDeclared, true);
  assert.equal(o.value.enumeration.successful, true);
  assert.equal(o.value.reads.failed, 0);
  assert.equal(o.value.reads.succeeded + o.value.reads.failed, o.value.reads.attempted);
  assert.equal(o.value.classSemantics.exact, true);
  assert.equal(o.value.coverage.complete, true);
  assert.deepEqual(o.value.onFire, { economics: true, keylessFixedPinFork: true, alert: true });
  assert.equal(o.value.dispatchEnabled, true);
  assert.deepEqual(o.value.blockers, []);
  assert.ok(o.value.evidence.some((line) => /sample-complete|sampleComplete=true/.test(line)));
  assert.ok(o.value.evidence.some((line) => /not an exhaustive position proof|exhaustiveProof=null/.test(line)));
  assert.ok(o.value.evidence.some((line) => /oracle observation read cleanly/.test(line)));

  // L: incomplete evidence disables the binder despite declared dispatch intent.
  assert.equal(universeRow(universe, l.id).onFire.enabled, true);
  assert.equal(l.value.observedAt, FIXTURE_TIME);
  assert.equal(l.value.triggerClass, "L");
  assert.equal(l.value.enumeration.successful, false);
  assert.equal(l.value.coverage.complete, false);
  assert.equal(l.value.dispatchEnabled, false);
  assert.deepEqual(l.value.onFire, { economics: false, keylessFixedPinFork: false, alert: false });
  assert.ok(l.value.blockers.length > 0);
  assert.ok(l.value.blockers.some((line) => /sampleComplete/.test(line)));
  assert.ok(l.value.blockers.some((line) => /borrower/i.test(line)));

  const oAssessed = audit.auditRow({ ...universeRow(universe, o.id), artifactPath: o.artifactPath }, { workspace: root, nowMs: Date.parse(topology.generatedAt) + 1_000 });
  assert.equal(oAssessed.status, "COVERED");
  assert.deepEqual(oAssessed.blockers, []);
  const lAssessed = audit.auditRow({ ...universeRow(universe, l.id), artifactPath: l.artifactPath }, { workspace: root, nowMs: Date.parse(FIXTURE_TIME) + 1_000 });
  assert.equal(lAssessed.status, "MISSING", "incomplete evidence cannot promote an enabled row");
  assert.ok(lAssessed.blockers.length > 0);
});

test("wiring check confirms the two Aave V4 rows point at their binders with the declared dispatch intent", () => {
  const universe = realUniverse();
  assert.deepEqual(builder.checkUniverseWiring(universe, realConfig()), []);
  const o = universeRow(universe, "ethereum-aave-v4-o");
  const l = universeRow(universe, "ethereum-aave-v4-l");
  assert.equal(o.artifactPath, "reports/monitor/trigger-coverage/ethereum-aave-v4-o.json");
  assert.equal(l.artifactPath, "reports/monitor/trigger-coverage/ethereum-aave-v4-l.json");
  assert.equal(o.freshnessSeconds, 1800);
  assert.equal(l.freshnessSeconds, 1800);
  assert.equal(o.onFire.enabled, true);
  assert.equal(l.onFire.enabled, true);
  assert.ok(/registry-anchored/.test(o.enumerationRef));
  assert.ok(/complete batch borrower sweep/.test(l.enumerationRef));
  assert.ok(/history-complete borrower index/.test(l.enumerationRef));
});

test("fails closed when the topology envelope is not sample-complete", () => {
  const root = tempWorkspace();
  const topology = normalizedTopology();
  topology.sourceCoverage.sampleComplete = false;
  topology.sourceCoverage.classification = "SOURCE_INCOMPLETE";
  writeArtifacts(root, topology, fixtureMonitor());
  assert.throws(() => builder.buildBinders({ workspace: root, universe: realUniverse() }), /TOPOLOGY_COVERAGE_INVALID/);
});

test("fails closed when a declared reserve/oracle read is missing", () => {
  const root = tempWorkspace();
  const topology = normalizedTopology();
  const linked = topology.hubs[0].listedSpokeDependencies[0].linkedAssets[0];
  linked.reserve.oracleData = null;
  writeArtifacts(root, topology, fixtureMonitor());
  assert.throws(() => builder.buildBinders({ workspace: root, universe: realUniverse() }), /TOPOLOGY_ORACLE_INVALID/);
});

test("fails closed when provenance or read accounting is broken", () => {
  const root = tempWorkspace();
  const brokenProvenance = normalizedTopology();
  brokenProvenance.sourceCoverage.topologyUniverse.commit = "not-a-commit";
  writeArtifacts(root, brokenProvenance, fixtureMonitor());
  assert.throws(() => builder.buildBinders({ workspace: root, universe: realUniverse() }), /TOPOLOGY_COVERAGE_INVALID|TOPOLOGY_PROVENANCE_INVALID/);

  const brokenReads = normalizedTopology();
  brokenReads.sourceCoverage.stateReadsSucceeded -= 1;
  writeArtifacts(root, brokenReads, fixtureMonitor());
  assert.throws(() => builder.buildBinders({ workspace: root, universe: realUniverse() }), /TOPOLOGY_COVERAGE_INVALID|TOPOLOGY_READS_INVALID/);
});

test("never stamps wall-clock observation time and goes stale from the source timestamp", () => {
  const root = tempWorkspace();
  const topology = normalizedTopology();
  topology.generatedAt = "2020-01-01T00:00:00.000Z";
  const monitor = fixtureMonitor();
  monitor.generatedAt = "2020-01-01T00:00:00.000Z";
  writeArtifacts(root, topology, monitor);
  const universe = realUniverse();
  const result = builder.buildBinders({ workspace: root, universe, apply: true });
  const o = result.binders.find((binder) => binder.id === "ethereum-aave-v4-o");
  assert.equal(o.value.observedAt, "2020-01-01T00:00:00.000Z");
  const assessed = audit.auditRow({ ...universeRow(universe, o.id), artifactPath: o.artifactPath }, { workspace: root, nowMs: Date.parse("2026-09-20T07:02:16.276Z") });
  assert.equal(assessed.status, "STALE");
});

test("config validation is fail-closed on row-set, freshness, and blocked-row drift", () => {
  const universe = realUniverse();
  const missingRow = realConfig();
  delete missingRow.rows["ethereum-aave-v4-o"];
  assert.throws(() => builder.buildBinders({ workspace: WORKSPACE, universe, config: missingRow }), /CONFIG_ROW_SET_INVALID/);

  const badFreshness = realConfig();
  badFreshness.freshnessSeconds = 900;
  assert.throws(() => builder.buildBinders({ workspace: WORKSPACE, universe, config: badFreshness }), /UNIVERSE_FRESHNESS_MISMATCH/);

  const blockerOnCovered = realConfig();
  blockerOnCovered.rows["ethereum-aave-v4-o"].blocker = "should not exist";
  assert.throws(() => builder.buildBinders({ workspace: WORKSPACE, universe, config: blockerOnCovered }), /CONFIG_ROW_BLOCKER_UNEXPECTED/);

  const missingBlocker = realConfig();
  missingBlocker.rows["ethereum-aave-v4-l"] = { source: "monitor", mode: "BLOCKED" };
  assert.throws(() => builder.buildBinders({ workspace: WORKSPACE, universe, config: missingBlocker }), /CONFIG_ROW_BLOCKER_MISSING/);
});

test("CLI option parsing is strict", () => {
  assert.deepEqual(builder.parseOptions(["--check"]), { apply: false, check: true });
  assert.deepEqual(builder.parseOptions(["--apply"]), { apply: true, check: false });
  assert.throws(() => builder.parseOptions(["--check", "--apply"]), /usage/);
  assert.throws(() => builder.parseOptions(["--nope"]), /usage/);
});
