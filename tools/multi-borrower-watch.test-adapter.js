"use strict";
// Deliberately non-Morpho adapter: no addresses, ABIs, or token decimal assumptions.
const block = { number: "0x10", hash: `0x${"33".repeat(32)}`, timestamp: "0x100" };
module.exports = {
  default: { chainId: 1, watchList: [] },
  async readMarketTotal() { return { lltv: 1n }; },
  async readPosition(_market, borrower) {
    if (borrower === "failed") throw new Error("RPC_FAILURE");
    return { debt: borrower === "no-debt" ? 0n : 1n, collateral: borrower === "healthy" ? 2n : 1n };
  },
  async readOraclePrice() { return 1n; },
  computeHF(debt, collateral) { return { hf: debt ? `${collateral}.000000000000000000` : null, hfWad: debt ? (collateral * 10n ** 18n).toString() : null,
    noDebt: debt === 0n, verdict: collateral > debt ? "SCOPED_ABOVE_THRESHOLD" : "LIQUIDATABLE", protocolLiquidatableAtPin: debt > collateral }; },
  fixtureSend() { return async (method, args) => method === "eth_chainId" ? "0x1" : { ...block, number: args[0] === "finalized" ? block.number : args[0] }; },
};
