"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const shadow = require("./run-base-euler-evk-same-asset-shadow-r1");

const nativeGasConversion = (amount = "1") => ({
  nativeAmount: amount, settlementAmount: amount, rateNumerator: "1", rateDenominator: "1",
  rounding: "UP", conservative: true, complete: true, evidence: true, provenance: true
});
function economicsRows(acquisitionAmount) {
  return shadow.ECONOMIC_CATEGORY_NAMES.map((category) => ({
    category,
    treatment: "AMOUNT",
    amount: category === "acquisition" ? String(acquisitionAmount) : "1",
    denomination: "SETTLEMENT_ASSET",
    conservative: true,
    evidence: true,
    provenance: true,
    ...(category === "acquisition" ? { exactOutputAmount: true, venueFeesIncluded: true } : {}),
    ...(shadow.GAS_CATEGORY_NAMES.includes(category) ? { nativeGasConversion: nativeGasConversion() } : {})
  }));
}
function sample(sharesOut, previewRedeem, acquisitionAmount = "5") {
  return {
    sharesOut: String(sharesOut), success: true, reverted: false, provenance: true,
    feeTreatment: "INCLUDED_IN_ACQUISITION_CATEGORY", previewRedeem: String(previewRedeem), convertToAssets: String(previewRedeem),
    economics: economicsRows(acquisitionAmount)
  };
}
const category = (row, name) => row.economics.find((item) => item.category === name);
function fixture() {
  return {
    authority: {
      chainId: 8453, registryPin: "d0e9a428", fixtureOnly: true,
      authorityManifestCommitment: shadow.AUTHORITY_MANIFEST_COMMITMENT, reviewedManifestValidated: true,
      finalizedBlock: { number: 123456, timestamp: "1700000000", finalized: true },
      agreement: { twoFamilies: true, sameBlock: true, sameState: true, mixedState: false },
      bindings: Object.fromEntries(Object.entries(shadow.REVIEWED_AUTHORITY_MANIFEST.bindings).map(([name, commitment]) => [name, { exact: true, commitment }]))
    },
    route: {
      settlementAsset: "asset-a", vaultAsset: "asset-a", shareAsset: "vault-share-v", pairAssets: ["asset-a", "vault-share-v"],
      tokenIn: "asset-a", tokenOut: "vault-share-v", poolCount: 1, venueCount: 1, direct: true, permissionless: true, immediateRedeem: true, exactOutput: true,
      factoryMembership: true, quoterProvenance: true, routerProvenance: true, standardTransfer: true,
      components: Object.fromEntries(shadow.FORBIDDEN_COMPONENTS.map((name) => [name, false]))
    },
    erc4626: {
      assetDecimals: 18, shareDecimals: 18, totalSupply: "1000", totalAssets: "2000", poolShares: "100",
      maxRedeemPool: "100", maxWithdrawPool: "200", underlyingCash: "200", rounding: "DOWN", optimisticConversion: false
    },
    interpolationUsed: false,
    samples: [sample(10, 20, 5), sample(20, 40, 20), sample(30, 60, 30)],
    valuations: { native: { complete: false }, usd: { complete: false } }
  };
}
const run = (mutate = () => {}) => { const value = fixture(); mutate(value); return shadow.runShadowGate(value); };

test("valid positive route is aggregate-only PASS_SHADOW_CANDIDATE with promotion closed", () => {
  const result = run();
  assert.equal(result.status, "PASS_SHADOW_CANDIDATE");
  assert.deepEqual(result.counts, { sampled: 3, evaluated: 3, positive: 3, zero: 0, negative: 0, capacityFailures: 0, structuralFailures: 0, incompleteInputs: 0 });
  assert.deepEqual(result.netSummary, { denomination: "SETTLEMENT_ASSET_BASE_UNITS", minimum: "1", maximum: "16" });
  assert.deepEqual(result.gates, { automaticPromotion: false, routePositive: "unknown", executableNow: "unknown", signedActionJustified: false });
  assert.deepEqual(result.valuationCompleteness, { native: false, usd: false });
});

test("net exactly zero and all-negative ladders reject", () => {
  const zero = run((value) => { for (const row of value.samples) category(row, "acquisition").amount = String(BigInt(row.previewRedeem) - 14n); });
  assert.equal(zero.status, "REJECT"); assert.equal(zero.counts.zero, 3); assert.equal(zero.netSummary.maximum, "0");
  const negative = run((value) => { for (const row of value.samples) category(row, "acquisition").amount = row.previewRedeem; });
  assert.equal(negative.status, "REJECT"); assert.equal(negative.counts.negative, 3); assert.equal(negative.netSummary.maximum, "-14");
  const oneZero = run((value) => { category(value.samples[1], "acquisition").amount = "26"; });
  assert.equal(oneZero.status, "REJECT"); assert.equal(oneZero.counts.zero, 1); assert.equal(oneZero.counts.positive, 2);
  const oneNegative = run((value) => { category(value.samples[1], "acquisition").amount = "27"; });
  assert.equal(oneNegative.status, "REJECT"); assert.equal(oneNegative.counts.negative, 1); assert.equal(oneNegative.counts.positive, 2);
});

test("wrong chain rejects", () => assert.equal(run((value) => { value.authority.chainId = 1; }).status, "REJECT"));

test("mixed, nonfinalized, and two-family failures reject", () => {
  const mutations = [
    (value) => { value.authority.agreement.mixedState = true; },
    (value) => { value.authority.finalizedBlock.finalized = false; },
    (value) => { value.authority.agreement.twoFamilies = false; },
    (value) => { value.authority.agreement.sameBlock = false; },
    (value) => { value.authority.agreement.sameState = false; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("registry and each exact runtime binding are mandatory", () => {
  assert.equal(run((value) => { value.authority.registryPin = "wrong-pin"; }).status, "REJECT");
  for (const name of ["vault", "factory", "proxy", "implementation", "runtime"]) assert.equal(run((value) => { value.authority.bindings[name].exact = false; }).status, "REJECT");
  assert.equal(run((value) => { delete value.authority.bindings.runtime; }).status, "INCOMPLETE");
});

test("only the fixed reviewed fixture manifest and exact reviewed bindings are authorized", () => {
  assert.equal(run((value) => { delete value.authority.reviewedManifestValidated; }).status, "INCOMPLETE");
  assert.equal(run((value) => { value.authority.reviewedManifestValidated = false; }).status, "INCOMPLETE");
  assert.equal(run((value) => { value.authority.fixtureOnly = false; }).status, "REJECT");
  const wrongManifest = run((value) => { value.authority.authorityManifestCommitment = "valid_but_unauthorized_manifest_r2"; });
  assert.equal(wrongManifest.status, "REJECT"); assert.notEqual(wrongManifest.status, "PASS_SHADOW_CANDIDATE");
  for (const name of Object.keys(shadow.REVIEWED_AUTHORITY_MANIFEST.bindings)) {
    const result = run((value) => { value.authority.bindings[name].commitment = `valid_but_unauthorized_${name}_r2`; });
    assert.equal(result.status, "REJECT"); assert.notEqual(result.status, "PASS_SHADOW_CANDIDATE");
  }
});

test("direct pair, factory, quoter, router, and exact-output provenance failures reject", () => {
  const mutations = [
    (value) => { value.route.vaultAsset = "other-asset"; },
    (value) => { value.route.pairAssets.reverse(); },
    (value) => { value.route.poolCount = 2; },
    (value) => { value.route.venueCount = 2; },
    (value) => { value.route.direct = false; },
    (value) => { value.route.permissionless = false; },
    (value) => { value.route.immediateRedeem = false; },
    (value) => { value.route.exactOutput = false; },
    (value) => { value.route.factoryMembership = false; },
    (value) => { value.route.quoterProvenance = false; },
    (value) => { value.route.routerProvenance = false; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("nonstandard transfer and every forbidden route component reject", () => {
  assert.equal(run((value) => { value.route.standardTransfer = false; }).status, "REJECT");
  for (const name of shadow.FORBIDDEN_COMPONENTS) assert.equal(run((value) => { value.route.components[name] = true; }).status, "REJECT");
});

test("missing, failed, reverted, and unprovenanced quote states stop", () => {
  assert.equal(run((value) => { delete category(value.samples[0], "acquisition").amount; }).status, "INCOMPLETE");
  assert.equal(run((value) => { value.samples[0].success = false; }).status, "INCOMPLETE");
  assert.equal(run((value) => { value.samples[0].reverted = true; }).status, "INCOMPLETE");
  assert.equal(run((value) => { value.samples[0].provenance = false; }).status, "REJECT");
  assert.equal(run((value) => { value.samples[0].feeTreatment = "UNKNOWN"; }).status, "REJECT");
});

test("ladder requires exactly three distinct samples and forbids interpolation", () => {
  assert.equal(run((value) => { value.samples.pop(); }).status, "INCOMPLETE");
  assert.equal(run((value) => { value.samples.push(sample(40, 80)); }).status, "INCOMPLETE");
  assert.equal(run((value) => { value.samples[1].sharesOut = value.samples[0].sharesOut; value.samples[1].previewRedeem = value.samples[0].previewRedeem; value.samples[1].convertToAssets = value.samples[0].convertToAssets; }).status, "REJECT");
  assert.equal(run((value) => { value.interpolationUsed = true; }).status, "REJECT");
});

test("each of four ERC4626 capacity inequalities rejects", () => {
  const mutations = [
    (value) => { value.erc4626.poolShares = "29"; },
    (value) => { value.erc4626.maxRedeemPool = "29"; },
    (value) => { value.erc4626.maxWithdrawPool = "59"; },
    (value) => { value.erc4626.underlyingCash = "59"; }
  ];
  for (const mutate of mutations) { const result = run(mutate); assert.equal(result.status, "REJECT"); assert.ok(result.counts.capacityFailures > 0); }
});

test("bad decimals and non-downward or optimistic rounding sanity reject", () => {
  const mutations = [
    (value) => { value.erc4626.assetDecimals = 78; value.erc4626.shareDecimals = 78; },
    (value) => { value.erc4626.shareDecimals = 6; },
    (value) => { value.erc4626.rounding = "UP"; },
    (value) => { value.erc4626.optimisticConversion = true; },
    (value) => { value.samples[0].convertToAssets = "21"; },
    (value) => { value.samples[0].previewRedeem = "21"; value.samples[0].convertToAssets = "20"; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("economics categories are unique, complete, positive, settlement-denominated, and proven", () => {
  assert.equal(run((value) => { value.samples[0].economics.pop(); }).status, "INCOMPLETE");
  assert.equal(run((value) => { value.samples[0].economics.push({ ...value.samples[0].economics[0] }); }).status, "REJECT");
  assert.equal(run((value) => { category(value.samples[0], "latency").amount = "-1"; }).status, "REJECT");
  assert.equal(run((value) => { category(value.samples[0], "latency").amount = "0"; }).status, "REJECT");
  assert.equal(run((value) => { category(value.samples[0], "latency").denomination = "NATIVE"; }).status, "REJECT");
  assert.equal(run((value) => { category(value.samples[0], "competition").provenance = false; }).status, "REJECT");
  assert.equal(run((value) => { category(value.samples[0], "residualUncertainty").evidence = false; }).status, "REJECT");
  assert.equal(run((value) => { category(value.samples[0], "residualUncertainty").conservative = false; }).status, "REJECT");
  assert.equal(run((value) => { category(value.samples[0], "acquisition").exactOutputAmount = false; }).status, "REJECT");
  assert.equal(run((value) => { category(value.samples[0], "acquisition").venueFeesIncluded = false; }).status, "REJECT");
});

test("only bounded category-specific proven-inapplicable rationales permit zero deduction", () => {
  for (const [name, rationale] of Object.entries(shadow.INAPPLICABLE_RATIONALES)) {
    const accepted = run((value) => {
      const row = category(value.samples[0], name);
      Object.assign(row, { treatment: "PROVEN_INAPPLICABLE", rationale });
      delete row.amount; delete row.denomination; delete row.conservative; delete row.nativeGasConversion;
    });
    assert.equal(accepted.status, "PASS_SHADOW_CANDIDATE", name);
  }
  assert.equal(run((value) => {
    const row = category(value.samples[0], "gasApproval");
    Object.assign(row, { treatment: "PROVEN_INAPPLICABLE", rationale: "ARBITRARY_ZERO" });
    delete row.amount; delete row.denomination; delete row.conservative; delete row.nativeGasConversion;
  }).status, "REJECT");
  assert.equal(run((value) => {
    const row = category(value.samples[0], "acquisition");
    Object.assign(row, { treatment: "PROVEN_INAPPLICABLE", rationale: "EXACT_OUTPUT_NOT_NEEDED" });
    delete row.amount; delete row.denomination; delete row.conservative; delete row.exactOutputAmount; delete row.venueFeesIncluded;
  }).status, "REJECT");
});

test("every non-allowlisted category rejects proven-inapplicable treatment with omitted rationale", () => {
  const nonAllowlisted = shadow.ECONOMIC_CATEGORY_NAMES.filter((name) => !Object.hasOwn(shadow.INAPPLICABLE_RATIONALES, name));
  assert.deepEqual(nonAllowlisted, [
    "acquisition", "gasSwap", "gasRedemption", "latency", "competition", "residualUncertainty",
    "quoteDrift", "redemptionDrift", "gasVolatility"
  ]);
  for (const name of nonAllowlisted) {
    const result = run((value) => {
      const row = category(value.samples[0], name);
      row.treatment = "PROVEN_INAPPLICABLE";
      delete row.rationale;
      delete row.amount;
      delete row.denomination;
      delete row.conservative;
      delete row.nativeGasConversion;
      delete row.exactOutputAmount;
      delete row.venueFeesIncluded;
    });
    assert.equal(result.status, "REJECT", name);
  }
});

test("every applicable gas category requires proven conservative native conversion", () => {
  assert.equal(run((value) => { delete category(value.samples[0], "gasSwap").nativeGasConversion; }).status, "INCOMPLETE");
  assert.equal(run((value) => { category(value.samples[0], "gasApproval").nativeGasConversion.provenance = false; }).status, "REJECT");
  assert.equal(run((value) => { category(value.samples[0], "gasApproval").nativeGasConversion.complete = false; }).status, "REJECT");
  assert.equal(run((value) => { category(value.samples[0], "gasRedemption").nativeGasConversion.conservative = false; }).status, "REJECT");
  assert.equal(run((value) => { category(value.samples[0], "gasExecutor").nativeGasConversion.rounding = "DOWN"; }).status, "REJECT");
  assert.equal(run((value) => { category(value.samples[0], "gasDeployment").nativeGasConversion.settlementAmount = "0"; }).status, "REJECT");
  assert.equal(run((value) => { category(value.samples[0], "gasSwap").nativeGasConversion.rateNumerator = "2"; }).status, "REJECT");
  assert.equal(run((value) => {
    value.valuations = { native: { complete: true }, usd: { complete: true } };
    delete category(value.samples[0], "gasSwap").nativeGasConversion;
  }).status, "INCOMPLETE");
});

test("forbidden data sanitizer rejects every prohibited public data class", () => {
  const cases = [
    { url: "opaque" }, { safe: "https://example.invalid" }, { safe: "rpc.example.com" }, { endpoint: "opaque" }, { providerLabel: "p" },
    { operatorFamily: "f" }, { rawRpc: "x" }, { rawQuotePayload: "x" }, { calldata: "0x1234" }, { address: "opaque" },
    { safe: `0x${"11".repeat(20)}` }, { blockHash: "x" }, { stateRoot: "x" }, { transactionHash: "x" }, { credentials: "x" }, { safe: "Bearer abc" }
  ];
  for (const value of cases) assert.throws(() => shadow.assertSanitized(value), shadow.ShadowError);
});

test("output is deterministic, aggregate-only, identifier-free, and contains only allowed statuses", () => {
  const first = run(), second = run();
  assert.deepEqual(first, second);
  assert.ok(["PASS_SHADOW_CANDIDATE", "REJECT", "INCOMPLETE"].includes(first.status));
  const text = JSON.stringify(first);
  assert.equal(/asset-a|vault-share|binding_r1|sharesOut|assetsIn|previewRedeem|convertToAssets|sampleOrder|identifier|https?:|0x[0-9a-f]{40}/iu.test(text), false);
  assert.deepEqual(Object.keys(first.netSummary).sort(), ["denomination", "maximum", "minimum"]);
});

test("missing valuation does not invalidate same-asset math and never promotes", () => {
  const result = run((value) => { delete value.valuations; });
  assert.equal(result.status, "PASS_SHADOW_CANDIDATE");
  assert.deepEqual(result.valuationCompleteness, { native: false, usd: false });
  assert.equal(result.gates.automaticPromotion, false);
  assert.equal(result.gates.routePositive, "unknown");
});

test("all missing structural stop conditions return INCOMPLETE without throwing", () => {
  const mutations = [
    (value) => { delete value.authority; },
    (value) => { delete value.route; },
    (value) => { delete value.erc4626; },
    (value) => { delete value.interpolationUsed; },
    (value) => { delete value.samples; },
    (value) => { delete value.route.components.callback; },
    (value) => { delete value.authority.agreement.sameState; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "INCOMPLETE");
});
