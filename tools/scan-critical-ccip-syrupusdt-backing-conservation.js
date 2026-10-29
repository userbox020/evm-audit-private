#!/usr/bin/env node
"use strict";

// Pre-hash gate, offline packager, exact BigInt worksheet, and verifier for the CCIP backing branch.

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const RUNNER = "tools/run-critical-ccip-syrupusdt-backing-network.js";
const EXPECTED_RUNNER_BYTES = 28393;
const EXPECTED_RUNNER_SHA256 = "6b262d1839f41b98a073ff7089b47a9642236f85440f6d53f14d0d8bf052d825";
const TOOL = "tools/scan-critical-ccip-syrupusdt-backing-conservation.js";
const CAPTURE = "reports/raw/fast/critical-ccip-syrupusdt-backing-conservation.capture.json";
const RAW = "reports/raw/fast/critical-ccip-syrupusdt-backing-conservation.json";
const WORKSHEET = "reports/raw/fast/critical-ccip-syrupusdt-backing-conservation-worksheet.json";
const MANIFEST = "reports/raw/fast/critical-ccip-syrupusdt-backing-conservation-manifest.json";
const REPORT = "reports/critical-ccip-syrupusdt-backing-conservation.md";
const INBOX = "coordination/inbox/critical/2026-07-18-critical-ccip-syrupusdt-backing-conservation.json";
const HANDOFF = "coordination/handoffs/2026-07-18-critical-ccip-syrupusdt-backing-conservation-handoff.md";
const REVISION = "fixed-pin-global-conservation-r3-oracle-tristate";
const EXPECTED_CAPTURE_BYTES = 175770;
const EXPECTED_CAPTURE_SHA256 = "47e9c88a4cb2d34e92142e60104833b246bec52febcbcb9fea86b30cfba90701";
const PRIOR_MANIFEST = "reports/raw/fast/critical-ccip-syrupusdt-release-auth-manifest.json";
const PRIOR_RAW = "reports/raw/fast/critical-ccip-syrupusdt-release-auth.json";
const PRIOR_PROOF = "reports/raw/fast/critical-ccip-syrupusdt-release-auth-offline-build.json";
const ETH_SELECTOR = "5009297550715157269";

const MAPPING_INPUTS = [
  "targets/hyperlane-monorepo/typescript/sdk/src/ccip/consts.ts",
  "targets/aave-governance-v3/lib/aave-delivery-infrastructure/src/contracts/adapters/ccip/CCIPAdapter.sol",
  "targets/aave-governance-v3/lib/aave-delivery-infrastructure/lib/solidity-utils/src/contracts/utils/ChainHelpers.sol",
];
const SEMANTIC_INPUTS = [
  "targets/dolomite-margin-modules/node_modules/@chainlink/contracts-ccip/abi/v0.8/LockReleaseTokenPool.json",
  "targets/dolomite-margin-modules/node_modules/@chainlink/contracts-ccip/abi/v0.8/BurnMintTokenPool.json",
  "targets/dolomite-margin-modules/node_modules/@chainlink/contracts-ccip/abi/v0.8/BurnMintERC677.json",
  "targets/dolomite-margin-modules/node_modules/@chainlink/contracts-ccip/src/v0.8/ccip/pools/LockReleaseTokenPool.sol",
  "targets/dolomite-margin-modules/node_modules/@chainlink/contracts-ccip/src/v0.8/ccip/pools/TokenPool.sol",
  "targets/dolomite-margin-modules/node_modules/@chainlink/contracts-ccip/src/v0.8/shared/token/ERC677/BurnMintERC677.sol",
];

function abs(rel) { return path.join(ROOT, ...rel.split("/")); }
function read(rel) { return fs.readFileSync(abs(rel)); }
function text(rel) { return read(rel).toString("utf8"); }
function json(rel) { return JSON.parse(text(rel)); }
function sha256(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function record(rel) { const data = read(rel); return { path: rel, bytes: data.length, sha256: sha256(data) }; }
function write(rel, value) {
  const allowed = new Set([RAW, WORKSHEET, MANIFEST, REPORT, INBOX, HANDOFF]);
  if (!allowed.has(rel)) throw new Error(`write outside backing branch refused: ${rel}`);
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), value, "utf8");
}
function runnerRecord() {
  const row = record(RUNNER);
  if (row.bytes !== EXPECTED_RUNNER_BYTES || row.sha256 !== EXPECTED_RUNNER_SHA256) throw new Error(`immutable runner hash mismatch bytes=${row.bytes} sha256=${row.sha256}`);
  return { ...row, expectedBytes: EXPECTED_RUNNER_BYTES, expectedSha256: EXPECTED_RUNNER_SHA256, immutablePreHashMatch: true };
}
function captureRecord() {
  const row = record(CAPTURE);
  if (row.bytes !== EXPECTED_CAPTURE_BYTES || row.sha256 !== EXPECTED_CAPTURE_SHA256) throw new Error(`immutable capture mismatch bytes=${row.bytes} sha256=${row.sha256}`);
  return { ...row, expectedBytes: EXPECTED_CAPTURE_BYTES, expectedSha256: EXPECTED_CAPTURE_SHA256, immutableCaptureMatch: true };
}
function pow10(n) {
  if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`invalid decimal exponent ${n}`);
  return 10n ** BigInt(n);
}
function normalize(raw, decimals, targetDecimals) {
  const amount = BigInt(raw);
  if (decimals > targetDecimals) throw new Error("normalization target below source decimals");
  return amount * pow10(targetDecimals - decimals);
}
function formatUnitsExact(raw, decimals) {
  const amount = BigInt(raw);
  if (decimals === 0) return amount.toString();
  const base = pow10(decimals);
  const whole = amount / base;
  const fraction = (amount % base).toString().padStart(decimals, "0");
  return `${whole}.${fraction}`;
}
function unique(values) { return [...new Set(values)]; }

function normalizeCapture(capture) {
  const normalized = JSON.parse(JSON.stringify(capture));
  for (const route of normalized.counterpartRoutes || []) {
    const key = route.chain?.key;
    const stateCovered = Boolean(route.pool?.runtime?.present && route.token?.totalSupply?.ok);
    let reasons = [];
    if (!route.chainPin?.reached) {
      reasons = [{ code: "FIXED_PIN_STATE_UNAVAILABLE", detail: `${route.chain?.name || key} fixed-pin state unavailable: ${route.chainPin?.coverageGap || "chain pin unavailable"}` }];
    } else if (!stateCovered) {
      const http403 = JSON.stringify(route).includes("public preset HTTP 403");
      reasons = [{ code: http403 ? "FIXED_PIN_STATE_UNAVAILABLE_HTTP_403" : "FIXED_PIN_STATE_UNAVAILABLE", detail: http403 ? `${route.chain.name} fixed-pin pool/token state calls unavailable (HTTP 403)` : `${route.chain.name} fixed-pin pool/token state unavailable` }];
    } else {
      const authorityEstablished = Boolean(route.token?.minters?.ok && route.token?.burners?.ok && route.token?.isMinter?.ok && route.token?.isBurner?.ok);
      if (!authorityEstablished) reasons.push({ code: "AUTHORITY_INTERFACE_ENUMERATION_UNAVAILABLE", detail: `${route.chain.name} minter/burner authority interface or enumeration unavailable` });
      if (route.authority?.historicalMintProvenanceComplete !== true) reasons.push({ code: "HISTORICAL_MINT_MIGRATION_ALTERNATE_BRIDGE_PROVENANCE_UNSCANNED", detail: `${route.chain.name} historical mint, migration, removed-minter, and alternate-bridge provenance unscanned` });
    }
    route.unknownLiabilityReasons = reasons;
    route.attributableLiabilityProven = false;
    route.attributableLiabilityRaw = null;
    route.unknownSupplyRaw = stateCovered && route.token?.totalSupply?.ok ? route.token.totalSupply.decoded : null;
    const authorityEnumerationEstablished = stateCovered
      ? Boolean(route.token?.minters?.ok && route.token?.burners?.ok && route.token?.isMinter?.ok && route.token?.isBurner?.ok)
      : null;
    const poolTypeBurnMint = stateCovered && route.pool?.typeAndVersion?.ok
      ? /Burn.*Mint|BurnMint/i.test(route.pool.typeAndVersion.decoded)
      : null;
    const currentExclusiveMinter = authorityEnumerationEstablished === true
      ? Boolean(route.token.minters.decoded.length === 1 && route.token.minters.decoded[0].toLowerCase() === route.pool.address.toLowerCase() && route.token.isMinter.decoded === true)
      : null;
    const poolBurner = authorityEnumerationEstablished === true
      ? Boolean(route.token.burners.decoded.some((x) => x.toLowerCase() === route.pool.address.toLowerCase()) && route.token.isBurner.decoded === true)
      : null;
    // Explicit reconstruction: never inherit false predicates emitted after transport/call failure.
    route.authority = {
      fixedPinStateAvailable: stateCovered,
      poolTypeBurnMint,
      currentExclusiveMinter,
      poolBurner,
      authorityInterfaceEnumerationEstablished: authorityEnumerationEstablished,
      historicalMintProvenanceComplete: false,
      migrationOrRemovedMinterHistoryScanned: false,
      historicalMintMigrationAlternateBridgeProvenanceScanned: false,
      totalSupplyAttributableToCcip: false,
      alternateCurrentMinters: authorityEnumerationEstablished === true ? route.token.minters.decoded.filter((x) => x.toLowerCase() !== route.pool.address.toLowerCase()) : null,
      reason: reasons.map((x) => x.detail).join("; "),
    };
    if (!stateCovered) {
      if (route.pool) route.pool.runtime = { bytes: null, keccak256: null, present: null, status: "unknown-fixed-pin-state-unavailable" };
      if (route.token) route.token.runtime = { bytes: null, keccak256: null, present: null, status: "unknown-fixed-pin-state-unavailable" };
      route.topologyComplete = false;
      route.sourceRuntimeComplete = false;
      route.coverageGaps = reasons.map((x) => x.detail);
      if (key === "mantle") {
        route.coverageGaps.push("Mantle reciprocal route not established because fixed-pin state calls unavailable (HTTP 403)");
        route.coverageGaps.push("Mantle pool/token identity and decimals not established because fixed-pin state calls unavailable (HTTP 403)");
        route.coverageGaps.push("Mantle pool typeAndVersion not established because fixed-pin state calls unavailable (HTTP 403)");
      }
    } else {
      route.coverageGaps = (route.coverageGaps || []).filter((x) => !/totalSupply is not CCIP-attributable/i.test(x));
      for (const reason of reasons) route.coverageGaps.push(reason.detail);
    }
  }
  const preserved = (normalized.coverageGaps || []).filter((x) => !/^(Plasma|Mantle|BNB Chain|Ink)\//.test(x));
  const routeGaps = (normalized.counterpartRoutes || []).flatMap((route) => (route.coverageGaps || []).map((gap) => `${route.chain.name}/${route.selector}: ${gap}`));
  normalized.coverageGaps = unique([...preserved, ...routeGaps]);
  return normalized;
}

function synchronizedAccountingGate(capture) {
  const rows = [];
  if (capture.ethereum?.custodyRaw != null && capture.ethereum?.chain?.pin?.terminalSameHash) {
    rows.push({ chain: "Ethereum", timestamp: capture.ethereum.chain.pin.blockTimestampDecimal, field: "custody" });
  }
  for (const route of capture.counterpartRoutes || []) {
    if (route.token?.totalSupply?.ok && route.chainPin?.pin?.terminalSameHash) rows.push({ chain: route.chain.name, timestamp: route.chainPin.pin.blockTimestampDecimal, field: "remote totalSupply context" });
  }
  const timestamps = rows.map((x) => BigInt(x.timestamp));
  const spread = timestamps.length > 1 ? timestamps.reduce((a, b) => a > b ? a : b) - timestamps.reduce((a, b) => a < b ? a : b) : 0n;
  return {
    mandatoryForSuccessorPassFail: true,
    modelCompleteRequiresPass: true,
    status: "NOT_MET",
    pass: false,
    synchronizedAsOfAccountingEstablished: false,
    explicitCcipInFlightReconciliationEstablished: false,
    accountingStatePins: rows,
    accountingStateTimestampSpreadSeconds: spread.toString(),
    observedCurrentSpreadUpToSeconds: spread.toString(),
    reason: `Accounting inputs are not synchronized/as-of and no explicit CCIP in-flight reconciliation is retained; current accounting-state pin spread is ${spread} seconds.`,
  };
}

function buildWorksheet(capture) {
  const ethDecimals = Number(capture.ethereum?.token?.decimals?.decoded);
  const custodyRaw = capture.ethereum?.custodyRaw;
  if (!Number.isInteger(ethDecimals) || custodyRaw == null) throw new Error("Ethereum custody/decimals unavailable for worksheet");
  const rows = [];
  for (const route of capture.counterpartRoutes || []) {
    const decimals = route.token?.decimals?.ok ? Number(route.token.decimals.decoded) : null;
    const supplyRaw = route.token?.totalSupply?.ok ? route.token.totalSupply.decoded : null;
    rows.push({
      selector: route.selector,
      chain: route.chain.name,
      chainId: route.chain.chainId,
      pool: route.pool?.address || route.ethereumRoute?.remotePoolAddresses?.[0] || null,
      token: route.token?.address || route.ethereumRoute?.remoteTokenAddress || null,
      decimals,
      totalSupplyRawContext: supplyRaw,
      totalSupplyExact: supplyRaw != null && decimals != null ? formatUnitsExact(supplyRaw, decimals) : null,
      attributableLiabilityProven: route.attributableLiabilityProven === true,
      attributableLiabilityRaw: route.attributableLiabilityProven ? route.attributableLiabilityRaw : null,
      unknownSupplyRaw: route.attributableLiabilityProven ? null : supplyRaw,
      unknownReasonCodes: route.attributableLiabilityProven ? [] : (route.unknownLiabilityReasons || []).map((x) => x.code),
      unknownReasons: route.attributableLiabilityProven ? [] : (route.unknownLiabilityReasons || [{ code: "UNKNOWN", detail: "unavailable route/supply provenance" }]),
      unknownReason: route.attributableLiabilityProven ? null : (route.unknownLiabilityReasons || []).map((x) => x.detail).join("; "),
      topologyComplete: route.topologyComplete === true,
      sourceRuntimeComplete: route.sourceRuntimeComplete === true,
      terminalSameHash: route.chainPin?.pin?.terminalSameHash === true,
      runtimeTriState: {
        poolPresent: route.pool?.runtime?.present ?? null,
        poolBytes: route.pool?.runtime?.bytes ?? null,
        tokenPresent: route.token?.runtime?.present ?? null,
        tokenBytes: route.token?.runtime?.bytes ?? null,
      },
      authorityTriState: {
        poolTypeBurnMint: route.authority?.poolTypeBurnMint ?? null,
        currentExclusiveMinter: route.authority?.currentExclusiveMinter ?? null,
        poolBurner: route.authority?.poolBurner ?? null,
        authorityInterfaceEnumerationEstablished: route.authority?.authorityInterfaceEnumerationEstablished ?? null,
        historicalMintMigrationAlternateBridgeProvenanceScanned: route.authority?.historicalMintMigrationAlternateBridgeProvenanceScanned ?? false,
      },
    });
  }
  const knownDecimals = [ethDecimals, ...rows.map((x) => x.decimals).filter(Number.isInteger)];
  const targetDecimals = Math.max(...knownDecimals);
  const custodyNormalized = normalize(custodyRaw, ethDecimals, targetDecimals);
  let attributableNormalized = 0n;
  let unknownKnownAmountNormalized = 0n;
  let unquantifiedUnknownRouteCount = 0;
  for (const row of rows) {
    if (row.attributableLiabilityProven && row.attributableLiabilityRaw != null && row.decimals != null) {
      row.attributableLiabilityNormalized = normalize(row.attributableLiabilityRaw, row.decimals, targetDecimals).toString();
      attributableNormalized += BigInt(row.attributableLiabilityNormalized);
    } else {
      row.attributableLiabilityNormalized = null;
    }
    if (row.unknownSupplyRaw != null && row.decimals != null) {
      row.unknownSupplyNormalized = normalize(row.unknownSupplyRaw, row.decimals, targetDecimals).toString();
      unknownKnownAmountNormalized += BigInt(row.unknownSupplyNormalized);
    } else {
      row.unknownSupplyNormalized = null;
      unquantifiedUnknownRouteCount++;
    }
  }
  const selectors = capture.ethereum?.supportedSelectors || [];
  const mappingComplete = selectors.length > 0 && capture.selectorMappings?.length === selectors.length && capture.selectorMappings.every((x) => x.resolved && x.evm);
  const routesComplete = capture.routeCount <= capture.caps.maxRoutes
    && capture.counterpartRoutes.length === selectors.length
    && capture.counterpartRoutes.every((x) => x.chainPin?.reached && x.chainPin?.pin?.terminalSameHash && x.topologyComplete && x.sourceRuntimeComplete && x.attributableLiabilityProven);
  const accountingGate = synchronizedAccountingGate(capture);
  const modelComplete = Boolean(capture.ethereum?.chain?.reached && capture.ethereum?.chain?.pin?.terminalSameHash && mappingComplete && routesComplete && capture.coverageGaps.length === 0 && accountingGate.pass);
  const deficitNormalized = attributableNormalized > custodyNormalized ? attributableNormalized - custodyNormalized : 0n;
  const surplusNormalized = custodyNormalized >= attributableNormalized ? custodyNormalized - attributableNormalized : 0n;
  return {
    arithmeticModel: "All values are decimal strings parsed as BigInt; normalization multiplies by 10^(targetDecimals-sourceDecimals); no floating point or Number amount arithmetic.",
    normalizationDecimals: targetDecimals,
    ethereumCustody: {
      token: capture.ethereum.token.address,
      pool: capture.ethereum.pool.address,
      decimals: ethDecimals,
      raw: custodyRaw,
      exact: formatUnitsExact(custodyRaw, ethDecimals),
      normalized: custodyNormalized.toString(),
      expression: `${custodyRaw} * 10^(${targetDecimals}-${ethDecimals})`,
    },
    routes: rows,
    totals: {
      attributableLiabilityNormalized: attributableNormalized.toString(),
      attributableLiabilityExactAtNormalizationDecimals: formatUnitsExact(attributableNormalized.toString(), targetDecimals),
      unknownKnownAmountNormalized: unknownKnownAmountNormalized.toString(),
      unknownKnownAmountExactAtNormalizationDecimals: formatUnitsExact(unknownKnownAmountNormalized.toString(), targetDecimals),
      unquantifiedUnknownRouteCount,
      deficitNormalized: modelComplete ? deficitNormalized.toString() : null,
      surplusNormalized: modelComplete ? surplusNormalized.toString() : null,
    },
    exclusions: {
      ethereumTokenTotalSupplyContextOnlyRaw: capture.ethereum.token.totalSupplyContextOnly?.decoded || null,
      ethereumCanonicalSupplyIncludedAsRemoteLiability: false,
      remoteTotalSupplyIncludedOnlyWithExclusiveHistoricalCcipMintProvenance: true,
    },
    successorPassFailGate: accountingGate,
    completeness: { mappingComplete, routesComplete, synchronizedAccountingOrInFlightGatePassed: accountingGate.pass, modelComplete },
  };
}

function classify(capture, worksheet) {
  if (!worksheet.completeness.modelComplete) return { status: "MODEL_NOT_ESTABLISHED", classification: "INCOMPLETE/WATCH/MODEL_NOT_ESTABLISHED", signal: "🟠 WATCH", cleanSubbranch: false };
  const custody = BigInt(worksheet.ethereumCustody.normalized);
  const liability = BigInt(worksheet.totals.attributableLiabilityNormalized);
  if (custody >= liability) return { status: "PASS", classification: "PASS/CLEAN/BACKING-COVERS-ATTRIBUTABLE-LIABILITIES", signal: "⚪ CLEAN", cleanSubbranch: true };
  return { status: "FAIL", classification: "FAIL/EXACT-UNEXPLAINED-BACKING-DEFICIT", signal: "🟡 VULNERABLE", cleanSubbranch: false };
}

function renderReport(raw, worksheet) {
  const rows = worksheet.routes.map((x) => `| ${x.chain} | ${x.selector} | ${x.pool || "null"} | ${x.token || "null"} | ${x.decimals ?? "null"} | ${x.totalSupplyRawContext ?? "null"} | ${x.attributableLiabilityRaw ?? "null"} | ${x.unknownSupplyRaw ?? "null"} | ${(x.unknownReasonCodes || []).join("+") || "none"} | ${x.topologyComplete} | ${x.sourceRuntimeComplete} |`).join("\n");
  const chainRows = Object.entries(raw.chainCoverage).map(([key, x]) => `| ${x.name || key} | ${x.expectedChainId} | ${x.reached} | ${x.blockNumber || "null"} | ${x.blockHash || "null"} | ${x.terminalSameHash} |`).join("\n");
  return `# CCIP Ethereum syrupUSDT Global Backing/Liability Conservation\n\nSignal: ${raw.signal} — **${raw.classification}**.\n\n## Scope and result\n\n- Run/revision: \`${raw.runId}\` / \`${raw.revision}\`.\n- Strict model status: \`${raw.status}\`; global route/executable/signing remains \`0/0/false\`.\n- This branch is distinct from and does not modify the prior authorization subbranch. Prior r2 aggregate \`${raw.priorAuthorizationBinding.manifestAggregateSha256}\` is hash-bound.\n- Immutable runner: \`${raw.runner.path}\`, ${raw.runner.bytes} bytes, SHA-256 \`${raw.runner.sha256}\`, pre-hash match \`${raw.runner.immutablePreHashMatch}\`.\n- Execution provenance: one immutable retained transcript is exact; \`attemptedExecutionExact=false\` because failed pre-capture attempts cannot be excluded.\n- Requests retained by that transcript: \`${raw.requestCounts.jsonRpc}/${raw.caps.maxRpcReads}\` JSON-RPC; \`${raw.requestCounts.metadata}/${raw.caps.maxMetadataRequests}\` metadata. No history, transaction, signing, broadcast, fork, or state override.\n\n## Fixed-pin chain coverage\n\n| Chain | Expected chain ID | Reached | Block | Hash | Terminal same hash |\n|---|---:|---:|---:|---|---:|\n${chainRows || "| none | null | false | null | null | false |"}\n\nMantle's header pin is retained, but its pool/token state calls were unavailable with HTTP 403. Reciprocal topology, identity, decimals, supply, authority, and runtime presence are therefore **not established**, not observed negatives. Mantle runtime bytes/hash/presence and \`poolTypeBurnMint/currentExclusiveMinter/poolBurner\` are explicitly \`null\`.\n\n## Exact BigInt conservation worksheet\n\n- Ethereum custody: \`${worksheet.ethereumCustody.raw}\` raw / \`${worksheet.ethereumCustody.exact}\` syrupUSDT; normalized \`${worksheet.ethereumCustody.normalized}\` at ${worksheet.normalizationDecimals} decimals.\n- Attributable remote liability: \`${worksheet.totals.attributableLiabilityNormalized}\` normalized.\n- Known-amount but unattributable/unknown remote supply: \`${worksheet.totals.unknownKnownAmountNormalized}\` normalized.\n- Unquantified unknown routes: \`${worksheet.totals.unquantifiedUnknownRouteCount}\`.\n- Model complete: \`${worksheet.completeness.modelComplete}\`. Deficit/surplus are intentionally \`null\` unless complete.\n\n| Chain | Selector | Pool | Token | Decimals | totalSupply context | Attributable | Unknown/excluded | Unknown reason codes | Topology | Source/runtime |\n|---|---|---|---|---:|---:|---:|---:|---|---:|---:|\n${rows || "| none | null | null | null | null | null | null | null | UNKNOWN | false | false |"}\n\nUnknown-liability reasons are separated into fixed-pin state unavailable, authority interface/enumeration unavailable, and historical mint/migration/alternate-bridge provenance unscanned. BNB minter/burner calls reverted: \`authorityInterfaceEnumerationEstablished=false\`, while \`currentExclusiveMinter=null\` and \`poolBurner=null\`. Mantle has no retained supply or authority state. Failed transport/calls are normalized to unknown \`null\`, never false-negative predicates.\n\nNo remote \`totalSupply\` is treated as CCIP liability unless exclusive historical CCIP mint provenance is proven.\n\n## Mandatory successor PASS/FAIL gate\n\n- Required for \`modelComplete=true\`: synchronized/as-of accounting or explicit CCIP in-flight reconciliation.\n- Status: \`${worksheet.successorPassFailGate.status}\`; pass=\`${worksheet.successorPassFailGate.pass}\`.\n- Current accounting-state timestamp spread: \`${worksheet.successorPassFailGate.accountingStateTimestampSpreadSeconds}\` seconds.\n- ${worksheet.successorPassFailGate.reason}\n\n## Source/runtime status\n\n- Ethereum LockRelease semantics: prior r2 \`localExactBuildEquivalence=true\`, \`callOrderExact=true\`, \`acceptLiquidity=false\`.\n- Counterpart statuses are retained per route in raw JSON. A public full-match record sets that contract's source/runtime field true; unavailable metadata remains \`null\`. No type/version-only equivalence is inferred.\n\n## Coverage blockers\n\n${raw.blockers.length ? raw.blockers.map((x) => `- ${x}`).join("\n") : "- None."}\n\n## Decision rule and next action\n\nPASS/CLEAN requires complete reciprocal topology, exact source/runtime reliance, exclusive attributable liabilities, custody coverage, and the mandatory synchronized/as-of or in-flight reconciliation gate. FAIL requires the same complete model plus an exact unexplained deficit. Every other state is MODEL_NOT_ESTABLISHED.\n\n${raw.nextAction}\n`;
}

function makeInbox(raw, worksheet) {
  return {
    findingId: "ccip-ethereum-syrupusdt-global-backing-conservation",
    agentId: "critical-ccip-syrupusdt-backing-20260718",
    role: "critical-research",
    status: raw.status === "PASS" ? "route-negative" : "watch-only",
    runId: raw.runId,
    revision: raw.revision,
    classification: raw.classification,
    modelStatus: raw.status,
    signal: raw.signal.replace(/^\S+\s*/, ""),
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    summary: raw.summary,
    custodyRaw: worksheet.ethereumCustody.raw,
    custodyExact: worksheet.ethereumCustody.exact,
    attributableLiabilityNormalized: worksheet.totals.attributableLiabilityNormalized,
    unknownKnownAmountNormalized: worksheet.totals.unknownKnownAmountNormalized,
    unquantifiedUnknownRouteCount: worksheet.totals.unquantifiedUnknownRouteCount,
    chainCoverage: raw.chainCoverage,
    routeCoverage: raw.routeCoverage,
    sourceRuntimeStatus: raw.sourceRuntimeStatus,
    executionProvenance: raw.captureProvenance,
    successorPassFailGate: raw.successorPassFailGate,
    triStateStatus: worksheet.routes.map((x) => ({ chain: x.chain, runtime: x.runtimeTriState, authority: x.authorityTriState })),
    requestCounts: raw.requestCounts,
    artifacts: [RUNNER, TOOL, CAPTURE, RAW, WORKSHEET, MANIFEST, REPORT, INBOX, HANDOFF],
    blockers: raw.blockers,
    nextAction: raw.nextAction,
  };
}

function renderHandoff(raw, worksheet) {
  const rendered = `# CCIP syrupUSDT backing conservation handoff\n\n- Agent/role: \`critical-ccip-syrupusdt-backing-20260718\` / \`critical-research\`\n- Run/revision: \`${raw.runId}\` / \`${raw.revision}\`\n- Classification: **${raw.classification}** (${raw.signal})\n- Coverage: ${raw.routeCoverage.counterpartChainsPinned}/${raw.routeCoverage.configuredRoutes} counterpart chains pinned; ${raw.routeCoverage.counterpartRoutesStateCovered}/${raw.routeCoverage.configuredRoutes} routes with retained pool/token state; ${raw.routeCoverage.topologyCompleteRoutes}/${raw.routeCoverage.configuredRoutes} reciprocal topologies complete; ${raw.routeCoverage.chainsReached}/${raw.routeCoverage.chainsExpected} chains reached including Ethereum\n- Custody: \`${worksheet.ethereumCustody.raw}\` raw / \`${worksheet.ethereumCustody.exact}\`; attributable normalized \`${worksheet.totals.attributableLiabilityNormalized}\`; unknown-known normalized \`${worksheet.totals.unknownKnownAmountNormalized}\`; unquantified routes \`${worksheet.totals.unquantifiedUnknownRouteCount}\`\n- Requests retained: ${raw.requestCounts.jsonRpc}/${raw.caps.maxRpcReads} RPC, ${raw.requestCounts.metadata}/${raw.caps.maxMetadataRequests} metadata\n- Execution provenance: immutable runner/transcript exact; attemptedExecutionExact=false\n- Successor accounting/in-flight gate: ${worksheet.successorPassFailGate.status}, pass=${worksheet.successorPassFailGate.pass}, spread=${worksheet.successorPassFailGate.accountingStateTimestampSpreadSeconds}s\n- Mantle reciprocal/identity/supply/authority: not established because fixed-pin state calls unavailable (HTTP 403); no observed mismatch claimed\n- BNB authority enumeration: not established because minter/burner calls reverted; historical provenance separately unscanned\n- Runner hash: \`${raw.runner.sha256}\` pre-hash match=true\n- Prior authorization artifacts unchanged and bound to aggregate \`${raw.priorAuthorizationBinding.manifestAggregateSha256}\`\n- Gates: \`0/0/false\`\n\n## Artifacts\n\n- \`${RUNNER}\`\n- \`${TOOL}\`\n- \`${CAPTURE}\`\n- \`${RAW}\`\n- \`${WORKSHEET}\`\n- \`${MANIFEST}\`\n- \`${REPORT}\`\n- \`${INBOX}\`\n- \`${HANDOFF}\`\n\n## Blockers / next action\n\n${raw.blockers.map((x) => `- ${x}`).join("\n")}\n\n${raw.nextAction}\n\nNo coordinator file was edited and the claim was not released.\n`;
  return rendered
    .replace("- BNB authority enumeration: not established because minter/burner calls reverted; historical provenance separately unscanned", "- BNB authority enumeration: not established because minter/burner calls reverted; currentExclusiveMinter=null; poolBurner=null; historical provenance separately unscanned")
    .replace("- Runner hash:", "- Failed transport/calls normalize runtime and authority predicates to null, never false\n- Runner hash:");
}

function packageCapture() {
  runnerRecord();
  const immutableCapture = captureRecord();
  const capture = normalizeCapture(json(CAPTURE));
  const worksheet = buildWorksheet(capture);
  const derived = classify(capture, worksheet);
  const chainCoverage = {};
  const eth = capture.ethereum?.chain;
  chainCoverage.ethereum = { name: "Ethereum", expectedChainId: "1", reached: eth?.reached === true, chainIdBound: eth?.chainId === "1", blockNumber: eth?.pin?.blockNumberDecimal || null, blockHash: eth?.pin?.blockHash || null, timestamp: eth?.pin?.blockTimestampDecimal || null, terminalSameHash: eth?.pin?.terminalSameHash === true };
  for (const mapping of capture.selectorMappings || []) {
    if (!mapping.resolved || !mapping.evm) continue;
    const route = capture.counterpartRoutes.find((x) => x.selector === mapping.selector);
    const pin = route?.chainPin;
    chainCoverage[mapping.mapping.key] = { name: mapping.mapping.name, expectedChainId: mapping.mapping.chainId, reached: pin?.reached === true, chainIdBound: pin?.chainId === mapping.mapping.chainId, blockNumber: pin?.pin?.blockNumberDecimal || null, blockHash: pin?.pin?.blockHash || null, timestamp: pin?.pin?.blockTimestampDecimal || null, terminalSameHash: pin?.pin?.terminalSameHash === true };
  }
  const sourceRuntimeStatus = {
    ethereumPool: { localExactBuildEquivalence: true, priorRevision: capture.priorAuthorizationBinding.revision },
    counterparts: capture.counterpartRoutes.map((x) => ({ selector: x.selector, chain: x.chain.name, pool: x.pool?.address || x.ethereumRoute?.remotePoolAddresses?.[0] || null, poolSourceRuntimeEquivalence: x.pool?.sourceRuntimeEquivalence ?? null, token: x.token?.address || x.ethereumRoute?.remoteTokenAddress || null, tokenSourceRuntimeEquivalence: x.token?.sourceRuntimeEquivalence ?? null })),
  };
  const blockers = unique([
    ...capture.coverageGaps,
    ...worksheet.routes.filter((x) => !x.attributableLiabilityProven).map((x) => `${x.chain}/${x.selector}: totalSupply excluded from attributable liability — ${x.unknownReason}`),
  ]);
  const hashSeed = Object.values(chainCoverage).map((x) => x.blockHash || "unreached").join("|");
  const runId = `ccip-syrupusdt-backing-${sha256(Buffer.from(hashSeed)).slice(0, 16)}`;
  const raw = {
    generatedAt: capture.completedAt,
    runId,
    revision: REVISION,
    scanner: TOOL,
    immutableNetworkRunner: RUNNER,
    runner: runnerRecord(),
    captureProvenance: {
      ...immutableCapture,
      retainedTranscriptExact: true,
      retainedTranscriptCount: 1,
      attemptedExecutionExact: false,
      qualification: "Immutable runner prehash and one retained transcript are proven; exactly one attempted execution is not proven because failed pre-capture attempts cannot be excluded.",
    },
    scope: capture.scope,
    signal: derived.signal,
    status: derived.status,
    classification: derived.classification,
    cleanSubbranch: derived.cleanSubbranch,
    summary: derived.status === "MODEL_NOT_ESTABLISHED"
      ? "Global backing/liability conservation model is not established: exact custody is known, but one or more counterpart topology/source/provenance/liability buckets remain unknown and no remote totalSupply is promoted without exclusive historical CCIP mint provenance."
      : (derived.status === "PASS" ? "Complete attributable liabilities are covered by Ethereum custody." : "A complete exact unexplained custody deficit was observed; realization remains unproven."),
    caps: capture.caps,
    safety: capture.safety,
    priorAuthorizationBinding: capture.priorAuthorizationBinding,
    chainCoverage,
    routeCoverage: {
      supportedSelectors: capture.ethereum?.supportedSelectors?.length || 0,
      configuredRoutes: capture.routeCount,
      counterpartRoutesAttempted: capture.counterpartRoutes.length,
      counterpartChainsPinned: capture.counterpartRoutes.filter((x) => x.chainPin?.reached).length,
      counterpartRoutesStateCovered: capture.counterpartRoutes.filter((x) => x.pool?.runtime?.present && x.token?.totalSupply?.ok).length,
      topologyCompleteRoutes: capture.counterpartRoutes.filter((x) => x.topologyComplete).length,
      chainsExpected: Object.keys(chainCoverage).length,
      chainsReached: Object.values(chainCoverage).filter((x) => x.reached).length,
      evmRouteCapExceeded: capture.routeCount > capture.caps.maxRoutes,
      nonEvmOrUnresolvedSelectors: capture.selectorMappings.filter((x) => !x.resolved || !x.evm).map((x) => x.selector),
    },
    ethereum: capture.ethereum,
    selectorMappings: capture.selectorMappings,
    counterpartRoutes: capture.counterpartRoutes,
    sourceRuntimeStatus,
    worksheetPath: WORKSHEET,
    successorPassFailGate: worksheet.successorPassFailGate,
    blockers,
    requestCounts: capture.requestCounts,
    transcript: { capturePath: CAPTURE, rpcRows: capture.rpcTranscript.length, metadataRows: capture.metadataTranscript.length },
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    nextAction: derived.status === "MODEL_NOT_ESTABLISHED"
      ? "STOP/ROTATE. Do not assert solvency or deficit. Reopen only when fixed-pin state/source coverage, authoritative authority and historical mint/migration/alternate-bridge attribution, and synchronized/as-of accounting or explicit CCIP in-flight reconciliation are available; then use a new fixed-pin revision."
      : (derived.status === "PASS" ? "Close only this fixed-pin conservation subbranch and monitor topology/authority drift." : "Keep all execution gates closed; independently resolve migration/in-flight accounting before any separately authorized fork validation."),
  };
  write(WORKSHEET, `${JSON.stringify(worksheet, null, 2)}\n`);
  write(RAW, `${JSON.stringify(raw, null, 2)}\n`);
  write(REPORT, renderReport(raw, worksheet));
  write(INBOX, `${JSON.stringify(makeInbox(raw, worksheet), null, 2)}\n`);
  write(HANDOFF, renderHandoff(raw, worksheet));
  const paths = [RUNNER, TOOL, CAPTURE, RAW, WORKSHEET, REPORT, INBOX, HANDOFF, PRIOR_MANIFEST, PRIOR_RAW, PRIOR_PROOF, ...MAPPING_INPUTS, ...SEMANTIC_INPUTS];
  const records = [...new Set(paths)].map(record);
  const aggregateSha256 = sha256(Buffer.from(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")));
  const manifest = {
    generatedAt: raw.generatedAt,
    runId,
    revision: REVISION,
    manifestVersion: 1,
    hashAlgorithm: "sha256",
    records,
    aggregateSha256,
    immutableRunner: raw.runner,
    immutableCapture: raw.captureProvenance,
    successorPassFailGate: raw.successorPassFailGate,
    requestCounts: raw.requestCounts,
    requestCaps: { jsonRpc: capture.caps.maxRpcReads, metadata: capture.caps.maxMetadataRequests },
    chainCount: Object.keys(chainCoverage).length,
    routeCount: capture.routeCount,
    classification: raw.classification,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
  };
  write(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`package PASS run=${runId} revision=${REVISION} classification=${raw.classification} chains=${raw.routeCoverage.chainsReached}/${raw.routeCoverage.chainsExpected} stateRoutes=${raw.routeCoverage.counterpartRoutesStateCovered}/${raw.routeCoverage.configuredRoutes} topology=${raw.routeCoverage.topologyCompleteRoutes}/${raw.routeCoverage.configuredRoutes} custody=${worksheet.ethereumCustody.raw} attributable=${worksheet.totals.attributableLiabilityNormalized} unknown=${worksheet.totals.unknownKnownAmountNormalized} rpc=${raw.requestCounts.jsonRpc}/${capture.caps.maxRpcReads} metadata=${raw.requestCounts.metadata}/${capture.caps.maxMetadataRequests} aggregate=${aggregateSha256}`);
}

function runNetworkOnce() {
  runnerRecord();
  if (fs.existsSync(abs(CAPTURE))) throw new Error("run-once capture already exists; refusing another network run");
  const result = childProcess.spawnSync(process.execPath, [abs(RUNNER), "--run-once"], { cwd: ROOT, encoding: "utf8", stdio: "inherit", timeout: 90 * 60 * 1000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`immutable runner exited ${result.status}`);
  packageCapture();
}

function selfTest() {
  const runner = runnerRecord();
  const child = childProcess.spawnSync(process.execPath, [abs(RUNNER), "--self-test"], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  if (child.error || child.status !== 0) throw new Error(`runner self-test failed: ${child.error?.message || child.stderr}`);
  if (!child.stdout.includes("runner self-test PASS")) throw new Error("runner self-test PASS marker absent");
  const sample = normalize("1234567", 6, 18);
  if (sample !== 1234567000000000000n || formatUnitsExact("1234567", 6) !== "1.234567") throw new Error("BigInt arithmetic self-test failed");
  const huge = normalize("900719925474099312345678", 6, 18);
  if (huge.toString() !== "900719925474099312345678000000000000") throw new Error("large BigInt arithmetic self-test failed");
  const immutableCapture = captureRecord();
  const normalized = normalizeCapture(json(CAPTURE));
  const mantle = normalized.counterpartRoutes.find((x) => x.chain.key === "mantle");
  const bsc = normalized.counterpartRoutes.find((x) => x.chain.key === "bsc");
  if (!mantle || mantle.unknownSupplyRaw !== null || mantle.pool?.runtime?.bytes !== null || mantle.pool?.runtime?.present !== null || mantle.token?.runtime?.bytes !== null || mantle.token?.runtime?.present !== null || [mantle.authority.poolTypeBurnMint, mantle.authority.currentExclusiveMinter, mantle.authority.poolBurner].some((x) => x !== null) || !mantle.unknownLiabilityReasons.some((x) => x.code === "FIXED_PIN_STATE_UNAVAILABLE_HTTP_403") || JSON.stringify(mantle).match(/reciprocal Ethereum pool\/token route not exact|identity or decimals mismatch/)) throw new Error("Mantle runtime/authority tri-state normalization self-test failed");
  if (!bsc || bsc.authority.authorityInterfaceEnumerationEstablished !== false || bsc.authority.currentExclusiveMinter !== null || bsc.authority.poolBurner !== null || bsc.authority.historicalMintMigrationAlternateBridgeProvenanceScanned !== false || !bsc.unknownLiabilityReasons.some((x) => x.code === "AUTHORITY_INTERFACE_ENUMERATION_UNAVAILABLE") || !bsc.unknownLiabilityReasons.some((x) => x.code === "HISTORICAL_MINT_MIGRATION_ALTERNATE_BRIDGE_PROVENANCE_UNSCANNED")) throw new Error("BNB authority/history tri-state reason separation self-test failed");
  const gate = synchronizedAccountingGate(normalized);
  if (gate.pass || gate.status !== "NOT_MET" || gate.accountingStateTimestampSpreadSeconds !== "777") throw new Error("mandatory synchronized accounting gate self-test failed");
  console.log(`self-test PASS runner=${runner.sha256} capture=${immutableCapture.sha256} child=PASS BigInt=PASS MantleTriState=PASS BnbTriState=PASS accountingGate=NOT_MET/777s caps=220/20/8`);
}

function verify() {
  const runner = runnerRecord();
  const immutableCapture = captureRecord();
  const capture = json(CAPTURE);
  const raw = json(RAW);
  const worksheet = json(WORKSHEET);
  const manifest = json(MANIFEST);
  for (const expected of manifest.records) {
    const actual = record(expected.path);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`manifest mismatch: ${expected.path}`);
  }
  const aggregate = sha256(Buffer.from(manifest.records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")));
  if (aggregate !== manifest.aggregateSha256) throw new Error("manifest aggregate mismatch");
  if (capture.requestCounts.jsonRpc !== capture.rpcTranscript.length || capture.requestCounts.jsonRpc > capture.caps.maxRpcReads) throw new Error("RPC transcript/budget mismatch");
  if (capture.requestCounts.metadata !== capture.metadataTranscript.length || capture.requestCounts.metadata > capture.caps.maxMetadataRequests) throw new Error("metadata transcript/budget mismatch");
  const allowedMethods = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"]);
  if (capture.rpcTranscript.some((x) => !allowedMethods.has(x.method))) throw new Error("non-read-only/history RPC method observed");
  for (const [key, chain] of Object.entries(raw.chainCoverage)) {
    if (!chain.reached) continue;
    const chainRows = capture.rpcTranscript.filter((x) => x.chain === key);
    if (!chain.chainIdBound || !chain.terminalSameHash || !chainRows.some((x) => x.label === "pin.chainId") || !chainRows.some((x) => x.label === "pin.terminalSameNumber")) throw new Error(`pin/chainId/terminal binding failed: ${key}`);
  }
  if (raw.routeCoverage.configuredRoutes > 8 || Object.keys(raw.chainCoverage).length > 9) throw new Error("route/chain cap invariant failed");
  if (runner.sha256 !== manifest.immutableRunner.sha256 || !manifest.immutableRunner.immutablePreHashMatch) throw new Error("runner manifest binding failed");
  if (immutableCapture.sha256 !== manifest.immutableCapture.sha256 || manifest.immutableCapture.attemptedExecutionExact !== false || manifest.immutableCapture.retainedTranscriptExact !== true) throw new Error("immutable capture/execution provenance mismatch");
  if (raw.priorAuthorizationBinding.manifestAggregateSha256 !== "82c4a08e3f8e27bf29836191f46e7f57513bd9b9d331cae1fd13b94bb964f88d") throw new Error("prior r2 binding failed");
  if (record(PRIOR_MANIFEST).sha256 !== raw.priorAuthorizationBinding.manifestSha256 || record(PRIOR_RAW).sha256 !== raw.priorAuthorizationBinding.rawSha256) throw new Error("prior authorization artifacts changed after immutable capture");
  if (raw.status === "MODEL_NOT_ESTABLISHED" && raw.classification !== "INCOMPLETE/WATCH/MODEL_NOT_ESTABLISHED") throw new Error("model classification mismatch");
  if (raw.status === "PASS" && !worksheet.completeness.modelComplete) throw new Error("PASS without complete model");
  if (raw.status === "FAIL" && (!worksheet.completeness.modelComplete || worksheet.totals.deficitNormalized == null || BigInt(worksheet.totals.deficitNormalized) <= 0n)) throw new Error("FAIL without complete exact deficit");
  if (raw.routePositive !== 0 || raw.executableNow !== 0 || raw.signedActionJustified !== false) throw new Error("global gates changed");
  if (raw.captureProvenance.attemptedExecutionExact !== false || raw.captureProvenance.retainedTranscriptExact !== true || raw.captureProvenance.retainedTranscriptCount !== 1) throw new Error("attempt/transcript provenance qualification failed");
  if (raw.successorPassFailGate.pass !== false || raw.successorPassFailGate.status !== "NOT_MET" || raw.successorPassFailGate.accountingStateTimestampSpreadSeconds !== "777" || worksheet.completeness.synchronizedAccountingOrInFlightGatePassed !== false || worksheet.completeness.modelComplete !== false) throw new Error("mandatory synchronized accounting/in-flight gate failed");
  const mantle = raw.counterpartRoutes.find((x) => x.chain.key === "mantle");
  const bsc = raw.counterpartRoutes.find((x) => x.chain.key === "bsc");
  if (!mantle || mantle.unknownSupplyRaw !== null || mantle.authority.authorityInterfaceEnumerationEstablished !== null || [mantle.authority.poolTypeBurnMint, mantle.authority.currentExclusiveMinter, mantle.authority.poolBurner].some((x) => x !== null) || mantle.pool?.runtime?.bytes !== null || mantle.pool?.runtime?.keccak256 !== null || mantle.pool?.runtime?.present !== null || mantle.token?.runtime?.bytes !== null || mantle.token?.runtime?.keccak256 !== null || mantle.token?.runtime?.present !== null || !mantle.unknownLiabilityReasons.some((x) => x.code === "FIXED_PIN_STATE_UNAVAILABLE_HTTP_403")) throw new Error("Mantle runtime/authority tri-state semantics failed");
  if (!bsc || bsc.authority.authorityInterfaceEnumerationEstablished !== false || bsc.authority.currentExclusiveMinter !== null || bsc.authority.poolBurner !== null || bsc.authority.historicalMintMigrationAlternateBridgeProvenanceScanned !== false || !bsc.unknownLiabilityReasons.some((x) => x.code === "AUTHORITY_INTERFACE_ENUMERATION_UNAVAILABLE") || !bsc.unknownLiabilityReasons.some((x) => x.code === "HISTORICAL_MINT_MIGRATION_ALTERNATE_BRIDGE_PROVENANCE_UNSCANNED")) throw new Error("BNB authority/history tri-state semantics failed");
  if (raw.sourceRuntimeStatus.counterparts.some((x) => x.poolSourceRuntimeEquivalence !== null || x.tokenSourceRuntimeEquivalence !== null)) throw new Error("counterpart source/runtime null semantics changed");
  const custody = BigInt(worksheet.ethereumCustody.raw);
  const reconstructed = BigInt(worksheet.ethereumCustody.normalized) / pow10(worksheet.normalizationDecimals - worksheet.ethereumCustody.decimals);
  if (custody !== reconstructed) throw new Error("worksheet custody arithmetic mismatch");
  const generated = [CAPTURE, RAW, WORKSHEET, MANIFEST, REPORT, INBOX, HANDOFF].map(text).join("\n");
  if (/https?:\/\//i.test(generated)) throw new Error("URL/domain/endpoint leak in generated artifacts");
  if (/(?:api[_-]?key|bearer|authorization)\s*[:=]/i.test(generated)) throw new Error("token/header leak in generated artifacts");
  if (!text(REPORT).includes(`Signal: ${raw.signal}`)) throw new Error("report signal missing");
  const normalizedArtifacts = [RAW, WORKSHEET, REPORT, INBOX, HANDOFF].map(text).join("\n");
  if (/reciprocal Ethereum pool\/token route not exact|pool\/token identity or decimals mismatch/i.test(normalizedArtifacts)) throw new Error("observed-mismatch wording leaked into normalized artifacts");
  if (!normalizedArtifacts.includes("not established because fixed-pin state calls unavailable (HTTP 403)")) throw new Error("Mantle not-established qualification missing");
  console.log(`verify PASS run=${raw.runId} revision=${raw.revision} classification=${raw.classification} runner=${runner.sha256} records=${manifest.records.length} rpc=${capture.requestCounts.jsonRpc}/${capture.caps.maxRpcReads} metadata=${capture.requestCounts.metadata}/${capture.caps.maxMetadataRequests} pins=true BigInt=true leak=false signal=true gates=0/0/false aggregate=${manifest.aggregateSha256}`);
}

const mode = process.argv[2];
if (mode === "--self-test") selfTest();
else if (mode === "--network-once") runNetworkOnce();
else if (mode === "--package") packageCapture();
else if (mode === "--verify") verify();
else throw new Error("mode required: --self-test, --network-once, --package, or --verify");
