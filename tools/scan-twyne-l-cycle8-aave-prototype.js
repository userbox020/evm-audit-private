#!/usr/bin/env node
"use strict";

// PROTOTYPE ONLY: offline source reader + JSON/pseudocode emitter, NOT a scanner.
// No RPC client, ABI encoder, signing, broadcast, fork, or filesystem writes.
// Never require scan-twyne-l.js/shared-rpc.js; the existing scanner does not load us.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..");
const FILES = {
  inventory: "reports/raw/fast/novelty-rerank-20261017/A06-cycle7-aave-wrapper-inventory.md",
  scanner: "tools/scan-twyne-l.js",
  surface: "reports/raw/fast/twyne-l.json",
  wrapper: "targets/twyne-aToken-wrapper/src/AaveV3ATokenWrapper.sol",
  customBase: "targets/twyne-aToken-wrapper/src/CustomERC4626StataTokenUpgradeable.sol",
  consumer: "targets/twyne-contracts-v1/src/twyne/AaveV3CollateralVault.sol",
  vaultBase: "targets/twyne-contracts-v1/src/twyne/CollateralVaultBase.sol",
  pool: "targets/twyne-contracts-v1/lib/aave-v3-origin/src/contracts/interfaces/IPool.sol",
};

// Interface imports are documentary signatures, not linked Solidity or executable calls.
const READ_SURFACE = {
  wrapper: ["version()", "decimals()", "asset()", "aToken()", "POOL()",
    "POOL_ADDRESSES_PROVIDER()", "RAY()", "balanceOf(address)", "totalSupply()",
    "totalAssets()", "convertToAssets(uint256)", "convertToShares(uint256)",
    "previewDeposit(uint256)", "previewRedeem(uint256)", "latestAnswer()"],
  collateralVault: ["version()", "asset()", "intermediateVault()", "targetVault()",
    "underlyingAsset()", "aToken()", "targetAsset()", "aaveDebtToken()", "categoryId()",
    "totalAssetsDepositedOrReserved()", "maxRelease()", "balanceOf(address)"],
  aToken: ["UNDERLYING_ASSET_ADDRESS()", "POOL()", "scaledBalanceOf(address)"],
  pool: ["getReserveData(address)", "getReserveNormalizedIncome(address)",
    "getUserAccountData(address)"],
};
const PROFILES = {
  euler: { targetReads: ["debtOf(vault)", "LTVLiquidation(collateral)",
    "accountLiquidity(vault,true)"], status: "EXISTING_EVK_ROUTE" },
  aave: { targetReads: ["getReserveData(underlying)", "getReserveData(targetAsset)",
    "getReserveNormalizedIncome(underlying)", "getUserAccountData(vault)",
    "aToken.scaledBalanceOf(vault)", "aaveDebtToken.balanceOf(vault)"],
    status: "PROPOSED_ONLY" },
  morpho: { targetReads: ["position(marketId,vault)", "market(marketId)"],
    status: "DOCUMENTARY_ONLY; bind marketId/params and accrue debt shares before valuation" },
};

function source(file) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  return { text, sha256: crypto.createHash("sha256").update(text).digest("hex") };
}
function excerpt(text, first, last) {
  return text.split(/\r?\n/).slice(first - 1, last).join("\n");
}
function read(to, signature, args = []) {
  return { to, signature, args, transport: "eth_call", status: "PSEUDOCODE_NOT_SENT" };
}

// Dependency-resolved stages: unknown addresses below are explicit symbolic references.
// Every future call must share one chain/block-hash pin, never implicit latest.
function observationPlan(vault, multicall3) {
  const direct = ["asset()", "intermediateVault()", "targetVault()", "underlyingAsset()",
    "aToken()", "targetAsset()", "aaveDebtToken()", "categoryId()"]
    .map((fn) => read(vault, fn));
  const aggregateReads = [
    read("$wrapper", "asset()"), read("$wrapper", "aToken()"), read("$wrapper", "POOL()"),
    read("$aToken", "UNDERLYING_ASSET_ADDRESS()"), read("$aToken", "POOL()"),
    read("$aToken", "scaledBalanceOf(address)", [vault]),
    read("$intermediateVault", "asset()"),
    read("$intermediateVault", "debtOf(address)", [vault]),
    read(vault, "totalAssetsDepositedOrReserved()"), read(vault, "maxRelease()"),
    read(vault, "balanceOf(address)", [vault]),
  ];
  return {
    requestedInitializationRead: { ...read(vault, "initialization()"),
      status: "UNSUPPORTED_IN_SOURCE; use getters, never simulate initialize(...)" },
    stage1DirectGetters: direct,
    stage2Multicall3: { to: multicall3, method: "eth_call", signature: "aggregate3",
      pin: "$verifiedBlockHash", gas: "$reviewedBoundedReadGasCap",
      calls: aggregateReads.map(({ to, signature, args }) => ({ target: to,
        allowFailure: true, callData: { signature, args, encoding: "NOT_IMPLEMENTED" } })),
      decode: "(bool success,bytes returnData)[]; failures => null, never zero",
      note: "One aggregate captures scaled balance and identity AFTER discovery; not one total RPC." },
    stage3DirectReserveReads: [
      read("$pool", "getReserveData(address)", ["$underlying"]),
      read("$pool", "getReserveData(address)", ["$targetAsset"]),
      read("$pool", "getReserveNormalizedIncome(address)", ["$underlying"]),
      read("$pool", "getUserAccountData(address)", [vault]),
      read("$aaveDebtToken", "balanceOf(address)", [vault]),
    ],
    identityAdmission: ["CV.asset == IV.asset == wrapper", "CV.underlyingAsset == wrapper.asset == aToken.UNDERLYING_ASSET_ADDRESS",
      "CV.aToken == wrapper.aToken == collateral reserve.aTokenAddress",
      "CV.targetVault == wrapper.POOL == aToken.POOL", "all results share chainId + block hash",
      "reserve tuple layout and variable-debt token bound to reviewed deployed pool version"],
  };
}

// Same-unit arithmetic only; caller must bind identities, units and pin first.
// Never subtract Aave target-asset debt from collateral-wrapper shares.
function conservationLens(row, identitiesAndPinVerified = false) {
  const keys = ["totalAssetsDepositedOrReserved", "ivDebt", "scaledBalanceOfVault",
    "collateralVaultBalanceOfSelf"];
  if (!identitiesAndPinVerified || keys.some((k) => row[k] == null)) {
    return { state: "UNKNOWN", sameUnitDelta: null, scaledBackingDelta: null,
      ledgerIdentityResidual: null, crossAssetIdentityComputed: false };
  }
  const [total, debt, scaled, borrower] = keys.map((k) => BigInt(row[k]));
  const release = debt < total ? debt : total; // CollateralVaultBase.maxRelease()
  return { state: scaled >= total ? "SAME_UNIT_LENS_ONLY" : "EXTERNAL_LIQUIDATION_BRANCH",
    sameUnitDelta: (total - debt).toString(), scaledBackingDelta: (scaled - total).toString(),
    // Normal branch: T = min(ivDebt,T) + CV.balanceOf(CV). Not cross-asset conservation.
    ledgerIdentityResidual: scaled >= total ? (total - release - borrower).toString() : null,
    crossAssetIdentityComputed: false };
}

function version3Row(existing, surface) {
  const row = {
    vault: existing.vault, chainId: existing.chainId ?? surface.chainId, version: 3,
    profile: "AAVE_CANDIDATE_UNBOUND", observationState: "NOT_OBSERVED_OFFLINE",
    inventoryPin: surface.pin, observationPin: null,
    wrapper: null, underlying: null, aToken: null, pool: null, intermediateVault: null,
    scaledBalanceOfVault: null,
    // Requested schema label; actual Aave selector is getReserveNormalizedIncome(address).
    getReserveDataNormalizedIncome: null,
    totalAssetsDepositedOrReserved: null, ivDebt: null, collateralVaultBalanceOfSelf: null,
    routePositive: "unknown", executableNow: "unknown", signedActionJustified: false,
  };
  row.conservationIdentity = conservationLens(row);
  row.proposedReads = observationPlan(row.vault, surface.contracts?.multicall3 ?? "$multicall3");
  return row;
}

function buildPrototype() {
  const sources = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, source(file)]));
  const surface = JSON.parse(sources.surface.text);
  if (!sources.wrapper.text.includes("contract AaveV3ATokenWrapper is") ||
      !sources.customBase.text.includes("return POOL.getReserveNormalizedIncome(asset());") ||
      !sources.consumer.text.includes("function initialize(")) {
    throw new Error("SOURCE_ANCHOR_DRIFT: review documentary signatures before reuse");
  }
  return {
    schema: "twyne-cycle8-aave-offline-prototype/v1", prototypeOnly: true,
    safety: { readOnly: true, liveRpc: false, signing: false, broadcast: false,
      forkBind: false, scannerBehaviorChanged: false, executableRoutesEstablished: false },
    sourceAuthority: Object.fromEntries(Object.entries(sources).map(([key, value]) =>
      [key, { path: FILES[key], sha256: value.sha256 }])),
    sections: {
      importsFromWrapperSource: { publicReadSurface: READ_SURFACE,
        inherited: "asset/ERC20/ERC4626 reads are inherited; _rate is internal, NOT callable",
        consumedByCV: "initialize reads wrapper.asset/aToken/decimals; valuation reads latestAnswer",
        stateChangingExcluded: ["initialize", "rebalanceATokens_CV", "burnShares_CV", "deposit", "redeem"],
        wrapperDeclaration: excerpt(sources.wrapper.text, 27, 44),
        baseDeclaration: excerpt(sources.customBase.text, 14, 19) },
      wrapperConversionPricingPath: {
        identity: excerpt(sources.customBase.text, 51, 70),
        scaledBalance: excerpt(sources.wrapper.text, 191, 203),
        conversionAndRate: excerpt(sources.customBase.text, 255, 273),
        formulas: ["assets=floor(shares*normalizedIncome/1e27)",
          "shares=floor(assets*1e27/normalizedIncome) for deposit/redeem-floor views",
          "mint/withdraw previews require their own ceil rounding",
          "latestAnswer=floor(AaveOracle.getAssetPrice(underlying)*normalizedIncome/1e27)"],
        warning: "CV.convertToAssets is 1:1 wrapper-share identity, NOT underlying conversion" },
      readOnlyObservationFlow: { profiles: PROFILES,
        initializationCorrection: "No initialization() accessor in supplied consumer/base. initialize(...) mutates state.",
        normalizedIncomeCorrection: "getReserveDataNormalizedIncome is a schema alias, not an Aave selector.",
        widenedEnvelope: "Future authorized scanner needs eth_call plus block headers, logs, code/storage for pins/enumeration/binding; none executed here." },
      outputSchema: { integers: "decimal strings when observed; null when absent; never synthetic zero",
        rows: (surface.vaults || []).filter((v) => v.version === 3).map((v) => version3Row(v, surface)) },
      honestLimitations: ["PROTOTYPE ONLY; scanner unchanged; not loaded by existing scanner",
        "Zero fresh reads; saved version-3 rows are candidates, not runtime-confirmed Aave profiles",
        "No executable route, conservation proof, positive economics, or executive verdict",
        "No claim that cycle-6 enabled Aave detail reads: current source still skips them",
        "Source presence/hashes are not deployed-source equivalence or fork authorization"],
      cycle9Runbook: ["Owner authorization first; bind wrapper/consumer/pool implementation and ABI",
        "Extend scanner 731-733 + 871-876 with profile-aware admission, not version===3 alone",
        "Split 625-677 and 879-886: keep IV.debtOf, route external observations by profile",
        "Extend interfaces 94-142; aggregate3 shape/decoder 579-608; preserve per-call failures",
        "Budget gas, calldata/return bytes, retries, request count and wall time; no eth_estimateGas assumed",
        "Version row/CSV/coverage schemas 692-780,901+; preserve nulls and routePositive unknown",
        "Offline fixtures first: v4 non-regression, v3 identities/reserve ABI/index rounding/failures/caps",
        "Only separately authorized fresh read batch later; no fork/signing/broadcast implied"],
    },
  };
}

if (require.main === module) {
  if (process.argv.length > 2) throw new Error("Offline prototype accepts no RPC or execution options");
  process.stdout.write(`${JSON.stringify(buildPrototype(), null, 2)}\n`);
}
module.exports = { buildPrototype, observationPlan, conservationLens };
