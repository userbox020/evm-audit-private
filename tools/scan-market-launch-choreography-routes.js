#!/usr/bin/env node
// Read-only market-launch/config-choreography route scanner.
// Looks for Sonne-style unsafe intermediate/current states: high LTV, borrow cash,
// tiny or newly listed collateral state, and split launch/config signals.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "market-launch-choreography-routes.json");
const OUT_MD = path.join(WORKSPACE, "reports", "market-launch-choreography-routes-triage.md");
const QUIET = process.argv.includes("--quiet");

const FILES = {
  consumerFirstHighLtv: path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json"),
  newVaultDonationAttack: path.join(WORKSPACE, "reports", "raw", "fast", "new-vault-donation-attack.json"),
  focusedEulerReview: path.join(WORKSPACE, "reports", "raw", "fast", "focused-euler-evk-review-producers.json"),
  smallCapOracleManipulation: path.join(WORKSPACE, "reports", "raw", "fast", "small-cap-oracle-manipulation-routes.json"),
  pendlePtConsumerGraph: path.join(WORKSPACE, "reports", "raw", "fast", "pendle-pt-consumer-graph.json"),
  siloPtOracleRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "silo-pt-oracle-routes.json"),
  morphoPublicAllocatorForceFeed: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-public-allocator-force-feed.json"),
};

const TIMEOUT_MS = 15_000;
const MIN_LTV = Number(process.env.MARKET_LAUNCH_MIN_LTV || "0.85");
const MIN_BORROW_LIQUIDITY_USD = Number(process.env.MARKET_LAUNCH_MIN_BORROW_LIQUIDITY_USD || "10000");
const LOW_MARKET_SUPPLY_USD = Number(process.env.MARKET_LAUNCH_LOW_MARKET_SUPPLY_USD || "10000");
const LOW_PRODUCER_TVL_USD = Number(process.env.MARKET_LAUNCH_LOW_PRODUCER_TVL_USD || "50000");
const RECENT_DEPLOY_BLOCKS = Number(process.env.MARKET_LAUNCH_RECENT_DEPLOY_BLOCKS || "100000");
const LOG_LOOKBACK_BLOCKS = Number(process.env.MARKET_LAUNCH_LOG_LOOKBACK_BLOCKS || "50000");
const MAX_ROWS = Number(process.env.MARKET_LAUNCH_MAX_ROWS || "160");
const SCAN_LOGS = process.env.MARKET_LAUNCH_SCAN_LOGS !== "0";

const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const MORPHO_CREATE_MARKET_TOPIC = "0x8a41cabf57f8c9e58b85a041c8b6e82af3eb44c2a21833c0f03a639b5bcb1c49";

const CHAIN_NAMES = {
  1: "Ethereum",
  10: "Optimism",
  56: "BNB Chain",
  137: "Polygon",
  146: "Sonic",
  480: "World Chain",
  8453: "Base",
  42161: "Arbitrum",
  57073: "Ink",
  130: "Unichain",
  80094: "Berachain",
};

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,_]/g, "").replace(/e18$/i, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 6) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function lowerAddress(value) {
  const text = String(value || "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text.toLowerCase() : null;
}

function canonicalAddress(value) {
  const lower = lowerAddress(value);
  if (!lower) return null;
  return `0x${lower.slice(2)}`;
}

function bool(value) {
  return Boolean(value === true || value === "true" || value === 1 || value === "1");
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcPool(chainIds) {
  const wanted = new Set(chainIds.map(Number));
  const pool = {};
  for (const url of loadRpcUrls()) {
    try {
      const chainId = Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000)));
      if (wanted.has(chainId) && !pool[chainId]) pool[chainId] = url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return pool;
}

async function latestBlock(rpc) {
  const block = await rpcCall(rpc, "eth_getBlockByNumber", ["latest", false], 8000).catch(() => null);
  if (!block) return null;
  return { number: Number(BigInt(block.number)), timestamp: Number(BigInt(block.timestamp)), iso: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() };
}

function toBlockHex(n) {
  return `0x${Math.max(0, Math.floor(Number(n) || 0)).toString(16)}`;
}

async function scanRecentMorphoMarketLogs(rpcPool, blocks) {
  if (!SCAN_LOGS) return {};
  const out = {};
  for (const [chainIdText, rpc] of Object.entries(rpcPool)) {
    const chainId = Number(chainIdText);
    const block = blocks[chainId];
    if (!block?.number) continue;
    const fromBlock = Math.max(0, block.number - LOG_LOOKBACK_BLOCKS);
    try {
      const logs = await rpcCall(rpc, "eth_getLogs", [{
        address: MORPHO_BLUE,
        fromBlock: toBlockHex(fromBlock),
        toBlock: "latest",
        topics: [MORPHO_CREATE_MARKET_TOPIC],
      }], 20_000) || [];
      out[chainId] = {
        chainId,
        chain: CHAIN_NAMES[chainId] || String(chainId),
        lookbackBlocks: LOG_LOOKBACK_BLOCKS,
        fromBlock,
        toBlock: block.number,
        recentCreateMarketLogs: logs.length,
        sampleMarketIds: logs.slice(0, 12).map((log) => log.topics?.[1] || null).filter(Boolean),
      };
    } catch (_) {
      out[chainId] = { chainId, chain: CHAIN_NAMES[chainId] || String(chainId), lookbackBlocks: LOG_LOOKBACK_BLOCKS, recentCreateMarketLogs: null, error: "query-failed" };
    }
  }
  return out;
}

function countBy(rows, fn) {
  const out = {};
  for (const row of rows || []) {
    const key = fn(row) || "unknown";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function maxNumber(rows, fn) {
  const values = (rows || []).map(fn).filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

function minNumber(rows, fn) {
  const values = (rows || []).map(fn).filter((value) => Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

function rowKey(row) {
  const chainId = Number(row?.chainId);
  const protocol = String(row?.protocol || "").toLowerCase();
  const consumer = lowerAddress(row?.consumer?.marketId) || lowerAddress(row?.consumer?.evault) || lowerAddress(row?.consumer?.comet) || lowerAddress(row?.consumer?.silo) || lowerAddress(row?.consumer?.config) || String(row?.consumer?.id || row?.consumer?.marketName || "unknown").toLowerCase();
  const collateral = lowerAddress(row?.collateral?.address || row?.consumer?.collateralAsset?.address);
  const borrow = lowerAddress(row?.borrowAsset?.address || row?.consumer?.loanAsset?.address || row?.consumer?.asset || row?.consumer?.baseToken);
  if (!chainId || !collateral || !borrow) return null;
  return `${chainId}:${protocol}:${consumer}:${collateral}:${borrow}`;
}

function collectHighLtvRows(consumerFirst) {
  const rows = [];
  for (const result of consumerFirst?.results || []) {
    for (const row of result?.highLtvRowsDetail || []) {
      rows.push({ ...row, chainId: Number(row.chainId || result.chainId), chain: row.chain || result.chain });
    }
  }
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = rowKey(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function mapNewVaultRows(artifact) {
  const map = new Map();
  for (const row of artifact?.rows || artifact?.topRows || []) {
    const vault = row?.vault || row;
    const address = lowerAddress(vault?.address);
    if (!address) continue;
    map.set(`${Number(row.chainId || vault.chainId)}:${address}`, row);
  }
  return map;
}

function mapFocusedEulerRows(artifact) {
  const map = new Map();
  for (const row of artifact?.rows || []) {
    const key = rowKey(row);
    if (key) map.set(key, row);
    const chainCollateral = `${Number(row.chainId)}:${lowerAddress(row?.collateral?.address)}`;
    if (lowerAddress(row?.collateral?.address)) map.set(chainCollateral, row);
  }
  return map;
}

function mapSmallCapRows(artifact) {
  const map = new Map();
  for (const row of artifact?.rows || []) {
    const key = rowKey(row);
    if (key) map.set(key, row);
  }
  return map;
}

function producerTvlFromFocusedEuler(row) {
  const totalSupplyRaw = row?.nav?.totalSupplyRaw;
  const decimals = Number(row?.collateral?.decimals ?? 18);
  const price = asNumber(row?.nav?.referenceUsdPerCollateral ?? row?.euler?.acceptedUsdPerCollateral);
  if (totalSupplyRaw === null || totalSupplyRaw === undefined || price === null) return null;
  try {
    const whole = Number(BigInt(totalSupplyRaw)) / (10 ** Math.min(decimals, 30));
    if (!Number.isFinite(whole)) return null;
    return whole * price;
  } catch (_) {
    return null;
  }
}

function collateralState(row, matches, blocks) {
  const chainId = Number(row.chainId);
  const collateral = lowerAddress(row?.collateral?.address);
  const newVault = matches.newVaultByCollateral.get(`${chainId}:${collateral}`) || null;
  const focusedEuler = matches.focusedEulerByKey.get(rowKey(row)) || matches.focusedEulerByKey.get(`${chainId}:${collateral}`) || null;
  const smallCap = matches.smallCapByKey.get(rowKey(row)) || null;
  const deployBlock = asNumber(newVault?.vault?.deployBlock ?? newVault?.deployBlock);
  const latest = asNumber(blocks?.[chainId]?.number);
  const deployAgeBlocks = deployBlock !== null && latest !== null ? Math.max(0, latest - deployBlock) : null;
  const producerTvlUsd = asNumber(newVault?.vault?.totalAssetsUsd) ?? producerTvlFromFocusedEuler(focusedEuler);
  const marketSupplyUsd = asNumber(row?.supplyAssetsUsd);
  const collateralAssetsRaw = row?.collateralAssetsRaw;
  const zeroCollateralAssets = collateralAssetsRaw !== undefined && collateralAssetsRaw !== null && /^0+$/.test(String(collateralAssetsRaw));
  const zeroOrLowMarketSupply = zeroCollateralAssets || (marketSupplyUsd !== null && marketSupplyUsd <= LOW_MARKET_SUPPLY_USD);
  const lowProducerTvl = producerTvlUsd !== null && producerTvlUsd <= LOW_PRODUCER_TVL_USD;
  const recentProducerDeploy = deployAgeBlocks !== null && deployAgeBlocks <= RECENT_DEPLOY_BLOCKS;
  const publicAcquisitionOpen = newVault?.depositOpen === true || focusedEuler?.nav?.publicMintOpen === true ? true : newVault?.depositOpen === false || focusedEuler?.nav?.publicMintOpen === false ? false : null;
  return {
    newVault,
    focusedEuler,
    smallCap,
    deployBlock,
    deployAgeBlocks,
    producerTvlUsd,
    marketSupplyUsd,
    zeroCollateralAssets,
    zeroOrLowMarketSupply,
    lowProducerTvl,
    recentProducerDeploy,
    publicAcquisitionOpen,
  };
}

function capFlags(row) {
  const protocol = row?.protocol;
  const flags = [];
  const supplyCap = row?.consumer?.supplyCap ?? row?.consumer?.supplyCapWholeTokens;
  const borrowCap = row?.consumer?.borrowCapWholeTokens;
  if (protocol === "Compound Comet" && !supplyCap) flags.push("compound-supply-cap-unresolved");
  if (protocol === "Aave V3") {
    if (borrowCap === "0") flags.push("aave-borrow-disabled-or-cap-zero");
    if (!borrowCap || borrowCap === "68719476735") flags.push("aave-borrow-cap-unbounded-or-unresolved");
    if (!supplyCap || supplyCap === "68719476735") flags.push("aave-supply-cap-unbounded-or-unresolved");
  }
  if (["Euler EVK", "Silo V3", "Morpho Blue"].includes(protocol)) flags.push("cap-or-flow-control-needs-protocol-specific-check");
  return flags;
}

function exactEconomicsClosure(row, state) {
  if (row?.protocol !== "Euler EVK") return null;
  const focused = state.focusedEuler;
  const netEdgeUsd = asNumber(focused?.economics?.netEdgeUsd);
  const premiumGapBps = asNumber(focused?.economics?.premiumGapBps);
  const acceptedVsReferenceBps = asNumber(focused?.economics?.acceptedVsReferenceBps);
  const requiredPremiumBps = asNumber(focused?.economics?.requiredPremiumBps);
  if (netEdgeUsd !== null && netEdgeUsd < 0 && premiumGapBps !== null && premiumGapBps > 0) {
    return {
      status: "closed-focused-euler-exact-economics-negative",
      sourceArtifact: "reports/raw/fast/focused-euler-evk-review-producers.json",
      acceptedVsReferenceBps: round(acceptedVsReferenceBps, 6),
      requiredPremiumBps: round(requiredPremiumBps, 6),
      premiumGapBps: round(premiumGapBps, 6),
      netEdgeUsd: round(netEdgeUsd, 6),
      reason: "Focused Euler exact accepted-vs-reference economics are below LTV break-even after slippage/gas/min-profit gates.",
    };
  }
  return null;
}

function riskScore(row, state, capFlagList) {
  const ltv = asNumber(row.ltv) || 0;
  const liquidity = asNumber(row.routeLiquidityUsd) || 0;
  const tags = new Set(row.riskTags || []);
  let score = 0;
  score += Math.min(20, Math.max(0, (ltv - MIN_LTV) * 200));
  score += Math.min(20, Math.log10(Math.max(1, liquidity / MIN_BORROW_LIQUIDITY_USD)) * 10);
  if (state.zeroCollateralAssets) score += 22;
  else if (state.zeroOrLowMarketSupply) score += 16;
  if (state.lowProducerTvl) score += 16;
  if (state.recentProducerDeploy) score += 10;
  if (tags.has("principal-token")) score += 12;
  if (tags.has("receipt-or-yield-bearing")) score += 9;
  if (tags.has("rwa-or-credit")) score += 8;
  if (tags.has("bridge-wrapper")) score += 6;
  if (tags.has("noncanonical-or-unknown")) score += 5;
  if (state.publicAcquisitionOpen === true) score += 7;
  if (state.publicAcquisitionOpen === false) score -= 12;
  if (capFlagList.length) score += 4;
  return Math.max(0, Math.round(score));
}

function classifyLaunchRow(row, matches, blocks) {
  const chainId = Number(row.chainId);
  const ltv = asNumber(row.ltv) || 0;
  const routeLiquidityUsd = asNumber(row.routeLiquidityUsd) || 0;
  const collateral = row.collateral || null;
  const borrowAsset = row.borrowAsset || row.consumer?.loanAsset || null;
  const state = collateralState(row, matches, blocks);
  const capFlagList = capFlags(row);
  const economicsClosure = exactEconomicsClosure(row, state);
  const tags = new Set(row.riskTags || []);
  const noncanonical = tags.has("noncanonical-or-unknown") || tags.has("principal-token") || tags.has("receipt-or-yield-bearing") || tags.has("rwa-or-credit") || tags.has("bridge-wrapper");
  const highLtv = ltv >= MIN_LTV;
  const materialBorrowLiquidity = routeLiquidityUsd >= MIN_BORROW_LIQUIDITY_USD;
  const launchOrderingShape = Boolean(state.zeroOrLowMarketSupply || state.lowProducerTvl || state.recentProducerDeploy);
  const preforkLaunchRisk = Boolean(highLtv && materialBorrowLiquidity && noncanonical && launchOrderingShape && state.publicAcquisitionOpen !== false && !economicsClosure);
  const watchCandidate = preforkLaunchRisk;
  const score = riskScore(row, state, capFlagList);
  const blockers = [];
  if (!highLtv) blockers.push(`LTV below threshold ${MIN_LTV}`);
  if (!materialBorrowLiquidity) blockers.push(`Borrow-side liquidity below $${MIN_BORROW_LIQUIDITY_USD}`);
  if (!noncanonical) blockers.push("Collateral is canonical/blue-chip, not a market-launch anomaly shape");
  if (!launchOrderingShape) blockers.push("No current low-supply, low-TVL, or recent-deploy market-launch ordering signal");
  if (state.publicAcquisitionOpen === false) blockers.push("Public mint/deposit/acquisition appears closed");
  if (economicsClosure) blockers.push(`Exact focused-Euler economics are negative: premium gap ${economicsClosure.premiumGapBps}bps, net ${economicsClosure.netEdgeUsd} USD`);
  blockers.push("No exact acquisition/borrow/exit economics for launch-order exploitation");
  blockers.push("No fork proof or manipulated launch-order simulation");

  return {
    protocol: row.protocol,
    chainId,
    chain: row.chain || CHAIN_NAMES[chainId] || String(chainId),
    consumer: row.consumer || null,
    collateral,
    borrowAsset,
    ltv: round(ltv, 6),
    liquidationThreshold: round(row.liquidationThreshold, 6),
    routeLiquidityUsd: round(routeLiquidityUsd, 6),
    riskTags: row.riskTags || [],
    launchSignals: {
      highLtv,
      materialBorrowLiquidity,
      noncanonical,
      zeroCollateralAssets: state.zeroCollateralAssets,
      zeroOrLowMarketSupply: state.zeroOrLowMarketSupply,
      lowProducerTvl: state.lowProducerTvl,
      recentProducerDeploy: state.recentProducerDeploy,
      publicAcquisitionOpen: state.publicAcquisitionOpen,
      exactEconomicsNegative: Boolean(economicsClosure),
      capFlags: capFlagList,
    },
    linkedState: {
      deployBlock: state.deployBlock,
      deployAgeBlocks: state.deployAgeBlocks,
      producerTvlUsd: round(state.producerTvlUsd, 6),
      marketSupplyUsd: round(state.marketSupplyUsd, 6),
      newVaultLinked: Boolean(state.newVault),
      focusedEulerLinked: Boolean(state.focusedEuler),
      smallCapOracleLinked: Boolean(state.smallCap),
      smallCapBestNetUsd: round(state.smallCap?.bestModeledPool?.economics?.modeledNetUsd),
      focusedEulerPremiumGapBps: round(state.focusedEuler?.economics?.premiumGapBps, 6),
      focusedEulerNetEdgeUsd: round(state.focusedEuler?.economics?.netEdgeUsd, 6),
      focusedEulerAcceptedVsReferenceBps: round(state.focusedEuler?.economics?.acceptedVsReferenceBps, 6),
      focusedEulerRequiredPremiumBps: round(state.focusedEuler?.economics?.requiredPremiumBps, 6),
    },
    economicsClosure,
    launchRiskScore: score,
    preforkLaunchRisk,
    watchCandidate,
    routePositive: false,
    routeGate: {
      status: economicsClosure?.status || (watchCandidate ? "launch-order-watch-needs-exact-economics-and-fork" : "launch-order-blocked"),
      exactLaunchOrderingExploit: false,
      exactAcquisitionRoute: false,
      exactBorrowExitRoute: false,
      exactEconomicsNegative: Boolean(economicsClosure),
      exactEconomicsPositive: false,
      forkProof: false,
    },
    blockers,
  };
}

function table(rows, headers) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${headers.map((h) => String(row[h] ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "/")).join(" | ")} |`),
  ].join("\n");
}

function renderReport(artifact) {
  const topWatch = artifact.topRows.filter((row) => row.watchCandidate).slice(0, 8).map((row) => ({
    Protocol: row.protocol,
    Chain: row.chain,
    Collateral: row.collateral?.symbol || row.collateral?.address || "",
    Borrow: row.borrowAsset?.symbol || row.borrowAsset?.address || "",
    LTV: row.ltv,
    LiquidityUSD: row.routeLiquidityUsd,
    Blocker: row.blockers?.[0] || "",
  }));
  const closed = artifact.rows.filter((row) => row.economicsClosure).slice(0, 8).map((row) => ({
    Protocol: row.protocol,
    Chain: row.chain,
    Collateral: row.collateral?.symbol || row.collateral?.address || "",
    Borrow: row.borrowAsset?.symbol || row.borrowAsset?.address || "",
    PremiumGapBps: row.economicsClosure?.premiumGapBps,
    NetEdgeUSD: row.economicsClosure?.netEdgeUsd,
    Status: row.economicsClosure?.status,
  }));
  return [
    "# 🟢 DORMANT — Market-Launch Choreography Route Scan",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "Artifact: `reports/raw/fast/market-launch-choreography-routes.json`",
    "",
    "## Result",
    "",
    `No current permissionless value-extracting market-launch route was found. The scanner scored \`${artifact.summary.rowsScored}\` joined high-LTV/config-risk rows across \`${artifact.summary.chainsInput}\` chains, closed \`${artifact.summary.exactEconomicsNegativeRows}\` Euler rows with exact negative economics, and left \`${artifact.summary.watchCandidates}\` watch-only launch-order research leads. Route-relevant gates remain closed: \`exactLaunchOrderingRows=${artifact.summary.exactLaunchOrderingRows}\`, \`exactAcquisitionRouteRows=${artifact.summary.exactAcquisitionRouteRows}\`, \`exactBorrowExitRouteRows=${artifact.summary.exactBorrowExitRouteRows}\`, \`exactEconomicsRows=${artifact.summary.exactEconomicsRows}\`, \`forkProofRows=${artifact.summary.forkProofRows}\`, \`routePositive=0\`, \`signedActionJustified=false\`.`,
    "",
    "The scan made read-only RPC/API calls only. RPC endpoints were resolved in memory and no endpoint URLs, private keys, env files, signed actions, fork transactions, or exploit calls were used.",
    "",
    "## Coverage",
    "",
    table([
      { Metric: "Rows scored", Value: artifact.summary.rowsScored },
      { Metric: "Chains with RPC", Value: artifact.summary.chainsWithRpc },
      { Metric: "Low-producer-TVL rows", Value: artifact.summary.lowProducerTvlRows },
      { Metric: "Exact-economics-negative rows", Value: artifact.summary.exactEconomicsNegativeRows },
      { Metric: "Prefork launch-risk rows", Value: artifact.summary.preforkLaunchRisk },
      { Metric: "Watch candidates", Value: artifact.summary.watchCandidates },
      { Metric: "Exact launch-ordering rows", Value: artifact.summary.exactLaunchOrderingRows },
      { Metric: "Exact acquisition-route rows", Value: artifact.summary.exactAcquisitionRouteRows },
      { Metric: "Exact borrow/exit-route rows", Value: artifact.summary.exactBorrowExitRouteRows },
      { Metric: "Exact positive economics rows", Value: artifact.summary.exactEconomicsRows },
      { Metric: "Fork-proof rows", Value: artifact.summary.forkProofRows },
      { Metric: "Route-positive rows", Value: artifact.summary.routePositive },
      { Metric: "Best route liquidity", Value: `$${artifact.summary.bestRouteLiquidityUsd}` },
    ], ["Metric", "Value"]),
    "",
    "## Remaining Watch Rows",
    "",
    topWatch.length ? table(topWatch, ["Protocol", "Chain", "Collateral", "Borrow", "LTV", "LiquidityUSD", "Blocker"]) : "No watch rows remain after exact-economics gating.",
    "",
    "## Exact-Economics Closures",
    "",
    closed.length ? table(closed, ["Protocol", "Chain", "Collateral", "Borrow", "PremiumGapBps", "NetEdgeUSD", "Status"]) : "No rows were closed by exact focused-Euler economics in this pass.",
    "",
    "## Current Blockers",
    "",
    "| Blocker | Evidence |",
    "|---|---|",
    "| No exact unsafe ordering sequence | Remaining watch rows still do not prove a public market-launch window before safe caps/oracles/pause states |",
    "| Exact-negative Euler rows closed | Focused Euler linked rows with negative net edge no longer count as watch candidates |",
    "| No exact economics for remaining rows | Remaining rows still lack exact collateral acquisition, borrow, and exit route economics; watch rows are research-only until exact route gates pass |",
    "| No fork proof | Fork extraction is not justified without a concrete route-positive row |",
    "",
    "## Reopen Criteria",
    "",
    "Reopen fork work only if all are true:",
    "",
    "- A governance or launch transaction sequence creates a public deposit/borrow window before caps, oracle guards, or pause states are safe.",
    "- Collateral acquisition is permissionless and exact-quoted for the target size.",
    "- Borrow-side liquidity and the borrowed-asset exit route are material and unpaused.",
    "- Gas/slippage-adjusted economics are positive.",
    "- Fork extraction proof demonstrates positive net value.",
    "",
  ].join("\n");
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const consumerFirst = readJson(FILES.consumerFirstHighLtv, {});
  const newVault = readJson(FILES.newVaultDonationAttack, {});
  const focusedEuler = readJson(FILES.focusedEulerReview, {});
  const smallCap = readJson(FILES.smallCapOracleManipulation, {});
  const highLtvRows = collectHighLtvRows(consumerFirst).slice(0, MAX_ROWS);
  const chainIds = [...new Set(highLtvRows.map((row) => Number(row.chainId)).filter(Boolean))].sort((a, b) => a - b);
  const rpcPool = await resolveRpcPool(chainIds);
  const blocks = {};
  for (const [chainIdText, rpc] of Object.entries(rpcPool)) {
    const block = await latestBlock(rpc).catch(() => null);
    if (block) blocks[Number(chainIdText)] = { chain: CHAIN_NAMES[Number(chainIdText)] || chainIdText, ...block };
  }
  const recentMorphoLogs = await scanRecentMorphoMarketLogs(rpcPool, blocks);
  const matches = {
    newVaultByCollateral: mapNewVaultRows(newVault),
    focusedEulerByKey: mapFocusedEulerRows(focusedEuler),
    smallCapByKey: mapSmallCapRows(smallCap),
  };
  const rows = highLtvRows.map((row) => classifyLaunchRow(row, matches, blocks));
  rows.sort((a, b) => Number(b.watchCandidate) - Number(a.watchCandidate)
    || Number(b.preforkLaunchRisk) - Number(a.preforkLaunchRisk)
    || Number(b.launchRiskScore || 0) - Number(a.launchRiskScore || 0)
    || Number(b.routeLiquidityUsd || 0) - Number(a.routeLiquidityUsd || 0));

  const watchCandidates = rows.filter((row) => row.watchCandidate).length;
  const preforkLaunchRisk = rows.filter((row) => row.preforkLaunchRisk).length;
  const zeroCollateralRows = rows.filter((row) => row.launchSignals.zeroCollateralAssets).length;
  const lowMarketSupplyRows = rows.filter((row) => row.launchSignals.zeroOrLowMarketSupply).length;
  const lowProducerTvlRows = rows.filter((row) => row.launchSignals.lowProducerTvl).length;
  const recentProducerRows = rows.filter((row) => row.launchSignals.recentProducerDeploy).length;
  const exactEconomicsNegativeRows = rows.filter((row) => row.launchSignals.exactEconomicsNegative).length;
  const exactLaunchOrderingRows = rows.filter((row) => row.routeGate.exactLaunchOrderingExploit).length;
  const exactAcquisitionRouteRows = rows.filter((row) => row.routeGate.exactAcquisitionRoute).length;
  const exactBorrowExitRouteRows = rows.filter((row) => row.routeGate.exactBorrowExitRoute).length;
  const exactEconomicsRows = rows.filter((row) => row.routeGate.exactEconomicsPositive).length;
  const forkProofRows = rows.filter((row) => row.routeGate.forkProof).length;
  const routePositive = 0;
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-market-launch-choreography-routes.js",
    scope: "Read-only Sonne-style lending market launch/config choreography scanner",
    safety: {
      rpcInventoryRead: Object.keys(rpcPool).length > 0,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    thresholds: {
      minLtv: MIN_LTV,
      minBorrowLiquidityUsd: MIN_BORROW_LIQUIDITY_USD,
      lowMarketSupplyUsd: LOW_MARKET_SUPPLY_USD,
      lowProducerTvlUsd: LOW_PRODUCER_TVL_USD,
      recentDeployBlocks: RECENT_DEPLOY_BLOCKS,
      logLookbackBlocks: LOG_LOOKBACK_BLOCKS,
      maxRows: MAX_ROWS,
      scanLogs: SCAN_LOGS,
    },
    inputs: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, path.relative(WORKSPACE, file).replace(/\\/g, "/")])),
    blocks,
    recentMorphoLogs,
    summary: {
      rowsInput: highLtvRows.length,
      rowsScored: rows.length,
      chainsInput: chainIds.length,
      chainsWithRpc: Object.keys(rpcPool).length,
      byProtocol: countBy(rows, (row) => row.protocol),
      byChain: countBy(rows, (row) => row.chain),
      zeroCollateralRows,
      lowMarketSupplyRows,
      lowProducerTvlRows,
      recentProducerRows,
      exactEconomicsNegativeRows,
      exactLaunchOrderingRows,
      exactAcquisitionRouteRows,
      exactBorrowExitRouteRows,
      exactEconomicsRows,
      forkProofRows,
      preforkLaunchRisk,
      watchCandidates,
      routePositive,
      signedActionJustified: false,
      bestLaunchRiskScore: maxNumber(rows, (row) => row.launchRiskScore),
      bestRouteLiquidityUsd: maxNumber(rows, (row) => row.routeLiquidityUsd),
      lowestProducerTvlUsd: minNumber(rows, (row) => row.linkedState.producerTvlUsd),
      recentMorphoCreateMarketLogs: Object.values(recentMorphoLogs).reduce((sum, row) => sum + (asNumber(row.recentCreateMarketLogs) || 0), 0),
    },
    topRows: rows.slice(0, 30),
    rows,
    requiredForRoutePositive: [
      "new or recently configured lending market has high LTV/LLTV/CF enabled",
      "borrow-side liquidity is material and caps/pause state permit borrowing",
      "collateral side is empty, underseeded, newly deployed, or otherwise manipulable",
      "public acquisition/deposit route exists for the collateral",
      "exact unsafe transaction ordering is proven for a deployed market",
      "exact acquisition + borrow + exit economics are positive after fees/gas/slippage",
      "fork extraction proof demonstrates positive net value",
    ],
    nextReadOnlyStep: watchCandidates > 0
      ? "Treat current launch-risk rows as research-only; decode exact unsafe ordering plus collateral acquisition and borrow/exit quotes before any fork."
      : "Refresh high-LTV/new-vault artifacts and scan recent governance/timelock events; reopen only if an underseeded high-LTV market has exact positive economics.",
  };
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, `${renderReport(artifact)}\n`);
  if (!QUIET) {
    console.log(`Market-launch choreography: rows=${rows.length} watch=${watchCandidates} prefork=${preforkLaunchRisk} exactLaunch=${exactLaunchOrderingRows} exactEconomics=${exactEconomicsRows} forkProof=${forkProofRows} routePositive=0`);
    console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  const message = String(err?.stack || err?.message || err).replace(/https?:\/\/[^\s'"<>]+/g, "[redacted-url]");
  console.error(message);
  process.exitCode = 1;
});
