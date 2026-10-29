"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const contract = require("./morpho-pt-27aug2026-post-expiry-r2-contract.json");
const adapter = require("./lib/morpho-pt-27aug2026-post-expiry-r2-production-adapter.js");

test("r2 contract preserves the exact r1 engine profile identity", () => {
  assert.equal(contract.engineProfile, "ethereum-morpho-pt-27aug2026-post-expiry-r1");
  assert.equal(contract.enginePublicSchema, "r1-exact");
});

test("r2 request budgets reconcile exactly", () => {
  const { budgets, poolQualification } = contract;
  assert.equal(poolQualification.requestsPerCandidate * contract.inventory.eligiblePoolSize, 32);
  assert.equal(budgets.poolReserved, 32);
  assert.equal(budgets.poolReserved + budgets.engineMaximum, budgets.outerMaximum);
  assert.equal(budgets.enginePerCandidateMaximum, 88);
  assert.equal(budgets.binarySearchMaximum, 37);
  assert.equal(budgets.retries, 0);
});

test("r2 selection is deterministic, family-diverse, and has no backfill", () => {
  assert.equal(contract.selection.maximumSelected, 4);
  assert.equal(contract.selection.familyDiverse, true);
  assert.equal(contract.selection.deterministic, true);
  assert.equal(contract.selection.postSelectionReplacement, false);
  assert.equal(contract.selection.postSelectionBackfill, false);
  assert.equal(contract.selection.engineCandidateIndexIsDense, true);
  assert.equal(contract.selection.retainPoolIndexMapping, true);
});

test("r2 failure taxonomy exactly matches implementation", () => {
  assert.deepEqual(contract.poolQualification.candidateLocalFailures, [
    "HTTP_STATUS", "HTTP_BODY_LIMIT", "RPC_JSON", "RPC_ENVELOPE", "RESULT_SCHEMA",
    "CHAIN_ID_MISMATCH", "BLOCK_NUMBER_MISMATCH", "BLOCK_HASH_MISMATCH",
  ]);
  assert.deepEqual(contract.poolQualification.globalFailureClasses, [
    "AUTHORITY", "ACCOUNTING", "DEADLINE", "REQUEST_CONTRACT", "SOCKET", "INTERNAL",
  ]);
  assert.deepEqual(contract.poolQualification.candidateLocalFailures, [...adapter.LOCAL_FAILURES]);
  assert.deepEqual(contract.poolQualification.globalFailureClasses, [...adapter.GLOBAL_FAILURES]);
});

test("r2 offline implementation forbids external effects", () => {
  assert.equal(contract.production.stagingDuringOfflineImplementation, false);
  assert.equal(contract.production.networkDuringOfflineTests, false);
  assert.equal(contract.production.inventoryReadDuringOfflineTests, false);
  assert.equal(contract.production.r1FilesImmutable, true);
});
