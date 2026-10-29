#!/usr/bin/env node
"use strict";

// Deterministic/offline Lombard LBTC step-5 backing and non-EVM liability discovery.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const RAW_REL = "reports/raw/fast/lombard-lbtc-backing-liability-discovery.json";
const REPORT_REL = "reports/lombard-lbtc-backing-liability-discovery-triage.md";
const HANDOFF_REL = "coordination/handoffs/2026-07-11-coordinator-lombard-step5-handoff.md";
const INPUTS = [
  "reports/raw/fast/lombard-lbtc-endpoint-state.json",
  "targets/lombard-evm-smart-contracts/mainnet.json",
  "targets/lombard-evm-smart-contracts/contracts/ibc/IBCVoucher.sol",
  "targets/lombard-evm-smart-contracts/contracts/bridge/README.md",
  "targets/lombard-evm-smart-contracts/contracts/bridge/oft/LBTCOFTAdapter.sol",
  "targets/lombard-evm-smart-contracts/contracts/bridge/oft/LBTCBurnMintOFTAdapter.sol",
];
const RESEARCH_DATE = "2026-07-11";
const CONTRACTS_PAGE_URL = "https://docs.lombard.finance/technical-documentation/contract-addresses";
const POR_PAGE_URL = "https://www.lombard.finance/proof-of-reserves";
const WITHDRAWALS_PAGE_URL = "https://docs.lombard.finance/technical-documentation/withdrawals";
const RISK_PAGE_URL = "https://docs.lombard.finance/technical-documentation/risk-management";

function sha256(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function readInput(rel) {
  const data = fs.readFileSync(path.join(ROOT, rel));
  return { rel, data, evidence: { path: rel, bytes: data.length, sha256: sha256(data), loaded: true } };
}
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
function atomicWrite(rel, text) {
  const target = path.join(ROOT, rel), temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, text, "utf8");
  fs.renameSync(temp, target);
}
function externalClaim(claim, sourceUrl, notes) {
  return { claim, classification: "recordedExternalClaimUnverified", fetchedByScanner: false, sourceUrl, researchDate: RESEARCH_DATE, reproducible: false, reproducibilityBlocker: "No hashed source-page snapshot is present in the permitted local evidence.", notes };
}

function buildIdentitySeeds(mainnet, mainnetEvidence) {
  const solanaEvmAdapter = mainnet?.mainnet?.layerZero?.LBTCOFTAdapter_solana || null;
  const blocked = (ecosystem, kind, query) => ({ ecosystem, identifierKind: kind, identifier: null, exactIdentityStatus: "blocked-no-full-exact-identifier-in-local-evidence", classification: "scannerDerivedCoverageGap", fetchedByScanner: false, derivation: "No full exact identifier occurs in the hashed permitted local inputs.", requiredVerification: query });
  return [
    blocked("Solana", "spl-token-mint", "Obtain the full registry mint and verify mint owner program, decimals, supply, mint authority and freeze authority."),
    blocked("Solana", "program-id", "Obtain the full registry program ID and verify executable account and upgrade authority/program-data account."),
    blocked("Solana", "config-pda", "Obtain the full registry config PDA and reproduce PDA derivation from the verified program."),
    blocked("Solana", "oft-adapter-or-store", "Obtain the full Solana-side OFT adapter/store identity and verify peer, endpoint, mint and delegate bindings."),
    { ecosystem: "Solana", identifierKind: "ethereum-lock-adapter-for-solana-rail", identifier: solanaEvmAdapter, exactIdentityStatus: solanaEvmAdapter ? "exact-local-evm-registry-seed" : "blocked", classification: "localRegistrySeed", fetchedByScanner: false, sourcePath: mainnetEvidence.path, sourcePointer: "/mainnet/layerZero/LBTCOFTAdapter_solana", sourceSha256: mainnetEvidence.sha256, limitation: "This EVM adapter is not the Solana mint, program, config PDA, or Solana OFT store." },
    blocked("Sui", "coin-type", "Full Move coin type is not established by the local evidence; verify package, module and struct type without abbreviation."),
    blocked("Sui", "package-id", "Full package ID is not established by the local evidence; verify package digest, upgrade capability and current package lineage."),
    blocked("Starknet", "token-contract", "Obtain the full felt contract address and verify class hash, proxy implementation/admin, name, symbol, decimals and total_supply."),
    blocked("Cosmos", "ibc-denom", "Obtain the exact full ibc/{SHA256 trace} denom and verify denom trace, source port/channel and bank metadata."),
    blocked("Babylon", "ibc-denom", "Obtain the exact full ibc/{SHA256 trace} denom and verify denom trace, source port/channel and bank metadata."),
  ].sort((a, b) => `${a.ecosystem}:${a.identifierKind}`.localeCompare(`${b.ecosystem}:${b.identifierKind}`));
}

function buildQueries() {
  return [
    { ecosystem: "Solana", status: "unknown-no-live-query", fixedPoint: "slot", stateQueries: ["getAccountInfo(mint)", "getTokenSupply(mint)", "getAccountInfo(program/config/OFT-store)", "getProgramAccounts only after verified owner/layout"], verification: ["SPL Token versus Token-2022 owner", "mint/freeze authorities", "program executable flag", "program-data upgrade authority", "PDA derivation", "OFT peer/endpoint/mint binding"] },
    { ecosystem: "Sui", status: "unknown-no-live-query", fixedPoint: "checkpoint", stateQueries: ["sui_getObject(package/metadata/treasury-cap/config)", "suix_getCoinMetadata(coin-type)", "suix_getTotalSupply(coin-type) when supported", "dynamic-field reads from verified config objects"], verification: ["full coin type", "package digest and linkage", "upgrade capability", "treasury-cap authority", "shared-object version", "bridge/package configuration"] },
    { ecosystem: "Starknet", status: "unknown-no-live-query", fixedPoint: "block number/hash", stateQueries: ["starknet_getClassHashAt(token)", "starknet_call name/symbol/decimals/total_supply", "proxy implementation/admin getters only after ABI/source verification"], verification: ["full token address", "class hash", "proxy implementation/admin", "mint/burn authority", "bridge configuration"] },
    { ecosystem: "Cosmos", status: "unknown-no-live-query", fixedPoint: "consensus height", stateQueries: ["cosmos.bank.v1beta1.Query/SupplyOf(exact denom)", "cosmos.bank.v1beta1.Query/DenomMetadata", "ibc.applications.transfer.v1.Query/DenomTrace"], verification: ["exact IBC denom hash", "full denom trace", "source port/channel", "escrow/burn-mint semantics", "module/account authority"] },
    { ecosystem: "Babylon", status: "unknown-no-live-query", fixedPoint: "Babylon height plus referenced BTC height", stateQueries: ["cosmos.bank.v1beta1.Query/SupplyOf(exact denom)", "IBC denom-trace query", "BTC staking delegation/finality-provider/unbonding queries only after exact module/version schema is pinned"], verification: ["exact IBC denom", "module version", "active stake", "pending unbonding", "slashing state", "BTC outpoint linkage"] },
  ].sort((a, b) => a.ecosystem.localeCompare(b.ecosystem));
}

function buildEvmBaseline(step4, step4Evidence) {
  const pins = new Map((step4.chains || []).filter(c => c.pin).map(c => [c.chainId, c]));
  return (step4.liabilityReconciliation?.perRailRows || []).map(row => {
    const chain = pins.get(row.chainId);
    const isVoucher = row.component === "IBCVoucher";
    return {
      chainId: row.chainId,
      chainName: row.chainName,
      component: row.component,
      address: row.address,
      rail: isVoucher ? "burn-source-mint-voucher-replacement-liability" : row.rail,
      liabilityMode: isVoucher ? "burn-source/mint-voucher replacement liability" : row.adapterMode || row.rail,
      adapterMode: row.adapterMode || null,
      deduplicationStatus: isVoucher ? "count outstanding voucher supply once alongside remaining canonical supply in a future mode-aware reconciliation; transit and fees remain separate; do not aggregate now" : row.doubleCountingPolicy || row.backingTreatment || "unclassified-do-not-aggregate",
      rawSupply: row.rawSupply ?? null,
      decimalSupply: row.decimalSupply ?? null,
      adjustedBtcLiabilityFloorRaw: row.exchangeRateAdjustedBtcLiabilityFloorRaw ?? null,
      adjustedBtcLiabilityCeilingRaw: row.exchangeRateAdjustedBtcLiabilityCeilingRaw ?? null,
      adjustedBtcLiabilityFloor: row.exchangeRateAdjustedBtcLiabilityFloor ?? null,
      adjustedBtcLiabilityCeiling: row.exchangeRateAdjustedBtcLiabilityCeiling ?? null,
      underlyingBalanceRaw: row.underlyingBalanceRaw ?? null,
      formula: row.formula || null,
      assumptions: row.assumptions || null,
      coverageStatus: row.coverageStatus,
      fixedPoint: chain?.pin ? { chainId: row.chainId, blockNumber: chain.pin.blockNumber, blockHash: chain.pin.blockHash, timestamp: chain.pin.timestamp, resolutionSource: chain.resolutionSource } : null,
      provenance: { inputPath: step4Evidence.path, inputSha256: step4Evidence.sha256, generatedAt: step4.generatedAt, scanner: step4.scanner },
      aggregateTreatment: "preserve-row-no-naive-sum",
    };
  }).sort((a, b) => `${String(a.chainId).padStart(10, "0")}:${a.component}:${a.address}`.localeCompare(`${String(b.chainId).padStart(10, "0")}:${b.component}:${b.address}`));
}

function renderReport(raw) {
  const m = raw.metrics;
  const lines = [
    "# Lombard LBTC backing and non-EVM liability discovery",
    "",
    `**Signal:** ${raw.signal}`,
    `**Classification:** ${raw.classification}`,
    "",
    "> Deterministic offline discovery only. External statements are recorded assertions, not scanner-observed current state.",
    "",
    "## EVM liability baseline",
    "",
    `- Step-4 rows preserved: ${m.evmLiabilityRows}; covered supply rows: ${m.evmCoveredSupplyRows}; adjusted Staked rows: ${m.evmAdjustedRows}.`,
    `- Resolved EVM configurations: ${m.resolvedEvmConfigurations}; unresolved: ${m.unresolvedEvmConfigurations}.`,
    `- Unresolved names: ${raw.evmBaseline.unresolvedConfigurations.join(", ")}.`,
    "- Rails are not summed: canonical issuance, native issuance, vouchers, lock escrow and burn/mint context have unresolved overlap and mode classification.",
    "",
    "| Chain | Component / rail | Decimal supply | Raw escrow/context | Adjusted ceiling | Block | Timestamp | Dedup status |",
    "|---|---|---:|---:|---:|---:|---|---|",
  ];
  for (const row of raw.evmBaseline.rows) lines.push(`| ${row.chainName} | ${row.component} / ${row.rail} | ${row.decimalSupply ?? (row.rawSupply === null ? "—" : "unknown")} | ${row.underlyingBalanceRaw === null ? "—" : `${row.underlyingBalanceRaw} raw units`} | ${row.adjustedBtcLiabilityCeiling ?? "—"} | ${row.fixedPoint?.blockNumber ?? "—"} | ${row.fixedPoint?.timestamp ?? "—"} | ${row.deduplicationStatus} |`);
  lines.push("", "## Non-EVM identities and fixed-point reads", "", `- Identity rows: ${m.identitySeedRows}; exact non-EVM identities established locally: ${m.exactNonEvmIdentityRows}; blocked exact identities: ${m.blockedIdentityRows}.`, "- Full identifiers are never abbreviated. Where the local official-registry snapshot is absent, exact identity is blocked rather than invented.", "");
  for (const id of raw.identityCoverageRows) lines.push(`- **${id.ecosystem} / ${id.identifierKind}** — ${id.identifier ?? id.exactIdentityStatus}; taxonomy=${id.classification}; fetchedByScanner=${id.fetchedByScanner}.`);
  lines.push("");
  for (const q of raw.nonEvmStateQueries) lines.push(`- **${q.ecosystem}** — fixed point: ${q.fixedPoint}; status: ${q.status}; queries: ${q.stateQueries.join("; ")}; verification: ${q.verification.join("; ")}.`);
  lines.push("", "## PoR and backing provenance", "", "- Optimism/EVM oracle context: `0x1De9fcfeDF3E51266c188ee422fbA1c7860DA0eF` is an inherited fixed-block observation from the hashed step-4 artifact. A price/fundamental oracle answer is not a reserve amount.", "- Base reserve-address-list seed: `0xe7Ebc588F4EC9297d9867aD75a9b5D86848c8018` is a hashed local-registry seed. An address list is not Bitcoin balances or spend-authority proof.", "- Claimed 10-minute cadence, withdrawal timing and slashing cap remain unverified external claims without hashed source-page snapshots.", "- Dashboard HTTP 403 is a research-access observation, not an official protocol assertion or scanner network result.", "", "## IBC voucher semantics", "", "IBCVoucher is a **burn-source/mint-voucher replacement liability**. A future mode-aware reconciliation counts outstanding voucher supply once alongside remaining canonical supply; transit and fees stay separate. The current artifact still performs no aggregate arithmetic.", "", "## Backing buckets", "");
  for (const b of raw.backingBuckets) lines.push(`- ${b.bucket}: **${b.status}** — ${b.requirement}`);
  lines.push("", "Recorded disclosures only: withdrawals may take up to 10 days; a slashing event is described as capped at 0.1%. Neither statement supplies current balances or loss realization.", "", "## Reconciliation-window policy", "", ...raw.reconciliationWindowPolicy.rules.map(x => `- ${x}`), "", raw.reconciliationWindowPolicy.conclusion, "", "## Conclusion", "", `**${raw.classification}**`, "", `Current exposure: **${raw.currentExposureStatus}**. No exploit, solvency failure, or permissionless invariant violation is proven. Zero positive routes are proven; backing and global liabilities remain unknown.`, "", "## Next bounded step", "", raw.nextStep, "");
  return lines.join("\n");
}

function renderHandoff(raw) {
  return [
    "# Coordinator Handoff — Lombard LBTC Step 5 — 2026-07-11",
    "",
    `- Classification: **${raw.classification}**`,
    `- Preserved ${raw.metrics.evmLiabilityRows} step-4 EVM rail rows without summing incompatible or duplicate-prone liabilities.`,
    `- Six EVM configurations remain unresolved: ${raw.evmBaseline.unresolvedConfigurations.join(", ")}.`,
    `- Non-EVM query plans: ${raw.metrics.nonEvmQueryRows}; exact non-EVM identity rows established from current local evidence: ${raw.metrics.exactNonEvmIdentityRows}; blocked identities: ${raw.metrics.blockedIdentityRows}.`,
    "- Provenance is separated: Base PoR is a hashed local-registry seed; Optimism PoR is inherited fixed-block context; cadence/withdrawal/slashing are unverified external claims; dashboard 403 is a research-access observation; absent identities are scanner-derived coverage gaps.",
    "- IBCVoucher is classified as burn-source/mint-voucher replacement liability: outstanding vouchers are counted once alongside remaining canonical supply only in a future mode-aware reconciliation, with transit and fees separate.",
    "- All five backing buckets remain unknown; no PoR context is reproducible custody evidence.",
    "- Exact same-time reconciliation remains impossible without coordinated EVM/BTC/Solana/Sui/Starknet/Cosmos/Babylon fixed points and explicit in-flight buckets.",
    "",
    "## Next bounded step",
    "",
    "Perform fixed-point non-EVM reads after exact identities are independently verified, verify the PoR ABI/source and payload schema, and capture Bitcoin custody addresses plus balances, active stake, pending unbonding, bridge transit and slashing effects at a bounded reconciliation window. If private endpoint inventories are needed, obtain explicit current-turn authorization before reading them. No fork, executor, transaction, signing, wallet or aggregate promotion is justified.",
    "",
    "## Closed gates",
    "",
    "`routePositive=0`, `routeEvidenceStatus=unknown`, `evidenceComplete=false`, `closureEligible=false`, `executableNow=0`, `signedActionJustified=false`, `forkJustified=false`.",
    "",
  ].join("\n");
}

function main() {
  const loaded = INPUTS.map(readInput), byRel = new Map(loaded.map(x => [x.rel, x]));
  const step4 = JSON.parse(byRel.get(INPUTS[0]).data.toString("utf8"));
  const mainnet = JSON.parse(byRel.get(INPUTS[1]).data.toString("utf8"));
  const step4Evidence = byRel.get(INPUTS[0]).evidence;
  const evmRows = buildEvmBaseline(step4, step4Evidence);
  const unresolvedConfigurations = (step4.chains || []).filter(c => !c.pin).map(c => c.chainName).sort();
  const mainnetEvidence = byRel.get(INPUTS[1]).evidence;
  const identitySeeds = buildIdentitySeeds(mainnet, mainnetEvidence), nonEvmStateQueries = buildQueries();
  const optimismChain = (step4.chains || []).find(c => c.chainId === 10);
  const porEvidence = [
    { classification: "localRegistrySeed", label: "Base reserve-address-list contract", value: mainnet?.base?.lombard?.PoR || null, sourcePath: mainnetEvidence.path, sourcePointer: "/base/lombard/PoR", sourceSha256: mainnetEvidence.sha256, fetchedByScanner: false, interpretation: "Address-list seed only; not Bitcoin balances or spend-authority proof." },
    { classification: "inheritedFixedBlockObservation", label: "Optimism PoR/fundamental oracle", value: step4.porObservation?.address || null, sourcePath: step4Evidence.path, sourcePointer: "/porObservation", sourceSha256: step4Evidence.sha256, inheritedFixedPoint: optimismChain?.pin || null, fetchedByScanner: false, interpretation: "Inherited price/fundamental-oracle context; not a reserve amount." },
  ];
  const externalClaims = [
    externalClaim("Attestations are claimed on an approximately 10-minute cadence.", POR_PAGE_URL, "Cadence is not a reproducible payload, reserve balance or custody proof."),
    externalClaim("Withdrawals may take up to 10 days.", WITHDRAWALS_PAGE_URL, "Timing disclosure only; no current queue or unbonding amount was observed."),
    externalClaim("Maximum loss per slashing event is described as 0.1%.", RISK_PAGE_URL, "Risk disclosure only; no current slashing state or realized loss was observed."),
  ];
  const researchAccessObservations = [
    { classification: "researchAccessObservation", observation: "The official proof-of-reserves dashboard returned HTTP 403/inaccessible during research; no public documented payload/schema was obtained.", sourceUrl: POR_PAGE_URL, researchDate: RESEARCH_DATE, fetchedByScanner: false, scannerNetworkFetch: false, protocolAssertion: false },
  ];
  const backingBuckets = [
    { bucket: "liquid-custody", status: "unknown", requirement: "Verified Bitcoin addresses, spend policy and balances at the reconciliation BTC height." },
    { bucket: "active-babylon-stake", status: "unknown", requirement: "Outpoint-bound active stake and finality-provider state at matched Babylon/BTC heights." },
    { bucket: "pending-unbonding", status: "unknown", requirement: "Current unbonding queue, maturity heights/times and expected recoverable value." },
    { bucket: "pending-bridge-transit", status: "unknown", requirement: "Messages/deposits/withdrawals in flight across every issuance rail, deduplicated from issued supply." },
    { bucket: "slashing-effects", status: "unknown", requirement: "Detected slash events, affected outpoints, realized/pending loss and liability treatment." },
  ];
  const metrics = {
    localInputs: loaded.length,
    evmLiabilityRows: evmRows.length,
    evmCoveredSupplyRows: evmRows.filter(x => x.rawSupply !== null).length,
    evmAdjustedRows: evmRows.filter(x => x.adjustedBtcLiabilityCeiling !== null).length,
    resolvedEvmConfigurations: (step4.chains || []).filter(c => c.pin).length,
    unresolvedEvmConfigurations: unresolvedConfigurations.length,
    identitySeedRows: identitySeeds.length,
    exactNonEvmIdentityRows: identitySeeds.filter(x => x.exactIdentityStatus === "exact-official-identifier").length,
    blockedIdentityRows: identitySeeds.filter(x => String(x.exactIdentityStatus).startsWith("blocked")).length,
    nonEvmQueryRows: nonEvmStateQueries.length,
    porEvidenceRows: porEvidence.length,
    externalClaimRows: externalClaims.length,
    researchAccessObservationRows: researchAccessObservations.length,
    backingBuckets: backingBuckets.length,
    networkCalls: 0,
  };
  const raw = {
    snapshotLabel: "2026-07-11-lombard-step5-backing-liability-discovery",
    deterministicOutputPolicy: "No runtime timestamp, endpoint input or network response is used; stable key sorting and row sorting make unchanged local inputs byte-identical.",
    scanner: "tools/scan-lombard-lbtc-backing-liability-discovery.js",
    signal: "🟠 WATCH",
    classification: "INCOMPLETE/WATCH — BACKING AND NON-EVM STATE BLOCKED",
    currentExposureStatus: "unknown-global-backing-and-non-evm-liability-gap",
    provenance: { localInputs: loaded.map(x => x.evidence), step4SourceCommit: step4.sourceCommit, taxonomyPolicy: "Local seeds and inherited fixed-block observations are distinguished from scanner-derived gaps, unverified external claims and research-access observations." },
    metrics,
    evmBaseline: { aggregationStatus: "unknown-partial-do-not-naively-sum-rails", unresolvedConfigurations, rows: evmRows },
    identityCoverageRows: identitySeeds,
    nonEvmStateQueries,
    porEvidence,
    externalClaims,
    researchAccessObservations,
    porInterpretation: { priceOrFundamentalOracleIsReserveAmount: false, reserveAddressListIsBitcoinBalanceProof: false, cadenceClaimIsReproducibleReserveEvidence: false, dashboardStatusDuringResearch: "http-403-inaccessible", publicDocumentedPayloadSchemaObtained: false, scannerNetworkFetch: false },
    backingBuckets,
    reconciliationWindowPolicy: {
      status: "blocked-no-cross-system-fixed-window",
      requiredFixedPoints: ["EVM block number/hash/timestamp per chain", "Bitcoin block height/hash", "Solana slot/block time", "Sui checkpoint/digest", "Starknet block number/hash", "Cosmos height/app hash", "Babylon height/app hash plus referenced BTC height"],
      rules: [
        "Choose an anchor UTC time and record every system's finalized fixed point, hash and timestamp; never use latest without a pin.",
        "Declare maximum skew before collection. Target <=10 minutes only if every source exposes finalized timestamps; otherwise report measured skew and reject aggregate solvency arithmetic.",
        "Separate liquid custody, active stake, pending unbonding, pending deposit/withdrawal/bridge transit, slash-pending and realized-slash buckets.",
        "Bind every liability to exact token identity, decimals, bridge mode and fixed point; deduplicate lock/mint, burn/mint, voucher and transit representations before aggregation.",
        "Carry uncertainty ranges for state transitions between fixed points and exclude stale or identity-unverified rows from a solvency conclusion.",
      ],
      conclusion: "Exact same-time reconciliation is impossible from current official disclosures because no reproducible reserve payload/schema, complete Bitcoin address set, synchronized non-EVM supplies, or in-flight transition ledger is locally available.",
    },
    conclusion: { exploitProven: false, solvencyFailureProven: false, permissionlessInvariantViolationProven: false, deployedVulnerabilityClaims: 0, permissionlessInvariantViolations: 0 },
    gates: { routePositive: 0, routePositiveMeaning: "zero-proven-positive-routes", routeEvidenceStatus: "unknown", evidenceComplete: false, closureEligible: false, executableNow: 0, signedActionJustified: false, forkJustified: false },
    safety: { deterministicOffline: true, networkCalls: false, rpcInventoryRead: false, graphqlInventoryRead: false, envFilesRead: false, secretsRead: false, privateKeysRead: false, wallets: false, transactions: false, mutations: false, forks: false, deployments: false, executor: false },
    blockers: ["Exact Solana mint/program/config/OFT identities absent from current local official-registry evidence", "Exact Sui coin type/package absent", "Exact Starknet token address absent", "Exact Cosmos and Babylon IBC denoms absent", "Six EVM configurations unresolved in step 4", "No synchronized Bitcoin custody/stake/unbonding/transit/slashing state", "Official dashboard payload/schema unavailable"],
    nextStep: "After exact identities are independently verified, perform fixed-point non-EVM reads plus verified PoR ABI/source and Bitcoin address/balance capture. Explicit current-turn authorization is required before any private endpoint inventory is read; no fork or executor.",
  };
  if (metrics.unresolvedEvmConfigurations !== 6 || metrics.backingBuckets !== 5 || metrics.nonEvmQueryRows !== 5) throw new Error("bounded coverage fixture failed");
  if (raw.externalClaims.some(x => x.classification !== "recordedExternalClaimUnverified" || x.fetchedByScanner !== false || !x.sourceUrl || !x.researchDate || x.reproducible !== false)) throw new Error("external claim provenance failed");
  if (raw.researchAccessObservations.some(x => x.classification !== "researchAccessObservation" || x.fetchedByScanner !== false || x.protocolAssertion !== false)) throw new Error("research observation provenance failed");
  if (raw.identityCoverageRows.filter(x => x.identifier === null).some(x => x.classification !== "scannerDerivedCoverageGap")) throw new Error("identity gap taxonomy failed");
  if (raw.porEvidence.find(x => x.label.startsWith("Base"))?.classification !== "localRegistrySeed" || raw.porEvidence.find(x => x.label.startsWith("Optimism"))?.classification !== "inheritedFixedBlockObservation") throw new Error("PoR taxonomy failed");
  if (raw.evmBaseline.rows.find(x => x.component === "IBCVoucher")?.liabilityMode !== "burn-source/mint-voucher replacement liability") throw new Error("voucher semantics failed");
  if (raw.identityCoverageRows.some(x => typeof x.identifier === "string" && x.identifier.includes("..."))) throw new Error("abbreviated identifier forbidden");
  if (raw.gates.routePositive !== 0 || raw.gates.routeEvidenceStatus !== "unknown" || raw.gates.evidenceComplete || raw.gates.closureEligible || raw.gates.executableNow !== 0 || raw.gates.signedActionJustified || raw.gates.forkJustified) throw new Error("gate check failed");
  const json = serialize(raw), report = renderReport(raw), handoff = renderHandoff(raw);
  atomicWrite(RAW_REL, json);
  atomicWrite(REPORT_REL, report);
  atomicWrite(HANDOFF_REL, handoff);
  process.stdout.write(`rawSha256=${sha256(json)} evmRows=${metrics.evmLiabilityRows} coveredSupplyRows=${metrics.evmCoveredSupplyRows} adjustedRows=${metrics.evmAdjustedRows} unresolvedEvm=${metrics.unresolvedEvmConfigurations} identityRows=${metrics.identitySeedRows} blockedIdentityRows=${metrics.blockedIdentityRows} nonEvmQueries=${metrics.nonEvmQueryRows} backingBuckets=${metrics.backingBuckets} networkCalls=0\n`);
}

main();
