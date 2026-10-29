#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const binder = require("./bind-morpho-pt-27aug2026-r5-wrappers.js");
const profileModule = require("./morpho-pt-27aug2026-post-expiry-r1-profile.js");

const APX = profileModule.ADDRESSES.apxWrapper;
const APY = profileModule.ADDRESSES.apyWrapper;
const TARGET_FILE = binder._test.TARGET_FILE;
const TARGET_CONTRACT = binder._test.TARGET_CONTRACT;

function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function patchedHash(template, references, address) {
  const runtime = Buffer.from(template);
  const word = Buffer.from(address.slice(2).padStart(64, "0"), "hex");
  for (const reference of references) word.copy(runtime, reference.start);
  return binder.sha256(runtime);
}

function fixture(overrides = {}) {
  const compilerInputs = readJson(binder.PATHS.compilerInputs);
  const sourceManifest = readJson(binder.PATHS.sourceManifest);
  const capture = readJson(binder.PATHS.capture);
  const template = Buffer.alloc(overrides.runtimeBytes || 923);
  for (let index = 0; index < template.length; index += 1) template[index] = (index * 17 + 3) & 0xff;
  const references = clone(overrides.references || [{ start: 96, length: 32 }, { start: 512, length: 32 }]);
  for (const reference of references) {
    if (reference.start >= 0 && reference.start + reference.length <= template.length) template.fill(0, reference.start, reference.start + reference.length);
  }
  if (overrides.runtimeMutation) template[0] ^= 1;
  const output = {
    contracts: {
      [TARGET_FILE]: {
        [TARGET_CONTRACT]: {
          evm: { deployedBytecode: { object: template.toString("hex"), immutableReferences: { "7": references }, linkReferences: {} } },
        },
      },
    },
    sources: {
      [TARGET_FILE]: {
        ast: { nodeType: "SourceUnit", nodes: [{ id: 7, nodeType: "VariableDeclaration", name: "innerOracle",
          mutability: "immutable", typeDescriptions: { typeString: "contract IPChainlinkOracleEssential" } }] },
      },
    },
  };
  const outputText = JSON.stringify(output);
  let compileCalls = 0;
  const compilerAdapter = {
    version: `${binder.EXPECTED_COMPILER}.fixture`,
    commitment: { kind: "INJECTED_FIXTURE", bytes: outputText.length, sha256: binder.sha256(Buffer.from(outputText)) },
    compile() { compileCalls += 1; return overrides.outputForCall ? overrides.outputForCall(compileCalls, outputText) : outputText; },
  };
  const profileAuthority = {
    ADDRESSES: clone(profileModule.ADDRESSES),
    RUNTIME_BASELINES: clone(profileModule.RUNTIME_BASELINES),
    PROFILE_HASH: profileModule.PROFILE_HASH,
  };
  const apxHash = patchedHash(template, references.filter((row) => row.start >= 0 && row.start + row.length <= template.length),
    profileAuthority.ADDRESSES.apxInner);
  const apyHash = patchedHash(template, references.filter((row) => row.start >= 0 && row.start + row.length <= template.length),
    profileAuthority.ADDRESSES.apyInner);
  profileAuthority.RUNTIME_BASELINES.apxWrapper = [923, apxHash];
  profileAuthority.RUNTIME_BASELINES.apyWrapper = [923, apyHash];
  capture.code[APX].bytes = 923;
  capture.code[APX].sha256 = apxHash;
  capture.code[APY].bytes = 923;
  capture.code[APY].sha256 = apyHash;
  return { compilerInputs, sourceManifest, capture, profileAuthority, compilerAdapter, compileCalls: () => compileCalls };
}

function run(values) {
  return binder.buildBinding({
    compilerInputs: values.compilerInputs,
    sourceManifest: values.sourceManifest,
    capture: values.capture,
    profileAuthority: values.profileAuthority,
    compilerAdapter: values.compilerAdapter,
  });
}

test("fixture adapter passes exact two-wrapper binding and compiles each input twice", () => {
  const values = fixture();
  const artifact = run(values);
  assert.equal(artifact.disposition, binder.PASS);
  assert.equal(values.compileCalls(), 4);
  assert.deepEqual(artifact.wrappers.map((row) => row.address), [APX, APY]);
  assert.ok(artifact.wrappers.every((row) => row.runtime.expectedBytes === 923
    && row.runtime.expectedSha256 === row.runtime.observedSha256
    && row.runtime.observedSha256 === row.runtime.reconstructedSha256
    && row.compiler.outputByteIdenticalAcrossTwoRuns === true
    && row.immutable.name === "innerOracle" && row.immutable.references.length === 2));
  assert.equal(artifact.gates.oracleSubgraphSourceRuntime, "PASS");
  for (const gate of ["overallSourceRuntime", "protocolLoss", "publicExit", "economics", "fork"]) {
    assert.match(artifact.gates[gate], /CLOSED/);
  }
  assert.equal(/https?:\/\//i.test(JSON.stringify(artifact)), false);
});

test("source mutation is blocked by declared source hash authority", () => {
  const values = fixture();
  values.compilerInputs.contracts.find((row) => row.address === APX).sources[TARGET_FILE].content += " ";
  const artifact = run(values);
  assert.equal(artifact.disposition, binder.BLOCKED);
  assert.equal(artifact.failure.code, "SOURCE_HASH_MISMATCH");
  assert.equal(values.compileCalls(), 0);
});

test("settings mutation is blocked rather than guessed", () => {
  const values = fixture();
  values.compilerInputs.contracts.find((row) => row.address === APY).compilerSettings.optimizer.runs = 1000000;
  const artifact = run(values);
  assert.equal(artifact.disposition, binder.BLOCKED);
  assert.equal(artifact.failure.code, "COMPILER_SETTINGS_MISMATCH");
});

test("inner address mutation is blocked before compilation", () => {
  const values = fixture();
  const row = values.compilerInputs.contracts.find((candidate) => candidate.address === APX);
  row.constructorArgs = `000000000000000000000000${profileModule.ADDRESSES.apyInner.slice(2)}`;
  row.decodedConstructorArgs[0][0] = profileModule.ADDRESSES.apyInner;
  const artifact = run(values);
  assert.equal(artifact.disposition, binder.BLOCKED);
  assert.equal(artifact.failure.code, "INNER_ORACLE_CONSTRUCTOR_MISMATCH");
  assert.equal(values.compileCalls(), 0);
});

test("compiler-declared immutable out-of-range mutation stops runtime admission", () => {
  const values = fixture({ references: [{ start: 900, length: 32 }] });
  const artifact = run(values);
  assert.equal(artifact.disposition, binder.STOP);
  assert.equal(artifact.failure.code, "IMMUTABLE_REFERENCE_INVALID");
  assert.equal(artifact.gates.oracleSubgraphSourceRuntime, "CLOSED");
});

test("compiled runtime length mutation stops runtime admission", () => {
  const values = fixture({ runtimeBytes: 922 });
  const artifact = run(values);
  assert.equal(artifact.disposition, binder.STOP);
  assert.equal(artifact.failure.code, "COMPILED_RUNTIME_LENGTH_MISMATCH");
});

test("compiled runtime hash mutation stops runtime admission", () => {
  const values = fixture();
  const normalOutput = values.compilerAdapter.compile();
  const decoded = JSON.parse(normalOutput);
  const runtime = Buffer.from(decoded.contracts[TARGET_FILE][TARGET_CONTRACT].evm.deployedBytecode.object, "hex");
  runtime[0] ^= 1;
  decoded.contracts[TARGET_FILE][TARGET_CONTRACT].evm.deployedBytecode.object = runtime.toString("hex");
  const mutatedOutput = JSON.stringify(decoded);
  values.compilerAdapter.compile = () => mutatedOutput;
  const artifact = run(values);
  assert.equal(artifact.disposition, binder.STOP);
  assert.equal(artifact.failure.code, "RECONSTRUCTED_RUNTIME_HASH_MISMATCH");
  assert.equal(artifact.wrappers.length, 2);
  assert.match(artifact.wrappers[0].failure.evidence.reconstructedSha256, /^0x[0-9a-f]{64}$/);
});

test("same fixture inputs produce byte-identical deterministic artifact JSON", () => {
  const left = run(fixture());
  const right = run(fixture());
  assert.equal(binder.serializedArtifact(left).toString("utf8"), binder.serializedArtifact(right).toString("utf8"));
});
