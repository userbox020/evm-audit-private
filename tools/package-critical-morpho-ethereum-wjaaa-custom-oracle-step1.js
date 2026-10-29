#!/usr/bin/env node
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.resolve(__dirname, ".."), abs = (x) => path.join(ROOT, ...x.split("/")), sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const P = {
  raw: "reports/raw/fast/critical-morpho-ethereum-wjaaa-custom-oracle-step1.json",
  source: "reports/raw/fast/critical-morpho-ethereum-wjaaa-custom-oracle-step1-sources.json",
  venue: "reports/raw/fast/critical-morpho-ethereum-wjaaa-venue-supplement.json",
  tests: "reports/raw/fast/critical-morpho-ethereum-wjaaa-custom-oracle-step1-tests.json",
  leak: "reports/raw/fast/critical-morpho-ethereum-wjaaa-custom-oracle-step1-leak-scan.json",
  manifest: "reports/raw/fast/critical-morpho-ethereum-wjaaa-custom-oracle-step1-manifest.json",
  report: "reports/critical-morpho-ethereum-wjaaa-custom-oracle-step1.md",
  inbox: "coordination/inbox/critical/2026-07-26-critical-morpho-ethereum-wjaaa-custom-oracle-step1.json",
  handoff: "coordination/handoffs/2026-07-26-critical-morpho-ethereum-wjaaa-custom-oracle-step1-handoff.md"
};
const TOOLS = ["tools/run-critical-morpho-ethereum-wjaaa-custom-oracle-step1.js", "tools/run-critical-morpho-ethereum-wjaaa-venue-supplement.js", "tools/package-critical-morpho-ethereum-wjaaa-custom-oracle-step1.js", "tools/validate-critical-morpho-ethereum-wjaaa-custom-oracle-step1.js"];
const load = (x) => JSON.parse(fs.readFileSync(abs(x), "utf8"));
const write = (x, value) => { fs.mkdirSync(path.dirname(abs(x)), { recursive: true }); fs.writeFileSync(abs(x), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`); };
const bind = (file) => { const body = fs.readFileSync(abs(file)); return { file, bytes: body.length, sha256: sha(body) }; };

function correct(raw, source, venue) {
  source.publicExplorerSources[0].build = { compiler: "v0.8.34+commit.80d5c536", optimizerEnabled: true, optimizerRuns: 200, evmVersion: "prague", exactLocalRecompile: false, binding: "public-verified source at implementation plus fresh fixed-pin runtime" };
  source.publicExplorerSources[1].build = { compiler: "v0.8.26+commit.8a97fa7a", optimizerEnabled: true, optimizerRuns: 500, evmVersion: "cancun", exactLocalRecompile: false, binding: "public-verified source at direct deployment plus fresh fixed-pin runtime" };
  write(P.source, source);
  raw.revision = "offline-wrapper-semantics-and-canonical-venue-correction-r2";
  Object.assign(raw.wrapper, {
    mintRedeemModel: "permissionless 1:1 self-wrap/self-unwrap; third-party mint requires issuer role and third-party burn requires allowance; not ERC4626",
    permissionlessSelfWrapUnwrap: true, publicUnderlyingUnwrapPresent: true, publicUsdcRedemptionPresent: false,
    donationEffect: "Direct JAAA donation creates trapped surplus only; one burned wJAAA releases one JAAA and the oracle does not read wrapper backing."
  });
  delete raw.wrapper.publicRedeemPresent;
  raw.venues.wrapperZeroBalanceSelfPathSimulation = { selfMintWithoutUnderlyingOrAllowance: raw.venues.wrapperPermissionBoundary?.unauthorizedMint || raw.venues.wrapperZeroBalanceSelfPathSimulation?.selfMintWithoutUnderlyingOrAllowance, selfBurnWithoutWrapperBalance: raw.venues.wrapperPermissionBoundary?.unauthorizedBurn || raw.venues.wrapperZeroBalanceSelfPathSimulation?.selfBurnWithoutWrapperBalance };
  delete raw.venues.wrapperPermissionBoundary;
  raw.venues.canonicalAsyncVaultAtSamePin = { artifact: P.venue, sha256: bind(P.venue).sha256, pricing: venue.pricing, reachability: venue.reachability, sourceIdentity: venue.sourceIdentity, archiveFamilies: venue.archiveFamilies, crossFamilyAgreement: venue.crossFamilyAgreement };
  raw.oracle.updateAuthorization = venue.oracleUpdateAuthorization;
  raw.venues.acquisitionQuote = venue.pricing.acquisitionReferenceJaaaRaw; raw.venues.redemptionQuote = venue.pricing.redeemReferenceUsdcRaw;
  raw.manipulationAssessment = {
    permissionlessOracleManipulationEdge: false, exactDexInfluence: false, wrapperDonationInfluence: false,
    permissionlessUnauthenticatedNavUpdate: false, permissionlessValidSignedReportRelayMayExist: true, permissionlessSelfWrapUnwrap: true,
    permissionlessUsdcAcquisitionAndExitForFreshUser: false, routePositive: 0, executableNow: 0, signedActionJustified: false,
    forkGateMet: false, forkCreated: false, exactEconomics: null,
    stopReason: "Chronicle NAV is signed/storage-backed, self-wrap/unwrap is fixed 1:1, the same-pin JAAA/USDC vault rejects a fresh user with all immediate maxima zero, and no canonical DEX pool exists."
  };
  raw.sourceEvidence = bind(P.source); raw.canonicalVenueEvidence = bind(P.venue); raw.packagingSafety = { networkRequests: 0, fork: false, signing: false, mutation: false };
  write(P.raw, raw); return raw;
}

function runTests(raw, source, venue) {
  const c = [
    ["ethereum", raw.scopeCorrection.chainId === 1 && raw.scopeCorrection.falseBaseAssumptionCorrected],
    ["pin", raw.pin.finalizedSelected && raw.pin.passed && raw.pin.terminalRecheck.every((x) => x.sameHash && x.finalizedAtOrAbove)],
    ["id", raw.market.idMatches && raw.market.recomputedId === raw.market.id], ["lltv", raw.market.lltv === "980000000000000000"],
    ["liquidity", BigInt(raw.market.availableLiquidityRaw) === BigInt(raw.market.expectedAtPin.totalSupplyAssets) - BigInt(raw.market.expectedAtPin.totalBorrowAssets)],
    ["history", raw.history.familyCount === 2 && raw.history.crossFamilyAgreement], ["trace", raw.oracle.callGraphFamilyCount === 2 && raw.oracle.callGraphCrossFamilyAgreement],
    ["storage", raw.oracle.traces.every((x) => x.prestateAvailable && x.touchedStorage.some((y) => y.storageSlotCount > 0))], ["no-dex-call", raw.oracle.noDexCalleesObserved],
    ["runtime", source.freshRuntimeBindings.oracle.codeKeccak256 === "0x9a43083613b83b329783a9d321938d5edcad86b215a0d41ccc69554f53513459"],
    ["proxy", source.freshRuntimeBindings.wrapperProxy.implementation.toLowerCase() === "0x949a1d8bb6d79af138ccf9836af9f846180a7f9a"],
    ["wrapper-source", source.publicExplorerSources[0].contractName === "WrappedAsset" && source.publicExplorerSources[0].verifiedSourceAvailable],
    ["wrapper-semantics", /to != msg.sender/.test(source.publicExplorerSources[0].snippets.mint) && /from != msg.sender/.test(source.publicExplorerSources[0].snippets.burn)],
    ["backing", raw.wrapper.totalSupplyRaw === raw.wrapper.underlyingBackingRaw && raw.wrapper.backingRatioWad === "1000000000000000000"],
    ["donation", !raw.wrapper.oracleReadsWrapperBalanceOrRate && !raw.wrapper.directDonationChangesOraclePrice],
    ["venue-pin", venue.pin.number === raw.pin.number && venue.pin.hash === raw.pin.hash], ["venue-families", venue.archiveFamilies === 2 && venue.crossFamilyAgreement],
    ["venue-assets", venue.state.values.asset.toLowerCase() === raw.market.loanToken.toLowerCase() && venue.state.values.share.toLowerCase() === "0x5a0f93d040de44e78f251b03c43be9cf317dcf64"],
    ["venue-quote", venue.pricing.redeemReferenceUsdcRaw === "1041987" && venue.pricing.divergenceBps === "-4"],
    ["oracle-update-auth", venue.oracleUpdateAuthorization.barECDSA === "2" && venue.oracleUpdateAuthorization.barSchnorr === "2" && venue.oracleUpdateAuthorization.unauthenticatedValueWrite === false],
    ["fresh-user", venue.reachability.freshUserPermissioned === false && venue.reachability.maxDepositRaw === "0" && venue.reachability.maxRedeemRaw === "0"],
    ["pools", raw.venues.discoveredPools.length === 0 && Object.values(raw.venues.balancerVaultTokenBalances).every((x) => x === "0")],
    ["borrowers", raw.borrowers.currentDebtAccounts === 7 && raw.borrowers.nearBoundaryWithin500Bps.length === 0],
    ["gates", raw.manipulationAssessment.routePositive === 0 && raw.manipulationAssessment.executableNow === 0 && !raw.manipulationAssessment.signedActionJustified && !raw.manipulationAssessment.forkCreated],
    ["safety", !raw.safety.endpointIdentitiesPersisted && !raw.safety.rawRpcPersisted && !raw.safety.signing && !raw.safety.broadcast && !raw.safety.fork]
  ].map(([id, pass]) => ({ id, pass: !!pass }));
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), total: c.length, passed: c.filter((x) => x.pass).length, failed: c.filter((x) => !x.pass).map((x) => x.id), rows: c };
}

function makeReport(raw, source, venue) {
  const nearest = raw.borrowers.positions.find((x) => x.borrowShares !== "0"), created = raw.history.morphoEvents.find((x) => x.event === "CreateMarket");
  return [
    "# ⚪ CLEAN (permissionless manipulation subbranch) / WATCH — Ethereum Morpho wJAAA/USDC", "",
    `**Classification:** \`${raw.classification}\`  `, "**Pipeline:** `2/5`; **gates:** `0/0/false`; **fork:** `false`.", "",
    "## Pin, market, and liquidity", "",
    `- Finalized Ethereum block \`${raw.pin.number}\` / \`${raw.pin.hash}\` (${raw.pin.iso}); terminal same-number recheck passed.`,
    `- Exact ID \`${raw.market.id}\` recomputes from USDC / wJAAA / oracle / IRM / 98% LLTV, correcting the false Base assumption.`,
    `- Expected supply / borrow / liquidity: \`${Number(raw.market.expectedAtPin.totalSupplyAssets) / 1e6}\` / \`${Number(raw.market.expectedAtPin.totalBorrowAssets) / 1e6}\` / **\`${raw.market.availableLiquidityUsdc} USDC\`**.`, "",
    "## Exact oracle path", "",
    `\`price() 0xa035b1fe\` → oracle \`${raw.market.oracle}\` → adapter \`${raw.oracle.baseFeed}\` via \`latestRoundData 0xfeaf968c\` → router \`${raw.oracle.router}\` via toll check \`0x3bee58f9\` and \`readWithAge 0x393e5ede\` → storage consumer \`${raw.oracle.selectedConsumer}\`.`,
    "- Two trace families agree. Consumer slots `0x3`, `0x308`; router slots `0x2`, `0x3dc9…f884`, `0x6124…b5d6`. No DEX call appeared.",
    `- Price \`${raw.market.oraclePriceUsdcPerWjaaa} USDC/wJAAA\`; feed age \`${raw.oracle.ageSecondsAtPin}s\`. Morpho intentionally omits a staleness check (\`targets/morpho-blue-oracles/src/morpho-chainlink/libraries/ChainlinkDataFeedLib.sol:13-26\`).`,
    `- Chronicle update bars are ECDSA \`${venue.oracleUpdateAuthorization.barECDSA}\` / Schnorr \`${venue.oracleUpdateAuthorization.barSchnorr}\`; \`poke\` is relayable only with a threshold-valid proof. Two auth addresses control validator bars/auth, so this remains permissioned control-plane risk, not an unauthenticated write.`,
    `- Runtime hashes: oracle \`${source.freshRuntimeBindings.oracle.codeKeccak256}\`; adapter \`${source.freshRuntimeBindings.adapter.codeKeccak256}\`; router \`${source.freshRuntimeBindings.router.codeKeccak256}\`; consumer \`${source.freshRuntimeBindings.consumer.codeKeccak256}\`.`, "",
    "## Wrapper / NAV", "",
    `- wJAAA proxy → \`${source.freshRuntimeBindings.wrapperProxy.implementation}\` (\`${source.freshRuntimeBindings.wrapperImplementation.codeKeccak256}\`), public verified \`WrappedAsset\`, solc 0.8.34 / optimizer 200 / Prague.`,
    "- Not ERC4626: self mint/burn is public and exactly 1:1 JAAA; third-party mint needs issuer role and third-party burn needs allowance.",
    `- Supply and JAAA backing both \`${raw.wrapper.totalSupplyRaw}\` raw (${Number(raw.wrapper.totalSupplyRaw) / 1e6}). Donation only creates trapped surplus and cannot affect Chronicle NAV.`,
    `- JAAA is direct \`Tranche\` runtime \`${source.freshRuntimeBindings.jaaa.codeKeccak256}\`; vault changes and mint/burn are auth-controlled; transfer hook \`${raw.wrapper.transferHook}\`.`, "",
    "## Borrowers", "",
    `- Complete bounded history from wJAAA deployment block \`24841246\` through pin: ${raw.history.morphoEvents.length} Morpho and ${raw.history.wrapperEvents.length} wrapper events across two agreeing archive families; market created at \`${created.blockNumber}\`.`,
    `- ${raw.borrowers.enumeratedAccounts} accounts, ${raw.borrowers.currentDebtAccounts} with debt; none within 500 bps. Nearest \`${nearest.account}\`: ${Number(nearest.borrowedAssetsRaw) / 1e6} USDC debt, ${Number(nearest.collateralRaw) / 1e6} wJAAA, HF ${Number(nearest.healthFactorWad) / 1e18} (+${nearest.distanceToLiquidationBps} bps).`, "",
    "## Canonical acquisition / redemption", "",
    `- JAAA/USDC AsyncVault \`${venue.target}\`, direct \`${venue.state.runtimeKeccak256}\`, public verified solc 0.8.28 / optimizer 1 / Cancun. Two-family same-pin reference: 1 JAAA → \`${venue.pricing.referenceRedemptionUsdcPerJaaa} USDC\`, ${venue.pricing.divergenceBps} bps versus Morpho.`,
    "- Fresh user: `isPermissioned=false`; max deposit/mint/redeem/withdraw all zero. Async request/claim state means conversion is not an immediate exit.",
    "- No wJAAA/JAAA pool versus USDC/WETH in Uniswap V2, Sushi V2, or Uniswap V3; Balancer Vault balances are zero.", "",
    "## Result / next gate", "",
    "No permissionless manipulation edge survives. Chronicle is signed/storage-backed, wrapper conversion is fixed 1:1, donation is oracle-independent, and fresh-user USDC entry/exit is permissioned/asynchronous. No fork was created; economics are null, not assumed zero.", "",
    "Reopen only on Chronicle auth/target drift, stale-feed activation, AsyncVault permission/capacity change, material pool appearance, or wrapper/hook upgrade.", ""
  ].join("\n");
}

function leakScan(files) {
  const inventory = ["rpc_endpoints.txt", "graphql_endpoints.txt"].map((x) => fs.readFileSync(abs(x), "utf8")).join("\n");
  const urls = [...inventory.matchAll(/https?:\/\/[^\s"'`<>{}\[\]]+/gi)].map((x) => x[0].replace(/[)>`,.;\]]+$/g, ""));
  const secrets = [...new Set([...urls, ...urls.map((x) => { try { return new URL(x).hostname; } catch { return null; } }).filter(Boolean)])], hits = [];
  for (const file of files) { const text = fs.readFileSync(abs(file), "utf8"); for (const secret of secrets) if (secret.length >= 6 && text.includes(secret)) hits.push({ file, type: secret.includes("://") ? "url" : "host" }); }
  return { schemaVersion: 1, scannedAt: new Date().toISOString(), filesScanned: files.length, inventoryValuesComparedInMemoryOnly: true, endpointIdentityHits: hits.length, hits, pass: hits.length === 0, rawInventoryPersisted: false };
}

function main() {
  let raw = load(P.raw), source = load(P.source); const venue = load(P.venue); raw = correct(raw, source, venue); source = load(P.source);
  const tests = runTests(raw, source, venue); if (tests.failed.length) throw Error(`tests failed:${tests.failed.join(",")}`); write(P.tests, tests);
  write(P.report, makeReport(raw, source, venue));
  write(P.inbox, { findingId: "morpho-ethereum-wjaaa-custom-oracle-step1", agentId: "critical-morpho-ethereum-wjaaa-step1-20260725", role: "critical-research", status: "route-negative", routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, classification: raw.classification, summary: "Ethereum 98%-LLTV market bound; Chronicle signed/storage NAV has no DEX/donation edge and fresh-user canonical USDC entry/exit is blocked.", artifacts: [P.raw, P.source, P.venue, P.report, P.tests], nextAction: "Reopen only on Chronicle, AsyncVault, pool, wrapper, or hook trigger change." });
  write(P.handoff, ["# Morpho Ethereum wJAAA custom-oracle Step 1 handoff", "", `- Pin ${raw.pin.number} / ${raw.pin.hash}; terminal PASS.`, `- Market ${raw.market.id}; 98% LLTV; ${raw.market.availableLiquidityUsdc} USDC liquidity.`, `- Chronicle adapter/router/storage consumer; two traces; no DEX; age ${raw.oracle.ageSecondsAtPin}s; no Morpho staleness check.`, "- Wrapper public 1:1 self wrap/unwrap, not ERC4626; exact backing; donation-independent oracle.", `- ${raw.borrowers.currentDebtAccounts} debt accounts; nearest +${raw.borrowers.positions[0].distanceToLiquidationBps} bps.`, `- AsyncVault ${venue.pricing.referenceRedemptionUsdcPerJaaa} USDC/JAAA (${venue.pricing.divergenceBps} bps); fresh user blocked; no DEX pool.`, `- ${raw.classification}; pipeline 2/5; gates 0/0/false; fork=false.`, ""].join("\n"));
  const outputs = [P.raw, P.source, P.venue, P.tests, P.report, P.inbox, P.handoff], leak = leakScan(outputs); if (!leak.pass) throw Error("endpoint leak"); write(P.leak, leak);
  const records = [...TOOLS, ...outputs, P.leak].map(bind), manifest = { schemaVersion: 1, generatedAt: new Date().toISOString(), runId: raw.runId, revision: raw.revision, classification: raw.classification, records, aggregateSha256: sha(Buffer.from(records.map((x) => `${x.file}\0${x.bytes}\0${x.sha256}`).join("\n"))), gates: raw.manipulationAssessment, safety: { packagingNetworkRequests: 0, fork: false, signing: false, broadcast: false, endpointMaterialPersisted: false } };
  write(P.manifest, manifest); process.stdout.write(JSON.stringify({ runId: raw.runId, tests: `${tests.passed}/${tests.total}`, leak: leak.pass, aggregateSha256: manifest.aggregateSha256, gates: "0/0/false", fork: false }) + "\n");
}
main();
