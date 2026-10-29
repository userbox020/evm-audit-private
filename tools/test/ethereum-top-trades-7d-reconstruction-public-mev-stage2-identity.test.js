"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Interface } = require("ethers");
const gate = require("../atomic/ethereum-top-trades-7d-reconstruction/public-mev-stage2-identity-gate");
const validator = require("../atomic/ethereum-top-trades-7d-reconstruction/public-mev-stage2-identity-validator");

function sourceEntry(address) { return { address, host: gate.BLOCKSCOUT_HOST, path: gate.sourceRequestSpec(address).path, source: `contract C_${address.slice(2, 8)} {}`, abi: [{ type: "function", name: "f", stateMutability: "view", inputs: [], outputs: [] }], compiler: { version: "v0.8.24", optimizationEnabled: true, optimizationRuns: 200, evmVersion: "paris" }, settings: { optimizer: { enabled: true, runs: 200 } }, contractName: "C", filePath: "C.sol", runtimeTemplate: "0x6000", immutableReferences: [] }; }
function sourcePackage() { return { schemaVersion: 1, target: "PUBLIC_MEV_STAGE2_VERIFIED_SOURCE_PACKAGE_V1", entries: [...gate.REQUIRED_SOURCE_ADDRESSES, "0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222", validator.A.poolManager, validator.A.usdc].map(sourceEntry) }; }
function sourceAddresses(pkg) { return pkg.entries.map((row) => row.address); }
function recompute(bundle) { bundle["verdict.json"].decision = validator.decision(bundle); bundle["verdict.json"].forkJustified = bundle["verdict.json"].decision === "WATCH_CROSS_DOMAIN_AUTHORIZATION_OR_REPLAY_MISMATCH"; bundle["verdict.json"].reasonEnums = [bundle["verdict.json"].decision]; return bundle; }
function mockInventory(t, bytes) { const target = path.resolve(__dirname, "..", "..", "rpc_endpoints.txt"), lstat = fs.lstatSync, read = fs.readFileSync, native = fs.realpathSync.native, state = { dev: 1, ino: 2, size: bytes.length, mtimeMs: 3, ctimeMs: 4 }; const isTarget = (value) => typeof value === "string" && path.resolve(value) === target; fs.lstatSync = (value, ...rest) => isTarget(value) ? { ...state, isFile: () => true, isSymbolicLink: () => false } : lstat(value, ...rest); fs.readFileSync = (value, ...rest) => isTarget(value) ? Buffer.from(bytes) : read(value, ...rest); fs.realpathSync.native = (value, ...rest) => isTarget(value) ? target : native(value, ...rest); t.after(() => { fs.lstatSync = lstat; fs.readFileSync = read; fs.realpathSync.native = native; }); return state; }

test("preflight self-validates immutable Stage0, Stage1, deep anchors and exact row without live reads", { skip: gate.programFacts().pending }, () => {
  const out = [], err = [], before = gate.snapshotAnchors(), result = gate.runCli(["--preflight-only"], { stdout: (value) => out.push(value), stderr: (value) => err.push(value) }); assert.equal(result.ok, true); assert.equal(result.liveRpcPerformed, false); assert.equal(result.publicWebReadPerformed, false); assert.equal(result.artifactWritten, false); assert.equal(result.stage1ManifestSha256, validator.MANIFESTS.stage1); assert.equal(result.deepManifestSha256, validator.MANIFESTS.deep); assert.equal(err.length, 0); assert.equal(gate.snapshotAnchors().commitment, before.commitment); assert.equal(gate.findDeepRow().transaction.hash, validator.TX); assert.equal(gate.runCli(["--live"], { stdout: () => {}, stderr: () => {} }).code, "PUBLIC_MEV_STAGE2_CLI_INVALID");
});

test("EIP-7702 designator, EIP-1967 slots, historical/current proxy difference, and runtime immutables bind", () => {
  assert.deepEqual(gate.decodeDelegationCode(`0xef0100${validator.A.calibur.slice(2)}`), { designator: "0xef0100", delegate: validator.A.calibur }); assert.throws(() => gate.decodeDelegationCode("0x6000"), /DELEGATION_CODE/); assert.equal(gate.decodeStorageAddress(`0x${"00".repeat(12)}${validator.A.settler.slice(2)}`), validator.A.settler); assert.match(gate.EIP1967.implementation, /^0x[0-9a-f]{64}$/); assert.match(gate.EIP1967.admin, /^0x[0-9a-f]{64}$/);
  const zeroSlot = `0x${"00".repeat(32)}`, zeroAddress = `0x${"00".repeat(20)}`, directView = { delegation: { delegate: validator.A.calibur }, proxySlots: Object.fromEntries([validator.A.router, validator.A.dln, validator.A.usdc].map((address) => [address, { implementation: zeroSlot, beaconImplementation: zeroAddress }])) }, directMap = gate.historicalImplementationMap(directView); assert.equal(directMap[validator.A.router], validator.A.router); assert.equal(directMap[validator.A.dln], validator.A.dln); assert.equal(directMap[validator.A.usdc], validator.A.usdc);
  assert.equal(gate.runtimeMatchesTemplate("0x60010203", "0x60010003", [{ start: 2, length: 1 }]), true); assert.equal(gate.runtimeMatchesTemplate("0x60010203", "0x60010004", [{ start: 2, length: 1 }]), false); const bundle = gate.buildFixtureBundle(); bundle["runtime-identity.json"].contexts.find((row) => row.kind === "PROXY").currentImplementationDifferent = true; assert.equal(validator.validateBundle(bundle), true); assert.equal(bundle["verdict.json"].decision, "ORDINARY_DLN_FULFILLMENT_EXACT");
});

test("ABI call decoding retains names and safe semantics but never calldata", () => {
  const abi = ["function transfer(address to,uint256 amount)"], iface = new Interface(abi), data = iface.encodeFunctionData("transfer", [validator.A.recipient, 7776498n]), decoded = gate.decodeCall(data, abi, ["to", "amount"]); assert.equal(decoded.functionName, "transfer"); assert.equal(decoded.semanticFields.to, validator.A.recipient); assert.equal(decoded.semanticFields.amount, "7776498"); assert.doesNotMatch(JSON.stringify(decoded), new RegExp(data.slice(10), "i"));
});

test("value-moving trace calls and order/domain/recipient/fee events decode without raw payloads", () => {
  const eventAbi = ["event OrderFulfilled(bytes32 orderId,address recipient,uint256 sourceDomain,uint256 destinationDomain)", "event AffiliateFeePaid(address feeRecipient,uint256 affiliateFee)"], transferAbi = ["function transfer(address to,uint256 amount)"], eventInterface = new Interface(eventAbi), transferInterface = new Interface(transferAbi);
  const pkg = { schemaVersion: 1, target: "PUBLIC_MEV_STAGE2_VERIFIED_SOURCE_PACKAGE_V1", entries: [{ ...sourceEntry(validator.A.dln), abi: eventAbi }, { ...sourceEntry(validator.A.usdc), abi: transferAbi }] }, implementations = { [validator.A.dln]: validator.A.dln, [validator.A.usdc]: validator.A.usdc };
  const trace = { from: validator.A.router, to: validator.A.dln, input: "0x", value: "0x1", calls: [{ from: validator.A.router, to: validator.A.usdc, input: transferInterface.encodeFunctionData("transfer", [validator.A.recipient, 7776498n]), value: "0x0" }] }, calls = gate.decodeTraceSurface(trace, pkg, implementations);
  assert.equal(calls[0].asset, "NATIVE"); assert.equal(calls[1].asset, validator.A.usdc); assert.equal(calls[1].amount, "7776498");
  const fulfilled = eventInterface.encodeEventLog(eventInterface.getEvent("OrderFulfilled"), [validator.ORDER_ID, validator.A.recipient, 1n, 10n]), fee = eventInterface.encodeEventLog(eventInterface.getEvent("AffiliateFeePaid"), [validator.A.feeRecipient, 45430727807392n]);
  const events = gate.decodeEventSurface({ logs: [{ address: validator.A.dln, ...fulfilled }, { address: validator.A.dln, ...fee }] }, pkg, implementations), bound = gate.bindOrderSemantics({ semanticFields: {} }, [], events);
  assert.equal(bound.orderIdBound, true); assert.equal(bound.recipientBound, true); assert.equal(bound.domainBound, true); assert.equal(bound.feeBound, true); assert.doesNotMatch(JSON.stringify({ calls, events }), /"(?:input|data|topics)"/);
});

test("identity, ABI/runtime, event/order recipient/domain/replay/fee and arithmetic incompleteness block", () => {
  const mutations = [
    (x) => { x["runtime-identity.json"].contexts[0].runtimeTemplateMatched = false; },
    (x) => { x["call-surface.json"].valueMovingCalls[0].abiDecoded = false; },
    (x) => { x["event-order-binding.json"].recipient = validator.A.feeRecipient; },
    (x) => { x["event-order-binding.json"].domainBound = false; },
    (x) => { x["event-order-binding.json"].feeBound = false; },
    (x) => { x["replay-state.json"].dualBound = false; },
    (x) => { x["value-ledger.json"].feeWei = "45430727807393"; }
  ]; for (const mutate of mutations) { const bundle = gate.buildFixtureBundle(); mutate(bundle); recompute(bundle); assert.equal(validator.validateBundle(bundle), true); assert.equal(bundle["verdict.json"].decision, "BLOCKED_IDENTITY_OR_STATE_INCOMPLETE"); }
});

test("only a concrete authorization or replay mismatch produces WATCH and fork justification", () => {
  const watch = gate.buildFixtureBundle({ concreteMismatch: true }); assert.equal(watch["verdict.json"].decision, "WATCH_CROSS_DOMAIN_AUTHORIZATION_OR_REPLAY_MISMATCH"); assert.equal(watch["verdict.json"].forkJustified, true); const blocked = gate.buildFixtureBundle({ complete: false }); assert.equal(blocked["verdict.json"].decision, "BLOCKED_IDENTITY_OR_STATE_INCOMPLETE"); assert.equal(blocked["verdict.json"].forkJustified, false);
});

test("fixed value ledger reconciles exact USDC and native equations and isolates gas", () => {
  const bundle = gate.buildFixtureBundle(), ledger = bundle["value-ledger.json"]; assert.equal(BigInt(ledger.feeWei) + BigInt(ledger.dlnWei), BigInt(ledger.poolManagerNativeWei)); assert.equal(ledger.recipientWei, ledger.dlnWei); assert.deepEqual(ledger.usdcHops, [validator.A.account, validator.A.router, validator.A.settler, validator.A.poolManager]); assert.deepEqual(ledger.nonRouteNativeDeltas, [{ classification: "TRANSACTION_GAS", amountWei: "123875038916044" }]); assert.equal(validator.validateBundle(bundle), true);
});

test("dual historical projection disagreement fails closed", () => { assert.equal(gate.dualAgreement({ blockHash: validator.BLOCK.hash }, { blockHash: validator.BLOCK.hash }).blockHash, validator.BLOCK.hash); assert.throws(() => gate.dualAgreement({ blockHash: validator.BLOCK.hash }, { blockHash: `0x${"00".repeat(32)}` }), /DUAL_DISAGREEMENT/); });

test("Blockscout acquisition is fixed, one-address scoped, unauthenticated, and source schema/caps fail closed", () => {
  const spec = gate.sourceRequestSpec(validator.A.calibur); assert.deepEqual({ host: spec.host, path: spec.path, redirects: spec.redirects, retries: spec.retries, authentication: spec.authentication }, { host: "eth.blockscout.com", path: `/api/v2/smart-contracts/${validator.A.calibur}`, redirects: 0, retries: 0, authentication: false });
  const abi = [{ type: "function", name: "f", stateMutability: "view", inputs: [], outputs: [] }], response = { abi, compiler_version: "v0.8.24", is_verified: true, optimization_enabled: true, optimization_runs: 200, source_code: "contract C{}", evm_version: "paris", contract_name: "C", file_path: "C.sol", compiler_settings: {}, deployed_bytecode: "0x6000" };
  assert.deepEqual(gate.validateSourceResponse(validator.A.calibur, response).abi, abi);
  const stringAbi = gate.validateSourceResponse(validator.A.calibur, { ...response, abi: JSON.stringify(abi) }); assert.deepEqual(stringAbi.abi, abi); assert.equal(Array.isArray(stringAbi.abi), true);
  for (const invalidAbi of ["not-json", "{}", null, 7]) assert.throws(() => gate.validateSourceResponse(validator.A.calibur, { ...response, abi: invalidAbi }), /SOURCE_SCHEMA/);
  const withExtras = gate.validateSourceResponse(validator.A.calibur, { ...response, abi: JSON.stringify(abi), creation_status: "success", is_fully_verified: true, language: "solidity", verified_at: "2026-08-27T00:00:00Z", additional_sources: [] }); assert.deepEqual(withExtras.abi, abi); for (const key of ["creation_status", "is_fully_verified", "language", "verified_at", "additional_sources"]) assert.equal(Object.hasOwn(withExtras, key), false);
  for (const key of ["source_code", "is_verified", "compiler_version", "optimization_enabled", "optimization_runs", "deployed_bytecode"]) assert.throws(() => gate.validateSourceResponse(validator.A.calibur, { ...response, [key]: null }), /SOURCE_SCHEMA/);
  for (const mutation of [{ compiler_version: "" }, { source_code: "" }, { deployed_bytecode: "0x" }, { optimization_runs: -1 }, { optimization_runs: 1.5 }]) assert.throws(() => gate.validateSourceResponse(validator.A.calibur, { ...response, ...mutation }), /SOURCE_SCHEMA/);
  assert.throws(() => gate.validateSourceResponse(validator.A.calibur, { ...response, token: "secret" }), /SOURCE_SCHEMA/); assert.throws(() => gate.validateSourceResponse(validator.A.calibur, { ...response, source_code: "x".repeat(gate.LIMITS.publicResponseBytes + 1) }), /SOURCE_CAP/); const pkg = sourcePackage(); assert.match(gate.validateSourcePackage(pkg, sourceAddresses(pkg)), /^0x[0-9a-f]{64}$/); assert.throws(() => gate.validateSourcePackage({ ...pkg, entries: [...pkg.entries, sourceEntry("0x3333333333333333333333333333333333333333")] }, sourceAddresses(pkg)), /SOURCE_PACKAGE/);
});

test("canonical inventory marking stays private and inventory is not serialized", (t) => { const secret = Buffer.from("stage2-private-inventory-sentinel"); mockInventory(t, secret); const bytes = gate.readCanonicalInventory(); assert.deepEqual(bytes, secret); assert.equal(Object.keys(gate).some((key) => /weak|mark|inventoryMarks|productionCaptures/i.test(key)), false); assert.doesNotMatch(JSON.stringify(gate.buildFixtureBundle()), /stage2-private-inventory-sentinel/); bytes[0] ^= 1; assert.notDeepEqual(bytes, secret); });

test("source package failures expose only fixed invariant categories", () => {
  const base = sourcePackage(), required = sourceAddresses(base), expect = (pkg, code, addresses = required) => assert.throws(() => gate.validateSourcePackage(pkg, addresses), new RegExp(`PUBLIC_MEV_STAGE2_SOURCE_PACKAGE_${code}$`));
  expect({ ...base, schemaVersion: 2 }, "TOP_LEVEL_SCHEMA");
  const shape = structuredClone(base); shape.entries[0].transportMetadata = true; expect(shape, "ENTRY_SHAPE");
  const duplicate = structuredClone(base); duplicate.entries[1].address = duplicate.entries[0].address; duplicate.entries[1].path = duplicate.entries[0].path; expect(duplicate, "DUPLICATE_OR_REQUIRED_SET");
  const compiler = structuredClone(base); compiler.entries[0].compiler.version = ""; expect(compiler, "COMPILER_PROJECTION");
  const source = structuredClone(base); source.entries[0].source = ""; expect(source, "SOURCE_PRESENCE");
  const abi = structuredClone(base); abi.entries[0].abi = "[]"; expect(abi, "ABI_PROJECTION");
  const settings = structuredClone(base); settings.entries[0].settings = null; expect(settings, "SETTINGS_PROJECTION");
  const runtime = structuredClone(base); runtime.entries[0].runtimeTemplate = "0x"; expect(runtime, "RUNTIME_TEMPLATE");
  const immutable = structuredClone(base); immutable.entries[0].immutableReferences = [{ start: 2, length: 1 }]; expect(immutable, "IMMUTABLE_REFERENCES");
  const entries = Array.from({ length: gate.LIMITS.sourceAddresses + 1 }, (_, index) => sourceEntry(`0x${(index + 1).toString(16).padStart(40, "0")}`)); expect({ schemaVersion: 1, target: "PUBLIC_MEV_STAGE2_VERIFIED_SOURCE_PACKAGE_V1", entries }, "CAP", entries.map((row) => row.address));
});

test("separate source package and sanitized report writers are atomic, capped, no-overwrite, and validator-bound", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-mev-stage2-writer-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const pkg = sourcePackage(), sourceTarget = path.join(root, gate.SOURCE_BASENAME), sourceReceipt = gate.writeSourcePackage(sourceTarget, pkg, { approvedParent: root, requiredAddresses: sourceAddresses(pkg) }), bundle = gate.buildFixtureBundle({ sourcePackageCommitment: sourceReceipt.commitment, sourcePackage: pkg }), target = path.join(root, gate.OUTPUT_BASENAME), receipt = gate.writeBundle(target, bundle, { approvedParent: root, sourcePackage: pkg }); assert.equal(receipt.postvalidated, true); assert.equal(validator.validateDirectory(target), true); assert.doesNotMatch(fs.readdirSync(target).map((name) => fs.readFileSync(path.join(target, name), "utf8")).join(""), /contract C_/); assert.throws(() => gate.writeBundle(target, bundle, { approvedParent: root, sourcePackage: pkg }), /OUTPUT_EXISTS/); const tampered = structuredClone(bundle); tampered["runtime.json"].profitClaim = true; assert.throws(() => validator.validateBundle(tampered), /NONCLAIMS/); const leak = structuredClone(bundle); leak["call-surface.json"].calldata = "0xdead"; assert.throws(() => validator.validateBundle(leak), /LEAK/);
});

test("writer preserves foreign output races and manifest tampering fails", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-mev-stage2-race-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const target = path.join(root, gate.OUTPUT_BASENAME), marker = path.join(target, "foreign.txt"), pkg = sourcePackage(), bundle = gate.buildFixtureBundle({ sourcePackageCommitment: gate.validateSourcePackage(pkg, sourceAddresses(pkg)), sourcePackage: pkg }); assert.throws(() => gate.writeBundle(target, bundle, { approvedParent: root, sourcePackage: pkg, beforeRename: (_staging, final) => { fs.mkdirSync(final); fs.writeFileSync(marker, "foreign"); } }), /OUTPUT_EXISTS/); assert.equal(fs.readFileSync(marker, "utf8"), "foreign"); fs.rmSync(target, { recursive: true }); gate.writeBundle(target, bundle, { approvedParent: root, sourcePackage: pkg }); fs.writeFileSync(path.join(target, "verdict.json"), "{}\n"); assert.throws(() => validator.validateDirectory(target));
});

test("production CLI uses fixed dual outputs, sanitized lifecycle, and validates both manifests", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-mev-stage2-cli-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const pkg = sourcePackage(), commitment = gate.validateSourcePackage(pkg, sourceAddresses(pkg)), bundle = gate.buildFixtureBundle({ sourcePackageCommitment: commitment, sourcePackage: pkg }), capture = { bundle, sourcePackage: pkg, diagnostics: { requestsUsed: 31, independentFamilyCount: 2, sourceAddresses: pkg.entries.length, decodedEvents: 2, decodedValueMovingCalls: 5 } }, out = [], err = [], exits = [];
  const summary = await gate.runCli(["--live-capture"], { approvedParent: root, readInventory: () => Buffer.from("private-inventory-sentinel"), rpcTransport: async () => ({ result: "0x1" }), publicTransport: async () => ({}), produce: async ({ rpcTransport, publicTransport }) => { await rpcTransport({}); await publicTransport(gate.sourceRequestSpec(validator.A.calibur)); return capture; }, stdout: (value) => out.push(value), stderr: (value) => err.push(value), setExitCode: (value) => exits.push(value) });
  const targets = gate.captureOutputTargets(root); assert.equal(summary.ok, true); assert.equal(summary.verdict, "ORDINARY_DLN_FULFILLMENT_EXACT"); assert.equal(summary.rpcReadStarted, true); assert.equal(summary.publicReadStarted, true); assert.equal(summary.artifactsWritten, true); assert.equal(err.length, 0); assert.deepEqual(exits, []); assert.equal(validator.validateDirectory(targets.report), true); assert.equal(gate.validateSourceDirectory(targets.source, sourceAddresses(pkg)), commitment); assert.doesNotMatch(out.join(""), /private-inventory-sentinel|https?:|endpoint|provider|token|header/i); assert.doesNotMatch(fs.readdirSync(targets.report).map((name) => fs.readFileSync(path.join(targets.report, name), "utf8")).join(""), /contract C_/);
});

test("production CLI capability failure is sanitized and creates neither output", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-mev-stage2-cli-fail-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const err = [], exits = [], result = await gate.runCli(["--live-capture"], { approvedParent: root, readInventory: () => Buffer.from("private-inventory-sentinel"), produce: async ({ rpcTransport }) => { await rpcTransport({}); throw new Error("secret provider capability detail"); }, rpcTransport: async () => ({ result: "0x1" }), publicTransport: async () => ({}), stdout: () => {}, stderr: (value) => err.push(value), setExitCode: (value) => exits.push(value) }); const targets = gate.captureOutputTargets(root), failure = JSON.parse(err.join(""));
  assert.equal(result.code, "PUBLIC_MEV_STAGE2_FAILED"); assert.equal(failure.rpcReadStarted, true); assert.equal(failure.artifactsWritten, false); assert.equal(fs.existsSync(targets.report), false); assert.equal(fs.existsSync(targets.source), false); assert.deepEqual(exits, [1]); assert.doesNotMatch(err.join(""), /secret|provider|inventory|https?:|endpoint/i);
});

test("production CLI emits differentiated package errors without dynamic data", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-mev-stage2-cli-category-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const pkg = sourcePackage(); pkg.entries[0].settings = null; pkg.entries[0].source = "raw-source-sentinel"; const err = [], result = await gate.runCli(["--live-capture"], { approvedParent: root, readInventory: () => Buffer.from("private-inventory-sentinel"), produce: async () => gate.validateSourcePackage(pkg, sourceAddresses(pkg)), stdout: () => {}, stderr: (value) => err.push(value), setExitCode: () => {} }), targets = gate.captureOutputTargets(root);
  assert.equal(result.code, "PUBLIC_MEV_STAGE2_SOURCE_PACKAGE_SETTINGS_PROJECTION"); assert.equal(JSON.parse(err.join("")).code, result.code); assert.doesNotMatch(err.join(""), /raw-source-sentinel|private-inventory-sentinel|https?:|endpoint|provider|address/i); assert.equal(fs.existsSync(targets.report), false); assert.equal(fs.existsSync(targets.source), false);
});
