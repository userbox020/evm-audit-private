#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const RAW = path.join(ROOT, "reports", "raw", "fast", "critical-lorenzo-susd1plus-stale-nav-step1.json");
const MANIFEST = path.join(ROOT, "reports", "raw", "fast", "critical-lorenzo-susd1plus-stale-nav-step1.manifest.json");
const FORGE_RESULT_FILE = path.join(ROOT, "reports", "raw", "fast", "critical-lorenzo-susd1plus-stale-nav-step1.forge-test.json");
const Q = 10n ** 18n;
const P0 = 1_031_617_490_000_000_000n;
const P1 = 1_031_719_320_000_000_000n;
const HISTORICAL_DEPOSIT = 105n * Q;
const HISTORICAL_REQUEST = 101_781_911_430_000_000_000n;
const SEED = "0x4c6f72656e7a6f2d73555344312b53746570312d3230323630373237";

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function fileSha(file) {
  return sha(fs.readFileSync(file));
}
function rel(file) {
  return path.relative(ROOT, file).replaceAll("\\", "/");
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function row(file) {
  const absolute = path.join(ROOT, file);
  return { file, bytes: fs.statSync(absolute).size, sha256: fileSha(absolute) };
}
function mint(deposit, nav) {
  return deposit * Q / nav;
}
function payout(shares, nav) {
  return shares * nav / Q;
}
function matrixCase(name, deposit, p0, p1) {
  const shares = mint(deposit, p0);
  const output = payout(shares, p1);
  return {
    name,
    depositRaw: deposit.toString(),
    p0Raw: p0.toString(),
    p1Raw: p1.toString(),
    sharesRaw: shares.toString(),
    payoutRaw: output.toString(),
    scenarioClaimantWalletDeltaRaw: (output - deposit).toString(),
    navRatioFloorRaw: (deposit * p1 / p0).toString(),
    roundingShortfallFromRatioFloorRaw: (deposit * p1 / p0 - output).toString(),
  };
}

const evidenceInputs = [
  "targets/lorenzo-susd1plus/foundry.toml",
  "targets/lorenzo-susd1plus/PROVENANCE.md",
  "targets/lorenzo-susd1plus/src/ProductionLinkedSUSD1Plus.sol",
  "targets/lorenzo-susd1plus/test/StaleNavSettlementStep1.t.sol",
  "tools/critical-lorenzo-susd1plus-stale-nav-step1.js",
  "tools/run-critical-lorenzo-susd1plus-step1-forge.js",
  "reports/raw/fast/critical-lorenzo-susd1plus-stale-nav-step1.forge-test.json",
  "sources/lorenzo-susd1plus-step6-accounting/reviewed-accounting-snapshot.sol",
  "sources/lorenzo-susd1plus-step6-accounting/source-evidence.json",
  "sources/lorenzo-susd1plus-step6-accounting/live-window.json",
  "definitions/lorenzo-susd1plus-step6-accounting.json",
  "reports/raw/fast/lorenzo-susd1plus-step6-accounting.json",
  "reports/raw/fast/lorenzo-susd1plus-step6-accounting.manifest.json",
];
if (!fs.existsSync(FORGE_RESULT_FILE)) throw new Error("Missing machine-readable Forge result; run the Forge capture first");
const forgeArtifact = JSON.parse(fs.readFileSync(FORGE_RESULT_FILE, "utf8"));
const forgeSuites = Object.values(forgeArtifact.forgeResult || {});
const forgeTests = forgeSuites.flatMap((suite) => Object.values(suite.test_results || {}));
const forgeSucceeded = forgeTests.filter((test) => test.status === "Success").length;
const forgeFuzzTests = forgeTests.filter((test) => test.kind?.Fuzz);
const forgeFuzzRuns = forgeFuzzTests.reduce((sum, test) => sum + Number(test.kind.Fuzz.runs || 0), 0);
if (forgeTests.length === 0 || forgeSucceeded !== forgeTests.length) throw new Error("Forge result is absent or not all-success");
const evidenceRows = evidenceInputs.map(row);
const evidenceAggregateSha256 = sha(canonical(evidenceRows));
const historicalMint = mint(HISTORICAL_DEPOSIT, P0);
const historicalPayout = payout(HISTORICAL_REQUEST, P1);
const historicalEqualP0Payout = payout(HISTORICAL_REQUEST, P0);
const historicalEqualP0Shortfall = HISTORICAL_DEPOSIT - historicalEqualP0Payout;
const historicalNavIncrement = historicalPayout - historicalEqualP0Payout;
const historicalResidue = historicalMint - HISTORICAL_REQUEST;
const raw = {
  schemaVersion: 2,
  evidenceRevision: 2,
  stage: "lorenzo-susd1plus-stale-nav-request-settlement-step1",
  generatedAt: "2026-07-28T02:40:00.000Z",
  classification: "PASS/ROUTE-NEGATIVE-WITHIN-RETAINED-USD1-ACCOUNTING-SUBPATH/PRODUCTION-LINKED-MODEL/EXACT-SOURCE-BUILD-BLOCKED",
  evidenceAggregateSha256,
  scope: {
    routeNegativeClaim: "Only the retained production-linked, exact-transfer/non-rebasing USD1 mint/request/period/claim accounting subpath represented by the local model.",
    exhaustiveProductionAbsenceClaim: false,
    modelIsProductionDifferential: false,
    omitted: [
      "alternative accepted underlyings and decimal-alignment branches",
      "blacklist and frozen-share behavior beyond visible getters/checks",
      "concrete onWithdrawUnderlying implementation",
      "SafeERC20 internals and concrete USD1 transfer/revert/hook behavior",
      "complete role holders, selector-allowlist evolution, and UUPS upgrade authority",
    ],
  },
  safety: {
    localOnly: true,
    networkReads: 0,
    rpcInventoryReads: 0,
    endpointReads: 0,
    secretReads: 0,
    forks: 0,
    signedActions: 0,
    liveActions: 0,
  },
  provenance: {
    targetExistedAtStart: false,
    localGitRepositoryAvailable: false,
    exactProductionStandardJsonAvailable: false,
    exactProductionDependencyClosureAvailable: false,
    sourceRuntimeEquivalence: null,
    retainedCompilerAssociation: "0.8.28+commit.7893614a",
    retainedOptimizerRuns: 200,
    retainedEvmVersion: "paris",
    harnessCompiler: "0.8.28+commit.7893614a",
    harnessBuildIsProductionBuild: false,
    productionProxy: "0x4F2760B32720F013E900DC92F65480137391199b",
    retainedImplementation: "0xAaFE784a51F119d38e57717FD8A00F844BD86f13",
    retainedImplementationRuntimeKeccak256: "0x9a15479ce7e51fb13e9d53fbdff3c03a487cbfba78b5160b0d15a8cd809a3cd1",
    directBoundRetainedEvidence: [
      "sources/lorenzo-susd1plus-step6-accounting/live-window.json",
      "reports/raw/fast/lorenzo-susd1plus-step6-accounting.json",
      "reports/raw/fast/lorenzo-susd1plus-step6-accounting.manifest.json",
    ],
    limitation: "Only directly hash-bound retained verified-source excerpts and sanitized fixed-pin evidence link the model to the USD1 accounting subpath; no exhaustive deployment or exact build claim is made.",
  },
  productionFunctionMap: [
    { function: "supply(address,uint256)", permission: "public", source: "reviewed-accounting-snapshot.sol:215-235", recipientBinding: "shares minted to msg.sender; input sent to portfolio[0]" },
    { function: "requestWithdraw(uint256)", permission: "public when unpaused/not-blacklisted", source: "reviewed-accounting-snapshot.sol:114-140", recipientBinding: "request keyed to msg.sender and current settlementPeriod" },
    { function: "setUnitNav(uint256)", permission: "onlyManager; retained manager selector allowlisted", source: "reviewed-accounting-snapshot.sol:59-71,263-269", recipientBinding: null },
    { function: "resetUnitNav(uint128,uint256)", permission: "onlyManager; retained fixed-pin manager selector not allowlisted", source: "reviewed-accounting-snapshot.sol:73-80,252-269", recipientBinding: null },
    { function: "withdraw(uint128)", permission: "public when unpaused/not-blacklisted", source: "reviewed-accounting-snapshot.sol:142-175", recipientBinding: "request lookup, burn, and payout all bind msg.sender" },
  ],
  stateMachine: {
    requestSnapshot: "shares only",
    requestPeriod: "P",
    firstManagerTransition: "periodUnitNav[P]=P1; unsettledWithdrawShares += periodWithdrawShares[P]; settlementPeriod=P+1",
    secondManagerTransition: "settlementPeriod=P+2 makes request P claimable; its NAV does not replace P1",
    claimNavLookup: "getUnitNav(P+1)=periodUnitNav[P]",
    resetEffect: "if privileged reset becomes reachable before claim, periodUnitNav[P] and the unexecuted payout change",
    requestAccounting: "raw supply and reported supply unchanged; shares become unusable",
    settlementAccounting: "raw supply unchanged; reported supply falls by newly settled request shares",
    claimAccounting: "raw supply and unsettled shares fall equally; reported active supply is unchanged; vault cash falls by payout",
  },
  cases: {
    navMatrix: [
      matrixCase("P1=P0", 100n * Q, P0, P0),
      matrixCase("P1=P0+1raw", 100n * Q, P0, P0 + 1n),
      matrixCase("P1=P0-1raw", 100n * Q, P0, P0 - 1n),
      matrixCase("larger-up", 100n * Q, P0, 1_200_000_000_000_000_000n),
      matrixCase("larger-down", 100n * Q, P0, 800_000_000_000_000_000n),
    ],
    historical: {
      depositRaw: HISTORICAL_DEPOSIT.toString(),
      p0Raw: P0.toString(),
      mintedSharesRaw: historicalMint.toString(),
      requestedSharesRaw: HISTORICAL_REQUEST.toString(),
      p1Raw: P1.toString(),
      payoutRaw: historicalPayout.toString(),
      equalP0PayoutOnRequestedSharesRaw: historicalEqualP0Payout.toString(),
      equalP0ShortfallVsDepositRaw: historicalEqualP0Shortfall.toString(),
      p1MinusP0IncrementRaw: historicalNavIncrement.toString(),
      netScenarioClaimantWalletFlowUpliftRaw: (historicalPayout - HISTORICAL_DEPOSIT).toString(),
      residueSharesRaw: historicalResidue.toString(),
      residueMarkedAtP1Raw: payout(historicalResidue, P1).toString(),
      scenarioClaimantDeltaIncludingMarkedResidueRaw: (historicalPayout + payout(historicalResidue, P1) - HISTORICAL_DEPOSIT).toString(),
      decompositionIdentity: "net wallet-flow uplift = P1-P0 increment - equal-P0 shortfall versus deposit",
      actorLabel: "historical claimant / modeled scenario actor; not labeled an attacker",
      economicsBoundary: "gross USD1 wallet flow only; gas, delay, and opportunity cost excluded",
      attribution: "Higher-NAV benefit minus residual-share/floor effects; not a favorable rounding anomaly.",
    },
    requestBoundaries: {
      zeroRequest: "revert",
      partialBelowMinimum: "revert",
      partialAtMinimum: "success",
      fullUsableBelowMinimum: "success",
      repeatedSamePeriod: "merge before one payout rounding",
      cancellation: "unsupported",
    },
    ordering: {
      sameBlock: "transaction ordering is reachable; request before set enters P, request after set enters P+1",
      competingFullyFunded: "both orders pay fixed formula amounts",
      competingUnderfunded: "In the exact-transfer model, first public claimant can consume cash; the second transfer reverts and all modeled claim state rolls back.",
    },
    donation: "Public actors can add vault or portfolio cash by direct exact-token transfer; this changes cash only, not modeled NAV, shares, or request entitlement.",
    callbacks: "outbound adversarial callback cannot reenter withdraw because lock is held; production USD1 callback behavior remains unproven/unsupported",
    feeOnTransferAndRebasing: "explicitly outside the exact-transfer/non-rebasing model; no production support is asserted",
  },
  rounding: {
    formula: "S=floor(D*1e18/P0); O=floor(S*P1/1e18)",
    upperBound: "O <= floor(D*P1/P0)",
    conversionShortfallBoundRaw: "floor(D*P1/P0)-O <= ceil(P1/1e18)",
    sameNavLossBoundRaw: "0 <= D-O <= ceil(P0/1e18)",
    splitScope: "Only common unchanged P0/P1 and non-overflowing products are compared. Different periods or manager-selected NAVs can produce different payouts.",
    splitMintAndClaim: "Within that scope, fragmentation cannot increase shares or payout; same-period repeated requests merge.",
    fixedSharesSplitClaimBound: "At one common unchanged NAV with non-overflowing products, n separately floored claims lose at most n-1 raw versus one combined floor.",
    extraction: false,
  },
  decisiveAnswers: {
    q1: "Request snapshots shares only. P1 is selected later by manager settlement. After settlement the storage rate is fixed unless a privileged reset path is allowlisted/reached before claim.",
    q2: "Within the modeled USD1 subpath, public actors control supply/request timing, direct cash additions, and eligible claim ordering/consumption. Privileged or custodial actors control NAV/reset/config and operational funding/removal.",
    q3: "The bounded model found no public-only repeatable positive delta without favorable privileged/exogenous NAV and cash. This is not an exhaustive production absence claim.",
    q4: "Gross USD1 wallet-flow uplift 0.010364448859827600 reproduces for the historical claimant/scenario actor: 0.010364452040916900 higher-NAV increment minus 0.000000003181089300 equal-P0 shortfall. Gas/opportunity cost are excluded.",
    q5: "Within common unchanged P0/P1 and non-overflowing products, the double-floor shortfall is at most ceil(P1/1e18) raw and splitting cannot extract. Different-period/manager-NAV outcomes may differ.",
  },
  controlTaxonomy: {
    public: ["supply/request timing", "directly add modeled vault or portfolio cash", "eligible claim ordering that consumes vault cash"],
    privilegedOrCustodial: ["set/reset NAV", "allowlist/pause/blacklist/configuration", "operational funding or removal of vault/portfolio cash"],
  },
  deltas: {
    equalNavRequestedHistoricalScenario: {
      scenarioClaimantWalletRaw: `-${historicalEqualP0Shortfall}`,
      payoutRaw: historicalEqualP0Payout.toString(),
      protocolCashDeltaDepositMinusOutputRaw: historicalEqualP0Shortfall.toString(),
      economicBearer: "unknown because vault prefunding/custody and liabilities are not fully bound",
    },
    historicalConditional: {
      scenarioClaimantGrossWalletFlowRaw: (historicalPayout - HISTORICAL_DEPOSIT).toString(),
      vaultCashRaw: `-${historicalPayout}`,
      portfolioCashRaw: `+${HISTORICAL_DEPOSIT}`,
      combinedVaultPortfolioRaw: (HISTORICAL_DEPOSIT - historicalPayout).toString(),
      economicBearer: "unknown; fully funded execution does not establish who bears the NAV/cash difference",
    },
    underfundedModel: "Conditional on the concrete payout transfer reverting for insufficient cash under exact-transfer semantics: first claim receives the formula amount; second has zero wallet delta and modeled request membership, ongoing shares, claimant shares/usable shares, queue, timestamp, and vault cash roll back.",
  },
  tests: {
    machineReadableOutput: rel(FORGE_RESULT_FILE),
    machineReadableOutputSha256: fileSha(FORGE_RESULT_FILE),
    command: forgeArtifact.command.join(" "),
    prerequisiteCommands: ["forge fmt --check", "forge lint", "forge build --force --offline"],
    testFunctionsObserved: forgeTests.length,
    testFunctionsSucceeded: forgeSucceeded,
    fuzzFunctionsObserved: forgeFuzzTests.length,
    fuzzRunsObserved: forgeFuzzRuns,
    failuresObserved: forgeTests.length - forgeSucceeded,
    seed: forgeArtifact.seed,
    countSource: "derived from hash-bound machine-readable Forge output, not generator constants",
    existingChecks: [
      "node --check tools/lorenzo-susd1plus-step6-accounting.js",
      "JSON.parse retained definition/source/raw/manifest artifacts",
    ],
  },
  gates: {
    sourceBuildBound: false,
    accountingPrimitiveBound: true,
    outsiderControlledPositiveRoute: false,
    routePositive: false,
    executableNow: false,
    signedActionJustified: false,
    fork: false,
    pipeline: "1/5 retained production-linked USD1 accounting-subpath semantics only; exhaustive production source/build and deployed economics unclaimed",
  },
  limitations: [
    "Exact production source/build/runtime equivalence unavailable locally.",
    "Alternative accepted underlyings and decimal alignment are omitted.",
    "Blacklist, frozen-share, concrete onWithdrawUnderlying, SafeERC20, and token hook/revert semantics are not fully retained.",
    "Complete role holders, selector evolution, UUPS authority, pause/config, and upgrade reachability are unavailable.",
    "Portfolio assets are offchain/unmeasured; no production totalAssets or solvency claim is made.",
    "No deployed current state, timing predictability, gas, fees, or economics were queried or claimed.",
    "Harness assumes exact-transfer non-rebasing USD1 semantics; underfunding rollback is conditional on the modeled transfer reverting.",
  ],
  evidenceFiles: evidenceRows,
};

writeJson(RAW, raw);

const packageCandidates = [
  ...evidenceInputs,
  "reports/raw/fast/critical-lorenzo-susd1plus-stale-nav-step1.json",
  "reports/critical-lorenzo-susd1plus-stale-nav-step1.md",
  "coordination/inbox/critical/2026-07-27-critical-lorenzo-susd1plus-step1.json",
  "coordination/handoffs/2026-07-27-critical-lorenzo-susd1plus-step1.md",
].filter((file) => fs.existsSync(path.join(ROOT, file)));
const packageRows = packageCandidates.map(row);
const manifest = {
  schemaVersion: 2,
  evidenceRevision: 2,
  stage: raw.stage,
  generatedAt: raw.generatedAt,
  evidenceAggregateSha256,
  packageAggregateSha256: sha(canonical(packageRows)),
  files: packageRows,
  verification: {
    jsonSyntax: true,
    endpointOrSecretMaterialPersisted: false,
    sourceRuntimeEquivalence: null,
    routeNegativeScope: "retained production-linked exact-transfer USD1 accounting subpath/model only",
    exhaustiveProductionAbsenceClaim: false,
    machineReadableForgeResult: rel(FORGE_RESULT_FILE),
    machineReadableForgeResultSha256: fileSha(FORGE_RESULT_FILE),
    forgeTestsObserved: forgeTests.length,
    forgeTestsSucceeded: forgeSucceeded,
    forgeFuzzRunsObserved: forgeFuzzRuns,
    routePositive: false,
    executableNow: false,
    signedActionJustified: false,
  },
};
writeJson(MANIFEST, manifest);
console.log(JSON.stringify({ evidenceAggregateSha256, packageAggregateSha256: manifest.packageAggregateSha256 }));
