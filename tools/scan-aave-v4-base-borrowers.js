#!/usr/bin/env node
"use strict";

// No native provider/store/CLI path. All collection authority is injected.
const { Interface } = require("ethers");
const contract = require("./lib/aave-v4-base-observation-contract");
const ABI = new Interface([
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getUserReserveStatus(uint256,address) view returns (bool,bool)",
  "function getUserSuppliedAssets(uint256,address) view returns (uint256)",
  "function getUserTotalDebt(uint256,address) view returns (uint256)",
  "function getUserPosition(uint256,address) view returns (uint120,uint120,int200,uint120,uint32)",
  "function getDynamicReserveConfig(uint256,uint32) view returns (uint16,uint32,uint16)",
  "function getSpokeDrawnShares(uint256,address) view returns (uint256)",
  "function getSpokePremiumData(uint256,address) view returns (uint256,int256)",
  "function getAssetDrawnIndex(uint256) view returns (uint256)",
]);
const RAY = 10n ** 27n;
// Spoke.sol:600-607 / UserPositionUtils:127-132 and Hub.sol:785-810:
// drawn and premium round UP separately. Rounded user debts are not additive.
function debtFromComponents(drawnShares, premiumShares, premiumOffsetRay, index) {
  const premiumSharesRay = premiumShares * index, premiumRay = premiumSharesRay - premiumOffsetRay;
  if (index <= 0n || premiumSharesRay >= 2n ** 255n || premiumRay < 0n || premiumRay >= 2n ** 255n
    || drawnShares * index >= 2n ** 256n) contract.fail("BORROWER_DEBT_UNACCOUNTED");
  return (drawnShares * index + RAY - 1n) / RAY + (premiumRay + RAY - 1n) / RAY;
}
async function collectBaseBorrowers(topology, deps = {}) {
  const out = contract.result("borrower", deps.now);
  out.componentScope = "INDEXED_BORROWER_ACCOUNTS_AND_EIGHT_RESERVES_NOT_LIVE_ADMISSION";
  out.spoke = contract.SPOKE; out.users = []; out.linksConsumed = []; out.fullHistoryProven = false;
  out.debtAccounting = "UNKNOWN"; out.debtReconciliation = [];
  let state, history, advanced, identity;
  try {
    const prepared = await contract.openObservation(topology, deps, { historyProbe: {
      addresses: [contract.SPOKE], topic: require("ethers").id("Borrow(uint256,address,address,uint256,uint256)"),
    } });
    state = { ...prepared, counts: { attempted: 0, succeeded: 0, failed: 0 } };
    const proof = contract.startProof(deps.startProof, prepared);
    const maxUsers = deps.maxUsers ?? 10000;
    if (!Number.isSafeInteger(maxUsers) || maxUsers < 1 || maxUsers > 10000) contract.fail("INPUT_INVALID");
    history = require("./lib/aave-v4-borrower-history");
    identity = history.historyIdentity([contract.SPOKE], prepared.registryDigest, { chainId: 8453,
      namespace: "aave-v4-base-borrower-history/v1", reserveIds: prepared.links.map(row => row.reserveId), startProof: proof,
      deploymentBindings: [{ spoke: contract.SPOKE, implementation: contract.IMPLEMENTATION, implementationCodeKeccak256: contract.IMPL_HASH }] });
    let index;
    try {
      index = deps.historyStore ? await deps.historyStore.load(identity) : history.emptyHistory(identity);
      history.validateHistory(index, identity);
      advanced = await history.advanceHistory(state.context, index, deps.historyOptions || {});
    } catch (_) { contract.fail("HISTORY_INVALID"); }
    out.history = { namespace: identity.namespace, identityDigest: contract.digest(identity), fromBlock: identity.fromBlock,
      throughBlock: advanced.index.throughBlock, throughBlockHash: advanced.index.throughBlockHash,
      logs: advanced.index.logs, committedChunks: advanced.index.committedChunks, rangeComplete: advanced.complete, startKind: proof.kind };
    if (!advanced.complete) out.errors.push("HISTORY_INCOMPLETE");
    out.fullHistoryProven = advanced.complete && proof.fullHistoryEligible;
    const users = advanced.index.users[contract.SPOKE];
    const debtSums = Array(8).fill(0n);
    const componentSums = Array.from({ length: 8 }, () => ({ drawnShares: 0n, premiumShares: 0n, premiumOffsetRay: 0n }));
    for (const entry of users.slice(0, maxUsers)) {
      const account = await contract.read(state, contract.SPOKE, ABI, "getUserAccountData", [entry.user]);
      const row = { user: entry.user, accountRaw: Array.from(account, String), reserves: [], usdValue: null };
      for (const link of prepared.links) {
        const args = [link.reserveId, entry.user];
        const status = await contract.read(state, contract.SPOKE, ABI, "getUserReserveStatus", args);
        const supplied = await contract.read(state, contract.SPOKE, ABI, "getUserSuppliedAssets", args);
        const debt = await contract.read(state, contract.SPOKE, ABI, "getUserTotalDebt", args);
        const position = await contract.read(state, contract.SPOKE, ABI, "getUserPosition", args);
        const userKey = Number(position[4]);
        const dynamic = await contract.read(state, contract.SPOKE, ABI, "getDynamicReserveConfig", [link.reserveId, userKey]);
        debtSums[link.reserveId] += debt[0];
        componentSums[link.reserveId].drawnShares += position[0];
        componentSums[link.reserveId].premiumShares += position[1];
        componentSums[link.reserveId].premiumOffsetRay += position[2];
        row.reserves.push({ reserveId: link.reserveId, assetId: link.assetId, hub: link.hubAddress, underlying: link.underlying,
          collateral: status[0], borrowing: status[1], suppliedAssetsRaw: supplied[0].toString(), totalDebtRaw: debt[0].toString(),
          position: { drawnShares: position[0].toString(), premiumShares: position[1].toString(), premiumOffsetRay: position[2].toString(),
            suppliedShares: position[3].toString(), dynamicConfigKey: userKey },
          dynamicConfig: { key: userKey, collateralFactor: dynamic[0].toString(), maxLiquidationBonus: dynamic[1].toString(), liquidationFee: dynamic[2].toString() } });
      }
      out.users.push(row);
    }
    out.linksConsumed = prepared.links.map(row => ({ reserveId: row.reserveId, assetId: row.assetId, hub: row.hubAddress, spoke: row.spoke, underlying: row.underlying }));
    if (users.length > maxUsers) out.errors.push("USER_CAP_REACHED");
    for (const link of prepared.links) {
      // Published Hub API: raw shares and signed RAY offset for THIS spoke,
      // never asset-wide totals or the first word of getSpokeOwed as total debt.
      const drawn = await contract.read(state, link.hubAddress, ABI, "getSpokeDrawnShares", [link.assetId, contract.SPOKE]);
      const premium = await contract.read(state, link.hubAddress, ABI, "getSpokePremiumData", [link.assetId, contract.SPOKE]);
      const index = await contract.read(state, link.hubAddress, ABI, "getAssetDrawnIndex", [link.assetId]);
      if (drawn[0] >= 2n ** 120n || premium[0] >= 2n ** 120n || premium[1] < -(2n ** 199n) || premium[1] >= 2n ** 199n) contract.fail("BORROWER_DEBT_UNACCOUNTED");
      const sum = componentSums[link.reserveId];
      const componentsEqual = sum.drawnShares === drawn[0] && sum.premiumShares === premium[0] && sum.premiumOffsetRay === premium[1];
      const aggregateDebt = debtFromComponents(drawn[0], premium[0], premium[1], index[0]);
      const aggregateDebtConsistent = aggregateDebt === BigInt(link.aggregateDebtRaw);
      const userDebtReadsConsistent = out.users.every(user => {
        const reserve = user.reserves.find(row => row.reserveId === link.reserveId), p = reserve.position;
        return debtFromComponents(BigInt(p.drawnShares), BigInt(p.premiumShares), BigInt(p.premiumOffsetRay), index[0]) === BigInt(reserve.totalDebtRaw);
      });
      out.debtReconciliation.push({ reserveId: link.reserveId, reconciliationUnit: "RAW_POSITION_COMPONENTS", underlyingDebtAdditive: false,
        aggregateDebtRaw: link.aggregateDebtRaw, indexedUserDebtRaw: debtSums[link.reserveId].toString(),
        roundingOverhangRaw: (debtSums[link.reserveId] - BigInt(link.aggregateDebtRaw)).toString(), drawnIndexRay: index[0].toString(),
        aggregateComponents: { drawnShares: drawn[0].toString(), premiumShares: premium[0].toString(), premiumOffsetRay: premium[1].toString() },
        indexedUserComponents: Object.fromEntries(Object.entries(sum).map(([key, value]) => [key, value.toString()])),
        componentsEqual, aggregateDebtConsistent, userDebtReadsConsistent, equal: componentsEqual && aggregateDebtConsistent && userDebtReadsConsistent });
    }
    if (out.debtReconciliation.some(row => !row.equal)) out.errors.push("BORROWER_DEBT_UNACCOUNTED");
    if (out.fullHistoryProven && out.users.length === users.length) out.debtAccounting = out.debtReconciliation.every(row => row.equal) ? "PASS" : "FAIL";
    out.componentObservationComplete = out.fullHistoryProven && out.debtAccounting === "PASS" && !out.errors.length && out.users.length === users.length;
  } catch (error) { out.errors.push(contract.safeFailure(error)); }
  if (state) {
    const confirmed = await contract.finish(out, state);
    if (!confirmed) { out.fullHistoryProven = false; out.debtAccounting = "UNKNOWN"; }
    if (confirmed && advanced && !state.counts.failed && out.errors.every(code => ["HISTORY_INCOMPLETE", "USER_CAP_REACHED", "BORROWER_DEBT_UNACCOUNTED"].includes(code))
      && (!advanced.reason || advanced.reason === "HISTORY_BACKFILL_PENDING") && deps.historyStore?.save) {
      try {
        history.validateHistory(advanced.index, identity);
        if (Buffer.byteLength(JSON.stringify(advanced.index)) > history.MAX_BYTES) contract.fail("HISTORY_INVALID");
        await deps.historyStore.save(structuredClone(advanced.index));
      } catch (_) { out.errors.push("HISTORY_STORE_FAILED"); out.componentObservationComplete = false; }
    }
  }
  out.coverage.classification = out.componentObservationComplete ? "BOUNDED_OBSERVATIONAL" : "SOURCE_INCOMPLETE";
  return out;
}
if (require.main === module) console.log(JSON.stringify({ status: "OFFLINE_INJECTED_INPUT_REQUIRED", networkCalls: 0, writes: 0 }));
module.exports = { collectBaseBorrowers, ABI };
