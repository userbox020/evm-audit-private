"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { snapshotCanaryReadonlyTriplet: snapshot } = require("../lib/canary-readonly-triplet.js");
const { loadPinnedDivergenceUniverse } = require("../lib/pinned-divergence-universe.js");

const NOW = Date.parse("2026-09-26T12:00:01.000Z");
const AT = "2026-09-26T12:00:00.000Z";
const RUN = "2026-09-26T12-00-00-000Z";
const schema = {
  dedicated: ["exploit-rearm-canary/v1", "exploit-rearm-canary-history/v1"],
  multichain: ["exploit-rearm-canary-multichain/v1", "exploit-rearm-canary-multichain-history/v1"],
  divergence: ["oracle-divergence-monitor/v1", "oracle-divergence-monitor-history/v1"],
};
const surfaces = Object.keys(schema);
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-triplet-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const baselinePath = path.join(dir, "coverage-r3.json");
  const records = [
    { source: "dedicated", chainId: 1, id: "alpha", schema: schema.dedicated[0] },
    { source: "dedicated", chainId: 1, id: "beta", schema: schema.dedicated[0] },
    { source: "multichain", chainId: 8453, id: "gamma", schema: schema.multichain[0] },
    { source: "divergence", chainId: 42161, id: "delta", schema: schema.divergence[0] },
  ];
  write(baselinePath, { schema: "all-sentinels-coverage/v1", records });
  const sources = {};
  for (const surface of surfaces) {
    const subdir = path.join(dir, surface);
    fs.mkdirSync(subdir);
    sources[surface] = { statusPath: path.join(subdir, "status.json"), historyPath: path.join(subdir, "history.json") };
    const sentinels = records.filter((r) => r.source === surface).map((r) => ({
      sentinel: r.id, ...(surface === "dedicated" ? {} : { chainId: r.chainId }), ok: true, fired: false,
    }));
    write(sources[surface].statusPath, { schema: schema[surface][0], runId: RUN, generatedAt: AT,
      ...(surface === "dedicated" ? { chainId: 1 } : {}), sentinels,
      verdict: "DORMANT", firedCount: 0, firedSentinels: [] });
    write(sources[surface].historyPath, { schema: schema[surface][1], runs: [
      { runId: RUN, at: AT, verdict: "DORMANT", fired: [] },
    ] });
  }
  const input = { baselinePath, sources, nowMs: NOW, maxAgeMs: 30000 };
  const edit = (surface, which, fn) => {
    const file = sources[surface][which];
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    fn(data);
    write(file, data);
  };
  return { input, sources, baselinePath, edit };
}

function safe(verdict) {
  assert.equal(verdict.routeProven, false);
  assert.equal(verdict.profitProven, false);
  assert.equal(verdict.dispatchAllowed, false);
  assert.equal(verdict.monitoringOnly, true);
  assert.equal(verdict.validatorBoundary, "MINIMAL_SHAPE_JOIN_ONLY");
  assert.equal(JSON.stringify(verdict).includes("profitable"), false);
}

test("separate-directory exact baseline join, byte hashes, no proof or dispatch", (t) => {
  const { input, sources, baselinePath } = fixture(t);
  const verdict = snapshot(input);
  assert.equal(verdict.trackedBaselineCount, 4);
  assert.deepEqual(verdict.sourceRowCounts, { dedicated: 2, multichain: 1, divergence: 1 });
  assert.equal(verdict.coverageComplete, true);
  assert.deepEqual(verdict.surfaces.dedicated, { ok: true, fired: false, incomplete: false, missingIds: [], newIds: [] });
  assert.equal(verdict.hashes.baseline, crypto.createHash("sha256").update(fs.readFileSync(baselinePath)).digest("hex"));
  assert.equal(verdict.hashes.divergence.status, crypto.createHash("sha256")
    .update(fs.readFileSync(sources.divergence.statusPath)).digest("hex"));
  safe(verdict);
});

test("FIRED with incomplete rows is not complete coverage or authorization", (t) => {
  const { input, edit } = fixture(t);
  edit("dedicated", "statusPath", (s) => {
    s.sentinels[0].fired = true;
    s.sentinels[1].ok = false;
    s.firedCount = 1;
    s.firedSentinels = ["alpha"];
    s.verdict = "FIRED";
  });
  edit("dedicated", "historyPath", (h) => { h.runs[0].fired = ["alpha"]; h.runs[0].verdict = "FIRED"; });
  const verdict = snapshot(input);
  assert.equal(verdict.surfaces.dedicated.incomplete, true);
  assert.equal(verdict.surfaces.dedicated.fired, false);
  assert.equal(verdict.coverageComplete, false);
  safe(verdict);
});

test("complete FIRED is monitoring evidence only", (t) => {
  const { input, edit } = fixture(t);
  edit("divergence", "statusPath", (s) => {
    s.sentinels[0].fired = true; s.firedCount = 1; s.firedSentinels = ["delta"]; s.verdict = "FIRED";
  });
  edit("divergence", "historyPath", (h) => { h.runs[0].fired = ["delta"]; h.runs[0].verdict = "FIRED"; });
  const verdict = snapshot(input);
  assert.equal(verdict.coverageComplete, true);
  assert.equal(verdict.surfaces.divergence.fired, true);
  safe(verdict);
});

test("stale, unchanged and partial status-history generations fail closed", (t) => {
  const { input, edit } = fixture(t);
  assert.throws(() => snapshot({ ...input, nowMs: NOW + 30001 }), { code: "RUN_STALE_OR_INVALID" });
  assert.throws(() => snapshot({ ...input, priorGeneration: Object.fromEntries(surfaces.map((s) => [s, RUN])) }),
    { code: "RUN_UNCHANGED" });
  edit("multichain", "historyPath", (h) => { h.runs[0].runId = "2026-09-26T11-59-00-000Z"; });
  assert.throws(() => snapshot(input), { code: "HISTORY_LATEST_MISMATCH" });
  edit("multichain", "historyPath", (h) => { h.runs = []; });
  assert.throws(() => snapshot(input), { code: "SOURCE_SCHEMA_OR_BOUNDS_INVALID" });
});

test("duplicate rows and baseline identities reject; missing/new are explicit", (t) => {
  const { input, edit, baselinePath } = fixture(t);
  edit("dedicated", "statusPath", (s) => { s.sentinels.push({ ...s.sentinels[0] }); });
  assert.throws(() => snapshot(input), { code: "SOURCE_DUPLICATE_ID" });
  edit("dedicated", "statusPath", (s) => { s.sentinels = [{ sentinel: "other", ok: true, fired: false }]; });
  const verdict = snapshot(input);
  assert.deepEqual(verdict.surfaces.dedicated.missingIds, [["dedicated", 1, "alpha"], ["dedicated", 1, "beta"]]);
  assert.deepEqual(verdict.surfaces.dedicated.newIds, [["dedicated", 1, "other"]]);
  assert.equal(verdict.coverageComplete, false);
  safe(verdict);
  const b = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  b.records.push({ ...b.records[0] });
  write(baselinePath, b);
  assert.throws(() => snapshot(input), { code: "BASELINE_DUPLICATE_ID" });
});

test("malformed schema, invalid JSON, symlinks, nonregular and oversized files reject", (t) => {
  const { input, sources, edit } = fixture(t);
  edit("divergence", "historyPath", (h) => { h.schema = "wrong"; });
  assert.throws(() => snapshot(input), { code: "SOURCE_SCHEMA_OR_BOUNDS_INVALID" });
  fs.writeFileSync(sources.divergence.historyPath, "{");
  assert.throws(() => snapshot(input), { code: "JSON_INVALID" });
  fs.rmSync(sources.divergence.historyPath);
  try {
    fs.symlinkSync(sources.dedicated.historyPath, sources.divergence.historyPath);
    assert.throws(() => snapshot(input), { code: "SYMLINK_INPUT" });
    fs.rmSync(sources.divergence.historyPath);
  } catch (error) {
    if (error.code !== "EPERM") throw error; // Windows may disallow creating symlinks without developer mode.
  }
  fs.mkdirSync(sources.divergence.historyPath);
  assert.throws(() => snapshot(input), { code: "FILE_INVALID_OR_OVERSIZE" });
  fs.rmSync(sources.divergence.historyPath, { recursive: true });
  const fd = fs.openSync(sources.divergence.historyPath, "w");
  fs.ftruncateSync(fd, 32 * 1024 * 1024 + 1);
  fs.closeSync(fd);
  assert.throws(() => snapshot(input), { code: "FILE_INVALID_OR_OVERSIZE" });
});

test("bounded row/history counts, directory separation, and option bounds", (t) => {
  const { input, edit } = fixture(t);
  assert.throws(() => snapshot({ ...input, sources: { ...input.sources,
    divergence: { ...input.sources.divergence, statusPath: input.sources.dedicated.statusPath,
      historyPath: input.sources.dedicated.historyPath } } }), { code: "SOURCES_NOT_SEPARATE" });
  assert.throws(() => snapshot({ ...input, maxAgeMs: Number.MAX_SAFE_INTEGER }), { code: "OPTIONS_INVALID" });
  edit("dedicated", "historyPath", (h) => { h.runs = Array.from({ length: 51 }, () => h.runs[0]); });
  assert.throws(() => snapshot(input), { code: "SOURCE_SCHEMA_OR_BOUNDS_INVALID" });
  edit("dedicated", "historyPath", (h) => { h.runs = [h.runs[0]]; });
  edit("dedicated", "statusPath", (s) => { s.sentinels = Array.from({ length: 10001 }, () => s.sentinels[0]); });
  assert.throws(() => snapshot(input), { code: "SOURCE_SCHEMA_OR_BOUNDS_INVALID" });
});

function pinnedFixture(t) {
  const f = fixture(t);
  const pinned = { sha256: "a".repeat(64), sourceConstantSha256: "b".repeat(64),
    rows: [{ id: "delta", sentinel: "delta", chainId: 42161,
    oracle: `0x12345678${"a".repeat(32)}`, marketId: `0x${"b".repeat(64)}`,
    pair: "TOKEN/USDC", kind: "api-market", provenanceConstant: false,
    collateralToken: `0x${"c".repeat(40)}`,
    loanToken: `0x${"d".repeat(40)}` }] };
  f.edit("divergence", "statusPath", (status) => {
    status.pinnedUniverseSha256 = pinned.sha256;
    status.sourceConstantSha256 = pinned.sourceConstantSha256;
    status.verdict = "INCOMPLETE";
    Object.assign(status.sentinels[0], { ...pinned.rows[0], ok: false, actionable: false, referenceOk: false,
      sustained: false, consecutiveOver: 0, divergenceBps: null,
      measurements: { marketBound: false, marketStateReadable: false } });
  });
  f.edit("divergence", "historyPath", (history) => {
    history.runs[0].pinnedUniverseSha256 = pinned.sha256;
    history.runs[0].sourceConstantSha256 = pinned.sourceConstantSha256;
    history.runs[0].verdict = "INCOMPLETE";
  });
  return { ...f, pinned, input: { ...f.input, pinnedDivergenceUniverse: pinned } };
}

test("pinned join binds the complete oracle, market, pair and kind, not a short-prefix ID", (t) => {
  const f = pinnedFixture(t);
  const good = snapshot(f.input);
  assert.equal(good.validatorBoundary, "PINNED_DIVERGENCE_JOIN_ONLY");
  assert.equal(good.routeProven, false);
  for (const [field, next] of [["oracle", `0x12345678${"e".repeat(32)}`],
    ["marketId", `0x${"f".repeat(64)}`], ["pair", "DIFFERENT/USDC"], ["kind", "constant-oracle"]]) {
    f.edit("divergence", "statusPath", (status) => { status.sentinels[0][field] = next; });
    assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_TUPLE_MISMATCH" });
    f.edit("divergence", "statusPath", (status) => { status.sentinels[0][field] = f.pinned.rows[0][field]; });
  }
  assert.equal(snapshot(f.input).validatorBoundary, "PINNED_DIVERGENCE_JOIN_ONLY");
});

test("pinned status/history digest drift and missing or colliding identity reject", (t) => {
  const f = pinnedFixture(t);
  f.edit("divergence", "statusPath", (status) => { status.pinnedUniverseSha256 = "0".repeat(64); });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_DIGEST_MISMATCH" });
  f.edit("divergence", "statusPath", (status) => { status.pinnedUniverseSha256 = f.pinned.sha256; });
  f.edit("divergence", "historyPath", (history) => { history.runs[0].pinnedUniverseSha256 = "0".repeat(64); });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_DIGEST_MISMATCH" });
  f.edit("divergence", "historyPath", (history) => { history.runs[0].pinnedUniverseSha256 = f.pinned.sha256; });
  f.edit("divergence", "statusPath", (status) => { status.sourceConstantSha256 = "0".repeat(64); });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_DIGEST_MISMATCH" });
  f.edit("divergence", "statusPath", (status) => { status.sourceConstantSha256 = f.pinned.sourceConstantSha256; });
  f.edit("divergence", "historyPath", (history) => { history.runs[0].sourceConstantSha256 = "0".repeat(64); });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_DIGEST_MISMATCH" });
  f.edit("divergence", "historyPath", (history) => {
    history.runs[0].sourceConstantSha256 = f.pinned.sourceConstantSha256;
  });
  f.pinned.rows.push({ ...f.pinned.rows[0] });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_INVALID" });
  f.pinned.rows.pop();
  const baseline = JSON.parse(fs.readFileSync(f.baselinePath, "utf8"));
  baseline.records.push({ ...baseline.records.at(-1), id: "epsilon" });
  write(f.baselinePath, baseline);
  f.pinned.rows.push({ ...f.pinned.rows[0], id: "epsilon", sentinel: "epsilon",
    oracle: `0x87654321${"e".repeat(32)}` });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_IDS_INVALID" });
  f.pinned.rows[1].sentinel = "delta";
  f.pinned.rows[1].id = "delta";
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_IDS_INVALID" });
});

test("pinned actionable is forbidden; valid sustained FIRED remains monitoring-only", (t) => {
  const f = pinnedFixture(t);
  f.edit("divergence", "statusPath", (s) => {
    Object.assign(s.sentinels[0], { ok: true, fired: true, actionable: true, sustained: true,
      consecutiveOver: 2, divergenceBps: 600, thresholdBps: 500 });
    s.firedCount = 1; s.firedSentinels = ["delta"]; s.verdict = "FIRED";
  });
  f.edit("divergence", "historyPath", (h) => { h.runs[0].fired = ["delta"]; h.runs[0].verdict = "FIRED"; });
  f.edit("divergence", "statusPath", (s) => {
    Object.assign(s.sentinels[0], { referenceOk: true, referenceSource: "independent", oracleRatio: 1.06,
      referenceRatio: 1, measurements: { marketBound: true, marketStateReadable: true,
        collateralDecimals: 18, loanDecimals: 6,
        collateralToken: f.pinned.rows[0].collateralToken,
        loanToken: f.pinned.rows[0].loanToken } });
  });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_ACTIONABLE_FORBIDDEN" });
  f.edit("divergence", "statusPath", (s) => { s.sentinels[0].actionable = false; });
  const observed = snapshot(f.input);
  assert.equal(observed.surfaces.divergence.fired, true);
  assert.equal(observed.dispatchAllowed, false);
  assert.equal(observed.routeProven, false);
  f.edit("divergence", "statusPath", (s) => { s.sentinels[0].measurements.loanToken = `0x${"e".repeat(40)}`; });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_BINDING_INVALID" });
});

test("pinned ok:true dormant row needs live market, reference, decimals and pinned token binding", (t) => {
  const f = pinnedFixture(t);
  f.edit("divergence", "statusPath", (s) => { s.sentinels[0].ok = true; s.verdict = "DORMANT"; });
  f.edit("divergence", "historyPath", (h) => { h.runs[0].verdict = "DORMANT"; });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_BINDING_INVALID" });
  f.edit("divergence", "statusPath", (s) => {
    Object.assign(s.sentinels[0], { referenceOk: true, referenceSource: "independent", oracleRatio: 1,
      referenceRatio: 1, measurements: { marketBound: true, marketStateReadable: true,
        collateralDecimals: 18, loanDecimals: 6, collateralToken: f.pinned.rows[0].collateralToken,
        loanToken: f.pinned.rows[0].loanToken } });
  });
  assert.equal(snapshot(f.input).surfaces.divergence.ok, true);
  for (const [field, value] of [["marketBound", false], ["marketStateReadable", false],
    ["collateralDecimals", undefined], ["collateralDecimals", -1], ["loanDecimals", 37],
    ["loanDecimals", "6"], ["collateralToken", `0x${"e".repeat(40)}`]]) {
    const original = JSON.parse(fs.readFileSync(f.sources.divergence.statusPath, "utf8")).sentinels[0].measurements[field];
    f.edit("divergence", "statusPath", (s) => { s.sentinels[0].measurements[field] = value; });
    assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_BINDING_INVALID" });
    f.edit("divergence", "statusPath", (s) => { s.sentinels[0].measurements[field] = original; });
  }
  f.edit("divergence", "statusPath", (s) => { s.sentinels[0].referenceOk = false; });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_BINDING_INVALID" });
  f.edit("divergence", "statusPath", (s) => { s.sentinels[0].ok = false; s.verdict = "INCOMPLETE"; });
  f.edit("divergence", "historyPath", (h) => { h.runs[0].verdict = "INCOMPLETE"; });
  assert.equal(snapshot(f.input).surfaces.divergence.incomplete, true);
});

test("pinned incomplete rows cannot claim actionable or fired", (t) => {
  const f = pinnedFixture(t);
  assert.equal(snapshot(f.input).surfaces.divergence.incomplete, true);
  f.edit("divergence", "statusPath", (s) => { s.sentinels[0].actionable = true; });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_ACTIONABLE_FORBIDDEN" });
  f.edit("divergence", "statusPath", (s) => {
    s.sentinels[0].actionable = false; s.sentinels[0].fired = true;
    s.firedCount = 1; s.firedSentinels = ["delta"]; s.verdict = "FIRED";
  });
  f.edit("divergence", "historyPath", (h) => { h.runs[0].fired = ["delta"]; h.runs[0].verdict = "FIRED"; });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_STRUCTURAL_INVALID" });
});

function w9Fixture(t) {
  const f = pinnedFixture(t);
  f.pinned.rows[0].kind = "constant-oracle";
  f.pinned.rows[0].provenanceConstant = true;
  const row = f.pinned.rows[0];
  const key = `${row.chainId}:${row.oracle.toLowerCase()}:${row.marketId.toLowerCase()}`;
  f.edit("divergence", "statusPath", (s) => {
    s.verdict = "DORMANT";
    Object.assign(s.sentinels[0], { kind: row.kind, ok: true, referenceOk: false, structuralVerified: true,
      structuralCandidate: false, borrowsPositive: true, borrowRaw: "20", availableRaw: "0",
      measurements: { marketBound: true, marketStateReadable: true, collateralDecimals: 18,
        loanDecimals: 6, collateralToken: row.collateralToken, loanToken: row.loanToken,
        oraclePrice: "1000000000000000000" } });
  });
  f.edit("divergence", "historyPath", (h) => {
    h.runs[0].verdict = "DORMANT";
  });
  return { ...f, key };
}

test("W9 verified no-reference ZERO and first positive candidate are observational only", (t) => {
  const f = w9Fixture(t);
  assert.equal(snapshot(f.input).surfaces.divergence.ok, true);
  f.edit("divergence", "statusPath", (s) => {
    Object.assign(s.sentinels[0], { availableRaw: "1", structuralCandidate: true });
  });
  const verdict = snapshot(f.input);
  assert.equal(verdict.surfaces.divergence.fired, false);
  assert.equal(verdict.surfaces.divergence.ok, true);
  assert.equal(verdict.validatorBoundary, "PINNED_DIVERGENCE_JOIN_ONLY");
  assert.equal(verdict.routeProven, false);
  assert.equal(verdict.dispatchAllowed, false);
});

test("forged prior structuralZero never authorizes structural-only FIRED", (t) => {
  const f = w9Fixture(t);
  f.edit("divergence", "statusPath", (s) => {
    Object.assign(s.sentinels[0], { availableRaw: "1", structuralCandidate: true,
      signalType: "SOURCE_CONSTANT_LIQUIDITY_EDGE", fired: true });
    s.firedCount = 1; s.firedSentinels = ["delta"]; s.verdict = "FIRED";
  });
  f.edit("divergence", "historyPath", (h) => {
    h.runs.unshift({ runId: "2026-09-26T11-59-00-000Z", at: "2026-09-26T11:59:00.000Z",
      pinnedUniverseSha256: f.pinned.sha256, sourceConstantSha256: f.pinned.sourceConstantSha256,
      verdict: "INCOMPLETE", fired: [], chains: { "42161": 100 }, structuralZero: { [f.key]: true } });
    h.runs[1].fired = ["delta"]; h.runs[1].verdict = "FIRED";
  });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_STRUCTURAL_INVALID" });
  f.edit("divergence", "statusPath", (s) => { delete s.sentinels[0].signalType; });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_STRUCTURAL_INVALID" });
});

test("W9 first positive cannot FIRE, forged candidate and no-reference streak reject", (t) => {
  const f = w9Fixture(t);
  f.edit("divergence", "statusPath", (s) => {
    s.sentinels[0].availableRaw = "2"; s.sentinels[0].structuralCandidate = true;
  });
  assert.equal(snapshot(f.input).surfaces.divergence.ok, true);
  f.edit("divergence", "statusPath", (s) => { s.sentinels[0].signalType = "SOURCE_CONSTANT_LIQUIDITY_EDGE"; });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_STRUCTURAL_INVALID" });
  f.edit("divergence", "statusPath", (s) => { delete s.sentinels[0].signalType; });
  f.edit("divergence", "statusPath", (s) => { s.sentinels[0].structuralCandidate = false; });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_STRUCTURAL_INVALID" });
  f.edit("divergence", "statusPath", (s) => {
    s.sentinels[0].structuralCandidate = true; s.sentinels[0].fired = true;
    s.firedCount = 1; s.firedSentinels = ["delta"]; s.verdict = "FIRED";
  });
  f.edit("divergence", "historyPath", (h) => { h.runs[0].fired = ["delta"]; h.runs[0].verdict = "FIRED"; });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_STRUCTURAL_INVALID" });
  f.edit("divergence", "statusPath", (s) => {
    s.sentinels[0].fired = false; s.sentinels[0].sustained = true;
    s.sentinels[0].consecutiveOver = 2; s.sentinels[0].divergenceBps = 501;
    s.firedCount = 0; s.firedSentinels = []; s.verdict = "DORMANT";
  });
  f.edit("divergence", "historyPath", (h) => { h.runs[0].fired = []; h.runs[0].verdict = "DORMANT"; });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_STRUCTURAL_INVALID" });
  f.edit("divergence", "statusPath", (s) => {
    s.sentinels[0].sustained = false; s.sentinels[0].consecutiveOver = 0;
    s.sentinels[0].divergenceBps = null;
  });
  f.edit("divergence", "statusPath", (s) => { s.sentinels[0].consecutiveOver = 1; });
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_STRUCTURAL_INVALID" });
  f.edit("divergence", "statusPath", (s) => { s.sentinels[0].consecutiveOver = 0; });
  f.pinned.rows[0].provenanceConstant = false;
  assert.throws(() => snapshot(f.input), { code: "PINNED_UNIVERSE_STRUCTURAL_INVALID" });
});

test("real pinned source loads 351 full identities and joins isolated 421-row fixtures offline", (t) => {
  const pinned = loadPinnedDivergenceUniverse();
  assert.equal(pinned.sha256, "ed62283d99d674f61d445c49a3cda4bfb021cb7fb684b900299cd7d738bf549a");
  assert.equal(pinned.rows.length, 351);
  const baselinePath = path.resolve(__dirname, "..", "..", "reports", "raw", "fast",
    "all-sentinels-coverage-20260926", "coverage-r3.json");
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canary-triplet-421-offline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = {};
  for (const surface of surfaces) {
    const dir = path.join(root, surface);
    fs.mkdirSync(dir);
    sources[surface] = { statusPath: path.join(dir, "status.json"), historyPath: path.join(dir, "history.json") };
    const records = baseline.records.filter((record) => record.source === surface);
    const sentinels = surface === "divergence" ? pinned.rows.map((row) => ({
      sentinel: row.sentinel, chainId: row.chainId, oracle: row.oracle, marketId: row.marketId,
      pair: row.pair, kind: row.kind, provenanceConstant: row.provenanceConstant,
      ok: false, fired: false, actionable: false, sustained: false,
      consecutiveOver: 0, divergenceBps: null,
    })) : records.map((record) => ({ sentinel: record.id,
      ...(surface === "dedicated" ? {} : { chainId: record.chainId }), ok: false, fired: false }));
    write(sources[surface].statusPath, { schema: schema[surface][0], runId: RUN, generatedAt: AT,
      ...(surface === "dedicated" ? { chainId: 1 } : {}), sentinels,
      ...(surface === "divergence" ? { pinnedUniverseSha256: pinned.sha256,
        sourceConstantSha256: pinned.sourceConstantSha256 } : {}),
      firedCount: 0, firedSentinels: [], verdict: "INCOMPLETE" });
    write(sources[surface].historyPath, { schema: schema[surface][1], runs: [{ runId: RUN,
      at: AT, verdict: "INCOMPLETE", fired: [],
      ...(surface === "divergence" ? { pinnedUniverseSha256: pinned.sha256,
        sourceConstantSha256: pinned.sourceConstantSha256 } : {}) }] });
  }
  const verdict = snapshot({ baselinePath, sources, pinnedDivergenceUniverse: pinned, nowMs: NOW });
  assert.deepEqual(verdict.sourceRowCounts, { dedicated: 3, multichain: 67, divergence: 351 });
  assert.equal(verdict.trackedBaselineCount, 421);
  assert.equal(verdict.validatorBoundary, "PINNED_DIVERGENCE_JOIN_ONLY");
  assert.equal(verdict.dispatchAllowed, false);
});

test("fresh loader read rejects changed original source bytes in a copied offline fixture", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canary-pinned-bytes-offline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.resolve(__dirname, "..", "..");
  for (const relative of ["reports/raw/fast/all-sentinels-coverage-20260926/coverage-r3.json",
    "reports/raw/fast/exploit-rearm-canary/status-divergence.json",
    "reports/raw/fast/w9-strike-routes-20260922/drain-route-spec.json"]) {
    const destination = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(workspace, ...relative.split("/")), destination);
  }
  const testPins = { baseline: "9bd9ddb6a622c3dbfdea0f90e5491374f2473888b1e1d24ef3180d0bf1b9886a",
    source: "ed62283d99d674f61d445c49a3cda4bfb021cb7fb684b900299cd7d738bf549a",
    sourceConstant: "d8e47e5034747b901007f6d47c5a07b431fb99a8fb2f73af70466575aa6fa5bd" };
  assert.equal(loadPinnedDivergenceUniverse({ root, testPins }).rows.length, 351);
  fs.appendFileSync(path.join(root, "reports", "raw", "fast", "exploit-rearm-canary",
    "status-divergence.json"), " ");
  assert.throws(() => loadPinnedDivergenceUniverse({ root, testPins }), { code: "PINNED_HASH_MISMATCH" });
  fs.copyFileSync(path.join(workspace, "reports", "raw", "fast", "exploit-rearm-canary",
    "status-divergence.json"), path.join(root, "reports", "raw", "fast", "exploit-rearm-canary",
    "status-divergence.json"));
  fs.appendFileSync(path.join(root, "reports", "raw", "fast", "w9-strike-routes-20260922",
    "drain-route-spec.json"), " ");
  assert.throws(() => loadPinnedDivergenceUniverse({ root, testPins }), { code: "PINNED_HASH_MISMATCH" });
});
