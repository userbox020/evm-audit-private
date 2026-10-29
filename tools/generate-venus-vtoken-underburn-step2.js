#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const CAPTURE = path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-capture.json");
const SUMMARY = path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-summary.json");
const REPORT = path.join(ROOT, "reports/critical-venus-vtoken-underburn-step2.md");

if (process.argv.length !== 3 || process.argv[2] !== "--generate") throw new Error("usage: node generate-venus-vtoken-underburn-step2.js --generate");
const r = JSON.parse(fs.readFileSync(CAPTURE, "utf8"));
const bsc = r.chains.find(c => c.chainId === 56);
const core = bsc.core;
const complete = core.markets.filter(m => m.state.exchangeRateCurrentCall !== null);
const top = complete.filter(m => m.economics.perRedemptionGainUpperUsd !== null).sort((a, b) => b.economics.perRedemptionGainUpperUsd - a.economics.perRedemptionGainUpperUsd).slice(0, 10);
const exact = core.markets.filter(m => m.runtime.exactSelectedSourceRuntime);
const blockers = [
  "BNB fixed-pin full-state digests disagreed across the two observed families even though the selected header and terminal rechecks matched",
  `${core.markets.length - complete.length}/${core.markets.length} BNB Core market rows have one or more null current-state fields after bounded calls`,
  `${r.coverage.coreMarketsRuntimeUnknown}/${r.coverage.coreMarketsEnumerated} BNB Core market runtimes are not exact matches to the selected local delegate/direct runtime`,
  `selected Comptroller dispatch addresses do not match the four locally manifested facet addresses`,
  `${r.coverage.isolatedMarketsEnumerated - r.coverage.isolatedExactRuntimeMatches}/${r.coverage.isolatedMarketsEnumerated} isolated market implementations are not exact matches to the selected local VTokenImpl artifact`,
  "opBNB has one observed finalized family; no two-family state agreement is available",
  "ERC20 exact-transfer behavior is unbound; Prime and VAI-vault hooks are nonzero on BNB Core",
  "deployed mint/redeem gas estimates are null because no valid anonymized funded/approved/share-holding account state was available",
  "L1 data fees are not estimated; economics use an attacker-favorable zero lower bound",
];
const summary = {
  schemaVersion: 1,
  generatedAt: r.generatedAt,
  classification: r.classification,
  gates: r.gates,
  coverage: { ...r.coverage, bnbCoreRowsWithCurrentRate: complete.length },
  pins: r.chains.map(c => ({ chain: c.chain, chainId: c.chainId, number: c.pin?.number ?? null, hash: c.pin?.hash ?? null, selectedFinalizedFamilies: c.coverage.selectedFinalizedFamilies, stateDigestAgreement: c.coverage.familyAgreement.stateDigestAgreement, terminalMatch: c.coverage.terminal.allMatch, isolatedPools: c.isolated?.pools?.length ?? 0, isolatedMarkets: c.isolated?.markets?.length ?? 0 })),
  bnbCore: {
    treasuryPercent: core.global.treasuryPercent,
    prime: core.global.prime,
    vaiVaultAddress: core.global.vaiVaultAddress,
    gasPriceWei: core.global.gas.appliedAttackerFavorableGasPriceFloor,
    nativeTokenPriceUsd: core.global.gas.nativeTokenPriceUsd,
    exactRuntimeMarkets: exact.map(m => ({ symbol: m.symbol, vToken: m.vToken, mintPaused: m.state.mintPaused, feasibleBatch: m.economics.feasibleRedemptionsUpperScenario, netUpperUsd: m.economics.maximumSameBlockNetUpperUsd })),
    topCompleteStateScenarios: top.map(m => ({ symbol: m.symbol, vToken: m.vToken, runtimeExact: m.runtime.exactSelectedSourceRuntime, perCallGainUpperRaw: m.economics.attackerFavorablePerRedemptionGainUpperAfterFeeRaw, perCallGainUpperUsd: m.economics.perRedemptionGainUpperUsd, feasibleBatchUpper: m.economics.feasibleRedemptionsUpperScenario, gasUnitsLowerBound: m.economics.gasUnitsLowerBoundAtFeasibleBatch, gasCostLowerBoundUsd: m.economics.gasCostLowerBoundUsd, maximumSameBlockNetUpperUsd: m.economics.maximumSameBlockNetUpperUsd })),
  },
  blockers,
  leakGuard: r.leakGuard,
};
fs.writeFileSync(SUMMARY, `${JSON.stringify(summary, null, 2)}\n`);

const pinRows = summary.pins.map(p => `| ${p.chain} | ${p.chainId} | ${p.number ?? "null"} | \`${p.hash ?? "null"}\` | ${p.selectedFinalizedFamilies} | ${p.stateDigestAgreement === null ? "null" : p.stateDigestAgreement} | ${p.isolatedPools}/${p.isolatedMarkets} |`).join("\n");
const topRows = summary.bnbCore.topCompleteStateScenarios.slice(0, 6).map(m => `| ${m.symbol} | \`${m.vToken}\` | ${m.runtimeExact} | ${m.perCallGainUpperRaw} | ${m.perCallGainUpperUsd?.toExponential(6) ?? "null"} | ${m.feasibleBatchUpper} | ${m.gasCostLowerBoundUsd?.toFixed(6) ?? "null"} | ${m.maximumSameBlockNetUpperUsd?.toFixed(6) ?? "null"} |`).join("\n");
const md = `# 🟡 Venus redeemUnderlying under-burn Step2 — incomplete coverage, bound route negative

## Classification

**INCOMPLETE_COVERAGE_WITH_CURRENT_BOUND_MARKETS_ROUTE_NEGATIVE.** Operational gates remain \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`, and \`fork=false\`.

All eight supported mainnet chains received strict fixed finalized pins and exact terminal number/hash rechecks. The capture enumerated **52 BNB Core markets** and **19 pools / 114 isolated markets**. It does not establish a global current closeout: only one BNB Core market runtime exactly matches the selected local affected runtime, only ${complete.length}/52 Core rows have complete current-rate state, BNB two-family state digests disagree, and most isolated runtimes are not exactly linked to the selected local round-up implementation.

## Finalized pins and market coverage

| Chain | ID | Finalized block | Hash | Families | State agreement | Isolated pools/markets |
| --- | ---: | ---: | --- | ---: | --- | ---: |
${pinRows}

No backend/operator independence is claimed. Family identities, endpoint material, headers, and raw responses are not persisted.

## Version and runtime binding

- BNB Core source at \`f64be6169d1bb29d94d6b4ab1eb517564cb7328d\` floors \`B=floor(A·1e18/R)\` while transferring caller-selected \`A\`.
- Isolated-pools source at \`cdc9185d87a3ebadba527d285210700b4e787c4e\` rounds the vToken burn up when division is inexact (\`VToken.sol:992-995\`), eliminating this under-burn when exact runtime continuity holds.
- Four locally manifested BNB facet address runtimes match their artifacts, but the selected \`actionPaused\` and \`getAllMarkets\` dispatch addresses differ; selected facet continuity is therefore qualified unknown.
- Exact affected runtime: \`vSXP\` only. It is mint-paused with zero feasible batch. The other 51 Core implementations are qualified unknown, not assumed current or legacy.
- Exact isolated round-up runtime: 9/114 markets (zkSync). The other 105 remain deployment-qualified unknown despite matching registry/market APIs.

## Correct economics

For \`B=floor(AO/R)\`, \`O=1e18\`:

- \`0 <= AO/R-B < 1\` raw vToken;
- \`0 <= A-BR/O < R/O\` exact rational underlying;
- \`0 <= A-floor(BR/O) <= ceil(R/O)\` integer underlying.

The runner uses the attacker-favorable fee-adjusted per-call bound \`max(0, ceil(R/O)-floor(A_min·treasuryPercent/O))\`, a 90% finalized block-gas budget, local lower bounds of 88,599 gas for one bulk mint and 34,443 per redemption, protocol-oracle same-pin USD prices, and BNB gas price 50,000,000 wei. L1 data fee is conservatively set to zero, making negative results stronger.

| Market | Address | Runtime exact | Per-call raw upper | Per-call USD upper | Batch upper | Gas USD lower | Same-block net upper USD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
${topRows}

The largest complete-state scenario is ${top[0]?.symbol ?? "null"} at approximately **$${top[0]?.economics.perRedemptionGainUpperUsd?.toFixed(8) ?? "null"} per call**, ${top[0]?.economics.feasibleRedemptionsUpperScenario ?? "null"} redemptions, and **$${top[0]?.economics.maximumSameBlockNetUpperUsd?.toFixed(6) ?? "null"}** maximum net after only the gas lower bound. This row is not runtime-exact and is sensitivity evidence, not operational closure. The sole exact affected runtime, vSXP, is mint-paused and has batch zero.

## Current configuration and precondition failures

- BNB Core is globally unpaused and \`treasuryPercent=0\`.
- Prime and VAI-vault hooks are nonzero, so the Step1 controlled-hook preconditions fail.
- ERC20 exact-transfer semantics and an approval-funded anonymous outsider state are unbound. Native vBNB avoids token approval but its runtime is not exact-linked.
- Supply cap/headroom, cash, stored/current exchange rate, borrows, reserves, reserve-reduction fields, reward speeds, listed state, and mint/redeem pauses are persisted per successful market row; failed reads remain null.
- No valid deployed \`eth_estimateGas\` scenario was available without a funded/approved/share-holding identity. No state mutation, transaction, or exploit call was made.

## Exact blockers

${blockers.map(x => `- ${x}.`).join("\n")}

## Evidence

- Sanitized capture: \`reports/raw/fast/critical-venus-vtoken-underburn-step2-capture.json\`.
- Sanitized summary: \`reports/raw/fast/critical-venus-vtoken-underburn-step2-summary.json\`.
- Capture runner: \`tools/capture-venus-vtoken-underburn-step2.js\`.
- Generator: \`tools/generate-venus-vtoken-underburn-step2.js\`.
- No endpoint URLs/domains/providers, credentials, headers, inventories, raw responses, or private identities are present. No signing, transaction, broadcast, mutation, exploit call, or fork occurred.
`;
fs.writeFileSync(REPORT, md);
console.log(JSON.stringify({ ok: true, classification: summary.classification, summary: rel(SUMMARY), report: rel(REPORT) }));

function rel(file) { return path.relative(ROOT, file).replace(/\\/g, "/"); }
