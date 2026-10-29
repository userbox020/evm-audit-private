#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const framework = require("./deployed-delta-adapters/index.js");
const pendle = require("./deployed-delta-adapters/pendle-core-v2.js");

const hash = (character) => character.repeat(64);
function input(overrides = {}) {
  return {
    repositoryId: pendle.REPOSITORY_ID,
    pinnedCommit: "1".repeat(40),
    manifestPath: "deployments/mainnet/market.json",
    manifestBlobCommitment: hash("2"),
    declarationCommitment: hash("3"),
    upstreamExtractorCommitment: hash("4"),
    upstreamRecordCommitment: hash("5"),
    manifest: {},
    ...overrides
  };
}

test("allowed Pendle deployment and artifact paths are deterministic UNKNOWN", () => {
  const paths = [
    "deployments/mainnet/market.json",
    "artifacts/contracts/Market.sol/Market.json",
    "artifacts/build-info/build.json",
    "build-info/build.json",
    ".openzeppelin/mainnet.json"
  ];
  for (const manifestPath of paths) {
    const first = pendle.extract(input({ manifestPath, manifest: { z: 1 } }));
    const second = pendle.extract(input({ manifestPath, manifest: { a: [1, 2, 3] } }));
    assert.deepEqual(first, {
      status: "UNKNOWN",
      reason: "DEPLOYMENT_METADATA_ABSENT"
    });
    assert.deepEqual(first, second);
    assert.equal(Object.isFrozen(first), true);
  }
});

test("unsupported repositories and non-metadata paths are rejected without inference", () => {
  assert.deepEqual(pendle.extract(input({ repositoryId: "compound-finance/comet" })), {
    status: "UNKNOWN", reason: "UNSUPPORTED_MANIFEST"
  });
  for (const manifestPath of [
    "package.json",
    "hardhat.config.ts",
    "hardhat.config.js",
    "contracts/Market.sol",
    "deployments/../package.json"
  ]) {
    assert.deepEqual(pendle.extract(input({ manifestPath })), {
      status: "UNKNOWN", reason: "UNSUPPORTED_MANIFEST"
    });
  }

  const unknownRepository = framework.dispatch(input({ repositoryId: "unknown/project" }));
  const unsupportedPath = framework.dispatch(input({ manifestPath: "package.json" }));
  assert.equal(unknownRepository.reason, "UNKNOWN_REPOSITORY");
  assert.equal(unsupportedPath.reason, "UNSUPPORTED_MANIFEST");
  assert.equal(framework.validateResult(unknownRepository), true);
  assert.equal(framework.validateResult(unsupportedPath), true);
});

test("shared input guards reject malformed and capped inputs", () => {
  assert.equal(framework.dispatch(input({ pinnedCommit: "not-a-commit" })).reason, "INPUT_MALFORMED");
  assert.equal(framework.dispatch(input({ manifestPath: "https://rpc.invalid/secret.json" })).reason,
    "INPUT_MALFORMED");
  assert.equal(framework.dispatch(input({ manifest: new Array(4_097).fill(null) })).reason,
    "INPUT_CAP_EXCEEDED");
  let deep = {};
  for (let index = 0; index < 70; index += 1) deep = { child: deep };
  assert.equal(framework.dispatch(input({ manifest: deep })).reason, "INPUT_CAP_EXCEEDED");
});

test("unknown output is bounded and cannot leak ignored input content", () => {
  const secrets = [
    `0x${"a".repeat(40)}`,
    "https://rpc.invalid/private",
    "private_key=do-not-persist",
    "hardhat.config.ts",
    "package.json"
  ];
  const output = pendle.extract(input({ manifest: {
    address: secrets[0], endpoint: secrets[1], credential: secrets[2],
    package: secrets[4], hardhatConfig: secrets[3],
    mappings: new Array(4_096).fill("invented")
  } }));
  const serialized = JSON.stringify(output);
  assert.ok(Buffer.byteLength(serialized, "utf8") < 128);
  assert.deepEqual(Object.keys(output).sort(), ["reason", "status"]);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  assert.equal(Object.isFrozen(pendle.registration), true);
  assert.equal(pendle.registration.repositoryId, pendle.REPOSITORY_ID);
});
