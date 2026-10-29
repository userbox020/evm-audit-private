#!/usr/bin/env node
"use strict";

// Authoritative v3 offline-only economics model. No inventory, network, RPC,
// environment, fork, key, signing, or transaction path exists in this tool.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const NS = "apyusd-economics-requalification-r1";
const CLAIM = "atomic/apyusd-economics-requalification-r1";
const OUT_DIR = path.join(ROOT, "reports", "raw", "fast", NS);
const OUT_PATH = path.join(OUT_DIR, "model-v3.json");
const PATHS = Object.freeze({
  route: path.join(ROOT, "reports", "raw", "fast", "apyusd-erc4626-redeem-route.json"),
  proof: path.join(ROOT, "reports", "raw", "fast", "apyusd-erc4626-fork-proof.json"),
  preflight: path.join(ROOT, "reports", "raw", "fast", "apyusd-receipt-live-preflight.json"),
  staleMarkdown: path.join(ROOT, "reports", "apyusd-erc4626-redeem-route-triage.md"),
  apyUsdSource: path.join(ROOT, "targets", "apyx-evm-contracts-stage2b-fe2ab775", "src", "ApyUSD.sol"),
  scannerSource: path.join(ROOT, "tools", "scan-apyusd-erc4626-redeem-route.js"),
  v1Model: path.join(OUT_DIR, "model.json"), v1Validation: path.join(OUT_DIR, "validation.json"), v1TestResult: path.join(OUT_DIR, "test-result.json"),
  v2Model: path.join(OUT_DIR, "model-v2.json"), v2Validation: path.join(OUT_DIR, "validation-v2.json"), v2TestResult: path.join(OUT_DIR, "test-result-v2.json")
});
const EXPECTED = Object.freeze({
  route: [14129, "0xe2256a38a283d921eddc1419f8b766f0a9a25cf63c4c9bdac1ef25c5fde6b67e"],
  proof: [6979, "0x3c191f261ace9dbf7db18e65c4d9a6b92081b9613199305e11a2ec776d7dbff5"],
  preflight: [5385, "0x954815c03380f70e0cdc43884ab5b75d07455c1767f50a5f32b08a76696e6ad6"],
  staleMarkdown: [3887, "0xc29b459a40143c438c71b61d9df04ff9c9b368d1953b8b1d0ae56b47526a1e02"],
  apyUsdSource: [23861, "0x31530d40f5ad2eb0cea4d1adac27825da3d2a735d1cd7f5bf3409e45975f44a2"],
  scannerSource: [29473, "0xc8ca080e81a4d0a28fe6df3eba335e5c861848adc61e5d9e2b0b3839408f8c3d"],
  v1Model: [97079, "0x1ce451dda1517659ffb63739e313d2225fb1791053976c470cdf11ca13a694a4"],
  v1Validation: [3035, "0x2e8a379394ef8fa2949268c7893a592785bffd9b4d0e442eff23d9b84b2e0273"],
  v1TestResult: [1942, "0xbf7f426b856e6015f9c15a6c0a31a01a5f6d69fa42601229fde1a930f39e0124"],
  v2Model: [113185, "0x1331537d0b245a4e95ac9a93d53321b81a3c487c7317364d68e321b972d81952"],
  v2Validation: [4374, "0x0bdf2407cf3a23f649880c360159048a451446846ded3e3c1dd9598e0d9cedf8"],
  v2TestResult: [2595, "0xafe7aedc4afcb03570b7442293d324674539ea2d9f1558e15be4cc58683402ed"]
});
const DELAYS = Object.freeze([3, 4, 7, 20]);
const CARRY_APR_BPS = Object.freeze([0, 500, 1500, 3000]);
const UNCERTAINTY_BPS = Object.freeze([0, 50, 200]);
const WAD = 10n ** 18n, UNLOCKING_FEE = 10n ** 15n;
const sha256 = (bytes) => `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const rel = (file) => path.relative(ROOT, file).replaceAll("\\", "/");
const text = String;
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
function rat(n, d = 1n) { if (!d) throw new Error("ZERO_DENOMINATOR"); if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); return { n: n / g, d: d / g }; }
function decimal(value) { const s = text(value); if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(s)) throw new Error(`INVALID_DECIMAL:${s}`); const neg = s[0] === "-", body = neg ? s.slice(1) : s; const [w, f = ""] = body.split("."); return rat((neg ? -1n : 1n) * BigInt(`${w}${f}`), 10n ** BigInt(f.length)); }
const sub = (a, b) => rat(a.n * b.d - b.n * a.d, a.d * b.d), mul = (a, b) => rat(a.n * b.n, a.d * b.d), div = (a, b) => rat(a.n * b.d, a.d * b.n);
function fixed(x, places) { const scale = 10n ** BigInt(places), neg = x.n < 0n, n = neg ? -x.n : x.n; const rounded = (n * scale * 2n + x.d) / (2n * x.d); return `${neg && rounded ? "-" : ""}${rounded / scale}${places ? `.${text(rounded % scale).padStart(places, "0")}` : ""}`; }
function parseUnits18(value) { const s = text(value); if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(s)) throw new Error(`INVALID_18_DECIMAL_INPUT:${s}`); const [w, f = ""] = s.split("."); return BigInt(w) * WAD + BigInt(f.padEnd(18, "0")); }
const rawRat = (raw) => rat(raw, WAD), ceilDiv = (n, d) => n === 0n ? 0n : 1n + (n - 1n) / d;
const rawDecimal = (raw) => `${raw / WAD}.${text(raw % WAD).padStart(18, "0")}`;

function bindInputs(check) {
  const artifacts = {}, parsed = {};
  for (const name of Object.keys(EXPECTED)) {
    const bytes = fs.readFileSync(PATHS[name]), record = { path: rel(PATHS[name]), bytes: bytes.length, sha256: sha256(bytes) };
    check(record.bytes === EXPECTED[name][0], `bytes:${name}`); check(record.sha256 === EXPECTED[name][1], `hash:${name}`);
    if (["route", "proof", "preflight"].includes(name)) { parsed[name] = JSON.parse(bytes); record.embeddedGeneratedAt = parsed[name].generatedAt; record.authority = "PINNED_HISTORICAL_INPUT"; }
    else if (name === "staleMarkdown") { parsed[name] = bytes.toString("utf8"); record.embeddedDocumentDate = /^Date: ([0-9-]+)$/m.exec(parsed[name])?.[1] || null; record.authority = "SUPERSEDED_LINEAGE_ONLY_NOT_EVIDENCE_AUTHORITY"; }
    else if (["apyUsdSource", "scannerSource"].includes(name)) { parsed[name] = bytes.toString("utf8"); record.authority = "LOCAL_SEMANTIC_REFERENCE_ONLY"; }
    else { parsed[name] = JSON.parse(bytes); record.schema = parsed[name].schema; record.generatedAt = parsed[name].generatedAt; record.authority = name.startsWith("v1") ? "SUPERSEDED_V1_NON_AUTHORITATIVE" : "SUPERSEDED_V2_NON_AUTHORITATIVE_RECEIPT_DELAY_FEE_P1"; }
    artifacts[name] = record;
  }
  const apy = parsed.apyUsdSource, scanner = parsed.scannerSource;
  check(apy.includes("return assets - _feeOnTotal(assets, $.unlockingFee);"), "tripwire:unlock-order");
  check(apy.includes("feePercentage + FEE_PRECISION, Math.Rounding.Ceil"), "tripwire:unlock-ceil");
  check(scanner.includes("function feeRateAtDelay(curve, delaySeconds) {"), "tripwire:feeRateAtDelay-signature");
  check(scanner.includes("const tHat = ((elapsed - curve.minDuration) * WAD) / span;"), "tripwire:tHat-floor");
  check(scanner.includes("return curve.maxFee - ((delta * tHatPowK) / WAD);"), "tripwire:rate-floor");
  check(scanner.includes("function feeOnAssetsRaw(assetsRaw, feeRateRaw) {"), "tripwire:feeOnAssetsRaw-signature");
  check(scanner.includes("return (assetsRaw * feeRateRaw + WAD - 1n) / WAD;"), "tripwire:feeOnAssetsRaw-ceil");
  return { artifacts, parsed };
}

function parseCurve(route, check) {
  const source = route.candidate.receiptFeeCurve;
  const curve = { minFee: BigInt(source.minFee), maxFee: BigInt(source.maxFee), minDuration: BigInt(source.minDuration), maxDuration: BigInt(source.maxDuration), curvature: BigInt(source.curvature) };
  check(curve.maxDuration >= curve.minDuration, "curve:elapsed-bounds"); check(curve.curvature === WAD, "curve:linear-branch");
  return curve;
}
function feeRateAtDelay(curve, delaySeconds) {
  const elapsed = BigInt(Math.max(0, Math.round(delaySeconds)));
  if (elapsed >= curve.maxDuration) return { elapsed, tHat: WAD, tHatPowK: WAD, rate: curve.minFee, branch: "AT_OR_ABOVE_MAX_DURATION" };
  if (elapsed <= curve.minDuration) return { elapsed, tHat: 0n, tHatPowK: 0n, rate: curve.maxFee, branch: "AT_OR_BELOW_MIN_DURATION" };
  const span = curve.maxDuration - curve.minDuration;
  if (span <= 0n) return { elapsed, tHat: 0n, tHatPowK: 0n, rate: curve.maxFee, branch: "NONPOSITIVE_SPAN" };
  const tHat = ((elapsed - curve.minDuration) * WAD) / span;
  const tHatPowK = curve.curvature === WAD ? tHat : curve.curvature === 2n * WAD ? (tHat * tHat) / WAD : 0n;
  const delta = curve.maxFee > curve.minFee ? curve.maxFee - curve.minFee : 0n;
  return { elapsed, tHat, tHatPowK, rate: curve.maxFee - ((delta * tHatPowK) / WAD), branch: curve.curvature === WAD ? "LINEAR_CURVATURE_WAD" : "SCANNER_FALLBACK" };
}
const feeOnAssetsRaw = (assetsRaw, feeRateRaw) => feeRateRaw <= 0n ? 0n : ceilDiv(assetsRaw * feeRateRaw, WAD);

function correctedRows(route, curve, check) {
  const rows = [], gas = mul(mul(decimal(route.thresholds.gasUnits), decimal(route.gas.gasPriceWei)), div(decimal(route.gas.ethPriceUsd), decimal(WAD)));
  const assetPrice = decimal(route.candidate.assetPriceUsd), slipRate = div(decimal(route.thresholds.slippageBufferBps), decimal(10000));
  for (const sourceRow of route.rows) {
    const grossRaw = parseUnits18(sourceRow.receiptAssets), unlockingFeeRaw = ceilDiv(grossRaw * UNLOCKING_FEE, UNLOCKING_FEE + WAD), principalRaw = grossRaw - unlockingFeeRaw;
    check(unlockingFeeRaw * (UNLOCKING_FEE + WAD) >= grossRaw * UNLOCKING_FEE, `unlock-ceil:${sourceRow.sizeUsd}`);
    for (const delayDays of DELAYS) {
      const source = sourceRow.receiptScenarios.find((x) => x.delayDays === delayDays); check(Boolean(source), `delay:${sourceRow.sizeUsd}:${delayDays}`);
      const derived = feeRateAtDelay(curve, source.delaySeconds), delayFeeRaw = feeOnAssetsRaw(principalRaw, derived.rate), claimRaw = principalRaw - delayFeeRaw;
      const legacyRateRaw = BigInt(Math.round(source.feeRateBps * 1e6)) * 10n ** 8n;
      const legacyFeeRaw = parseUnits18(source.receiptFeeAssets);
      const grossUsd = mul(rawRat(grossRaw), assetPrice), unlockUsd = mul(rawRat(unlockingFeeRaw), assetPrice), principalUsd = mul(rawRat(principalRaw), assetPrice);
      const delayFeeUsd = mul(rawRat(delayFeeRaw), assetPrice), claimUsd = mul(rawRat(claimRaw), assetPrice), slippage = mul(claimUsd, slipRate);
      const net = sub(sub(sub(claimUsd, decimal(sourceRow.sizeUsd)), slippage), gas), bps = mul(div(net, decimal(sourceRow.sizeUsd)), decimal(10000));
      rows.push({ sizeUsd: text(sourceRow.sizeUsd), delayDays, delaySeconds: source.delaySeconds,
        input: { usd: fixed(decimal(sourceRow.sizeUsd), 6), amountInAssetRounded: text(sourceRow.amountInAsset), totalAttackerCapitalUsd: null, borrowedPrincipalIsProfit: false },
        quote: { sharesOutGetDyRounded: text(sourceRow.sharesOut), grossReceiptAssetsRoundedInput: text(sourceRow.receiptAssets), grossReceiptAssetsRaw: text(grossRaw), grossOutputUsd: fixed(grossUsd, 12), routeQuoteImpactUsd: null, routeQuoteImpactTreatment: "ALREADY_EMBODIED_IN_GET_DY_NOT_SEPARATELY_DEDUCTED" },
        unlockingFee: { pinnedFeeRateRaw: text(UNLOCKING_FEE), formula: "ceil(grossReceiptAssetsRaw * fee / (fee + 1e18))", rounding: "CEIL", raw: text(unlockingFeeRaw), assets: rawDecimal(unlockingFeeRaw), usd: fixed(unlockUsd, 12), appliedBeforeReceiptDelayFee: true },
        feeAdjustedReceiptPrincipal: { raw: text(principalRaw), assets: rawDecimal(principalRaw), usd: fixed(principalUsd, 12) },
        receiptDelayFee: { feeRateRaw: text(derived.rate), elapsedSecondsRaw: text(derived.elapsed), tHatRaw: text(derived.tHat), tHatPowKRaw: text(derived.tHatPowK), curveBranch: derived.branch,
          rateFormula: "maxFee-floor((maxFee-minFee)*tHatPowK/1e18)", appliedTo: "FEE_ADJUSTED_RECEIPT_PRINCIPAL", formula: "ceil(principalRaw*feeRateRaw/1e18)", rounding: "CEIL", raw: text(delayFeeRaw), assets: rawDecimal(delayFeeRaw), usd: fixed(delayFeeUsd, 12), appliedExactlyOnce: true,
          legacyRoundedObservation: { feeRateBps: source.feeRateBps, feeRateBpsExpandedRaw: text(legacyRateRaw), exactRateMinusExpandedRaw: text(derived.rate - legacyRateRaw), receiptFeeAssets: text(source.receiptFeeAssets), receiptFeeAssetsParsedRaw: text(legacyFeeRaw), exactFeeMinusPublishedRoundedRaw: text(delayFeeRaw - legacyFeeRaw), receiptFeeUsd: text(source.receiptFeeUsd), usedForCorrectedEconomics: false,
            reconciliation: "Published feeRateBps and receiptFeeAssets are rounded legacy observations; corrected economics uses the derived raw WAD rate and exact ceil only." } },
        claimOutput: { raw: text(claimRaw), assets: rawDecimal(claimRaw), usd: fixed(claimUsd, 12) },
        legacyCosts: { slippageBufferBps: route.thresholds.slippageBufferBps, slippageBufferUsd: fixed(slippage, 12), aggregateGasUnits: route.thresholds.gasUnits, aggregateGasUsd: fixed(gas, 12), componentizedGasAvailable: false },
        netUsd: fixed(net, 12), netBpsOfInputUsd: fixed(bps, 9), exactness: "EXACT_RAW_FEE_MATH_ON_PINNED_DECIMAL_ROUTE_INPUTS_NOT_CHAIN_UNIT_ROUTE_QUOTE_ACCURACY" });
    }
  }
  return rows;
}

function buildModel(options = {}) {
  let checks = 0; const check = (condition, label) => { checks++; if (!condition) throw new Error(`CHECK_FAILED:${label}`); };
  const { artifacts, parsed } = bindInputs(check), { route, proof, preflight } = parsed, curve = parseCurve(route, check);
  check(route.candidate.unlockingFee === text(UNLOCKING_FEE), "pinned-unlocking-fee");
  check(route.rows.length === 5 && route.rows.every((x) => x.receiptScenarios.length === 4), "historical-shape");
  check(proof.result.forkProfitPositive === false && preflight.summary.readOnlyPreflightPassed === false, "newest-negative-observations");
  const rateRows = DELAYS.map((delayDays) => { const x = feeRateAtDelay(curve, delayDays * 86400); return { delayDays, delaySeconds: delayDays * 86400, elapsedBoundsApplied: true, tHatFloorApplied: true, curvatureRaw: text(curve.curvature), branch: x.branch, tHatRaw: text(x.tHat), tHatPowKRaw: text(x.tHatPowK), feeRateRaw: text(x.rate) }; });
  check(JSON.stringify(rateRows.map((x) => x.feeRateRaw)) === JSON.stringify(["34000000000000000", "32000000000000001", "26000000000000001", "0"]), "exact-raw-rates");
  const rows = correctedRows(route, curve, check), carryRows = [], uncertaintyRows = [];
  check(rows.filter((x) => BigInt(x.receiptDelayFee.raw) > 0n).length === 15, "fifteen-nonzero-delay-fees");
  for (const row of rows) for (const aprBps of CARRY_APR_BPS) { const cost = mul(decimal(row.sizeUsd), rat(BigInt(aprBps * row.delayDays), 3650000n)), net = sub(decimal(row.netUsd), cost); carryRows.push({ sizeUsd: row.sizeUsd, delayDays: row.delayDays, aprBps, capitalLockCarryUsd: fixed(cost, 12), correctedBaseNetUsd: row.netUsd, netAfterCarryUsd: fixed(net, 12), netAfterCarryBpsOfInputUsd: fixed(mul(div(net, decimal(row.sizeUsd)), decimal(10000)), 9), totalAttackerCapitalUsd: null, authority: "APR_SCENARIO_PARAMETER_NOT_CURRENT_FINANCING_EVIDENCE" }); }
  for (const row of rows) for (const uncertaintyBps of UNCERTAINTY_BPS) { const cost = mul(decimal(row.sizeUsd), rat(BigInt(uncertaintyBps), 10000n)), net = sub(decimal(row.netUsd), cost); uncertaintyRows.push({ sizeUsd: row.sizeUsd, delayDays: row.delayDays, uncertaintyBps, uncertaintyCostUsd: fixed(cost, 12), correctedBaseNetUsd: row.netUsd, sensitivityNetUsd: fixed(net, 12), sensitivityNetBpsOfInputUsd: fixed(mul(div(net, decimal(row.sizeUsd)), decimal(10000)), 9), totalAttackerCapitalUsd: null, authority: "CONSERVATIVE_SENSITIVITY_PARAMETER_ONLY_NOT_EVIDENCE_OR_PROMOTED_ESTIMATE" }); }
  const sorted = [...rows].sort((a, b) => Number(a.netUsd) - Number(b.netUsd)), best = sorted.at(-1), worst = sorted[0];
  const forkAssetsRaw = parseUnits18(proof.result.receiptState.assets); check(forkAssetsRaw === parseUnits18(proof.result.receiptIssued.amount), "fork-receipt-assets-identity");
  const forkRows = DELAYS.map((delayDays) => { const scenario = proof.result.claimScenarios.find((x) => x.delayDays === delayDays), derived = feeRateAtDelay(curve, delayDays * 86400), computed = feeOnAssetsRaw(forkAssetsRaw, derived.rate), observed = parseUnits18(scenario.currentFee), difference = computed - observed; check(difference >= -1n && difference <= 1n, `fork-fee:${delayDays}`); return { delayDays, forkReceiptAssetsRaw: text(forkAssetsRaw), feeRateRaw: text(derived.rate), computedFeeRaw: text(computed), observedCurrentFeeString: scenario.currentFee, observedCurrentFeeRaw: text(observed), differenceRaw: text(difference), reconciliation: difference === 0n ? "EXACT" : "BOUNDED_ONE_RAW_ROUNDING_DIFFERENCE", causeIfOneRaw: difference === 0n ? null : "Historical execution may differ by one raw unit at integer rounding boundary." }; });
  const model = {
    schema: `${NS}/model-v3`, generatedAt: options.generatedAt || new Date().toISOString(), claim: CLAIM, status: "PASS_V3_RECEIPT_DELAY_FEE_P1_CORRECTED_CURRENT_ECONOMICS_UNKNOWN", mode: "OFFLINE_ONLY_DETERMINISTIC", checks: 0,
    inputs: { commitmentsVerified: true, artifacts, sourceSemantics: { authority: "LOCAL_SEMANTIC_REFERENCE_ONLY", apyUsdUnlockingFeeTripwires: true, scannerFeeRateAtDelayTripwire: true, scannerFeeOnAssetsRawTripwire: true, pinnedUnlockingFeeRaw: text(UNLOCKING_FEE), sourceRuntimeOrDeploymentBindingClaim: false } },
    versionAuthority: { authoritativeVersion: "v3", authoritativeFiles: ["model-v3.json", "validation-v3.json", "test-result-v3.json"], v1Authority: "SUPERSEDED_NON_AUTHORITATIVE_KNOWN_UNLOCKING_FEE_OMISSION", v2Authority: "SUPERSEDED_NON_AUTHORITATIVE_RECEIPT_DELAY_FEE_P1", v1ArtifactsPreserved: true, v2ArtifactsPreserved: true },
    precedence: [{ rank: 1, authority: "THIS_VALIDATED_V3_PACKAGE", scope: "authoritative raw-WAD receipt-delay-fee corrected requalification" }, { rank: 2, authority: "AUG_25_PREFLIGHT", scope: "newest pinned operational observation" }, { rank: 3, authority: "JUNE_30_ROUTE_AND_PROOF", scope: "bounded historical observations" }, { rank: 4, authority: "V2_PACKAGE", scope: "superseded receipt-delay-fee P1; non-authoritative" }, { rank: 5, authority: "V1_PACKAGE", scope: "superseded unlocking-fee omission; non-authoritative" }, { rank: 6, authority: "STALE_POSITIVE_MARKDOWN", scope: "superseded lineage only; never evidence authority" }],
    policy: { currentPromotionRule: { comparator: "STRICT_GREATER_THAN", conservativeNetUsdThreshold: "0", usdMinimum: null, bpsMinimum: null, requiresCompletePublicRouteAndAllGates: true }, supersededLegacyClassification: { minNetProfitUsd: "25", affectsAnyGate: false }, bpsDenominator: "INPUT_USD_ONLY", currentTotalAttackerCapitalUsd: null, borrowedPrincipalIsProfit: false, inventedHaircutUsedAsPromotedEstimate: false },
    precision: { scannerReceiptAssetsInput: "JSON_NUMBER_RENDERED_DECIMAL_WITH_UP_TO_10_FRACTIONAL_DIGITS_RIGHT_PADDED_TO_18_RAW_DECIMALS", rawConversionRounding: "NONE_AFTER_PINNED_DECIMAL_PARSE", unlockingFeeRawRounding: "CEIL_FEE_ON_TOTAL", receiptDelayRate: "DERIVED_RAW_WAD_FROM_PINNED_FEE_CURVE_NEVER_ROUNDED_FEE_RATE_BPS", receiptDelayFeeRawRounding: "CEIL_FEE_ON_ASSETS", legacyPublishedBpsAndFees: "ROUNDED_OBSERVATIONS_ONLY_NOT_CORRECTED_ECONOMICS_INPUTS", reportedUsdDecimals: 12, reportedBpsDecimals: 9, reportRounding: "HALF_AWAY_FROM_ZERO", accuracyStatement: "Raw fee rates and integer fees are exact under pinned scanner semantics; USD and bps outputs remain deterministic calculations from rounded route quote inputs, not twelve-decimal observational accuracy or chain-unit route execution evidence." },
    pinnedFeeCurve: { authority: "PINNED_ROUTE_ARTIFACT_INTERPRETED_BY_PINNED_LOCAL_SCANNER_SEMANTICS", minFeeRaw: text(curve.minFee), maxFeeRaw: text(curve.maxFee), minDurationSeconds: text(curve.minDuration), maxDurationSeconds: text(curve.maxDuration), curvatureRaw: text(curve.curvature), formula: "elapsed bounds; tHat=floor((elapsed-minDuration)*1e18/span); curvature=1e18 linear; rate=maxFee-floor(delta*tHatPowK/1e18)", rows: rateRows },
    correctedHistoricalEconomics: { authority: "PRIMARY_V3_TABLE_RAW_WAD_RATE_AND_CEIL_FEE_CORRECTED", sizesUsd: route.thresholds.tradeSizesUsd.map(String), delaysDays: DELAYS, rows, best: { sizeUsd: best.sizeUsd, delayDays: best.delayDays, netUsd: best.netUsd, netBpsOfInputUsd: best.netBpsOfInputUsd }, worst: { sizeUsd: worst.sizeUsd, delayDays: worst.delayDays, netUsd: worst.netUsd, netBpsOfInputUsd: worst.netBpsOfInputUsd } },
    legacyScannerReconstruction: { authority: "ROUNDED_OBSERVATIONS_AND_SUPERSEDED_PACKAGES_NON_AUTHORITATIVE", roundedFeeRateBpsUsedForV3Economics: false, roundedReceiptFeeUsedForV3Economics: false, v1OmittedKnownUnlockingFee: true, v2UsedRoundedBpsAndFloorInsteadOfRawRateAndCeil: true, reconciliationLocation: "correctedHistoricalEconomics.rows[].receiptDelayFee.legacyRoundedObservation", useForPromotionOrCurrentClaim: false },
    historicalForkFeeReconciliation: { authority: "PINNED_HISTORICAL_FORK_OBSERVATION_NO_RERUN", forkReceiptAssetsString: proof.result.receiptState.assets, forkReceiptAssetsRaw: text(forkAssetsRaw), receiptIssuedAssetsString: proof.result.receiptIssued.amount, exactOrOneRawPolicy: true, allRowsReconciled: forkRows.every((x) => x.differenceRaw === "0" || x.differenceRaw === "1" || x.differenceRaw === "-1"), exactRows: forkRows.filter((x) => x.differenceRaw === "0").length, oneRawRows: forkRows.filter((x) => x.differenceRaw !== "0").length, rows: forkRows, forkRerun: false },
    carrySensitivity: { aprBpsParameters: CARRY_APR_BPS, dayCountConvention: "ACT/365", capitalBase: "INPUT_USD", currentFinancingEvidence: false, promotionEstimate: false, rows: carryRows },
    uncertaintySensitivity: { uncertaintyBpsParameters: UNCERTAINTY_BPS, capitalBase: "INPUT_USD", currentUncertaintyEvidence: false, inventedScenarioParameters: true, promotedEstimate: false, rows: uncertaintyRows },
    currentGates: { capacity: { poolLiquidityUsd: null, capacity: "unknown", passed: false }, freshness: { currentPriceAuthority: "stale", passed: false }, gas: { componentizedCurrentGas: null, passed: false }, configurationAndGovernanceRisk: "unresolved", unwindRisk: "unresolved", historicalForkMatched: false, currentConservativeNetUsd: null, currentTotalAttackerCapitalUsd: null, routePositive: "unknown", executableNow: "unknown", forkEligible: false, signedActionJustified: false, promotionEligible: false },
    conclusion: { currentConservativeNetUsd: null, currentNetBpsOfInputUsd: null, currentTotalAttackerCapitalUsd: null, routePositive: "unknown", executableNow: "unknown", forkEligible: false, signedActionJustified: false, statement: "Corrected historical rows use exact raw WAD receipt fee rates and ceil after the unlocking fee; current net and total attacker capital remain unknown, so promotion, fork, execution, and signing stay closed." },
    counts: { boundHistoricalInputs: 4, localSemanticReferences: 2, supersededV1Artifacts: 3, supersededV2Artifacts: 3, totalBoundArtifacts: 12, historicalSizes: 5, delays: 4, exactRawRateRows: 4, correctedHistoricalRows: rows.length, nonzeroReceiptDelayFeeRows: rows.filter((x) => BigInt(x.receiptDelayFee.raw) > 0n).length, legacyRoundingReconciliations: rows.length, carryAprRates: 4, carryRows: carryRows.length, uncertaintyRates: 3, uncertaintyRows: uncertaintyRows.length, forkFeeReconciliationRows: forkRows.length, forkFeeExactRows: forkRows.filter((x) => x.differenceRaw === "0").length, forkFeeOneRawRows: forkRows.filter((x) => x.differenceRaw !== "0").length },
    safety: { offlineOnly: true, network: false, rpc: false, inventoryRead: false, envRead: false, fork: false, forkRerun: false, keyRead: false, signing: false, transaction: false, broadcast: false, productionMutation: false }
  };
  model.checks = checks; return model;
}

function durablePublishNoOverwrite(file, value) { const parent = path.dirname(file); if (!fs.statSync(parent).isDirectory()) throw new Error("OUTPUT_PARENT_NOT_STABLE_DIRECTORY"); if (fs.existsSync(file)) throw new Error(`FINAL_ALREADY_EXISTS:${path.basename(file)}`); const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`), temporary = path.join(parent, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`); let fd; try { fd = fs.openSync(temporary, "wx", 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; if (!fs.readFileSync(temporary).equals(bytes)) throw new Error("TEMP_READBACK_MISMATCH"); fs.linkSync(temporary, file); if (!fs.readFileSync(file).equals(bytes)) throw new Error("FINAL_READBACK_MISMATCH"); fs.unlinkSync(temporary); return { bytes: bytes.length, sha256: sha256(bytes) }; } catch (error) { if (fd !== undefined) fs.closeSync(fd); try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) {} throw error; } }
function verifyExisting(existing) { const generatedAt = existing.generatedAt; assert.equal(typeof generatedAt, "string"); assert.deepStrictEqual(existing, buildModel({ generatedAt })); }
function main() { const args = process.argv.slice(2); if (args.length !== 1 || !["--check", "--write-v3"].includes(args[0])) throw new Error("ARGV_FORBIDDEN_USE_CHECK_OR_WRITE_V3"); const model = buildModel(); let publication = null; if (args[0] === "--write-v3") publication = durablePublishNoOverwrite(OUT_PATH, model); else if (fs.existsSync(OUT_PATH)) verifyExisting(JSON.parse(fs.readFileSync(OUT_PATH))); console.log(JSON.stringify({ status: model.status, mode: args[0].slice(2), checks: model.checks, counts: model.counts, best: model.correctedHistoricalEconomics.best, worst: model.correctedHistoricalEconomics.worst, routePositive: "unknown", forkEligible: false, wrote: Boolean(publication), publication })); }
module.exports = { buildModel, durablePublishNoOverwrite, OUT_PATH };
if (require.main === module) { try { main(); } catch (error) { console.error(JSON.stringify({ status: "FAIL", diagnostic: text(error.message || error).slice(0, 500) })); process.exitCode = 1; } }
