#!/usr/bin/env node
// scan-defillama-oracle-classifier.js — DeFiLlama protocol scraper + oracle classifier
// Discovers NEW lending/CDP targets, classifies oracle types, ranks by exploitability
// Phases 1-5 in one script

const fs = require("fs"); const path = require("path");
const WORKSPACE = path.resolve(__dirname, "..");
const OUT_DIR = path.join(WORKSPACE, "reports", "raw", "fast");

const CATEGORIES = ["Lending", "CDP", "Leveraged Farming", "Yield Aggregator"];
const MIN_TVL = 10_000_000;
const NOW = new Date().toISOString();

// Chains we have RPC for (from rpc_endpoints.txt coverage)
const RPC_CHAINS = new Set([
  "Ethereum", "Arbitrum", "Optimism", "Base", "Polygon", "BSC", "Avalanche",
  "Gnosis", "Linea", "Scroll", "Mantle", "Celo", "zkSync", "Blast", "Fantom",
  "Moonbeam", "Moonriver", "Unichain", "Mode", "Ink", "Soneium", "Lisk",
  "Sonic", "WorldChain", "Hyperliquid", "Berachain",
]);

// Known oracle providers and their risk scores
const ORACLE_RISK = {
  "Chainlink": 3,                  // Most trusted, multi-decade history
  "RedStone": 7,                   // Pull oracle, newer, less battle-tested
  "Pyth": 6,                       // Pull oracle, used by major protocols
  "Chronicle": 4,                  // Formerly Maker, well-audited
  "API3": 6,                       // Push oracle, smaller market share
  "eOracle": 6,                    // Eigenlayer-based, new
  "Binance Oracle": 5,             // Centralized, BSC-specific
  "WINkLink": 8,                   // Tron/Justin Sun ecosystem, centralization risk
  "TWAP / DEX": 8,                 // On-chain TWAP, manipulable with capital
  "Internal / Custom": 9,          // Custom oracle, least audited
  "Tellor": 7,                     // Pull oracle, long-standing but smaller share
  "Band Protocol": 6,              // Push oracle
  "Supra": 7,                      // Newer oracle, pull model
  "Stork": 7,                      // Pull oracle, mostly newer protocols
  "Switchboard": 7,                // Solana-native, newer
  "Scope": 7,                      // Solana-native
  "Unknown": 10,                   // No oracle data available = highest risk
};

// Single-source risk boost (no fallback)
const SINGLE_SOURCE_BOOST = 3;
// No-audit boost
const NO_AUDIT_BOOST = 2;

// ─── Phase 1: Fetch + Filter ───

async function fetchProtocols() {
  console.log("Fetching DeFiLlama protocols...");
  const resp = await fetch("https://api.llama.fi/protocols", { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

function hasRpcChain(chains) {
  return chains.some(c => RPC_CHAINS.has(c));
}

function filterProtocols(all) {
  const filtered = [];
  for (const p of all) {
    if (!CATEGORIES.includes(p.category)) continue;
    if ((p.tvl || 0) < MIN_TVL) continue;
    if (!p.chains || !hasRpcChain(p.chains)) continue;
    filtered.push(p);
  }
  return filtered;
}

// ─── Phase 2: Oracle Classifier ───

function classifyOracle(protocol) {
  const breakdown = protocol.oraclesBreakdown || [];
  const oracles = [];
  
  for (const o of breakdown) {
    oracles.push({
      name: o.name || "Unknown",
      type: o.type || "Primary",
    });
  }
  
  // Determine risk
  let maxRisk = 0;
  let isSingleSource = true;
  let hasFallback = false;
  const oracleNames = new Set();
  
  for (const o of oracles) {
    const risk = ORACLE_RISK[o.name] || ORACLE_RISK["Unknown"];
    if (risk > maxRisk) maxRisk = risk;
    oracleNames.add(o.name);
    if (o.type === "Fallback" || o.type === "Secondary") hasFallback = true;
  }
  
  if (oracles.length > 1) isSingleSource = false;
  
  // Single-source without fallback = higher risk
  if (isSingleSource && !hasFallback) maxRisk += SINGLE_SOURCE_BOOST;
  // No oracle data at all = highest risk
  if (oracles.length === 0) maxRisk = ORACLE_RISK["Unknown"];
  
  // Audit gap
  const auditCount = (protocol.audit_links || []).length;
  if (auditCount === 0) maxRisk += NO_AUDIT_BOOST;
  
  const risk = Math.min(maxRisk, 10);
  
  return {
    oracles,
    oracleNames: [...oracleNames],
    isSingleSource,
    hasFallback,
    auditCount,
    riskScore: risk,
    riskLabel: risk >= 9 ? "CRITICAL" : risk >= 7 ? "HIGH" : risk >= 5 ? "MEDIUM" : "LOW",
  };
}

// ─── Phase 3: Exploitability Ranking ───

function rankProtocols(protocols, coverage) {
  const ranked = [];
  
  for (const p of protocols) {
    const oracleInfo = classifyOracle(p);
    const tvlScore = Math.min(10, Math.log10(p.tvl) / 1); // log10 scale: $10M=7, $100M=8, $1B=9, $10B=10
    const chainCount = (p.chains || []).filter(c => RPC_CHAINS.has(c)).length;
    const chainScore = Math.min(5, chainCount);
    const isNew = !coverage.has(p.slug);
    
    // Composite score: oracle risk dominates (weight 4), TVL (3), chain count (2), new bonus (1)
    const composite = oracleInfo.riskScore * 4 + tvlScore * 3 + chainScore * 2 + (isNew ? 3 : 0);
    
    ranked.push({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl: p.tvl,
      chains: (p.chains || []).filter(c => RPC_CHAINS.has(c)),
      chainCount,
      tvlScore: tvlScore.toFixed(1),
      ...oracleInfo,
      composite: composite.toFixed(1),
      isNew,
      audits: p.audit_links || [],
      url: p.url,
      twitter: p.twitter,
      tvlCodePath: p.tvlCodePath,
    });
  }
  
  ranked.sort((a, b) => parseFloat(b.composite) - parseFloat(a.composite));
  return ranked;
}

// ─── Coverage cross-reference ───

function buildCoverageMap() {
  const coverage = new Set();
  const targetsDir = path.join(WORKSPACE, "targets");
  if (!fs.existsSync(targetsDir)) return coverage;
  
  // Map target directory names to known DeFiLlama slugs
  const slugMap = {
    "aave-v3-origin": "aave-v3",
    "aave-governance-v3": "aave-v3",
    "morpho-blue": "morpho-blue",
    "morpho-blue-oracles": "morpho-blue",
    "morpho-vault-v2": "morpho-blue",
    "compound-comet": "compound-v3",
    "sparklend": "spark",
    "spark-ssr": "spark",
    "fluid-contracts-public": "fluid",
    "venus-protocol": "venus",
    "venus-isolated-pools": "venus",
    "euler-v2": "euler-v2",
    "euler-evc": "euler",
    "euler-evk": "euler",
    "benqi": "benqi-lending",
    "liquity-bold": "liquity",
    "curve-stablecoin": "curve-stablecoin",
    "gearbox-core-v3": "gearbox",
    "gearbox-oracles-v3": "gearbox",
    "fraxlend": "fraxlend",
    "silo-contracts-v2": "silo-v2",
    "across-contracts": "across",
    "dolomite-margin": "dolomite",
    "kamino-klend": "kamino-lend",
    "marginfi-v2": "marginfi",
    "hyperlend": "hyperlend",
    "gravita": "gravita",
    "prisma": "prisma-finance",
    "alchemix": "alchemix",
    "angle": "angle",
    "inverse": "inverse-finance",
    "raft": "raft",
    "etherfi-contracts": "etherfi-staked-eth-borrowing",
    "maple-core-v2": "maple",
    "tydro": "tydro",
    "loopscale": "loopscale",
    "termmax": "termmax",
    "moonwell-contracts": "moonwell",
    "yearn-vaults-v3": "yearn-finance",
    "cap-contracts": "cap",
    "tectonic": "tectonic",
    "convex-platform": "convex-finance",
    "ajna-core": "ajna",
    "derivative-v2-core": "derive",
    "fixed-term-loan": "fixed-term-loan",
    "folks-xchain-contracts": "folks-finance",
    "exponent-core": "exponent",
    "blend": "blend",
  };
  
  for (const [dir, slug] of Object.entries(slugMap)) {
    coverage.add(slug);
  }
  
  // Also add protocols we've manually audited (from existing scanner coverage)
  const extraSlugs = [
    "aave-v2", "compound", "maker", "sky-ecosystem", "resolv", "resupply",
    "ethena", "ether-fi", "kelp-dao", "renzo", "eigenlayer",
    "velodrome", "aerodrome", "camelot", "uniswap", "pancakeswap",
    "balancer", "bunni", "jupiter-aggregator", "orca", "raydium",
    "axelar", "debridge", "layerzero", "wormhole", "stargate",
    "dydx", "gmx", "synthetix", "perennial", "hyperliquid",
    "1inch", "odos", "paraswap", "lifi", "openocean",
    "drift", "meteora", "save", "solend", "jupiter-lend",
    "pendle", "cowswap", "cow-protocol",
  ];
  for (const s of extraSlugs) coverage.add(s);
  
  return coverage;
}

// ─── Main ───

async function main() {
  console.log("=== DeFiLlama Oracle Classifier ===\n");
  
  const start = Date.now();
  
  // Phase 1: Fetch + Filter
  const all = await fetchProtocols();
  console.log(`Fetched ${all.length} protocols from DeFiLlama`);
  
  const filtered = filterProtocols(all);
  console.log(`Filtered to ${filtered.length} lending/CDP/yield >$10M on RPC chains`);
  
  // Coverage
  const coverage = buildCoverageMap();
  const newProtocols = filtered.filter(p => !coverage.has(p.slug));
  const covered = filtered.filter(p => coverage.has(p.slug));
  console.log(`Covered: ${covered.length} | NEW: ${newProtocols.length}\n`);
  
  // Phase 2-3: Classify + Rank
  const ranked = rankProtocols(filtered, coverage);
  
  // Display
  console.log("=== Top 15 by Exploitability ===\n");
  console.log("Rank  Protocol".padEnd(28) + "TVL".padEnd(10) + "Oracle".padEnd(22) + "Risk".padEnd(10) + "New");
  console.log("─".repeat(80));
  
  for (let i = 0; i < Math.min(15, ranked.length); i++) {
    const r = ranked[i];
    const tvlStr = "$" + (r.tvl / 1e6).toFixed(0) + "M";
    const oracleStr = r.oracleNames.slice(0, 3).join(", ").padEnd(20).slice(0, 20);
    const risk = r.riskLabel;
    const isNew = r.isNew ? "NEW" : "";
    console.log(
      (i+1).toString().padStart(3) + " " +
      r.name.slice(0, 25).padEnd(26) +
      tvlStr.padEnd(10) +
      oracleStr.padEnd(22) +
      risk.padEnd(10) +
      isNew
    );
  }
  
  // Phase 4: Top new targets
  const topNew = ranked.filter(r => r.isNew).slice(0, 20);
  console.log(`\n=== Top ${topNew.length} NEW Targets ===\n`);
  for (const r of topNew.slice(0, 10)) {
    console.log(`${r.name.padEnd(25)} TVL=$${(r.tvl/1e6).toFixed(0)}M  Oracle: ${r.oracleNames.join(", ") || "UNKNOWN"}`);
    console.log(`  Category: ${r.category} | Chains: ${r.chains.slice(0,5).join(", ")} | Audits: ${r.auditCount}`);
    console.log(`  Risk: ${r.riskLabel} (score=${r.riskScore}/10) | Single-source: ${r.isSingleSource} | Fallback: ${r.hasFallback}`);
    if (r.tvlCodePath) console.log(`  GitHub: ${r.tvlCodePath}`);
    console.log("");
  }
  
  // Save
  const outFile = path.join(OUT_DIR, "defillama-oracle-classifier.json");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({
    scannedAt: NOW,
    total: all.length,
    filtered: filtered.length,
    covered: covered.length,
    new: newProtocols.length,
    ranked,
    topNew: topNew,
  }, null, 2));
  
  console.log(`\nDone in ${((Date.now()-start)/1000).toFixed(1)}s. Artifact: ${outFile}`);
  console.log(`Covered: ${covered.length} | NEW: ${newProtocols.length} | Total ranked: ${ranked.length}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
