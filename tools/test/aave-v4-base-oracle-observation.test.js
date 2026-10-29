"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const observer = require("../scan-aave-v4-base-oracles");
const contract = require("../lib/aave-v4-base-observation-contract");
const { keccak256 } = require("ethers");
const { makeFixture, semanticDescriptor, A, CODE_HASH } = require("./aave-v4-base-observation-contract.test");
test.beforeEach(t => t.mock.method(global, "fetch", () => assert.fail("network forbidden")));
function descriptors(kind = "round-data", options = { maxAgeSeconds: 30 }) {
  return [semanticDescriptor(contract.ORACLE, "reserve-price-positive-only"), ...contract.FEEDS.map(at => semanticDescriptor(at, kind, options))];
}
test("all eight pinned oracle/source/price links are observed; positive prices and a recent block do not prove freshness", async () => {
  const f = makeFixture(); const out = await observer.collectBaseOracles(f.topology, f.deps);
  assert.equal(out.wiringObserved, true); assert.equal(out.reserves.length, 8); assert.equal(out.componentObservationComplete, true);
  assert.equal(out.sourceSemanticsQualified, false); assert.equal(out.freshness, "UNKNOWN"); assert.equal(f.state.latestRoundReads, 0);
  assert.ok(out.reserves.every(row => row.priceRaw === "100000000")); assert.equal(out.coverage.complete, false);
  assert.equal(out.classSemantics.exact, false); assert.equal(out.coveragePromotion, false); assert.equal(out.liveAdmission, false);
});
test("code-bound source/review artifacts permit typed timestamp evidence without claiming global exact semantics", async () => {
  const f = makeFixture(); const out = await observer.collectBaseOracles(f.topology, { ...f.deps, semanticDescriptors: descriptors() });
  assert.equal(out.sourceSemanticsQualified, true); assert.equal(out.freshness, "PASS"); assert.equal(f.state.latestRoundReads, 8);
  assert.equal(out.classSemantics.exact, false); assert.equal(out.baseGuardQualified, false);
  assert.doesNotMatch(JSON.stringify(out), /SYNTHETIC_SECRET_SOURCE/);
});
test("missing max-age remains UNKNOWN; zero/future/stale timestamps are FAIL, not positive-price freshness", async () => {
  const unknown = makeFixture();
  assert.equal((await observer.collectBaseOracles(unknown.topology, { ...unknown.deps, semanticDescriptors: descriptors("round-data", {}) })).freshness, "UNKNOWN");
  for (const updated of [0n, 999999999999n, -1n]) {
    const f = makeFixture(); f.state.updatedAt = updated < 0 ? BigInt(f.pin.timestamp - 1000) : updated;
    const out = await observer.collectBaseOracles(f.topology, { ...f.deps, semanticDescriptors: descriptors() });
    assert.equal(out.freshness, "FAIL"); assert.equal(out.coverage.complete, false);
  }
});
test("latestAnswer-only source never gets a speculative latestRoundData call", async () => {
  const f = makeFixture(); const out = await observer.collectBaseOracles(f.topology, { ...f.deps, semanticDescriptors: descriptors("answer-only") });
  assert.equal(out.sourceSemanticsQualified, true); assert.equal(out.freshness, "UNKNOWN"); assert.equal(f.state.latestRoundReads, 0);
});
test("a forwarded adapter timestamp cannot qualify freshness without a current child binding", async () => {
  const f = makeFixture(), ds = descriptors();
  ds[1].sourceEvidence.review.statement.timestampPropagation = "propagated";
  ds[1].statementDigest = contract.digest(ds[1].sourceEvidence.review.statement);
  const out = await observer.collectBaseOracles(f.topology, { ...f.deps, semanticDescriptors: ds });
  assert.equal(out.reserves[0].freshness, "UNKNOWN");
  assert.equal(out.reserves[0].sourceSemanticsQualified, false);
  assert.equal(out.freshness, "UNKNOWN");
});
test("a capped parent's fresh child is not a parent timestamp; missing child scope/source cannot fan out", async () => {
  const f = makeFixture();
  const parentCode = "0x73" + contract.FEEDS[1].slice(2) + "00";
  f.state.codeByAddress = { [contract.FEEDS[0]]: parentCode };
  f.deps.runtimeExpectations[1].codeKeccak256 = keccak256(parentCode);
  const ds = descriptors(); ds[1] = semanticDescriptor(contract.FEEDS[0], "capped-child", {
    child: contract.FEEDS[1], maxAgeSeconds: 30, runtimeCode: parentCode, childProof: { opcodePc: 0 } });
  const out = await observer.collectBaseOracles(f.topology, { ...f.deps, semanticDescriptors: ds });
  assert.equal(out.reserves[0].childFreshness, "PASS"); assert.equal(out.reserves[0].freshness, "UNKNOWN"); assert.equal(out.freshness, "UNKNOWN");
  const missing = makeFixture(); const child = A(999);
  const inputs = descriptors(); inputs[1] = semanticDescriptor(contract.FEEDS[0], "capped-child", { child });
  const blocked = await observer.collectBaseOracles(missing.topology, { ...missing.deps, semanticDescriptors: inputs });
  assert.equal(blocked.reserves[0].freshness, "UNKNOWN"); assert.equal(missing.state.calls.some(row => row.to === child), false);
  assert.equal(blocked.sourceSemanticsQualified, false);
});
test("source/address/reciprocal-link/codehash mismatches fail closed and sourceBound booleans are not proof", async () => {
  for (const mutate of [f => { f.state.wrongSource = contract.FEEDS[1]; }, f => { f.state.wrongSpoke = A(333); },
    f => { f.state.wrongOracle = A(333); }, f => { f.state.badCode = true; }, f => { f.state.price = 0n; }]) {
    const f = makeFixture(); mutate(f); const out = await observer.collectBaseOracles(f.topology, f.deps);
    assert.equal(out.componentObservationComplete, false); assert.ok(out.errors.length);
  }
  for (const descriptor of [{ address: contract.FEEDS[0], codeKeccak256: CODE_HASH, sourceBound: true },
    { ...semanticDescriptor(contract.FEEDS[0]), codeKeccak256: "0x" + "00".repeat(32) }]) {
    const f = makeFixture(); const out = await observer.collectBaseOracles(f.topology, { ...f.deps, semanticDescriptors: [descriptor] });
    assert.ok(out.errors.includes("SOURCE_BINDING_INVALID")); assert.equal(out.componentObservationComplete, false);
  }
});
test("artifact address/source-hash mismatches and pointer drift are not source qualification", async () => {
  for (const mutate of [d => {
    const artifact = JSON.parse(d.sourceEvidence.artifactJson); artifact.address = A(999);
    d.sourceEvidence.artifactJson = JSON.stringify(artifact); d.sourceEvidence.artifactSha256 = contract.sha256(d.sourceEvidence.artifactJson);
  }, d => { d.sourceEvidence.sourceSha256 = "0".repeat(64); }]) {
    const f = makeFixture(), descriptor = semanticDescriptor(contract.FEEDS[0]); mutate(descriptor);
    const out = await observer.collectBaseOracles(f.topology, { ...f.deps, semanticDescriptors: [descriptor] });
    assert.ok(out.errors.includes("SOURCE_BINDING_INVALID")); assert.equal(out.sourceSemanticsQualified, false);
  }
  const f = makeFixture(); f.deps.runtimeExpectations[1].implementation = contract.IMPLEMENTATION;
  f.deps.runtimeExpectations[1].implementationCodeKeccak256 = CODE_HASH;
  const out = await observer.collectBaseOracles(f.topology, f.deps);
  assert.ok(out.errors.includes("RUNTIME_BINDING_INVALID")); assert.equal(out.componentObservationComplete, false);
});
test("transport and terminal errors carry fixed codes only, never injected secret error data", async () => {
  for (const terminal of [false, true]) {
    const f = makeFixture(); f.state.terminalFailure = terminal;
    if (!terminal) { f.state.failName = "getReservePrice"; f.state.failure = { message: "SYNTHETIC_SECRET_HTTP", code: "SYNTHETIC_SECRET_CODE", body: "SYNTHETIC_SECRET_BODY" }; }
    const out = await observer.collectBaseOracles(f.topology, { ...f.deps, ...(terminal ? { semanticDescriptors: descriptors() } : {}) });
    assert.equal(out.componentObservationComplete, false); assert.doesNotMatch(JSON.stringify(out), /SYNTHETIC_SECRET/);
    if (terminal) { assert.equal(out.observationPin, null); assert.equal(out.freshness, "UNKNOWN"); assert.equal(out.sourceSemanticsQualified, false); }
  }
});

function archivedEacDescriptor() {
  const root = path.resolve(__dirname, "../../reports/coverage-unblock-20261018/continuation/public-base-sources");
  const artifactJson = fs.readFileSync(path.join(root, "feed-0.json"), "utf8");
  const artifact = JSON.parse(artifactJson), source = artifact.sources["EACAggregatorProxy.sol"].content;
  assert.equal(artifact.compilation.compilerVersion, "0.6.6+commit.6c089d02");
  assert.equal(artifact.metadata.compiler.version, artifact.compilation.compilerVersion);
  assert.equal(fs.readFileSync(path.join(root, "derived/feed-0-source-0.sol"), "utf8"), source);
  assert.ok(source.includes("current.aggregator.latestRoundData()"));
  assert.ok(source.includes("return addPhaseIds(roundId, answer, startedAt, updatedAt, ansIn, current.id);"));
  const code = artifact.runtimeBytecode.onchainBytecode, hash = keccak256(code);
  const inventory = require("../../reports/coverage-unblock-20261018/base-typed-validation/code-inventory.json");
  assert.equal(inventory.rows.find(row => row.address === contract.FEEDS[0]).codeKeccak256, hash);
  const statement = { kind: "round-data", timestampPropagation: "propagated", maxAgeSeconds: 30 };
  return { code, descriptor: { address: contract.FEEDS[0], codeKeccak256: hash, statementDigest: contract.digest(statement),
    sourceEvidence: { schema: "aave-v4-base-source-evidence/v1", artifactJson, artifactSha256: contract.sha256(artifactJson),
      sourcePath: "EACAggregatorProxy.sol", sourceSha256: contract.sha256(source), review: {
        schema: "aave-v4-code-bound-semantic-review/v1", sourceSha256: contract.sha256(source), codeKeccak256: hash, statement } } } };
}

test("real archived EAC 0.6.6 source/runtime binds without inventing current child timestamp qualification", async () => {
  const f = makeFixture(), archived = archivedEacDescriptor(), ds = descriptors();
  f.state.codeByAddress = { [contract.FEEDS[0]]: archived.code };
  f.deps.runtimeExpectations[1].codeKeccak256 = keccak256(archived.code);
  ds[1] = archived.descriptor;
  const out = await observer.collectBaseOracles(f.topology, { ...f.deps, semanticDescriptors: ds });
  assert.deepEqual(out.errors, []);
  assert.equal(out.wiringObserved, true); assert.equal(out.componentObservationComplete, true);
  assert.equal(out.reserves[0].runtimeCodeKeccak256, archived.descriptor.codeKeccak256);
  assert.equal(out.reserves[0].freshness, "UNKNOWN");
  assert.equal(out.reserves[0].reason, "CURRENT_CHILD_BINDING_UNQUALIFIED");
  assert.equal(out.reserves[0].timestampEvidence, "ADAPTER_PROPAGATED");
  assert.equal(out.reserves[0].sourceSemanticsQualified, false);
  assert.equal(out.freshness, "UNKNOWN"); assert.equal(out.sourceSemanticsQualified, false);
  assert.equal(f.state.calls.filter(row => row.name === "latestRoundData" && row.to === contract.FEEDS[0]).length, 0);
  for (const flag of [out.coverage.complete, out.classSemantics.exact, out.coveragePromotion, out.dispatchEnabled, out.liveAdmission]) assert.equal(flag, false);
});

test("the archived compiler exception is exact, with all artifact/source/runtime/review bindings still required", async () => {
  for (const compilerVersion of ["0.6.7+commit.b8d736ae", "0.6.6+commit.deadbeef", "0.6.6", "0.6.6+commit.6c089d02.SYNTHETIC_SECRET"]) {
    const f = makeFixture(), archived = archivedEacDescriptor();
    f.state.codeByAddress = { [contract.FEEDS[0]]: archived.code };
    f.deps.runtimeExpectations[1].codeKeccak256 = keccak256(archived.code);
    const artifact = JSON.parse(archived.descriptor.sourceEvidence.artifactJson);
    artifact.compilation.compilerVersion = compilerVersion;
    archived.descriptor.sourceEvidence.artifactJson = JSON.stringify(artifact);
    archived.descriptor.sourceEvidence.artifactSha256 = contract.sha256(archived.descriptor.sourceEvidence.artifactJson);
    const out = await observer.collectBaseOracles(f.topology, { ...f.deps, semanticDescriptors: [archived.descriptor] });
    assert.ok(out.errors.includes("SOURCE_BINDING_INVALID"));
    assert.equal(out.componentObservationComplete, false); assert.equal(out.freshness, "UNKNOWN");
    assert.doesNotMatch(JSON.stringify(out), /SYNTHETIC_SECRET/);
  }
});
