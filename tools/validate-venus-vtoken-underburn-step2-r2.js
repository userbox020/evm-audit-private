#!/usr/bin/env node
"use strict";
const fs = require("fs"); const path = require("path"); const crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
if (process.argv.length !== 3 || process.argv[2] !== "--check") { console.error("usage: node validate-venus-vtoken-underburn-step2-r2.js --check"); process.exit(2); }
const mp = path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-r2-manifest.json");
const cp = path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-r2-capture.json");
const sp = path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-r2-summary.json");
const rp = path.join(ROOT, "reports/critical-venus-vtoken-underburn-step2-r2.md");
let checks = 0; const fail = []; function c(v, n) { checks++; if (!v) fail.push(n); } function sha(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
let m, r, s; try { m = JSON.parse(fs.readFileSync(mp)); r = JSON.parse(fs.readFileSync(cp)); s = JSON.parse(fs.readFileSync(sp)); } catch (e) { console.error(`parse failed: ${e.message}`); process.exit(1); }
c(m.schemaVersion === 2 && m.findingId === "venus-vtoken-redeem-underburn-step2-r2", "manifest identity");
c(r.classification === "INCOMPLETE_CURRENT_PREHELD_ROUTE_CONDITIONAL_ACQUISITION_AND_NET_UNBOUND", "classification");
c(r.authorization.targetedCaptureCount === 1 && r.authorization.chains.join(",") === "56,324", "capture scope");
c(r.terminal.bnb.match === true && r.terminal.zkSync.match === true, "terminal");
c(r.gates.routePositive === 0 && r.gates.executableNow === 0 && r.gates.signedActionJustified === false && r.gates.fork === false, "gates");
c(r.bnb.markets.length === 52 && r.bnb.markets.filter(x => x.affected === true).length === 8 && r.bnb.markets.filter(x => x.affected === null).length === 44, "core tri-state");
c(r.bnb.markets.filter(x => x.marketType === "unknown").length === 1, "market type unknown");
c(r.bnb.vSXP.state.listed === null, "listed null"); c(r.bnb.vSXP.state.mintPaused === true && r.bnb.vSXP.state.redeemPaused === false && r.bnb.vSXP.state.transferPaused === false, "vSXP pauses");
c(r.bnb.vSXP.routes.freshBulkMint.available === false, "fresh mint block"); c(r.bnb.vSXP.routes.preHeldOneShare.callableIfOneRawShareControlled === true, "preheld callable");
c(r.bnb.vSXP.routes.preHeldOneShare.shareControlObserved === null && r.bnb.vSXP.routes.preHeldMulti.feasibleN === null, "share nulls");
c(r.bnb.vSXP.routes.acquiredShare.aggregateVenueVTokenBalanceRaw === "250" && r.bnb.vSXP.routes.acquiredShare.poolSpecificLiquidity === null && r.bnb.vSXP.routes.acquiredShare.acquisitionCost === null, "acquisition qualification");
c(r.bnb.vSXP.economics.ethGasPriceSensitivityWei === null && r.bnb.vSXP.economics.bestExecutableN === null, "economics null");
c(r.perSurfaceAgreement["bnb.facets"].agreed === 6 && r.perSurfaceAgreement["bnb.facets.runtime"].agreed === 6, "facet agreement");
c(r.perSurfaceAgreement["bnb.market.storage"].agreed === 104 && r.perSurfaceAgreement["bnb.market.runtime"].agreed === 156, "runtime agreement");
c(r.perSurfaceAgreement["bnb.gas"].disagreed === 1, "gas disagreement");
c(r.zkSync.markets.length === 9 && r.zkSync.exactOrNormalizedCeilingMarkets === 9 && r.zkSync.unknownMarkets === 0, "zk runtime");
c(r.zkSync.markets.every(x => x.underburnGainUpperRaw === "0" && x.runtimeAgreement), "zk bound");
c(r.zkSync.markets.every(x => x.state.redeemPaused === false && x.state.transferPaused === false), "zk pauses");
c(Object.values(r.leakGuard).every(x => x === 0), "leak guard"); c(s.captureQualification.targetedCaptureCount === 1 && s.captureQualification.currentGasSensitivity === null, "summary qualification");
c(Array.isArray(m.artifacts) && m.artifacts.length >= 30, "artifact inventory");
for (const a of m.artifacts || []) { const p = path.join(ROOT, a.path.replaceAll("/", path.sep)); c(fs.existsSync(p), `exists ${a.path}`); if (!fs.existsSync(p)) continue; c(sha(p) === a.sha256, `hash ${a.path}`); if (a.text !== false) { const text = fs.readFileSync(p, "utf8"); c(!/https?:\/\//i.test(text), `no url ${a.path}`); c(!text.split(/\r?\n/).some(x => /[ \t]+$/.test(x)), `whitespace ${a.path}`); } }
const aggregate = crypto.createHash("sha256").update(m.artifacts.map(a => `${a.path}:${a.sha256}`).join("\n")).digest("hex"); c(aggregate === m.aggregateSha256, "aggregate");
const report = fs.readFileSync(rp, "utf8"); c(!/full-state/i.test(report), "report family wording"); c(!/net upper|net lower/i.test(report), "report net wording"); c(report.includes("empirical estimates, not floors"), "gas wording"); c(report.includes("Pre-held one raw share"), "route distinction");
if (fail.length) { console.error(`FAIL ${checks - fail.length}/${checks}: ${fail.join("; ")}`); process.exit(1); }
console.log(`PASS ${checks}/${checks} checks; check-only; no files written`);
