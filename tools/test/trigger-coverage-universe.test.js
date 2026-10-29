"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  WORKSPACE,
  OUT_PATH,
  EVIDENCE_SCHEMA,
  sha256,
  sanitizeText,
  validateUniverse,
  auditRow,
  runAudit,
  parseOptions,
} = require("../audit-trigger-coverage-universe");
const { dataArtifacts } = require("../monitor-service-manifest");
const { healthyTriggerCoverageAudit, validateArtifactSemantics } = require("../autopilot-status");

const SOURCE_UNIVERSE = path.join(WORKSPACE, "tools", "trigger-coverage-universe.json");
const BASE = JSON.parse(fs.readFileSync(SOURCE_UNIVERSE, "utf8"));
const NOW = Date.parse("2026-09-19T12:00:00.000Z");

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function tempWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trigger-coverage-"));
  fs.mkdirSync(path.join(root, "tools"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function writeUniverse(root, universe = BASE) {
  const file = path.join(root, "tools", "trigger-coverage-universe.json");
  fs.writeFileSync(file, `${JSON.stringify(universe, null, 2)}\n`);
  return file;
}
function rowById(universe, id = "ethereum-morpho-blue-l") { return universe.rows.find((row) => row.id === id); }
function writeArtifact(root, relative, value) {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}
function coverageArtifact(row, overrides = {}) {
  const base = {
    schema: EVIDENCE_SCHEMA,
    observedAt: new Date(NOW).toISOString(),
    chainId: row.chainId,
    family: row.family,
    triggerClass: row.triggerClass,
    enumeration: { kind: row.enumerationKind, ref: row.enumerationRef, boundDeclared: true, successful: true },
    reads: { attempted: 3, succeeded: 3, failed: 0, unclassifiedFailures: 0 },
    classSemantics: { triggerClass: row.triggerClass, exact: true },
    coverage: { complete: true },
    onFire: { economics: true, keylessFixedPinFork: true, alert: true },
    dispatchEnabled: true,
    evidence: ["offline fixture evidence"],
    blockers: [],
  };
  return Object.assign(base, overrides);
}

test("authoritative universe has exact schema, keys, and 53 rows", () => {
  assert.equal(validateUniverse(BASE), true);
  assert.equal(BASE.rows.length, 53);
  assert.deepEqual(Object.keys(BASE).sort(), ["chains", "exclusions", "rows", "schema"]);
});

test("53-row matrix has exact family totals", () => {
  const counts = Object.fromEntries(BASE.rows.reduce((map, row) => map.set(row.family, (map.get(row.family) || 0) + 1), new Map()));
  assert.deepEqual(counts, { "Morpho Blue": 8, "Aave V3": 8, "Aave V4": 6, Curve: 6, "Uniswap V3": 4, "Balancer V2": 8, "Balancer V3": 8, Ammalgam: 1, Enhanced: 1, Basalt: 1, "Surge Credit": 1, Umbrae: 1 });
});

test("53-row matrix has exact class totals", () => {
  const counts = Object.fromEntries(BASE.rows.reduce((map, row) => map.set(row.triggerClass, (map.get(row.triggerClass) || 0) + 1), new Map()));
  assert.deepEqual(counts, { L: 8, O: 6, F: 8, D: 14, X: 10, R: 7 });
});

test("exclusions are exact and ordered", () => {
  assert.deepEqual(BASE.exclusions, ["victim/orderflow/sandwiching", "ordinary non-flawed liquidation", "feed manipulation", "reorg attacks", "live access bypass", "chains other than 1/8453 (Arbitrum 42161 registered as a dispatch-disabled blocked row only)", "non-atomic multi-day routes"]);
});

test("duplicate row IDs fail closed", () => {
  const value = clone(BASE);
  value.rows[1].id = value.rows[0].id;
  assert.throws(() => validateUniverse(value), /duplicate or invalid row id/);
});

test("unknown row dimensions fail closed", () => {
  const value = clone(BASE);
  value.rows[0].family = "Unknown";
  assert.throws(() => validateUniverse(value), /unknown row dimension/);
});

test("artifact path escape fails closed", () => {
  const value = clone(BASE);
  value.rows[0].artifactPath = "../outside.json";
  assert.throws(() => validateUniverse(value), /escapes workspace/);
});

test("universe hashing is byte deterministic", () => {
  const bytes = fs.readFileSync(SOURCE_UNIVERSE);
  assert.equal(sha256(bytes), sha256(Buffer.from(bytes)));
  assert.match(sha256(bytes), /^[0-9a-f]{64}$/);
});

test("fresh exact evidence with all on-fire stages is COVERED", (t) => {
  const root = tempWorkspace(t);
  const universe = clone(BASE);
  const row = rowById(universe);
  row.onFire.enabled = true;
  writeArtifact(root, row.artifactPath, coverageArtifact(row));
  assert.equal(auditRow(row, { workspace: root, nowMs: NOW }).status, "COVERED");
});

test("COVERED rejects an unsuccessful enumeration bound", (t) => {
  const root = tempWorkspace(t);
  const row = clone(rowById(BASE));
  row.onFire.enabled = true;
  const artifact = coverageArtifact(row);
  artifact.enumeration.successful = false;
  writeArtifact(root, row.artifactPath, artifact);
  assert.equal(auditRow(row, { workspace: root, nowMs: NOW }).status, "MISSING");
});

test("COVERED rejects unclassified read failures", (t) => {
  const root = tempWorkspace(t);
  const row = clone(rowById(BASE));
  row.onFire.enabled = true;
  const artifact = coverageArtifact(row);
  artifact.reads.unclassifiedFailures = 1;
  writeArtifact(root, row.artifactPath, artifact);
  assert.equal(auditRow(row, { workspace: root, nowMs: NOW }).status, "MISSING");
});

test("COVERED rejects trigger-class semantic mismatch", (t) => {
  const root = tempWorkspace(t);
  const row = clone(rowById(BASE));
  row.onFire.enabled = true;
  const artifact = coverageArtifact(row);
  artifact.classSemantics.triggerClass = "O";
  writeArtifact(root, row.artifactPath, artifact);
  assert.equal(auditRow(row, { workspace: root, nowMs: NOW }).status, "MISSING");
});

test("COVERED rejects incomplete on-fire wiring", (t) => {
  const root = tempWorkspace(t);
  const row = clone(rowById(BASE));
  row.onFire.enabled = true;
  const artifact = coverageArtifact(row);
  artifact.onFire.keylessFixedPinFork = false;
  writeArtifact(root, row.artifactPath, artifact);
  assert.equal(auditRow(row, { workspace: root, nowMs: NOW }).status, "MISSING");
});

test("DELTA_ONLY is rejected outside D", () => {
  const value = clone(BASE);
  value.rows[0].coverageMode = "DELTA_ONLY";
  assert.throws(() => validateUniverse(value), /DELTA_ONLY is valid only for D/);
});

test("BLOCKED requires evidence and disabled dispatch", (t) => {
  const root = tempWorkspace(t);
  const row = clone(rowById(BASE));
  row.onFire.enabled = false;
  const artifact = coverageArtifact(row, { dispatchEnabled: false, evidence: ["current bounded blocker"] });
  artifact.coverage.complete = false;
  artifact.blockers = ["unwind closure absent"];
  writeArtifact(root, row.artifactPath, artifact);
  const result = auditRow(row, { workspace: root, nowMs: NOW });
  assert.equal(result.status, "BLOCKED");
  row.onFire.enabled = true;
  assert.equal(auditRow(row, { workspace: root, nowMs: NOW }).status, "MISSING");
});

test("missing and stale statuses keep done false", (t) => {
  const root = tempWorkspace(t);
  const universe = clone(BASE);
  const missing = rowById(universe);
  missing.onFire.enabled = true;
  const stale = rowById(universe, "ethereum-morpho-blue-o");
  stale.onFire.enabled = true;
  writeArtifact(root, stale.artifactPath, coverageArtifact(stale, { observedAt: new Date(NOW - (stale.freshnessSeconds * 1000 + 1_000)).toISOString() }));
  const universePath = writeUniverse(root, universe);
  const audit = runAudit({ workspace: root, universePath, nowMs: NOW });
  assert.equal(audit.rows.find((row) => row.id === missing.id).status, "MISSING");
  assert.equal(audit.rows.find((row) => row.id === stale.id).status, "STALE");
  assert.equal(audit.done, false);
});

test("done means every enabled row is COVERED and every disabled row is explicitly BLOCKED", (t) => {
  const root = tempWorkspace(t);
  const enabledIds = BASE.rows.filter((row) => row.onFire.enabled).map((row) => row.id);
  for (const id of enabledIds) {
    const row = rowById(BASE, id);
    writeArtifact(root, row.artifactPath, coverageArtifact(row));
  }
  const universePath = writeUniverse(root);
  const audit = runAudit({ workspace: root, universePath, nowMs: NOW });
  assert.equal(audit.rows.filter((row) => row.status === "COVERED").length, enabledIds.length);
  assert.equal(audit.rows.filter((row) => row.status === "BLOCKED").length, BASE.rows.length - enabledIds.length);
  assert.equal(audit.done, true);
});

test("--apply uses injected atomic write and leaves no temporary file", (t) => {
  const root = tempWorkspace(t);
  const universePath = writeUniverse(root);
  const outputPath = path.join(root, "reports", "monitor", "audit.json");
  let writes = 0;
  const fsImpl = Object.create(fs);
  fsImpl.writeFileSync = (...args) => { writes += 1; return fs.writeFileSync(...args); };
  const audit = runAudit({ workspace: root, universePath, outputPath, nowMs: NOW, apply: true, fsImpl });
  assert.equal(writes, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), audit);
  assert.deepEqual(fs.readdirSync(path.dirname(outputPath)).filter((name) => name.includes(".tmp-")), []);
});

test("default and --check perform no write, including live output", (t) => {
  const root = tempWorkspace(t);
  const universePath = writeUniverse(root);
  const outputPath = path.join(root, "reports", "monitor", "must-not-exist.json");
  const before = fs.existsSync(OUT_PATH) ? fs.statSync(OUT_PATH).mtimeMs : null;
  runAudit({ workspace: root, universePath, outputPath, nowMs: NOW, ...parseOptions(["--check"]) });
  const after = fs.existsSync(OUT_PATH) ? fs.statSync(OUT_PATH).mtimeMs : null;
  assert.equal(fs.existsSync(outputPath), false);
  assert.equal(after, before);
});

test("sanitizer removes endpoint and credential material", () => {
  const text = sanitizeText("failed https://rpc.example/key api_key=abc123\nsecret:xyz");
  assert.equal(text.includes("rpc.example"), false);
  assert.equal(text.includes("abc123"), false);
  assert.equal(text.includes("xyz"), false);
});

test("manifest adds exactly one 5-minute trigger coverage data artifact", () => {
  const matches = dataArtifacts.filter((row) => row.semantic?.validator === "trigger-coverage-audit");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].freshnessMinutes, 5);
  assert.equal(matches[0].path, "reports/monitor/trigger-coverage-audit.json");
});

test("autopilot semantic validator checks hash, accounting, and done consistency", () => {
  const audit = runAudit({ nowMs: Date.now() });
  const spec = dataArtifacts.find((row) => row.semantic?.validator === "trigger-coverage-audit");
  assert.equal(healthyTriggerCoverageAudit(audit), true);
  assert.equal(validateArtifactSemantics(spec, audit, null, Date.now()), true);
  const badHash = clone(audit);
  badHash.universeSha256 = "0".repeat(64);
  assert.equal(healthyTriggerCoverageAudit(badHash), false);
  const badDone = clone(audit);
  badDone.done = !badDone.done;
  assert.equal(healthyTriggerCoverageAudit(badDone), false);
});

test("autopilot validator distinguishes the operationally COVERED rows from BLOCKED", () => {
  const audit = runAudit({ nowMs: Date.now() });
  assert.equal(audit.rows.some((row) => row.status === "BLOCKED"), true);
  assert.equal(audit.rows.some((row) => row.status === "COVERED"), true);
  assert.equal(healthyTriggerCoverageAudit(audit), true);
});
