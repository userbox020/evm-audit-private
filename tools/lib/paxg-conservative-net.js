"use strict";

// Integer-only, read-only economics for ONE exact two-transaction PAXG route.
// Every quote and haircut is required; positive net is advisory, not authority.
const USD_SCALE = 10n ** 8n;
const RAW_USD = 10n ** 6n;
const ETH_WEI = 10n ** 18n;
const PAXG_WEI = 10n ** 18n;
const MAX_GAS_WEI_PER_TX = 5n * 10n ** 16n; // 0.05 ETH
const MAX_CAPITAL_WEI_PER_ACTION = 10n ** 16n; // 0.01 ETH
const divUp = (a, b) => (a + b - 1n) / b;

function nonnegative(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error("MISSING_OR_INVALID_ECONOMIC_INPUT");
  return BigInt(value);
}

function evaluatePaxgNet(data) {
  try {
    if (!data || typeof data !== "object") throw new Error("MISSING_OR_INVALID_ECONOMIC_INPUT");
    const loanRaw = nonnegative(data.borrowUsdcRaw);
    const availableRaw = nonnegative(data.availableUsdcRaw);
    const collateralWei = nonnegative(data.collateralPaxgWei);
    const loanUsd8 = nonnegative(data.usdcUsdE8);
    const paxgUsd8 = nonnegative(data.paxgUsdE8);
    const ethUsd8 = nonnegative(data.ethUsdE8);
    const gasLimits = [nonnegative(data.supplyGasLimit), nonnegative(data.borrowGasLimit)];
    const maxFeeWei = nonnegative(data.maxFeePerGasWei);
    const exitBps = nonnegative(data.exitSlippageBps);
    const financingUsdRaw = nonnegative(data.financingUsdRaw);
    const competitionUsdRaw = nonnegative(data.competitionUsdRaw);
    const uncertaintyUsdRaw = nonnegative(data.uncertaintyUsdRaw);
    if (loanRaw !== 100n * RAW_USD || availableRaw < loanRaw + RAW_USD ||
        collateralWei !== 1_000_000_000_000n ||
        loanUsd8 === 0n || paxgUsd8 === 0n || ethUsd8 === 0n ||
        maxFeeWei === 0n || gasLimits.some((limit) => limit === 0n) || exitBps > 10_000n) {
      throw new Error("INVALID_ROUTE_OR_UNPRICED_LIQUIDITY");
    }
    if (gasLimits.some((limit) => limit * maxFeeWei > MAX_GAS_WEI_PER_TX)) throw new Error("GAS_CAP_EXCEEDED");

    const gross = loanRaw * loanUsd8 / USD_SCALE;
    const collateral = divUp(collateralWei * paxgUsd8 * RAW_USD, PAXG_WEI * USD_SCALE);
    const totalGasWei = (gasLimits[0] + gasLimits[1]) * maxFeeWei;
    const gas = divUp(totalGasWei * ethUsd8 * RAW_USD, ETH_WEI * USD_SCALE);
    if (collateral * ETH_WEI * USD_SCALE > MAX_CAPITAL_WEI_PER_ACTION * ethUsd8 * RAW_USD) {
      throw new Error("CAPITAL_CAP_EXCEEDED");
    }
    const exit = divUp(gross * exitBps, 10_000n);
    const costs = collateral + gas + exit + financingUsdRaw + competitionUsdRaw + uncertaintyUsdRaw;
    const net = gross - costs;
    const attackerCapital = collateral + gas + financingUsdRaw;
    return {
      economicPositive: net > 0n,
      grossUsdRaw: gross.toString(), totalCostsUsdRaw: costs.toString(), netUsdRaw: net.toString(),
      netNativeEthWei: (net * ETH_WEI * USD_SCALE / (ethUsd8 * RAW_USD)).toString(),
      netBpsOfCapital: attackerCapital > 0n ? (net * 10_000n / attackerCapital).toString() : null,
      collateralUsdRaw: collateral.toString(), gasUsdRaw: gas.toString(),
      exitUsdRaw: exit.toString(),
      executable: false, // Needs a fresh signed v3 batch and route-real fork proof.
    };
  } catch (error) {
    return { economicPositive: false, executable: false, blocker: error.message };
  }
}

module.exports = { evaluatePaxgNet };
