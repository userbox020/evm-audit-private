#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const audit = require("./audit-trigger-coverage-universe.js");
const builder = require("./build-trigger-coverage-delta-binders.js");
const refreshRunner = require("./refresh-trigger-coverage-delta-binders.js");

const WORKSPACE = builder.WORKSPACE;
const CONFIG_PATH = builder.CONFIG_PATH;
const SENTINEL_REL = "reports/monitor/official-deployed-delta-sentinel.json";
const EXCLUDED_REPO = "Instadapp/fluid-contracts-public";

function realConfig() { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
function realUniverse() { return JSON.parse(fs.readFileSync(audit.UNIVERSE_PATH, "utf8")); }
function realSentinel() { return JSON.parse(fs.readFileSync(path.join(WORKSPACE, SENTINEL_REL), "utf8")); }

function tempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tc-delta-binders-"));
  fs.mkdirSync(path.join(root, "reports", "monitor"), { recursive: true });
  return root;
}

function writeSentinel(workspace, sentinel) {
  fs.writeFileSync(path.join(workspace, SENTINEL_REL), `${JSON.stringify(sentinel, null, 2)}\n`, "utf8");
}

function universeRow(universe, id) {
  const row = universe.rows.find((entry) => entry.id === id);
  assert.ok(row, `missing row ${id}`);
  return row;
}

test("canonical sentinel drives thirteen COVERED and one COVERED-blocked D binders with sentinel observation time", () => {
  const workspace = tempWorkspace();
  const sentinel = realSentinel();
  // Normalize any transient in-scope poll failure so the happy-path assertions are deterministic;
  // the explicit-exclusion and fail-closed behavior is covered by the dedicated tests below.
  for (const entry of sentinel.repositories) {
    if (entry.id !== EXCLUDED_REPO && !["unchanged", "candidate-change"].includes(entry.pollStatus)) entry.pollStatus = "unchanged";
  }
  writeSentinel(workspace, sentinel);
  const universe = realUniverse();
  const observedAt = new Date(Date.parse(sentinel.generatedAt)).toISOString();
  const expectedCandidateChanges = sentinel.repositories
    .filter((entry) => entry.id !== EXCLUDED_REPO && entry.pollStatus === "candidate-change")
    .map((entry) => entry.id).sort();
  const result = builder.buildBinders({ workspace, universe, apply: true });

  assert.equal(result.binders.length, 14);
  // Thirteen DELTA_ONLY rows are enabled (ethereum-aave-v4-d was enabled by the A1
  // registry-bound repoint); base-aave-v4-d remains BLOCKED by construction.
  assert.equal(result.covered, 13);
  assert.equal(result.blocked, 1);
  assert.equal(result.written.length, 14);
  assert.equal(result.assessment.observedAt, observedAt);
  assert.equal(result.assessment.attempted, 16);
  assert.equal(result.assessment.failed.length, 0);
  // Honest current sentinel state: top-level status is passed through unchanged (the
  // token fix removed rate-limiting), and the only exclusion is the declared unpolled
  // repository Instadapp/fluid-contracts-public.
  assert.equal(result.assessment.status, sentinel.status);
  assert.equal(result.assessment.excluded.length, 1);
  assert.equal(result.assessment.excluded[0].id, EXCLUDED_REPO);
  assert.deepEqual(result.assessment.candidateChanges, expectedCandidateChanges);

  for (const binder of result.binders) {
    assert.equal(binder.value.observedAt, observedAt, "observedAt must be the sentinel time");
    assert.equal(binder.value.chainId, universeRow(universe, binder.id).chainId);
    assert.equal(binder.value.family, universeRow(universe, binder.id).family);
    assert.equal(binder.value.triggerClass, "D");
    assert.ok(binder.value.enumeration.kind === "DELTA_SENTINEL" || binder.value.enumeration.kind === "BLOCKED_REGISTRY");
  }

  const nowMs = Date.parse(sentinel.generatedAt) + 1_000;
  for (const binder of result.binders) {
    const row = universeRow(universe, binder.id);
    const assessed = audit.auditRow({ ...row, artifactPath: binder.artifactPath }, { workspace, nowMs });
    if (binder.value.coverage.complete) {
      assert.equal(assessed.status, "COVERED", `${binder.id} should audit COVERED`);
      assert.deepEqual(assessed.blockers, []);
    } else {
      assert.equal(assessed.status, "BLOCKED", `${binder.id} should audit BLOCKED`);
      assert.ok(assessed.blockers.length > 0);
    }
  }

  const excludedEvidence = result.binders[0].value.evidence.find((line) => line.includes(EXCLUDED_REPO));
  assert.ok(excludedEvidence && /transport failure/.test(excludedEvidence), "exclusion reason must be surfaced");
  assert.equal(JSON.stringify(result.binders).includes("0x0000"), false);
});

test("wiring check confirms the universe points every D row at its binder and matches dispatch intent", () => {
  const universe = realUniverse();
  assert.deepEqual(builder.checkUniverseWiring(universe, realConfig()), []);
  const enabled = universe.rows.filter((row) => row.triggerClass === "D" && row.onFire.enabled).map((row) => row.id).sort();
  assert.equal(enabled.length, 13);
  assert.equal(enabled.includes("base-aave-v4-d"), false);
  assert.equal(enabled.includes("ethereum-aave-v4-d"), true);
  assert.ok(universe.rows.filter((row) => row.triggerClass === "D").every((row) => row.freshnessSeconds === 25200));
  assert.ok(universe.rows.filter((row) => row.triggerClass === "D").every((row) => row.artifactPath === `reports/monitor/trigger-coverage/${row.id}.json`));
});

test("fails closed when an in-scope sentinel repository has not completed", () => {
  const workspace = tempWorkspace();
  const sentinel = realSentinel();
  const victim = sentinel.repositories.find((entry) => entry.id === "silo-finance/silo-contracts-v3");
  victim.pollStatus = "incomplete";
  writeSentinel(workspace, sentinel);
  const result = builder.buildBinders({ workspace, universe: realUniverse(), apply: true });

  assert.equal(result.covered, 0);
  assert.equal(result.blocked, 14);
  assert.equal(result.assessment.failed.length, 1);
  for (const binder of result.binders) {
    assert.equal(binder.value.coverage.complete, false);
    assert.ok(binder.value.blockers.some((line) => line.includes("silo-finance/silo-contracts-v3")));
  }
});

test("explicit exclusion is required to scope around an unpolled repository", () => {
  const workspace = tempWorkspace();
  const sentinel = realSentinel();
  // Deterministic fixture: the excluded repository is unpolled, independent of the
  // live sentinel's transient poll state.
  sentinel.repositories.find((entry) => entry.id === EXCLUDED_REPO).pollStatus = "incomplete";
  writeSentinel(workspace, sentinel);
  const scoped = builder.buildBinders({ workspace, universe: realUniverse() });
  assert.equal(scoped.covered, 13);
  assert.equal(scoped.blocked, 1);

  const strictConfig = realConfig();
  strictConfig.sentinelScope.excludedRepositories = [];
  const strict = builder.buildBinders({ workspace, universe: realUniverse(), config: strictConfig });
  assert.equal(strict.covered, 0);
  assert.equal(strict.blocked, 14);
  assert.equal(strict.assessment.failed[0].id, EXCLUDED_REPO);
});

test("never stamps wall-clock observation time on a stale sentinel", () => {
  const workspace = tempWorkspace();
  const sentinel = realSentinel();
  sentinel.generatedAt = "2020-01-01T00:00:00.000Z";
  sentinel.runId = "fixture-old-run";
  for (const entry of sentinel.repositories) {
    if (entry.id !== EXCLUDED_REPO) entry.pollStatus = "unchanged";
  }
  writeSentinel(workspace, sentinel);
  const universe = realUniverse();
  const result = builder.buildBinders({ workspace, universe, apply: true });
  assert.equal(result.assessment.observedAt, "2020-01-01T00:00:00.000Z");
  for (const binder of result.binders) assert.equal(binder.value.observedAt, "2020-01-01T00:00:00.000Z");

  const nowMs = Date.parse("2026-09-20T07:02:16.276Z");
  for (const binder of result.binders.filter((entry) => entry.value.coverage.complete)) {
    const row = universeRow(universe, binder.id);
    const assessed = audit.auditRow({ ...row, artifactPath: binder.artifactPath }, { workspace, nowMs });
    assert.equal(assessed.status, "STALE", `${binder.id} must not be fresh from wall-clock time`);
  }
});

test("config validation is fail-closed on row-set and freshness drift", () => {
  const universe = realUniverse();
  const missingRow = realConfig();
  delete missingRow.rows["ethereum-morpho-blue-d"];
  assert.throws(() => builder.buildBinders({ workspace: WORKSPACE, universe, config: missingRow }), /CONFIG_ROW_SET_INVALID/);

  const badFreshness = realConfig();
  badFreshness.freshnessSeconds = 900;
  assert.throws(() => builder.buildBinders({ workspace: WORKSPACE, universe, config: badFreshness }), /UNIVERSE_FRESHNESS_MISMATCH/);

  const unknownRepo = realConfig();
  unknownRepo.sentinelScope.excludedRepositories = [{ id: "not/configured", reason: "fixture" }];
  const workspace = tempWorkspace();
  writeSentinel(workspace, realSentinel());
  assert.throws(() => builder.buildBinders({ workspace, universe, config: unknownRepo }), /EXCLUSION_NOT_CONFIGURED/);
});

test("sentinel validation rejects a non-canonical schema", () => {
  const workspace = tempWorkspace();
  const sentinel = realSentinel();
  sentinel.schema = "not-the-sentinel";
  writeSentinel(workspace, sentinel);
  assert.throws(() => builder.buildBinders({ workspace, universe: realUniverse() }), /SENTINEL_INVALID/);
});

test("refresh runner runs the sentinel then rebuilds binders with apply enabled", async () => {
  let captured = null;
  const result = await refreshRunner.refresh({
    workspace: WORKSPACE,
    runSentinel: async () => ({ status: "candidate-change" }),
    buildBinders: (options) => {
      captured = options;
      return { assessment: { observedAt: "2026-09-20T07:02:15.276Z" }, covered: 13, blocked: 1, written: ["a", "b"] };
    },
  });
  assert.equal(captured.apply, true);
  assert.equal(result.sentinelStatus, "candidate-change");
  assert.equal(result.covered, 13);
  assert.equal(result.written.length, 2);
});

test("refresh runner can rebuild from the on-disk sentinel without polling", async () => {
  let polled = false;
  const result = await refreshRunner.refresh({
    workspace: WORKSPACE,
    sentinel: false,
    runSentinel: async () => { polled = true; return { status: "unchanged" }; },
    buildBinders: () => ({ assessment: { observedAt: "2026-09-20T07:02:15.276Z" }, covered: 13, blocked: 1, written: [] }),
  });
  assert.equal(polled, false);
  assert.equal(result.sentinelStatus, "skipped");
});

test("CLI option parsing is strict", () => {
  assert.deepEqual(builder.parseOptions(["--check"]), { apply: false, check: true });
  assert.deepEqual(builder.parseOptions(["--apply"]), { apply: true, check: false });
  assert.throws(() => builder.parseOptions(["--check", "--apply"]), /usage/);
  assert.throws(() => builder.parseOptions(["--nope"]), /usage/);
  assert.deepEqual(refreshRunner.parseOptions(["--skip-sentinel"]), { sentinel: false });
  assert.throws(() => refreshRunner.parseOptions(["--nope"]), /usage/);
});
