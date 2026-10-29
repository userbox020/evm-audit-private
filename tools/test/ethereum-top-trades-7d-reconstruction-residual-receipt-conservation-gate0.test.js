"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BATCH_TERMINAL, ROW_TERMINAL, SOURCE_DIRECTORY, SOURCE_FILES, SPECS,
  adjudicateFixture, adjudicateProduction, assertMandatoryNonpromotion,
  assertNoEndpointEnvironment, assertSanitizedBundle, parseCli, writeDerivedBundle,
} = require("../atomic/ethereum-top-trades-7d-reconstruction/residual-receipt-conservation-gate0");

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fact(filename) { const bytes = fs.readFileSync(filename); return { bytes: bytes.length, sha256: sha256(bytes) }; }
function writeJson(filename, value) { fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`); }
function repin(directory) {
  const files = {};
  for (const name of SOURCE_FILES.filter((row) => row !== "manifest.json")) files[name] = fact(path.join(directory, name));
  writeJson(path.join(directory, "manifest.json"), { atomicVisibility: true, durabilityClaimed: false, endpointFree: true, files, schemaVersion: 1 });
  return { basename: path.basename(directory), manifest: fact(path.join(directory, "manifest.json")) };
}
function setup(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "residual-receipt-gate0-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const source = path.join(parent, "isolated-residual-source"); fs.mkdirSync(source);
  for (const name of SOURCE_FILES) fs.copyFileSync(path.join(SOURCE_DIRECTORY, name), path.join(source, name));
  return { parent, source, fixture: { sourcePins: repin(source) }, options: { inputDirectory: source } };
}
function adjudicate(made) { return adjudicateFixture(made.options, made.fixture); }
function mutateJson(made, filename, mutation) { const target = path.join(made.source, filename); const value = JSON.parse(fs.readFileSync(target, "utf8")); mutation(value); writeJson(target, value); made.fixture.sourcePins = repin(made.source); }
function candidate(value, hash = SPECS[0].hash) { return value.rows.find((row) => row.transaction.hash === hash); }

test("CLI is exact, endpoint-environment rejecting, production isolated, and collector-free", () => {
  assert.deepEqual(parseCli(["--input-dir", "in", "--output-dir", "out"]), { inputDirectory: "in", outputDirectory: "out" });
  assert.throws(() => parseCli(["--input-dir", "in", "--rpc-url", "x", "--output-dir", "out"]), /cli-options-invalid/);
  assert.throws(() => parseCli(["--input-dir", "same", "--output-dir", path.join("same", "child")]), /output-must-be-separate/);
  assert.equal(assertNoEndpointEnvironment({}), true);
  for (const name of ["RPC_URL", "ETH_RPC_URL", "WEB3_PROVIDER_URI", "RPC_ENDPOINTS_FILE", "GRAPHQL_ENDPOINTS_FILE", "HTTP_PROXY"]) assert.throws(() => assertNoEndpointEnvironment({ [name]: "redacted" }), /endpoint-environment-rejected/);
  assert.throws(() => adjudicateProduction({ inputDirectory: "not-the-source" }), /exact-source-required/);
  assert.throws(() => adjudicateProduction({ inputDirectory: SOURCE_DIRECTORY, sourcePins: {} }), /production-options-invalid/);
  const implementation = fs.readFileSync(path.join(__dirname, "../atomic/ethereum-top-trades-7d-reconstruction/residual-receipt-conservation-gate0.js"), "utf8");
  assert.doesNotMatch(implementation, /require\(["']\.\/collector["']\)|loadInventory|buildEthereumCandidatePool|RpcBudget|fetch\(/);
});

test("real immutable source passes check-only with five ordinary nonpromoting rows", () => {
  const result = adjudicateProduction({ inputDirectory: SOURCE_DIRECTORY });
  const receipt = result.bundle["receipt-conservation.json"]; const verdict = result.bundle["residual-batch-gate0-verdict.json"];
  assert.equal(receipt.rows.length, 5); assert.deepEqual(receipt.rows.map((row) => row.transactionHash), SPECS.map((row) => row.hash));
  assert.ok(receipt.rows.every((row) => row.terminalStage === ROW_TERMINAL && row.concreteReceiptMismatch === false && row.typedTransferProjectionExact === true));
  assert.ok(receipt.rows.every((row) => row.receiptConservationChecks.length > 0 && row.receiptConservationChecks.every((check) => check.exact && check.leftRaw === check.rightRaw)));
  assert.ok(receipt.rows.every((row) => row.unknownCustomEventCommitmentsRemainLimitation === true && row.unknownCustomEventCommitmentsResolvedBenign === false));
  assert.equal(verdict.terminalStage, BATCH_TERMINAL); assert.equal(verdict.allRowsOrdinaryReceiptPattern, true); assertMandatoryNonpromotion(verdict); assertSanitizedBundle(result.bundle);
});

test("isolated fixture writes only sanitized atomic derived artifacts", (t) => {
  const made = setup(t); const result = adjudicate(made); const output = path.join(made.parent, "derived-output");
  writeDerivedBundle(output, result);
  assert.deepEqual(fs.readdirSync(output).sort(), ["manifest.json", "receipt-conservation.json", "residual-batch-gate0-verdict.json", "source-anchor.json"]);
  const text = fs.readdirSync(output).map((name) => fs.readFileSync(path.join(output, name), "utf8")).join("\n");
  assert.doesNotMatch(text, /provider-\d+|"topics"|"calldata"|https?:\/\/|wss?:\/\//i);
});

test("manifest pin, file commitments, allowlist, and symlink substitutions fail closed", (t) => {
  const manifest = setup(t); fs.appendFileSync(path.join(manifest.source, "manifest.json"), " "); assert.throws(() => adjudicate(manifest), /manifest-pin-mismatch/);
  const file = setup(t); fs.appendFileSync(path.join(file.source, "runtime.json"), " "); assert.throws(() => adjudicate(file), /file-commitment-mismatch/);
  const extra = setup(t); fs.writeFileSync(path.join(extra.source, "extra.json"), "{}\n"); assert.throws(() => adjudicate(extra), /file-allowlist-mismatch/);
  const linked = setup(t); const outside = path.join(linked.parent, "linked-runtime.json"); fs.copyFileSync(path.join(linked.source, "runtime.json"), outside); fs.rmSync(path.join(linked.source, "runtime.json"));
  try { fs.symlinkSync(outside, path.join(linked.source, "runtime.json"), "file"); } catch (_) { t.diagnostic("symlink creation unavailable"); return; }
  assert.throws(() => adjudicate(linked), /source-file-invalid/);
});

test("all five receipt transfer graphs and conservation inputs fail closed when semantically tampered", (t) => {
  for (const spec of SPECS) {
    const made = setup(t);
    mutateJson(made, "candidates.json", (value) => { const row = candidate(value, spec.hash); const log = row.receipt.logs.find((entry) => entry.transfer); log.transfer.amount = (BigInt(log.transfer.amount) + 1n).toString(); });
    assert.throws(() => adjudicate(made), /receipt-projection-mismatch/);
  }
  const value = setup(t); mutateJson(value, "candidates.json", (json) => { candidate(json).transaction.valueWei = "0"; }); assert.throws(() => adjudicate(value), /candidate-identity-mismatch/);
  const event = setup(t); mutateJson(event, "candidates.json", (json) => { candidate(json).receipt.logs.find((row) => row.recognized).recognized.protocol = "wrong"; }); assert.throws(() => adjudicate(event), /receipt-projection-mismatch/);
  const unknown = setup(t); mutateJson(unknown, "candidates.json", (json) => { candidate(json).receipt.logs.find((row) => !row.transfer && !row.recognized).recognized = { class: "dex", event: "Swap", protocol: "invented" }; }); assert.throws(() => adjudicate(unknown), /receipt-projection-mismatch/);
});

test("identity, receipt integrity, offline context, and prior nonpromotion context fail closed", (t) => {
  const identity = setup(t); mutateJson(identity, "candidates.json", (value) => { candidate(value).receipt.blockHash = `0x${"0".repeat(64)}`; }); assert.throws(() => adjudicate(identity), /candidate-identity-mismatch/);
  const log = setup(t); mutateJson(log, "candidates.json", (value) => { candidate(value).receipt.logs[0].removed = true; }); assert.throws(() => adjudicate(log), /receipt-log-integrity-mismatch/);
  const runtime = setup(t); mutateJson(runtime, "runtime.json", (value) => { value.tracesEnabled = true; }); assert.throws(() => adjudicate(runtime), /runtime-context-invalid/);
  const window = setup(t); mutateJson(window, "window.json", (value) => { value.immutable = false; }); assert.throws(() => adjudicate(window), /window-context-invalid/);
  const reconciled = setup(t); mutateJson(reconciled, "reconciled.json", (value) => { value.rows.find((row) => row.transactionHash === SPECS[0].hash).ledger.reconciliationComplete = true; }); assert.throws(() => adjudicate(reconciled), /reconciled-context-invalid/);
});

test("nonpromotion and output leakage invariants reject every promotion or forbidden projection", (t) => {
  const verdict = adjudicate(setup(t)).bundle["residual-batch-gate0-verdict.json"];
  for (const mutation of [{ sourceRuntimeExact: true }, { traceExact: true }, { fullAssetVectorExact: true }, { currentBehaviorAsserted: true }, { scalarNetExact: true }, { routePositive: true }, { currentExecutable: true }, { promotable: true }, { signing: true }, { signingAuthorized: true }]) assert.throws(() => assertMandatoryNonpromotion({ ...verdict, ...mutation }), /nonpromotion-invariant/);
  for (const bad of [{ topics: ["forbidden"] }, { calldata: "0x" }, { provider: "provider-01" }, { userPath: "C:\\Users\\forbidden" }, { url: "https://forbidden.invalid" }]) assert.throws(() => assertSanitizedBundle({ bad }), /output-leak/);
});

test("source mutation before publication cleans the temporary bundle atomically", (t) => {
  const made = setup(t); const result = adjudicate(made); fs.appendFileSync(path.join(made.source, "candidates.json"), " "); const output = path.join(made.parent, "mutated-output");
  assert.throws(() => writeDerivedBundle(output, result), /source-/); assert.equal(fs.existsSync(output), false); assert.equal(fs.readdirSync(made.parent).some((name) => name.includes(".tmp-")), false);
});
