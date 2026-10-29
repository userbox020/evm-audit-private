"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const binder = require("./bind-venus-token-buyback-source-runtime.js");

const ROOT = path.resolve(__dirname, "..");
const FIXED = path.join(ROOT, "reports", "raw", "fast", "venus-psr-bnb-fixed-block.json");

function fixedArtifact() {
  return JSON.parse(fs.readFileSync(FIXED, "utf8"));
}

test("offline immutable-aware binding reproduces all nine implementations and shared proxy", () => {
  const artifact = binder.buildBinding();
  assert.equal(artifact.status, "TOKEN_BUYBACK_SOURCE_RUNTIME_BOUND_9_OF_9");
  assert.equal(artifact.compiler.version, "0.8.25+commit.b61c2a91");
  assert.match(artifact.sourceCheckout.commit, /^[0-9a-f]{40}$/);
  assert.match(artifact.sourceCheckout.tree, /^[0-9a-f]{40}$/);
  assert.equal(artifact.result.matched, 9);
  assert.equal(artifact.result.mismatched, 0);
  assert.equal(artifact.result.allExactImmutableAwareMatches, true);
  assert.equal(artifact.sharedProxy.proxyCount, 9);
  assert.equal(artifact.sharedProxy.allExactMatches, true);
  assert.equal(new Set(artifact.sharedProxy.addresses).size, 9);
  assert.ok(artifact.implementations.every((row) =>
    row.implementationRuntime.match && row.proxyRuntime.match
      && row.implementationRuntime.capturedSha256 === row.implementationRuntime.reconstructedSha256
      && row.proxyRuntime.capturedSha256 === row.proxyRuntime.reconstructedSha256));
});

test("binding scope expressly leaves PSR source-unbound and contains no provider material", () => {
  const artifact = binder.buildBinding();
  assert.equal(artifact.scope.protocolShareReserve, "EXCLUDED_SOURCE_UNBOUND");
  assert.equal(artifact.scope.psrSourceBindingClaimed, false);
  assert.equal(artifact.result.providerAccessed, false);
  const serialized = JSON.stringify(artifact);
  assert.equal(/https?:\/\//i.test(serialized), false);
  assert.equal(/(?:endpoint|rpcUrl|providerUrl|headers)/i.test(serialized), false);
});

test("same local inputs produce byte-for-byte deterministic evidence", () => {
  const identity = { commit: "1".repeat(40), tree: "2".repeat(40) };
  const left = binder.buildBinding({ sourceIdentity: identity });
  const right = binder.buildBinding({ sourceIdentity: identity });
  assert.equal(JSON.stringify(left), JSON.stringify(right));
});

test("any captured implementation or proxy hash mismatch fails closed", () => {
  for (const field of ["implementation", "proxy"]) {
    const fixed = fixedArtifact();
    if (field === "implementation") fixed.destinationClassifications[0].resolvedRuntime.code.sha256 = `0x${"00".repeat(32)}`;
    else fixed.destinationClassifications[0].code.sha256 = `0x${"00".repeat(32)}`;
    assert.throws(
      () => binder.buildBinding({ fixedArtifact: fixed }),
      (error) => error instanceof binder.BindingError && error.code === `${field.toUpperCase()}_RUNTIME_HASH_MISMATCH`,
    );
  }
});

test("captured set must be exactly nine unique TokenBuyback candidates", () => {
  const fixed = fixedArtifact();
  fixed.destinationClassifications.pop();
  assert.throws(
    () => binder.buildBinding({ fixedArtifact: fixed }),
    (error) => error instanceof binder.BindingError && error.code === "CAPTURED_DESTINATION_COUNT_MISMATCH",
  );
});
