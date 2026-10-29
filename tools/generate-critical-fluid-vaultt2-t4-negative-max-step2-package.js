#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const runner = require("./run-critical-fluid-vaultt2-t4-negative-max-step2.js");

const ROOT = path.resolve(__dirname, "..");
const PREFIX = "reports/raw/fast/critical-fluid-vaultt2-t4-negative-max-step2";
const CAPTURE = `${PREFIX}-capture.json`;
const RESULT = `${PREFIX}.json`;
const REPORT = "reports/critical-fluid-vaultt2-t4-negative-max-step2.md";
const MANIFEST = `${PREFIX}-manifest.json`;
const CHECK_ONLY = process.argv.includes("--check-only");

const absolute = relative => path.join(ROOT, ...relative.split("/"));
const read = relative => fs.readFileSync(absolute(relative));
const json = relative => JSON.parse(read(relative).toString("utf8"));
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");

function sums(chains, getter) {
  return chains.reduce((total, chain) => total + (getter(chain) || 0), 0);
}

function buildResult(capture) {
  const chains = capture.chains;
  const callerCategories = {
    directEoa: sums(chains, chain => chain.history?.transactionLevelDecodedCallerCategories?.directEoa),
    contractIntegration: sums(chains, chain => chain.history?.transactionLevelDecodedCallerCategories?.contractIntegration),
    knownLocalIntegrationContract: sums(chains, chain => chain.history?.transactionLevelDecodedCallerCategories?.knownLocalIntegrationContract),
    unresolved: sums(chains, chain => chain.history?.transactionLevelDecodedCallerCategories?.unresolved)
  };
  const current = {
    uniqueDexPoolsByChainSum: sums(chains, chain => chain.current?.uniqueDexPools),
    smartCollateralEnabledPoolsByChainSum: sums(chains, chain => chain.current?.smartCollateralEnabledPools),
    smartCollateralDisabledPoolsByChainSum: sums(chains, chain => chain.current?.smartCollateralDisabledPools),
    swapAndArbitragePausedPoolsByChainSum: sums(chains, chain => chain.current?.swapAndArbitragePausedPools),
    nativeToken1Vaults: sums(chains, chain => chain.vaults?.linkage?.nativeToken1),
    erc20Token1Vaults: sums(chains, chain => chain.vaults?.linkage?.erc20Token1),
    liquidityNormalChains: chains.filter(chain => chain.current?.liquidityNormal === true).length
  };
  return {
    schemaVersion: 3,
    findingId: capture.findingId,
    generatedFromCaptureAt: capture.generatedAt,
    classification: capture.classification,
    severity: "conditional-low",
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    fork: false,
    partialArtifactDisposition: capture.reconciliation,
    coverage: {
      localManifestVaults: 99,
      resolverVaultT2: capture.aggregate.vaultT2,
      resolverVaultT4: capture.aggregate.vaultT4,
      resolverVaultT2T4: capture.aggregate.vaultT2T4,
      locallyManifestedMatched: sums(chains, chain => chain.vaults?.linkage?.localManifestMatched),
      resolverOnlyOrLocallyMissing: sums(chains, chain => chain.vaults?.linkage?.localManifestMissing),
      chainsPinned: capture.aggregate.chainsPinned,
      chainsTerminalExact: capture.aggregate.chainsTerminalExact,
      twoHostnameFamilyPinChains: capture.aggregate.twoFamilyPinnedChains,
      oneFamilyPinChains: capture.aggregate.chainsPinned - capture.aggregate.twoFamilyPinnedChains,
      backendIndependenceClaimed: false,
      runtimeStateFamilyBinding: "single-family observations at each fixed pin; two-family runtime-state agreement not claimed"
    },
    runtimeObservation: {
      architecture: "immutable-selector-router-with-delegatecall-operate-implementation-not-EIP1967",
      vulnerableShapedPredicateSignatureObserved: capture.aggregate.vulnerableShapedPredicateSignatureObserved,
      patchedShapedPredicateSignatureObserved: capture.aggregate.patchedShapedPredicateSignatureObserved,
      predicateShapeUnknown: capture.aggregate.predicateShapeUnknown,
      deployedOperatePerfectSemanticsBound: capture.aggregate.deployedOperatePerfectSemanticsBound,
      deployedOperatePerfectSemanticsUnbound: capture.aggregate.deployedOperatePerfectSemanticsUnbound,
      classification: "vulnerable-shaped predicate signature observed; deployed operatePerfect semantics unbound",
      selectorControlFlowAnchoredProofRetained: false,
      observedOperateRuntimeCodeCommitmentSha256: null,
      observedVaultCoreRuntimeCodeCommitmentSha256: null,
      observedRuntimeCommitmentsRetained: false,
      observedRuntimeCommitmentReason: "Actual observed runtime bytes/code hashes were not persisted by the retained capture; template hashes are reference evidence only and are not deployed commitments.",
      method: "unanchored unique byte-pattern differential against two explicitly retained deployment artifacts",
      wholeRuntimeEqualityClaimed: false,
      sourceBinding: capture.sourceBinding
    },
    history: {
      primaryFamilyOperateLogRowsObserved: capture.aggregate.primaryFamilyOperateLogRowsObserved,
      primaryFamilyScanCompletedChains: capture.aggregate.primaryFamilyScanCompletedChains,
      crossFamilyCompletenessAgreementChains: capture.aggregate.crossFamilyCompletenessAgreementChains,
      completeInputDecodeChains: capture.aggregate.completeInputDecodeChains,
      transactionLevelOperatePerfectDecodes: capture.aggregate.transactionLevelOperatePerfectDecodes,
      transactionLevelPerfectDepositToken1MaxObservations: capture.aggregate.transactionLevelPerfectDepositToken1MaxObservations,
      transactionLevelDecodedCallerCategories: callerCategories,
      negativeCallerAuthorityObservations: {
        newPositionCustodialContract: sums(chains, chain => chain.history?.negativeCallerAuthorityObservations?.newPositionCustodialContract),
        nftOwner: sums(chains, chain => chain.history?.negativeCallerAuthorityObservations?.nftOwner),
        approvedOperator: sums(chains, chain => chain.history?.negativeCallerAuthorityObservations?.approvedOperator),
        unapprovedThirdPartyDepositor: sums(chains, chain => chain.history?.negativeCallerAuthorityObservations?.unapprovedThirdPartyDepositor),
        unresolved: sums(chains, chain => chain.history?.negativeCallerAuthorityObservations?.unresolved)
      },
      exactOverspendObservations: capture.aggregate.exactOverspendObservations,
      exactOverspendRaw: null,
      traceInnerCallSuccessProven: false,
      successfulLogOperateLinkageProven: false,
      caveat: "Zero observed negative sentinels applies only to retained transaction-level decodes. Base primary-family scanning completed, but cross-family completeness/agreement is unavailable; traces may include reverted inner calls and are not proven one-to-one successful LogOperate-linked calls."
    },
    current,
    chains: chains.map(chain => ({
      chain: chain.chain,
      chainId: chain.chainId,
      pin: chain.pin,
      vaultT2: chain.vaults?.t2 ?? null,
      vaultT4: chain.vaults?.t4 ?? null,
      vulnerableShaped: chain.vaults?.runtime?.vulnerableShapedPredicateSignatureObserved ?? null,
      patchedShaped: chain.vaults?.runtime?.patchedShapedPredicateSignatureObserved ?? null,
      predicateShapeUnknown: chain.vaults?.runtime?.predicateShapeUnknown ?? null,
      deployedOperatePerfectSemanticsBound: chain.vaults?.runtime?.deployedOperatePerfectSemanticsBound ?? null,
      nativeToken1: chain.vaults?.linkage?.nativeToken1 ?? null,
      erc20Token1: chain.vaults?.linkage?.erc20Token1 ?? null,
      linkage: chain.vaults?.linkage ?? null,
      history: chain.history ? {
        fromBlock: chain.history.fromBlock,
        toBlock: chain.history.toBlock,
        primaryFamilyOperateLogRowsObserved: chain.history.primaryFamilyOperateLogRowsObserved,
        primaryFamilyScanCompleted: chain.history.primaryFamilyScanCompleted,
        primaryFamilyScanQualification: chain.history.primaryFamilyScanQualification,
        crossFamilyCompletenessAgreement: chain.history.crossFamilyCompletenessAgreement,
        secondaryFamilyScan: chain.history.secondaryFamilyScan,
        inputDecodeCompleteness: chain.history.inputDecodeCompleteness,
        stoppedReason: chain.history.stoppedReason,
        transactionLevelOperatePerfectDecodes: chain.history.transactionLevelOperatePerfectDecodes,
        token1MaxObservations: chain.history.transactionLevelPerfectDepositToken1MaxObservations,
        callerCategoryObservations: chain.history.transactionLevelDecodedCallerCategories,
        traceObservationsMayIncludeRevertedInnerCalls: chain.history.traceObservationsMayIncludeRevertedInnerCalls,
        successfulLogOperateLinkageProven: chain.history.successfulLogOperateLinkageProven
      } : null,
      current: chain.current
    })),
    budgets: {
      limits: capture.limits,
      resumeNewReads: capture.rpcBudget,
      retainedFiveChainReadsNotDoubleCountedInResumeBudget: true
    },
    safety: capture.safety,
    conclusion: capture.conclusion
  };
}

function reportText(result) {
  const rows = result.chains.map(chain => {
    const pin = chain.pin;
    const history = chain.history;
    return `| ${chain.chain} | ${pin.number} / \`${pin.hash}\` | ${pin.familiesObserved} | ${chain.vaultT2}/${chain.vaultT4} | ${chain.vulnerableShaped}/${chain.patchedShaped}/${chain.predicateShapeUnknown} | ${history.primaryFamilyOperateLogRowsObserved} | ${history.primaryFamilyScanCompleted ? "primary-family completed; cross-family null" : `partial (${history.stoppedReason})`} |`;
  }).join("\n");
  const volatility = result.chains.map(chain => {
    const value = chain.current.reserveRatioAbsoluteChangeBps;
    return `| ${chain.chain} | ${chain.current.uniqueDexPools} | ${chain.current.smartCollateralEnabledPools} | ${chain.current.swapAndArbitragePausedPools} | ${value ? `${value.median} / ${value.maximum}` : "null"} |`;
  }).join("\n");
  return `# Fluid VaultT2/T4 Negative Token1 Maximum — Step2 Deployment and Usage Binding

**Signal: 🟠 WATCH — CONDITIONAL LOW / VULNERABLE-SHAPED PREDICATE SIGNATURE OBSERVED / DEPLOYED OPERATEPERFECT SEMANTICS UNBOUND / HISTORY INCOMPLETE / CALLER-FUNDED / NO OUTSIDER THEFT**

## Conclusion

At six fixed finalized pins, resolver/factory enumeration identified **${result.coverage.resolverVaultT2T4}** VaultT2/T4 deployments: **${result.coverage.resolverVaultT2} T2** and **${result.coverage.resolverVaultT4} T4**. All 128 observations contained a vulnerable-shaped duplicated-token0 byte pattern; zero contained the patched-shaped pattern and zero were shape-unknown. The retained code does not provide a selector/control-flow anchored proof, so this is **not** an exact current affected-runtime or deployed \`operatePerfect\` semantics claim. All 128 deployed semantics remain unbound.

Retained data contains **${result.history.primaryFamilyOperateLogRowsObserved} primary-family Operate log rows** and **${result.history.transactionLevelOperatePerfectDecodes} transaction-level \`operatePerfect\` calldata observations**. Among transaction-level perfect-deposit decodes, token1 maxima were **${result.history.transactionLevelPerfectDepositToken1MaxObservations.positive} positive, ${result.history.transactionLevelPerfectDepositToken1MaxObservations.zero} zero, and ${result.history.transactionLevelPerfectDepositToken1MaxObservations.negative} negative**; neither \`-1\` nor \`int256.min\` was observed. These counts are not proven one-to-one successful LogOperate-linked calls. Trace-derived calldata may include reverted inner calls.

Base's primary-family scan completed, but cross-family completeness/agreement is unavailable: the secondary scan exhausted queries, encountered failed ranges, or otherwise did not establish agreement. Other histories are partial or boundary-blocked. No negative transaction-level decode was identified, so actual token1 spend, exact pre-call quote, post-state, and overspend remain **null**, not zero. No outsider profit or forced unauthorized third-party loss is established. The source finding remains caller/custodial-integration-funded Conditional Low with gates \`0/0/false\` and no fork.

## Partial-artifact reconciliation

- Two initial bounded attempts timed out before a sanitized result was written; their empty stdout/stderr timeout captures are retained.
- R3 completed but whole-runtime matching was unknown; R4 added an initial semantic signature but did not cover the retained deployment PUSH1 form. Both are superseded.
- The cancelled R5 run left five terminally rechecked chain checkpoints. It is archived at \`${result.partialArtifactDisposition.partialArtifact}\` with SHA-256 \`${result.partialArtifactDisposition.partialArtifactSha256}\`.
- R6 retained those five chains and performed new endpoint qualification plus reads only for missing Ethereum. The final result supersedes the R5 checkpoint.

## Pins, deployments, runtime and history

| Chain | Finalized number/hash | Families | T2/T4 | vulnerable-shaped/patched-shaped/unknown | Primary-family log rows | History qualification |
|---|---|---:|---:|---:|---:|---|
${rows}

Four chains have two hostname-distinct families agreeing on exact pin number/hash and terminal recheck; Plasma and Polygon have one family. Hostname distinction is not backend independence. Runtime/state reads are single-family observations; no two-family runtime-state agreement is claimed.

Local manifests contain 99 T2/T4 files. Resolver enumeration found 128 deployments: 99 matched local files and 29 were resolver-visible but locally missing. The offline fixture counts all 99 files but runtime-shape classification is asserted only for the two explicitly retained deployment artifacts named in the fixture. Token1 is native in ${result.current.nativeToken1Vaults} observations and ERC20 in ${result.current.erc20Token1Vaults}.

## Retained usage and callers

The Base primary-family scan observed 4,378 log rows across 3,874 transaction hashes. The bounded decoder fetched 400 transactions: 216 direct and 184 indirect. Fifty indirect transaction traces exposed target calldata, but inner-call success was not proven and reverted inner calls may be included. Transaction-level observations decoded 99 perfect and 196 ordinary calldata items; 192 processed log rows had no resolved target calldata observation. Transaction-level perfect-decode caller categories were **83 direct EOAs, 16 unidentified contract integrations, zero known local integrations, and zero unresolved decoded callers**.

No negative sentinel was observed in transaction-level decodes, so owner/operator/custodial negative-sentinel categories, ERC20/native negative use, actual spend and archive replay are zero-observation/null-economics fields. No event-call success linkage, sandwich, or earlier quote is inferred.

## Current linkage, pause and reserve context

All six Liquidity resolvers returned status \`1\` (normal). Across per-chain DEX sets, ${result.current.smartCollateralEnabledPoolsByChainSum} pools reported smart collateral enabled, ${result.current.smartCollateralDisabledPoolsByChainSum} disabled, and ${result.current.swapAndArbitragePausedPoolsByChainSum} swap/arbitrage paused. DEX pause does not disable perfect functions.

| Chain | DEX pools | Smart collateral enabled | Swap/arbitrage paused | Reserve-ratio absolute change bps median/max |
|---|---:|---:|---:|---:|
${volatility}

Reserve changes are fixed-block lookback context only. They do not establish transaction-local slippage, ordering, or overspend.

## Runtime evidence

- T2 vulnerable source SHA-256: \`${result.runtimeObservation.sourceBinding.vulnerable.vaultT2Sha256}\`.
- T4 vulnerable source SHA-256: \`${result.runtimeObservation.sourceBinding.vulnerable.vaultT4Sha256}\`.
- T2/T4 patched source SHA-256: \`${result.runtimeObservation.sourceBinding.patched.vaultT2Sha256}\` / \`${result.runtimeObservation.sourceBinding.patched.vaultT4Sha256}\`.
- Reference template hashes are not deployed runtime commitments. Actual observed runtime bytes/code hashes were not retained, so deployed runtime commitments are null and cannot be reconstructed offline.
- The fixture-tested shaped differential is one stack-selection byte in each reference type. It is unanchored to selector/control flow and does not bind deployed semantics.
- Offline fixtures: 62 checks. They count 99 local manifest files and classify only two explicitly retained deployment artifacts; they also cover renamed fields, Base cross-family nulls, trace-success qualification, malformed-value decoding, leak guard, and metadata handling.

## Coverage and safety

- Final resume RPC budget: ${result.budgets.resumeNewReads.global.attempted}/${result.budgets.resumeNewReads.global.max}; the retained five-chain R5 reads are not double-counted in this resume budget.
- Oracle corrections were offline-only with zero new network/RPC reads.
- No endpoint URL, domain, provider identity, credential, header, raw response, caller/user identity or address is persisted.
- No signing, transaction, broadcast, mutation, live exploit call, or fork occurred.
- Exact overspend is null because no decoded negative-max call supplied an exact transaction/order-bound quote baseline.
`;
}

function artifacts() {
  const paths = [
    CAPTURE,
    `${PREFIX}-capture-pre-oracle.json`,
    `${PREFIX}-partial-r5.json`,
    `${PREFIX}-run-r6-resume.capture.json`,
    `${PREFIX}-run-r6-resume.stdout.txt`,
    `${PREFIX}-run-r6-resume.stderr.txt`,
    `${PREFIX}-run.capture.json`, `${PREFIX}-run.stdout.txt`, `${PREFIX}-run.stderr.txt`,
    `${PREFIX}-run-r2.capture.json`, `${PREFIX}-run-r2.stdout.txt`, `${PREFIX}-run-r2.stderr.txt`,
    `${PREFIX}-run-r3.capture.json`, `${PREFIX}-run-r3.stdout.txt`, `${PREFIX}-run-r3.stderr.txt`,
    `${PREFIX}-run-r4.capture.json`, `${PREFIX}-run-r4.stdout.txt`, `${PREFIX}-run-r4.stderr.txt`,
    `${PREFIX}-offline-fixtures.capture.json`,
    `${PREFIX}-offline-fixtures.stdout.txt`,
    `${PREFIX}-offline-fixtures.stderr.txt`,
    "tools/run-critical-fluid-vaultt2-t4-negative-max-step2.js",
    "tools/correct-critical-fluid-vaultt2-t4-negative-max-step2-oracle.js",
    "tools/capture-critical-fluid-vaultt2-t4-negative-max-step2.js",
    "tools/capture-critical-fluid-vaultt2-t4-negative-max-step2-offline.js",
    "tools/test-critical-fluid-vaultt2-t4-negative-max-step2-fixtures.js",
    "tools/generate-critical-fluid-vaultt2-t4-negative-max-step2-package.js",
    "tools/validate-critical-fluid-vaultt2-t4-negative-max-step2.js",
    "reports/critical-fluid-vaultt2-t4-smart-collateral-negative-max-r2.md",
    "reports/raw/fast/critical-fluid-vaultt2-t4-negative-max-r2.json",
    "reports/raw/fast/critical-fluid-vaultt2-t4-negative-max-r2-manifest.json",
    "targets/fluid-contracts-public/contracts/protocols/vault/vaultT2/coreModule/mainOperate.sol",
    "targets/fluid-contracts-public/contracts/protocols/vault/vaultT4/coreModule/mainOperate.sol",
    "remediations/fluid-vaultt2-t4-r2/contracts/protocols/vault/vaultT2/coreModule/mainOperate.sol",
    "remediations/fluid-vaultt2-t4-r2/contracts/protocols/vault/vaultT4/coreModule/mainOperate.sol",
    "remediations/fluid-vaultt2-t4-r2-vulnerable/out/mainOperate.sol/FluidVaultT2Operate.json",
    "remediations/fluid-vaultt2-t4-r2-vulnerable/out/mainOperate.sol/FluidVaultT4Operate.json",
    "remediations/fluid-vaultt2-t4-r2/out/mainOperate.sol/FluidVaultT2Operate.json",
    "remediations/fluid-vaultt2-t4-r2/out/mainOperate.sol/FluidVaultT4Operate.json",
    RESULT,
    REPORT
  ];
  return paths.map(relative => {
    const data = read(relative);
    return { path: relative, bytes: data.length, sha256: sha256(data) };
  });
}

function sameFile(relative, expected) {
  return fs.existsSync(absolute(relative)) && read(relative).equals(Buffer.from(expected, "utf8"));
}

const capture = json(CAPTURE);
runner.assertNoLeaks(capture);
const result = buildResult(capture);
runner.assertNoLeaks(result);
const resultText = `${JSON.stringify(result, null, 2)}\n`;
const report = reportText(result);

if (!CHECK_ONLY) {
  fs.writeFileSync(absolute(RESULT), resultText, "utf8");
  fs.writeFileSync(absolute(REPORT), report, "utf8");
}

if (CHECK_ONLY && (!sameFile(RESULT, resultText) || !sameFile(REPORT, report))) {
  throw new Error("CHECK_ONLY_GENERATED_CONTENT_MISMATCH");
}

const entries = artifacts();
const aggregateSha256 = sha256(Buffer.from(entries.map(entry => `${entry.path}:${entry.sha256}`).sort().join("\n"), "utf8"));
const manifest = {
  schemaVersion: 3,
  findingId: result.findingId,
  generatedFromCaptureAt: capture.generatedAt,
  artifactCount: entries.length,
  aggregateSha256,
  artifacts: entries
};
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
if (!CHECK_ONLY) fs.writeFileSync(absolute(MANIFEST), manifestText, "utf8");
else if (!sameFile(MANIFEST, manifestText)) throw new Error("CHECK_ONLY_MANIFEST_MISMATCH");

console.log(`${CHECK_ONLY ? "PASS check-only" : "GENERATED"} ${entries.length} artifacts; aggregate ${aggregateSha256}`);
