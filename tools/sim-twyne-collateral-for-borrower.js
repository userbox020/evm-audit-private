#!/usr/bin/env node
"Use strict";

// Twyne `collateralForBorrower` rounding simulator.
// Source authority: targets/twyne-contracts-v1/src/twyne/CollateralVaultBase.sol:586-614
//
// Honest goal: verify the rounding-boundary class in Twyne's intermediate-regime case 3.
// We replicate Twyne's exact math (solidity-default / rounding), compare against
// Math.ceilDiv-aware versions, and report absDiff by configuration.
//
// All math in BigInt; no Number, no floats anywhere except display formatting at the end.

const fs = require("node:fs");
const path = require("node:path");

const MAXFACTOR = 10n ** 4n;
const ONE_E8 = 10n ** 8n;

// ceilDiv replicating OZ Math.ceilDiv: (a, b) => b == 0 ? 0 : a / b + (a % b == 0 ? 0n : 1n)
function ceilDiv(a, b) {
  if (b === 0n) return 0n;
  const q = a / b;
  const r = a % b;
  return q + (r === 0n ? 0n : 1n);
}

// Math.floorDiv: (a, b) => a / b  (solidity default for positive a, b)
function floorDiv(a, b) {
  if (b === 0n) return 0n;
  const aAbs = a < 0n ? -a : a;
  const bAbs = b < 0n ? -b : b;
  const q = aAbs / bAbs;
  return a < 0n !== b < 0n ? -q : q;
}

// Twyne's collateralForBorrower Case 3 (the rounding-class candidate).
// Mimics solidity: MAXFACTOR = 1e4; buffer * extLiqLTV = 1e8.
function collateralForBorrowerTwync(B, C, buffer, maxLTV_t, extLiqLTV) {
  const liqLTV_e = BigInt(buffer) * BigInt(extLiqLTV); // 1e8 precision
  const m = MAXFACTOR * B;
  const t = BigInt(maxLTV_t) * C;
  if (m >= t) return { case: 1, formulaResult: 0n, idealResult: 0n };
  if (ONE_E8 * B <= liqLTV_e * C) return { case: 2, formulaResult: C - B, idealResult: C - B };
  // Case 3: intermediate
  const numeratorTwync = (ONE_E8 - liqLTV_e) * (t - m);
  const denomTwync = MAXFACTOR * (MAXFACTOR * BigInt(maxLTV_t) - liqLTV_e);
  // floor toward zero (solidity behavior for positive numerator/denominator)
  const formulaResult = floorDiv(numeratorTwync, denomTwync);
  // "Ideal" = conservative vault-side: every division uses ceilDiv
  const numeratorIdeal = ceilDiv((ONE_E8 - liqLTV_e) * (t - m), 1n); // (a*b) numerator -> idealized w/ no floor error on multiplication
  const idealIntermediate = ceilDiv((ONE_E8 - liqLTV_e) * (t - m), MAXFACTOR);
  const idealResult = ceilDiv(ceilDiv(numeratorIdeal, MAXFACTOR * BigInt(maxLTV_t) - liqLTV_e), 1n); // placeholder
  // Honest ideal: Math.ceilDiv(num, denom)
  const idealResultClean = ceilDiv(numeratorTwync, denomTwync);
  return { case: 3, formulaResult, idealResult: idealResultClean, denomTwync };
}

function bpsFormat(x) {
  // Return a fixed string in 1e18-precision "human" format using BigInt
  return x.toString();
}

function main() {
  const out = [];
  const buffers = [8000n, 8500n, 9000n, 9500n];
  const extLiqLTVs = [8000n, 8500n, 9000n, 9500n];
  const maxLTVts = [7000n, 7500n, 8000n, 8500n, 9000n];
  const br_over_cs = [0.65, 0.66, 0.67, 0.68, 0.69, 0.70, 0.71, 0.72, 0.73, 0.74, 0.75];
  const totalAssetsList = [10n ** 6n, 10n ** 12n, 10n ** 18n, 10n ** 21n, 10n ** 24n, 10n ** 27n];

  for (const buffer of buffers) {
    for (const extLiqLTV of extLiqLTVs) {
      for (const maxLTV_t of maxLTVts) {
        const liqLTV_e = buffer * extLiqLTV; // 1e8
        for (const totalAssets of totalAssetsList) {
          for (const br_over_c of br_over_cs) {
            // Scale: B+C = totalAssets (1e18 precision).
            const sumBC = totalAssets;
            const B = (sumBC * BigInt(Math.floor(br_over_c * 1e6))) / BigInt(Math.floor((1 + br_over_c) * 1e6));
            const C = sumBC - B;
            const r = collateralForBorrowerTwync(B, C, buffer, maxLTV_t, extLiqLTV);
            const absDiff = (r.formulaResult > r.idealResult) ? r.formulaResult - r.idealResult : r.idealResult - r.formulaResult;
            const denomTwync = r.denomTwync !== undefined ? r.denomTwync.toString() : "n/a";
            out.push({
              buffer: buffer.toString(),
              extLiqLTV: extLiqLTV.toString(),
              maxLTV_t: maxLTV_t.toString(),
              br_over_c: br_over_c.toFixed(2),
              totalAssets: totalAssets.toString(),
              regimeCase: "case" + r.case + (r.case === 3 ? "_intermediate" : (r.case === 2 ? "_healthy" : "_severely_unhealthy")),
              formulaResult: r.formulaResult.toString(),
              idealResult: r.idealResult.toString(),
              absDiff: absDiff.toString(),
              diffPctOfBorrowAmount: B === 0n ? "0" : ((absDiff * 10000n) / B).toString(),
              denom: denomTwync,
            });
          }
        }
      }
    }
  }

  out.sort((a, b) => {
    const ad = BigInt(a.absDiff);
    const bd = BigInt(b.absDiff);
    if (ad === bd) return 0;
    return bd > ad ? 1 : -1;
  });

  const case3 = out.filter(x => x.regimeCase.startsWith("case3_"));
  const above1bps = out.filter(x => BigInt(x.diffPctOfBorrowAmount) > 0n && BigInt(x.diffPctOfBorrowAmount) < 100n);
  const above10bps = out.filter(x => BigInt(x.diffPctOfBorrowAmount) >= 100n && BigInt(x.diffPctOfBorrowAmount) < 1000n);
  const above100bps = out.filter(x => BigInt(x.diffPctOfBorrowAmount) >= 1000n);

  const summary = {
    version: "A06-stage3-simulator/v1",
    generatedAt: new Date().toISOString(),
    totalRows: out.length,
    case3Rows: case3.length,
    maxAbsDiff: out[0].absDiff,
    meanAbsDiff: out.reduce((acc, x) => acc + BigInt(x.absDiff), 0n) / BigInt(out.length),
    countAbove1bps: above1bps.length,
    countAbove10bps: above10bps.length,
    countAbove100bps: above100bps.length,
    worstCase3Row: case3[0] || null,
    note: "case 1 (severely_unhealthy) returns formulaResult=0 by construction. case 2 (healthy) returns formulaResult=C-B which equals ideal. The rounding class is ONLY in case 3. The 'idealResult' is Math.ceilDiv(num, denom), the 'formulaResult' is the solidity floor. absDiff=abs(formula-ideal)."
  };

  const result = { summary, rows: out };

  const outDir = path.resolve(__dirname, "..", "reports", "raw", "fast", "novelty-rerank-20261017");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "twyne-rounding-sim-results.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`Wrote ${out.length} rows to ${outPath}`);
  console.log(`case3 rows: ${case3.length}, maxAbsDiff: ${summary.maxAbsDiff}, worstCase3Row.absDiff: ${case3[0] ? case3[0].absDiff : "n/a"}`);
}

if (require.main === module) main();
