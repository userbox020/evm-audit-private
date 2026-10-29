#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CAPTURE_REL = "reports/raw/fast/critical-symbiotic-vaultv2-named-deployment-step3.json";
const CAPTURE_PATH = path.join(ROOT, ...CAPTURE_REL.split("/"));
const ANALYSIS_REL = "reports/raw/fast/critical-symbiotic-vaultv2-named-deployment-step3-analysis.json";
const ANALYSIS_PATH = path.join(ROOT, ...ANALYSIS_REL.split("/"));
const MARKDOWN_REL = "reports/critical-symbiotic-vaultv2-named-deployment-step3.md";
const MARKDOWN_PATH = path.join(ROOT, ...MARKDOWN_REL.split("/"));
const FORMULAS_REL = "reports/critical-symbiotic-vaultv2-withdrawalqueue-step1.md";
const FORMULAS_PATH = path.join(ROOT, ...FORMULAS_REL.split("/"));
const HISTORY_REL = "reports/raw/fast/critical-symbiotic-vaultv2-v1-history-step3.json";
const HISTORY_PATH = path.join(ROOT, ...HISTORY_REL.split("/"));

const CAPTURE_SHA256 = "0x7e784c10e90e9abb6dbe86959e2b21ee2d4e952fb448387507dbd69b993c2064";
const FORMULAS_SHA256 = "0xda918b2a677bc2d4e2dbe7620b69ce8822df6ad6b14bd49bdf533f87ca4082f8";
const HISTORY_SHA256 = "0xb97975fb0cead82772dca3c16f93c1166a18f435f8ae9d88203e6566a311f0da";
const CAPTURE_SCHEMA = "critical-symbiotic-vaultv2-named-deployment-step3/v2";
const ANALYSIS_SCHEMA = "critical-symbiotic-vaultv2-named-deployment-step3-analysis/v1";
const BLOCK = Object.freeze({
  number: "25696793",
  hash: "0x9ba1793cefe984dbd54076b6916c75ceecb081aee44e2d8a9c968c5f6c42c3a9",
  timestamp: "1786029911",
  stateRoot: "0x80f91600fe9bdd770de7a1db7079c863d8009861ab718da00fb65ab2f4edce9f"
});
const FACTORY = "0xaeb6bdd95c502390db8f52c8909f703e9af6a346";
const FACTORY_RUNTIME_SHA256 = "0xa4c18e4f94f00255ab5e3246c18dad37b0475a035bec29c27837667dffbda067";
const FACTORY_BUILD_SHA256 = "0x39c5ebc5bc85d2231cd3bf45cac2526f0e4dcddf545f666840c6d5e3ab690d7c";
const CANONICAL_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const EXPECTED_EXACT = 23;
const EXPECTED_PUBLIC = 19;
const HISTORY_TARGETS = Object.freeze({
  "0x586b3b7ccef9d1e45e7d38a2845d06e604d79d12": Object.freeze({
    index: "336", asset: "0x917cee801a67f933f2e6b33fc0cd1ed2d5909d88",
    supply: "4812313651515377", assets: "4812313651515377"
  }),
  "0x177f30a4e3b8c8fa54a01e173a76e4061630d89a": Object.freeze({
    index: "335", asset: "0xbeef01735c132ada46aa9aa4c54623caa92a64cb",
    supply: "13570915079550576883", assets: "13570915079550576883"
  })
});

class AnalysisError extends Error {
  constructor(code) { super(code); this.name = "AnalysisError"; this.code = code; }
}
function fail(code) { throw new AnalysisError(code); }
function sha256(bytes) { return `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`; }
function bigint(value, label = "INTEGER") {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) fail(`MALFORMED_${label}`);
  return BigInt(value);
}
function pow10(exponent) {
  if (typeof exponent !== "bigint" || exponent < 0n || exponent > 255n) fail("DECIMAL_EXPONENT_RANGE");
  let result = 1n;
  for (let i = 0n; i < exponent; i += 1n) result *= 10n;
  return result;
}
function offsetAndVirtualShares(decimals) {
  const d = bigint(String(decimals), "ASSET_DECIMALS");
  if (d > 255n) fail("ASSET_DECIMALS_RANGE");
  const offset = d < 18n ? 18n - d : 0n;
  return { decimals: d, offset, virtualShares: pow10(offset) };
}
function minimumDonation(victimDeposit, virtualShares, attackerSeed = 1n) {
  if (victimDeposit <= 0n || virtualShares <= 0n || attackerSeed <= 0n) fail("FORMULA_INPUT_RANGE");
  return victimDeposit * virtualShares * (attackerSeed + 1n) - attackerSeed;
}
function firstProfitableEqualDepositCount(virtualShares, attackerSeed = 1n) {
  if (virtualShares <= 0n || attackerSeed <= 0n) fail("FORMULA_INPUT_RANGE");
  return virtualShares * (attackerSeed + 1n) / attackerSeed + 1n;
}
function ceilDiv(numerator, denominator) {
  if (numerator < 0n || denominator <= 0n) fail("DIVISION_INPUT_RANGE");
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}
function residualRestart(residualAssets, virtualShares) {
  if (residualAssets <= 0n || virtualShares <= 0n) fail("RESIDUAL_INPUT_RANGE");
  const minimum = ceilDiv(residualAssets + 1n, virtualShares);
  return {
    exactFormula: "shares=floor(x*V/(residual+1))",
    minimumDepositForOneShareRaw: minimum.toString(),
    residualPlusOneShortcutApplicable: virtualShares === 1n,
    residualPlusOneRaw: virtualShares === 1n ? (residualAssets + 1n).toString() : null,
    caveat: virtualShares === 1n
      ? "V=1: minimum restart deposit is exactly residual+1."
      : "V!=1: use the exact ERC4626 formula; residual+1 is not a supported shortcut."
  };
}
function formatUnits(value, decimals) {
  const base = pow10(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(Number(decimals), "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
function address(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/.test(value)) fail(`MALFORMED_${label}`);
  return value;
}

function validateCapture(capture, captureHash = CAPTURE_SHA256) {
  if (captureHash !== CAPTURE_SHA256) fail("CAPTURE_HASH_MISMATCH");
  if (!capture || capture.schema !== CAPTURE_SCHEMA || capture.status !== "COMPLETE_READ_ONLY_CAPTURE"
    || capture.branch !== "critical/symbiotic-vaultv2-named-deployment-step3") fail("CAPTURE_IDENTITY_MISMATCH");
  if (capture.chain?.chainId !== "1" || JSON.stringify(capture.chain.finalizedBlock) !== JSON.stringify(BLOCK)
    || capture.chain.statePin?.blockHash !== BLOCK.hash || capture.chain.statePin?.requireCanonical !== true
    || capture.chain.terminalRecheck?.number !== BLOCK.number || capture.chain.terminalRecheck?.hash !== BLOCK.hash
    || capture.chain.terminalRecheck?.stateRoot !== BLOCK.stateRoot
    || capture.chain.terminalRecheck?.exactCanonicalMatch !== true) fail("CAPTURE_BLOCK_PIN_MISMATCH");
  if (capture.factory?.address !== FACTORY || capture.factory?.bound !== true
    || capture.factory.runtime?.present !== true || capture.factory.runtime?.lengthBytes !== 4423
    || capture.factory.runtime?.sha256 !== FACTORY_RUNTIME_SHA256
    || capture.factory.artifactRuntimeBinding?.matched !== true
    || capture.factory.provenance?.artifactFileSha256 !== FACTORY_BUILD_SHA256
    || capture.factory.provenance?.sourcifyExactCreationAndRuntimeMatch !== true) fail("FACTORY_GATE_MISMATCH");
  if (capture.readOnly !== true || capture.transactions !== 0 || capture.signedActionJustified !== false
    || capture.providerMaterialAbsent !== true) fail("CAPTURE_SAFETY_MISMATCH");
  if (capture.enumeration?.reportedTotal !== "353" || capture.enumeration?.capturedCount !== 353
    || capture.enumeration?.complete !== true || !Array.isArray(capture.enumeration.entities)
    || capture.enumeration.entities.length !== 353) fail("ENUMERATION_GATE_MISMATCH");
  if (capture.classification?.factoryBound !== true || capture.classification?.completeEnumeration !== true
    || capture.classification?.exactVaultV2Entities !== EXPECTED_EXACT
    || capture.classification?.permissionlessPublicDepositAdvertisedEntities !== EXPECTED_PUBLIC) {
    fail("CLASSIFICATION_COUNT_MISMATCH");
  }
  const exact = capture.enumeration.entities.filter((row) => row.exactVaultV2 === true);
  const advertised = exact.filter((row) => row.configuration?.permissionlessPublicDepositAdvertised === true);
  if (exact.length !== EXPECTED_EXACT || advertised.length !== EXPECTED_PUBLIC) fail("CANDIDATE_COUNT_MISMATCH");
  for (const row of exact) {
    if (row.proxyBinding?.matched !== true || row.factoryMembership !== "ENUMERATED_BY_BOUND_FACTORY_AT_PIN"
      || row.factoryBackReference !== FACTORY || row.implementationMatchesKnownFactoryVersion !== true
      || row.implementationMatchesFactoryVersion !== true || row.version !== "3"
      || row.classification !== "EXACT_VAULTV2_ALL_IDENTITY_AND_RUNTIME_GATES_PASSED" || !row.configuration) {
      fail("EXACT_CANDIDATE_GATE_MISMATCH");
    }
  }
  return exact;
}

function eventPosition(event) {
  return [BigInt(event.blockNumber), BigInt(event.transactionIndex || "0"), BigInt(event.logIndex)];
}
function afterEvent(left, right) {
  const a = eventPosition(left); const b = eventPosition(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}
function deriveHistoryCandidateEvidence(candidate) {
  if (!candidate || !Array.isArray(candidate.events?.deposits) || !Array.isArray(candidate.events?.transfers)) {
    fail("HISTORY_EVENTS_MALFORMED");
  }
  const deposits = [...candidate.events.deposits].sort((a, b) => afterEvent(a, b) ? 1 : afterEvent(b, a) ? -1 : 0);
  const transfers = [...candidate.events.transfers].sort((a, b) => afterEvent(a, b) ? 1 : afterEvent(b, a) ? -1 : 0);
  const firstDeposit = deposits[0] || null;
  const firstMint = transfers.find((event) => event.from === "0x0000000000000000000000000000000000000000") || null;
  const zeroShareDeposits = deposits.filter((event) => BigInt(event.shares) === 0n && BigInt(event.assets) > 0n);
  const laterDeposits = firstDeposit ? deposits.filter((event) => event !== firstDeposit && afterEvent(event, firstDeposit)) : [];
  const transfersAfterMint = firstMint ? transfers.filter((event) => event !== firstMint && afterEvent(event, firstMint)) : [];
  const splitRunObserved = (candidate.depositSummary?.runsAtLeastThreeSameCallerOwner || []).length > 0
    || (candidate.depositSummary?.consecutiveSameCallerOwnerPairs || 0) > 0;
  const postPositiveZeroSupplyWindowObserved = candidate.transferReplay?.anyHistoricalZeroSupplyWindowAfterInitialization === true
    || (candidate.transferReplay?.zeroSupplyWindowsAfterFirstPositiveSupply || []).length > 0;
  const soleHolder = candidate.transferReplay?.holderCount === 1
    && candidate.transferReplay?.topHolder?.concentrationBpsFloor === "10000"
    && candidate.transferReplay?.holders?.length === 1;
  const sameCallerOwnerSoleHolder = Boolean(firstDeposit && firstMint && firstDeposit.caller === firstDeposit.owner
    && firstMint.to === firstDeposit.owner && candidate.transferReplay.holders[0].account === firstDeposit.owner);
  const initialDepositMatchesCurrent = Boolean(firstDeposit
    && firstDeposit.assets === candidate.basePinState?.totalAssets
    && firstDeposit.shares === candidate.basePinState?.storedSupply
    && firstDeposit.assets === candidate.basePinState?.visibleSupply);
  const initialMintMatchesCurrent = Boolean(firstMint && firstMint.value === candidate.basePinState?.storedSupply);
  const onlyInitializationDepositObserved = deposits.length === 1 && transfers.length === 1
    && initialDepositMatchesCurrent && initialMintMatchesCurrent && sameCallerOwnerSoleHolder && soleHolder
    && zeroShareDeposits.length === 0 && laterDeposits.length === 0 && transfersAfterMint.length === 0
    && !postPositiveZeroSupplyWindowObserved && !splitRunObserved;
  const promotesFurtherEconomicsWork = zeroShareDeposits.length > 0 || laterDeposits.length > 0
    || transfersAfterMint.length > 0 || postPositiveZeroSupplyWindowObserved || splitRunObserved;
  return {
    complete: true,
    classification: onlyInitializationDepositObserved ? "ONLY_INITIALIZATION_DEPOSIT_OBSERVED"
      : "ADDITIONAL_HISTORY_ACTIVITY_OBSERVED",
    exactlyOneDeposit: deposits.length === 1,
    exactlyOneMintTransfer: transfers.length === 1 && firstMint !== null,
    initialDepositMatchesCurrentSupplyAndAssets: initialDepositMatchesCurrent,
    initialMintMatchesCurrentStoredSupply: initialMintMatchesCurrent,
    sameCallerOwnerIsSoleHolder: sameCallerOwnerSoleHolder && soleHolder,
    soleHolderAddress: sameCallerOwnerSoleHolder ? firstDeposit.owner : null,
    soleHolderConcentrationBps: soleHolder ? "10000" : null,
    zeroShareDepositObserved: zeroShareDeposits.length > 0,
    zeroShareDepositCount: zeroShareDeposits.length,
    laterDepositAfterInitializationObserved: laterDeposits.length > 0,
    laterDepositCount: laterDeposits.length,
    transferAfterInitialMintObserved: transfersAfterMint.length > 0,
    transferAfterInitialMintCount: transfersAfterMint.length,
    postPositiveZeroSupplyWindowObserved,
    splitRunObserved,
    establishedExternalVictimFlow: false,
    holderAcquirability: "unknown",
    futureVictimFlow: "unknown",
    promotesFurtherEconomicsWork,
    routePositive: "unknown",
    routePositiveEstablished: false,
    promotionPassed: false
  };
}
function validateHistoryArtifact(history, historyHash = HISTORY_SHA256) {
  if (historyHash !== HISTORY_SHA256) fail("HISTORY_HASH_MISMATCH");
  if (!history || history.schema !== "critical-symbiotic-vaultv2-v1-history-step3/v1"
    || history.status !== "COMPLETE_READ_ONLY_HISTORY_CAPTURE" || history.readOnly !== true
    || history.transactions !== 0 || history.signedActionJustified !== false
    || history.providerMaterialAbsent !== true || history.sourceCapture?.sha256 !== CAPTURE_SHA256
    || JSON.stringify(history.sourceCapture?.fixedBlock) !== JSON.stringify({
      number: BLOCK.number, hash: BLOCK.hash, stateRoot: BLOCK.stateRoot
    }) || history.candidateCount !== 2 || !Array.isArray(history.candidates)
    || history.candidates.length !== 2 || history.classification?.routePositive !== "unknown"
    || history.classification?.routePositiveEstablished !== false
    || history.classification?.promotionPassed !== false
    || history.rpc?.adaptiveLogRangeStats?.noSkippedRange !== true || history.rpc?.retries !== 0) {
    fail("HISTORY_GATE_MISMATCH");
  }
  const byAddress = {};
  for (const [targetAddress, expected] of Object.entries(HISTORY_TARGETS)) {
    const candidate = history.candidates.find((row) => row.address === targetAddress);
    const coverage = candidate?.logCoverage;
    if (!candidate || candidate.baseCaptureIndex !== expected.index || candidate.asset !== expected.asset
      || candidate.assetDecimals !== "18" || candidate.virtualShares !== "1"
      || candidate.basePinState?.visibleSupply !== expected.supply
      || candidate.basePinState?.storedSupply !== expected.supply
      || candidate.basePinState?.pendingFeeShares !== "0"
      || candidate.basePinState?.totalAssets !== expected.assets
      || coverage?.complete !== true || coverage.fromBlock !== candidate.codeDiscovery?.firstCodeBlock
      || coverage.toBlock !== BLOCK.number || coverage.depositLogs !== candidate.events?.deposits?.length
      || coverage.transferLogs !== candidate.events?.transfers?.length
      || coverage.adaptiveRangeStats?.byTopic?.Deposit?.noSkippedRange !== true
      || coverage.adaptiveRangeStats?.byTopic?.Transfer?.noSkippedRange !== true
      || coverage.adaptiveRangeStats?.aggregate?.noSkippedRange !== true
      || candidate.transferReplay?.matchesBaseVisibleSupplyMinusPendingFees !== true
      || candidate.transferReplay?.replayedStoredSupply !== expected.supply
      || candidate.transferReplay?.expectedStoredSupply !== expected.supply
      || candidate.conservativeGates?.routePositive !== "unknown"
      || candidate.conservativeGates?.routePositiveEstablished !== false
      || candidate.conservativeGates?.promotionPassed !== false) fail("HISTORY_CANDIDATE_GATE_MISMATCH");
    const evidence = deriveHistoryCandidateEvidence(candidate);
    if (evidence.classification !== "ONLY_INITIALIZATION_DEPOSIT_OBSERVED"
      || evidence.promotesFurtherEconomicsWork !== false) fail("HISTORY_OBSERVED_CLOSEOUT_MISMATCH");
    byAddress[targetAddress] = evidence;
  }
  return {
    byAddress,
    counts: {
      candidates: 2,
      onlyInitializationDepositObserved: Object.values(byAddress)
        .filter((row) => row.classification === "ONLY_INITIALIZATION_DEPOSIT_OBSERVED").length,
      zeroShareDepositObserved: Object.values(byAddress).filter((row) => row.zeroShareDepositObserved).length,
      laterDepositAfterInitializationObserved: Object.values(byAddress)
        .filter((row) => row.laterDepositAfterInitializationObserved).length,
      transferAfterInitialMintObserved: Object.values(byAddress)
        .filter((row) => row.transferAfterInitialMintObserved).length,
      postPositiveZeroSupplyWindowObserved: Object.values(byAddress)
        .filter((row) => row.postPositiveZeroSupplyWindowObserved).length,
      splitRunObserved: Object.values(byAddress).filter((row) => row.splitRunObserved).length,
      establishedExternalVictimFlow: 0,
      promotedFurtherEconomicsWork: Object.values(byAddress).filter((row) => row.promotesFurtherEconomicsWork).length
    }
  };
}

function analyzeCandidate(row, historyEvidence = null) {
  const q = row.configuration;
  const asset = address(q.asset, "ASSET");
  const { decimals, offset, virtualShares } = offsetAndVirtualShares(q.assetDecimals);
  const totalSupply = bigint(q.totalSupply, "TOTAL_SUPPLY");
  const totalAssets = bigint(q.totalAssets, "TOTAL_ASSETS");
  const newTotalAssets = bigint(q.getAccrueInterest?.newTotalAssets, "NEW_TOTAL_ASSETS");
  const managementFeeShares = bigint(q.getAccrueInterest?.managementFeeShares, "MANAGEMENT_FEE_SHARES");
  const performanceFeeShares = bigint(q.getAccrueInterest?.performanceFeeShares, "PERFORMANCE_FEE_SHARES");
  const protocolFeeShares = bigint(q.getAccrueInterest?.protocolFeeShares, "PROTOCOL_FEE_SHARES");
  const pendingFeeShares = bigint(q.pendingFeeShares, "PENDING_FEE_SHARES");
  if (pendingFeeShares !== managementFeeShares + performanceFeeShares + protocolFeeShares
    || pendingFeeShares > totalSupply) fail("FEE_SHARE_RECONCILIATION_MISMATCH");
  const incumbentSupply = totalSupply - pendingFeeShares;
  let stateClass;
  if (totalSupply === 0n && totalAssets === 0n) stateClass = "ZERO_VISIBLE_SUPPLY_ZERO_ASSETS";
  else if (totalSupply === 0n) stateClass = "ZERO_VISIBLE_SUPPLY_RESIDUAL_ASSETS";
  else if (incumbentSupply === 0n && pendingFeeShares > 0n) stateClass = "EFFECTIVE_PENDING_FEE_SHARES_ONLY_WITH_RESIDUAL_ASSETS";
  else stateClass = "NONZERO_INCUMBENT_SUPPLY";

  const wholeToken = pow10(decimals);
  const maxDeposit = bigint(q.probeActorDepositCapacityAdvertised, "MAX_DEPOSIT");
  const depositLimit = bigint(q.depositLimit, "DEPOSIT_LIMIT");
  const headroom = q.depositHeadroom === null ? null : bigint(q.depositHeadroom, "DEPOSIT_HEADROOM");
  const permissionless = q.permissionlessPublicDepositAdvertised === true;
  const capacity = q.isDepositLimit ? headroom : maxDeposit;
  const meaningfulCapacity = maxDeposit > 0n && capacity !== null && capacity >= wholeToken;
  const nearZeroAssets = totalAssets <= wholeToken;
  const zeroFeeClosedFormPermitted = pendingFeeShares === 0n && totalSupply === 0n && totalAssets === 0n;
  const canonicalUsdc = asset === CANONICAL_USDC && decimals === 6n;
  const standardAssetSemanticsEstablished = historyEvidence?.standardExactTransferNonrebasingAssetEstablished === true;
  const blockers = [];
  if (!permissionless) blockers.push("NO_PERMISSIONLESS_DEPOSIT_ADVERTISED");
  if (virtualShares > 1n) blockers.push("VIRTUAL_SHARE_VICTIM_COUNT_AND_CAPITAL_BARRIER");
  if (pendingFeeShares > 0n) blockers.push("EFFECTIVE_PENDING_FEE_SHARES");
  if (incumbentSupply > 0n) blockers.push("INCUMBENT_CAPTURE_OR_DOMINANCE_BLOCKER");
  if (totalSupply === 0n && totalAssets > 0n) blockers.push("EXISTING_RESIDUAL_VALUE_NOT_PROFIT");
  if (!meaningfulCapacity) blockers.push("NON_MEANINGFUL_ADVERTISED_DEPOSIT_CAPACITY");
  if (!historyEvidence?.complete) blockers.push("EXTERNAL_VICTIM_FLOW_UNASSESSED");
  else if (historyEvidence.classification === "ONLY_INITIALIZATION_DEPOSIT_OBSERVED") {
    blockers.push("ONLY_INITIALIZATION_DEPOSIT_OBSERVED");
  } else if (!historyEvidence.establishedExternalVictimFlow) {
    blockers.push("EXTERNAL_VICTIM_FLOW_NOT_ESTABLISHED_IN_BOUNDED_HISTORY");
  }
  blockers.push("TIMING_ORDER_EXIT_GAS_UNESTABLISHED");

  let emptyRace = null;
  if (totalSupply === 0n && totalAssets === 0n) {
    const attackerSeed = 1n;
    const donation = minimumDonation(wholeToken, virtualShares, attackerSeed);
    const count = firstProfitableEqualDepositCount(virtualShares, attackerSeed);
    const capital = attackerSeed + donation;
    emptyRace = {
      conditionalOnFutureEqualVictimDeposits: true,
      attackerSeedRaw: "1",
      equalVictimDepositRaw: wholeToken.toString(),
      equalVictimDepositTokens: "1",
      minimumDonationFormula: "D_min=v*V*(a+1)-a",
      minimumDonationRaw: donation.toString(),
      minimumDonationTokens: formatUnits(donation, decimals),
      firstProfitableEqualDepositCountFormula: "floor(V*(a+1)/a)+1",
      firstProfitableEqualDepositCount: count.toString(),
      adversarialCapitalRaw: capital.toString(),
      tenBasisPointsOfCapitalRawFloor: (capital / 1000n).toString(),
      barrierClass: virtualShares === 1n ? "LOW_VIRTUAL_SHARE_BLOCKER" : "ENORMOUS_VIRTUAL_SHARE_BLOCKER"
    };
  }
  const restart = totalSupply === 0n && totalAssets > 0n && pendingFeeShares === 0n
    ? residualRestart(totalAssets, virtualShares) : null;
  const safeRatios = {
    visibleAssetsPerVisibleShareNumerator: totalAssets.toString(),
    visibleAssetsPerVisibleShareDenominator: totalSupply.toString(),
    ratioDefined: totalSupply > 0n
  };
  const score = (permissionless ? 10 : 0) + (virtualShares === 1n ? 40 : 0)
    + (totalSupply === 0n && totalAssets === 0n ? 30 : nearZeroAssets ? 20 : 0)
    + (pendingFeeShares === 0n ? 15 : 0) + (meaningfulCapacity ? 10 : 0);
  const externalVictimFlowHypothesis = historyEvidence?.establishedExternalVictimFlow === true ? true : "unknown";
  const historyCaptureEligible = permissionless && virtualShares === 1n && nearZeroAssets
    && pendingFeeShares === 0n && meaningfulCapacity && !historyEvidence?.complete;

  return {
    index: row.index,
    address: row.address,
    version: row.version,
    exactVaultV2: true,
    asset,
    assetDecimals: decimals.toString(),
    assetUsd: canonicalUsdc ? { policyAssumptionApplied: true, hashBoundPriceEvidence: false,
      basis: "EXPLICIT_POLICY_ASSUMPTION_CANONICAL_USDC_EQUALS_ONE_USD", usdPerWholeToken: "1" }
      : { policyAssumptionApplied: false, hashBoundPriceEvidence: false,
        basis: "NO_HASH_BOUND_AUTHORITATIVE_LOCAL_PRICE" },
    assetSemantics: {
      requiredForFormula: "STANDARD_EXACT_TRANSFER_NONREBASING_ASSET_REQUIRED",
      established: standardAssetSemanticsEstablished,
      status: standardAssetSemanticsEstablished ? "HASH_BOUND_ELSEWHERE" : "UNBOUND"
    },
    totalSupplyView: totalSupply.toString(),
    incumbentSupplyExcludingPendingFeeShares: incumbentSupply.toString(),
    totalAssetsView: totalAssets.toString(),
    totalAssetsTokens: formatUnits(totalAssets, decimals),
    totalAssetsUsdUnderExplicitPolicyAssumption: canonicalUsdc ? formatUnits(totalAssets, 6n) : null,
    accrueInterest: {
      newTotalAssets: newTotalAssets.toString(),
      managementFeeShares: managementFeeShares.toString(),
      performanceFeeShares: performanceFeeShares.toString(),
      protocolFeeShares: protocolFeeShares.toString(),
      pendingFeeShares: pendingFeeShares.toString(),
      effectivePendingFeeShares: pendingFeeShares > 0n
    },
    deposit: {
      whitelistEnabled: q.depositWhitelist,
      probeActorWhitelisted: q.probeActorWhitelisted,
      limitEnabled: q.isDepositLimit,
      limitRaw: depositLimit.toString(),
      headroomRaw: headroom === null ? null : headroom.toString(),
      probeActorMaxDepositAdvertisedRaw: maxDeposit.toString(),
      permissionlessPublicDepositAdvertised: permissionless,
      semantics: "ADVERTISED_VIEW_ONLY_NO_EXECUTION_INFERENCE",
      meaningfulCapacity
    },
    withdrawalQueue: address(q.withdrawalQueue, "WITHDRAWAL_QUEUE"),
    delegator: address(q.delegator, "DELEGATOR"),
    initialized: q.isInitialized,
    offset: offset.toString(),
    virtualShares: virtualShares.toString(),
    conservativeStateClass: stateClass,
    nearZeroAssetsDefinition: "totalAssetsView<=one whole asset token",
    nearZeroAssets,
    feeFreeStep1ClosedFormPermitted: zeroFeeClosedFormPermitted,
    formulaApplicability: {
      arithmeticStatePreconditionsAtPin: zeroFeeClosedFormPermitted,
      standardExactTransferNonrebasingAssetRequired: true,
      assetSemanticsEstablished: standardAssetSemanticsEstablished,
      operationallyEstablished: zeroFeeClosedFormPermitted && standardAssetSemanticsEstablished,
      thresholdsAreHypothetical: !standardAssetSemanticsEstablished,
      caveat: standardAssetSemanticsEstablished ? null
        : "Thresholds are hypothetical under the standard exact-transfer, non-rebasing token assumption."
    },
    feeFormulaCaveat: pendingFeeShares > 0n
      ? "Fee-free Step1 closed form forbidden; pending fee shares are effective and ownership is not attributed to an attacker."
      : "No pending fee shares observed at the pin; operational first/sole-owner and future-flow assumptions remain unestablished.",
    incumbentFormulaCaveat: incumbentSupply > 0n
      ? "Sole-attacker payout/profit formula forbidden; incumbents may capture donation value."
      : null,
    safeObservedRatio: safeRatios,
    emptyRaceThresholds: emptyRace,
    residualRestart: restart,
    blockers,
    rankingScore: score,
    historyEvidence,
    plausibleExternalVictimFlowHypothesis: externalVictimFlowHypothesis,
    historyCaptureEligible,
    furtherEconomicsWorkPromoted: historyEvidence?.promotesFurtherEconomicsWork === true,
    routePositive: "unknown",
    routePositiveEstablished: false,
    promotionPassed: false,
    routePositiveReason: "Victim deposits/history/timing/order/exit execution/gas and conservative net are not established."
  };
}

function increment(target, key) { target[key] = (target[key] || 0) + 1; }
function analyzeCapture(capture, options = {}) {
  const captureHash = options.captureSha256 || CAPTURE_SHA256;
  const formulasHash = options.formulasSha256 || FORMULAS_SHA256;
  if (formulasHash !== FORMULAS_SHA256) fail("FORMULAS_HASH_MISMATCH");
  const exactRows = validateCapture(capture, captureHash);
  const historyValidation = options.historyArtifact
    ? validateHistoryArtifact(options.historyArtifact, options.historySha256 || HISTORY_SHA256) : null;
  const historyEvidenceByAddress = historyValidation?.byAddress || options.historyEvidenceByAddress || {};
  const candidates = exactRows.map((row) => analyzeCandidate(row, historyEvidenceByAddress[row.address] || null));
  const stateCounts = {};
  const blockerCounts = {};
  for (const candidate of candidates) {
    increment(stateCounts, candidate.conservativeStateClass);
    for (const blocker of candidate.blockers) increment(blockerCounts, blocker);
  }
  const ranking = candidates.filter((row) => row.deposit.permissionlessPublicDepositAdvertised)
    .sort((a, b) => {
      if (a.rankingScore !== b.rankingScore) return b.rankingScore - a.rankingScore;
      const aIndex = BigInt(a.index); const bIndex = BigInt(b.index);
      return aIndex < bIndex ? -1 : aIndex > bIndex ? 1 : 0;
    })
    .map((row, index) => ({
      rank: index + 1, address: row.address, index: row.index, asset: row.asset,
      assetDecimals: row.assetDecimals, virtualShares: row.virtualShares,
      stateClass: row.conservativeStateClass, totalAssetsTokens: row.totalAssetsTokens,
      pendingFeeShares: row.accrueInterest.pendingFeeShares,
      maxDepositRaw: row.deposit.probeActorMaxDepositAdvertisedRaw,
      rankingScore: row.rankingScore, historyCaptureEligible: row.historyCaptureEligible,
      primaryBlockers: row.blockers.slice(0, 4)
    }));
  const historyEligible = ranking.filter((row) => row.historyCaptureEligible);
  return {
    schema: ANALYSIS_SCHEMA,
    sourceCapture: { path: CAPTURE_REL, sha256: captureHash, schema: CAPTURE_SCHEMA, fixedBlock: { ...BLOCK } },
    sourceHistory: historyValidation ? {
      path: HISTORY_REL, sha256: options.historySha256 || HISTORY_SHA256,
      schema: "critical-symbiotic-vaultv2-v1-history-step3/v1",
      fixedBlock: { number: BLOCK.number, hash: BLOCK.hash, stateRoot: BLOCK.stateRoot },
      completeGapFree: true
    } : null,
    formulasBinding: {
      path: FORMULAS_REL, sha256: formulasHash,
      preconditions: [
        "Fee-free closed form requires zero effective pending fee shares.",
        "First-deposit race requires zero visible supply and zero assets plus future victim flow.",
        "Never attribute pending fee shares to an attacker.",
        "Do not apply sole-attacker payout/profit formulas with incumbent supply.",
        "STANDARD_EXACT_TRANSFER_NONREBASING_ASSET_REQUIRED"
      ]
    },
    validatedGates: {
      exactHistoricalFactoryRuntime: true, completeFactoryEnumeration: true,
      exactVaultV2Candidates: EXPECTED_EXACT, permissionlessDepositAdvertisedCandidates: EXPECTED_PUBLIC,
      readOnlyCapture: true, signedActionJustified: false,
      boundedHistoryValidated: Boolean(historyValidation), boundedHistoryGapFree: Boolean(historyValidation)
    },
    formulaModel: {
      offset: "max(0,18-assetDecimals)", virtualShares: "V=10^offset", attackerSeedRaw: "a=1",
      minimumDonation: "D_min=v*V*(a+1)-a",
      firstProfitableEqualDepositCount: "floor(V*(a+1)/a)+1",
      zeroShareConditionFeeFree: "v*V*(a+1)<a+D+P+1",
      feeAwareVictimShares: "q_i=floor(v_i*(V*(a+1)+F_i)/(a+D+P_i+1))",
      residualRestart: "shares=floor(x*V/(residual+1)); residual+1 shortcut only for V=1"
    },
    counts: {
      exactCandidates: candidates.length,
      permissionlessDepositAdvertised: ranking.length,
      routePositiveEstablished: 0,
      economicsUnknownPermissionlessCandidates: ranking.length,
      permissionlessBlockedAtPin: candidates.length - ranking.length,
      historyCaptureEligible: historyEligible.length,
      historyEvidence: historyValidation?.counts || null,
      byState: stateCounts,
      byBlocker: blockerCounts
    },
    materialityGate: {
      expression: "conservative net > max($1,000, 10bps adversarial capital)",
      evaluable: false,
      reason: historyValidation
        ? "No conservative net is established; bounded history found only each vault's first observed deposit and no material external victim flow."
        : "No established victim deposits, timing/order, exit execution, gas, or conservative net.",
      canonicalUsdAssetPolicy: `${CANONICAL_USDC} only, fixed at $1 with 6 decimals`,
      canonicalUsdPolicyCaveat: "Explicit policy assumption only; not hash-bound price evidence.",
      routePositiveEstablishedCandidates: 0,
      promotionPassedCandidates: 0
    },
    candidates,
    ranking,
    recommendation: {
      decision: historyValidation ? "CLOSE/ROTATE AS TRIAGE DEPRIORITIZATION"
        : "RUN_BOUNDED_V1_HISTORY_BEFORE_TRIAGE_CLOSEOUT",
      display: historyValidation ? "CLOSE/ROTATE AS TRIAGE DEPRIORITIZATION" : "RUN BOUNDED V1 HISTORY",
      rationale: historyValidation
        ? "No operational route or material victim flow is established at the fixed pin or across the complete bounded history window. This is not a global route-negative conclusion or source refutation."
        : "No operational route is established. Empty candidates retain the 6-decimal V=1e12 barrier; the two V=1 rows warrant only bounded history/exposure evidence before triage deprioritization.",
      bestObservedCandidateForReferenceOnly: ranking[0]?.address || null,
      boundedHistoryCandidates: [
        "0x586b3b7ccef9d1e45e7d38a2845d06e604d79d12",
        "0x177f30a4e3b8c8fa54a01e173a76e4061630d89a"
      ],
      historyGateComplete: Boolean(historyValidation),
      reopenOnlyOn: [
        "external deposit activity",
        "zero-supply transition",
        "holder or seed transfer/acquisition evidence",
        "material value with price and exit evidence",
        "configuration or runtime change"
      ],
      nextAction: historyValidation
        ? "Close/rotate as triage deprioritization; reopen only on a listed evidence change."
        : "Run the bounded V=1 history capture; close/rotate only as triage deprioritization if it establishes no material flow or zero-supply exposure."
    },
    safety: {
      offline: true, network: false, inventoryRead: false, fork: false,
      productionMutation: false, routePositive: "unknown", routePositiveEstablished: false,
      promotionPassed: false, liveExploitabilityClaimed: false
    }
  };
}

function renderMarkdown(analysis) {
  const lines = [
    "# Symbiotic VaultV2 Named Deployment Step3 — Offline Candidate Economics",
    "",
    "> **NO OPERATIONAL ROUTE ESTABLISHED AT THE FIXED PIN**",
    "",
    `- Capture: \`${analysis.sourceCapture.path}\``,
    `- Capture SHA-256: \`${analysis.sourceCapture.sha256}\``,
    ...(analysis.sourceHistory ? [`- History: \`${analysis.sourceHistory.path}\``,
      `- History SHA-256: \`${analysis.sourceHistory.sha256}\``] : []),
    `- Fixed block: \`${analysis.sourceCapture.fixedBlock.number}\` (\`${analysis.sourceCapture.fixedBlock.hash}\`)`,
    `- Exact VaultV2 candidates: **${analysis.counts.exactCandidates}**`,
    `- Permissionless-deposit-advertised candidates: **${analysis.counts.permissionlessDepositAdvertised}**`,
    `- Established route-positive candidates: **${analysis.counts.routePositiveEstablished}**`,
    `- Economics-unknown permissionless candidates: **${analysis.counts.economicsUnknownPermissionlessCandidates}**`,
    `- Permissionless blocked at pin: **${analysis.counts.permissionlessBlockedAtPin}**`,
    "",
    "## Bound model and safety boundary",
    "",
    `The formulas and preconditions are hash-bound to \`${analysis.formulasBinding.path}\` (\`${analysis.formulasBinding.sha256}\`). `
      + "Current VaultV2 rows are exact bound-artifact runtime candidates, not Sourcify-proven current source builds. All arithmetic is exact BigInt arithmetic over raw units. Pending fee shares are effective supply and are never attributed to an attacker. "
      + "No timing/order, exit execution, gas, or conservative net is established.",
    "",
    "The promotion gate is `conservative net > max($1,000, 10bps adversarial capital)`. It is not evaluable from this capture, so no route-positive candidate is established or promoted.",
    "",
    "## Exact state counts",
    ""
  ];
  for (const [key, value] of Object.entries(analysis.counts.byState)) lines.push(`- ${key}: **${value}**`);
  lines.push("", "## Blocker counts", "");
  for (const [key, value] of Object.entries(analysis.counts.byBlocker)) lines.push(`- ${key}: **${value}**`);
  if (analysis.counts.historyEvidence) {
    lines.push("", "## Bounded V=1 history closeout", "",
      `- Complete gap-free history candidates: **${analysis.counts.historyEvidence.candidates}**`,
      `- ONLY_INITIALIZATION_DEPOSIT_OBSERVED: **${analysis.counts.historyEvidence.onlyInitializationDepositObserved}**`,
      `- Zero-share deposits observed: **${analysis.counts.historyEvidence.zeroShareDepositObserved}**`,
      `- Later deposits after initialization observed: **${analysis.counts.historyEvidence.laterDepositAfterInitializationObserved}**`,
      `- Transfers after initial mint observed: **${analysis.counts.historyEvidence.transferAfterInitialMintObserved}**`,
      `- Post-positive zero-supply windows observed: **${analysis.counts.historyEvidence.postPositiveZeroSupplyWindowObserved}**`,
      `- Split runs observed: **${analysis.counts.historyEvidence.splitRunObserved}**`,
      `- Established external victim flow: **${analysis.counts.historyEvidence.establishedExternalVictimFlow}**`,
      `- Promoted for further economics: **${analysis.counts.historyEvidence.promotedFurtherEconomicsWork}**`, "",
      "Each V=1 row has exactly one first observed Deposit and one mint Transfer several blocks after first code. The deposit equals current assets/supply; the same caller/owner is the sole 100% holder. No later deposit, zero-share deposit, post-mint transfer, post-positive zero-supply window, or split run was observed. Holder acquirability and future victim flow remain unknown.");
  }
  lines.push("", "## Ranked permissionless-advertised candidates", "",
    "Ranking is only for a possible future bounded history/exposure gate; it is not an exploitability or profit ranking.", "",
    "| Rank | Vault | Asset | Decimals / V | State | Assets (tokens) | Pending fees | History gate |",
    "|---:|---|---|---:|---|---:|---:|---|");
  for (const row of analysis.ranking) {
    lines.push(`| ${row.rank} | \`${row.address}\` | \`${row.asset}\` | ${row.assetDecimals} / ${row.virtualShares} | ${row.stateClass} | ${row.totalAssetsTokens} | ${row.pendingFeeShares} | ${row.historyCaptureEligible ? "eligible" : "blocked"} |`);
  }
  const empty = analysis.candidates.filter((row) => row.emptyRaceThresholds);
  lines.push("", "## Empty-state conditional thresholds", "",
    "These are generic future-victim-flow-conditional examples using a one-raw-unit seed and one-whole-token equal victim deposits. STANDARD_EXACT_TRANSFER_NONREBASING_ASSET_REQUIRED. They do not establish victim flow or profit; unknown-token rows are hypothetical under that standard-token assumption.", "",
    "| Vault | Decimals | V | D_min raw | D_min tokens | First profitable victim count | USD policy |",
    "|---|---:|---:|---:|---:|---:|---|");
  for (const row of empty) {
    lines.push(`| \`${row.address}\` | ${row.assetDecimals} | ${row.virtualShares} | ${row.emptyRaceThresholds.minimumDonationRaw} | ${row.emptyRaceThresholds.minimumDonationTokens} | ${row.emptyRaceThresholds.firstProfitableEqualDepositCount} | ${row.assetUsd.policyAssumptionApplied ? "policy assumption: canonical USDC=$1" : "unknown"} |`);
  }
  lines.push("", "For every empty 6-decimal candidate, `V=1e12`, `D_min=2e18-1` raw for a one-token victim, and the first profitable equal-deposit count is `2e12+1`. This is an enormous capital and victim-count blocker.",
    "", "## Residual and incumbent handling", "");
  const residual = analysis.candidates.filter((row) => row.residualRestart);
  if (residual.length) {
    for (const row of residual) lines.push(`- \`${row.address}\`: residual ${row.totalAssetsView} raw; ${row.residualRestart.exactFormula}; minimum one-share restart ${row.residualRestart.minimumDepositForOneShareRaw} raw. ${row.residualRestart.caveat} Existing residual is value, not profit.`);
  } else lines.push("- No zero-visible-supply residual state passed the fee precondition for restart analysis.");
  lines.push("- Nonzero incumbent supply rows receive only observed ratio/fee flags. The sole-attacker formula is not applied.",
    "", "## Recommendation", "", `**${analysis.recommendation.display}**`, "",
    `${analysis.recommendation.rationale}`, "",
    `User materiality gate: \`${analysis.materialityGate.expression}\`. No conservative net is established.`, "",
    "Close/rotate is only a triage/deprioritization action, explicitly not a global route-negative conclusion or source refutation.", "",
    `Reopen only on: ${analysis.recommendation.reopenOnlyOn.join("; ")}.`, "",
    `Best reference-only row: \`${analysis.recommendation.bestObservedCandidateForReferenceOnly}\`. Its route-positive status remains unknown.`, "");
  return `${lines.join("\n")}\n`;
}

function writeDeterministic(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
}
function run() {
  const captureBytes = fs.readFileSync(CAPTURE_PATH);
  const formulasBytes = fs.readFileSync(FORMULAS_PATH);
  const historyBytes = fs.readFileSync(HISTORY_PATH);
  const captureHash = sha256(captureBytes);
  const formulasHash = sha256(formulasBytes);
  const historyHash = sha256(historyBytes);
  let capture; let historyArtifact;
  try { capture = JSON.parse(captureBytes); } catch (_) { fail("CAPTURE_JSON_MALFORMED"); }
  try { historyArtifact = JSON.parse(historyBytes); } catch (_) { fail("HISTORY_JSON_MALFORMED"); }
  const analysis = analyzeCapture(capture, { captureSha256: captureHash, formulasSha256: formulasHash,
    historyArtifact, historySha256: historyHash });
  const json = `${JSON.stringify(analysis, null, 2)}\n`;
  const markdown = renderMarkdown(analysis);
  writeDeterministic(ANALYSIS_PATH, json);
  writeDeterministic(MARKDOWN_PATH, markdown);
  process.stdout.write(`${JSON.stringify({ status: "ANALYSIS_WRITTEN", analysis: ANALYSIS_REL,
    markdown: MARKDOWN_REL, exactCandidates: analysis.counts.exactCandidates,
    permissionlessCandidates: analysis.counts.permissionlessDepositAdvertised,
    historyCandidates: analysis.counts.historyEvidence.candidates,
    routePositiveEstablished: 0, recommendation: analysis.recommendation.decision })}\n`);
}

if (require.main === module) {
  try { run(); } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "ANALYSIS_REJECTED",
      reasonCode: error instanceof AnalysisError ? error.code : "INTERNAL_FAILURE" })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CAPTURE_PATH, HISTORY_PATH, ANALYSIS_PATH, MARKDOWN_PATH, CAPTURE_SHA256, FORMULAS_SHA256, HISTORY_SHA256,
  analyzeCapture, analyzeCandidate, deriveHistoryCandidateEvidence, validateHistoryArtifact,
  renderMarkdown, validateCapture,
  _test: { AnalysisError, bigint, pow10, offsetAndVirtualShares, minimumDonation,
    firstProfitableEqualDepositCount, ceilDiv, residualRestart, formatUnits, sha256 }
};
