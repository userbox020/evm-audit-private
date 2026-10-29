"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  CONTRACTS,
  BUILD_MANIFEST_SHA256,
  LIMITS,
  READ_ONLY_METHODS,
  REQUIRED_R2_BASENAME,
  REQUIRED_R2_MANIFEST_SHA256,
  STAGE2B_TIER,
  TEST_HOOK_TOKEN,
  agreeProviderCaptures,
  apxUsdSourceBind,
  assertMandatoryNonpromotion,
  assertNoRawRuntimeLeak,
  compareRuntime,
  loadBuildManifest,
  metadataIntrospectionPolicy,
  parseArtifact,
  parseSolidityMetadata,
  regularContainedFile,
  validateApxUsdCallSurface,
  validateLimits,
  validatePinnedDependencies,
  verifyAnchors,
  verifyR2Directory,
  verifySourceCheckout,
} = require("../atomic/ethereum-top-trades-7d-reconstruction/morpho-funded-arbitrage-apxusd-source-binder");
const { atomicBundle } = require("../atomic/ethereum-top-trades-7d-reconstruction/output");
const { atomicWriteOptions } = require("../atomic/ethereum-top-trades-7d-reconstruction/run");
const { argumentsOf, safeTerminalCode } = require("../atomic/ethereum-top-trades-7d-reconstruction/run");

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function metadata(seed = 0x11, options = {}) {
  const map = options.extraKey ? "a3" : "a2"; const prefix = options.badPrefix ? "1320" : "1220"; const extra = options.extraKey ? "617801" : "";
  const payload = Buffer.from(`${map}64697066735822${prefix}${seed.toString(16).padStart(2, "0").repeat(32)}64736f6c634300081e${extra}`, "hex");
  const length = Buffer.alloc(2); length.writeUInt16BE(payload.length);
  return Buffer.concat([payload, length]);
}
function syntheticArtifact(name = "ApxUSD") {
  const descriptor = CONTRACTS[name]; const ranges = name === "ApxUSD" ? [{ offset: 4774, length: 32 }, { offset: 4815, length: 32 }, { offset: 5135, length: 32 }] : [];
  const bytecode = Buffer.alloc(descriptor.expectedLength, 0x5b); const trailer = metadata(); const start = bytecode.length - trailer.length; bytecode[start - 1] = name === "ApxUSD" ? 0x00 : 0xfe; trailer.copy(bytecode, start);
  for (const range of ranges) bytecode.fill(0, range.offset, range.offset + range.length);
  return { name, descriptor, bytecode, references: ranges.map((range) => ({ id: "1484", ...range })) };
}
function semanticRuntime(artifact) {
  const runtime = Buffer.from(artifact.bytecode); const changedMetadata = metadata(0x22); changedMetadata.copy(runtime, runtime.length - changedMetadata.length);
  const selfWord = Buffer.from(artifact.descriptor.address.slice(2).padStart(64, "0"), "hex");
  for (const range of artifact.references) selfWord.copy(runtime, range.offset);
  return runtime;
}
const INERT = { lengthConditionalInert: true, sourcePolicyExact: true, exactPinnedSourceSetChecked: true, runtimeTotalLengthEqualityRequired: true, lengthOnlyObservationCount: 1 };
function git(directory, args) {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, String(result.stderr)); return String(result.stdout).trim();
}

test("Stage2B apxUSD CLI mode is explicit and sanitized", () => {
  const parsed = argumentsOf(["--morpho-funded-arbitrage-apxusd-source-binder", "--source-dir", "stage1"]);
  assert.equal(parsed.mode, "morpho-stage2b-apxusd");
  assert.throws(() => argumentsOf(["--morpho-funded-arbitrage-apxusd-source-binder"]), /requires-source/);
  assert.equal(safeTerminalCode(new Error("stage2b-apxusd-cbor-malformed")), "stage2b-apxusd-cbor-malformed");
  assert.deepEqual([...READ_ONLY_METHODS].sort(), ["debug_traceTransaction", "eth_chainId", "eth_getBlockByHash", "eth_getTransactionByHash", "eth_getTransactionReceipt"]);
});

test("fixed Stage1 and accepted R2 artifacts validate offline", () => {
  const parent = path.join(__dirname, "..", "..", "reports", "raw", "fast", "atomic-ethereum-top-trades-7d-reconstruction");
  const anchors = verifyAnchors(path.join(parent, "morpho-stage1-2026-08-26T02-25-32-196Z-8e901119"), path.join(parent, REQUIRED_R2_BASENAME));
  assert.equal(anchors.r2.manifestSha256, REQUIRED_R2_MANIFEST_SHA256);
  assert.equal(anchors.r2.runtimeFacts.ApxUSD.sha256, CONTRACTS.ApxUSD.expectedSha256);
  assert.equal(anchors.r2.runtimeFacts.ERC1967Proxy.sha256, "97a750124c8ea95913f40f4c202d6dde93bf577e48398007acded0e1a297a152"); assert.equal(anchors.r2.runtimeFacts.ERC1967Proxy.length, 130);
  assert.equal(anchors.r2.runtimes.requiredUniverse.count, 17); assert.equal(anchors.r2.runtimes.requiredUniverse.derivedFromEverySuccessfulFrameCodeContext, true);
  assert.equal(anchors.r2.runtimes.relationships.filter((row) => row.context === CONTRACTS.ApxUSD.address && row.code === CONTRACTS.AddressList.address).length, 0);
  assert.equal(anchors.r2.runtimes.relationships.filter((row) => row.context === "0x98a878b1cd98131b271883b390f68d2c90674665" && row.code === CONTRACTS.ApxUSD.address).length, 1);
  assert.equal(anchors.r2.runtimes.relationships.filter((row) => row.context === "0x98a878b1cd98131b271883b390f68d2c90674665" && row.code === CONTRACTS.AddressList.address).length, 1);
});

test("production source preflight accepts separate deterministic build outputs without provider work", () => {
  const checkout = path.join(__dirname, "..", "..", "targets", "apyx-evm-contracts-stage2b-fe2ab775");
  const source = verifySourceCheckout(checkout);
  assert.equal(source.artifacts.ApxUSD.descriptor.artifact, "out/stage2b-apxusd-non-via-ir/ApxUSD.sol/ApxUSD.json");
  assert.equal(source.artifacts.ApxUSD.bytecode.length, 10129); assert.equal(source.artifacts.ApxUSD.metadata.settings.viaIR, undefined);
  assert.equal(source.artifacts.AddressList.descriptor.artifact, "out/stage2b-address-list-via-ir/AddressList.sol/AddressList.json");
  assert.equal(source.artifacts.AddressList.bytecode.length, 1631); assert.equal(source.artifacts.AddressList.metadata.settings.viaIR, true);
  assert.equal(source.artifacts.ERC1967Proxy.descriptor.artifact, "out/stage2b-apxusd-proxy-via-ir/ERC1967Proxy.sol/ERC1967Proxy.json"); assert.equal(source.artifacts.ERC1967Proxy.bytecode.length, 130); assert.equal(source.artifacts.ERC1967Proxy.metadata.settings.viaIR, true); assert.deepEqual(source.artifacts.ERC1967Proxy.artifact.deployedBytecode.immutableReferences || {}, {});
  assert.equal(source.buildManifestSha256, BUILD_MANIFEST_SHA256); assert.equal(source.metadataInertness.lengthConditionalInert, true); assert.equal(source.metadataInertness.rejectedIntrospectionAbsent, true); assert.ok(source.metadataInertness.lengthOnlyObservationCount >= 1);
  assert.equal(loadBuildManifest().manifest.builds.ApxUSD.artifact.deployedBytecodeLength, 10129); assert.equal(loadBuildManifest().manifest.buildAlternatives.ERC1967Proxy[0].deployedBytecodeLength, 163); assert.equal(loadBuildManifest().manifest.buildAlternatives.ERC1967Proxy[0].accepted, false);
});

test("semantic comparator accepts only validated metadata and source-bound immutable differences", () => {
  const artifact = syntheticArtifact(); const runtime = semanticRuntime(artifact); const result = compareRuntime(artifact, runtime, INERT);
  assert.equal(result.rawExactMatch, false); assert.equal(result.exactBodyMatch, true); assert.equal(result.immutableBindingsExact, true);
  assert.equal(result.differencesConfinedToDeclaredImmutablesAndValidatedMetadata, true); assert.equal(result.metadataInertnessExact, true); assert.equal(result.sourceSemanticEquivalent, true); assert.equal(result.differenceCounts.outsideAllowed, 0);
  assert.deepEqual(result.allowedDifferenceRanges.map(({ offset, length, kind }) => ({ offset, length, kind })), [
    { offset: 4774, length: 32, kind: "immutable" }, { offset: 4815, length: 32, kind: "immutable" }, { offset: 5135, length: 32, kind: "immutable" }, { offset: 10076, length: 53, kind: "metadata" },
  ]);
});

test("equal-length metadata variation remains inert with recorded code.length-only observation", () => {
  const policy = loadBuildManifest().manifest.metadataInertness; const inertness = metadataIntrospectionPolicy({ "LengthOnly.sol": "contract C { function f() external view returns (uint256) { return address(this).code.length; } } // address(this).codehash\n" }, policy);
  assert.equal(inertness.sourcePolicyExact, true); assert.equal(inertness.lengthConditionalInert, true); assert.equal(inertness.lengthOnlyObservationCount, 1); assert.equal(inertness.lengthOnlyObservations[0].observation, "code-length-only");
  const artifact = syntheticArtifact(); const result = compareRuntime(artifact, semanticRuntime(artifact), inertness);
  assert.equal(result.metadataInertness.compiledRuntimeTotalLengthsEqual, true); assert.equal(result.metadataInertnessExact, true); assert.equal(result.sourceSemanticEquivalent, true);
});

test("code.length-only policy still rejects unequal compiled and expected runtime lengths", () => {
  const artifact = syntheticArtifact(); const runtime = Buffer.concat([semanticRuntime(artifact), Buffer.from([0])]);
  assert.throws(() => compareRuntime(artifact, runtime, INERT), /runtime-length-mismatch/);
});

test("codehash, unreduced code, and extcodecopy introspection remain rejected", () => {
  const policy = loadBuildManifest().manifest.metadataInertness;
  for (const source of [
    "contract C { function f(address a) external view returns (bytes32) { return a.codehash; } }",
    "contract C { function f(address a) external view returns (bytes memory) { return a.code; } }",
    "contract C { function f() external view { assembly { extcodecopy(address(), 0, 0, 1) } } }",
  ]) {
    const result = metadataIntrospectionPolicy({ "Rejected.sol": source }, policy); assert.equal(result.sourcePolicyExact, false); assert.equal(result.lengthConditionalInert, false);
  }
});

test("a byte difference outside compiler-declared ranges fails semantic equivalence", () => {
  const artifact = syntheticArtifact(); const runtime = semanticRuntime(artifact); runtime[100] ^= 1; const result = compareRuntime(artifact, runtime, INERT);
  assert.equal(result.exactBodyMatch, false); assert.equal(result.differenceCounts.outsideAllowed, 1); assert.equal(result.sourceSemanticEquivalent, false);
});

test("a wrong ApxUSD immutable self binding fails semantic equivalence", () => {
  const artifact = syntheticArtifact(); const runtime = semanticRuntime(artifact); runtime[artifact.references[0].offset + 31] ^= 1; const result = compareRuntime(artifact, runtime, INERT);
  assert.equal(result.exactBodyMatch, true); assert.equal(result.immutableBindingsExact, false); assert.equal(result.sourceSemanticEquivalent, false);
});

test("malformed Solidity CBOR trailers are rejected", () => {
  const artifact = syntheticArtifact(); const runtime = semanticRuntime(artifact); runtime.writeUInt16BE(0xffff, runtime.length - 2);
  assert.throws(() => parseSolidityMetadata(runtime), /cbor-malformed/);
  assert.throws(() => compareRuntime(artifact, runtime), /cbor-malformed/);
});

test("CBOR rejects wrong IPFS prefixes, extra keys, and non-halting delimiters", () => {
  for (const options of [{ badPrefix: true }, { extraKey: true }]) {
    const artifact = syntheticArtifact(); const trailer = metadata(0x22, options); trailer.copy(artifact.bytecode, artifact.bytecode.length - trailer.length);
    assert.throws(() => parseSolidityMetadata(artifact.bytecode), /cbor-malformed/);
  }
  const artifact = syntheticArtifact(); const parsed = parseSolidityMetadata(artifact.bytecode); artifact.bytecode[parsed.start - 1] = 0x5b;
  assert.throws(() => parseSolidityMetadata(artifact.bytecode), /cbor-malformed/);
});

test("semantic equivalence remains false without exact pinned-source metadata inertness", () => {
  const artifact = syntheticArtifact(); const result = compareRuntime(artifact, semanticRuntime(artifact));
  assert.equal(result.exactBodyMatch, true); assert.equal(result.metadataInertnessExact, false); assert.equal(result.sourceSemanticEquivalent, false);
});

test("two provider captures must contain byte-identical runtimes", () => {
  const leftApx = Buffer.alloc(CONTRACTS.ApxUSD.expectedLength, 1); const rightApx = Buffer.from(leftApx); rightApx[0] = 2;
  const helper = Buffer.alloc(CONTRACTS.AddressList.expectedLength, 3); const proxy = Buffer.alloc(CONTRACTS.ERC1967Proxy.expectedLength, 4); const familyA = Symbol("a"); const familyB = Symbol("b");
  const captures = [
    { provider: { declaredGroup: true, family: familyA }, canonical: { ok: true }, runtimes: { ERC1967Proxy: proxy, ApxUSD: leftApx, AddressList: helper } },
    { provider: { declaredGroup: true, family: familyB }, canonical: { ok: true }, runtimes: { ERC1967Proxy: Buffer.from(proxy), ApxUSD: rightApx, AddressList: Buffer.from(helper) } },
  ];
  const expected = { ERC1967Proxy: { length: proxy.length, sha256: sha256(proxy) }, ApxUSD: { length: leftApx.length, sha256: sha256(leftApx) }, AddressList: { length: helper.length, sha256: sha256(helper) } };
  assert.throws(() => agreeProviderCaptures(captures, expected), /provider-runtime-mismatch/);
});

test("an R2 artifact mutation is rejected before provider work", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stage2b-r2-anchor-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const original = path.join(__dirname, "..", "..", "reports", "raw", "fast", "atomic-ethereum-top-trades-7d-reconstruction", REQUIRED_R2_BASENAME);
  const copied = path.join(parent, "synthetic-r2"); fs.cpSync(original, copied, { recursive: true }); fs.appendFileSync(path.join(copied, "runtime-bindings.json"), " ");
  assert.throws(() => verifyR2Directory(copied, { expectedBasename: "synthetic-r2", expectedManifestSha256: REQUIRED_R2_MANIFEST_SHA256 }), /r2-anchor-mismatch/);
});

test("a dirty or mutated source checkout is rejected", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stage2b-source-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true })); const repo = path.join(parent, "apyx-evm-contracts-stage2b-fe2ab775"); fs.mkdirSync(repo);
  git(repo, ["init", "--quiet"]); fs.writeFileSync(path.join(repo, "tracked.txt"), "fixed\n"); git(repo, ["add", "tracked.txt"]); git(repo, ["-c", "user.name=Offline Test", "-c", "user.email=offline@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  const commit = git(repo, ["rev-parse", "HEAD"]); const tree = git(repo, ["rev-parse", "HEAD^{tree}"]); git(repo, ["checkout", "--quiet", "--detach", commit]); fs.writeFileSync(path.join(repo, "mutation.txt"), "dirty\n");
  assert.throws(() => verifySourceCheckout(repo), /source-mutation/);
});

test("artifact-declared secret source paths are rejected before source reads", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stage2b-secret-source-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const fixed = loadBuildManifest().manifest; const pin = structuredClone(fixed.builds.ApxUSD); const checkout = path.join(__dirname, "..", "..", "targets", fixed.checkout.basename);
  const artifact = JSON.parse(fs.readFileSync(path.join(checkout, ...pin.artifactPath.split("/")), "utf8")); artifact.metadata.sources["src/.env.sol"] = { keccak256: `0x${"0".repeat(64)}` };
  const bytes = Buffer.from(`${JSON.stringify(artifact)}\n`); const filename = path.join(parent, ...pin.artifactPath.split("/")); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, bytes);
  pin.artifact.bytes = bytes.length; pin.artifact.sha256 = sha256(bytes);
  assert.throws(() => parseArtifact(parent, "ApxUSD", CONTRACTS.ApxUSD, pin, fixed.approvedSourceRoots), /source-path-rejected/);
});

test("symlink or reparse source escapes are rejected where supported", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stage2b-source-link-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true })); const sourceRoot = path.join(parent, "src"); fs.mkdirSync(sourceRoot); const outside = path.join(parent, "outside.sol"); fs.writeFileSync(outside, "pragma solidity 0.8.30;\n"); const linked = path.join(sourceRoot, "Escape.sol");
  try { fs.symlinkSync(outside, linked, "file"); } catch (error) { if (["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) { t.skip("symlink creation unavailable"); return; } throw error; }
  assert.throws(() => regularContainedFile(parent, "src/Escape.sol", ["src"]), /source-path-rejected/);
});

test("ignored artifact and dependency mutations fail fixed pins", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stage2b-pin-mutation-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const fixed = loadBuildManifest().manifest; const pin = structuredClone(fixed.builds.ApxUSD); const checkout = path.join(__dirname, "..", "..", "targets", fixed.checkout.basename); const original = fs.readFileSync(path.join(checkout, ...pin.artifactPath.split("/"))); const filename = path.join(parent, ...pin.artifactPath.split("/")); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, Buffer.concat([original, Buffer.from(" ")]));
  assert.throws(() => parseArtifact(parent, "ApxUSD", CONTRACTS.ApxUSD, pin, fixed.approvedSourceRoots), /artifact-pin-mismatch/);
  fs.writeFileSync(path.join(parent, "lockfile"), "mutated\n");
  assert.throws(() => validatePinnedDependencies(parent, { dependencyAcquisition: { lockfiles: { lockfile: { bytes: 6, sha256: sha256(Buffer.from("fixed\n")) } }, npmPackages: {} } }), /dependency-pin-mismatch/);
});

test("raw runtime leakage is rejected while hashes remain permitted", () => {
  const runtime = Buffer.from("0123456789abcdef".repeat(4), "hex");
  assert.doesNotThrow(() => assertNoRawRuntimeLeak({ runtimeSha256: sha256(runtime), runtimeLength: runtime.length }, { ApxUSD: runtime }));
  assert.throws(() => assertNoRawRuntimeLeak({ persistedPayload: runtime.toString("hex") }, { ApxUSD: runtime }), /raw-runtime-leak/);
});

test("immutable Stage1 establishes the exact source-bound apxUSD call surface", () => {
  const root = path.join(__dirname, "..", ".."); const reportParent = path.join(root, "reports", "raw", "fast", "atomic-ethereum-top-trades-7d-reconstruction");
  const anchors = verifyAnchors(path.join(reportParent, "morpho-stage1-2026-08-26T02-25-32-196Z-8e901119"), path.join(reportParent, REQUIRED_R2_BASENAME)); const source = verifySourceCheckout(path.join(root, "targets", "apyx-evm-contracts-stage2b-fe2ab775"));
  const result = validateApxUsdCallSurface(anchors.stage1, source.artifacts);
  assert.equal(result.exact, true); assert.deepEqual(result.orderedProxyCalls.map(({ type, selector }) => ({ type, selector })), [{ type: "CALL", selector: "0xa9059cbb" }, { type: "STATICCALL", selector: "0x70a08231" }, { type: "CALL", selector: "0x23b872dd" }, { type: "STATICCALL", selector: "0x70a08231" }]); assert.equal(result.helperStaticcallCount, 4);
});

test("extra proxy or implementation calls and missing helpers fail call-surface closure", () => {
  const root = path.join(__dirname, "..", ".."); const reportParent = path.join(root, "reports", "raw", "fast", "atomic-ethereum-top-trades-7d-reconstruction");
  const anchors = verifyAnchors(path.join(reportParent, "morpho-stage1-2026-08-26T02-25-32-196Z-8e901119"), path.join(reportParent, REQUIRED_R2_BASENAME)); const source = verifySourceCheckout(path.join(root, "targets", "apyx-evm-contracts-stage2b-fe2ab775")); const original = anchors.stage1.traceProjection.trace.frames;
  const proxy = original.find((frame) => frame.path === "0.0.1.0.1.8"); const implementation = original.find((frame) => frame.path === "0.0.1.0.1.8.0"); const helperIndex = original.findIndex((frame) => frame.path === "0.0.1.0.1.9.0.1");
  for (const frames of [[...original, { ...proxy, path: `${proxy.path}.extra` }], [...original, { ...implementation, path: `${implementation.path}.extra`, selector: "0xa9059cbb" }], original.filter((_, index) => index !== helperIndex)]) {
    const stage1 = structuredClone(anchors.stage1); stage1.traceProjection.trace.frames = frames; assert.throws(() => validateApxUsdCallSurface(stage1, source.artifacts), /call-surface-mismatch/);
  }
});

test("wrong proxy selector, type, or path and source ABI mismatch fail closed", () => {
  const root = path.join(__dirname, "..", ".."); const reportParent = path.join(root, "reports", "raw", "fast", "atomic-ethereum-top-trades-7d-reconstruction");
  const anchors = verifyAnchors(path.join(reportParent, "morpho-stage1-2026-08-26T02-25-32-196Z-8e901119"), path.join(reportParent, REQUIRED_R2_BASENAME)); const source = verifySourceCheckout(path.join(root, "targets", "apyx-evm-contracts-stage2b-fe2ab775"));
  for (const mutation of [{ selector: "0x00000000" }, { type: "CALL" }, { path: "0.0.1.0.1.800" }]) {
    const stage1 = structuredClone(anchors.stage1); const frame = stage1.traceProjection.trace.frames.find((row) => row.path === "0.0.1.0.1.8"); Object.assign(frame, mutation); assert.throws(() => validateApxUsdCallSurface(stage1, source.artifacts), /call-surface-mismatch/);
  }
  const artifacts = { ...source.artifacts, ApxUSD: { ...source.artifacts.ApxUSD, artifact: { ...source.artifacts.ApxUSD.artifact, abi: source.artifacts.ApxUSD.artifact.abi.filter((row) => row.name !== "transferFrom") } } };
  assert.throws(() => validateApxUsdCallSurface(anchors.stage1, artifacts), /source-abi-mismatch/);
});

test("proxy body mismatch is not source-semantic equivalent", () => {
  const source = verifySourceCheckout(path.join(__dirname, "..", "..", "targets", "apyx-evm-contracts-stage2b-fe2ab775")); const runtime = semanticRuntime(source.artifacts.ERC1967Proxy); runtime[8] ^= 1;
  const result = compareRuntime(source.artifacts.ERC1967Proxy, runtime, source.metadataInertness); assert.equal(result.exactBodyMatch, false); assert.equal(result.sourceSemanticEquivalent, false);
});

test("apxUsdSourceBind accepts two independent exact mock runtimes and remains nonpromotable", async (t) => {
  const root = path.join(__dirname, "..", ".."); const reportParent = path.join(root, "reports", "raw", "fast", "atomic-ethereum-top-trades-7d-reconstruction"); const checkout = path.join(root, "targets", "apyx-evm-contracts-stage2b-fe2ab775");
  const source = verifySourceCheckout(checkout); const runtimes = Object.fromEntries(Object.keys(CONTRACTS).map((name) => [name, semanticRuntime(source.artifacts[name])]));
  const runtimeFacts = Object.fromEntries(Object.entries(runtimes).map(([name, bytes]) => [name, { address: CONTRACTS[name].address, length: bytes.length, sha256: sha256(bytes) }]));
  const inventoryEntries = [0, 1].map((index) => ({ url: `http://localhost:${9950 + index}`, lineIndex: index, ethereumHint: true, unsupportedMode: false, declaredGroup: true, groupIdentity: Symbol(`stage2b-family-${index}`) }));
  const captureProvider = async (provider, anchors) => ({ provider, canonical: { transactionHash: anchors.stage1.canonicalEvidence.transaction.hash, blockHash: anchors.stage1.canonicalEvidence.block.hash, receiptTransactionHash: anchors.stage1.canonicalEvidence.receipt.transactionHash, inclusion: anchors.stage1.canonicalEvidence.inclusion }, runtimes: Object.fromEntries(Object.entries(runtimes).map(([name, bytes]) => [name, Buffer.from(bytes)])) });
  const result = await apxUsdSourceBind({ stage1Directory: path.join(reportParent, "morpho-stage1-2026-08-26T02-25-32-196Z-8e901119"), r2Directory: path.join(reportParent, REQUIRED_R2_BASENAME), sourceCheckout: checkout, inventoryEntries, captureProvider, testHooks: { token: TEST_HOOK_TOKEN, transformAnchors: (anchors) => ({ ...anchors, r2: { ...anchors.r2, runtimeFacts } }) } });
  const verdict = result.bundle["stage2b-verdict.json"];
  assert.equal(result.bundle["source-semantics.json"].sourceSemanticEquivalent, true); assert.equal(result.bundle["source-semantics.json"].metadataInertness.compiledExpectedRuntimeTotalLengthsEqual, true); assert.equal(result.bundle["source-semantics.json"].conditionalTokenConclusions.observedExecutorTransferNetRawExact, "1"); assert.equal(verdict.observedExecutorTransferNetRawExact, "1"); assert.equal(verdict.perAddressApxUsdDeltaExact, true); assert.equal(verdict.perAddressApxUsdDeltaRawExact, "1"); assert.equal(verdict.apxUsdCallSurfaceExact, true); assert.equal(verdict.proxySourceRuntimeExact, true); assert.equal(verdict.fullPerAddressAssetVectorExact, false); assert.equal(verdict.routePositive, "unknown"); assert.equal(verdict.promotable, false);
  assert.equal(JSON.stringify(result.bundle).includes(runtimes.ApxUSD.toString("hex")), false);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stage2b-atomic-success-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true })); const output = path.join(parent, "bundle"); atomicBundle(output, result.bundle, atomicWriteOptions("morpho-stage2b-apxusd", result)); assert.ok(fs.existsSync(path.join(output, "manifest.json")));
  const sourceName = Object.keys(result.source.checkout.sourceFiles)[0]; result.source.checkout.sourceFiles[sourceName].sha256 = "0".repeat(64); const rejectedOutput = path.join(parent, "mutated-source-bundle");
  assert.throws(() => atomicBundle(rejectedOutput, result.bundle, atomicWriteOptions("morpho-stage2b-apxusd", result)), /source-mutation/); assert.equal(fs.existsSync(rejectedOutput), false);
});

test("atomic pre-rename source-mutation failure exposes no bundle", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stage2b-atomic-mutation-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true })); const output = path.join(parent, "bundle");
  assert.throws(() => atomicBundle(output, { "stage2b-verdict.json": { promotable: false } }, { beforeRename: () => { throw new Error("stage2b-apxusd-source-mutation"); } }), /source-mutation/);
  assert.equal(fs.existsSync(output), false); assert.equal(fs.readdirSync(parent).length, 0);
});

test("mandatory verdict gates can never promote Stage2B", () => {
  const verdict = { evidenceTier: STAGE2B_TIER, observedExecutorTransferNetRawExact: "1", perAddressApxUsdDeltaExact: false, apxUsdCallSurfaceExact: false, proxySourceRuntimeExact: false, fullPerAddressAssetVectorExact: false, controlledClusterExact: false, scalarHistoricalNetExact: false, routePositive: "unknown", currentExecutable: false, promotable: false };
  assert.doesNotThrow(() => assertMandatoryNonpromotion(verdict));
  const exactR2 = { ...verdict, proxySourceRuntimeExact: true, apxUsdCallSurfaceExact: true, perAddressApxUsdDeltaExact: true }; assert.doesNotThrow(() => assertMandatoryNonpromotion(exactR2));
  for (const mutation of [{ promotable: true }, { routePositive: true }, { currentExecutable: true }, { fullPerAddressAssetVectorExact: true }, { controlledClusterExact: true }, { scalarHistoricalNetExact: true }]) assert.throws(() => assertMandatoryNonpromotion({ ...exactR2, ...mutation }), /nonpromotion-invariant/);
  assert.throws(() => assertMandatoryNonpromotion({ ...verdict, perAddressApxUsdDeltaExact: true }), /nonpromotion-invariant/); assert.throws(() => assertMandatoryNonpromotion({ ...verdict, apxUsdCallSurfaceExact: true }), /nonpromotion-invariant/);
});

test("all Stage2B caps reject unknown, fractional, nonfinite, and over-cap values", () => {
  assert.deepEqual(validateLimits({}), LIMITS);
  for (const field of Object.keys(LIMITS)) for (const value of [NaN, Infinity, 1.5, -1]) assert.throws(() => validateLimits({ [field]: value }), /invalid-limits/);
  for (const row of [{ unknown: 1 }, { requests: 17 }, { traceRequestCap: 3 }, { providerPairChecks: 2 }, { requestTimeoutMs: 8001 }, { totalTimeoutMs: 120001 }, { outputBytes: 524289 }, { traceConcurrency: 2, concurrency: 1 }]) assert.throws(() => validateLimits(row), /invalid-limits/);
});
