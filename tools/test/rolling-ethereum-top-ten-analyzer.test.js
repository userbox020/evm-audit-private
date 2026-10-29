"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const analyzer = require("../atomic/ethereum-top-trades-7d-reconstruction/rolling-ethereum-top-ten-analyzer");

function tx(index) { return `0x${index.toString(16).padStart(64, "0")}`; }
function fixtureRow(index, overrides = {}) {
  return {
    transactionHash: tx(index),
    classification: { type: "pattern-only", verified: false },
    rankingEvidence: { confidence: index, reproducibility: index % 4, liquidityCapacity: index % 3 },
    ledger: { coverage: { clusterComplete: index % 2 === 0 }, reconciliationComplete: false },
    economics: { status: "UNKNOWN", routePositive: false },
    ...overrides,
  };
}
function fixtureCollection(rows) {
  return {
    window: {
      chainId: "1", immutable: true,
      start: { number: "100", hash: tx(900), timestamp: "1000" },
      finalized: { number: "200", hash: tx(901), timestamp: "2000" },
      agreement: { providers: [0, 1] },
    },
    reconciled: { rows },
    providerQualifications: [{ endpoint: "must-not-survive" }],
  };
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

test("preflight is offline, Ethereum-only, deterministic, and writes nothing", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-analyzer-preflight-"));
  try {
    const before = fs.readdirSync(parent), output = [], errors = [], exits = [];
    const result = analyzer.runCli(["--preflight-only"], { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), setExitCode: (value) => exits.push(value) });
    assert.deepEqual(result, analyzer.preflight());
    assert.deepEqual(fs.readdirSync(parent), before);
    assert.equal(errors.length, 0); assert.equal(exits.length, 0);
    assert.deepEqual(JSON.parse(output[0]), analyzer.preflight());
    assert.equal(result.chain, "ethereum"); assert.equal(result.solana, "EXCLUDED_NOT_READ"); assert.equal(result.rpcPerformed, false); assert.equal(result.webPerformed, false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("CLI rejects unbounded or unsafe intervals and disables production by default", async () => {
  for (const argv of [["--interval-ms", "0", "--iterations", "1"], ["--interval-ms", "-1", "--iterations", "1"], ["--interval-ms", String(analyzer.MIN_INTERVAL_MS - 1), "--iterations", "1"], ["--interval-ms", String(analyzer.MAX_INTERVAL_MS + 1), "--iterations", "1"], ["--interval-ms", String(analyzer.MIN_INTERVAL_MS), "--iterations", String(analyzer.MAX_ITERATIONS + 1)], ["--interval-ms", String(analyzer.MIN_INTERVAL_MS)]]) {
    assert.throws(() => analyzer.parseArgs(argv));
  }
  assert.deepEqual(analyzer.parseArgs(["--interval-ms", String(analyzer.MIN_INTERVAL_MS), "--iterations", "2"]), { mode: "interval", intervalMs: analyzer.MIN_INTERVAL_MS, iterations: 2 });
  let code; const result = await analyzer.runCli(["--once"], { stdout: () => {}, stderr: () => {}, setExitCode: (value) => { code = value; } });
  assert.deepEqual(result, { ok: false, code: "ROLLING_ANALYZER_PRODUCTION_DISABLED" }); assert.equal(code, 1);
  code = null; const live = await analyzer.runCli(["--live-once"], { stdout: () => {}, stderr: () => {}, setExitCode: (value) => { code = value; } });
  assert.deepEqual(live, { ok: false, code: "ROLLING_ANALYZER_PRODUCTION_DISABLED" }); assert.equal(code, 1);
  code = null; const cycle02 = await analyzer.runCli(["--live-once-02"], { stdout: () => {}, stderr: () => {}, setExitCode: (value) => { code = value; } });
  assert.deepEqual(cycle02, { ok: false, code: "ROLLING_ANALYZER_PRODUCTION_DISABLED" }); assert.equal(code, 1);
  code = null; const cycle03 = await analyzer.runCli(["--live-once-03"], { stdout: () => {}, stderr: () => {}, setExitCode: (value) => { code = value; } });
  assert.deepEqual(cycle03, { ok: false, code: "ROLLING_ANALYZER_PRODUCTION_DISABLED" }); assert.equal(code, 1);
  code = null; const cycle04 = await analyzer.runCli(["--live-once-04"], { stdout: () => {}, stderr: () => {}, setExitCode: (value) => { code = value; } });
  assert.deepEqual(cycle04, { ok: false, code: "ROLLING_ANALYZER_PRODUCTION_DISABLED" }); assert.equal(code, 1);
});

test("analyzer excludes ordinary activity, preserves UNKNOWN/WATCH, and deterministically keeps current top ten", () => {
  const rows = [];
  for (let index = 1; index <= 12; index += 1) rows.push(fixtureRow(index));
  rows.push(fixtureRow(50, { classification: { type: "liquidation", verified: true } }));
  rows.push(fixtureRow(51, { classification: { type: "arbitrage", verified: true } }));
  rows.push(fixtureRow(52, { classification: { type: "sandwich", verified: true }, economics: { status: "UNKNOWN", routePositive: false } }));
  rows.push(fixtureRow(53, { classification: { type: "pattern-only", verified: false }, economics: { status: "KNOWN", routePositive: false, net: { usdMicros: "0" } } }));
  rows.push(fixtureRow(54, { classification: { type: "pattern-only", verified: false }, ledger: { reconciliationComplete: true, assetDeltas: [{ rawDelta: "0" }] } }));
  rows.push(fixtureRow(55, { classification: { type: "backrun", verified: true }, economics: { status: "KNOWN", routePositive: true, net: { usdMicros: "100" } } }));
  const state = analyzer.buildState(fixtureCollection(rows));
  assert.equal(state.policy.topK, 10); assert.equal(state.policy.historyMode, "CURRENT_ONLY"); assert.equal(state.results.length, 10);
  const upstreamPositive = state.results.find((row) => row.transactionHash === tx(55)); assert.equal(upstreamPositive.disposition, "WATCH"); assert.equal(upstreamPositive.reason, "UPSTREAM_POSITIVE_NOT_PROMOTED"); assert.equal(upstreamPositive.routePositive, "unknown");
  assert.deepEqual(state.results.map((row) => row.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(state.rejections.map((row) => row.reason).sort(), ["BALANCED_SETTLEMENT", "KNOWN_NONPOSITIVE_ECONOMICS", "ORDINARY_ARBITRAGE", "ORDINARY_LIQUIDATION"].sort());
  assert.equal(JSON.stringify(state).includes("must-not-survive"), false); assert.equal(JSON.stringify(state).includes("provider"), false); assert.equal(JSON.stringify(state).includes("endpoint"), false);
  assert.equal(state.scope.chain, "ethereum"); assert.equal(state.scope.solana, "EXCLUDED_NOT_READ"); assert.equal(state.nonclaims.signing, false); assert.equal(state.nonclaims.broadcast, false); assert.equal(state.nonclaims.forkClaim, false);
  const next = analyzer.buildState(fixtureCollection([fixtureRow(80)]));
  assert.deepEqual(next.results.map((row) => row.transactionHash), [tx(80)]);
});

test("collection runs only through explicit injected transport and collector dependency", async () => {
  const transport = async () => { throw new Error("transport-not-invoked-by-fixture"); };
  let collectedOptions, written;
  const result = await analyzer.collectOnce({
    transport,
    outputDirectory: "injected-output-not-written",
    approvedParent: "injected-parent-not-read",
    inventoryEntries: [{ family: "injected" }],
    limits: { maxRequests: 1 },
    collect: async (options) => { collectedOptions = options; return fixtureCollection([fixtureRow(3)]); },
    write: (directory, state, controls) => { written = { directory, state, controls }; analyzer.validateState(state); return { postvalidated: true }; },
  });
  assert.equal(collectedOptions.transport, transport); assert.equal(collectedOptions.traces, false); assert.deepEqual(collectedOptions.inventoryEntries, [{ family: "injected" }]);
  assert.equal(written.directory, "injected-output-not-written"); assert.equal(written.controls.approvedParent, "injected-parent-not-read"); assert.equal(result.state.lifecycle.mode, "INJECTED_COLLECT_ONCE"); assert.equal(result.state.lifecycle.collectionInjected, true);
});

test("strict validation rejects leaks and positive, executable, profit, signing, broadcast, or fork claims", () => {
  const state = analyzer.buildState(fixtureCollection([fixtureRow(1)]));
  for (const mutate of [
    (value) => { value.endpoint = "secret"; },
    (value) => { value.results[0].routePositive = true; },
    (value) => { value.results[0].executableNow = true; },
    (value) => { value.nonclaims.profitClaim = true; },
    (value) => { value.nonclaims.currentExecutableClaim = true; },
    (value) => { value.nonclaims.signing = true; },
    (value) => { value.nonclaims.broadcast = true; },
    (value) => { value.nonclaims.forkClaim = true; },
  ]) {
    const changed = clone(state); mutate(changed); assert.throws(() => analyzer.validateState(changed));
  }
});

test("atomic writer postvalidates, refuses overwrite, and preserves a competing final directory", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-analyzer-write-"));
  try {
    const state = analyzer.buildState(fixtureCollection([fixtureRow(1)]));
    const target = path.join(parent, "rolling-ethereum-top-ten-first");
    const receipt = analyzer.writeBundle(target, state, { approvedParent: parent });
    assert.equal(receipt.postvalidated, true); assert.deepEqual(analyzer.validateDirectory(target), state);
    assert.throws(() => analyzer.writeBundle(target, state, { approvedParent: parent }), /ROLLING_ANALYZER_OUTPUT_EXISTS/);

    const raced = path.join(parent, "rolling-ethereum-top-ten-race");
    assert.throws(() => analyzer.writeBundle(raced, state, { approvedParent: parent, beforeRename: (_staging, final) => { fs.mkdirSync(final); fs.writeFileSync(path.join(final, "sentinel"), "foreign"); } }), /ROLLING_ANALYZER_OUTPUT_EXISTS/);
    assert.equal(fs.readFileSync(path.join(raced, "sentinel"), "utf8"), "foreign");
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("injected live-once adapter performs exactly one bounded collection and publishes no inventory material", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-analyzer-live-"));
  const outputDirectory = path.join(parent, "rolling-ethereum-top-ten-test-live");
  const inventoryEntries = [{ url: "https://credential.example.invalid/private", ethereumHint: true, marker: "inventory-secret-marker" }];
  let reads = 0, collections = 0, transports = 0;
  try {
    const adapter = () => analyzer.productionAdapter({
      approvedParent: parent,
      outputDirectory,
      readInventory: () => { reads += 1; return inventoryEntries; },
      transport: async () => { transports += 1; throw new Error("fixture-transport-must-not-run"); },
      collect: async (options) => {
        collections += 1; assert.equal(options.inventoryEntries, inventoryEntries); assert.equal(options.traces, false);
        assert.ok(options.limits.requests <= analyzer.LIVE_LIMITS.requests); assert.ok(options.limits.concurrency <= analyzer.LIVE_LIMITS.concurrency); assert.equal(options.limits.traceTransactions, 0);
        return fixtureCollection([fixtureRow(7)]);
      },
    });
    const stdout = [], stderr = []; const summary = await analyzer.runCli(["--live-once"], { dependencies: { productionAdapter: adapter }, stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value), setExitCode: () => assert.fail("unexpected exit") });
    assert.equal(reads, 1); assert.equal(collections, 1); assert.equal(transports, 0); assert.equal(summary.ok, true); assert.equal(summary.mode, "live-once"); assert.equal(summary.cycles, 1); assert.equal(summary.postvalidated, true);
    const state = analyzer.validateDirectory(outputDirectory); assert.equal(state.lifecycle.mode, "LIVE_READ_ONLY_ONCE"); assert.equal(state.nonclaims.routePositive, "unknown"); assert.equal(state.nonclaims.forkClaim, false);
    const serialized = `${fs.readFileSync(path.join(outputDirectory, "state.json"), "utf8")}${fs.readFileSync(path.join(outputDirectory, "manifest.json"), "utf8")}${stdout.join("")}${stderr.join("")}`;
    assert.equal(serialized.includes("credential.example.invalid"), false); assert.equal(serialized.includes("inventory-secret-marker"), false); assert.equal(/(?:https?|wss?):\/\//i.test(serialized), false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("live-once capture failure emits no output", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-analyzer-live-fail-"));
  const outputDirectory = path.join(parent, "rolling-ethereum-top-ten-test-failure");
  try {
    await assert.rejects(() => analyzer.productionAdapter({ approvedParent: parent, outputDirectory, readInventory: () => [], transport: async () => {}, collect: async () => { throw new Error("fixture-read-failure"); } }), /ROLLING_ANALYZER_CAPTURE_FAILED/);
    assert.equal(fs.existsSync(outputDirectory), false); assert.deepEqual(fs.readdirSync(parent), []);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("live-once refuses a preexisting fixed target before inventory read", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-analyzer-live-existing-"));
  const outputDirectory = path.join(parent, "rolling-ethereum-top-ten-test-existing"); let reads = 0;
  try {
    fs.mkdirSync(outputDirectory); fs.writeFileSync(path.join(outputDirectory, "sentinel"), "preserve");
    await assert.rejects(() => analyzer.productionAdapter({ approvedParent: parent, outputDirectory, readInventory: () => { reads += 1; return []; } }), /ROLLING_ANALYZER_OUTPUT_EXISTS/);
    assert.equal(reads, 0); assert.equal(fs.readFileSync(path.join(outputDirectory, "sentinel"), "utf8"), "preserve");
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

function cycleCollection(indices, finalizedBlockNumber) {
  const collection = fixtureCollection(indices.map((index) => fixtureRow(index)));
  collection.window.start = { number: String(finalizedBlockNumber - 100), hash: tx(finalizedBlockNumber - 100), timestamp: "1000" };
  collection.window.finalized = { number: String(finalizedBlockNumber), hash: tx(finalizedBlockNumber), timestamp: "2000" };
  return collection;
}
function prepareCycle01(parent, indices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], finalizedBlockNumber = 200) {
  const directory = path.join(parent, analyzer.LIVE_OUTPUT_BASENAME), state = analyzer.buildState(cycleCollection(indices, finalizedBlockNumber), { mode: "LIVE_READ_ONLY_ONCE" });
  analyzer.writeBundle(directory, state, { approvedParent: parent }); return { directory, state };
}

test("cycle02 has one fixed CLI target and cycle comparison is exact", () => {
  assert.equal(analyzer.LIVE_OUTPUT_BASENAME_02, "rolling-ethereum-top-ten-20260828-02"); assert.equal(path.basename(analyzer.LIVE_OUTPUT_DIRECTORY_02), analyzer.LIVE_OUTPUT_BASENAME_02); assert.deepEqual(analyzer.parseArgs(["--live-once-02"]), { mode: "live-once-02", iterations: 1, intervalMs: null });
  const oldState = analyzer.buildState(cycleCollection([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 200)), newState = analyzer.buildState(cycleCollection([6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 210));
  assert.deepEqual(analyzer.compareCycles(oldState, newState), { overlapCount: 5, newHashCount: 5, oldOnlyCount: 5, finalizedBlockDelta: "10" });
});

test("injected cycle02 succeeds once, preserves cycle01, and emits only sanitized comparison counts", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-analyzer-cycle02-")), cycle01 = prepareCycle01(parent), outputDirectory = path.join(parent, analyzer.LIVE_OUTPUT_BASENAME_02), before = analyzer.snapshotArtifact(cycle01.directory), inventoryEntries = [{ url: "https://cycle02.secret.invalid/private", marker: "cycle02-inventory-secret" }]; let inventoryReads = 0, collections = 0;
  try {
    const output = [], errors = [], summary = await analyzer.runCli(["--live-once-02"], { dependencies: { productionAdapter02: () => analyzer.productionAdapter02({ approvedParent: parent, cycle01Directory: cycle01.directory, outputDirectory, readInventory: () => { inventoryReads += 1; return inventoryEntries; }, transport: async () => { throw new Error("fixture-transport-must-not-run"); }, collect: async (options) => { collections += 1; assert.equal(options.inventoryEntries, inventoryEntries); assert.equal(options.traces, false); return cycleCollection([6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 210); } }) }, stdout: (value) => output.push(value), stderr: (value) => errors.push(value), setExitCode: () => assert.fail("unexpected exit") });
    assert.equal(inventoryReads, 1); assert.equal(collections, 1); assert.equal(summary.ok, true); assert.equal(summary.mode, "live-once-02"); assert.equal(summary.artifact, analyzer.LIVE_OUTPUT_BASENAME_02); assert.deepEqual({ overlapCount: summary.overlapCount, newHashCount: summary.newHashCount, oldOnlyCount: summary.oldOnlyCount, finalizedBlockDelta: summary.finalizedBlockDelta }, { overlapCount: 5, newHashCount: 5, oldOnlyCount: 5, finalizedBlockDelta: "10" });
    assert.equal(summary.signing, false); assert.equal(summary.broadcast, false); assert.equal(summary.fork, false); assert.equal(errors.length, 0); assert.equal(analyzer.validateDirectory(outputDirectory).results.length, 10); analyzer.assertArtifactPreserved(before, analyzer.snapshotArtifact(cycle01.directory));
    const serialized = `${fs.readFileSync(path.join(outputDirectory, "state.json"), "utf8")}${fs.readFileSync(path.join(outputDirectory, "manifest.json"), "utf8")}${output.join("")}`; assert.equal(serialized.includes("cycle02.secret.invalid"), false); assert.equal(serialized.includes("cycle02-inventory-secret"), false); assert.equal(/(?:https?|wss?):\/\//i.test(serialized), false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("cycle02 preexisting target rejects before inventory and preserves cycle01", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-analyzer-cycle02-existing-")), cycle01 = prepareCycle01(parent), outputDirectory = path.join(parent, analyzer.LIVE_OUTPUT_BASENAME_02), before = analyzer.snapshotArtifact(cycle01.directory); let inventoryReads = 0;
  try { fs.mkdirSync(outputDirectory); fs.writeFileSync(path.join(outputDirectory, "sentinel"), "foreign"); await assert.rejects(() => analyzer.productionAdapter02({ approvedParent: parent, cycle01Directory: cycle01.directory, outputDirectory, readInventory: () => { inventoryReads += 1; return []; } }), /ROLLING_ANALYZER_OUTPUT_EXISTS/); assert.equal(inventoryReads, 0); assert.equal(fs.readFileSync(path.join(outputDirectory, "sentinel"), "utf8"), "foreign"); analyzer.assertArtifactPreserved(before, analyzer.snapshotArtifact(cycle01.directory)); }
  finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("cycle02 capture failure creates no output and leaves cycle01 byte-identical", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-analyzer-cycle02-failure-")), cycle01 = prepareCycle01(parent), outputDirectory = path.join(parent, analyzer.LIVE_OUTPUT_BASENAME_02), before = analyzer.snapshotArtifact(cycle01.directory);
  try { await assert.rejects(() => analyzer.productionAdapter02({ approvedParent: parent, cycle01Directory: cycle01.directory, outputDirectory, readInventory: () => [], transport: async () => {}, collect: async () => { throw new Error("fixture-capture-failure"); } }), /ROLLING_ANALYZER_CAPTURE_FAILED/); assert.equal(fs.existsSync(outputDirectory), false); analyzer.assertArtifactPreserved(before, analyzer.snapshotArtifact(cycle01.directory)); }
  finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("existing cycle01 live mode refuses its immutable production target before inventory", async () => {
  let inventoryReads = 0; await assert.rejects(() => analyzer.productionAdapter({ readInventory: () => { inventoryReads += 1; return []; } }), /ROLLING_ANALYZER_OUTPUT_EXISTS/); assert.equal(inventoryReads, 0); assert.equal(analyzer.validateDirectory(analyzer.LIVE_OUTPUT_DIRECTORY).results.length, 10);
});

function scoredCycle03Collection(order = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], finalizedBlockNumber = 220) {
  const rows = order.map((index) => fixtureRow(700 + index, { scorerV2Projection: { leadTier: 1, selector4: `0x${index.toString(16).padStart(8, "0")}`, calldataBytes: 68, evidence: { transaction: true, receipt: true, decodedLogs: true, fullBlock: true }, ordinaryKind: "NONE", accounting: index === 10 ? { completeFlowSet: true, unmatchedFlowCount: 1 } : { completeFlowSet: true, unmatchedFlowCount: 0, transferCount: index % 5 }, authorization: {}, replay: {}, precision: {}, transition: {} } }));
  const collection = fixtureCollection(rows); collection.window.start = { number: String(finalizedBlockNumber - 100), hash: tx(finalizedBlockNumber - 100), timestamp: "1000" }; collection.window.finalized = { number: String(finalizedBlockNumber), hash: tx(finalizedBlockNumber), timestamp: "2000" }; return collection;
}

test("cycle03 fixed mode and scorer-v2 priority integration are deterministic", () => {
  assert.equal(analyzer.LIVE_OUTPUT_BASENAME_03, "rolling-ethereum-top-ten-20260828-03"); assert.equal(path.basename(analyzer.LIVE_OUTPUT_DIRECTORY_03), analyzer.LIVE_OUTPUT_BASENAME_03); assert.deepEqual(analyzer.parseArgs(["--live-once-03"]), { mode: "live-once-03", iterations: 1, intervalMs: null });
  const forward = analyzer.buildState(scoredCycle03Collection()), reverse = analyzer.buildState(scoredCycle03Collection([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])); assert.equal(analyzer.text(forward), analyzer.text(reverse)); assert.equal(forward.results[0].transactionHash, tx(710)); assert.equal(forward.results.every((row, index) => row.reviewPriority.version === "v2" && row.reviewPriority.rank === index + 1 && row.disposition === "UNKNOWN"), true);
});

test("injected scorer-v2 cycle03 succeeds once, compares both priors, and preserves all pinned artifacts", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-analyzer-cycle03-")), outputDirectory = path.join(parent, analyzer.LIVE_OUTPUT_BASENAME_03), priorBefore = analyzer.snapshotPinnedPrior(), inventoryEntries = [{ url: "https://cycle03.secret.invalid/private", marker: "cycle03-inventory-secret" }]; let inventoryReads = 0, collections = 0;
  try {
    const stdout = [], stderr = [], summary = await analyzer.runCli(["--live-once-03"], { dependencies: { productionAdapter03: () => analyzer.productionAdapter03({ approvedParent: parent, outputDirectory, readInventory: () => { inventoryReads += 1; return inventoryEntries; }, transport: async () => { throw new Error("fixture-transport-must-not-run"); }, collect: async (options) => { collections += 1; assert.equal(options.inventoryEntries, inventoryEntries); assert.equal(options.traces, false); return scoredCycle03Collection(); } }) }, stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value), setExitCode: () => assert.fail("unexpected exit") });
    assert.equal(inventoryReads, 1); assert.equal(collections, 1); assert.equal(summary.ok, true); assert.equal(summary.mode, "live-once-03"); assert.equal(summary.artifact, analyzer.LIVE_OUTPUT_BASENAME_03); assert.equal(summary.scorerVersion, "v2"); assert.equal(summary.postvalidated, true); assert.equal(summary.signing, false); assert.equal(summary.broadcast, false); assert.equal(summary.fork, false); assert.equal(stderr.length, 0);
    const state = analyzer.validateDirectory(outputDirectory), expected01 = analyzer.compareCycles(priorBefore.cycle01, state), expected02 = analyzer.compareCycles(priorBefore.cycle02, state); assert.deepEqual({ overlapCount: summary.cycle01OverlapCount, newHashCount: summary.cycle01NewHashCount, oldOnlyCount: summary.cycle01OldOnlyCount, finalizedBlockDelta: summary.cycle01FinalizedBlockDelta }, expected01); assert.deepEqual({ overlapCount: summary.cycle02OverlapCount, newHashCount: summary.cycle02NewHashCount, oldOnlyCount: summary.cycle02OldOnlyCount, finalizedBlockDelta: summary.cycle02FinalizedBlockDelta }, expected02);
    assert.equal(state.results.every((row) => row.disposition === "UNKNOWN" && row.reviewPriority.version === "v2" && row.routePositive === "unknown" && row.executableNow === "unknown"), true); assert.equal(state.nonclaims.profitClaim, false); assert.equal(state.nonclaims.currentExecutableClaim, false); assert.equal(state.nonclaims.forkClaim, false); analyzer.assertPinnedPrior(priorBefore, analyzer.snapshotPinnedPrior());
    const serialized = `${fs.readFileSync(path.join(outputDirectory, "state.json"), "utf8")}${fs.readFileSync(path.join(outputDirectory, "manifest.json"), "utf8")}${stdout.join("")}`; assert.equal(serialized.includes("cycle03.secret.invalid"), false); assert.equal(serialized.includes("cycle03-inventory-secret"), false); assert.equal(/(?:https?|wss?):\/\//i.test(serialized), false); assert.equal(serialized.includes("\"disposition\":\"WATCH\""), false); assert.equal(serialized.includes("\"mismatch\""), false); assert.equal(serialized.includes("protocolLoss"), false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("cycle03 preexisting output rejects before inventory and prior files remain pinned", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-analyzer-cycle03-existing-")), outputDirectory = path.join(parent, analyzer.LIVE_OUTPUT_BASENAME_03), priorBefore = analyzer.snapshotPinnedPrior(); let inventoryReads = 0;
  try { fs.mkdirSync(outputDirectory); fs.writeFileSync(path.join(outputDirectory, "sentinel"), "foreign"); await assert.rejects(() => analyzer.productionAdapter03({ approvedParent: parent, outputDirectory, readInventory: () => { inventoryReads += 1; return []; } }), /ROLLING_ANALYZER_OUTPUT_EXISTS/); assert.equal(inventoryReads, 0); assert.equal(fs.readFileSync(path.join(outputDirectory, "sentinel"), "utf8"), "foreign"); analyzer.assertPinnedPrior(priorBefore, analyzer.snapshotPinnedPrior()); }
  finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("cycle03 capture failure creates no output and preserves all prior artifacts", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-analyzer-cycle03-failure-")), outputDirectory = path.join(parent, analyzer.LIVE_OUTPUT_BASENAME_03), priorBefore = analyzer.snapshotPinnedPrior();
  try { await assert.rejects(() => analyzer.productionAdapter03({ approvedParent: parent, outputDirectory, readInventory: () => [], transport: async () => {}, collect: async () => { throw new Error("fixture-cycle03-failure"); } }), /ROLLING_ANALYZER_CAPTURE_FAILED/); assert.equal(fs.existsSync(outputDirectory), false); analyzer.assertPinnedPrior(priorBefore, analyzer.snapshotPinnedPrior()); }
  finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

function prefilterCycle04Collection(order = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], finalizedBlockNumber = 240) {
  const sender = "0x1111111111111111111111111111111111111111", target = "0x2222222222222222222222222222222222222222", token = "0x3333333333333333333333333333333333333333", emitter = "0x4444444444444444444444444444444444444444";
  const rows = order.map((index) => fixtureRow(800 + index, { ledger: { coverage: {}, reconciliationComplete: true } })), candidates = rows.map((entry) => { const index = Number(BigInt(entry.transactionHash)), transfer = { address: token, topics: [], recognized: null, eventFacts: null, transfer: { token, from: sender, to: target, amount: "5", logIndex: "0" } }, logs = index === 810 ? [transfer, { ...transfer }] : index === 809 ? [{ address: emitter, topics: [], recognized: { class: "dex", protocol: "uniswap-v3", event: "Swap" }, eventFacts: { amount0: (1n << 130n).toString(), amount1: "-1", tick: "0" }, transfer: null }] : [transfer]; return { transaction: { hash: entry.transactionHash, from: sender, to: target, selector4: `0x${index.toString(16).padStart(8, "0")}`, calldataBytes: 68, calldataCommitment: "a".repeat(64) }, receipt: { status: "1", logs }, fullBlockProjection: { complete: true, rows: [{ selector4: `0x${index.toString(16).padStart(8, "0")}`, targetCommitment: "b".repeat(64), callCommitment: `${index.toString(16)}`.padStart(64, "0"), targetsCurrentTarget: true }] } }; });
  const collection = fixtureCollection(rows); collection.candidates = { rows: candidates }; collection.window.start = { number: String(finalizedBlockNumber - 100), hash: tx(finalizedBlockNumber - 100), timestamp: "1000" }; collection.window.finalized = { number: String(finalizedBlockNumber), hash: tx(finalizedBlockNumber), timestamp: "2000" }; return collection;
}

test("cycle04 fixed mode publishes deterministic scorer-v2 priorities and prefilter-v3 aggregates", () => {
  assert.equal(analyzer.LIVE_OUTPUT_BASENAME_04, "rolling-ethereum-top-ten-20260828-04"); assert.equal(path.basename(analyzer.LIVE_OUTPUT_DIRECTORY_04), analyzer.LIVE_OUTPUT_BASENAME_04); assert.deepEqual(analyzer.parseArgs(["--live-once-04"]), { mode: "live-once-04", iterations: 1, intervalMs: null });
  const forward = analyzer.buildState(prefilterCycle04Collection()), reverse = analyzer.buildState(prefilterCycle04Collection([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])); assert.equal(analyzer.text(forward), analyzer.text(reverse)); assert.equal(forward.results.every((row, index) => row.disposition === "UNKNOWN" && row.reviewPriority.version === "v2" && row.reviewPriority.rank === index + 1 && row.prefilterAggregates.version === "ROLLING_SAFE_PREFILTER_V3"), true); assert.ok(Math.max(...forward.results.map((row) => row.reviewPriority.maxClassScore)) >= 4);
});

test("injected cycle04 succeeds once with safe priorities, comparisons, and prior preservation", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-analyzer-cycle04-")), outputDirectory = path.join(parent, analyzer.LIVE_OUTPUT_BASENAME_04), priorBefore = analyzer.snapshotPinnedPrior(), inventoryEntries = [{ url: "https://cycle04.secret.invalid/private", marker: "cycle04-inventory-secret" }]; let inventoryReads = 0, collections = 0;
  try {
    const stdout = [], stderr = [], summary = await analyzer.runCli(["--live-once-04"], { dependencies: { productionAdapter04: () => analyzer.productionAdapter04({ approvedParent: parent, outputDirectory, readInventory: () => { inventoryReads += 1; return inventoryEntries; }, transport: async () => { throw new Error("fixture-transport-must-not-run"); }, collect: async (options) => { collections += 1; assert.equal(options.inventoryEntries, inventoryEntries); assert.equal(options.traces, false); return prefilterCycle04Collection(); } }) }, stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value), setExitCode: () => assert.fail("unexpected exit") });
    assert.equal(inventoryReads, 1); assert.equal(collections, 1); assert.equal(summary.ok, true); assert.equal(summary.mode, "live-once-04"); assert.equal(summary.artifact, analyzer.LIVE_OUTPUT_BASENAME_04); assert.equal(summary.scorerVersion, "v2"); assert.equal(summary.prefilterVersion, "v3"); assert.ok(summary.maxClassScore >= 4); assert.ok(summary.strongPrecursorCount >= 1); assert.equal(summary.postvalidated, true); assert.equal(summary.signing, false); assert.equal(summary.broadcast, false); assert.equal(summary.fork, false); assert.equal(stderr.length, 0);
    const state = analyzer.validateDirectory(outputDirectory); for (const [cycle, prior] of [["cycle01", priorBefore.cycle01], ["cycle02", priorBefore.cycle02], ["cycle03", priorBefore.cycle03]]) { const expected = analyzer.compareCycles(prior, state); assert.deepEqual({ overlapCount: summary[`${cycle}OverlapCount`], newHashCount: summary[`${cycle}NewHashCount`], oldOnlyCount: summary[`${cycle}OldOnlyCount`], finalizedBlockDelta: summary[`${cycle}FinalizedBlockDelta`] }, expected); }
    assert.equal(analyzer.validateCycle04State(state), true); analyzer.assertPinnedPrior(priorBefore, analyzer.snapshotPinnedPrior()); const serialized = `${fs.readFileSync(path.join(outputDirectory, "state.json"), "utf8")}${fs.readFileSync(path.join(outputDirectory, "manifest.json"), "utf8")}${stdout.join("")}`; assert.equal(serialized.includes("cycle04.secret.invalid"), false); assert.equal(serialized.includes("cycle04-inventory-secret"), false); assert.equal(/(?:https?|wss?):\/\//i.test(serialized), false); assert.equal(serialized.includes("\"disposition\":\"WATCH\""), false); assert.equal(serialized.includes("\"mismatch\""), false); assert.equal(serialized.includes("protocolLoss"), false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("cycle04 preexisting output rejects before inventory and preserves every prior artifact", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-analyzer-cycle04-existing-")), outputDirectory = path.join(parent, analyzer.LIVE_OUTPUT_BASENAME_04), priorBefore = analyzer.snapshotPinnedPrior(); let inventoryReads = 0;
  try { fs.mkdirSync(outputDirectory); fs.writeFileSync(path.join(outputDirectory, "sentinel"), "foreign"); await assert.rejects(() => analyzer.productionAdapter04({ approvedParent: parent, outputDirectory, readInventory: () => { inventoryReads += 1; return []; } }), /ROLLING_ANALYZER_OUTPUT_EXISTS/); assert.equal(inventoryReads, 0); assert.equal(fs.readFileSync(path.join(outputDirectory, "sentinel"), "utf8"), "foreign"); analyzer.assertPinnedPrior(priorBefore, analyzer.snapshotPinnedPrior()); }
  finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("cycle04 capture failure creates no output and preserves every prior artifact", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-analyzer-cycle04-failure-")), outputDirectory = path.join(parent, analyzer.LIVE_OUTPUT_BASENAME_04), priorBefore = analyzer.snapshotPinnedPrior();
  try { await assert.rejects(() => analyzer.productionAdapter04({ approvedParent: parent, outputDirectory, readInventory: () => [], transport: async () => {}, collect: async () => { throw new Error("fixture-cycle04-failure"); } }), /ROLLING_ANALYZER_CAPTURE_FAILED/); assert.equal(fs.existsSync(outputDirectory), false); analyzer.assertPinnedPrior(priorBefore, analyzer.snapshotPinnedPrior()); }
  finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
