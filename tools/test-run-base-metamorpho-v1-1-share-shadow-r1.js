"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const shadow = require("./run-base-metamorpho-v1-1-share-shadow-r1");

const observationBinding = () => ({
  exact: true,
  candidateCommitment: "candidate_vault_commitment_r1",
  blockNumber: 12345678,
  stateCommitment: "same_state_commitment_r1",
  sourcePinCommitment: "official_source_pin_commitment_r1",
  bundleCommitment: "observation_bundle_commitment_r1"
});
const readProof = (name) => ({
  exact: true,
  success: true,
  reverted: false,
  commitment: `${name}_read_commitment_r1`,
  observationBinding: observationBinding()
});
function market(label, index, liquidity, position) {
  const preimage = {
    loanTokenRef: "asset_a",
    collateralTokenRef: `${label}_collateral`,
    oracleCommitment: `${label}_oracle_commitment`,
    irmCommitment: `${label}_irm_commitment`,
    lltv: "860000000000000000"
  };
  const name = shadow.deriveMarketCommitment(preimage);
  const immediate = BigInt(liquidity) < BigInt(position) ? BigInt(liquidity) : BigInt(position);
  return {
    marketCommitment: name,
    queueIndex: index,
    expectedImmediateWithdrawable: immediate.toString(),
    zeroImmediateWithdrawable: immediate === 0n,
    config: { enabled: true, cap: "1000", read: { ...readProof(`${label}_config`), marketCommitment: name, normalizedEnabled: true, normalizedCap: "1000" } },
    bluePreimage: {
      exact: true,
      marketCommitment: name,
      ...preimage,
      preimageCommitment: `${label}_preimage_commitment`,
      observationBinding: observationBinding()
    },
    vaultSupplyPosition: {
      currentSupplyAssets: String(position),
      rounding: "DOWN",
      zeroPosition: BigInt(position) === 0n,
      read: { ...readProof(`${label}_position`), marketCommitment: name, normalizedAmount: String(position) }
    },
    liquidity: {
      expectedCurrentLiquidity: String(liquidity),
      rounding: "DOWN",
      zeroLiquidity: BigInt(liquidity) === 0n,
      read: { ...readProof(`${label}_liquidity`), marketCommitment: name, normalizedAmount: String(liquidity) }
    }
  };
}
function acquisitionSample(shares, cost) {
  return {
    sharesAcquired: String(shares),
    amountBinding: { exact: true, shares: String(shares), commitment: `amount_${shares}_commitment_r1`, observationBinding: observationBinding() },
    quote: {
      ...readProof(`acquisition_quote_${shares}`),
      fixedAllInCost: true,
      venueFeesIncluded: true,
      venueCommitment: "secondary_share_venue_commitment_r1",
      tokenIn: "asset_a",
      tokenOut: "vault_share_v",
      sharesOut: String(shares),
      allInShareCost: String(cost)
    }
  };
}
function redemptionSample(shares, assets) {
  return {
    sharesRedeemed: String(shares),
    previewRedeem: { ...readProof(`preview_redeem_${shares}`), shareRef: "vault_share_v", assetRef: "asset_a", shares: String(shares), assets: String(assets) },
    immediateRedeemProof: { ...readProof(`immediate_redeem_${shares}`), immediate: true, shareRef: "vault_share_v", assetRef: "asset_a", shares: String(shares), assetsReceived: String(assets) }
  };
}
function candidate() {
  const markets = [market("alpha", 0, 100, 40), market("beta", 1, 60, 100)];
  return {
    candidateCommitment: "candidate_vault_commitment_r1",
    kind: "METAMORPHO_V1_1",
    observationBinding: observationBinding(),
    deployment: { factoryRecognized: true, version: "V1.1", factoryRead: { ...readProof("factory_deployment"), normalizedRecognized: true, normalizedVersion: "V1.1" } },
    runtimeBinding: {
      codePresent: true,
      exact: true,
      sourcePin: shadow.SOURCE_PIN,
      runtimeCommitment: shadow.REVIEWED_FIXTURE_AUTHORITY.bindings.vaultRuntime,
      sourceBindingCommitment: shadow.REVIEWED_FIXTURE_AUTHORITY.bindings.vaultSource,
      observationBinding: observationBinding()
    },
    immutables: {
      exact: true,
      morphoCommitment: shadow.REVIEWED_FIXTURE_AUTHORITY.bindings.morphoImmutable,
      morphoRef: "morpho_blue_core",
      assetRef: "asset_a",
      assetBindingCommitment: shadow.REVIEWED_FIXTURE_AUTHORITY.bindings.assetImmutable,
      observationBinding: observationBinding()
    },
    shareRef: "vault_share_v",
    vaultState: {
      withdrawQueueLength: 2,
      withdrawQueue: markets.map((row) => row.marketCommitment),
      idleAssets: "20",
      maxRedeem: "100",
      maxWithdraw: "200",
      reads: {
        withdrawQueueLength: { ...readProof("withdraw_queue_length"), normalizedLength: 2 },
        withdrawQueue: { ...readProof("withdraw_queue"), normalizedQueue: markets.map((row) => row.marketCommitment) },
        idleAssets: { ...readProof("idle_assets"), normalizedAmount: "20" },
        maxRedeem: { ...readProof("max_redeem"), normalizedAmount: "100" },
        maxWithdraw: { ...readProof("max_withdraw"), normalizedAmount: "200" }
      },
      markets
    },
    acquisition: {
      mode: "DIRECT_SECONDARY_SHARE",
      direct: true,
      secondary: true,
      shareOnly: true,
      genericDex: false,
      venueCount: 1,
      venueCommitment: "secondary_share_venue_commitment_r1",
      venueProof: { ...readProof("secondary_share_venue"), targetSpecific: true, directShareVenue: true, venueCommitment: "secondary_share_venue_commitment_r1" },
      settlementAsset: "asset_a",
      tokenIn: "asset_a",
      tokenOut: "vault_share_v",
      transferable: true,
      standardTransfer: true,
      transferProof: { ...readProof("share_transfer"), shareRef: "vault_share_v", normalizedTransferable: true, normalizedStandardTransfer: true },
      samples: [acquisitionSample(10, 15), acquisitionSample(20, 30), acquisitionSample(30, 45)]
    },
    underlyingExit: { required: false, direct: false, venueCount: 0 },
    components: Object.fromEntries(shadow.FORBIDDEN_COMPONENTS.map((name) => [name, false])),
    redemption: {
      erc4626: true,
      immediateOrRevert: true,
      asyncUserQueue: false,
      delaySeconds: "0",
      assetRef: "asset_a",
      samples: [redemptionSample(10, 19), redemptionSample(20, 38), redemptionSample(30, 57)]
    }
  };
}
function fixture() {
  const reviewed = shadow.REVIEWED_FIXTURE_AUTHORITY;
  return {
    authority: {
      chainId: 8453,
      mode: "OFFLINE_REVIEWED_FIXTURE_ONLY",
      fixtureOnly: true,
      captureEnabled: false,
      factoryVersion: "V1.1",
      officialSourcePin: shadow.SOURCE_PIN,
      reviewedManifestValidated: true,
      manifestCommitment: reviewed.manifestCommitment,
      observation: {
        blockNumber: 12345678,
        timestamp: "1700000000",
        finalized: true,
        requireCanonical: true,
        stateCommitment: "same_state_commitment_r1",
        sourcePinCommitment: "official_source_pin_commitment_r1",
        bundleCommitment: "observation_bundle_commitment_r1"
      },
      observers: [
        { exact: true, finalized: true, requireCanonical: true, blockNumber: 12345678, stateCommitment: "same_state_commitment_r1", sourcePinCommitment: "official_source_pin_commitment_r1", bundleCommitment: "observation_bundle_commitment_r1", classCommitment: reviewed.observerClassCommitments[0], commitment: "observer_commitment_alpha_r1" },
        { exact: true, finalized: true, requireCanonical: true, blockNumber: 12345678, stateCommitment: "same_state_commitment_r1", sourcePinCommitment: "official_source_pin_commitment_r1", bundleCommitment: "observation_bundle_commitment_r1", classCommitment: reviewed.observerClassCommitments[1], commitment: "observer_commitment_beta_r1" }
      ],
      terminalRecheck: {
        exact: true,
        complete: true,
        finalized: true,
        requireCanonical: true,
        blockNumber: 12345678,
        stateCommitment: "same_state_commitment_r1",
        sourcePinCommitment: "official_source_pin_commitment_r1",
        bundleCommitment: "observation_bundle_commitment_r1",
        commitment: "terminal_recheck_commitment_r1",
        observerCommitments: ["observer_commitment_alpha_r1", "observer_commitment_beta_r1"],
        classCommitments: [...reviewed.observerClassCommitments]
      },
      factoryBinding: {
        exact: true,
        version: "V1.1",
        sourcePin: shadow.SOURCE_PIN,
        implementationCommitment: reviewed.bindings.factoryImplementation,
        runtimeCommitment: reviewed.bindings.factoryRuntime
      }
    },
    candidates: [candidate()]
  };
}
const run = (mutate = () => {}) => { const value = fixture(); mutate(value); return shadow.runShadowPreflight(value); };

test("ready fixture produces only aggregate closed-gate shadow readiness", () => {
  const result = run();
  assert.equal(result.status, "READY_FOR_SHADOW_CAPTURE");
  assert.deepEqual(result.counts, { submitted: 1, evaluated: 1, boundVaults: 1, marketRows: 2, acquisitionSamples: 3, redemptionSamples: 3, structuralFailures: 0, incompleteInputs: 0 });
  assert.deepEqual(result.gates, { captureEnabled: false, automaticPromotion: false, signedActionJustified: false, routePositive: "unknown", executableNow: "unknown", economicsEvaluated: false });
  assert.equal(result.authorityMode, "REVIEWED_FIXTURE_ONLY_NOT_REAL_AUTHORITY");
});

test("no candidates holds and ambiguous vaults reject", () => {
  assert.equal(run((value) => { value.candidates = []; }).status, "HOLD_NO_BOUND_VAULT");
  assert.equal(run((value) => { value.candidates.push(candidate()); }).status, "REJECT");
});

test("candidate cap rejects before recursive candidate sanitization", () => {
  let reached = false;
  const hostile = {};
  Object.defineProperty(hostile, "nested", { enumerable: true, get() { reached = true; throw new Error("unreachable"); } });
  const value = fixture();
  value.candidates = Array.from({ length: shadow.MAX_CANDIDATES + 1 }, () => ({}));
  value.candidates[0] = hostile;
  const result = shadow.runShadowPreflight(value);
  assert.equal(result.status, "REJECT");
  assert.equal(result.counts.submitted, 25);
  assert.equal(reached, false);
});

test("bounded pre-traversal rejects oversized nested arrays, accessors, and proxies without invoking them", () => {
  assert.equal(run((value) => { value.candidates[0].unusedOversized = new Array(shadow.INPUT_BUDGET.arrayItems + 1); }).status, "REJECT");
  let candidateGetterReached = false;
  const accessorResult = run((value) => {
    Object.defineProperty(value.candidates[0], "hostile", { enumerable: true, get() { candidateGetterReached = true; throw new Error("unreachable"); } });
  });
  assert.equal(accessorResult.status, "REJECT");
  assert.equal(candidateGetterReached, false);
  let candidatesGetterReached = false;
  const input = fixture();
  Object.defineProperty(input, "candidates", { configurable: true, enumerable: true, get() { candidatesGetterReached = true; throw new Error("unreachable"); } });
  assert.equal(shadow.runShadowPreflight(input).status, "REJECT");
  assert.equal(candidatesGetterReached, false);
  let candidateIndexGetterReached = false;
  const indexed = fixture();
  Object.defineProperty(indexed.candidates, "0", { configurable: true, enumerable: true, get() { candidateIndexGetterReached = true; throw new Error("unreachable"); } });
  assert.equal(shadow.runShadowPreflight(indexed).status, "REJECT");
  assert.equal(candidateIndexGetterReached, false);
  let proxyTrapReached = false;
  const proxied = fixture();
  proxied.candidates[0] = new Proxy({}, { get() { proxyTrapReached = true; throw new Error("unreachable"); } });
  assert.equal(shadow.runShadowPreflight(proxied).status, "REJECT");
  assert.equal(proxyTrapReached, false);
});

test("unexpected implementation failures convert to fail-closed result", () => {
  const original = Object.getPrototypeOf;
  let result;
  try {
    Object.getPrototypeOf = () => { throw new Error("synthetic unexpected failure"); };
    result = shadow.runShadowPreflight(fixture());
  } finally {
    Object.getPrototypeOf = original;
  }
  assert.equal(result.status, "REJECT");
  assert.equal(result.counts.structuralFailures, 1);
});

test("official source, factory V1.1, and fixture authority bindings are exact", () => {
  const mutations = [
    (value) => { value.authority.chainId = 1; },
    (value) => { value.authority.officialSourcePin = "wrong_source_pin"; },
    (value) => { value.authority.factoryVersion = "V1.0"; },
    (value) => { value.authority.factoryBinding.version = "V1.0"; },
    (value) => { value.authority.factoryBinding.sourcePin = "wrong_source_pin"; },
    (value) => { value.authority.factoryBinding.implementationCommitment = "wrong_factory_implementation"; },
    (value) => { value.authority.factoryBinding.runtimeCommitment = "wrong_factory_runtime"; },
    (value) => { value.authority.manifestCommitment = "wrong_reviewed_manifest"; },
    (value) => { value.authority.fixtureOnly = false; },
    (value) => { value.authority.captureEnabled = true; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("factory-recognized deployment, runtime, source, and immutable bindings are mandatory", () => {
  const mutations = [
    (value) => { value.candidates[0].deployment.factoryRecognized = false; },
    (value) => { value.candidates[0].deployment.version = "V1.0"; },
    (value) => { value.candidates[0].deployment.factoryRead.observationBinding.stateCommitment = "other_state"; },
    (value) => { value.candidates[0].deployment.factoryRead.normalizedRecognized = false; },
    (value) => { value.candidates[0].runtimeBinding.codePresent = false; },
    (value) => { value.candidates[0].runtimeBinding.exact = false; },
    (value) => { value.candidates[0].runtimeBinding.sourcePin = "wrong_source_pin"; },
    (value) => { value.candidates[0].runtimeBinding.runtimeCommitment = "wrong_vault_runtime"; },
    (value) => { value.candidates[0].runtimeBinding.sourceBindingCommitment = "wrong_source_binding"; },
    (value) => { value.candidates[0].runtimeBinding.observationBinding.stateCommitment = "other_state"; },
    (value) => { value.candidates[0].immutables.morphoCommitment = "wrong_morpho_immutable"; },
    (value) => { value.candidates[0].immutables.assetBindingCommitment = "wrong_asset_immutable"; },
    (value) => { value.candidates[0].immutables.observationBinding.bundleCommitment = "other_bundle"; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("canonical finalized two-class observation and terminal bindings fail closed", () => {
  const mutations = [
    (value) => { value.authority.observation.finalized = false; },
    (value) => { value.authority.observation.requireCanonical = false; },
    (value) => { value.authority.observers.pop(); },
    (value) => { value.authority.observers[1].classCommitment = value.authority.observers[0].classCommitment; },
    (value) => { value.authority.observers[1].commitment = value.authority.observers[0].commitment; },
    (value) => { value.authority.observers[1].stateCommitment = "other_state"; },
    (value) => { value.authority.terminalRecheck.complete = false; },
    (value) => { value.authority.terminalRecheck.finalized = false; },
    (value) => { value.authority.terminalRecheck.blockNumber += 1; },
    (value) => { value.authority.terminalRecheck.observerCommitments.pop(); },
    (value) => { value.authority.terminalRecheck.classCommitments[1] = value.authority.terminalRecheck.classCommitments[0]; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("withdraw queue length, order, decode, and maximum are enforced", () => {
  const mutations = [
    (value) => { value.candidates[0].vaultState.withdrawQueueLength = 31; },
    (value) => { value.candidates[0].vaultState.withdrawQueueLength = 1; },
    (value) => { value.candidates[0].vaultState.withdrawQueue.reverse(); },
    (value) => { value.candidates[0].vaultState.withdrawQueue[1] = value.candidates[0].vaultState.withdrawQueue[0]; },
    (value) => { value.candidates[0].vaultState.reads.withdrawQueueLength.normalizedLength = 1; },
    (value) => { value.candidates[0].vaultState.reads.withdrawQueue.normalizedQueue.reverse(); },
    (value) => { value.candidates[0].vaultState.markets[1].queueIndex = 0; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("market config, Blue preimage, and current liquidity are bound and decoded", () => {
  const mutations = [
    (value) => { value.candidates[0].vaultState.markets[0].config.enabled = false; },
    (value) => { value.candidates[0].vaultState.markets[0].config.cap = "0"; },
    (value) => { value.candidates[0].vaultState.markets[0].config.read.marketCommitment = "other_market"; },
    (value) => { value.candidates[0].vaultState.markets[0].config.read.normalizedEnabled = false; },
    (value) => { value.candidates[0].vaultState.markets[0].config.read.normalizedCap = "999"; },
    (value) => { value.candidates[0].vaultState.markets[0].bluePreimage.marketCommitment = "other_market"; },
    (value) => { value.candidates[0].vaultState.markets[0].bluePreimage.loanTokenRef = "other_asset"; },
    (value) => { value.candidates[0].vaultState.markets[0].bluePreimage.lltv = "0"; },
    (value) => { value.candidates[0].vaultState.markets[0].bluePreimage.observationBinding.stateCommitment = "other_state"; },
    (value) => { value.candidates[0].vaultState.markets[0].liquidity.read.marketCommitment = "other_market"; },
    (value) => { value.candidates[0].vaultState.markets[0].liquidity.read.normalizedAmount = "99"; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("reviewed market ID derivation covers all five exact Blue preimage parameters", () => {
  const substitutions = {
    loanTokenRef: "other_loan_token",
    collateralTokenRef: "other_collateral_token",
    oracleCommitment: "other_oracle_commitment",
    irmCommitment: "other_irm_commitment",
    lltv: "850000000000000000"
  };
  for (const [field, replacement] of Object.entries(substitutions)) {
    assert.equal(run((value) => { value.candidates[0].vaultState.markets[0].bluePreimage[field] = replacement; }).status, "REJECT", field);
  }
});

test("queue capacity uses exact ordered min of vault position and market liquidity", () => {
  assert.equal(run((value) => {
    const row = value.candidates[0].vaultState.markets[0];
    row.liquidity.expectedCurrentLiquidity = "41";
    row.liquidity.read.normalizedAmount = "41";
  }).status, "READY_FOR_SHADOW_CAPTURE", "liquidity greater than position");
  assert.equal(run((value) => {
    const row = value.candidates[0].vaultState.markets[1];
    row.vaultSupplyPosition.currentSupplyAssets = "61";
    row.vaultSupplyPosition.read.normalizedAmount = "61";
  }).status, "READY_FOR_SHADOW_CAPTURE", "position greater than liquidity");
  assert.equal(run((value) => {
    const row = value.candidates[0].vaultState.markets[0];
    row.vaultSupplyPosition.currentSupplyAssets = "0";
    row.vaultSupplyPosition.read.normalizedAmount = "0";
    row.vaultSupplyPosition.zeroPosition = true;
    row.expectedImmediateWithdrawable = "0";
    row.zeroImmediateWithdrawable = true;
  }).status, "READY_FOR_SHADOW_CAPTURE", "zero position is explicitly handled without overcounting");
  assert.equal(run((value) => {
    const row = value.candidates[0].vaultState.markets[0];
    row.liquidity.expectedCurrentLiquidity = "0";
    row.liquidity.read.normalizedAmount = "0";
    row.liquidity.zeroLiquidity = true;
    row.expectedImmediateWithdrawable = "0";
    row.zeroImmediateWithdrawable = true;
  }).status, "READY_FOR_SHADOW_CAPTURE", "zero liquidity is explicitly handled without overcounting");
  const mutations = [
    (value) => { value.candidates[0].vaultState.markets[0].vaultSupplyPosition.read.normalizedAmount = "39"; },
    (value) => { value.candidates[0].vaultState.markets[0].vaultSupplyPosition.rounding = "UP"; },
    (value) => { value.candidates[0].vaultState.markets[0].vaultSupplyPosition.zeroPosition = true; },
    (value) => { value.candidates[0].vaultState.markets[0].liquidity.rounding = "UP"; },
    (value) => { value.candidates[0].vaultState.markets[0].liquidity.zeroLiquidity = true; },
    (value) => { value.candidates[0].vaultState.markets[0].expectedImmediateWithdrawable = "41"; },
    (value) => { value.candidates[0].vaultState.markets[0].zeroImmediateWithdrawable = true; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("idle assets, maxRedeem, maxWithdraw, and total immediate liquidity capacity reject shortfalls", () => {
  const mutations = [
    (value) => { value.candidates[0].vaultState.reads.idleAssets.normalizedAmount = "19"; },
    (value) => { value.candidates[0].vaultState.reads.maxRedeem.normalizedAmount = "99"; },
    (value) => { value.candidates[0].vaultState.reads.maxWithdraw.normalizedAmount = "199"; },
    (value) => { value.candidates[0].vaultState.maxRedeem = "29"; value.candidates[0].vaultState.reads.maxRedeem.normalizedAmount = "29"; },
    (value) => { value.candidates[0].vaultState.maxWithdraw = "56"; value.candidates[0].vaultState.reads.maxWithdraw.normalizedAmount = "56"; },
    (value) => {
      value.candidates[0].vaultState.idleAssets = "0";
      value.candidates[0].vaultState.reads.idleAssets.normalizedAmount = "0";
      for (const row of value.candidates[0].vaultState.markets) {
        row.liquidity.expectedCurrentLiquidity = "20";
        row.liquidity.read.normalizedAmount = "20";
        row.expectedImmediateWithdrawable = "20";
      }
    }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("direct deposit and mint are value-neutral rejected acquisition modes", () => {
  assert.equal(run((value) => { value.candidates[0].acquisition.mode = "DIRECT_DEPOSIT"; }).status, "REJECT");
  assert.equal(run((value) => { value.candidates[0].acquisition.mode = "DIRECT_MINT"; }).status, "REJECT");
});

test("secondary venue, direction, settlement, transferability, and sample shape are exact", () => {
  const mutations = [
    (value) => { value.candidates[0].acquisition.mode = "GENERIC_SWAP"; },
    (value) => { value.candidates[0].acquisition.direct = false; },
    (value) => { value.candidates[0].acquisition.secondary = false; },
    (value) => { value.candidates[0].acquisition.shareOnly = false; },
    (value) => { value.candidates[0].acquisition.genericDex = true; },
    (value) => { value.candidates[0].acquisition.venueCount = 2; },
    (value) => { value.candidates[0].acquisition.venueProof.targetSpecific = false; },
    (value) => { value.candidates[0].acquisition.venueProof.directShareVenue = false; },
    (value) => { value.candidates[0].acquisition.venueProof.venueCommitment = "other_venue"; },
    (value) => { value.candidates[0].acquisition.tokenOut = "other_share"; },
    (value) => { value.candidates[0].acquisition.tokenIn = "other_asset"; },
    (value) => { value.candidates[0].acquisition.transferable = false; },
    (value) => { value.candidates[0].acquisition.standardTransfer = false; },
    (value) => { value.candidates[0].acquisition.transferProof.normalizedTransferable = false; },
    (value) => { value.candidates[0].acquisition.samples.pop(); },
    (value) => { value.candidates[0].acquisition.samples[1].sharesAcquired = "10"; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("acquisition amount and fixed all-in quote commitments bind candidate and state", () => {
  const mutations = [
    (value) => { value.candidates[0].acquisition.samples[0].amountBinding.shares = "9"; },
    (value) => { value.candidates[0].acquisition.samples[0].amountBinding.observationBinding.candidateCommitment = "other_candidate"; },
    (value) => { value.candidates[0].acquisition.samples[0].quote.observationBinding.stateCommitment = "other_state"; },
    (value) => { value.candidates[0].acquisition.samples[0].quote.fixedAllInCost = false; },
    (value) => { value.candidates[0].acquisition.samples[0].quote.venueFeesIncluded = false; },
    (value) => { value.candidates[0].acquisition.samples[0].quote.venueCommitment = "other_venue"; },
    (value) => { value.candidates[0].acquisition.samples[0].quote.sharesOut = "9"; },
    (value) => { value.candidates[0].acquisition.samples[0].quote.allInShareCost = "0"; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("different underlying requires one direct liquid target-specific exit", () => {
  assert.equal(run((value) => { value.candidates[0].acquisition.settlementAsset = "other_settlement"; value.candidates[0].acquisition.tokenIn = "other_settlement"; }).status, "REJECT");
  const result = run((value) => {
    const row = value.candidates[0];
    row.acquisition.settlementAsset = "other_settlement";
    row.acquisition.tokenIn = "other_settlement";
    for (const sample of row.acquisition.samples) sample.quote.tokenIn = "other_settlement";
    row.underlyingExit = {
      required: true, direct: true, liquid: true, targetSpecific: true, genericDex: false, venueCount: 1,
      tokenIn: "asset_a", tokenOut: "other_settlement", venueCommitment: "underlying_exit_venue_commitment_r1",
      samples: [19, 38, 57].map((assets, index) => ({
        quote: {
          ...readProof(`underlying_exit_${index}`), venueCommitment: "underlying_exit_venue_commitment_r1",
          tokenIn: "asset_a", tokenOut: "other_settlement", underlyingAmountIn: String(assets), settlementAmountOut: String(assets - 1)
        }
      }))
    };
  });
  assert.equal(result.status, "READY_FOR_SHADOW_CAPTURE");
});

test("every forbidden component rejects", () => {
  for (const name of shadow.FORBIDDEN_COMPONENTS) assert.equal(run((value) => { value.candidates[0].components[name] = true; }).status, "REJECT");
});

test("ERC4626 redemption must be immediate, queue-free, exact, positive, and capacity-bound", () => {
  const mutations = [
    (value) => { value.candidates[0].redemption.erc4626 = false; },
    (value) => { value.candidates[0].redemption.immediateOrRevert = false; },
    (value) => { value.candidates[0].redemption.asyncUserQueue = true; },
    (value) => { value.candidates[0].redemption.delaySeconds = "1"; },
    (value) => { value.candidates[0].redemption.assetRef = "other_asset"; },
    (value) => { value.candidates[0].redemption.samples[0].sharesRedeemed = "9"; },
    (value) => { value.candidates[0].redemption.samples[0].previewRedeem.assets = "0"; },
    (value) => { value.candidates[0].redemption.samples[0].previewRedeem.shareRef = "other_share"; },
    (value) => { value.candidates[0].redemption.samples[0].previewRedeem.observationBinding.bundleCommitment = "other_bundle"; },
    (value) => { value.candidates[0].redemption.samples[0].immediateRedeemProof.immediate = false; },
    (value) => { value.candidates[0].redemption.samples[0].immediateRedeemProof.assetRef = "other_asset"; },
    (value) => { value.candidates[0].redemption.samples[0].immediateRedeemProof.assetsReceived = "18"; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("sanitizer rejects transport, identifiers, raw data, and source paths", () => {
  const cases = [
    { url: "opaque" }, { safe: "https://example.invalid" }, { safe: "rpc.example.com" }, { providerLabel: "observer" },
    { family: "observer" }, { rawRpc: "x" }, { rawQuotePayload: "x" }, { calldata: "0x1234" }, { address: "opaque" },
    { safe: `0x${"11".repeat(20)}` }, { blockHash: "x" }, { stateRoot: "x" }, { transactionHash: "x" }, { sourcePath: "x" }
  ];
  for (const value of cases) assert.throws(() => shadow.assertSanitized(value), shadow.ShadowError);
});

test("output is deterministic, aggregate-only, and contains no semantic injected commitments", () => {
  const first = run(), second = run();
  assert.deepEqual(first, second);
  assert.ok(["READY_FOR_SHADOW_CAPTURE", "HOLD_NO_BOUND_VAULT", "REJECT", "INCOMPLETE"].includes(first.status));
  const text = JSON.stringify(first);
  assert.equal(/asset_a|vault_share|market_alpha|candidate_vault|secondary_share|observer_commitment|terminal_recheck|observation_bundle|89de5264|amount|preview|liquidity|queue|https?:|0x[0-9a-f]{40}/iu.test(text), false);
  assert.deepEqual(Object.keys(first.commitments), ["aggregateResult"]);
  assert.equal(first.gates.economicsEvaluated, false);
  assert.equal(first.gates.automaticPromotion, false);
  assert.equal(first.safety.outputArtifacts, false);
});

test("missing structural inputs return INCOMPLETE without throwing", () => {
  const mutations = [
    (value) => { delete value.authority; },
    (value) => { delete value.authority.observation; },
    (value) => { delete value.authority.factoryBinding; },
    (value) => { delete value.candidates; },
    (value) => { delete value.candidates[0].deployment; },
    (value) => { delete value.candidates[0].immutables; },
    (value) => { delete value.candidates[0].vaultState; },
    (value) => { delete value.candidates[0].acquisition; },
    (value) => { delete value.candidates[0].redemption; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "INCOMPLETE");
});
