#!/usr/bin/env node
"use strict";
const fs = require("fs"); const path = require("path"); const crypto = require("crypto"); const ROOT = path.resolve(__dirname, "..");
if (process.argv.length !== 3 || process.argv[2] !== "--write") throw new Error("usage: node build-venus-vtoken-underburn-step2-r3-manifest.js --write");
const text = [
  "reports/critical-venus-vtoken-underburn-step2-r3.md",
  "reports/raw/fast/critical-venus-vtoken-underburn-step2-r3-capture.json",
  "reports/raw/fast/critical-venus-vtoken-underburn-step2-r3-summary.json",
  "reports/raw/fast/critical-venus-vtoken-underburn-step2-r3-tests.txt",
  "tools/capture-venus-vtoken-underburn-step2-r3.js",
  "tools/generate-venus-vtoken-underburn-step2-r3.js",
  "tools/test-venus-vtoken-underburn-step2-r3.js",
  "tools/validate-venus-vtoken-underburn-step2-r3.js",
  "tools/build-venus-vtoken-underburn-step2-r3-manifest.js",
  "coordination/inbox/critical/20260729-critical-venus-vtoken-underburn-step2-r3.json",
  "coordination/handoffs/20260729-critical-venus-vtoken-underburn-step2-r3-handoff.md",
  "reports/raw/fast/critical-venus-vtoken-nonliquidation-accounting-step1-benchmark-r3.txt"
];
const binary = [
  "tools/shared-rpc.js",
  "reports/raw/fast/pancakeswap-infinity-phase0.json",
  "targets/venus-protocol/package.json",
  "targets/venus-protocol/contracts/Tokens/VTokens/VToken.sol",
  "targets/venus-protocol/contracts/Comptroller/Diamond/facets/PolicyFacet.sol",
  "targets/venus-protocol/contracts/Comptroller/Diamond/facets/RewardFacet.sol",
  "targets/venus-protocol/contracts/Comptroller/Diamond/facets/MarketFacet.sol",
  "targets/venus-protocol/contracts/Comptroller/Diamond/facets/SetterFacet.sol",
  "targets/venus-protocol/deployments/bscmainnet/VBep20Delegate.json",
  "targets/venus-protocol/deployments/bscmainnet/PolicyFacet.json",
  "targets/venus-protocol/deployments/bscmainnet/RewardFacet.json",
  "targets/venus-protocol/deployments/bscmainnet/MarketFacet.json",
  "targets/venus-protocol/deployments/bscmainnet/SetterFacet.json",
  "targets/venus-protocol/deployments/bscmainnet/Prime_Implementation.json",
  "targets/venus-protocol/deployments/bscmainnet/VAIVaultProxy_Implementation.json",
  "targets/venus-protocol/deployments/bscmainnet/SXP.json",
  "targets/venus-protocol/deployments/bscmainnet/vSXP.json"
];
const sha = p => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, p.replaceAll("/", path.sep)))).digest("hex");
const artifacts = [...text.map(p => ({ path: p, sha256: sha(p) })), ...binary.map(p => ({ path: p, sha256: sha(p), text: false }))];
const aggregateSha256 = crypto.createHash("sha256").update(artifacts.map(a => `${a.path}:${a.sha256}`).join("\n")).digest("hex");
const out = { schemaVersion: 3, findingId: "venus-vtoken-redeem-underburn-step2-r3", classification: "INCOMPLETE_CURRENT_PREHELD_VSXP_NOMINAL_ROUTE_CONDITIONAL_ACQUISITION_DELIVERY_AND_ECONOMICS_UNBOUND", routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, artifacts, aggregateSha256 };
fs.writeFileSync(path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-r3-manifest.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, artifacts: artifacts.length, aggregateSha256 }));
