"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  EXPECTED_RUNTIME_LENGTH,
  EXPECTED_RUNTIME_SHA256,
  REQUIRED_ARTIFACT_SHA256,
  REQUIRED_REPORT_SHA256,
  REQUIRED_R2_BASENAME,
  REQUIRED_R2_MANIFEST_SHA256,
  SELECTORS,
  STAGE2C_TIER,
  assertInputsUnchanged,
  assertMandatoryNonpromotion,
  assertSanitizedBundle,
  validateArtifactObject,
  validatePoolManagerCallSurface,
  validateSourceReport,
  validateTraceCompleteness,
  v4ClaimsBind,
  verifyAnchors,
  verifySourceCheckout,
} = require("../atomic/ethereum-top-trades-7d-reconstruction/morpho-funded-arbitrage-v4-claims-binder");
const { atomicBundle } = require("../atomic/ethereum-top-trades-7d-reconstruction/output");
const { argumentsOf, atomicWriteOptions, safeTerminalCode } = require("../atomic/ethereum-top-trades-7d-reconstruction/run");

const ROOT = path.join(__dirname, "..", "..");
const REPORT_PARENT = path.join(ROOT, "reports", "raw", "fast", "atomic-ethereum-top-trades-7d-reconstruction");
const STAGE1 = path.join(REPORT_PARENT, "morpho-stage1-2026-08-26T02-25-32-196Z-8e901119");
const R2 = path.join(REPORT_PARENT, REQUIRED_R2_BASENAME);
let cachedAnchors;
function anchors() { if (!cachedAnchors) cachedAnchors = verifyAnchors(STAGE1, R2); return cachedAnchors; }

test("Stage2C V4 closure CLI is explicit, offline-only, and sanitized", () => {
  const parsed = argumentsOf(["--morpho-funded-arbitrage-v4-claims-binder", "--source-dir", STAGE1]);
  assert.equal(parsed.mode, "morpho-stage2c-v4-claims");
  assert.throws(() => argumentsOf(["--morpho-funded-arbitrage-v4-claims-binder"]), /requires-source/);
  assert.throws(() => argumentsOf(["--morpho-funded-arbitrage-v4-claims-binder", "--source-dir", STAGE1, "--traces"]), /rejects-other-mode-options/);
  assert.equal(safeTerminalCode(new Error("stage2c-source-runtime-mismatch")), "stage2c-source-runtime-mismatch");
});

test("immutable real Stage1 and accepted R2 anchors validate offline", () => {
  const fixed = anchors();
  assert.equal(fixed.stage1.manifestSha256, "784a5962514a0d1f245afd8266403acd73ec607b2bf281652de017aadfb9eee6");
  assert.equal(fixed.r2.manifestSha256, REQUIRED_R2_MANIFEST_SHA256);
  assert.equal(fixed.r2.poolManager.codeHashSha256, `0x${EXPECTED_RUNTIME_SHA256}`);
  assert.equal(fixed.r2.poolManager.codeLength, EXPECTED_RUNTIME_LENGTH);
  assert.equal(fixed.r2.poolManager.twoFamilyEquality, true);
  assert.equal(validateTraceCompleteness(fixed.stage1), true);
});

test("clean exact source, pinned report, compiler artifact, and sole immutable validate independently", () => {
  const report = validateSourceReport(); const source = verifySourceCheckout();
  assert.equal(report.file.sha256, REQUIRED_REPORT_SHA256);
  assert.equal(source.artifactFile.sha256, REQUIRED_ARTIFACT_SHA256);
  assert.equal(source.commit, "e50237c43811bd9b526eff40f26772152a42daba");
  assert.equal(source.tree, "4b4f7d275f3733c3079643eba8624ecb9e4ba079");
  assert.equal(source.submodules.length, 7); assert.equal(Object.keys(source.sourceFiles).length, 44);
  assert.deepEqual(source.references.map(({ offset, length }) => ({ offset, length })), [{ offset: 13606, length: 32 }]);
  assert.equal(source.template.length, EXPECTED_RUNTIME_LENGTH); assert.equal(source.instantiated.length, EXPECTED_RUNTIME_LENGTH);
});

test("real PoolManager call surface closes every involving frame and exact successful unlock", () => {
  const result = validatePoolManagerCallSurface(anchors().stage1);
  assert.equal(result.exact, true); assert.equal(result.relatedFrameCount, 11); assert.equal(result.managerStorageFrameCount, 7); assert.equal(result.successfulUnlockCount, 1);
  assert.deepEqual(result.rows.map((row) => row.selector), [SELECTORS.unlock, "0x91dd7346", SELECTORS.swap, SELECTORS.exttload, SELECTORS.sync, "0x70a08231", SELECTORS.settle, "0x70a08231", SELECTORS.exttload, SELECTORS.take, "0xa9059cbb"]);
  assert.ok(result.rows.every((row) => JSON.stringify(Object.keys(row).sort()) === JSON.stringify(["classification", "path", "selector", "status", "type"])));
});

test("extra ERC-6909 claim-balance selectors fail closure", () => {
  for (const selector of [SELECTORS.mint, SELECTORS.burn, SELECTORS.transfer, SELECTORS.transferFrom]) {
    const stage1 = structuredClone(anchors().stage1); const frame = structuredClone(stage1.traceProjection.trace.frames.find((row) => row.selector === SELECTORS.swap));
    frame.path = `${frame.path}.claim`; frame.selector = selector; stage1.traceProjection.trace.frames.push(frame);
    assert.throws(() => validatePoolManagerCallSurface(stage1), /stage2c-/);
  }
});

test("ERC-6909 approve and operator selectors fail authorization closure", () => {
  for (const selector of [SELECTORS.approve, SELECTORS.setOperator]) {
    const stage1 = structuredClone(anchors().stage1); const frame = stage1.traceProjection.trace.frames.find((row) => row.selector === SELECTORS.swap); frame.selector = selector;
    assert.throws(() => validatePoolManagerCallSurface(stage1), /stage2c-/);
  }
});

test("foreign delegatecall in PoolManager storage context fails closed", () => {
  const stage1 = structuredClone(anchors().stage1); const frame = stage1.traceProjection.trace.frames.find((row) => row.selector === SELECTORS.swap);
  frame.type = "DELEGATECALL"; frame.codeContext = "0x1111111111111111111111111111111111111111"; frame.calleeContext = frame.codeContext;
  assert.throws(() => validatePoolManagerCallSurface(stage1), /stage2c-/);
});

test("reverted or missing exact unlock cannot prove transient closure", () => {
  const reverted = structuredClone(anchors().stage1); const unlock = reverted.traceProjection.trace.frames.find((row) => row.selector === SELECTORS.unlock); unlock.ownStatus = "REVERTED"; unlock.effectiveStatus = "REVERTED"; unlock.revert.own = true;
  assert.throws(() => validatePoolManagerCallSurface(reverted), /stage2c-/);
  const missing = structuredClone(anchors().stage1); missing.traceProjection.trace.frames = missing.traceProjection.trace.frames.filter((row) => row.selector !== SELECTORS.unlock);
  assert.throws(() => validatePoolManagerCallSurface(missing), /stage2c-/);
});

test("incomplete roots and changed trace commitments are rejected", () => {
  const incomplete = structuredClone(anchors().stage1); incomplete.traceProjection.trace.rootBindingComplete = false;
  assert.throws(() => validateTraceCompleteness(incomplete), /trace-completeness/);
  const changed = structuredClone(anchors().stage1); changed.traceProjection.trace.traceCommitmentSha256 = `0x${"0".repeat(64)}`;
  assert.throws(() => validateTraceCompleteness(changed), /trace-completeness/);
  const changedFrame = structuredClone(anchors().stage1); changedFrame.traceProjection.trace.frames[0].frameCommitmentSha256 = `0x${"1".repeat(64)}`;
  assert.throws(() => validateTraceCompleteness(changedFrame), /trace-completeness/);
});

test("compiler settings, runtime template, and immutable mutations are rejected", () => {
  const source = verifySourceCheckout();
  const wrongSettings = structuredClone(source.artifact); wrongSettings.metadata.settings.optimizer.runs = 1;
  assert.throws(() => validateArtifactObject(wrongSettings), /compiler-settings/);
  const wrongImmutable = structuredClone(source.artifact); Object.values(wrongImmutable.deployedBytecode.immutableReferences)[0][0].start += 1;
  assert.throws(() => validateArtifactObject(wrongImmutable), /immutable-layout/);
  const wrongRuntime = structuredClone(source.artifact); wrongRuntime.deployedBytecode.object = `${wrongRuntime.deployedBytecode.object.slice(0, 4)}00${wrongRuntime.deployedBytecode.object.slice(6)}`;
  assert.throws(() => validateArtifactObject(wrongRuntime), /artifact-runtime/);
});

test("source, report, and artifact snapshot mutations fail unchanged checks", () => {
  const result = v4ClaimsBind({ stage1Directory: STAGE1 });
  for (const mutate of [
    (source) => { source.checkout.commit = "0".repeat(40); },
    (source) => { source.report.file.sha256 = "0".repeat(64); },
    (source) => { source.checkout.artifactFile.sha256 = "0".repeat(64); },
  ]) {
    const source = structuredClone(result.source); mutate(source); assert.throws(() => assertInputsUnchanged(source), /stage2c-/);
  }
});

test("production binder emits only the five sanitized closure files and remains nonpromotable", () => {
  const result = v4ClaimsBind({ stage1Directory: STAGE1 }); const verdict = result.bundle["stage2c-verdict.json"];
  assert.deepEqual(Object.keys(result.bundle), ["anchors.json", "source-binding.json", "poolmanager-call-surface.json", "v4-claims-closure.json", "stage2c-verdict.json"]);
  assert.equal(verdict.evidenceTier, STAGE2C_TIER); assert.equal(verdict.poolManagerSourceRuntimeExact, true); assert.equal(verdict.successfulUnlockTransientClosureExact, true);
  assert.equal(verdict.erc6909ClaimBalanceMutationExactZero, true); assert.equal(verdict.erc6909AuthorizationMutationExactZero, true); assert.equal(verdict.preexistingErc6909BalancesZero, "unknown");
  assert.equal(verdict.fullPerAddressAssetVectorExact, false); assert.equal(verdict.controlledClusterExact, false); assert.equal(verdict.scalarHistoricalNetExact, false); assert.equal(verdict.routePositive, "unknown"); assert.equal(verdict.currentExecutable, false); assert.equal(verdict.promotable, false);
  assert.ok(result.bundle["poolmanager-call-surface.json"].rows.every((row) => JSON.stringify(Object.keys(row).sort()) === JSON.stringify(["path", "selector", "status", "type"])));
  assert.doesNotThrow(() => assertSanitizedBundle(result.bundle, [result.source.checkout.template, result.source.checkout.instantiated]));
});

test("raw trace, calldata, bytecode, and user-path leakage are rejected", () => {
  const raw = Buffer.from("0123456789abcdef".repeat(4), "hex");
  assert.throws(() => assertSanitizedBundle({ persisted: raw.toString("hex") }, [raw]), /raw-leak/);
  assert.throws(() => assertSanitizedBundle({ rawTrace: {} }), /forbidden-field/);
  assert.throws(() => assertSanitizedBundle({ calldata: "0x" }), /forbidden-field/);
  assert.throws(() => assertSanitizedBundle({ sourcePath: "C:\\Users\\person\\source.sol" }), /raw-leak/);
  assert.throws(() => assertSanitizedBundle({ authorization: "secret" }), /credential-marker/);
});

test("mandatory nonpromotion gates cannot be relaxed", () => {
  const verdict = v4ClaimsBind({ stage1Directory: STAGE1 }).bundle["stage2c-verdict.json"];
  assert.doesNotThrow(() => assertMandatoryNonpromotion(verdict));
  for (const mutation of [{ promotable: true }, { routePositive: true }, { currentExecutable: true }, { fullPerAddressAssetVectorExact: true }, { controlledClusterExact: true }, { scalarHistoricalNetExact: true }, { preexistingErc6909BalancesZero: true }, { erc6909ClaimBalanceMutationExactZero: false }, { erc6909AuthorizationMutationExactZero: false }]) assert.throws(() => assertMandatoryNonpromotion({ ...verdict, ...mutation }), /nonpromotion-invariant/);
});

test("atomic write succeeds only while every anchored input remains unchanged", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stage2c-v4-atomic-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const result = v4ClaimsBind({ stage1Directory: STAGE1 }); const output = path.join(parent, "bundle");
  atomicBundle(output, result.bundle, atomicWriteOptions("morpho-stage2c-v4-claims", result)); assert.ok(fs.existsSync(path.join(output, "manifest.json")));
  const mutated = v4ClaimsBind({ stage1Directory: STAGE1 }); mutated.source.checkout.artifactFile.sha256 = "0".repeat(64); const rejected = path.join(parent, "rejected");
  assert.throws(() => atomicBundle(rejected, mutated.bundle, atomicWriteOptions("morpho-stage2c-v4-claims", mutated)), /stage2c-/); assert.equal(fs.existsSync(rejected), false); assert.equal(fs.readdirSync(parent).some((name) => name.startsWith("rejected.tmp-")), false);
});
