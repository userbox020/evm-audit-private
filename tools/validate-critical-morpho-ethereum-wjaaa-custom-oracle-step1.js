#!/usr/bin/env node
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.resolve(__dirname, ".."), abs = (x) => path.join(ROOT, ...x.split("/")), sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const RAW = "reports/raw/fast/critical-morpho-ethereum-wjaaa-custom-oracle-step1.json", SOURCE = "reports/raw/fast/critical-morpho-ethereum-wjaaa-custom-oracle-step1-sources.json", VENUE = "reports/raw/fast/critical-morpho-ethereum-wjaaa-venue-supplement.json", MANIFEST = "reports/raw/fast/critical-morpho-ethereum-wjaaa-custom-oracle-step1-manifest.json";
function load(x) { return JSON.parse(fs.readFileSync(abs(x), "utf8")); }
function checks(raw, source, venue) {
  return [
    ["ethereum", raw.scopeCorrection.chainId === 1 && raw.scopeCorrection.falseBaseAssumptionCorrected],
    ["pin", raw.pin.finalizedSelected && raw.pin.passed && raw.pin.number === venue.pin.number && raw.pin.hash === venue.pin.hash],
    ["terminal", raw.pin.terminalRecheck.length >= 2 && raw.pin.terminalRecheck.every((x) => x.sameHash && x.finalizedAtOrAbove)],
    ["market-id", raw.market.id === "0xb55c0ebe12c4af149ce74ba4d83ca847c3be6787921b36b51a4d98bd105163e2" && raw.market.idMatches],
    ["params", raw.market.loanToken.toLowerCase() === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" && raw.market.collateralToken.toLowerCase() === "0x86b495e4cb00ab18ad94bfd7920479cc79e8ebfe" && raw.market.oracle.toLowerCase() === "0x2e4eb0647fd1f9029499d41153a7cccb1ab5d886" && raw.market.irm.toLowerCase() === "0x870ac11d48b15db9a138cf899d20f13f79ba00bc" && raw.market.lltv === "980000000000000000"],
    ["liquidity", BigInt(raw.market.availableLiquidityRaw) === BigInt(raw.market.expectedAtPin.totalSupplyAssets) - BigInt(raw.market.expectedAtPin.totalBorrowAssets)],
    ["history", raw.history.familyCount === 2 && raw.history.crossFamilyAgreement && raw.history.familyCommitments[0].morphoEventDigest === raw.history.familyCommitments[1].morphoEventDigest],
    ["borrowers", raw.borrowers.currentDebtAccounts === 7 && raw.borrowers.nearBoundaryWithin500Bps.length === 0],
    ["trace", raw.oracle.callGraphFamilyCount === 2 && raw.oracle.callGraphCrossFamilyAgreement && raw.oracle.noDexCalleesObserved],
    ["storage", raw.oracle.traces.every((x) => x.prestateAvailable && x.touchedStorage.some((y) => y.address.toLowerCase() === raw.oracle.selectedConsumer.toLowerCase() && y.storageSlotCount >= 2))],
    ["freshness", raw.oracle.ageSecondsAtPin >= 0 && raw.oracle.stalenessEnforcedByMorphoOracle === false],
    ["update-auth", raw.oracle.updateAuthorization.barECDSA === "2" && raw.oracle.updateAuthorization.barSchnorr === "2" && raw.oracle.updateAuthorization.unauthenticatedValueWrite === false],
    ["runtime", source.freshRuntimeBindings.oracle.codeKeccak256 === "0x9a43083613b83b329783a9d321938d5edcad86b215a0d41ccc69554f53513459" && source.freshRuntimeBindings.wrapperProxy.implementation.toLowerCase() === "0x949a1d8bb6d79af138ccf9836af9f846180a7f9a"],
    ["wrapper-source", source.publicExplorerSources[0].contractName === "WrappedAsset" && source.publicExplorerSources[0].verifiedSourceAvailable],
    ["wrapper-semantics", raw.wrapper.permissionlessSelfWrapUnwrap === true && raw.wrapper.publicUnderlyingUnwrapPresent === true && raw.wrapper.publicUsdcRedemptionPresent === false],
    ["backing", raw.wrapper.totalSupplyRaw === raw.wrapper.underlyingBackingRaw && raw.wrapper.backingRatioWad === "1000000000000000000"],
    ["donation", raw.wrapper.directDonationChangesOraclePrice === false && raw.wrapper.oracleReadsWrapperBalanceOrRate === false],
    ["venue-binding", venue.archiveFamilies === 2 && venue.crossFamilyAgreement && venue.state.values.asset.toLowerCase() === raw.market.loanToken.toLowerCase() && venue.state.values.share.toLowerCase() === "0x5a0f93d040de44e78f251b03c43be9cf317dcf64"],
    ["venue-quote", venue.pricing.redeemReferenceUsdcRaw === "1041987" && venue.pricing.divergenceBps === "-4"],
    ["venue-gate", venue.reachability.freshUserPermissioned === false && venue.reachability.maxDepositRaw === "0" && venue.reachability.maxRedeemRaw === "0"],
    ["dex", raw.venues.discoveredPools.length === 0 && Object.values(raw.venues.balancerVaultTokenBalances).every((x) => x === "0")],
    ["gates", raw.manipulationAssessment.routePositive === 0 && raw.manipulationAssessment.executableNow === 0 && raw.manipulationAssessment.signedActionJustified === false && raw.manipulationAssessment.forkCreated === false],
    ["safety", !raw.safety.endpointIdentitiesPersisted && !raw.safety.rawRpcPersisted && !raw.safety.signing && !raw.safety.broadcast && !raw.safety.fork]
  ].map(([id, pass]) => ({ id, pass: !!pass }));
}
function main() {
  const raw = load(RAW), source = load(SOURCE), venue = load(VENUE), result = checks(raw, source, venue);
  if (fs.existsSync(abs(MANIFEST))) { const manifest = load(MANIFEST); for (const row of manifest.records) { const body = fs.readFileSync(abs(row.file)); result.push({ id: `manifest:${row.file}`, pass: body.length === row.bytes && sha(body) === row.sha256 }); } result.push({ id: "manifest-aggregate", pass: sha(Buffer.from(manifest.records.map((x) => `${x.file}\0${x.bytes}\0${x.sha256}`).join("\n"))) === manifest.aggregateSha256 }); }
  const failed = result.filter((x) => !x.pass); process.stdout.write(JSON.stringify({ total: result.length, passed: result.length - failed.length, failed: failed.map((x) => x.id) }) + "\n"); if (failed.length) process.exitCode = 1;
}
main();
