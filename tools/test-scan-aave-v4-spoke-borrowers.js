#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");

const { scoreUser, providerCallErrorCode } = require("./scan-aave-v4-spoke-borrowers");

const WAD = 10n ** 18n;
const HF_HEALTHY = 1008643766712415168n; // > 1 WAD
const HF_LIQUIDATABLE = 950000000000000000n;

const IFACE = new ethers.Interface([
  "function getUserAccountData(address user) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getUserReserveStatus(uint256 reserveId,address user) view returns (bool,bool)",
  "function getUserSuppliedAssets(uint256 reserveId,address user) view returns (uint256)",
  "function getUserTotalDebt(uint256 reserveId,address user) view returns (uint256)",
  "function getLiquidationBonus(uint256 reserveId,address user,uint256 healthFactor) view returns (uint256)",
]);
const SELECTOR_TO_SIG = Object.fromEntries(
  Object.values(IFACE.fragments).filter((f) => f.type === "function").map((f) => [f.selector, f.name]),
);

const SPOKE = "0x94e7A5dCbE816e498b89aB752661904E2F56c485";

function makeProvider({ healthFactor = HF_HEALTHY, bonus = "ok", debtFails = false, accountFails = false } = {}) {
  const bonusCalls = [];
  const provider = {
    call: async ({ data }) => {
      const sig = SELECTOR_TO_SIG[data.slice(0, 10)];
      if (accountFails && sig === "getUserAccountData") {
        const error = new Error("execution reverted");
        error.code = "CALL_EXCEPTION";
        throw error;
      }
      if (sig === "getUserAccountData") {
        return IFACE.encodeFunctionResult(sig, [0n, 920000000000000000n, healthFactor, 0n, 0n, 1n, 1n]);
      }
      if (sig === "getUserReserveStatus") return IFACE.encodeFunctionResult(sig, [false, true]);
      if (sig === "getUserSuppliedAssets") return IFACE.encodeFunctionResult(sig, [0n]);
      if (sig === "getUserTotalDebt") {
        if (debtFails) {
          const error = new Error("execution reverted");
          error.code = "CALL_EXCEPTION";
          throw error;
        }
        return IFACE.encodeFunctionResult(sig, [5567493010303n]);
      }
      if (sig === "getLiquidationBonus") {
        const [, , hf] = IFACE.decodeFunctionData(sig, data);
        bonusCalls.push(hf);
        if (bonus === "revert") {
          const error = new Error("execution reverted: Panic due to OVERFLOW(17)");
          error.code = "CALL_EXCEPTION";
          throw error;
        }
        if (bonus === "provider-fail") {
          const error = new Error("gateway timeout");
          error.code = "TIMEOUT";
          throw error;
        }
        return IFACE.encodeFunctionResult(sig, [10499n]);
      }
      throw new Error(`unhandled selector ${data.slice(0, 10)}`);
    },
  };
  return { provider, bonusCalls };
}

const SPOKE_INPUT = {
  hub: "Core Hub",
  hubAddress: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
  spoke: SPOKE,
  totalOwedUsd: 100000,
  linkedAssets: [{
    assetId: 8,
    symbol: "USDG",
    decimals: 6,
    priceUsd: 1,
    reserve: {
      reserveId: 0,
      reserveConfig: { collateralRiskBps: 0 },
      dynamicConfig: { collateralFactorBps: 0, maxLiquidationBonusBps: 10000 },
      oracleData: { price: 1 },
    },
  }],
};

const USER = "0xa33E1f748754D2d624638ab335100d92fcBe62A2";

test("healthy health factor is clamped to 1 WAD before the optional bonus probe", async () => {
  const { provider, bonusCalls } = makeProvider({ healthFactor: HF_HEALTHY });
  const row = await scoreUser(provider, SPOKE_INPUT, USER, { user: USER });
  assert.deepEqual(bonusCalls, [WAD]);
  assert.equal(row.reserveReadCoverage.attempted, 1);
  assert.equal(row.reserveReadCoverage.succeeded, 1);
  assert.equal(row.reserveReadCoverage.failed, 0);
  assert.equal(row.reserveReadCoverage.optionalAttempted, 1);
  assert.equal(row.reserveReadCoverage.optionalSucceeded, 1);
  assert.equal(row.reserveReadCoverage.optionalReverted, 0);
  assert.equal(row.reserves[0].liquidationBonusBps, 10499);
});

test("liquidatable health factor is passed through unclamped", async () => {
  const { provider, bonusCalls } = makeProvider({ healthFactor: HF_LIQUIDATABLE });
  const row = await scoreUser(provider, SPOKE_INPUT, USER, { user: USER });
  assert.deepEqual(bonusCalls, [HF_LIQUIDATABLE]);
  assert.equal(row.reserveReadCoverage.optionalSucceeded, 1);
});

test("a deterministic revert on the optional bonus probe is non-fatal but explicitly counted", async () => {
  const { provider } = makeProvider({ bonus: "revert" });
  const row = await scoreUser(provider, SPOKE_INPUT, USER, { user: USER });
  assert.equal(row.reserveReadCoverage.failed, 0);
  assert.equal(row.reserveReadCoverage.succeeded, 1);
  assert.equal(row.reserveReadCoverage.optionalAttempted, 1);
  assert.equal(row.reserveReadCoverage.optionalReverted, 1);
  assert.equal(row.reserveReadCoverage.optionalFailed, 0);
});

test("a genuine transport failure on the optional bonus probe still fails the row closed", async () => {
  const { provider } = makeProvider({ bonus: "provider-fail" });
  const row = await scoreUser(provider, SPOKE_INPUT, USER, { user: USER });
  assert.equal(row.reserveReadCoverage.failed, 1);
  assert.equal(row.reserveReadCoverage.succeeded, 0);
  assert.equal(row.reserveReadCoverage.optionalFailed, 1);
  assert.equal(row.reserveReadCoverage.optionalReverted, 0);
});

test("a genuine core reserve read failure still fails the row closed", async () => {
  const { provider } = makeProvider({ debtFails: true });
  const row = await scoreUser(provider, SPOKE_INPUT, USER, { user: USER });
  assert.equal(row.reserveReadCoverage.failed, 1);
  assert.equal(row.reserveReadCoverage.succeeded, 0);
});

test("an account read failure short-circuits to an all-zero coverage record", async () => {
  const { provider } = makeProvider({ accountFails: true });
  const row = await scoreUser(provider, SPOKE_INPUT, USER, { user: USER });
  assert.deepEqual(row.reserveReadCoverage, {
    attempted: 0, succeeded: 0, failed: 0,
    optionalAttempted: 0, optionalSucceeded: 0, optionalReverted: 0, optionalFailed: 0,
  });
});

test("providerCallErrorCode separates deterministic reverts from transport failures", () => {
  assert.equal(providerCallErrorCode({ code: "CALL_EXCEPTION" }), "call-reverted");
  assert.equal(providerCallErrorCode({ code: "REVERT" }), "call-reverted");
  assert.equal(providerCallErrorCode({ code: "TIMEOUT" }), "provider-call-failed");
  assert.equal(providerCallErrorCode({}), "provider-call-failed");
});
