#!/usr/bin/env node
"use strict";
const fs = require("fs"); const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const CAP = path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-r2-capture.json");
const SUM = path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-r2-summary.json");
const REP = path.join(ROOT, "reports/critical-venus-vtoken-underburn-step2-r2.md");
if (process.argv.length !== 3 || process.argv[2] !== "--generate") throw new Error("usage: node generate-venus-vtoken-underburn-step2-r2.js --generate");
const r = JSON.parse(fs.readFileSync(CAP, "utf8")); const v = r.bnb.vSXP; const zk = r.zkSync;
const summary = {
  schemaVersion: 2, generatedAt: r.generatedAt, classification: r.classification, gates: r.gates, pins: r.pins, terminal: r.terminal,
  correctedCounts: { bnbCoreMarkets: r.bnb.markets.length, bnbFloorRuntimeExactOrNormalized: r.bnb.markets.filter(x => x.affected === true).length, bnbRuntimeUnknown: r.bnb.markets.filter(x => x.affected === null).length, bnbMarketTypeUnknown: r.bnb.markets.filter(x => x.marketType === "unknown").length, zkCeilingRuntimeExactOrNormalized: zk.exactOrNormalizedCeilingMarkets, zkRuntimeUnknown: zk.unknownMarkets },
  vSXP: { affected: v.affected, listed: v.state.listed, mintPaused: v.state.mintPaused, redeemPaused: v.state.redeemPaused, transferPaused: v.state.transferPaused, totalSupply: v.state.totalSupply, internalCash: v.state.internalCash, exchangeRateCurrent: v.state.exchangeRateCurrent, preHeldOneShare: v.routes.preHeldOneShare, freshBulkMint: v.routes.freshBulkMint, acquiredShare: v.routes.acquiredShare, hooks: v.hooks, economics: v.economics },
  facets: r.bnb.facets, perSurfaceAgreement: r.perSurfaceAgreement,
  zkSync: { marketCount: zk.markets.length, exactCeilingCount: zk.exactOrNormalizedCeilingMarkets, unknownCount: zk.unknownMarkets, mintPausedCount: zk.markets.filter(x => x.state.mintPaused === true).length, redeemPausedCount: zk.markets.filter(x => x.state.redeemPaused === true).length, transferPausedCount: zk.markets.filter(x => x.state.transferPaused === true).length, commonImplementation: [...new Set(zk.markets.map(x => x.implementation))], implementationCodeHashes: [...new Set(zk.markets.map(x => x.implementationCodeHash))] },
  captureQualification: { targetedCaptureCount: 1, rpcCalls: r.budgets.rpcCalls, gasFamilyAgreement: r.perSurfaceAgreement["bnb.gas"], currentGasSensitivity: null, bestExecutableN: null, instrumentationCaveat: "vSXP direct listed field is null because the retained runner addressed markets(vSXP) to vSXP rather than Comptroller; policyAllowed=true independently binds redemption policy acceptance, but the field remains null" },
  blockers: r.blockers,
  leakGuard: r.leakGuard,
};
fs.writeFileSync(SUM, `${JSON.stringify(summary, null, 2)}\n`);
const facetRows = summary.facets.map(x => `| ${x.name} | \`${x.selector}\` | \`${x.dispatch}\` | \`${x.runtimeCodeHash}\` | ${x.localMatch ? x.localMatch.artifact : "unknown"} |`).join("\n");
const md = `# 🟡 Venus redeemUnderlying under-burn Step2 R2 — current pre-held route conditional

## Classification

**INCOMPLETE_CURRENT_PREHELD_ROUTE_CONDITIONAL_ACQUISITION_AND_NET_UNBOUND.** Literal gates: \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`, \`fork=false\`.

The R2 capture corrects the prior false closure from mint pause. Mint pause blocks only a fresh bulk mint. At BNB finalized pin \`${r.pins.bnb.number}\` / \`${r.pins.bnb.hash}\`, vSXP redemption and transfer are unpaused, the floor-rounding implementation is exact, outsider policy returns allowed for one raw share, and cash exceeds the selected redemption. Therefore a caller already controlling one raw vSXP can reach the under-burn path. Share control, acquisition cost, realizable exit, and current net remain unbound.

## Targeted capture

| Chain | Finalized pin | Hash | Families | Terminal |
| --- | ---: | --- | ---: | --- |
| BNB | ${r.pins.bnb.number} | \`${r.pins.bnb.hash}\` | 2 | ${r.terminal.bnb.match} |
| zkSync | ${r.pins.zkSync.number} | \`${r.pins.zkSync.hash}\` | 2 | ${r.terminal.zkSync.match} |

Exactly one targeted capture occurred, using ${r.budgets.rpcCalls} bounded calls. No backend independence is claimed. Only two-family-equal values are persisted; disagreement or failed reads remain null.

## Tri-state corrections

- BNB Core markets: 52. Exact/normalized affected floor runtime: **${summary.correctedCounts.bnbFloorRuntimeExactOrNormalized}**; runtime affected state null: **${summary.correctedCounts.bnbRuntimeUnknown}**.
- Market type unknown: **${summary.correctedCounts.bnbMarketTypeUnknown}**. A failed \`underlying()\` read is never converted to native.
- Null rate/cap/headroom/feasibility/batch inputs remain null. No zero coercion is used.
- vSXP direct \`listed\` is null because of a retained runner addressing defect. The independently agreed policy call returned allowed, but the direct field is not backfilled.

## vSXP route split

| Route | Current status |
| --- | --- |
| No action | Available; n=0, cost=0, gain=0 |
| Fresh bulk mint | Blocked by mint pause |
| Pre-held one raw share | Conditional callable: affected runtime, redemption unpaused, policy allowed, cash sufficient |
| Pre-held multi-share | Share count and feasible n null |
| Acquired share | Transfer unpaused; two initialized local venue records and aggregate venue balance 250 raw vSXP observed; pool-specific liquidity, quote, and acquisition cost null |

Current vSXP state: total supply \`${v.state.totalSupply}\`, internal cash \`${v.state.internalCash}\`, current rate \`${v.state.exchangeRateCurrent}\`. One raw share selects \`${v.routes.preHeldOneShare.redeemAmountRaw}\` raw underlying and has an attacker-favorable accounting under-burn bound of \`${v.routes.preHeldOneShare.accountingGainUpperRaw}\` raw. The protocol-oracle mark is approximately \`${v.routes.preHeldOneShare.accountingMarkUsd}\` USD, explicitly not a realizable exit value.

## Facet and hook agreement

| Function | Selector | Agreed dispatch | Runtime hash | Local artifact match |
| --- | --- | --- | --- | --- |
${facetRows}

All six dispatch and runtime observations agree across the two families. The dispatch runtimes do not match the retained local facet artifacts, so source identity remains qualified unknown. Prime and VAI-vault addresses agree. A Prime hook eth_call from the Comptroller context succeeds for an anonymous outsider. Exact current VAI-vault reward-release triggering remains null.

## zkSync result

All **9/9** manifested markets agree across two families on beacon storage, implementation, proxy/runtime code, registry membership, exchange rate, and mint/redeem/transfer pause state. All exactly match the local ceiling-corrected VToken implementation, so the Step1 under-burn bound is **zero** for all nine. Four are mint-paused; none are redeem- or transfer-paused.

## Economics qualification

- \`eth_gasPrice\` disagreed between families and is null.
- Local Step1 gas figures are empirical estimates, not floors.
- Current best executable \`n>=1\` is null because share control/acquisition cost, pool liquidity, gas inclusion price, and realizable exit are unbound.
- Batch-zero has zero cost and is not used as a route estimate.
- No current net conclusion is made.

## Evidence

- Capture: \`reports/raw/fast/critical-venus-vtoken-underburn-step2-r2-capture.json\`
- Summary: \`reports/raw/fast/critical-venus-vtoken-underburn-step2-r2-summary.json\`
- Runner: \`tools/capture-venus-vtoken-underburn-step2-r2.js\`
- No endpoint material, raw responses, private identities, signing, transaction, mutation, broadcast, or fork were persisted or used.
`;
fs.writeFileSync(REP, md);
console.log(JSON.stringify({ ok: true, classification: summary.classification, report: path.relative(ROOT, REP).replace(/\\/g, "/") }));
