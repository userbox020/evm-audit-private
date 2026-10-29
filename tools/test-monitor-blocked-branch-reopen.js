#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const M = require("./monitor-blocked-branch-reopen.js");

const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const AT = new Date(NOW).toISOString();
let assertions = 0;
let tests = 0;
let symlinkCoverage = "not-attempted";
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function deepEqual(actual, expected, message) { assertions += 1; assert.deepEqual(actual, expected, message); }
async function rejects(fn, predicate, message) { assertions += 1; await assert.rejects(fn, predicate, message); }
function throws(fn, predicate, message) { assertions += 1; assert.throws(fn, predicate, message); }
async function test(name, fn) { await fn(); tests += 1; process.stdout.write(`ok ${tests} - ${name}\n`); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function h(char) { return char.repeat(64); }
function removeAt(value, dotted) {
  const copy = clone(value);
  const parts = dotted.split(".");
  const leaf = parts.pop();
  let cursor = copy;
  for (const part of parts) cursor = cursor[part];
  delete cursor[leaf];
  return copy;
}
async function makeRoot(label) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `blocked-reopen-v2-${label}-`));
  await fsp.mkdir(path.join(root, "reports"));
  await fsp.mkdir(path.join(root, "coordination", "reopen-evidence"), { recursive: true });
  return root;
}
function absolute(root, relative) { return path.join(root, ...relative.split("/")); }
async function writeBytes(root, relative, bytes) {
  const target = absolute(root, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, bytes);
  return { path: relative, sha256: M.sha256(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)) };
}
async function writeJson(root, relative, value) {
  return writeBytes(root, relative, `${JSON.stringify(value)}\n`);
}
async function artifact(root, name, content) {
  return writeBytes(root, `${M.EVIDENCE_ROOT}/artifacts/${name}`, Buffer.from(content));
}
async function buildPositive(root, suffix = "base") {
  const localStorageAttestation = {
    schema: "blocked-branch-reopen/local-storage-attestation/v1",
    evidenceRoot: M.EVIDENCE_ROOT,
    fullyLocalNonTiered: true,
    genericReparsePointsAbsent: true,
    reviewed: true,
    reviewerId: `storage-reviewer-${suffix}`,
    observedAt: AT,
    expiresAt: new Date(NOW + 60 * 60 * 1000).toISOString(),
  };
  const localStorageAttestationPath = `${M.EVIDENCE_ROOT}/manifests/${suffix}-local-storage-attestation.json`;
  await writeJson(root, localStorageAttestationPath, localStorageAttestation);
  const r = {
    runner: await artifact(root, `${suffix}-renzo-runner.js`, `renzo-runner-${suffix}`),
    test: await artifact(root, `${suffix}-renzo-test.js`, `renzo-test-${suffix}`),
    package: await artifact(root, `${suffix}-renzo-package.json`, `renzo-package-${suffix}`),
    approval: await artifact(root, `${suffix}-renzo-approval.json`, `renzo-approval-${suffix}`),
    output: await artifact(root, `${suffix}-renzo-output.json`, `renzo-output-${suffix}`),
  };
  const renzoLineage = {
    schema: "blocked-branch-reopen/renzo-lineage/v2", lineageId: `renzo-${suffix}`, newLineage: true,
    reviewed: true, reviewDecision: "APPROVED_CANDIDATE", reviewedAt: AT, observedAt: AT,
    artifacts: { runner: r.runner, test: r.test, package: r.package, approval: r.approval },
    consumedStep5Excluded: true, importsConsumedRunner: false,
  };
  const renzoLineagePath = `${M.EVIDENCE_ROOT}/manifests/${suffix}-renzo-lineage.json`;
  const renzoLineageRecord = await writeJson(root, renzoLineagePath, renzoLineage);
  const renzoQualification = {
    schema: "blocked-branch-reopen/renzo-dual-group-qualification/v2", lineageId: renzoLineage.lineageId,
    observedAt: AT, success: true, sanitized: true, providerMaterialAbsent: true, groupCount: 2,
    distinctGroups: true, identicalFinalizedHeader: true, finalizedHeader: { number: 123456, hash: h("d") },
    sourceLineageDigest: renzoLineageRecord.sha256, output: r.output, approval: r.approval,
    outputSha256: r.output.sha256, approvalSha256: r.approval.sha256, retry: false,
  };
  const renzoQualificationPath = `${M.EVIDENCE_ROOT}/manifests/${suffix}-renzo-qualification.json`;
  await writeJson(root, renzoQualificationPath, renzoQualification);

  const names = ["compiler", "standard-input", "standard-output", "metadata", "immutables", "pair-runtime", "oracle-runtime", "static-binding", "fair", "acquisition", "exit"];
  const refs = {};
  for (const name of names) refs[name] = await artifact(root, `${suffix}-frax-${name}.bin`, `${suffix}-frax-${name}`);
  const fraxlend = {
    schema: "blocked-branch-reopen/fraxlend-explicit-manifest/v2", validated: true, explicit: true, observedAt: AT,
    compiler: { ...refs.compiler, exactLocalBinary: true }, standardInput: refs["standard-input"],
    standardOutput: refs["standard-output"], metadata: refs.metadata, immutableReferences: refs.immutables,
    pairRuntimeTemplates: [refs["pair-runtime"]], oracleRuntimeTemplates: [refs["oracle-runtime"]],
    staticOracleBinding: { validated: true, evidence: refs["static-binding"] },
    authorities: {
      fair: { fixed: true, evidence: refs.fair }, acquisition: { fixed: true, evidence: refs.acquisition },
      exit: { fixed: true, evidence: refs.exit },
    },
  };
  const fraxlendPath = `${M.EVIDENCE_ROOT}/manifests/${suffix}-fraxlend.json`;
  await writeJson(root, fraxlendPath, fraxlend);

  const u = {
    runner: await artifact(root, `${suffix}-uni-runner.js`, `${suffix}-uni-runner`),
    approval: await artifact(root, `${suffix}-uni-approval.json`, `${suffix}-uni-approval`),
    ledger: await artifact(root, `${suffix}-uni-ledger.json`, `${suffix}-uni-ledger`),
    output: await artifact(root, `${suffix}-uni-output.json`, `${suffix}-uni-output`),
    durability: await artifact(root, `${suffix}-uni-durability.json`, `${suffix}-uni-durability`),
  };
  const uniswapxLineage = {
    schema: "blocked-branch-reopen/uniswapx-lineage/v2", lineageId: `uniswapx-${suffix}`, newLineage: true,
    reviewed: true, reviewedAt: AT, observedAt: AT, retry: false, consumedLineage: false,
    currentApprovalLedgerExcluded: true, artifacts: { runner: u.runner, approval: u.approval, ledger: u.ledger, output: u.output },
  };
  const uniswapxLineagePath = `${M.EVIDENCE_ROOT}/manifests/${suffix}-uniswapx-lineage.json`;
  const uniswapxLineageRecord = await writeJson(root, uniswapxLineagePath, uniswapxLineage);
  const uniswapxDurability = {
    schema: "blocked-branch-reopen/uniswapx-parent-durability/v2", lineageId: uniswapxLineage.lineageId,
    observedAt: AT, validated: true, sanitized: true, preInventory: true,
    sourceLineageDigest: uniswapxLineageRecord.sha256,
    parentDirectory: { durable: true, fsyncVerified: true, evidence: u.durability },
  };
  const uniswapxDurabilityPath = `${M.EVIDENCE_ROOT}/manifests/${suffix}-uniswapx-durability.json`;
  await writeJson(root, uniswapxDurabilityPath, uniswapxDurability);

  const v = {
    runner: await artifact(root, `${suffix}-valantis-runner.js`, `${suffix}-valantis-runner`),
    test: await artifact(root, `${suffix}-valantis-test.js`, `${suffix}-valantis-test`),
    authority: await artifact(root, `${suffix}-valantis-authority.json`, `${suffix}-valantis-authority`),
    package: await artifact(root, `${suffix}-valantis-package.json`, `${suffix}-valantis-package`),
    output: await artifact(root, `${suffix}-valantis-output.json`, `${suffix}-valantis-output`),
  };
  const valantisLineage = {
    schema: "blocked-branch-reopen/valantis-successor-lineage/v1",
    lineageId: `valantis-${suffix}`,
    newLineage: true,
    reviewed: true,
    reviewedAt: AT,
    observedAt: AT,
    artifacts: v,
    predecessorBindings: {
      step2sDiagnosticSha256: M.VALANTIS_PREDECESSOR.diagnostic,
      step2sRunnerSha256: M.VALANTIS_PREDECESSOR.runner,
      step2sAuthoritySha256: M.VALANTIS_PREDECESSOR.authority,
      step2sPackageSha256: M.VALANTIS_PREDECESSOR.package,
    },
    retry: false,
    importsConsumedLineage: false,
    reusesConsumedLineage: false,
  };
  const valantisLineagePath = `${M.EVIDENCE_ROOT}/manifests/valantis-successor-lineage.json`;
  const valantisLineageRecord = await writeJson(root, valantisLineagePath, valantisLineage);
  const valantisCapability = {
    schema: "blocked-branch-reopen/valantis-finality-capability/v1",
    lineageId: valantisLineage.lineageId,
    reviewed: true,
    reviewerId: `valantis-reviewer-${suffix}`,
    sanitized: true,
    observedAt: AT,
    expiresAt: new Date(NOW + 60 * 60 * 1000).toISOString(),
    sourceLineageDigest: valantisLineageRecord.sha256,
    chainId: 999,
    groupsOpaque: true,
    opaqueGroupCount: 2,
    distinctGroups: true,
    identicalFinalizedHeader: true,
    identicalFinalizedBlock: { number: 987654, hash: h("c"), stateRoot: h("b") },
    terminalRecheck: true,
    materialNewEvidence: true,
    providerMaterialAbsent: true,
    networkCaptureAuthorized: false,
  };
  const valantisCapabilityPath = `${M.EVIDENCE_ROOT}/manifests/valantis-finality-capability.json`;
  await writeJson(root, valantisCapabilityPath, valantisCapability);
  return {
    options: { localStorageAttestation: localStorageAttestationPath,
      renzoLineage: renzoLineagePath, renzoQualification: renzoQualificationPath,
      fraxlendManifest: fraxlendPath, uniswapxLineage: uniswapxLineagePath, uniswapxDurability: uniswapxDurabilityPath,
      valantisLineage: valantisLineagePath, valantisCapability: valantisCapabilityPath },
    fixtures: { localStorageAttestation, renzoLineage, renzoQualification, fraxlend, uniswapxLineage, uniswapxDurability,
      valantisLineage, valantisCapability, r, refs, u, v },
  };
}

(async () => {
  await test("strict canonical JSON and bounded defaults", async () => {
    equal(M.SCHEMA, "blocked-branch-reopen-state/v1");
    equal(M.EVIDENCE_ROOT, "coordination/reopen-evidence");
    equal(M.canonicalJson({ z: 1, a: [true, null] }), '{"a":[true,null],"z":1}');
    for (const value of [{ a: undefined }, { a: NaN }, { a: Infinity }, { a: 1n }, () => {}]) {
      throws(() => M.canonicalJson(value), (error) => error.code === "CANONICAL_VALUE_UNSUPPORTED");
    }
    const cyclic = {}; cyclic.self = cyclic;
    throws(() => M.canonicalJson(cyclic), (error) => error.code === "CANONICAL_VALUE_UNSUPPORTED");
    equal(M.parseCli([]).watch, false);
    equal(M.parseCli([]).intervalSeconds, 300);
    const valantisCli = M.parseCli([
      "--valantis-successor-lineage", `${M.EVIDENCE_ROOT}/manifests/valantis-successor-lineage.json`,
      "--valantis-finality-capability", `${M.EVIDENCE_ROOT}/manifests/valantis-finality-capability.json`,
    ]);
    ok(Boolean(valantisCli.valantisLineage));
    ok(Boolean(valantisCli.valantisCapability));
    const budget = new M.ReadBudget(M.MAX_CYCLE_READ_BYTES);
    budget.consume(M.MAX_CYCLE_READ_BYTES);
    equal(budget.used, M.MAX_CYCLE_READ_BYTES);
    throws(() => budget.consume(1), (error) => error.code === "READ_BUDGET_EXCEEDED");
  });

  await test("portable allowlisted paths reject escapes, ADS, devices, aliases, and URIs", async () => {
    const bad = [
      "../x.json", "coordination/reopen-evidence/../x.json", "coordination\\reopen-evidence\\x.json",
      "coordination/reopen-evidence/x.json:secret", "coordination/reopen-evidence/CON", "coordination/reopen-evidence/con.txt",
      "coordination/reopen-evidence/NUL.json", "coordination/reopen-evidence/LPT9", "coordination/reopen-evidence/file.",
      "coordination/reopen-evidence/file ", "file:///coordination/reopen-evidence/x", "https://host/x",
      "coordination/reopen-evidence//x", "/coordination/reopen-evidence/x", "reports/x.json",
      "coordination/reopen-evidence/wallet.json", "coordination/reopen-evidence/private-key.json",
      "coordination/reopen-evidence/keypair.json", "coordination/reopen-evidence/identity.pem",
    ];
    for (const value of bad) throws(() => M.evidenceRelative(value), (error) => error instanceof M.MonitorError, value);
    equal(M.evidenceRelative("coordination/reopen-evidence/manifests/a-1.json"), "coordination/reopen-evidence/manifests/a-1.json");
    throws(() => M.parseCli(["--fraxlend-manifest", "reports/f.json"]), (error) => error.code === "PATH_OUTSIDE_EVIDENCE_ROOT");
    throws(() => M.evidenceRelative(`${M.EVIDENCE_ROOT}/${"a".repeat(M.MAX_SEGMENT_CHARS + 1)}`), (error) => error.code === "PATH_INVALID");
    const longPath = `${M.EVIDENCE_ROOT}/${Array(20).fill("a".repeat(30)).join("/")}`;
    ok(longPath.length > M.MAX_PATH_CHARS);
    throws(() => M.evidenceRelative(longPath), (error) => error.code === "PATH_INVALID");
  });

  await test("interval, mode, duplicate and unknown CLI arguments fail closed", async () => {
    for (const argv of [["--interval-seconds", "29"], ["--interval-seconds", "86401"], ["--interval-seconds", "x"],
      ["--once", "--watch"], ["--unknown"], ["--fraxlend-manifest", `${M.EVIDENCE_ROOT}/a.json`, "--fraxlend-manifest", `${M.EVIDENCE_ROOT}/b.json`]]) {
      throws(() => M.parseCli(argv), (error) => error instanceof M.MonitorError);
    }
    throws(() => M.parseCli(["x".repeat(M.MAX_CLI_CHARS + 1)]), (error) => error.code === "CLI_LENGTH_EXCEEDED");
  });

  await test("absent inputs are branch HOLD and check-only publishes nothing", async () => {
    const root = await makeRoot("absent");
    const result = await M.runCycle({ checkOnly: true, intervalSeconds: 300 }, { root, now: () => new Date(NOW) });
    equal(result.state.status, "HOLD");
    for (const name of ["renzo", "fraxlend", "uniswapx", "valantis"]) equal(result.state.branches[name].status, "HOLD");
    deepEqual(result.state.branches.renzo.blockers, ["LOCAL_STORAGE_ATTESTATION_ABSENT", "RENZO_LINEAGE_MANIFEST_ABSENT", "RENZO_QUALIFICATION_ARTIFACT_ABSENT"]);
    for (const name of ["renzo", "fraxlend", "uniswapx", "valantis"]) ok(result.state.branches[name].blockers.includes("LOCAL_STORAGE_ATTESTATION_ABSENT"));
    equal(fs.existsSync(absolute(root, M.DEFAULT_OUTPUT)), false);
    equal(result.state.networkCalls, 0);
    equal(result.state.protectedInventoriesOpened, 0);
  });

  await test("positive fixtures hash every referenced artifact and produce candidates", async () => {
    const root = await makeRoot("positive");
    const built = await buildPositive(root);
    const result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    equal(result.state.status, "REOPEN_CANDIDATE");
    deepEqual(Object.keys(result.state.branches).sort(), ["fraxlend", "renzo", "uniswapx", "valantis"]);
    equal(result.state.branches.renzo.evidence.length, 8);
    equal(result.state.branches.fraxlend.evidence.length, 13);
    equal(result.state.branches.uniswapx.evidence.length, 8);
    equal(result.state.branches.valantis.evidence.length, 8);
    const expectedValidUntil = new Date(NOW + 60 * 60 * 1000).toISOString();
    equal(result.state.validUntil, expectedValidUntil);
    for (const name of ["renzo", "fraxlend", "uniswapx", "valantis"]) {
      equal(result.state.branches[name].status, "REOPEN_CANDIDATE");
      deepEqual(result.state.branches[name].blockers, []);
      equal(result.state.branches[name].priorValidatedObservation, null);
      ok(result.state.branches[name].evidence.every((row) => M.EVIDENCE_ROOT && row.path.startsWith(`${M.EVIDENCE_ROOT}/`)));
      equal(result.state.branches[name].validUntil, expectedValidUntil);
    }
    equal(result.state.readOnly, true);
    equal(result.state.upstreamTransactions, 0);
    equal(result.state.signing, false);
    equal(result.state.broadcast, false);
    equal(result.state.fork, false);
    equal(result.state.networkCalls, 0);
    M.validateState(result.state, NOW); assertions += 1;
    equal(M._test.publicSummary(result.state).validUntil, expectedValidUntil);
  });

  await test("candidate state and current evaluation expire exactly at validUntil", async () => {
    const root = await makeRoot("candidate-expiry");
    const built = await buildPositive(root);
    const state = (await M.evaluate(built.options, { root, now: () => new Date(NOW) })).state;
    const expiry = Date.parse(state.validUntil);
    M.validateState(state, expiry - 1); assertions += 1;
    throws(() => M.validateState(state, expiry), (error) => error.code === "STATE_BRANCH_INVALID");
    const expiredCurrent = await M.evaluate(built.options, { root, now: () => new Date(expiry) });
    equal(expiredCurrent.state.status, "HOLD");
    equal(expiredCurrent.state.validUntil, null);
    for (const name of ["renzo", "fraxlend", "uniswapx", "valantis"]) {
      equal(expiredCurrent.state.branches[name].status, "HOLD");
      equal(expiredCurrent.state.branches[name].validUntil, null);
      ok(expiredCurrent.state.branches[name].blockers.includes("LOCAL_STORAGE_ATTESTATION_EXPIRY_INVALID"));
    }
  });

  await test("reviewed local-storage attestation is a shared fresh candidate gate", async () => {
    const root = await makeRoot("storage-gate");
    const built = await buildPositive(root);
    const without = { ...built.options };
    delete without.localStorageAttestation;
    let result = await M.evaluate(without, { root, now: () => new Date(NOW) });
    for (const name of ["renzo", "fraxlend", "uniswapx", "valantis"]) {
      equal(result.state.branches[name].status, "HOLD");
      ok(result.state.branches[name].blockers.includes("LOCAL_STORAGE_ATTESTATION_ABSENT"));
    }
    const invalid = clone(built.fixtures.localStorageAttestation);
    invalid.fullyLocalNonTiered = false;
    invalid.genericReparsePointsAbsent = false;
    await writeJson(root, built.options.localStorageAttestation, invalid);
    result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    for (const name of ["renzo", "fraxlend", "uniswapx", "valantis"]) {
      ok(result.state.branches[name].blockers.includes("LOCAL_STORAGE_ATTESTATION_NOT_FULLY_LOCAL"));
      ok(result.state.branches[name].blockers.includes("LOCAL_STORAGE_ATTESTATION_REPARSE_ABSENCE_UNAPPROVED"));
    }
    const stale = clone(built.fixtures.localStorageAttestation);
    stale.observedAt = new Date(NOW - M.MAX_EVIDENCE_AGE_MS - 1).toISOString();
    stale.expiresAt = new Date(NOW + 1000).toISOString();
    await writeJson(root, built.options.localStorageAttestation, stale);
    result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    ok(result.state.branches.renzo.blockers.includes("LOCAL_STORAGE_ATTESTATION_OBSERVATION_NOT_FRESH"));
    ok(result.state.branches.renzo.blockers.includes("LOCAL_STORAGE_ATTESTATION_EXPIRY_INVALID"));
    const extra = clone(built.fixtures.localStorageAttestation);
    extra.unknown = true;
    ok(M.validateLocalStorageAttestation(extra, NOW).includes("LOCAL_STORAGE_ATTESTATION_EXACT_SCHEMA_INVALID"));
  });

  await test("descriptor count and cumulative-read budgets fail closed at boundaries", async () => {
    const root = await makeRoot("budgets");
    const built = await buildPositive(root);
    const frax = clone(built.fixtures.fraxlend);
    for (let index = 1; index < M.MAX_DESCRIPTOR_ARRAY_COUNT; index += 1) {
      frax.pairRuntimeTemplates.push(await artifact(root, `budget-pair-${index}.bin`, `budget-pair-${index}`));
      frax.oracleRuntimeTemplates.push(await artifact(root, `budget-oracle-${index}.bin`, `budget-oracle-${index}`));
    }
    equal(frax.pairRuntimeTemplates.length, M.MAX_DESCRIPTOR_ARRAY_COUNT);
    await writeJson(root, built.options.fraxlendManifest, frax);
    let result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    for (const name of ["renzo", "fraxlend", "uniswapx", "valantis"]) {
      ok(result.state.branches[name].blockers.includes(`${name.toUpperCase()}_DESCRIPTOR_CYCLE_BUDGET_EXCEEDED`));
    }
    const over = clone(frax);
    over.pairRuntimeTemplates.push(over.pairRuntimeTemplates[0]);
    ok(M.validateFraxlend(over, NOW).blockers.includes("FRAXLEND_PAIR_RUNTIME_TEMPLATES_INVALID"));
    const root2 = await makeRoot("read-budget");
    const built2 = await buildPositive(root2);
    const manifestBytes = Object.values(built2.options).reduce((total, relative) => total + fs.statSync(absolute(root2, relative)).size, 0);
    result = await M.evaluate(built2.options, { root: root2, now: () => new Date(NOW), readBudgetLimit: manifestBytes + 1 });
    for (const name of ["renzo", "fraxlend", "uniswapx", "valantis"]) {
      equal(result.state.branches[name].status, "HOLD");
      ok(result.state.branches[name].blockers.some((code) => code.endsWith("READ_BUDGET_EXCEEDED")));
    }
  });

  await test("actual descriptor hash mismatch and missing artifact hold only that branch", async () => {
    const root = await makeRoot("hash-mismatch");
    const built = await buildPositive(root);
    await fsp.writeFile(absolute(root, built.fixtures.refs.metadata.path), "changed");
    await fsp.unlink(absolute(root, built.fixtures.u.durability.path));
    const result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    equal(result.state.branches.renzo.status, "REOPEN_CANDIDATE");
    equal(result.state.branches.fraxlend.status, "HOLD");
    equal(result.state.branches.uniswapx.status, "HOLD");
    ok(result.state.branches.fraxlend.blockers.includes("FRAXLEND_METADATA_HASH_MISMATCH"));
    ok(result.state.branches.uniswapx.blockers.includes("UNISWAPX_PARENT_DURABILITY_INPUT_UNAVAILABLE"));
  });

  await test("cross-branch evidence reuse is rejected", async () => {
    const root = await makeRoot("cross-reuse");
    const built = await buildPositive(root);
    const frax = clone(built.fixtures.fraxlend);
    frax.compiler.path = built.fixtures.r.runner.path;
    frax.compiler.sha256 = built.fixtures.r.runner.sha256;
    await writeJson(root, built.options.fraxlendManifest, frax);
    const result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    equal(result.state.branches.renzo.status, "HOLD");
    equal(result.state.branches.fraxlend.status, "HOLD");
    ok(result.state.branches.renzo.blockers.includes("RENZO_CROSS_BRANCH_EVIDENCE_REUSE_REJECTED"));
    ok(result.state.branches.fraxlend.blockers.includes("FRAXLEND_CROSS_BRANCH_EVIDENCE_REUSE_REJECTED"));
    await writeJson(root, built.options.fraxlendManifest, built.fixtures.fraxlend);
    const valantis = clone(built.fixtures.valantisLineage);
    valantis.artifacts.runner = built.fixtures.r.runner;
    await writeJson(root, built.options.valantisLineage, valantis);
    const reused = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    ok(reused.state.branches.renzo.blockers.includes("RENZO_CROSS_BRANCH_EVIDENCE_REUSE_REJECTED"));
    ok(reused.state.branches.valantis.blockers.includes("VALANTIS_CROSS_BRANCH_EVIDENCE_REUSE_REJECTED"));
  });

  await test("Valantis actual descriptor mismatch is branch-scoped HOLD", async () => {
    const root = await makeRoot("valantis-hash-mismatch");
    const built = await buildPositive(root);
    await fsp.writeFile(absolute(root, built.fixtures.v.output.path), "changed-valantis-output");
    const result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    equal(result.state.branches.valantis.status, "HOLD");
    ok(result.state.branches.valantis.blockers.includes("VALANTIS_OUTPUT_HASH_MISMATCH"));
    equal(result.state.branches.renzo.status, "REOPEN_CANDIDATE");
    equal(result.state.branches.fraxlend.status, "REOPEN_CANDIDATE");
    equal(result.state.branches.uniswapx.status, "REOPEN_CANDIDATE");
  });

  await test("all input schemas reject extra fields recursively", async () => {
    const root = await makeRoot("extra");
    const built = await buildPositive(root);
    const cases = [
      [M.validateLocalStorageAttestation, built.fixtures.localStorageAttestation, "LOCAL_STORAGE_ATTESTATION_EXACT_SCHEMA_INVALID"],
      [M.validateRenzoLineage, built.fixtures.renzoLineage, "RENZO_LINEAGE_EXACT_SCHEMA_INVALID"],
      [M.validateRenzoQualification, built.fixtures.renzoQualification, "RENZO_QUALIFICATION_EXACT_SCHEMA_INVALID"],
      [M.validateFraxlend, built.fixtures.fraxlend, "FRAXLEND_EXACT_SCHEMA_INVALID"],
      [M.validateUniswapxLineage, built.fixtures.uniswapxLineage, "UNISWAPX_LINEAGE_EXACT_SCHEMA_INVALID"],
      [M.validateUniswapxDurability, built.fixtures.uniswapxDurability, "UNISWAPX_DURABILITY_EXACT_SCHEMA_INVALID"],
      [M.validateValantisLineage, built.fixtures.valantisLineage, "VALANTIS_LINEAGE_EXACT_SCHEMA_INVALID"],
      [M.validateValantisCapability, built.fixtures.valantisCapability, "VALANTIS_CAPABILITY_EXACT_SCHEMA_INVALID"],
    ];
    for (const [validator, fixture, code] of cases) {
      const extra = clone(fixture); extra.unknownSecret = "must-not-pass";
      const validated = validator(extra, NOW);
      ok((Array.isArray(validated) ? validated : validated.blockers).includes(code));
    }
    const nested = clone(built.fixtures.fraxlend); nested.standardInput.extra = true;
    ok(M.validateFraxlend(nested, NOW).blockers.includes("FRAXLEND_STANDARD_INPUT_INVALID"));
    const nestedRenzo = clone(built.fixtures.renzoLineage); nestedRenzo.artifacts.runner.extra = true;
    ok(M.validateRenzoLineage(nestedRenzo, NOW).blockers.includes("RENZO_RUNNER_DESCRIPTOR_INVALID"));
    const state = (await M.evaluate(built.options, { root, now: () => new Date(NOW) })).state;
    const extraState = clone(state); extraState.secret = "x";
    throws(() => M.validateState(extraState, NOW), (error) => error.code === "STATE_EXACT_SCHEMA_INVALID");
    const extraBranch = clone(state); extraBranch.branches.renzo.unknown = true;
    throws(() => M.validateState(extraBranch, NOW), (error) => error.code === "STATE_BRANCH_INVALID");
    const extraEvidence = clone(state); extraEvidence.branches.renzo.evidence[0].content = "x";
    throws(() => M.validateState(extraEvidence, NOW), (error) => error.code === "STATE_BRANCH_INVALID");
  });

  await test("required field omissions fail exact schemas including Renzo output and approval", async () => {
    const root = await makeRoot("omissions");
    const b = (await buildPositive(root)).fixtures;
    const rows = [
      [M.validateLocalStorageAttestation, b.localStorageAttestation, ["schema", "evidenceRoot", "fullyLocalNonTiered", "genericReparsePointsAbsent", "reviewed", "reviewerId", "observedAt", "expiresAt"]],
      [M.validateRenzoLineage, b.renzoLineage, ["schema", "lineageId", "newLineage", "reviewed", "reviewDecision", "reviewedAt", "observedAt", "artifacts", "consumedStep5Excluded", "importsConsumedRunner"]],
      [M.validateRenzoQualification, b.renzoQualification, ["schema", "lineageId", "observedAt", "success", "sanitized", "providerMaterialAbsent", "groupCount", "distinctGroups", "identicalFinalizedHeader", "finalizedHeader", "sourceLineageDigest", "output", "approval", "outputSha256", "approvalSha256", "retry"]],
      [M.validateFraxlend, b.fraxlend, ["schema", "validated", "explicit", "observedAt", "compiler", "standardInput", "standardOutput", "metadata", "immutableReferences", "pairRuntimeTemplates", "oracleRuntimeTemplates", "staticOracleBinding", "authorities"]],
      [M.validateUniswapxLineage, b.uniswapxLineage, ["schema", "lineageId", "newLineage", "reviewed", "reviewedAt", "observedAt", "retry", "consumedLineage", "currentApprovalLedgerExcluded", "artifacts"]],
      [M.validateUniswapxDurability, b.uniswapxDurability, ["schema", "lineageId", "observedAt", "validated", "sanitized", "preInventory", "sourceLineageDigest", "parentDirectory"]],
      [M.validateValantisLineage, b.valantisLineage, ["schema", "lineageId", "newLineage", "reviewed", "reviewedAt", "observedAt", "artifacts", "predecessorBindings", "retry", "importsConsumedLineage", "reusesConsumedLineage"]],
      [M.validateValantisCapability, b.valantisCapability, ["schema", "lineageId", "reviewed", "reviewerId", "sanitized", "observedAt", "expiresAt", "sourceLineageDigest", "chainId", "groupsOpaque", "opaqueGroupCount", "distinctGroups", "identicalFinalizedHeader", "identicalFinalizedBlock", "terminalRecheck", "materialNewEvidence", "providerMaterialAbsent", "networkCaptureAuthorized"]],
    ];
    for (const [validator, fixture, fields] of rows) for (const field of fields) {
      const validated = validator(removeAt(fixture, field), NOW);
      ok((Array.isArray(validated) ? validated : validated.blockers).length > 0, field);
    }
    ok(M.validateRenzoQualification(removeAt(b.renzoQualification, "outputSha256"), NOW).blockers.includes("RENZO_QUALIFICATION_EXACT_SCHEMA_INVALID"));
    ok(M.validateRenzoQualification(removeAt(b.renzoQualification, "approvalSha256"), NOW).blockers.includes("RENZO_QUALIFICATION_EXACT_SCHEMA_INVALID"));
  });

  await test("nested required fields are recursively mandatory", async () => {
    const root = await makeRoot("nested-omissions");
    const b = (await buildPositive(root)).fixtures;
    for (const field of ["artifacts.runner.path", "artifacts.runner.sha256", "artifacts.test.path", "artifacts.test.sha256",
      "artifacts.package.path", "artifacts.package.sha256", "artifacts.approval.path", "artifacts.approval.sha256"]) {
      ok(M.validateRenzoLineage(removeAt(b.renzoLineage, field), NOW).blockers.length > 0, field);
    }
    for (const field of ["finalizedHeader.number", "finalizedHeader.hash", "output.path", "output.sha256", "approval.path", "approval.sha256"]) {
      ok(M.validateRenzoQualification(removeAt(b.renzoQualification, field), NOW).blockers.length > 0, field);
    }
    for (const field of ["compiler.path", "compiler.sha256", "compiler.exactLocalBinary", "standardInput.path", "standardInput.sha256",
      "standardOutput.path", "standardOutput.sha256", "metadata.path", "metadata.sha256", "immutableReferences.path",
      "immutableReferences.sha256", "pairRuntimeTemplates.0.path", "pairRuntimeTemplates.0.sha256", "oracleRuntimeTemplates.0.path",
      "oracleRuntimeTemplates.0.sha256", "staticOracleBinding.validated", "staticOracleBinding.evidence.path",
      "staticOracleBinding.evidence.sha256", "authorities.fair.fixed", "authorities.fair.evidence.path",
      "authorities.fair.evidence.sha256", "authorities.acquisition.fixed", "authorities.acquisition.evidence.path",
      "authorities.acquisition.evidence.sha256", "authorities.exit.fixed", "authorities.exit.evidence.path",
      "authorities.exit.evidence.sha256"]) {
      ok(M.validateFraxlend(removeAt(b.fraxlend, field), NOW).blockers.length > 0, field);
    }
    for (const field of ["artifacts.runner.path", "artifacts.runner.sha256", "artifacts.approval.path", "artifacts.approval.sha256",
      "artifacts.ledger.path", "artifacts.ledger.sha256", "artifacts.output.path", "artifacts.output.sha256"]) {
      ok(M.validateUniswapxLineage(removeAt(b.uniswapxLineage, field), NOW).blockers.length > 0, field);
    }
    for (const field of ["parentDirectory.durable", "parentDirectory.fsyncVerified", "parentDirectory.evidence.path", "parentDirectory.evidence.sha256"]) {
      ok(M.validateUniswapxDurability(removeAt(b.uniswapxDurability, field), NOW).blockers.length > 0, field);
    }
    for (const field of ["artifacts.runner.path", "artifacts.runner.sha256", "artifacts.test.path", "artifacts.test.sha256",
      "artifacts.authority.path", "artifacts.authority.sha256", "artifacts.package.path", "artifacts.package.sha256",
      "artifacts.output.path", "artifacts.output.sha256", "predecessorBindings.step2sDiagnosticSha256",
      "predecessorBindings.step2sRunnerSha256", "predecessorBindings.step2sAuthoritySha256", "predecessorBindings.step2sPackageSha256"]) {
      ok(M.validateValantisLineage(removeAt(b.valantisLineage, field), NOW).blockers.length > 0, field);
    }
    for (const field of ["identicalFinalizedBlock.number", "identicalFinalizedBlock.hash", "identicalFinalizedBlock.stateRoot"]) {
      ok(M.validateValantisCapability(removeAt(b.valantisCapability, field), NOW).length > 0, field);
    }
  });

  await test("Renzo binds actual lineage, approval and distinct hashes", async () => {
    const root = await makeRoot("renzo-bind");
    const built = await buildPositive(root);
    const qPath = built.options.renzoQualification;
    const mismatch = clone(built.fixtures.renzoQualification); mismatch.sourceLineageDigest = h("f");
    await writeJson(root, qPath, mismatch);
    let result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    ok(result.state.branches.renzo.blockers.includes("RENZO_QUALIFICATION_LINEAGE_BINDING_MISMATCH"));
    const duplicate = clone(built.fixtures.renzoQualification);
    duplicate.output = built.fixtures.r.runner; duplicate.outputSha256 = built.fixtures.r.runner.sha256;
    await writeJson(root, qPath, duplicate);
    result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    ok(result.state.branches.renzo.blockers.includes("RENZO_LINEAGE_HASHES_NOT_DISTINCT"));
    ok(result.state.branches.renzo.blockers.includes("RENZO_EVIDENCE_PATHS_NOT_DISTINCT"));
    const badApproval = clone(built.fixtures.renzoQualification); badApproval.approval = built.fixtures.r.output; badApproval.approvalSha256 = built.fixtures.r.output.sha256;
    await writeJson(root, qPath, badApproval);
    result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    ok(result.state.branches.renzo.blockers.includes("RENZO_APPROVAL_LINEAGE_BINDING_MISMATCH"));
    ok(result.state.branches.renzo.blockers.includes("RENZO_APPROVAL_PATH_BINDING_MISMATCH"));
  });

  await test("consumed hashes and UniswapX retry/lineage binding are rejected", async () => {
    const root = await makeRoot("consumed");
    const built = await buildPositive(root);
    const line = clone(built.fixtures.renzoLineage);
    line.artifacts.runner.sha256 = [...M.CONSUMED_RENZO_HASHES][0];
    await writeJson(root, built.options.renzoLineage, line);
    let result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    ok(result.state.branches.renzo.blockers.includes("RENZO_CONSUMED_STEP5_HASH_REJECTED"));
    const uni = clone(built.fixtures.uniswapxLineage); uni.artifacts.approval.sha256 = [...M.CONSUMED_UNISWAPX_HASHES][4]; uni.retry = true;
    await writeJson(root, built.options.uniswapxLineage, uni);
    result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    ok(result.state.branches.uniswapx.blockers.includes("UNISWAPX_CURRENT_APPROVAL_LEDGER_OR_CONSUMED_HASH_REJECTED"));
    ok(result.state.branches.uniswapx.blockers.includes("UNISWAPX_RETRY_MUST_BE_FALSE"));
    const dur = clone(built.fixtures.uniswapxDurability); dur.sourceLineageDigest = h("e"); dur.lineageId = "different";
    await writeJson(root, built.options.uniswapxDurability, dur);
    result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    ok(result.state.branches.uniswapx.blockers.includes("UNISWAPX_DURABILITY_LINEAGE_BINDING_MISMATCH"));
    ok(result.state.branches.uniswapx.blockers.includes("UNISWAPX_DURABILITY_LINEAGE_ID_MISMATCH"));
  });

  await test("Valantis rejects consumed lineage and predecessor/binding mismatch", async () => {
    const root = await makeRoot("valantis-lineage-reject");
    const built = await buildPositive(root);
    const consumed = clone(built.fixtures.valantisLineage);
    consumed.artifacts.runner.sha256 = M.VALANTIS_PREDECESSOR.runner;
    consumed.predecessorBindings.step2sDiagnosticSha256 = h("f");
    await writeJson(root, built.options.valantisLineage, consumed);
    let result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    ok(result.state.branches.valantis.blockers.includes("VALANTIS_CONSUMED_LINEAGE_HASH_REJECTED"));
    ok(result.state.branches.valantis.blockers.includes("VALANTIS_STEP2S_DIAGNOSTIC_BINDING_INVALID"));
    const bindingCases = [
      ["step2sRunnerSha256", "VALANTIS_STEP2S_RUNNER_BINDING_INVALID"],
      ["step2sAuthoritySha256", "VALANTIS_STEP2S_AUTHORITY_BINDING_INVALID"],
      ["step2sPackageSha256", "VALANTIS_STEP2S_PACKAGE_BINDING_INVALID"],
    ];
    for (const [field, code] of bindingCases) {
      const lineage = clone(built.fixtures.valantisLineage);
      lineage.predecessorBindings[field] = h("f");
      ok(M.validateValantisLineage(lineage, NOW).blockers.includes(code));
    }
    const capability = clone(built.fixtures.valantisCapability);
    capability.sourceLineageDigest = h("e");
    capability.lineageId = "wrong-lineage";
    await writeJson(root, built.options.valantisLineage, built.fixtures.valantisLineage);
    await writeJson(root, built.options.valantisCapability, capability);
    result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    ok(result.state.branches.valantis.blockers.includes("VALANTIS_CAPABILITY_LINEAGE_BINDING_MISMATCH"));
    ok(result.state.branches.valantis.blockers.includes("VALANTIS_CAPABILITY_LINEAGE_ID_MISMATCH"));
    const wrongLineagePath = `${M.EVIDENCE_ROOT}/manifests/wrong-valantis-lineage.json`;
    const wrongCapabilityPath = `${M.EVIDENCE_ROOT}/manifests/wrong-valantis-capability.json`;
    await writeJson(root, wrongLineagePath, built.fixtures.valantisLineage);
    await writeJson(root, wrongCapabilityPath, built.fixtures.valantisCapability);
    result = await M.evaluate({ ...built.options, valantisLineage: wrongLineagePath, valantisCapability: wrongCapabilityPath }, { root, now: () => new Date(NOW) });
    ok(result.state.branches.valantis.blockers.includes("VALANTIS_LINEAGE_FILENAME_INVALID"));
    ok(result.state.branches.valantis.blockers.includes("VALANTIS_CAPABILITY_FILENAME_INVALID"));
  });

  await test("Valantis rejects consumed capability digest and duplicate actual descriptor digests", async () => {
    const root = await makeRoot("valantis-complete-digest-set");
    const built = await buildPositive(root);
    const capabilityDigest = M.sha256(await fsp.readFile(absolute(root, built.options.valantisCapability)));
    M.CONSUMED_VALANTIS_HASHES.add(capabilityDigest);
    try {
      const consumed = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
      equal(consumed.state.branches.valantis.status, "HOLD");
      ok(consumed.state.branches.valantis.blockers.includes("VALANTIS_CONSUMED_LINEAGE_HASH_REJECTED"));
    } finally {
      M.CONSUMED_VALANTIS_HASHES.delete(capabilityDigest);
    }

    const lineage = clone(built.fixtures.valantisLineage);
    const runnerBytes = await fsp.readFile(absolute(root, lineage.artifacts.runner.path));
    await fsp.writeFile(absolute(root, lineage.artifacts.test.path), runnerBytes);
    lineage.artifacts.test.sha256 = lineage.artifacts.runner.sha256;
    const lineageRecord = await writeJson(root, built.options.valantisLineage, lineage);
    const capability = clone(built.fixtures.valantisCapability);
    capability.sourceLineageDigest = lineageRecord.sha256;
    await writeJson(root, built.options.valantisCapability, capability);
    const duplicate = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    equal(duplicate.state.branches.valantis.status, "HOLD");
    ok(duplicate.state.branches.valantis.blockers.includes("VALANTIS_LINEAGE_HASHES_NOT_DISTINCT"));
  });

  await test("Valantis capability fails stale, nonmaterial, chain, header, terminal, group, provider, and authorization gates", async () => {
    const root = await makeRoot("valantis-capability-gates");
    const built = await buildPositive(root);
    const cases = [
      ["VALANTIS_CAPABILITY_OBSERVATION_NOT_FRESH", (v) => { v.observedAt = new Date(NOW - M.MAX_EVIDENCE_AGE_MS - 1).toISOString(); }],
      ["VALANTIS_MATERIAL_NEW_EVIDENCE_REQUIRED", (v) => { v.materialNewEvidence = false; }],
      ["VALANTIS_CHAIN_ID_INVALID", (v) => { v.chainId = 1; }],
      ["VALANTIS_FINALIZED_HASH_INVALID", (v) => { v.identicalFinalizedBlock.hash = "bad"; }],
      ["VALANTIS_FINALIZED_STATE_ROOT_INVALID", (v) => { v.identicalFinalizedBlock.stateRoot = "bad"; }],
      ["VALANTIS_TERMINAL_RECHECK_REQUIRED", (v) => { v.terminalRecheck = false; }],
      ["VALANTIS_GROUPS_NOT_DISTINCT", (v) => { v.distinctGroups = false; }],
      ["VALANTIS_FINALIZED_HEADERS_NOT_IDENTICAL", (v) => { v.identicalFinalizedHeader = false; }],
      ["VALANTIS_OPAQUE_GROUPS_INVALID", (v) => { v.opaqueGroupCount = 1; }],
      ["VALANTIS_PROVIDER_MATERIAL_PRESENT", (v) => { v.providerMaterialAbsent = false; }],
      ["VALANTIS_NETWORK_AUTHORIZATION_REJECTED", (v) => { v.networkCaptureAuthorized = true; }],
    ];
    for (const [code, mutate] of cases) {
      const capability = clone(built.fixtures.valantisCapability);
      mutate(capability);
      await writeJson(root, built.options.valantisCapability, capability);
      const result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
      equal(result.state.branches.valantis.status, "HOLD");
      ok(result.state.branches.valantis.blockers.includes(code), code);
    }
  });

  await test("Valantis explicit capability expiry controls output validity and state remains secret-free", async () => {
    const root = await makeRoot("valantis-expiry");
    const built = await buildPositive(root);
    const capability = clone(built.fixtures.valantisCapability);
    capability.expiresAt = new Date(NOW + 30 * 60 * 1000).toISOString();
    await writeJson(root, built.options.valantisCapability, capability);
    let result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    equal(result.state.branches.valantis.status, "REOPEN_CANDIDATE");
    equal(result.state.branches.valantis.validUntil, capability.expiresAt);
    equal(result.state.validUntil, capability.expiresAt);
    const serialized = M.canonicalJson(result.state);
    equal(serialized.includes(capability.reviewerId), false);
    equal(serialized.includes(capability.identicalFinalizedBlock.hash), false);
    equal(/https?:\/\//i.test(serialized), false);
    result = await M.evaluate(built.options, { root, now: () => new Date(Date.parse(capability.expiresAt)) });
    equal(result.state.branches.valantis.status, "HOLD");
    equal(result.state.branches.valantis.validUntil, null);
    ok(result.state.branches.valantis.blockers.includes("VALANTIS_CAPABILITY_EXPIRY_INVALID"));
  });

  await test("future and stale evidence timestamps hold branches", async () => {
    const root = await makeRoot("freshness");
    const built = await buildPositive(root);
    const future = clone(built.fixtures.renzoLineage); future.observedAt = new Date(NOW + 1).toISOString();
    await writeJson(root, built.options.renzoLineage, future);
    const stale = clone(built.fixtures.fraxlend); stale.observedAt = new Date(NOW - M.MAX_EVIDENCE_AGE_MS - 1).toISOString();
    await writeJson(root, built.options.fraxlendManifest, stale);
    const result = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    equal(result.state.branches.renzo.status, "HOLD");
    equal(result.state.branches.fraxlend.status, "HOLD");
    ok(result.state.branches.renzo.blockers.includes("RENZO_OBSERVATION_NOT_FRESH"));
    ok(result.state.branches.fraxlend.blockers.includes("FRAXLEND_OBSERVATION_NOT_FRESH"));
  });

  await test("branch-scoped malformed current input is HOLD with bounded prior metadata", async () => {
    const root = await makeRoot("history");
    const built = await buildPositive(root);
    const first = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    await M.publishAtomic(root, first.state, M.DEFAULT_OUTPUT, { now: NOW });
    await fsp.writeFile(absolute(root, built.options.fraxlendManifest), "{malformed");
    const secondNow = NOW + 60_000;
    const second = await M.evaluate(built.options, { root, now: () => new Date(secondNow) });
    equal(second.state.branches.renzo.status, "REOPEN_CANDIDATE");
    equal(second.state.branches.fraxlend.status, "HOLD");
    equal(second.state.branches.uniswapx.status, "REOPEN_CANDIDATE");
    equal(second.state.branches.valantis.status, "REOPEN_CANDIDATE");
    ok(second.state.branches.fraxlend.blockers.includes("FRAXLEND_MANIFEST_MALFORMED_JSON"));
    equal(second.state.branches.fraxlend.priorValidatedObservation.observedAt, AT);
    equal(second.state.branches.fraxlend.priorValidatedObservation.expiresAt, new Date(NOW + M.HISTORY_TTL_MS).toISOString());
    equal(second.state.branches.fraxlend.priorValidatedObservation.advisory, M.HISTORICAL_ADVISORY);
  });

  await test("expired prior metadata is removed and never restores current candidate", async () => {
    const root = await makeRoot("history-expired");
    const built = await buildPositive(root);
    const first = await M.evaluate(built.options, { root, now: () => new Date(NOW) });
    await M.publishAtomic(root, first.state, M.DEFAULT_OUTPUT, { now: NOW });
    const expired = await M.evaluate({}, { root, now: () => new Date(NOW + M.HISTORY_TTL_MS + 1) });
    for (const name of ["renzo", "fraxlend", "uniswapx", "valantis"]) {
      equal(expired.state.branches[name].status, "HOLD");
      equal(expired.state.branches[name].priorValidatedObservation, null);
    }
  });

  await test("safe artifact reader rejects hard links and symlinks/reparse", async () => {
    const root = await makeRoot("links");
    const source = absolute(root, `${M.EVIDENCE_ROOT}/artifacts/source.bin`);
    await fsp.mkdir(path.dirname(source), { recursive: true }); await fsp.writeFile(source, "source");
    const hardRel = `${M.EVIDENCE_ROOT}/artifacts/hard.bin`;
    await fsp.link(source, absolute(root, hardRel));
    await rejects(() => M.readSafeBytes(root, hardRel, 100), (error) => error.code === "INPUT_UNSAFE");
    const symRel = `${M.EVIDENCE_ROOT}/artifacts/sym.bin`;
    try {
      await fsp.symlink(source, absolute(root, symRel), "file");
      await rejects(() => M.readSafeBytes(root, symRel, 100), (error) => error.code === "INPUT_UNSAFE");
      symlinkCoverage = "passed";
    } catch (error) {
      if (!["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) throw error;
      symlinkCoverage = `skipped-${error.code}`; ok(true);
    }
  });

  await test("positional reader rejects concurrent growth and charges only verified bytes", async () => {
    const root = await makeRoot("growth");
    const relative = `${M.EVIDENCE_ROOT}/artifacts/growing.bin`;
    await writeBytes(root, relative, Buffer.from("fixed-size"));
    const budget = new M.ReadBudget(1024);
    await rejects(() => M.readSafeBytes(root, relative, 1024, true, budget, {
      afterReserve: ({ file }) => { fs.appendFileSync(file, "trailing"); },
    }), (error) => error.code === "INPUT_TRAILING_DATA");
    equal(budget.used, 0);
    equal(budget.reserved, 0);

    await fsp.writeFile(absolute(root, relative), "fixed-size");
    const secondBudget = new M.ReadBudget(1024);
    await rejects(() => M.readSafeBytes(root, relative, 1024, true, secondBudget, {
      afterExactRead: ({ file }) => { fs.appendFileSync(file, "late-trailing"); },
    }), (error) => error.code === "INPUT_TRAILING_DATA");
    equal(secondBudget.used, 0);
    equal(secondBudget.reserved, 0);

    await fsp.writeFile(absolute(root, relative), "verified");
    const successBudget = new M.ReadBudget(1024);
    const record = await M.readSafeBytes(root, relative, 1024, true, successBudget);
    equal(record.bytes.toString("utf8"), "verified");
    equal(successBudget.used, Buffer.byteLength("verified"));
    equal(successBudget.reserved, 0);
  });

  await test("atomic publication is canonical and rejects destination replacement/failure", async () => {
    const root = await makeRoot("publication");
    const built = await buildPositive(root);
    const state = (await M.evaluate(built.options, { root, now: () => new Date(NOW) })).state;
    const stages = [];
    await M.publishAtomic(root, state, M.DEFAULT_OUTPUT, { now: NOW, onPublicationStage: (stage) => stages.push(stage) });
    deepEqual(stages, ["temp-fsynced", "before-rename", "renamed"]);
    const output = absolute(root, M.DEFAULT_OUTPUT);
    equal(await fsp.readFile(output, "utf8"), `${M.canonicalJson(state)}\n`);
    const original = await fsp.readFile(output);
    await rejects(() => M.publishAtomic(root, state, M.DEFAULT_OUTPUT, {
      now: NOW,
      onPublicationStage: (stage, destination) => {
        if (stage === "before-rename") { fs.unlinkSync(destination); fs.writeFileSync(destination, "replacement"); }
      },
    }), (error) => error.code === "PUBLICATION_DESTINATION_CHANGED");
    equal(await fsp.readFile(output, "utf8"), "replacement");
    await fsp.writeFile(output, original);
    await rejects(() => M.publishAtomic(root, state, M.DEFAULT_OUTPUT, {
      now: NOW, onPublicationStage: (stage) => { if (stage === "temp-fsynced") throw new Error("injected"); },
    }), (error) => error.code === "PUBLICATION_FAILED");
    deepEqual(await fsp.readFile(output), original);
    deepEqual((await fsp.readdir(path.dirname(output))).filter((x) => x.endsWith(".tmp")), []);
  });

  await test("lock staging, collision, stale reclaim and ownership-safe release", async () => {
    const root = await makeRoot("locks");
    const release = await M.acquireLock(root, M.DEFAULT_OUTPUT, { now: NOW });
    await rejects(() => M.acquireLock(root, M.DEFAULT_OUTPUT, { now: NOW }), (error) => error.code === "MONITOR_ALREADY_RUNNING");
    equal(await release(), true);
    equal(await release(), false);
    const monitorDir = path.dirname(absolute(root, M.DEFAULT_OUTPUT));
    const canonical = path.join(monitorDir, ".blocked-branch-reopen-monitor.lock");
    await fsp.mkdir(canonical);
    const stale = { createdAt: new Date(NOW - 20 * 60_000).toISOString(), expiresAt: new Date(NOW - 5 * 60_000).toISOString(), nonce: crypto.randomUUID(), pid: 2147483647 };
    await fsp.writeFile(path.join(canonical, "owner.json"), `${JSON.stringify(stale)}\n`);
    const staleRelease = await M.acquireLock(root, M.DEFAULT_OUTPUT, { now: NOW });
    equal(await staleRelease(), true);
  });

  await test("ownerless/malformed stale staging is bounded; uncertain canonical is untouched", async () => {
    const root = await makeRoot("staging");
    await fsp.mkdir(path.dirname(absolute(root, M.DEFAULT_OUTPUT)));
    const dir = path.dirname(absolute(root, M.DEFAULT_OUTPUT));
    const old = new Date(NOW - M.LOCK_TTL_MS - 1000);
    const ownerless = path.join(dir, `.blocked-branch-reopen-monitor.lock.staging.999.${crypto.randomUUID()}`);
    const malformed = path.join(dir, `.blocked-branch-reopen-monitor.lock.staging.998.${crypto.randomUUID()}`);
    await fsp.mkdir(ownerless); await fsp.utimes(ownerless, old, old);
    await fsp.mkdir(malformed); await fsp.writeFile(path.join(malformed, "owner.json"), "bad"); await fsp.utimes(malformed, old, old);
    equal(await M.cleanStaleStaging(root, M.DEFAULT_OUTPUT, NOW), 2);
    equal(fs.existsSync(ownerless), false); equal(fs.existsSync(malformed), false);
    const canonical = path.join(dir, ".blocked-branch-reopen-monitor.lock");
    await fsp.mkdir(canonical);
    await rejects(() => M.acquireLock(root, M.DEFAULT_OUTPUT, { now: NOW }), (error) => error.code === "MONITOR_ALREADY_RUNNING");
    ok(fs.existsSync(canonical));
    await fsp.rmdir(canonical);
    await fsp.mkdir(canonical); await fsp.writeFile(path.join(canonical, "owner.json"), "{malformed");
    await rejects(() => M.acquireLock(root, M.DEFAULT_OUTPUT, { now: NOW }), (error) => error.code === "MONITOR_ALREADY_RUNNING");
    ok(fs.existsSync(path.join(canonical, "owner.json")));
  });

  await test("release quarantine mismatch never deletes uncertain ownership", async () => {
    const root = await makeRoot("release-mismatch");
    let quarantinePath = null;
    const release = await M.acquireLock(root, M.DEFAULT_OUTPUT, {
      now: NOW,
      releaseDependencies: {
        afterReleaseRename: (quarantine) => {
          quarantinePath = quarantine;
          const ownerPath = path.join(quarantine, "owner.json");
          const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")); owner.nonce = crypto.randomUUID();
          fs.writeFileSync(ownerPath, JSON.stringify(owner));
        },
      },
    });
    equal(await release(), false);
    ok(quarantinePath !== null && fs.existsSync(quarantinePath));
    ok(fs.existsSync(path.join(quarantinePath, "owner.json")));
  });

  await test("CLI always emits HOLD or REOPEN_CANDIDATE status contract", async () => {
    let output = "";
    let result = await M.runCli(["--unknown"], { writeStdout: (text) => { output += text; } });
    equal(result.exitCode, 2); equal(JSON.parse(output).status, "HOLD"); ok(Boolean(JSON.parse(output).errorClass));
    const root = await makeRoot("cli"); output = "";
    result = await M.runCli(["--once", "--check-only"], { root, now: () => new Date(NOW), writeStdout: (text) => { output += text; } });
    equal(result.exitCode, 0); equal(JSON.parse(output).status, "HOLD");
    output = "";
    result = await M.runCli(["--once"], { root, now: () => new Date(NOW), acquireLock: async () => { throw new M.MonitorError("LOCK_TEST_FAILURE"); }, writeStdout: (text) => { output += text; } });
    equal(result.exitCode, 1); equal(JSON.parse(output).status, "HOLD"); equal(JSON.parse(output).errorClass, "LOCK_TEST_FAILURE");
  });

  await test("watch remains local and emits only allowed status", async () => {
    const root = await makeRoot("watch");
    const signalTarget = new EventEmitter(); let output = ""; let sleeps = 0;
    await M.runWatch({ checkOnly: true, intervalSeconds: 30 }, {
      root, now: () => new Date(NOW), signalTarget, writeStdout: (text) => { output += text; },
      sleep: async (_ms, register) => { sleeps += 1; register(() => {}); signalTarget.emit("SIGTERM"); },
    }, async () => true);
    equal(sleeps, 1); equal(JSON.parse(output).status, "HOLD"); equal(JSON.parse(output).networkCalls, 0);
  });

  await test("launcher statically enforces sole Node boundary and bounded HOLD failure", async () => {
    const source = await fsp.readFile(path.join(__dirname, "start-blocked-branch-reopen-monitor.ps1"), "utf8");
    ok(source.includes("sole process boundary"));
    ok(source.includes("Get-Command node.exe -CommandType Application"));
    ok(source.includes("ReparsePoint"));
    ok(source.includes('[Environment]::SetEnvironmentVariable("NODE_OPTIONS", $null, "Process")'));
    ok(source.includes('[Environment]::SetEnvironmentVariable("NODE_PATH", $null, "Process")'));
    ok(source.includes('"status":"HOLD"'));
    ok(source.includes("[object]$IntervalSeconds"));
    ok(source.includes("[long]::TryParse"));
    ok(source.includes("$parsedInterval -lt 30 -or $parsedInterval -gt 86400"));
    ok(source.includes("host-level parameter-binding boundary"));
    ok(source.includes("--local-storage-attestation"));
    ok(source.includes("--valantis-successor-lineage"));
    ok(source.includes("--valantis-finality-capability"));
    ok(source.includes("$ValantisSuccessorLineage"));
    ok(source.includes("$ValantisFinalityCapability"));
    equal(/ValidateRange|\[int\]\$IntervalSeconds/.test(source), false);
    equal(/Start-Process|Invoke-Expression|cmd\.exe/i.test(source), false);
    equal(/REOPENED|route[-_ ]?positive/i.test(source), false);
  });

  ok(assertions >= 100, `assertion count ${assertions}`);
  process.stdout.write(`RESULT: ${tests} tests passed; ${assertions} deterministic assertions; symlink=${symlinkCoverage}; networkCalls=0; childProcesses=0\n`);
})().catch((error) => {
  process.stderr.write(`FAIL after ${tests} tests / ${assertions} assertions: ${error.stack || error}\n`);
  process.exitCode = 1;
});
