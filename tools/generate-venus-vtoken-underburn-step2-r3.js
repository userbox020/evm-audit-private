#!/usr/bin/env node
"use strict";
const fs = require("fs"); const path = require("path"); const ROOT = path.resolve(__dirname, "..");
const CAP = path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-r3-capture.json");
const SUM = path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-r3-summary.json");
const REP = path.join(ROOT, "reports/critical-venus-vtoken-underburn-step2-r3.md");
if (process.argv.length !== 3 || process.argv[2] !== "--generate") throw new Error("usage: node generate-venus-vtoken-underburn-step2-r3.js --generate");
const r = JSON.parse(fs.readFileSync(CAP)); const v = r.vSXP;
const summary = {
  schemaVersion: 3, generatedAt: r.generatedAt, classification: r.classification, gates: r.gates, authorization: r.authorization, targetedPolicyFix: r.targetedPolicyFix, postCaptureOfflineDerivation: r.postCaptureOfflineDerivation, pin: r.pin, terminal: r.terminal,
  counts: { coreMarkets: r.runtimeInventory.allCoreMarkets, exactFloorMarkets: r.runtimeInventory.exactOrNormalizedFloor, affectedNull: r.runtimeInventory.affectedNull, analyzedExactRows: r.exactFloorMarkets.length, completePolicyRows: r.exactFloorMarkets.filter(x => x.policy.redeemAllowed === true && x.policy.redeemVerifyCallSuccess === true).length, insufficientCashRows: r.exactFloorMarkets.filter(x => x.blockerRow.includes("INSUFFICIENT_CASH_FOR_ONE_SHARE")).length, nominalDeliveryRows: r.exactFloorMarkets.filter(x => x.blockerRow.includes("DELIVERY_EXACT_SEMANTICS_UNBOUND")).length },
  vSXP: { listed: v.state.listed, pauses: { mint: v.state.mintPaused, redeem: v.state.redeemPaused, transfer: v.state.transferPaused }, policy: v.productionPolicy, transferPolicy: v.acquisition.transferPolicy, delivery: v.delivery, acquisition: v.acquisition, arithmetic: v.correctedArithmetic, economics: v.economics },
  eightMarkets: r.exactFloorMarkets.map(x => ({ symbol: x.symbol, vToken: x.vToken, listed: x.state.listed, mintPaused: x.state.mintPaused, redeemPaused: x.state.redeemPaused, transferPaused: x.state.transferPaused, exchangeRateCurrent: x.state.exchangeRateCurrent, internalCash: x.state.internalCash, physicalUnderlying: x.delivery.physicalUnderlyingBalance, marketType: x.delivery.marketType, redeemAllowed: x.policy.redeemAllowed, redeemVerify: x.policy.redeemVerifyCallSuccess, redeemVerifyTestedArguments: x.policy.redeemVerifyTestedArguments, burnRawVTokens: x.arithmetic.burnRawVTokens, ceilBoundRaw: x.arithmetic.conservativeCeilGainBoundRaw, selectedExcessRaw: x.arithmetic.selectedIntegerExcessRaw, blockers: x.blockerRow })),
  facets: r.facets, perSurfaceAgreement: r.perSurfaceAgreement, blockers: r.blockers, leakGuard: r.leakGuard,
};
fs.writeFileSync(SUM, `${JSON.stringify(summary, null, 2)}\n`);
const rows = summary.eightMarkets.map(x => `| ${x.symbol} | ${x.listed} | ${x.mintPaused}/${x.redeemPaused}/${x.transferPaused} | ${x.internalCash} | ${x.physicalUnderlying} | ${x.redeemAllowed}/${x.redeemVerify} | ${x.redeemVerifyTestedArguments.underlyingAmountRaw}/${x.redeemVerifyTestedArguments.vTokenAmountRaw} | ${x.ceilBoundRaw} | ${x.selectedExcessRaw} | ${x.blockers.join(", ")} |`).join("\n");
const facets = summary.facets.map(x => `| ${x.name} | \`${x.dispatch}\` | ${x.runtimeAgreement} | ${x.localMatch?.artifact ?? "unknown"} |`).join("\n");
const md = `# 🟠 WATCH — Venus redeemUnderlying under-burn Step2 R3 nominal pre-held vSXP route conditional

## Classification

**INCOMPLETE_CURRENT_PREHELD_VSXP_NOMINAL_ROUTE_CONDITIONAL_ACQUISITION_DELIVERY_AND_ECONOMICS_UNBOUND.** Gates: \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`, \`fork=false\`.

The BNB evidence binds finalized pin \`${r.pin.number}\` / \`${r.pin.hash}\` across two observed families with a matching terminal recheck. One initial read-only attempt completed reads but failed before persistence on BigInt serialization; it produced no artifact. The corrected full capture followed. The first targeted policy-only pass persisted 0/8 agreement because one selected family failed the calls. A capability-qualified retry then made exactly the eight required two-family \`redeemVerify\` observations at the retained pin and changed no other state evidence. No backend independence is claimed.

After capture, blocker rows only were deterministically derived offline from the persisted selected amounts, cash, and delivery qualification. The runner was corrected to reproduce those rows; this step made zero network reads and did not alter observed state.

## vSXP status

- Listed: **${v.state.listed}**.
- Mint/redeem/transfer paused: **${v.state.mintPaused}/${v.state.redeemPaused}/${v.state.transferPaused}**.
- Exact floor runtime and implementation code agree across families.
- \`redeemAllowed(vSXP, outsider, 1)\` from the production vSXP caller context returns zero.
- \`redeemVerify(vSXP, outsider, 403423694, 1)\` from the production vSXP caller context succeeds, including the retained-pin Prime hook path. Exact tested arguments are persisted.
- \`transferAllowed(vSXP, sharedVault, outsider, 1)\` from the vSXP caller context returns zero. This is policy acceptance, not proof that the outsider can cause the shared vault to transfer.

Current SXP physical balance at vSXP equals internal cash at \`${v.delivery.internalCash}\`. SXP is a direct runtime under standard proxy slots, its ABI returns bool for transfer, and a one-raw transfer eth_call from vSXP returns true. The local artifact lacks deployed runtime/source metadata; fee, blacklist, pause, and exact recipient-delta semantics remain unbound. Delivery is therefore **nominal-only**.

## Acquisition

The two Infinity initialization rows are treated only as historical venue discovery.

- vSXP/SXP: current agreed slot state exists, current liquidity is **0**.
- vSXP/USDT: current agreed slot state exists, reported liquidity is **774,025,471**.
- Neither venue has an agreed executable one-raw-vSXP quote or proof that an outsider can acquire one raw share.
- The shared vault's 250 raw vSXP is nonwithdrawable/unattributed absent an exact public withdrawal route. A source-self transfer simulation succeeds, but outsider triggerability is null.

Acquisition remains **UNBOUND**.

## Corrected arithmetic

At current vSXP rate \`${v.state.exchangeRateCurrent}\`:

- burn: **1 raw vSXP**;
- selected underlying amount: \`${v.arithmetic.redeemAmountRaw}\` raw SXP;
- conservative integer bound \`ceil(R/1e18)\`: **201,711,848 raw SXP**;
- selected integer excess \`A-floor(R/1e18)\`: **201,711,847 raw SXP**.

## Eight exact floor-runtime markets

Pause columns are mint/redeem/transfer. All eight are listed, mint-paused, redeem-unpaused, transfer-unpaused, and policy-accepted. Delivery semantics remain nominal. vTUSDOLD additionally has no cash for the selected one-share amount.

| Market | Listed | Pauses | Internal cash | Physical | Policy allow/verify | Verify underlying/vToken | Ceil bound | Selected excess | Blockers |
| --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | --- |
${rows}

Counts: Core markets 52; exact/normalized floor 8; affected null 44; policy-complete exact rows 8; insufficient-cash rows 1; nominal-delivery rows 8.

## Facets and family agreement

| Selector path | Dispatch | Runtime agreement | Local artifact match |
| --- | --- | --- | --- |
${facets}

All seven route dispatch/runtime observations agree across families. None match the retained local facet artifacts, so exact facet source identity remains unknown. Storage, runtime, state, pause, policy, token-balance, and venue probes are separately counted in the raw evidence.

## Economics

Acquisition, exact delivery, realizable SXP value, and an inclusion gas price are not jointly bound. Gas observations disagree across families and remain sensitivity-only. Best executable \`n\` and current net are null. No fork is justified.

## Evidence

- Capture: \`reports/raw/fast/critical-venus-vtoken-underburn-step2-r3-capture.json\`
- Summary: \`reports/raw/fast/critical-venus-vtoken-underburn-step2-r3-summary.json\`
- Runner: \`tools/capture-venus-vtoken-underburn-step2-r3.js\`
- No endpoint material, raw responses, private identities, signing, transactions, mutation, broadcast, or fork were persisted or used.
`;
fs.writeFileSync(REP, md);
console.log(JSON.stringify({ ok: true, classification: summary.classification, report: path.relative(ROOT, REP).replace(/\\/g, "/") }));
