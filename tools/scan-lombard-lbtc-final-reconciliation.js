#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const RAW_REL = "reports/raw/fast/lombard-lbtc-final-reconciliation.json";
const REPORT_REL = "reports/lombard-lbtc-final-reconciliation.md";
const HANDOFF_REL = "coordination/handoffs/2026-07-12-coordinator-lombard-step15-handoff.md";
const CLASSIFICATION = "INCOMPLETE/WATCH — NO CONFIRMED EXPLOIT; GLOBAL BACKING/SOLVENCY UNRESOLVED";
const INPUTS = [
  ["step4", "reports/raw/fast/lombard-lbtc-endpoint-state.json", "tools/scan-lombard-lbtc-endpoint-state.js"],
  ["step5", "reports/raw/fast/lombard-lbtc-backing-liability-discovery.json", "tools/scan-lombard-lbtc-backing-liability-discovery.js"],
  ["step6", "reports/raw/fast/lombard-lbtc-nonevm-state.json", "tools/scan-lombard-lbtc-nonevm-state.js"],
  ["step7", "reports/raw/fast/lombard-lbtc-reserve-ibc-verification.json", "tools/scan-lombard-lbtc-reserve-ibc-verification.js"],
  ["step8", "reports/raw/fast/lombard-lbtc-por-attestation-integrity.json", "tools/scan-lombard-lbtc-por-attestation-integrity.js"],
  ["step9", "reports/raw/fast/lombard-lbtc-por-source-runtime.json", "tools/scan-lombard-lbtc-por-source-runtime.js"],
  ["step10", "reports/raw/fast/lombard-lbtc-bitcoin-utxo-pilot.json", "tools/scan-lombard-lbtc-bitcoin-utxo-pilot.js"],
  ["step11", "reports/raw/fast/lombard-lbtc-babylon-backing-state.json", "tools/scan-lombard-lbtc-babylon-backing-state.js"],
  ["step12", "reports/raw/fast/lombard-lbtc-ibc-origin-mode.json", "tools/scan-lombard-lbtc-ibc-origin-mode.js"],
  ["step13", "reports/raw/fast/lombard-lbtc-nonevm-resolution.json", "tools/scan-lombard-lbtc-nonevm-resolution.js"],
  ["step14", "reports/raw/fast/lombard-lbtc-evm-gap-resolution.json", "tools/scan-lombard-lbtc-evm-gap-resolution.js"],
];
const CLOSED_GATE_FIELDS = {
  routePositive: 0,
  routeEvidenceStatus: "unknown",
  evidenceComplete: false,
  closureEligible: false,
  executableNow: 0,
  signedActionJustified: false,
  forkJustified: false,
};

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}
function serialize(value) { return JSON.stringify(stable(value), null, 2) + "\n"; }
function invariant(condition, name) { if (!condition) throw new Error(name); }
function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isIso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function isRaw(value) { return typeof value === "string" && /^\d+$/.test(value); }
function isDecimal(value) { return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value); }
function isHash(value) { return typeof value === "string" && /^(?:0x)?[0-9a-fA-F]{32,}$/.test(value); }
function isCanonicalUintString(value) { return typeof value === "string" && /^\d+$/.test(value) && BigInt(value).toString() === value; }
function validIbcBaseDenom(value) { const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0; return typeof value === "string" && bytes >= 3 && bytes <= 128 && /^[A-Za-z0-9][A-Za-z0-9/:._-]*$/.test(value) && !/[\s\x00-\x1f\x7f]/.test(value); }
function validIbcIdentifier(value) { return typeof value === "string" && Buffer.byteLength(value, "utf8") >= 1 && Buffer.byteLength(value, "utf8") <= 128 && /^[A-Za-z0-9][A-Za-z0-9._+\-#\[\]<>]*$/.test(value) && !/[\s\x00-\x1f\x7f/]/.test(value); }
function independentlyReconstructTrace(row) {
  const trace = row?.trace || {}, pathValue = trace.path, baseDenom = trace.baseDenom;
  const parts = typeof pathValue === "string" ? pathValue.split("/") : [];
  const pathGrammarValid = parts.length >= 2 && parts.length % 2 === 0 && parts.every(validIbcIdentifier);
  const baseDenomValid = validIbcBaseDenom(baseDenom);
  const canonicalPreimage = pathGrammarValid && baseDenomValid ? `${parts.join("/")}/${baseDenom}` : null;
  const computedHash = canonicalPreimage ? sha256(Buffer.from(canonicalPreimage, "utf8")).toUpperCase() : null;
  const targetHash = typeof row?.denom === "string" && /^ibc\/[0-9A-F]{64}$/.test(row.denom) ? row.denom.slice(4) : null;
  return { pathGrammarValid, baseDenomValid, canonicalPreimage, computedHash, targetHash };
}
function step12RowChecks(row, expectedChainId) {
  const reconstructed = independentlyReconstructTrace(row), networkIdentity = row?.networkIdentity;
  const separateNetworkIdentityConsistent = networkIdentity === null || networkIdentity === undefined || (networkIdentity.expectedChainId === expectedChainId && networkIdentity.observedChainId === expectedChainId && /verified/i.test(networkIdentity.status || ""));
  return {
    requestedHeightCanonicalInteger: isCanonicalUintString(row?.binding?.requestedHeight),
    fixedPointHeightCanonicalInteger: isCanonicalUintString(row?.fixedPoint?.height),
    requestedHeightEqualsFixedPointHeight: row?.binding?.requestedHeight === row?.fixedPoint?.height,
    fixedPointChainIdEqualsExpected: row?.fixedPoint?.chainId === expectedChainId,
    separateNetworkIdentityConsistentIfPresent: separateNetworkIdentityConsistent,
    tracePathGrammarValidBeforeHashing: reconstructed.pathGrammarValid,
    traceBaseDenomGrammarValidBeforeHashing: reconstructed.baseDenomValid,
    independentlyComputedHashEqualsTargetDenomSuffix: reconstructed.computedHash !== null && reconstructed.computedHash === reconstructed.targetHash,
    independentlyComputedHashEqualsReportedComputedHash: reconstructed.computedHash === row?.trace?.computedHash,
    targetSuffixEqualsReportedExpectedHash: reconstructed.targetHash === row?.trace?.expectedHash,
    reportedPathHashRecomputed: typeof row?.trace?.pathSha256 !== "string" || row.trace.pathSha256 === sha256(Buffer.from(row.trace.path, "utf8")),
    reportedBaseDenomHashRecomputed: typeof row?.trace?.baseDenomSha256 !== "string" || row.trace.baseDenomSha256 === sha256(Buffer.from(row.trace.baseDenom, "utf8")),
  };
}
function checkFixedPoint(point) {
  if (!isObject(point)) return false;
  const number = point.blockNumber ?? point.number ?? point.height ?? point.slot ?? point.checkpoint;
  const hash = point.blockHash ?? point.hash ?? point.digest;
  const time = point.timestamp ?? point.time;
  return number !== null && number !== undefined && (typeof number === "number" || /^\d+$/.test(String(number)))
    && (hash === null || hash === undefined || typeof hash === "string")
    && (time === null || time === undefined || isIso(time));
}
function checkClosedGates(gates) {
  if (!isObject(gates)) return false;
  return Object.entries(CLOSED_GATE_FIELDS).every(([key, value]) => gates[key] === value);
}
function validateChecks(key, checks) {
  const results = Object.fromEntries(Object.entries(checks).map(([name, passed]) => [name, Boolean(passed)]));
  const failed = Object.entries(results).filter(([, passed]) => !passed).map(([name]) => name);
  invariant(failed.length === 0, `semantic-validation-${key}-${failed.join("-")}`);
  return results;
}
function commonChecks(parsed, scanner) {
  return {
    rootObject: isObject(parsed),
    scannerExact: parsed.scanner === scanner,
    classificationTyped: typeof parsed.classification === "string" && parsed.classification.length > 0,
    generatedAtOrSnapshotTyped: isIso(parsed.generatedAt) || typeof parsed.snapshotLabel === "string",
    gatesClosed: checkClosedGates(parsed.gates),
  };
}
function promotedChecks(key, d) {
  switch (key) {
    case "step4": {
      const pinned = d.chains?.filter(chain => checkFixedPoint(chain.pin)) || [];
      return {
        chainsConfigured19: Array.isArray(d.chains) && d.chains.length === 19,
        chainIdentityRowsTyped: d.chains.every(chain => Number.isInteger(chain.chainId) && typeof chain.name === "string"),
        chainIdentitiesUnique: new Set(d.chains.map(chain => chain.chainId)).size === 19,
        pinnedChainCount13: pinned.length === 13,
        pinnedFixedPointsValid: pinned.every(chain => checkFixedPoint(chain.pin) && isHash(chain.pin.blockHash)),
        sourceCommitBound: d.sourceCommit?.matches === true && /^[0-9a-f]{40}$/.test(d.sourceCommit?.observed || ""),
      };
    }
    case "step5": {
      const rows = d.evmBaseline?.rows || [];
      const promoted = rows.filter(row => row.rawSupply !== null);
      return {
        evmRowsArray: Array.isArray(rows),
        promotedRawAndDecimalStrings: promoted.every(row => isRaw(row.rawSupply) && isDecimal(row.decimalSupply)),
        promotedComponentsAllowed: promoted.every(row => /^(?:StakedLBTC|NativeLBTC|IBCVoucher)$/.test(row.component)),
        promotedFixedPointsValid: promoted.every(row => checkFixedPoint(row.fixedPoint) && isHash(row.fixedPoint.blockHash)),
        promotedProvenanceBound: promoted.every(row => isObject(row.provenance) && row.provenance.inputPath === INPUTS[0][1] && isHash(row.provenance.inputSha256)),
        ethereumCeilingExact: promoted.some(row => row.chainId === 1 && row.component === "StakedLBTC" && row.adjustedBtcLiabilityCeiling === "8771.74409737"),
      };
    }
    case "step6":
      return {
        resultsArray: Array.isArray(d.results) && d.results.length === 5,
        identityStatusesTyped: d.results.every(row => typeof row.networkIdentity?.status === "string"),
        fixedPointsOrExplicitUnresolved: d.results.every(row => row.fixedPoint === null || checkFixedPoint(row.fixedPoint)),
        anchorWindowTyped: isObject(d.anchorTimestampWindow),
      };
    case "step7":
      return {
        ibcRowsTwo: Array.isArray(d.ibc) && d.ibc.length === 2,
        ibcIdentityBoundStatuses: d.ibc.every(row => typeof row.networkIdentity?.status === "string" && typeof row.supply?.status === "string"),
        oracleRowsTyped: Array.isArray(d.oracles) && d.oracles.every(row => row.classification === "exchange-rate-oracle-not-reserve-attestation"),
        porLengthTyped: Number.isInteger(d.metrics?.porListLength) && d.metrics.porListLength === 28973,
      };
    case "step8":
      return {
        baseFixedPointValid: checkFixedPoint(d.base?.fixedBlock),
        registryMetricsExact: d.metrics?.listLength === 28973 && d.metrics?.cryptographicOwnershipVerifiedRows === 0 && d.metrics?.completeRegistryVerified === false,
        verifierStatusTyped: d.metrics?.attestationFormatSpecified === false,
        conclusionClosed: d.conclusion?.fullyReconciledBackingRows === 0 && d.conclusion?.insolvencyProven === false,
      };
    case "step9":
      return {
        step8HashBindingPassed: d.step8Binding?.passed === true && d.step8Binding?.deployedRuntimeHashMatches === true,
        executableRuntimeMatch: d.conclusion?.sourceRuntimeClassification === "EXECUTABLE RUNTIME MATCH / METADATA DIFFERENT",
        buildProvenanceComplete: d.reproducibleBuildProvenanceComplete === true,
        sourceCommitBound: /^[0-9a-f]{40}$/.test(d.provenance?.checkoutCommit || ""),
      };
    case "step10":
      return {
        baseFixedPointValid: checkFixedPoint(d.currentRun?.base?.fixedBlock),
        bitcoinAnchorUnavailable: d.currentRun?.bitcoin?.selectedBlock === null,
        utxoRowsZeroBecauseUnavailable: d.currentRun?.bitcoin?.utxos?.retained === 0 && d.currentRun?.bitcoin?.aggregate?.satoshis === null,
        ownershipFalse: d.currentRun?.bitcoin?.ownershipVerified === false,
      };
    case "step11":
      return {
        babylonFixedPointValid: checkFixedPoint(d.currentRun?.fixedPoint),
        snapshotBound: d.currentRun?.stateSnapshotBinding?.status === "bound",
        attributionBlocked: d.currentRun?.attribution?.officialLombardFpKeys === 0 && d.currentRun?.attribution?.attributableLombardSat === null,
        candidateIncomplete: d.currentRun?.candidateDelegations?.complete === false && d.currentRun?.candidateDelegations?.statusSat === null,
      };
    case "step12": {
      const identities = new Set((d.chains || []).map(row => row.fixedPoint?.chainId));
      const cosmos = d.chains?.find(row => row.fixedPoint?.chainId === "cosmoshub-4"), babylon = d.chains?.find(row => row.fixedPoint?.chainId === "bbn-1");
      const cosmosChecks = step12RowChecks(cosmos, "cosmoshub-4"), babylonChecks = step12RowChecks(babylon, "bbn-1");
      return {
        chainRowsTwo: Array.isArray(d.chains) && d.chains.length === 2,
        exactChainIdentities: identities.size === 2 && identities.has("cosmoshub-4") && identities.has("bbn-1"),
        fixedPointsAndBindingsValid: d.chains.every(row => checkFixedPoint(row.fixedPoint) && row.binding?.status === "bound" && Number(row.binding.requests) > 0 && row.binding.matching === row.binding.requests && row.binding.missing === 0 && row.binding.mismatched === 0),
        supplyRawStrings: d.chains.every(row => row.supply?.status === "observed-exact-denom" && isRaw(row.supply.amount)),
        traceStatusesVerified: d.chains.every(row => row.trace?.status === "observed-hash-verified" && row.trace?.hashVerified === true && row.trace?.computedHash === row.denom.slice(4) && row.trace?.expectedHash === row.denom.slice(4)),
        bridgeModesZero: d.aggregateMetrics?.bridgeModeVerifiedRows === 0,
        ...Object.fromEntries(Object.entries(cosmosChecks).map(([name, value]) => [`cosmosHub_${name}`, value])),
        ...Object.fromEntries(Object.entries(babylonChecks).map(([name, value]) => [`babylon_${name}`, value])),
      };
    }
    case "step13": {
      const sui = d.results?.find(row => row.ecosystem === "Sui"), starknet = d.results?.find(row => row.ecosystem === "Starknet"), solana = d.results?.find(row => row.ecosystem === "Solana");
      return {
        resultIdentitiesPresent: Boolean(sui && starknet && solana),
        suiIdentityExact: sui?.identity?.status === "verified-mainnet" && sui?.identity?.expectedChainIdentifier === "35834a8a",
        suiCheckpointPositive: /^\d+$/.test(String(sui?.fixedPoint?.checkpoint || "")) && BigInt(sui.fixedPoint.checkpoint) > 0n && typeof sui?.fixedPoint?.digest === "string" && sui.fixedPoint.digest.length > 0,
        suiSupplyAndTypeValid: isRaw(sui?.supply?.raw) && Number.isInteger(sui?.supply?.decimals) && /^0x[0-9a-f]+::[A-Za-z0-9_]+::[A-Za-z0-9_]+$/i.test(sui?.exactCoinType || "") && sui?.typeResolution?.packagePrefixVerified === true,
        suiTypeUsesRecordedPackage: [d.officialTargets?.sui?.coinObject, d.officialTargets?.sui?.package].some(id => sui?.exactCoinType?.toLowerCase().startsWith(`${id.toLowerCase()}::`)),
        suiUnpinnedStatusExact: sui?.supply?.status === "observed-exact-treasurycap-schema-unpinned" && sui?.observationWindow?.legacyObjectAndCoinCallsCheckpointPinned === false,
        starknetIdentityExact: starknet?.identity?.status === "verified-SN_MAIN" && starknet?.identity?.expectedChainId === "0x534e5f4d41494e",
        starknetFixedBlockClassAbiValid: checkFixedPoint(starknet?.fixedPoint) && Number(starknet?.fixedPoint?.blockNumber) > 0 && /^0x[0-9a-f]+$/i.test(starknet?.fixedPoint?.blockHash || "") && starknet?.class?.status === "verified-at-fixed-block" && /^0x[0-9a-f]+$/i.test(starknet?.class?.classHash || "") && ["array", "bounded-json-string"].includes(starknet?.class?.abiRepresentation),
        starknetSupplyFixedBlock: starknet?.supply?.status === "observed-schema-verified-fixed-block" && isRaw(starknet?.supply?.raw) && starknet?.supply?.decimalsSchema === "core::integer::u8" && starknet?.supply?.totalSupplySchema === "core::integer::u256",
        starknetOfficialAddressExact: /^0x[0-9a-f]{64}$/i.test(d.officialTargets?.starknet?.token || ""),
        solanaExplicitlyUnresolved: solana?.identity?.status === "unverified" && solana?.supply?.raw === null,
      };
    }
    case "step14": {
      const resolved = d.chains?.filter(row => row.resolved) || [];
      return {
        sixGapChains: Array.isArray(d.chains) && d.chains.length === 6,
        fiveResolvedExactIdentity: resolved.length === 5 && resolved.every(row => row.observedChainId === row.expectedChainId && checkFixedPoint(row.pin)),
        localSeedProvenanceOnly: resolved.every(row => row.addressAssociation === "localDeploymentSeed" && row.officialJoinVerified === false),
        supplySchemasValid: resolved.flatMap(row => row.supplyRows).every(row => isRaw(row.raw) && Number.isInteger(row.decimals) && isDecimal(row.display) && row.provenance?.classification === "localDeploymentSeed" && row.provenance?.officialJoinVerified === false),
        adapterRowsExcluded: resolved.flatMap(row => row.addresses).filter(row => row.supply).every(row => ["canonical-token", "btc-b-token"].includes(row.category)),
        aggregateGatesClosed: d.aggregateMetrics?.bridgeModeVerifiedRows === 0 && d.aggregateMetrics?.fullyReconciledLiabilityRows === 0,
      };
    }
    default: return { knownInput: false };
  }
}
function loadInputs() {
  const data = {}, manifest = [];
  for (const [key, rel, scanner] of INPUTS) {
    const bytes = fs.readFileSync(path.join(ROOT, rel));
    const parsed = JSON.parse(bytes.toString("utf8"));
    const rootChecks = validateChecks(key, commonChecks(parsed, scanner));
    const fieldChecks = validateChecks(key, promotedChecks(key, parsed));
    data[key] = parsed;
    manifest.push({
      key, path: rel, bytes: bytes.length, sha256: sha256(bytes), scanner,
      generatedAt: parsed.generatedAt ?? null, snapshotLabel: parsed.snapshotLabel ?? null,
      classification: parsed.classification, rootSchemaValidated: true,
      promotedFieldsValidated: true, validationChecks: { root: rootChecks, promotedFields: fieldChecks },
    });
  }
  return { data, manifest };
}
function bindingRow(name, source, target, checks, treatment = "promotion-eligible") {
  const validated = validateChecks(`cross-${name}`, checks);
  return { name, source, target, treatment, validated: true, checks: validated };
}
function validateCrossArtifactBindings(data, manifest) {
  const hashes = Object.fromEntries(manifest.map(row => [row.key, row.sha256]));
  const promotedStep5 = data.step5.evmBaseline.rows.filter(row => row.rawSupply !== null);
  const step8Lineage = data.step8.base.implementationLineage, step9Chain = data.step9.chain;
  const step6Rows = data.step6.identityRegistry;
  const starknetRegistry = step6Rows.find(row => row.ecosystem === "starknet" && row.kind === "token");
  const cosmosRegistry = step6Rows.find(row => row.ecosystem === "cosmos" && row.kind === "denom");
  const babylonRegistry = step6Rows.find(row => row.ecosystem === "babylon" && row.kind === "denom");
  const suiKinds = new Map(step6Rows.filter(row => row.ecosystem === "sui").map(row => [row.kind, row.identifier]));
  const rows = [];
  rows.push(bindingRow("step5-promoted-rows-to-current-step4", "step5.evmBaseline.rows[].provenance", "current-step4-file", {
    allPromotedRowsReferenceStep4Path: promotedStep5.every(row => row.provenance?.inputPath === INPUTS[0][1]),
    allPromotedRowsReferenceCurrentStep4Hash: promotedStep5.every(row => row.provenance?.inputSha256 === hashes.step4),
    allPromotedRowsReferenceStep4Scanner: promotedStep5.every(row => row.provenance?.scanner === data.step4.scanner),
    allPromotedRowsReferenceStep4GeneratedAt: promotedStep5.every(row => row.provenance?.generatedAt === data.step4.generatedAt),
  }));
  rows.push(bindingRow("step9-current-step8-artifact-hash", "step9.provenance/step8Binding", "current-step8-file", {
    provenanceHashMatchesCurrentStep8: data.step9.provenance?.step8Artifact?.sha256 === hashes.step8,
    bindingHashMatchesCurrentStep8: data.step9.step8Binding?.artifactSha256 === hashes.step8,
    artifactParsed: data.step9.provenance?.step8Artifact?.parsed === true && data.step9.step8Binding?.artifactParsed === true,
  }));
  rows.push(bindingRow("step9-runtime-lineage-to-current-step8", "step9.chain/comparison", "step8.base.implementationLineage", {
    fixedChainIdentityMatches: data.step8.base.networkIdentity?.status === "verified" && data.step8.base.networkIdentity?.observedChainId === 8453 && step9Chain.networkIdentity?.status === "verified" && step9Chain.networkIdentity?.observedChainId === 8453,
    proxyAddressMatches: step9Chain.proxy?.address === step8Lineage.proxyAddress,
    implementationAddressMatches: step9Chain.proxy?.implementationAddress === step8Lineage.implementationAddress,
    deployedRuntimeKeccakMatches: step9Chain.deployedRuntime?.keccak256 === step8Lineage.implementationCode?.keccak256,
    deployedRuntimeSha256Matches: step9Chain.deployedRuntime?.sha256 === step8Lineage.implementationCode?.sha256,
    deployedRuntimeLengthMatches: step9Chain.deployedRuntime?.length === step8Lineage.implementationCode?.byteLength,
    proxyRuntimeHashMatches: step9Chain.proxy?.code?.keccak256 === step8Lineage.proxyCode?.keccak256 && step9Chain.proxy?.code?.sha256 === step8Lineage.proxyCode?.sha256,
    proxyRuntimeLengthMatches: step9Chain.proxy?.code?.length === step8Lineage.proxyCode?.byteLength,
    step8BindingFieldsDerivedTrue: data.step9.step8Binding?.deployedRuntimeHashMatches === true && data.step9.step8Binding?.implementationAddressMatches === true && data.step9.step8Binding?.proxyAddressMatches === true && data.step9.step8Binding?.step8ProxyResolved === step8Lineage.proxyResolved,
    executableLengthComparisonExact: data.step9.comparison?.metadataStrippedRuntimeMatch === true && data.step9.comparison?.compiledExecutableLength === data.step9.comparison?.deployedExecutableLength && data.step9.comparison?.deployedLength === step9Chain.deployedRuntime?.length,
    differentFixedBlocksNotMerged: data.step8.base.fixedBlock?.number !== data.step9.chain.fixedBlock?.number,
  }));
  rows.push(bindingRow("step13-starknet-token-to-step6-recorded-assertion", "step13.officialTargets.starknet.token", "step6.identityRegistry.starknet.token", {
    exactAddressMatches: data.step13.officialTargets?.starknet?.token === starknetRegistry?.identifier,
    step6ClaimRecordedUnverified: starknetRegistry?.provenance === "recordedOfficialRegistryAssertion" && starknetRegistry?.fetchedByScanner === false,
    sourceMetadataPresent: typeof starknetRegistry?.sourceUrl === "string" && typeof starknetRegistry?.accessedDate === "string",
  }, "promotion-eligible-address-identity; external official claim remains recorded-unverified"));
  const step12ByChain = new Map(data.step12.chains.map(row => [row.fixedPoint.chainId, row]));
  rows.push(bindingRow("step12-denoms-to-step6-recorded-assertions", "step12.chains[].denom", "step6.identityRegistry cosmos/babylon denoms", {
    cosmosDenomMatches: step12ByChain.get("cosmoshub-4")?.denom === cosmosRegistry?.identifier,
    babylonDenomMatches: step12ByChain.get("bbn-1")?.denom === babylonRegistry?.identifier,
    claimsRecordedUnverified: [cosmosRegistry, babylonRegistry].every(row => row?.provenance === "recordedOfficialRegistryAssertion" && row?.fetchedByScanner === false),
  }, "promotion-eligible-denom-identity; external official claims remain recorded-unverified"));
  for (const [chainId, label] of [["cosmoshub-4", "cosmos-hub"], ["bbn-1", "babylon"]]) {
    const chain = step12ByChain.get(chainId);
    rows.push(bindingRow(`step12-${label}-independent-height-identity-trace-reconstruction`, `step12.chains[${chainId}]`, "independently-derived-canonical-height-identity-and-trace-hash", step12RowChecks(chain, chainId)));
  }
  rows.push(bindingRow("step13-sui-targets-to-step6-recorded-assertions", "step13.officialTargets.sui", "step6.identityRegistry.sui", {
    coinObjectMatches: data.step13.officialTargets?.sui?.coinObject === suiKinds.get("coinObject"),
    packageMatches: data.step13.officialTargets?.sui?.package === suiKinds.get("package"),
    controlTreasuryMatches: data.step13.officialTargets?.sui?.controlTreasury === suiKinds.get("controlTreasury"),
    resolvedTypeUsesMatchedPackage: [suiKinds.get("coinObject"), suiKinds.get("package")].some(id => data.step13.results.find(row => row.ecosystem === "Sui")?.exactCoinType?.toLowerCase().startsWith(`${id?.toLowerCase()}::`)),
  }, "promotion-eligible-object/type identity; external official claims remain recorded-unverified"));
  rows.push(bindingRow("step14-local-seed-provenance-context", "step14.chains/address provenance", "final coverage associations", {
    allResolvedAssociationsLocalSeed: data.step14.chains.filter(row => row.resolved).every(row => row.addressAssociation === "localDeploymentSeed"),
    noOfficialJoinPromoted: data.step14.chains.every(row => row.officialJoinVerified === false),
    sourceCommitConsistentWithinArtifact: data.step14.chains.every(row => row.sourceCommit === data.step14.provenance?.localMainnetConfig?.sourceCommit),
  }, "coverage-association-context-only; source file not independently revalidated by final scanner"));
  return { validated: true, rowCount: rows.length, checksPassed: rows.reduce((sum, row) => sum + Object.values(row.checks).filter(Boolean).length, 0), rows };
}
function deterministicGeneratedAt(manifest) {
  const times = manifest.map(row => Date.parse(row.generatedAt || "")).filter(Number.isFinite);
  invariant(times.length > 0, "deterministic-generated-at-input");
  return new Date(Math.max(...times)).toISOString();
}
function liabilityBucket(component, role) {
  if (/IBCVoucher/i.test(component) || role === "ibc-voucher") return "ibc-voucher";
  if (/NativeLBTC/i.test(component) || role === "btc-b-token") return "native-lbtc-btc-b";
  return "canonical-token";
}
function fixedIdentity(point) {
  if (!point) return "unresolved";
  return [point.chainId ?? "", point.blockNumber ?? point.number ?? point.height ?? point.slot ?? point.checkpoint ?? point.blockTag ?? "", point.blockHash ?? point.hash ?? point.digest ?? ""].join(":").toLowerCase();
}
function representationKey(row) {
  return [row.representation, row.chainId ?? row.chain, row.address ?? "", row.component, fixedIdentity(row.fixedPoint)].join("|").toLowerCase();
}
function validateRepresentationUniqueness(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = representationKey(row), canonical = JSON.stringify(stable(row));
    invariant(!byKey.has(key), byKey.get(key) === canonical ? "duplicate-representation" : "conflicting-representation");
    byKey.set(key, canonical); row.representationKey = key;
  }
  return { rowsChecked: rows.length, uniqueKeys: byKey.size, duplicates: 0, conflicts: 0 };
}
function buildEvmLiabilities(step5, step14) {
  const rows = [];
  for (const source of step5.evmBaseline.rows) {
    if (source.rawSupply === null || !/^(?:StakedLBTC|NativeLBTC|IBCVoucher)$/.test(source.component)) continue;
    const row = {
      representation: "evm-token-supply", sourceArtifact: "step4-via-step5-normalized-row",
      chain: source.chainName, chainId: source.chainId, address: source.address.toLowerCase(), component: source.component,
      liabilityClass: liabilityBucket(source.component), rawSupply: source.rawSupply, decimals: 8,
      displaySupply: source.decimalSupply, fixedPoint: source.fixedPoint, unitConversionEligible: false,
      aggregationTreatment: "preserve-representation-no-global-sum", railDedupStatus: source.deduplicationStatus || "unresolved",
      provenance: source.provenance,
    };
    if (source.chainId === 1 && source.component === "StakedLBTC") {
      invariant(source.adjustedBtcLiabilityCeiling === "8771.74409737", "ethereum-adjusted-ceiling-exact");
      row.adjustedLiabilityCeiling = {
        value: "8771.74409737", units: "BTC-like-at-step4-rate-only", formula: source.formula,
        assumptions: source.assumptions,
        caveat: "Exact step4 Ethereum rate/block/time context only; stale exchange-rate acceptance threshold unknown; not merged with later fixed points.",
      };
    }
    rows.push(row);
  }
  for (const chain of step14.chains) for (const address of chain.addresses || []) {
    if (!address.supply) continue;
    invariant(["canonical-token", "btc-b-token"].includes(address.category), "step14-nontoken-supply");
    invariant(!/Adapter|Oracle|Pool|Bascule|Mailbox|Consortium|Bridge/i.test(address.component), "step14-adapter-supply");
    rows.push({
      representation: "evm-token-supply", sourceArtifact: "step14", chain: chain.name,
      chainId: chain.expectedChainId, address: address.address.toLowerCase(), component: address.component,
      liabilityClass: liabilityBucket(address.component, address.supply.role), rawSupply: address.supply.raw,
      decimals: address.supply.decimals, displaySupply: address.supply.display, fixedPoint: chain.pin,
      addressProvenance: address.supply.provenance, unitConversionEligible: false,
      aggregationTreatment: "preserve-representation-no-global-sum", railDedupStatus: "unresolved",
    });
  }
  return rows;
}
function buildNonEvmLiabilities(step12, step13, step14) {
  const rows = [], sui = step13.results.find(row => row.ecosystem === "Sui"), starknet = step13.results.find(row => row.ecosystem === "Starknet");
  rows.push({
    representation: "sui-token-supply", sourceArtifact: "step13", chain: "Sui", component: sui.exactCoinType,
    liabilityClass: "canonical-token", rawSupply: sui.supply.raw, decimals: sui.supply.decimals, displaySupply: null,
    fixedPoint: sui.fixedPoint, observationCaveat: "Exact TreasuryCap schema observed in an unpinned legacy-read window around the checkpoint; not same-checkpoint state.",
    unitConversionEligible: false, aggregationTreatment: "preserve-representation-no-global-sum",
  });
  rows.push({
    representation: "starknet-token-supply", sourceArtifact: "step13", chain: "Starknet",
    component: step13.officialTargets.starknet.token, officialTokenAddress: step13.officialTargets.starknet.token,
    liabilityClass: "canonical-token", rawSupply: starknet.supply.raw, decimals: starknet.supply.decimals,
    displaySupply: null, fixedPoint: starknet.fixedPoint,
    observationCaveat: "Supply and ABI calls were fixed-block, but not synchronized with other chains.",
    unitConversionEligible: false, aggregationTreatment: "preserve-representation-no-global-sum",
  });
  for (const chain of step12.chains) rows.push({
    representation: "ics20-bank-voucher", sourceArtifact: "step12", chain: chain.name, component: chain.denom,
    liabilityClass: "ibc-voucher", rawSupply: chain.supply.amount, decimals: null, displaySupply: null,
    fixedPoint: chain.fixedPoint, traceStatus: chain.trace.status, traceHashVerified: chain.trace.hashVerified,
    tracePath: chain.trace.path ?? null, observationCaveat: "Decimals unknown; no conversion or addition to EVM/native units.",
    unitConversionEligible: false, aggregationTreatment: "preserve-voucher-raw-units",
  });
  rows.push({
    representation: "solana-token-supply", sourceArtifact: "step13", chain: "Solana", component: step13.officialTargets.solana.mint,
    liabilityClass: "canonical-token", rawSupply: null, decimals: null, displaySupply: null, fixedPoint: null,
    status: "unknown-chain-identity-unresolved", aggregationTreatment: "unknown-not-summed",
  });
  const corn = step14.chains.find(chain => chain.name === "Corn Maizenet");
  invariant(corn && !corn.resolved, "corn-unresolved-semantic");
  rows.push({
    representation: "evm-token-supply", sourceArtifact: "step14", chain: "Corn Maizenet", chainId: 21000000,
    component: "localDeploymentSeed-token", liabilityClass: "canonical-token", rawSupply: null, decimals: null,
    displaySupply: null, fixedPoint: null, status: "unknown-chain-identity-unresolved", aggregationTreatment: "unknown-not-summed",
  });
  return rows;
}
function buildBridgeContext(step5, step12, step14) {
  const step5Rows = step5.evmBaseline.rows.filter(row => row.adapterMode !== null || /Adapter|TokenPool|Bridge/i.test(row.component || ""));
  const step14Rows = step14.chains.flatMap(chain => (chain.addresses || [])
    .filter(row => ["bridge-adapter", "bridge", "router", "mailbox"].includes(row.category))
    .map(row => ({ sourceArtifact: "step14", chain: chain.name, chainId: chain.expectedChainId, component: row.component, category: row.category, fixedPoint: chain.pin, codePresent: row.code?.present === true, mode: row.bridgeMode })));
  return {
    aggregationAllowed: false, globalSum: null,
    observations: [
      ...step5Rows.map(row => ({ sourceArtifact: "step5", chain: row.chainName, chainId: row.chainId, component: row.component, rail: row.rail, adapterMode: row.adapterMode, fixedPoint: row.fixedPoint, supplyIncludedAsLiability: false })),
      ...step14Rows,
      { sourceArtifact: "step12", chain: "EVM intermediary", component: step12.localEvmMode.component, mode: step12.localEvmMode.classification, sourceVerified: step12.aggregateMetrics.localEvmModeSourceVerifiedRows === 1, linkedToRemoteVoucher: false },
    ],
    gaps: ["Adapter/pool balances are not liabilities and are not summed.", "Burn/mint, lock/escrow, voucher replacement, and in-flight topology are not completely linked.", "Current in-flight amounts are unknown.", "Bridge modes verified for remote IBC rows remain zero."],
    currentInFlightAmount: null,
    railDedupComplete: false,
  };
}
function deriveCoverage(step4, step14) {
  const configured = step4.chains.map(chain => ({ key: chain.name, chainId: chain.chainId }));
  invariant(configured.length === 19 && new Set(configured.map(row => row.chainId)).size === 19, "coverage-configured-identities");
  const configuredIds = new Set(configured.map(row => row.chainId));
  const original = step4.chains.filter(chain => checkFixedPoint(chain.pin)).map(chain => chain.chainId);
  const additions = step14.chains.filter(chain => chain.resolved).map(chain => chain.observedChainId);
  invariant(original.length === 13 && additions.length === 5, "coverage-source-counts");
  invariant(new Set(original).size === original.length && new Set(additions).size === additions.length, "coverage-source-uniqueness");
  invariant(additions.every(id => configuredIds.has(id)), "coverage-addition-configured-join");
  invariant(additions.every(id => !original.includes(id)), "coverage-additions-disjoint");
  const resolvedStep14 = step14.chains.filter(chain => chain.resolved);
  invariant(resolvedStep14.every(chain => chain.addressAssociation === "localDeploymentSeed" && chain.officialJoinVerified === false), "coverage-step14-provenance");
  const union = new Set([...original, ...additions]);
  invariant(union.size === 18, "coverage-derived-18");
  return {
    configuredDenominator: configured.length, step4ResolvedIdentities: original.length,
    step14NewDisjointResolvedIdentities: additions.length, unionResolvedIdentities: union.size,
    localConfigurationIdentityCoverageAcrossNonSimultaneousRuns: `${union.size}/${configured.length}`,
    currentSynchronizedCoverage: "unknown", normalizedIdentityKind: "numeric-chain-id",
    step14Associations: resolvedStep14.map(chain => ({ chain: chain.name, chainId: chain.observedChainId, association: "localDeploymentSeed", officialRegistryVerified: false })),
    independentlyOfficialRegistryVerifiedStep14Associations: 0,
    derivationChecks: { configuredUnique: true, step4AndStep14Disjoint: true, step14JoinsConfiguredIdentity: true, unionDerivedNotHardcoded: true },
  };
}
function compactPoint(value) { return isObject(value) ? stable(value) : null; }
function buildTimeMatrix(d) {
  return [
    { artifact: "step4", generatedAt: d.step4.generatedAt, fixedPoints: d.step4.chains.map(chain => ({ chain: chain.chainName || chain.name, pin: compactPoint(chain.pin) })) },
    { artifact: "step5", generatedAt: d.step5.generatedAt ?? null, snapshotLabel: d.step5.snapshotLabel, fixedPoints: [...new Map(d.step5.evmBaseline.rows.filter(row => row.fixedPoint).map(row => [`${row.fixedPoint.chainId}:${row.fixedPoint.blockNumber}`, row.fixedPoint])).values()] },
    { artifact: "step6", generatedAt: d.step6.generatedAt, fixedPoints: d.step6.results.map(row => ({ chain: row.ecosystem, fixedPoint: compactPoint(row.fixedPoint), observationWindow: compactPoint(row.observationWindow) })), window: compactPoint(d.step6.anchorTimestampWindow) },
    { artifact: "step7", generatedAt: d.step7.generatedAt, fixedPoints: [{ chain: "Base", fixedPoint: compactPoint(d.step7.base?.fixedBlock) }, ...d.step7.oracles.map(row => ({ chain: row.ecosystem, fixedPoint: compactPoint(row.fixedBlock) })), ...d.step7.ibc.map(row => ({ chain: row.ecosystem, fixedPoint: compactPoint(row.anchor) }))] },
    { artifact: "step8", generatedAt: d.step8.generatedAt, fixedPoints: [{ chain: "Base", fixedPoint: compactPoint(d.step8.base.fixedBlock) }] },
    { artifact: "step9", generatedAt: d.step9.generatedAt, fixedPoints: [{ chain: "Base", bindingToStep8: d.step9.step8Binding.passed }] },
    { artifact: "step10", generatedAt: d.step10.generatedAt, fixedPoints: [{ chain: "Base", fixedPoint: compactPoint(d.step10.currentRun.base.fixedBlock) }, { chain: "Bitcoin", selectedBlock: null, preTips: compactPoint(d.step10.currentRun.bitcoin.preTips) }] },
    { artifact: "step11", generatedAt: d.step11.generatedAt, fixedPoints: [{ chain: "Babylon", fixedPoint: compactPoint(d.step11.currentRun.fixedPoint), snapshotBinding: compactPoint(d.step11.currentRun.stateSnapshotBinding), btcTip: compactPoint(d.step11.currentRun.btcLightClientTip) }] },
    { artifact: "step12", generatedAt: d.step12.generatedAt, fixedPoints: d.step12.chains.map(row => ({ chain: row.name, fixedPoint: compactPoint(row.fixedPoint), binding: compactPoint(row.binding) })) },
    { artifact: "step13", generatedAt: d.step13.generatedAt, fixedPoints: d.step13.results.map(row => ({ chain: row.ecosystem, fixedPoint: compactPoint(row.fixedPoint), window: compactPoint(row.observationWindow) })), window: compactPoint(d.step13.anchorWindow) },
    { artifact: "step14", generatedAt: d.step14.generatedAt, fixedPoints: d.step14.chains.map(row => ({ chain: row.name, pin: compactPoint(row.pin) })) },
  ];
}
function finalGates() {
  return {
    numeratorComplete: false, liabilityCoverageComplete: false, railDedupComplete: false,
    ownershipVerified: false, sameTimeReconciliation: false, evidenceComplete: false,
    closureEligible: false, solvencyRatio: null, routePositive: 0,
    routeEvidenceStatus: "unknown", executableNow: 0, signedActionJustified: false,
    forkJustified: false, confirmedExploit: false, insolvencyProven: false,
  };
}
function assertFinalGates(gates) {
  invariant(gates.numeratorComplete === false, "gate-numerator");
  invariant(gates.liabilityCoverageComplete === false, "gate-liability");
  invariant(gates.railDedupComplete === false, "gate-dedup");
  invariant(gates.ownershipVerified === false, "gate-ownership");
  invariant(gates.sameTimeReconciliation === false, "gate-same-time");
  invariant(gates.evidenceComplete === false && gates.closureEligible === false, "gate-evidence-closure");
  invariant(gates.solvencyRatio === null, "gate-solvency");
  invariant(gates.routePositive === 0 && gates.routeEvidenceStatus === "unknown", "gate-route");
  invariant(gates.executableNow === 0 && gates.signedActionJustified === false && gates.forkJustified === false, "gate-action");
  invariant(gates.confirmedExploit === false && gates.insolvencyProven === false, "gate-findings");
}
function renderReport(raw) {
  const lines = [
    "# Lombard LBTC Final Reconciliation — Step 15", "", `**Classification:** ${raw.classification}`, "",
    "Artifact-only and zero-network. Representation, unit, rail, provenance, and fixed-point boundaries are preserved; no global liability sum or solvency ratio is calculated.", "",
    `Validation: root schemas=${raw.metrics.rootSchemasValidated}/${raw.metrics.inputCount}; promoted schemas=${raw.metrics.promotedInputSchemasValidated}/${raw.metrics.inputCount}; semantic checks=${raw.metrics.validationChecksPassed}; cross-artifact binding rows/checks=${raw.metrics.crossArtifactBindingRowsValidated}/${raw.metrics.crossArtifactBindingChecksPassed}.`, "",
    "## Established observations", "- PoR executable runtime matches pinned source after metadata stripping.",
    "- Two ICS-20 trace hashes are verified; Sui and Starknet supplies were observed with explicit timing caveats.",
    "- Direct reconciliation inputs are steps 4-14. Steps 1-3 conclusions are contextual/transitively consumed by earlier artifacts but are not revalidated or claimed cryptographically bound by this final scanner.", "",
    "## Liability representations", "| Populated liability class | Rows | Known raw rows | Treatment |", "|---|---:|---:|---|",
    ...raw.liabilityRepresentations.classSummary.map(row => `| ${row.liabilityClass} | ${row.rows} | ${row.knownRawRows} | no global/cross-class sum |`), "",
    "## Bridge, escrow, and transit context", `- Context observations=${raw.bridgeEscrowTransitContext.observations.length}; current in-flight amount=null; railDedupComplete=false.`,
    ...raw.bridgeEscrowTransitContext.gaps.map(gap => `- ${gap}`), "",
    "## Backing assets", "| Evidence | Result |", "|---|---|",
    `| PoR registry | list=${raw.backingAssets.por.publishedListLength}; complete=${raw.backingAssets.por.completeRegistryVerification}; ownership rows=${raw.backingAssets.por.cryptographicOwnershipRows} |`,
    "| Bitcoin pilot | anchored UTXO observation unavailable; amount=null (not a zero-reserve observation) |",
    `| Babylon | official FP keys=${raw.backingAssets.babylon.officialLombardFpKeys}; attributable sat=null; candidate complete=${raw.backingAssets.babylon.candidateDelegationComplete} |`,
    "| Custody/stake/unbonding/transit/slashing | unknown |", "",
    "## Coverage (non-simultaneous local configuration identities)",
    `- step4=${raw.coverage.step4ResolvedIdentities}/19; step14 new disjoint joins=${raw.coverage.step14NewDisjointResolvedIdentities}; localConfigurationIdentityCoverageAcrossNonSimultaneousRuns=${raw.coverage.localConfigurationIdentityCoverageAcrossNonSimultaneousRuns}.`,
    "- This 18/19 union is not synchronized current coverage and the five step14 associations are local deployment seeds, not independently verified official-registry joins.",
    `- Current synchronized coverage=${raw.coverage.currentSynchronizedCoverage}; official-registry-verified step14 associations=${raw.coverage.independentlyOfficialRegistryVerifiedStep14Associations}.`,
    `- Solana=${raw.crossEcosystemCoverage.solana}; Sui=${raw.crossEcosystemCoverage.sui}; Starknet=${raw.crossEcosystemCoverage.starknet}; Corn=${raw.crossEcosystemCoverage.corn}; IBC traces=2/2; bridge modes=0.`, "",
    "## Limitations and trust observations (not vulnerabilities)", ...raw.findingsAndTrustObservations.map(row => `- **${row.kind}:** ${row.observation}`), "",
    "## Exact blockers", ...raw.blockers.map(blocker => `- ${blocker}`), "",
    "## Continuation priority", ...raw.continuationPriority.map((item, index) => `${index + 1}. ${item}`), "",
    "## Final gates", "```json", JSON.stringify(raw.gates, null, 2), "```", "",
    "routePositive=0 means zero proven positive routes; route evidence remains unknown. No confirmed exploit, insolvency, CLEAN conclusion, or vulnerability promotion.", "",
  ];
  return lines.join("\n");
}
function renderHandoff(raw) {
  return [
    "# Coordinator Handoff — Lombard LBTC Step 15 — 2026-07-12", "",
    `- Final classification: **${raw.classification}**`,
    `- Direct inputs=${raw.metrics.inputCount} (steps 4-14); semantic checks=${raw.metrics.validationChecksPassed}; cross-artifact binding checks=${raw.metrics.crossArtifactBindingChecksPassed}; liability rows=${raw.metrics.liabilityRows}; populated liability classes=${raw.metrics.populatedLiabilityClassCount}.`,
    `- localConfigurationIdentityCoverageAcrossNonSimultaneousRuns=${raw.coverage.localConfigurationIdentityCoverageAcrossNonSimultaneousRuns}; current synchronized coverage=unknown; step14 official-registry joins verified=0.`,
    "- sameTimeReconciliation=false; solvencyRatio=null; routePositive=0 means no proven positive route and route evidence remains unknown.",
    "- No confirmed exploit, insolvency, CLEAN conclusion, vulnerability promotion, transaction, fork, or signed action.", "",
    "## Continuation priority", ...raw.continuationPriority.map((item, index) => `${index + 1}. ${item}`), "",
    "Private inventory use or user-provided archival Bitcoin/indexer access requires explicit current-turn authorization.", "",
    "## Final gates", `\`${JSON.stringify(raw.gates)}\``, "",
  ].join("\n");
}
function atomic(rel, text) {
  const target = path.join(ROOT, rel), temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, text, "utf8"); fs.renameSync(temp, target);
}
function countPassedChecks(manifest) {
  return manifest.reduce((count, input) => count
    + Object.values(input.validationChecks.root).filter(Boolean).length
    + Object.values(input.validationChecks.promotedFields).filter(Boolean).length, 0);
}
function main() {
  const { data, manifest } = loadInputs();
  const crossArtifactBindingsValidated = validateCrossArtifactBindings(data, manifest);
  const evmRows = buildEvmLiabilities(data.step5, data.step14);
  const nonEvmRows = buildNonEvmLiabilities(data.step12, data.step13, data.step14);
  const liabilityRows = [...evmRows, ...nonEvmRows];
  const uniqueness = validateRepresentationUniqueness(liabilityRows);
  const liabilityClasses = ["canonical-token", "native-lbtc-btc-b", "ibc-voucher"];
  const classSummary = liabilityClasses.map(liabilityClass => ({
    liabilityClass,
    rows: liabilityRows.filter(row => row.liabilityClass === liabilityClass).length,
    knownRawRows: liabilityRows.filter(row => row.liabilityClass === liabilityClass && row.rawSupply !== null).length,
    total: null, aggregationAllowed: false,
  }));
  invariant(classSummary.every(row => row.rows > 0), "liability-class-population");
  invariant(liabilityRows.every(row => liabilityClasses.includes(row.liabilityClass)), "liability-taxonomy");
  const coverage = deriveCoverage(data.step4, data.step14);
  const gates = finalGates(); assertFinalGates(gates);
  const backingAssets = {
    por: {
      executableSourceMatch: data.step9.conclusion.sourceRuntimeClassification.includes("EXECUTABLE RUNTIME MATCH"),
      cryptographicOwnershipRows: data.step8.metrics.cryptographicOwnershipVerifiedRows,
      completeRegistryVerification: data.step8.metrics.completeRegistryVerified,
      publishedListLength: data.step8.metrics.listLength,
      verifierSemanticsSpecified: data.step8.metrics.attestationFormatSpecified,
    },
    bitcoinListedUtxos: {
      status: "anchored-observation-unavailable", observedRows: null, observedSatoshis: null,
      retainedRowsAfterUnavailableAnchor: data.step10.currentRun.bitcoin.utxos.retained,
      selectedAnchorBlock: data.step10.currentRun.bitcoin.selectedBlock, ownershipVerified: false,
      interpretation: "No reserve-zero inference is permitted.",
    },
    babylon: {
      officialLombardFpKeys: data.step11.currentRun.attribution.officialLombardFpKeys,
      attributableLombardSat: data.step11.currentRun.attribution.attributableLombardSat,
      candidateDelegationComplete: data.step11.currentRun.candidateDelegations.complete,
      activeSat: null, unbondingSat: null, slashedSat: null,
    },
    custody: { liquidAmount: null, spendControlVerified: false },
    globalBackingTotal: null, aggregationAllowed: false,
  };
  const blockers = [
    "Bitcoin anchored UTXO observation is unavailable because the step10 anchor block was unavailable; no zero-reserve inference is permitted.",
    "PoR registry coverage and cryptographic ownership verification are incomplete; verifier semantics/test vectors are absent.",
    "Official Lombard Babylon finality-provider keys are absent; self-described candidates are not attribution.",
    "Babylon candidate delegation pagination is incomplete; active, unbonding, slashing, and attributable amounts remain unknown.",
    "Canonical, Native/BTC.b, IBC voucher, adapter/escrow, and in-flight rails are not mode-aware deduplicated.",
    "Solana and Corn supply remain unresolved; Sui is not checkpoint-pinned.",
    "EVM, non-EVM, IBC, Bitcoin, PoR, and Babylon observations are from non-simultaneous fixed points/windows.",
    "Custody, liquid, staked, unbonding, transit, and slashing amounts are unknown.",
    "Exchange-rate oracle acceptance/freshness threshold is unknown; adjusted ceilings remain exact-step caveated only.",
    "Current synchronized configuration and liability coverage is unknown.",
  ];
  const continuationPriority = [
    "Establish the authoritative deployment/token and reserve perimeter, including independently verified official registry snapshots.",
    "Resolve bridge/escrow/burn-mint/voucher/transit topology and mode-aware rail deduplication.",
    "Obtain the PoR verifier specification/test vectors and authoritative ownership/finality-provider mappings.",
    "Complete Bitcoin UTXO and Babylon active/unbonding/slashing evidence at explicit anchors.",
    "Run synchronized or explicitly bounded-skew reconciliation only after the dependency perimeter is complete.",
  ];
  const raw = {
    generatedAt: deterministicGeneratedAt(manifest), scanner: "tools/scan-lombard-lbtc-final-reconciliation.js",
    classification: CLASSIFICATION,
    execution: { networkCalls: 0, artifactOnly: true, deterministic: true, privateInventoryRead: false, envRead: false, secretsRead: false },
    inputModel: { directInputs: "steps4-14", steps1To3Treatment: "contextual-transitively-consumed-by-earlier-artifacts-not-revalidated-or-claimed-cryptographically-bound-by-final-scanner", inputs: manifest },
    crossArtifactBindingsValidated,
    liabilityRepresentations: { globalSum: null, globalSumAttempted: false, rows: liabilityRows, classSummary, populatedLiabilityClassCount: classSummary.length },
    bridgeEscrowTransitContext: buildBridgeContext(data.step5, data.step12, data.step14),
    backingAssets, coverage,
    crossEcosystemCoverage: { solana: "unresolved", sui: "observed-unpinned-supply", starknet: "observed-fixed-block-supply", corn: "unresolved", ibcTraceVerifiedRows: 2, bridgeModeVerifiedRows: 0 },
    timeMatrix: { sameTimeReconciliation: false, globalSkew: null, globalSkewReason: "No common cut: distinct chains, fixed points, finality levels, and unpinned windows.", artifacts: buildTimeMatrix(data) },
    findingsAndTrustObservations: [
      { kind: "trust assumption", observation: "PoR is an opaque privileged registry and exposes no verifier semantics sufficient for cryptographic ownership proof." },
      { kind: "proven source/runtime fact", observation: "Pinned PoR source reproducibly matches deployed executable runtime after metadata stripping; metadata differs." },
      { kind: "attribution limitation", observation: "Babylon candidates are self-described and are not official Lombard attribution." },
      { kind: "oracle limitation", observation: "The exchange-rate oracle was observed, but its acceptable freshness threshold remains unknown." },
      { kind: "rail limitation", observation: "Bridge burn/mint, lock/escrow, voucher replacement, adapter balances, and in-flight treatment are not fully linked or deduplicated." },
      { kind: "evidence limitation", observation: "Registry coverage, Bitcoin UTXOs, custody/spend control, and synchronized backing joins remain incomplete." },
    ],
    blockers, continuationPriority, gates, uniqueness,
    metrics: {
      inputCount: manifest.length, rootSchemasValidated: manifest.length, promotedInputSchemasValidated: manifest.length,
      validationChecksPassed: countPassedChecks(manifest), crossArtifactBindingRowsValidated: crossArtifactBindingsValidated.rowCount,
      crossArtifactBindingChecksPassed: crossArtifactBindingsValidated.checksPassed, liabilityRows: liabilityRows.length,
      evmLiabilityRows: evmRows.length, nonEvmLiabilityRows: nonEvmRows.length,
      populatedLiabilityClassCount: classSummary.length, knownRawSupplyRows: liabilityRows.filter(row => row.rawSupply !== null).length,
      bridgeContextRows: buildBridgeContext(data.step5, data.step12, data.step14).observations.length,
      backingAssetSections: Object.keys(backingAssets).filter(key => !["globalBackingTotal", "aggregationAllowed"].includes(key)).length,
      adapterLiabilityRows: liabilityRows.filter(row => /Adapter|Oracle|Pool/i.test(row.component || "")).length,
      fullyReconciledLiabilityRows: 0,
    },
    establishedObservations: { porExecutableSourceMatch: true, ibcTraceVerifiedRows: 2, suiSupplyObserved: true, starknetSupplyObserved: true },
    notProven: { globalLiabilityTotal: true, globalBackingTotal: true, solvency: true, insolvency: true, ownership: true, sameTimeReconciliation: true, confirmedExploit: true },
    conclusion: { clean: false, vulnerabilityPromoted: false, confirmedExploit: false, insolvencyProven: false, permissionlessInvariantViolationProven: false, globalBackingSolvencyResolved: false },
  };
  invariant(raw.metrics.adapterLiabilityRows === 0, "assert-no-adapter-liabilities");
  invariant(raw.crossArtifactBindingsValidated.validated === true && raw.crossArtifactBindingsValidated.rows.every(row => row.validated), "assert-cross-artifact-bindings");
  invariant(raw.liabilityRepresentations.globalSum === null && raw.backingAssets.globalBackingTotal === null, "assert-no-global-sums");
  invariant(raw.timeMatrix.sameTimeReconciliation === false && raw.timeMatrix.globalSkew === null, "assert-no-stale-merge");
  invariant(raw.coverage.localConfigurationIdentityCoverageAcrossNonSimultaneousRuns === "18/19", "assert-derived-coverage");
  invariant(raw.backingAssets.por.executableSourceMatch === true && raw.backingAssets.por.publishedListLength === 28973, "assert-por");
  invariant(raw.backingAssets.bitcoinListedUtxos.observedRows === null && raw.backingAssets.bitcoinListedUtxos.observedSatoshis === null, "assert-utxo-unavailable");
  invariant(raw.backingAssets.babylon.officialLombardFpKeys === 0 && raw.backingAssets.babylon.attributableLombardSat === null && raw.backingAssets.babylon.candidateDelegationComplete === false, "assert-babylon");
  assertFinalGates(raw.gates);
  const rawText = serialize(raw), reportText = renderReport(raw), handoffText = renderHandoff(raw);
  atomic(RAW_REL, rawText); atomic(REPORT_REL, reportText); atomic(HANDOFF_REL, handoffText);
  process.stdout.write(`rawSha256=${sha256(rawText)} reportSha256=${sha256(reportText)} handoffSha256=${sha256(handoffText)} scannerSha256=${sha256(fs.readFileSync(__filename))} inputs=${manifest.length} rootValidated=${raw.metrics.rootSchemasValidated} promotedValidated=${raw.metrics.promotedInputSchemasValidated} semanticChecks=${raw.metrics.validationChecksPassed} crossBindingRows=${raw.metrics.crossArtifactBindingRowsValidated} crossBindingChecks=${raw.metrics.crossArtifactBindingChecksPassed} liabilityRows=${liabilityRows.length} populatedLiabilityClasses=${classSummary.length} bridgeContextRows=${raw.metrics.bridgeContextRows} backingSections=${raw.metrics.backingAssetSections} unique=${uniqueness.uniqueKeys} duplicates=0 conflicts=0 coverage=${raw.coverage.localConfigurationIdentityCoverageAcrossNonSimultaneousRuns} sameTime=false solvencyRatio=null blockers=${blockers.length} assertions=passed networkCalls=0\n`);
}
try { main(); }
catch (error) {
  const message = typeof error?.message === "string" && /^(?:semantic-validation|coverage-|duplicate-|conflicting-|gate-|assert-|liability-|step14-|ethereum-|corn-|deterministic-)/.test(error.message) ? error.message : "validation-rejected";
  process.stderr.write(`scan-lombard-lbtc-final-reconciliation failed: ${message}\n`); process.exitCode = 1;
}
