"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  CAPTURE_DIRECTORY, DERIVED_TIER, EXTSLOAD_SELECTOR, HOOK, LOCKER, POOL_MANAGER, REQUIRED_FILES, SOURCE_PINS, TARGET_HASH,
  adjudicateFixture, adjudicateProduction, assertMandatoryNonpromotion, assertNoEndpointEnvironment, assertSanitizedBundle, parseCli, writeDerivedBundle,
} = require("../atomic/ethereum-top-trades-7d-reconstruction/v4-native-claim-gate0-offline-adjudicator");

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fact(filename) { const bytes = fs.readFileSync(filename); return { bytes: bytes.length, sha256: sha256(bytes) }; }
function writeJson(filename, value) { fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`); }
function git(directory, args) { const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", windowsHide: true }); assert.equal(result.status, 0, result.stderr); return String(result.stdout || "").trim(); }

function repinCapture(directory) {
  const files = {};
  for (const name of REQUIRED_FILES.filter((row) => row !== "manifest.json")) files[name] = fact(path.join(directory, name));
  writeJson(path.join(directory, "manifest.json"), { atomicVisibility: true, durabilityClaimed: false, endpointFree: true, files, schemaVersion: 1 });
  return { basename: path.basename(directory), manifest: fact(path.join(directory, "manifest.json")), files };
}

function makeSource(parent, anchor) {
  const directory = path.join(parent, "isolated-extsload-source"); fs.mkdirSync(path.join(directory, "src"), { recursive: true }); fs.mkdirSync(path.join(directory, "out", "PoolManager.sol"), { recursive: true });
  const pool = 'pragma solidity 0.8.26;\nimport {Extsload} from "./Extsload.sol";\ncontract PoolManager is Extsload { }\n';
  const extsload = 'pragma solidity ^0.8.0;\ninterface IExtsload {}\nabstract contract Extsload is IExtsload {\nfunction extsload(bytes32 slot) external view returns (bytes32) {\nassembly ("memory-safe") {\nmstore(0, sload(slot))\nreturn(0, 0x20)\n}\n}\n}\n';
  fs.writeFileSync(path.join(directory, "src", "PoolManager.sol"), pool); fs.writeFileSync(path.join(directory, "src", "Extsload.sol"), extsload); fs.writeFileSync(path.join(directory, "out", "PoolManager.sol", "PoolManager.json"), "fixture-artifact\n");
  git(directory, ["init", "--quiet"]); git(directory, ["add", "."]); git(directory, ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "-m", "fixture"]); const commit = git(directory, ["rev-parse", "HEAD"]); const tree = git(directory, ["rev-parse", "HEAD^{tree}"]);
  const reportFile = path.join(parent, "isolated-source-report.json"); fs.writeFileSync(reportFile, "fixture-report\n");
  const pins = { basename: path.basename(directory), commit, tree, report: fact(reportFile), artifact: fact(path.join(directory, "out", "PoolManager.sol", "PoolManager.json")), poolManagerSource: fact(path.join(directory, "src", "PoolManager.sol")), extsloadSource: fact(path.join(directory, "src", "Extsload.sol")), runtime: structuredClone(SOURCE_PINS.runtime), artifactRelative: "out/PoolManager.sol/PoolManager.json" };
  anchor.poolManagerSourceProvenance = { artifact: pins.artifact, checkout: { basename: pins.basename, commit, tree }, compiler: anchor.poolManagerSourceProvenance.compiler, report: pins.report, runtime: pins.runtime };
  return { directory, reportFile, pins };
}

function setup(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gate0-adjudicator-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const capture = path.join(parent, "isolated-gate0-capture"); fs.mkdirSync(capture); for (const name of REQUIRED_FILES) fs.copyFileSync(path.join(CAPTURE_DIRECTORY, name), path.join(capture, name));
  const anchorFile = path.join(capture, "source-anchor.json"); const anchor = JSON.parse(fs.readFileSync(anchorFile, "utf8")); const source = makeSource(parent, anchor); writeJson(anchorFile, anchor);
  const fixture = { capturePins: repinCapture(capture), sourceOptions: source }; return { parent, capture, source, fixture, options: { inputDirectory: capture } };
}
function adjudicate(made) { return adjudicateFixture(made.options, made.fixture); }
function mutateJson(made, filename, mutation) { const target = path.join(made.capture, filename); const value = JSON.parse(fs.readFileSync(target, "utf8")); mutation(value); writeJson(target, value); made.fixture.capturePins = repinCapture(made.capture); }
function unknownFrame(trace, pathValue = "0.0.0.0") { return trace.relatedFrames.find((row) => row.path === pathValue); }

test("offline adjudicator CLI is exact, endpoint-environment rejecting, and collector-free", async () => {
  assert.deepEqual(parseCli(["--input-dir", "in", "--output-dir", "out"]), { inputDirectory: "in", outputDirectory: "out" }); assert.throws(() => parseCli(["--input-dir", "in", "--rpc-url", "x", "--output-dir", "out"]), /cli-options-invalid/); assert.throws(() => parseCli(["--input-dir", "same", "--output-dir", "same"]), /output-must-be-separate/);
  assert.equal(assertNoEndpointEnvironment({}), true); for (const name of ["RPC_URL", "ETH_RPC_URL", "WEB3_PROVIDER_URI", "RPC_ENDPOINTS_FILE", "HTTP_PROXY"]) assert.throws(() => assertNoEndpointEnvironment({ [name]: "redacted" }), /endpoint-environment-rejected/);
  assert.throws(() => adjudicateProduction({ inputDirectory: "not-the-capture" }), /exact-capture-required/); assert.throws(() => adjudicateProduction({ inputDirectory: CAPTURE_DIRECTORY, sourceFacts: {} }), /production-options-invalid/);
  const source = fs.readFileSync(path.join(__dirname, "../atomic/ethereum-top-trades-7d-reconstruction/v4-native-claim-gate0-offline-adjudicator.js"), "utf8"); assert.doesNotMatch(source, /require\(["']\.\/collector["']\)|loadInventory|buildEthereumCandidatePool|RpcBudget|fetch\(/);
});

test("isolated exact capture derives only source-known extsload closure and remains nonpromoting", (t) => {
  const made = setup(t); const result = adjudicate(made); const verdict = result.bundle["derived-gate0-verdict.json"]; const reads = result.bundle["extsload-read-classification.json"];
  assert.equal(verdict.terminalStage, "GATE0_ORDINARY_SETTLEMENT_EXACT_DERIVED_OFFLINE"); assert.equal(verdict.evidenceTier, DERIVED_TIER); assert.equal(verdict.ordinarySettlementExact, true); assert.equal(verdict.transientClosureExact, true); assert.equal(verdict.incompleteExactEvidence, false); assert.equal(verdict.extsloadReadsSourceKnownBenign, true); assert.equal(verdict.slotArgumentsDecoded, false); assert.equal(verdict.outputValuesDecoded, false); assertMandatoryNonpromotion(verdict);
  assert.equal(reads.readCount, 4); assert.deepEqual(reads.rows.map((row) => row.path), ["0.0.0.0", "0.0.0.2.0.0", "0.0.0.2.0.1", "0.0.0.7"]); assert.ok(reads.rows.every((row) => row.selector === EXTSLOAD_SELECTOR && row.calleeContext === POOL_MANAGER && [LOCKER, HOOK].includes(row.caller)));
  const binding = result.bundle["poolmanager-extsload-source-binding.json"]; assert.equal(binding.selectorDerivedLocally, true); assert.equal(binding.poolManagerInheritsExtsload, true); assert.equal(binding.exactSingleSlotDeclarationAndBodyBound, true); assert.doesNotThrow(() => assertSanitizedBundle(result.bundle));
  const output = path.join(made.parent, "derived-output"); writeDerivedBundle(output, result); assert.deepEqual(fs.readdirSync(output).sort(), ["capture-anchor.json", "derived-gate0-verdict.json", "extsload-read-classification.json", "manifest.json", "poolmanager-extsload-source-binding.json"]);
});

test("capture manifest, file pins, extras, and symlink substitutions fail closed", (t) => {
  const manifest = setup(t); fs.appendFileSync(path.join(manifest.capture, "manifest.json"), " "); assert.throws(() => adjudicate(manifest), /manifest-pin-mismatch/);
  const file = setup(t); fs.appendFileSync(path.join(file.capture, "trace-projection.json"), " "); assert.throws(() => adjudicate(file), /file-pin-mismatch/);
  const extra = setup(t); fs.writeFileSync(path.join(extra.capture, "extra.json"), "{}\n"); assert.throws(() => adjudicate(extra), /file-allowlist-mismatch/);
  const linked = setup(t); const target = path.join(linked.parent, "linked-trace.json"); fs.copyFileSync(path.join(linked.capture, "trace-projection.json"), target); fs.rmSync(path.join(linked.capture, "trace-projection.json")); try { fs.symlinkSync(target, path.join(linked.capture, "trace-projection.json"), "file"); } catch (_) { t.diagnostic("symlink creation unavailable"); return; } assert.throws(() => adjudicate(linked), /capture-file-invalid/);
});

test("source anchor, transaction, block, tier, two-family agreement, and trace completeness tampering fail closed", (t) => {
  const cases = [
    ["source-anchor.json", (value) => { value.evidenceTier = "wrong"; }, /source-anchor-mismatch/],
    ["canonical-evidence.json", (value) => { value.transaction.hash = `0x${"0".repeat(64)}`; }, /canonical-identity-mismatch/],
    ["canonical-evidence.json", (value) => { value.block.number = "0"; }, /canonical-identity-mismatch/],
    ["canonical-evidence.json", (value) => { value.agreement.exactlyTwoIndependentProviderFamilies = false; }, /canonical-identity-mismatch/],
    ["trace-projection.json", (value) => { value.completeNormalizedTrace = false; }, /trace-completeness-mismatch/],
  ];
  for (const [filename, mutation, error] of cases) { const made = setup(t); mutateJson(made, filename, mutation); assert.throws(() => adjudicate(made), error); }
});

test("source, report, inheritance, body, provenance, and runtime mutations fail closed", (t) => {
  const dirty = setup(t); fs.appendFileSync(path.join(dirty.source.directory, "src", "Extsload.sol"), " "); assert.throws(() => adjudicate(dirty), /source-checkout-mismatch/);
  const report = setup(t); fs.appendFileSync(report.source.reportFile, " "); assert.throws(() => adjudicate(report), /source-report-mismatch/);
  const provenance = setup(t); mutateJson(provenance, "source-anchor.json", (value) => { value.poolManagerSourceProvenance.runtime.length += 1; }); assert.throws(() => adjudicate(provenance), /source-provenance-mismatch/);
  const runtime = setup(t); mutateJson(runtime, "runtime-fingerprints.json", (value) => { value.poolManagerExpected.codeLength += 1; }); assert.throws(() => adjudicate(runtime), /runtime-binding-mismatch/);
  const inheritance = setup(t); fs.writeFileSync(path.join(inheritance.source.directory, "src", "PoolManager.sol"), "pragma solidity 0.8.26; contract PoolManager {}\n"); git(inheritance.source.directory, ["add", "."]); git(inheritance.source.directory, ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "-m", "changed"]); inheritance.source.pins.commit = git(inheritance.source.directory, ["rev-parse", "HEAD"]); inheritance.source.pins.tree = git(inheritance.source.directory, ["rev-parse", "HEAD^{tree}"]); inheritance.source.pins.poolManagerSource = fact(path.join(inheritance.source.directory, "src", "PoolManager.sol")); mutateJson(inheritance, "source-anchor.json", (value) => { value.poolManagerSourceProvenance.checkout.commit = inheritance.source.pins.commit; value.poolManagerSourceProvenance.checkout.tree = inheritance.source.pins.tree; }); assert.throws(() => adjudicate(inheritance), /inheritance-mismatch/);
  const body = setup(t); fs.writeFileSync(path.join(body.source.directory, "src", "Extsload.sol"), "pragma solidity ^0.8.0; interface IExtsload {} abstract contract Extsload is IExtsload { function extsload(bytes32) external pure returns (bytes32) { return bytes32(0); } }\n"); git(body.source.directory, ["add", "."]); git(body.source.directory, ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "--quiet", "-m", "changed"]); body.source.pins.commit = git(body.source.directory, ["rev-parse", "HEAD"]); body.source.pins.tree = git(body.source.directory, ["rev-parse", "HEAD^{tree}"]); body.source.pins.extsloadSource = fact(path.join(body.source.directory, "src", "Extsload.sol")); mutateJson(body, "source-anchor.json", (value) => { value.poolManagerSourceProvenance.checkout.commit = body.source.pins.commit; value.poolManagerSourceProvenance.checkout.tree = body.source.pins.tree; }); assert.throws(() => adjudicate(body), /extsload-body-mismatch/);
});

test("selector, path, caller, type, status, value, contexts, count, and extra unknown manager frames fail closed", (t) => {
  const mutations = [
    (trace) => { unknownFrame(trace).selector = "0x00000000"; }, (trace) => { unknownFrame(trace).path = "0.0.0.99"; }, (trace) => { unknownFrame(trace).caller = HOOK; },
    (trace) => { unknownFrame(trace).type = "CALL"; }, (trace) => { unknownFrame(trace).status = "REVERTED"; }, (trace) => { unknownFrame(trace).valueWei = "1"; },
    (trace) => { unknownFrame(trace).callee = LOCKER; }, (trace) => { unknownFrame(trace).codeContext = LOCKER; }, (trace) => { unknownFrame(trace).storageContext = LOCKER; },
    (trace) => { trace.relatedFrames = trace.relatedFrames.filter((row) => row.path !== "0.0.0.7"); trace.frameCount -= 1; },
    (trace) => { const extra = structuredClone(unknownFrame(trace)); extra.path = "0.0.0.8"; extra.ordinal = 18; trace.relatedFrames.push(extra); trace.frameCount += 1; },
  ];
  for (const mutation of mutations) { const made = setup(t); mutateJson(made, "trace-projection.json", mutation); assert.throws(() => adjudicate(made), /extsload|trace-completeness|extra-manager/); }
});

test("substantive held-verdict and captured or derived nonpromotion tampering fail closed", (t) => {
  for (const mutation of [(value) => { value.swapHookReconciliationExact = false; }, (value) => { value.ownerNativeAccounting.exact = false; }, (value) => { value.expectedNativeTakes[0].matched = false; }, (value) => { value.concreteMismatches.feeValidationMismatch = true; }]) { const made = setup(t); mutateJson(made, "gate0-verdict.json", mutation); assert.throws(() => adjudicate(made), /substantive-verdict-mismatch/); }
  const captured = setup(t); mutateJson(captured, "gate0-verdict.json", (value) => { value.promotable = true; }); assert.throws(() => adjudicate(captured), /captured-nonpromotion-mismatch/);
  const made = setup(t); const verdict = adjudicate(made).bundle["derived-gate0-verdict.json"]; for (const mutation of [{ globalSolvencyAsserted: true }, { currentBehaviorAsserted: true }, { publicReachabilityAsserted: true }, { controlAsserted: true }, { controlledClusterExact: true }, { fullPerAddressAssetVectorExact: true }, { scalarHistoricalNetExact: true }, { liquidExtractionAsserted: true }, { routePositive: true }, { currentExecutable: true }, { promotable: true }]) assert.throws(() => assertMandatoryNonpromotion({ ...verdict, ...mutation }), /nonpromotion-invariant/);
});

test("output leakage, capture/source mutation, and atomic cleanup cannot expose a bundle", (t) => {
  assert.throws(() => assertSanitizedBundle({ bad: "https://forbidden.invalid" }), /output-leak/); assert.throws(() => assertSanitizedBundle({ slot: "secret" }), /output-leak/);
  const capture = setup(t); const captureResult = adjudicate(capture); fs.appendFileSync(path.join(capture.capture, "trace-projection.json"), " "); const captureOutput = path.join(capture.parent, "capture-mutated-output"); assert.throws(() => writeDerivedBundle(captureOutput, captureResult), /capture-/); assert.equal(fs.existsSync(captureOutput), false);
  const source = setup(t); const sourceResult = adjudicate(source); fs.appendFileSync(path.join(source.source.directory, "src", "Extsload.sol"), " "); const sourceOutput = path.join(source.parent, "source-mutated-output"); assert.throws(() => writeDerivedBundle(sourceOutput, sourceResult), /source-/); assert.equal(fs.existsSync(sourceOutput), false); assert.equal(fs.readdirSync(source.parent).some((name) => name.includes(".tmp-")), false);
});
