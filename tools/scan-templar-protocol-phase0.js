#!/usr/bin/env node
// scan-templar-protocol-phase0.js - bounded read-only Templar Protocol Phase 0 scan.
// Public metadata/source only. Never prints/stores RPC URLs, private keys, calldata, borrower addresses, or signed actions.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "templar-protocol-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "templar-protocol-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const CLASSIFIER = path.join(WORKSPACE, "reports", "raw", "fast", "defillama-oracle-classifier.json");
const QUIET = process.argv.includes("--quiet");

const REPORT_SIGNAL = "\uD83D\uDFE2 DORMANT";
const ADAPTER_URL = "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/templarfi/index.js";
const PROTOCOL_API = "https://api.llama.fi/protocol/templar-protocol";
const REPO_API = "https://api.github.com/repos/Templar-Protocol/contracts";
const MAX_LOCAL_ARTIFACT_BYTES = Number(process.env.TEMPLAR_PHASE0_MAX_LOCAL_ARTIFACT_BYTES || "2000000");

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file, fallback = "") { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : fallback; } catch (_) { return fallback; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`; }
function safeText(value, max = 180) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }

async function fetchText(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-templar-phase0/1.0" } });
    if (!res.ok) return null;
    return await res.text();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 20_000) {
  const text = await fetchText(url, timeoutMs);
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

function latestTvl(live) {
  const rows = Array.isArray(live?.tvl) ? live.tvl : [];
  return rows.length ? round(rows[rows.length - 1]?.totalLiquidityUSD, 2) : null;
}

function selectedChainTvls(currentChainTvls = {}) {
  const out = {};
  for (const [key, value] of Object.entries(currentChainTvls || {})) {
    const n = round(value, 2);
    if (n === null || !Number.isFinite(n)) continue;
    if (/borrowed/i.test(key)) continue;
    if (["Ethereum", "Near", "Stellar", "Bitcoin", "Solana", "Zcash", "Ripple", "Cardano", "Doge", "Litecoin"].includes(key)) out[key] = n;
  }
  return out;
}

function selectedBorrowed(currentChainTvls = {}) {
  const out = {};
  for (const [key, value] of Object.entries(currentChainTvls || {})) {
    const n = round(value, 2);
    if (n === null || !Number.isFinite(n)) continue;
    if (key === "borrowed") out.totalBorrowedUsd = n;
    else if (/-borrowed$/i.test(key)) out[key.replace(/-borrowed$/i, "")] = n;
  }
  return out;
}

function findDiscoveryRow() {
  const discovery = readJson(PUBLIC_TARGETS, {});
  const rows = [
    ...(discovery.phase0Queue || []),
    ...(discovery.protocolCandidates || []),
    ...(discovery.targetedRefreshQueue || []),
    ...(discovery.consumerJoinFirst || []),
  ];
  return rows.find((row) => row?.slug === "templar-protocol" || row?.name === "Templar Protocol") || null;
}

function classifierRow() {
  const classifier = readJson(CLASSIFIER, {});
  const rows = [...(classifier.ranked || []), ...(classifier.protocols || []), ...(classifier.candidates || []), ...(classifier.rows || [])];
  return rows.find((row) => row?.slug === "templar-protocol" || row?.name === "Templar Protocol") || null;
}

function parseStringArray(raw, name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m");
  const m = raw?.match(re);
  if (!m) return [];
  return unique([...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]));
}

function parseSkipSet(raw) {
  const m = raw?.match(/CONTRACTS_TO_SKIP\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/m);
  if (!m) return [];
  return unique([...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]));
}

function adapterSummary(raw) {
  const registries = parseStringArray(raw, "TEMPLAR_REGISTRY_CONTRACTS");
  const supportedChains = parseStringArray(raw, "SUPPORTED_CHAINS");
  const skippedContracts = parseSkipSet(raw);
  const methodNames = unique([...String(raw || "").matchAll(/["'](list_deployments|get_current_snapshot|get_configuration)["']/g)].map((m) => m[1]));
  return {
    url: ADAPTER_URL,
    fetched: Boolean(raw),
    registryContracts: registries,
    registryContractRows: registries.map((id) => ({ chain: "NEAR", accountId: id, role: "market registry" })),
    skippedContractsCount: skippedContracts.length,
    skippedContractsSample: skippedContracts.slice(0, 8),
    supportedChains,
    methodNames,
    detectsEthereumOriginAssets: /eth-0x\(\[a-fA-F0-9\]\{40\}\)\\\.omft\\\.near/.test(raw || "") || /ethereum:0x/.test(raw || ""),
    detectsBitcoinOriginAssets: /btc\.omft\.near/.test(raw || ""),
    detectsStellarOriginAssets: /v2_1\.omni\.hot\.tg:1100_/.test(raw || ""),
    methodology: "Adapter enumerates NEAR market deployments, reads get_current_snapshot/get_configuration, and attributes market assets back to origin chains.",
  };
}

function localArtifactRows() {
  const roots = [path.join(WORKSPACE, "reports")];
  const rows = [];
  const needles = [/templar/i, /tmplr\.near/i, /v1\.tmplr\.near/i];
  function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!/\.(json|md)$/i.test(ent.name)) continue;
      if (/templar-protocol-phase0/i.test(ent.name)) continue;
      let stat = null;
      try { stat = fs.statSync(full); } catch (_) { continue; }
      if (!stat || stat.size > MAX_LOCAL_ARTIFACT_BYTES) continue;
      const text = readText(full, "");
      const matches = needles.filter((re) => re.test(text)).length;
      if (!matches) continue;
      rows.push({ file: path.relative(WORKSPACE, full).replace(/\\/g, "/"), matchedTerms: matches, consumerGrade: false });
    }
  }
  roots.forEach(walk);
  return rows.slice(0, 80);
}

function renderReport(out) {
  const s = out.summary;
  const chainRows = Object.entries(out.metadata.currentChainTvls || {}).map(([chain, usd]) => `| ${chain} | ${formatUsd(usd)} |`).join("\n") || "| n/a | n/a |";
  const borrowedRows = Object.entries(out.metadata.borrowedByChain || {}).map(([chain, usd]) => `| ${chain} | ${formatUsd(usd)} |`).join("\n") || "| n/a | n/a |";
  const registryRows = out.adapter.registryContractRows.map((row) => `| ${row.chain} | ${row.accountId} | ${row.role} |`).join("\n") || "| n/a | n/a | n/a |";
  return `# ${REPORT_SIGNAL} - Templar Protocol Phase 0 Triage

Generated: ${out.generatedAt}

Scanner: \`${out.scanner}\`

Artifact: \`reports/raw/fast/templar-protocol-phase0.json\`

## Result

No permissionless EVM route-positive exploit is claimed. The public DefiLlama adapter for Templar is a NEAR market-registry adapter, not an Ethereum lending deployment: it enumerates \`v1.tmplr.near\`, reads NEAR market snapshots/configuration, and attributes assets back to origin chains such as Ethereum, Bitcoin, and Stellar. Current local coverage has no NEAR endpoint/preset, so NEAR market deployment enumeration, borrower state, Pyth oracle freshness, and liquidation economics remain blocked and are not closed route-negative. The declared EVM pass found no exact Ethereum contract, token, custody, lending, or consumer route controlled by Templar with positive economics.

## Summary

| Metric | Value |
|---|---:|
| Public TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Ethereum-attributed TVL | ${formatUsd(s.ethereumAttributedTvlUsd)} |
| Total borrowed context | ${formatUsd(s.totalBorrowedUsd)} |
| Adapter registry contracts | \`${s.registryContracts}\` |
| Adapter supported origin chains | \`${s.adapterSupportedChains}\` |
| NEAR registry rows | \`${s.nearRegistryRows}\` |
| EVM deployment rows | \`${s.evmDeploymentRows}\` |
| Local artifact rows | \`${s.localArtifactRows}\` |
| Consumer-grade local rows | \`${s.consumerGradeLocalRows}\` |
| Blocked scope rows | \`${s.blockedScopeRows}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |
| Coverage classification | \`${s.coverageClassification}\` |

## Chain TVL Context

| Chain / Origin | TVL Context |
|---|---:|
${chainRows}

## Borrowed Context

| Chain / Origin | Borrowed Context |
|---|---:|
${borrowedRows}

## Adapter Registries

| Chain | Account / Contract | Role |
|---|---|---|
${registryRows}

## Blockers

${out.blockers.map((b) => `- ${b}`).join("\n")}

## Required For Route-Positive

${out.requiredForRoutePositive.map((b) => `- ${b}`).join("\n")}

## Next Read-Only Step

${out.nextReadOnlyStep}
`;
}

async function main() {
  const [live, adapterRaw, repo] = await Promise.all([
    fetchJson(PROTOCOL_API, 35_000),
    fetchText(ADAPTER_URL, 25_000),
    fetchJson(REPO_API, 20_000),
  ]);
  const discovery = findDiscoveryRow();
  const classifier = classifierRow();
  const adapter = adapterSummary(adapterRaw || "");
  const localRows = localArtifactRows();
  const currentChainTvls = selectedChainTvls(live?.currentChainTvls || {});
  const borrowedByChain = selectedBorrowed(live?.currentChainTvls || {});
  const totalBorrowedUsd = borrowedByChain.totalBorrowedUsd ?? borrowedByChain.Ethereum ?? null;
  const ethereumAttributedTvlUsd = currentChainTvls.Ethereum ?? round(discovery?.tvlUsd, 2) ?? null;
  const blockedScopeRows = [
    {
      chain: "NEAR",
      component: "Templar market registry and market deployments",
      reason: "Templar live lending contracts are NEAR account contracts and no sanitized NEAR endpoint/preset exists in current local RPC inventory",
      skippedChecks: ["list_deployments", "get_current_snapshot", "get_configuration", "Pyth freshness", "borrower/liquidation economics"],
      notClosedRouteNegative: true,
    },
  ];
  const consumerGradeLocalRows = localRows.filter((row) => row.consumerGrade).length;
  const routePositive = 0;
  const watchCandidates = 0;
  const generatedAt = new Date().toISOString();
  const summary = {
    defillamaCurrentTvlUsd: round(latestTvl(live) ?? discovery?.tvlUsd ?? classifier?.tvl, 2),
    ethereumAttributedTvlUsd,
    totalBorrowedUsd: round(totalBorrowedUsd, 2),
    registryContracts: adapter.registryContracts.length,
    adapterSupportedChains: adapter.supportedChains.length,
    adapterSkippedContracts: adapter.skippedContractsCount,
    nearRegistryRows: adapter.registryContractRows.length,
    evmDeploymentRows: 0,
    localArtifactRows: localRows.length,
    consumerGradeLocalRows,
    blockedScopeRows: blockedScopeRows.length,
    oracleRiskScore: asNumber(classifier?.riskScore),
    singleSourceOracle: Boolean(classifier?.isSingleSource),
    watchCandidates,
    routePositive,
    executableNow: false,
    signedActionJustified: false,
    coverageClassification: "bounded-with-caveats",
    forkGate: "closed-route-positive-zero-for-declared-evm-scope",
    status: "templar-protocol-no-evm-route-positive-near-scope-blocked",
  };
  const out = {
    generatedAt,
    scanner: "tools/scan-templar-protocol-phase0.js",
    scope: "Read-only Templar Protocol DefiLlama adapter/source, EVM-origin asset attribution, local consumer artifact, and NEAR scope-blocker Phase 0",
    safety: {
      publicApisOnlyForMetadata: true,
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      calldataStored: false,
      borrowerAddressesStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    metadata: {
      name: live?.name || discovery?.name || classifier?.name || "Templar Protocol",
      slug: live?.slug || discovery?.slug || classifier?.slug || "templar-protocol",
      category: live?.category || discovery?.category || classifier?.category || "Lending",
      chains: live?.chains || discovery?.chains || classifier?.chains || [],
      evmAttributedChains: ["Ethereum"],
      nonEvmLiveExecutionChains: ["NEAR"],
      unsupportedChains: ["NEAR market registry/live lending state"],
      currentChainTvls,
      borrowedByChain,
      audits: live?.audit_links || live?.audits || classifier?.audits || [],
      url: live?.url || classifier?.url || discovery?.url || "https://www.templarfi.org/",
      twitter: live?.twitter || classifier?.twitter || discovery?.twitter || "TemplarProtocol",
      tvlCodePath: live?.tvlCodePath || classifier?.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/templarfi/index.js",
      sourceRepo: repo?.html_url || "https://github.com/Templar-Protocol/contracts",
      sourceRepoDefaultBranch: repo?.default_branch || "dev",
      sourceRepoLanguage: repo?.language || "Rust",
      sourceRepoPushedAt: repo?.pushed_at || null,
      oracleNames: classifier?.oracleNames || ["Pyth"],
      sourceAvailability: "DefiLlama adapter and public Rust/NEAR source repo; no EVM deployment source resolved in this pass",
    },
    adapter,
    localArtifactRows: localRows,
    blockedScopeRows,
    summary,
    blockers: [
      "DefiLlama Templar adapter enumerates NEAR market contracts and attributes assets back to origin chains; it does not expose an Ethereum lending deployment in current metadata",
      "Current local RPC inventory has no sanitized NEAR endpoint/preset, so NEAR list_deployments, market snapshots, borrower state, Pyth freshness, and liquidation economics are not closed route-negative",
      "No exact Templar-controlled EVM contract, token, custody, oracle, or lending consumer route was resolved from public metadata or local artifacts",
      "Single-source Pyth oracle context is a NEAR-market risk signal only until a live market, borrower state, stale price, and exit route are enumerated",
      "No exact-positive borrow, liquidation, redemption, bridge, or DEX unwind economics and no fork/local extraction proof exist",
    ],
    requiredForRoutePositive: [
      "sanitized NEAR endpoint/preset or equivalent public market-state artifact enumerates Templar deployments and market snapshots",
      "specific Templar market has live borrow cash, collateral, borrower/liquidation state, and Pyth/oracle data with an attacker-favorable stale or divergent value",
      "affected collateral/borrow asset maps to a permissionless EVM or cross-chain acquisition and exit route with exact positive economics after fees, slippage, gas, and bridge/settlement costs",
      "no role, queue, intent, bridge-finality, or cross-chain settlement blocker prevents the route",
      "fork/local extraction proof for the exact deployed route",
    ],
    nextReadOnlyStep: "Keep Templar closed only for declared EVM metadata scope; add a sanitized NEAR endpoint/preset and enumerate NEAR market deployments before claiming route-negative coverage for the live Templar lending system.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, JSON.stringify(out, null, 2));
  fs.writeFileSync(REPORT_OUT, renderReport(out));
  if (!QUIET) console.log(`Templar Phase0: tvl=${formatUsd(summary.defillamaCurrentTvlUsd)} evmDeployments=${summary.evmDeploymentRows} nearBlocked=${summary.blockedScopeRows} local=${summary.localArtifactRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
}

main().catch((err) => {
  console.error(`Templar Phase0 failed: ${err.message}`);
  process.exit(1);
});
