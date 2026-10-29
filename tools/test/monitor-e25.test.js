"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("../node_modules/ethers");
const {
  E25_AMOUNT_FOR_SHARE_SELECTOR,
  evaluateE25Rates,
} = require("../monitor-novelty-conditions");

test("E25 uses the four-byte amountForShare selector", () => {
  assert.equal(E25_AMOUNT_FOR_SHARE_SELECTOR, ethers.id("amountForShare(uint256)").slice(0, 10));
  assert.equal(E25_AMOUNT_FOR_SHARE_SELECTOR.length, 10);
});

test("E25 rejects a giant decoded rate and clears the gap", () => {
  const result = evaluateE25Rates(1e30, 1.01);
  assert.equal(result.status, "INVALID_DATA");
  assert.equal(result.valid, false);
  assert.equal(result.gapBps, null);
});

test("E25 accepts plausible rates and bounds the computed gap", () => {
  const valid = evaluateE25Rates(1.05, 1.0);
  const invalidGap = evaluateE25Rates(2.0, 0.5);

  assert.equal(valid.valid, true);
  assert.ok(Math.abs(valid.gapBps - 500) < 1e-9);
  assert.equal(invalidGap.status, "INVALID_DATA");
  assert.equal(invalidGap.gapBps, null);
});
