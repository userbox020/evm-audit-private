#!/usr/bin/env node
"use strict";

// Independent authoritative-v3 validator. It never imports or executes the model.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, ".."), NS = "apyusd-economics-requalification-r1", CLAIM = "atomic/apyusd-economics-requalification-r1";
const OUT_DIR = path.join(ROOT, "reports", "raw", "fast", NS), MODEL_PATH = path.join(OUT_DIR, "model-v3.json"), VALIDATION_PATH = path.join(OUT_DIR, "validation-v3.json");
const PATHS = Object.freeze({ route: path.join(ROOT, "reports", "raw", "fast", "apyusd-erc4626-redeem-route.json"), proof: path.join(ROOT, "reports", "raw", "fast", "apyusd-erc4626-fork-proof.json"), preflight: path.join(ROOT, "reports", "raw", "fast", "apyusd-receipt-live-preflight.json"), staleMarkdown: path.join(ROOT, "reports", "apyusd-erc4626-redeem-route-triage.md"), apyUsdSource: path.join(ROOT, "targets", "apyx-evm-contracts-stage2b-fe2ab775", "src", "ApyUSD.sol"), scannerSource: path.join(ROOT, "tools", "scan-apyusd-erc4626-redeem-route.js"), v1Model: path.join(OUT_DIR, "model.json"), v1Validation: path.join(OUT_DIR, "validation.json"), v1TestResult: path.join(OUT_DIR, "test-result.json"), v2Model: path.join(OUT_DIR, "model-v2.json"), v2Validation: path.join(OUT_DIR, "validation-v2.json"), v2TestResult: path.join(OUT_DIR, "test-result-v2.json") });
const EXPECTED = Object.freeze({ route: [14129, "0xe2256a38a283d921eddc1419f8b766f0a9a25cf63c4c9bdac1ef25c5fde6b67e"], proof: [6979, "0x3c191f261ace9dbf7db18e65c4d9a6b92081b9613199305e11a2ec776d7dbff5"], preflight: [5385, "0x954815c03380f70e0cdc43884ab5b75d07455c1767f50a5f32b08a76696e6ad6"], staleMarkdown: [3887, "0xc29b459a40143c438c71b61d9df04ff9c9b368d1953b8b1d0ae56b47526a1e02"], apyUsdSource: [23861, "0x31530d40f5ad2eb0cea4d1adac27825da3d2a735d1cd7f5bf3409e45975f44a2"], scannerSource: [29473, "0xc8ca080e81a4d0a28fe6df3eba335e5c861848adc61e5d9e2b0b3839408f8c3d"], v1Model: [97079, "0x1ce451dda1517659ffb63739e313d2225fb1791053976c470cdf11ca13a694a4"], v1Validation: [3035, "0x2e8a379394ef8fa2949268c7893a592785bffd9b4d0e442eff23d9b84b2e0273"], v1TestResult: [1942, "0xbf7f426b856e6015f9c15a6c0a31a01a5f6d69fa42601229fde1a930f39e0124"], v2Model: [113185, "0x1331537d0b245a4e95ac9a93d53321b81a3c487c7317364d68e321b972d81952"], v2Validation: [4374, "0x0bdf2407cf3a23f649880c360159048a451446846ded3e3c1dd9598e0d9cedf8"], v2TestResult: [2595, "0xafe7aedc4afcb03570b7442293d324674539ea2d9f1558e15be4cc58683402ed"] });
const DELAYS = [3, 4, 7, 20], WAD = 10n ** 18n, UNLOCK = 10n ** 15n;
const SEMANTIC = ["inputs", "versionAuthority", "precedence", "policy", "precision", "pinnedFeeCurve", "correctedHistoricalEconomics", "legacyScannerReconstruction", "historicalForkFeeReconciliation", "carrySensitivity", "uncertaintySensitivity", "currentGates", "conclusion", "counts", "safety"];
let assertions = 0;
function check(c, l) { assertions++; if (!c) throw new Error(`VALIDATION_FAILED:${l}`); }
function same(a, b, l) { assertions++; try { assert.deepStrictEqual(a, b); } catch (_) { throw new Error(`VALIDATION_FAILED:${l}`); } }
const hash = (b) => `0x${crypto.createHash("sha256").update(b).digest("hex")}`, rel = (f) => path.relative(ROOT, f).replaceAll("\\", "/"), text = String;
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
function q(n, d = 1n) { if (!d) throw new Error("ZERO_DENOMINATOR"); if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); return { n: n / g, d: d / g }; }
function dec(x) { const s = text(x), neg = s[0] === "-", body = neg ? s.slice(1) : s, [w, f = ""] = body.split("."); if (!/^[0-9]+$/.test(w + f)) throw new Error("BAD_DECIMAL"); return q((neg ? -1n : 1n) * BigInt(w + f), 10n ** BigInt(f.length)); }
const minus = (a, b) => q(a.n * b.d - b.n * a.d, a.d * b.d), times = (a, b) => q(a.n * b.n, a.d * b.d), over = (a, b) => q(a.n * b.d, a.d * b.n);
function fixed(x, p) { const s = 10n ** BigInt(p), neg = x.n < 0n, n = neg ? -x.n : x.n, r = (n * s * 2n + x.d) / (2n * x.d); return `${neg && r ? "-" : ""}${r / s}${p ? `.${text(r % s).padStart(p, "0")}` : ""}`; }
function units(x) { const [w, f = ""] = text(x).split("."); if (!/^[0-9]+$/.test(w + f) || f.length > 18) throw new Error("BAD_RAW_INPUT"); return BigInt(w) * WAD + BigInt(f.padEnd(18, "0")); }
const ceil = (n, d) => n ? 1n + (n - 1n) / d : 0n, rawQ = (x) => q(x, WAD);

function independentRate(curve, delaySeconds) {
  const elapsed = BigInt(Math.max(0, Math.round(delaySeconds))), minDuration = BigInt(curve.minDuration), maxDuration = BigInt(curve.maxDuration), maxFee = BigInt(curve.maxFee), minFee = BigInt(curve.minFee), curvature = BigInt(curve.curvature);
  if (elapsed >= maxDuration) return { rate: minFee, tHat: WAD, branch: "AT_OR_ABOVE_MAX_DURATION" };
  if (elapsed <= minDuration) return { rate: maxFee, tHat: 0n, branch: "AT_OR_BELOW_MIN_DURATION" };
  const span = maxDuration - minDuration; if (span <= 0n) return { rate: maxFee, tHat: 0n, branch: "NONPOSITIVE_SPAN" };
  const tHat = (elapsed - minDuration) * WAD / span;
  let power; if (curvature === WAD) power = tHat; else if (curvature === 2n * WAD) power = tHat * tHat / WAD; else power = 0n;
  const delta = maxFee > minFee ? maxFee - minFee : 0n;
  return { rate: maxFee - delta * power / WAD, tHat, branch: curvature === WAD ? "LINEAR_CURVATURE_WAD" : "SCANNER_FALLBACK" };
}
const independentFeeOnAssets = (assets, rate) => rate <= 0n ? 0n : (assets * rate + WAD - 1n) / WAD;

function inputs() {
  const records = {}, data = {};
  for (const name of Object.keys(EXPECTED)) {
    const bytes = fs.readFileSync(PATHS[name]); same([bytes.length, hash(bytes)], EXPECTED[name], `binding:${name}`);
    const record = { path: rel(PATHS[name]), bytes: bytes.length, sha256: hash(bytes) };
    if (["route", "proof", "preflight"].includes(name)) { data[name] = JSON.parse(bytes); record.embeddedGeneratedAt = data[name].generatedAt; record.authority = "PINNED_HISTORICAL_INPUT"; }
    else if (name === "staleMarkdown") { data[name] = bytes.toString("utf8"); record.embeddedDocumentDate = /^Date: ([0-9-]+)$/m.exec(data[name])?.[1] || null; record.authority = "SUPERSEDED_LINEAGE_ONLY_NOT_EVIDENCE_AUTHORITY"; }
    else if (["apyUsdSource", "scannerSource"].includes(name)) { data[name] = bytes.toString("utf8"); record.authority = "LOCAL_SEMANTIC_REFERENCE_ONLY"; }
    else { data[name] = JSON.parse(bytes); record.schema = data[name].schema; record.generatedAt = data[name].generatedAt; record.authority = name.startsWith("v1") ? "SUPERSEDED_V1_NON_AUTHORITATIVE" : "SUPERSEDED_V2_NON_AUTHORITATIVE_RECEIPT_DELAY_FEE_P1"; }
    records[name] = record;
  }
  check(data.apyUsdSource.includes("feePercentage + FEE_PRECISION, Math.Rounding.Ceil"), "apy-ceil-tripwire");
  check(data.scannerSource.includes("function feeRateAtDelay(curve, delaySeconds) {"), "scanner-rate-tripwire");
  check(data.scannerSource.includes("const tHat = ((elapsed - curve.minDuration) * WAD) / span;"), "scanner-that-tripwire");
  check(data.scannerSource.includes("return curve.maxFee - ((delta * tHatPowK) / WAD);"), "scanner-rate-floor-tripwire");
  check(data.scannerSource.includes("function feeOnAssetsRaw(assetsRaw, feeRateRaw) {"), "scanner-fee-tripwire");
  check(data.scannerSource.includes("return (assetsRaw * feeRateRaw + WAD - 1n) / WAD;"), "scanner-ceil-tripwire");
  return { records, data };
}

function validateModel() {
  assertions = 0; const { records, data } = inputs(), bytes = fs.readFileSync(MODEL_PATH), model = JSON.parse(bytes);
  same(bytes, Buffer.from(`${JSON.stringify(model, null, 2)}\n`), "model-canonical");
  same(Object.keys(model), ["schema", "generatedAt", "claim", "status", "mode", "checks", ...SEMANTIC], "strict-schema");
  same(model.schema, `${NS}/model-v3`, "schema"); same(model.claim, CLAIM, "claim"); same(model.status, "PASS_V3_RECEIPT_DELAY_FEE_P1_CORRECTED_CURRENT_ECONOMICS_UNKNOWN", "status"); same(model.mode, "OFFLINE_ONLY_DETERMINISTIC", "mode");
  same(model.inputs.artifacts, records, "artifact-records"); same(model.inputs.artifacts.scannerSource.authority, "LOCAL_SEMANTIC_REFERENCE_ONLY", "scanner-local-only");
  same(model.versionAuthority.authoritativeVersion, "v3", "v3-authority"); same(model.versionAuthority.authoritativeFiles, ["model-v3.json", "validation-v3.json", "test-result-v3.json"], "v3-files");
  same(model.versionAuthority.v1Authority, "SUPERSEDED_NON_AUTHORITATIVE_KNOWN_UNLOCKING_FEE_OMISSION", "v1-non-authority"); same(model.versionAuthority.v2Authority, "SUPERSEDED_NON_AUTHORITATIVE_RECEIPT_DELAY_FEE_P1", "v2-non-authority");
  check(model.versionAuthority.v1ArtifactsPreserved && model.versionAuthority.v2ArtifactsPreserved, "old-artifacts-preserved");
  same(model.precision.receiptDelayRate, "DERIVED_RAW_WAD_FROM_PINNED_FEE_CURVE_NEVER_ROUNDED_FEE_RATE_BPS", "raw-rate-wording"); same(model.precision.receiptDelayFeeRawRounding, "CEIL_FEE_ON_ASSETS", "ceil-wording"); check(model.precision.accuracyStatement.includes("rounded route quote inputs"), "precision-caveat");
  const curve = data.route.candidate.receiptFeeCurve, expectedRates = [34000000000000000n, 32000000000000001n, 26000000000000001n, 0n];
  for (let i = 0; i < DELAYS.length; i++) { const got = independentRate(curve, DELAYS[i] * 86400); same(got.rate, expectedRates[i], `raw-rate:${DELAYS[i]}`); same(model.pinnedFeeCurve.rows[i].feeRateRaw, text(got.rate), `published-rate:${DELAYS[i]}`); same(model.pinnedFeeCurve.rows[i].tHatRaw, text(got.tHat), `published-that:${DELAYS[i]}`); }
  same(model.correctedHistoricalEconomics.rows.length, 20, "twenty-rows"); let nonzero = 0; const recomputed = [];
  const gas = times(times(dec(data.route.thresholds.gasUnits), dec(data.route.gas.gasPriceWei)), over(dec(data.route.gas.ethPriceUsd), dec(WAD))), price = dec(data.route.candidate.assetPriceUsd), slipRate = over(dec(data.route.thresholds.slippageBufferBps), dec(10000));
  for (const sourceRow of data.route.rows) {
    const gross = units(sourceRow.receiptAssets), unlock = ceil(gross * UNLOCK, WAD + UNLOCK), principal = gross - unlock;
    for (const day of DELAYS) {
      const row = model.correctedHistoricalEconomics.rows.find((x) => x.sizeUsd === text(sourceRow.sizeUsd) && x.delayDays === day), source = sourceRow.receiptScenarios.find((x) => x.delayDays === day), rate = independentRate(curve, source.delaySeconds).rate, fee = independentFeeOnAssets(principal, rate), claim = principal - fee;
      if (fee > 0n) nonzero++;
      same(row.receiptDelayFee.feeRateRaw, text(rate), `row-rate:${sourceRow.sizeUsd}:${day}`); same(row.receiptDelayFee.rounding, "CEIL", `row-ceil:${sourceRow.sizeUsd}:${day}`); same(BigInt(row.receiptDelayFee.raw), fee, `row-fee:${sourceRow.sizeUsd}:${day}`); same(BigInt(row.claimOutput.raw), claim, `row-claim:${sourceRow.sizeUsd}:${day}`);
      const expanded = BigInt(Math.round(source.feeRateBps * 1e6)) * 10n ** 8n, legacyFee = units(source.receiptFeeAssets);
      same(row.receiptDelayFee.legacyRoundedObservation.feeRateBpsExpandedRaw, text(expanded), `legacy-rate:${sourceRow.sizeUsd}:${day}`); same(row.receiptDelayFee.legacyRoundedObservation.exactRateMinusExpandedRaw, text(rate - expanded), `rate-diff:${sourceRow.sizeUsd}:${day}`); same(row.receiptDelayFee.legacyRoundedObservation.exactFeeMinusPublishedRoundedRaw, text(fee - legacyFee), `fee-diff:${sourceRow.sizeUsd}:${day}`); same(row.receiptDelayFee.legacyRoundedObservation.usedForCorrectedEconomics, false, `legacy-unused:${sourceRow.sizeUsd}:${day}`);
      const claimUsd = times(rawQ(claim), price), net = minus(minus(minus(claimUsd, dec(sourceRow.sizeUsd)), times(claimUsd, slipRate)), gas), bps = times(over(net, dec(sourceRow.sizeUsd)), dec(10000));
      same(row.claimOutput.usd, fixed(claimUsd, 12), `claim-usd:${sourceRow.sizeUsd}:${day}`); same(row.netUsd, fixed(net, 12), `net:${sourceRow.sizeUsd}:${day}`); same(row.netBpsOfInputUsd, fixed(bps, 9), `bps:${sourceRow.sizeUsd}:${day}`); recomputed.push({ row, net });
    }
  }
  same(nonzero, 15, "fifteen-nonzero"); same(model.counts.nonzeroReceiptDelayFeeRows, 15, "count-nonzero");
  const sorted = [...recomputed].sort((a, b) => Number(a.row.netUsd) - Number(b.row.netUsd)); same(model.correctedHistoricalEconomics.best, { sizeUsd: sorted.at(-1).row.sizeUsd, delayDays: sorted.at(-1).row.delayDays, netUsd: sorted.at(-1).row.netUsd, netBpsOfInputUsd: sorted.at(-1).row.netBpsOfInputUsd }, "best"); same(model.correctedHistoricalEconomics.worst, { sizeUsd: sorted[0].row.sizeUsd, delayDays: sorted[0].row.delayDays, netUsd: sorted[0].row.netUsd, netBpsOfInputUsd: sorted[0].row.netBpsOfInputUsd }, "worst");
  const forkAssets = units(data.proof.result.receiptState.assets); same(forkAssets, units(data.proof.result.receiptIssued.amount), "fork-asset-identity"); same(model.historicalForkFeeReconciliation.rows.length, 4, "four-fork-rows");
  for (const day of DELAYS) { const source = data.proof.result.claimScenarios.find((x) => x.delayDays === day), rate = independentRate(curve, day * 86400).rate, computed = independentFeeOnAssets(forkAssets, rate), observed = units(source.currentFee), difference = computed - observed, row = model.historicalForkFeeReconciliation.rows.find((x) => x.delayDays === day); check(difference >= -1n && difference <= 1n, `fork-bound:${day}`); same(row.feeRateRaw, text(rate), `fork-rate:${day}`); same(row.computedFeeRaw, text(computed), `fork-computed:${day}`); same(row.observedCurrentFeeString, source.currentFee, `fork-string:${day}`); same(row.observedCurrentFeeRaw, text(observed), `fork-observed:${day}`); same(row.differenceRaw, text(difference), `fork-difference:${day}`); }
  same(model.historicalForkFeeReconciliation.exactRows, 4, "fork-exact-count"); same(model.historicalForkFeeReconciliation.oneRawRows, 0, "fork-one-raw-count");
  same(model.carrySensitivity.rows.length, 80, "carry-rows"); same(model.uncertaintySensitivity.rows.length, 60, "uncertainty-rows"); check(model.carrySensitivity.rows.every((x) => x.totalAttackerCapitalUsd === null && Object.hasOwn(x, "netAfterCarryBpsOfInputUsd")), "carry-fields"); check(model.uncertaintySensitivity.rows.every((x) => x.totalAttackerCapitalUsd === null && Object.hasOwn(x, "sensitivityNetBpsOfInputUsd")), "uncertainty-fields");
  same(model.policy.currentPromotionRule.comparator, "STRICT_GREATER_THAN", "strict-comparator"); same(model.policy.currentPromotionRule.conservativeNetUsdThreshold, "0", "net-threshold"); check(model.policy.currentPromotionRule.requiresCompletePublicRouteAndAllGates, "strict-gates");
  same(model.currentGates.currentConservativeNetUsd, null, "current-net-null"); same(model.currentGates.currentTotalAttackerCapitalUsd, null, "capital-null"); same(model.currentGates.routePositive, "unknown", "route-unknown"); same(model.currentGates.executableNow, "unknown", "executable-unknown"); same(model.currentGates.forkEligible, false, "fork-false"); same(model.currentGates.signedActionJustified, false, "sign-false"); same(model.safety.forkRerun, false, "no-fork-rerun");
  same(model.counts, { boundHistoricalInputs: 4, localSemanticReferences: 2, supersededV1Artifacts: 3, supersededV2Artifacts: 3, totalBoundArtifacts: 12, historicalSizes: 5, delays: 4, exactRawRateRows: 4, correctedHistoricalRows: 20, nonzeroReceiptDelayFeeRows: 15, legacyRoundingReconciliations: 20, carryAprRates: 4, carryRows: 80, uncertaintyRates: 3, uncertaintyRows: 60, forkFeeReconciliationRows: 4, forkFeeExactRows: 4, forkFeeOneRawRows: 0 }, "counts");
  return { model, bytes, records, assertions };
}

function publish(file, value) { if (fs.existsSync(file)) throw new Error(`FINAL_ALREADY_EXISTS:${path.basename(file)}`); const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`), temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`); let fd; try { fd = fs.openSync(temp, "wx", 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.linkSync(temp, file); if (!fs.readFileSync(file).equals(bytes)) throw new Error("READBACK"); fs.unlinkSync(temp); return { bytes: bytes.length, sha256: hash(bytes) }; } catch (e) { if (fd !== undefined) fs.closeSync(fd); try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {} throw e; } }
function record(r) { return { schema: `${NS}/validation-v3`, generatedAt: new Date().toISOString(), status: "PASS", validatorIndependentOfModelImplementation: true, rawFeeCurveIndependentlyImplemented: true, feeOnAssetsCeilIndependentlyImplemented: true, assertions: r.assertions, model: { path: rel(MODEL_PATH), bytes: r.bytes.length, sha256: hash(r.bytes), schema: r.model.schema, modelChecks: r.model.checks }, inputs: r.records, counts: r.model.counts, semanticSectionsCompared: SEMANTIC, forkFeeReconciliation: { rows: 4, exactRows: r.model.historicalForkFeeReconciliation.exactRows, oneRawRows: r.model.historicalForkFeeReconciliation.oneRawRows }, conclusions: { currentConservativeNetUsd: null, currentTotalAttackerCapitalUsd: null, routePositive: "unknown", executableNow: "unknown", forkEligible: false, signedActionJustified: false }, safety: { offlineOnly: true, modelImported: false, checkModeWriteFree: true, network: false, rpc: false, inventoryRead: false, envRead: false, fork: false, forkRerun: false, keys: false, signing: false, transactions: false } }; }
function stableSame(a, b) { const x = { ...a }, y = { ...b }; delete x.generatedAt; delete y.generatedAt; same(x, y, "existing-validation"); }
function main() { const args = process.argv.slice(2); if (args.length !== 1 || !["--check", "--write-v3"].includes(args[0])) throw new Error("ARGV_FORBIDDEN_USE_CHECK_OR_WRITE_V3"); const result = validateModel(), expected = record(result); let publication = null; if (args[0] === "--write-v3") publication = publish(VALIDATION_PATH, expected); else if (fs.existsSync(VALIDATION_PATH)) { const bytes = fs.readFileSync(VALIDATION_PATH), existing = JSON.parse(bytes); same(bytes, Buffer.from(`${JSON.stringify(existing, null, 2)}\n`), "validation-canonical"); stableSame(existing, expected); } console.log(JSON.stringify({ status: "PASS", mode: args[0].slice(2), assertions: result.assertions, modelChecks: result.model.checks, counts: result.model.counts, modelSha256: hash(result.bytes), best: result.model.correctedHistoricalEconomics.best, worst: result.model.correctedHistoricalEconomics.worst, routePositive: "unknown", forkEligible: false, wrote: Boolean(publication), publication })); }
module.exports = { validateModel, MODEL_PATH, VALIDATION_PATH, SEMANTIC };
if (require.main === module) { try { main(); } catch (e) { console.error(JSON.stringify({ status: "FAIL", diagnostic: text(e.message || e).slice(0, 500), assertions })); process.exitCode = 1; } }
