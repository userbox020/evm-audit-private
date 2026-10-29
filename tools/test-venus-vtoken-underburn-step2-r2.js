#!/usr/bin/env node
"use strict";
const fs = require("fs"); const path = require("path");
const ROOT = path.resolve(__dirname, ".."); let passed = 0;
function t(v, n) { if (!v) throw new Error(n); passed++; }
function tri(v) { return v === null ? null : BigInt(v); }
function optimize(gain, perGas, fixedGas, maxN) { if ([gain, perGas, fixedGas, maxN].some(x => x === null)) return null; let best = null; for (let n = 1; n <= maxN; n++) { const score = BigInt(n) * gain - (fixedGas + BigInt(n) * perGas); if (!best || score > best.score) best = { n, score }; } return best; }
t(tri(null) === null, "null bigint"); t(tri("0") === 0n, "explicit zero");
t(optimize(null, 1n, 1n, 10) === null, "null optimization"); t(optimize(1n, 2n, 3n, 8).n === 1, "negative optimum n1"); t(optimize(10n, 2n, 3n, 8).n === 8, "positive optimum max");
for (let i = 1n; i <= 512n; i++) { const R = i * 123457n + 1n; const A = i * 7919n + 3n; const O = 10n ** 18n; const B = A * O / R; t(A * O - B * R < R, `bound ${i}`); }
const cap = JSON.parse(fs.readFileSync(path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-r2-capture.json")));
const sum = JSON.parse(fs.readFileSync(path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-r2-summary.json")));
const report = fs.readFileSync(path.join(ROOT, "reports/critical-venus-vtoken-underburn-step2-r2.md"), "utf8");
t(cap.authorization.targetedCaptureCount === 1, "one capture"); t(cap.pins.bnb && cap.pins.zkSync, "pins"); t(cap.terminal.bnb.match && cap.terminal.zkSync.match, "terminal");
t(cap.bnb.markets.length === 52 && cap.bnb.markets.filter(x => x.affected === null).length === 44, "runtime tristate");
t(cap.bnb.markets.filter(x => x.marketType === "unknown").length === 1, "market type tristate");
t(cap.bnb.vSXP.state.listed === null, "listed null"); t(cap.bnb.vSXP.routes.freshBulkMint.available === false, "mint paused fresh");
t(cap.bnb.vSXP.routes.preHeldOneShare.callableIfOneRawShareControlled === true, "preheld distinction"); t(cap.bnb.vSXP.routes.preHeldMulti.feasibleN === null, "multi null");
t(cap.bnb.vSXP.routes.acquiredShare.poolSpecificLiquidity === null && cap.bnb.vSXP.routes.acquiredShare.acquisitionCost === null, "acquisition null");
t(cap.bnb.vSXP.economics.bestExecutableN === null && cap.bnb.vSXP.economics.ethGasPriceSensitivityWei === null, "economic nulls");
t(cap.perSurfaceAgreement["bnb.market.storage"].agreed === 104, "bnb storage agreement"); t(cap.perSurfaceAgreement["bnb.market.runtime"].agreed === 156, "bnb runtime agreement");
t(cap.perSurfaceAgreement["bnb.gas"].disagreed === 1, "gas disagreement");
t(cap.zkSync.markets.length === 9 && cap.zkSync.markets.every(x => x.affected === false && x.underburnGainUpperRaw === "0"), "zk ceiling");
t(cap.zkSync.markets.every(x => x.runtimeAgreement), "zk runtime agreement"); t(cap.zkSync.markets.every(x => x.state.redeemPaused === false && x.state.transferPaused === false), "zk pauses");
t(Object.values(cap.leakGuard).every(x => x === 0), "leak guard"); t(sum.captureQualification.bestExecutableN === null, "summary null");
t(!/full-state/i.test(report), "no full-state wording"); t(!/net upper|net lower/i.test(report), "no net bound wording");
t(report.includes("empirical estimates, not floors"), "gas qualification"); t(report.includes("Batch-zero has zero cost"), "batch zero wording");
for (const p of ["reports/raw/fast/critical-venus-vtoken-underburn-step2-r2-capture.json", "reports/raw/fast/critical-venus-vtoken-underburn-step2-r2-summary.json", "reports/critical-venus-vtoken-underburn-step2-r2.md"]) {
  const text = fs.readFileSync(path.join(ROOT, p), "utf8"); t(!/https?:\/\//i.test(text), `no url ${p}`);
}
console.log(`PASS ${passed}/${passed} R2 offline fixtures; 512 formula cases; no files written`);
