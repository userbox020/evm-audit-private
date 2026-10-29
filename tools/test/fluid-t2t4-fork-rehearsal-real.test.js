"use strict";
// Offline tests for the REAL Fluid T2/T4 fork rehearsal driver
// (tools/fluid-t2t4-fork-rehearsal-real.js).
//
// No side effects on import: the module guards main() behind require.main and only
// spawns anvil inside runRehearsal when the anvil binary exists. These tests never
// need anvil/forge, never touch the network, and never read keys or endpoints.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Interface, AbiCoder } = require(path.join(__dirname, "..", "node_modules", "ethers"));

const rehearsal = require("../fluid-t2t4-fork-rehearsal-real.js");

const LIQ_SIM_IFACE = new Interface([
  "error FluidLiquidateResult(uint256 colLiquidated, uint256 debtLiquidated)",
  "error FluidVaultError(uint256 id)",
]);

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fluid-t2t4-real-"));
  return path.join(dir, name || "result.json");
}

// ---------------------------------------------------------------------------
// 1. forge/anvil absent -> clean FAIL evidence file (no anvil, no network)
// ---------------------------------------------------------------------------
test("anvil absent -> clean FAIL evidence file with honest provenance and no secrets", async () => {
  const output = tmpFile();
  const candidate = rehearsal.defaultCandidate(null);
  const evidence = await rehearsal.runRehearsal({
    anvilPath: path.join(os.tmpdir(), "definitely-not-anvil-" + Date.now() + ".exe"),
    output,
    candidate,
    attemptId: "offline-anvil-missing",
  });

  assert.ok(fs.existsSync(output), "evidence file must be written");
  const onDisk = JSON.parse(fs.readFileSync(output, "utf8"));

  for (const doc of [evidence, onDisk]) {
    assert.equal(doc.schema, "rehearsal-evidence/v1");
    assert.equal(doc.label, rehearsal.LABEL);
    assert.equal(doc.label, "REHEARSAL_EVIDENCE_NOT_AUTHORIZATION");
    assert.equal(doc.verdict.state, "FAIL");
    assert.equal(doc.verdict.reason, "ANVIL_MISSING");
    assert.equal(doc.provenance.REALFORK, true);
    assert.equal(doc.provenance.forkLocalOnly, true);
    assert.equal(doc.provenance.upstreamBroadcast, false);
    assert.equal(doc.provenance.keysRead, false);
    assert.equal(doc.provenance.signedActionJustified, false);
    assert.equal(doc.provenance.endpointProcessOnly, true);
    assert.equal(doc.cleanup, "clean");
    assert.deepEqual(rehearsal.validateEvidenceShape(doc), { ok: true, errors: [] });
    assert.deepEqual(rehearsal.scanEvidenceForSecrets(doc), []);
  }
  fs.rmSync(path.dirname(output), { recursive: true, force: true });
});

test("requireForge with a missing forge binary also fails closed (ANVIL_MISSING)", async () => {
  const output = tmpFile();
  const evidence = await rehearsal.runRehearsal({
    anvilPath: __filename, // exists (any file passes the existence check)
    requireForge: true,
    forgePath: path.join(os.tmpdir(), "definitely-not-forge-" + Date.now() + ".exe"),
    output,
    attemptId: "offline-forge-missing",
  });
  assert.equal(evidence.verdict.state, "FAIL");
  assert.equal(evidence.verdict.reason, "ANVIL_MISSING");
  fs.rmSync(path.dirname(output), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 2. decoder handles FluidLiquidateResult / FluidVaultError (same as the trigger)
// ---------------------------------------------------------------------------
test("decodeLiqSimRevert decodes FluidLiquidateResult col/debt", () => {
  const data = LIQ_SIM_IFACE.encodeErrorResult("FluidLiquidateResult", [123n, 456n]);
  const decoded = rehearsal.decodeLiqSimRevert(data);
  assert.equal(decoded.name, "FluidLiquidateResult");
  assert.equal(decoded.colLiquidated, "123");
  assert.equal(decoded.debtLiquidated, "456");
  assert.match(decoded.text, /FluidLiquidateResult\(col=123,debt=456\)/);
});

test("decodeLiqSimRevert decodes FluidVaultError with the named id", () => {
  const data = LIQ_SIM_IFACE.encodeErrorResult("FluidVaultError", [31029n]);
  const decoded = rehearsal.decodeLiqSimRevert(data);
  assert.equal(decoded.name, "FluidVaultError");
  assert.equal(decoded.errorId, "31029");
  assert.equal(decoded.errorName, "Vault__InvalidLiquidation");
  assert.match(decoded.text, /Vault__InvalidLiquidation\(31029\)/);
});

test("decodeLiqSimRevert handles string reverts and unknown selectors", () => {
  const str = "0x08c379a0" + AbiCoder.defaultAbiCoder().encode(["string"], ["MIN_OUT_REQUIRED"]).slice(2);
  const decodedStr = rehearsal.decodeLiqSimRevert(str);
  assert.equal(decodedStr.name, "Error");
  assert.equal(decodedStr.text, "MIN_OUT_REQUIRED");

  const unknown = rehearsal.decodeLiqSimRevert("0xdeadbeef");
  assert.equal(unknown.name, null);
  assert.equal(unknown.text, "0xdeadbeef");
  assert.equal(unknown.colLiquidated, null);
  assert.equal(unknown.debtLiquidated, null);
});

// ---------------------------------------------------------------------------
// 3. result JSON shape validation
// ---------------------------------------------------------------------------
test("validateEvidenceShape accepts FAIL evidence and rejects malformed shapes", () => {
  const good = rehearsal.buildFailEvidence({ reason: "ANVIL_MISSING", stage: "SETUP" });
  assert.deepEqual(rehearsal.validateEvidenceShape(good), { ok: true, errors: [] });

  const badSchema = { ...good, schema: "wrong" };
  assert.ok(rehearsal.validateEvidenceShape(badSchema).errors.includes("schema"));

  const badLabel = { ...good, label: "AUTHORIZED" };
  assert.ok(rehearsal.validateEvidenceShape(badLabel).errors.includes("label"));

  const badProvenance = { ...good, provenance: { ...good.provenance, signedActionJustified: true } };
  assert.ok(rehearsal.validateEvidenceShape(badProvenance).errors.includes("provenance.signedActionJustified"));

  const badVerdict = { ...good, verdict: { state: "MAYBE", reason: "" } };
  const errs = rehearsal.validateEvidenceShape(badVerdict).errors;
  assert.ok(errs.includes("verdict.state"));
  assert.ok(errs.includes("verdict.reason"));

  // PASS requires pin/executor codehash/realizedNet/receiptStatus
  const passIncomplete = { ...good, verdict: { state: "PASS", reason: "x", stage: "EXECUTE" } };
  const passErrs = rehearsal.validateEvidenceShape(passIncomplete).errors;
  assert.ok(passErrs.includes("pin.block"));
  assert.ok(passErrs.includes("executor.codehash"));
  assert.ok(passErrs.includes("realizedNet.rawDebtToken"));
  assert.ok(passErrs.includes("execution.receiptStatus"));

  const passComplete = {
    ...good,
    pin: { block: 1, hash: "0x" + "1".repeat(64) },
    executor: { codehash: "0x" + "2".repeat(64) },
    realizedNet: { rawDebtToken: "5" },
    execution: { receiptStatus: "0x1" },
    verdict: { state: "PASS", reason: "REALIZED_NET_POSITIVE_ON_REAL_EXECUTOR_BYTECODE", stage: "EXECUTE" },
  };
  assert.deepEqual(rehearsal.validateEvidenceShape(passComplete), { ok: true, errors: [] });
});

// ---------------------------------------------------------------------------
// 4. no secrets in output (64-hex keys, endpoint urls, secret fields)
// ---------------------------------------------------------------------------
test("scanEvidenceForSecrets flags stray 64-hex, urls, and secret fields; allows known hashes", () => {
  const clean = rehearsal.buildFailEvidence({ reason: "ANVIL_MISSING", stage: "SETUP" });
  assert.deepEqual(rehearsal.scanEvidenceForSecrets(clean), []);

  // allowed 32-byte hashes (pin hash / codehash / tx hash) must NOT be flagged
  const withHashes = {
    ...clean,
    pin: { block: 1, hash: "0x" + "a".repeat(64) },
    executor: { codehash: "0x" + "b".repeat(64), artifactRuntimeKeccak: "0x" + "c".repeat(64) },
    execution: { txHash: "0x" + "d".repeat(64) },
  };
  assert.deepEqual(rehearsal.scanEvidenceForSecrets(withHashes), []);

  const strayKey = { ...clean, candidate: { ...clean.candidate, vault: "0x" + "e".repeat(64) } };
  assert.ok(rehearsal.scanEvidenceForSecrets(strayKey).some((f) => f.kind === "64hex"));

  const withUrl = { ...clean, candidate: { ...clean.candidate, note: "https://rpc.example.invalid/secret" } };
  assert.ok(rehearsal.scanEvidenceForSecrets(withUrl).some((f) => f.kind === "url"));

  const withSecret = { ...clean, privateKey: "0x" + "f".repeat(64) };
  assert.ok(rehearsal.scanEvidenceForSecrets(withSecret).some((f) => f.kind === "secret-field"));
});

test("the serialized evidence contains no endpoint urls or 64-hex outside the allowed hash fields", () => {
  const evidence = rehearsal.buildFailEvidence({
    reason: "ANVIL_MISSING",
    stage: "SETUP",
    pin: { block: 1, hash: "0x" + "a".repeat(64) },
    executor: { codehash: "0x" + "b".repeat(64) },
  });
  const text = JSON.stringify(evidence);
  assert.doesNotMatch(text, /https?:\/\//i);
  assert.deepEqual(rehearsal.scanEvidenceForSecrets(evidence), []);
});
