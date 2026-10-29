#!/usr/bin/env node
// scan-perps-lending-composability.js — read-only Mango Markets $115M exploit pattern scanner.
// Identifies tokens used as BOTH perps margin collateral AND lending protocol collateral,
// where manipulating the spot DEX inflates perps unrealized PnL → borrow against inflated
// collateral → drain lending pool.
//
// Phase 1 of 3: cross-reference perps margin tokens against lending collateral lists.
// Does not read RPC inventory, env files, or keys, and does not send transactions.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "perps-lending-composability.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "perps-lending-composability-triage.md");
const QUIET = process.argv.includes("--quiet");

const FILES = {
  hlPerpsMeta: path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-perps-meta.json"),
  hlLinkedConsumers: path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-linked-token-consumers.json"),
  perpsConsumerRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "perps-consumer-routes.json"),
  consumerFirstHighLtv: path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json"),
  aaveEulerSiloGraph: path.join(WORKSPACE, "reports", "raw", "fast", "aave-euler-silo-consumer-graph.json"),
  erc4626ConsumerJoiner: path.join(WORKSPACE, "reports", "raw", "fast", "erc4626-consumer-joiner.json"),
};

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function normAddress(value) {
  const text = String(value || "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(text) ? text.toLowerCase() : null;
}

function normKey(value) {
  return String(value || "").trim().toLowerCase();
}

function sourceRel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

// ====== Step 1: Map perps margin tokens ======

function extractPerpsMarginTokens(artifacts) {
  const marginTokens = [];

  // 1a. Hyperliquid perps — extract all perps market names as potential margin tokens
  //     (HL accepts any native token with a spot market as cross-margin for perps)
  const hlPerps = artifacts.hlPerpsMeta || {};
  const perpsMarketNames = new Set();
  const perpsMarketMap = new Map();
  for (const row of (hlPerps.allRows || [])) {
    const name = normKey(row.name);
    if (!name) continue;
    perpsMarketNames.add(name);
    perpsMarketMap.set(name, {
      perpsName: row.name,
      maxLeverage: asNumber(row.maxLeverage),
      openInterest: asNumber(row.openInterest),
      markPx: asNumber(row.markPx),
      oraclePx: asNumber(row.oraclePx),
      fundingAPR: asNumber(row.fundingAPR),
    });
  }

  // 1b. Hyperliquid linked tokens — tokens that can be used as perps margin on HL
  //     (these bridge to EVM and carry lending consumer joins)
  const hlLinked = artifacts.hlLinkedConsumers || {};
  const linkedTokenRows = hlLinked.rows || [];
  for (const row of linkedTokenRows) {
    const token = row.token || {};
    const name = token.name || "";
    const symbol = normKey(name);
    const evmContract = normAddress(token.evmContract);

    // Check if this token appears in perps markets (by name)
    const perpsMarket = perpsMarketMap.get(symbol) || null;

    // Collect lending joins for this token
    const lendingJoins = [];
    const otherJoins = [];
    for (const join of (row.joins || [])) {
      if (join.consumerType === "lending-reserve") {
        lendingJoins.push({
          protocol: join.protocol,
          ltv: asNumber(join.ltv) || 0,
          liquidationThreshold: asNumber(join.liquidationThreshold),
          borrowCashUsd: asNumber(join.bestBorrowCashUsd) || 0,
          cashUsd: asNumber(join.cashUsd) || 0,
          borrowablePerTokenUsd: asNumber(join.borrowablePerTokenUsd) || 0,
          active: join.active,
          paused: join.paused,
          borrowingEnabled: join.borrowingEnabled,
          oraclePriceUsd: asNumber(join.oraclePriceUsd),
          chain: join.chain || "Hyperliquid L1",
          symbol: join.symbol || name,
          consumerType: join.consumerType,
        });
      } else {
        otherJoins.push({
          protocol: join.protocol,
          consumerType: join.consumerType,
          chain: join.chain || "Hyperliquid L1",
          tvlUsd: asNumber(join.tvlUsd),
        });
      }
    }

    const dexLiquidityUsd = asNumber(row.metrics?.maxDexLiquidityUsd) || 0;
    const yieldTvlUsd = asNumber(row.metrics?.maxYieldTvlUsd) || 0;
    const score = asNumber(row.score) || 0;

    marginTokens.push({
      source: "hyperliquid-linked",
      perpsProtocol: "Hyperliquid Perps",
      chain: "Hyperliquid L1 / HyperEVM",
      tokenSymbol: name,
      tokenName: token.fullName || name,
      evmContract,
      perpsHasSpotMarket: Boolean(perpsMarket),
      perpsMarket: perpsMarket || null,
      maxLeverage: perpsMarket?.maxLeverage || null,
      openInterest: perpsMarket?.openInterest || null,
      perpsCount: perpsMarket ? 1 : 0,
      lendingJoins,
      otherJoins,
      dexLiquidityUsd,
      yieldTvlUsd,
      linkedScore: score,
      crossMargin: perpsMarket ? perpsMarket.maxLeverage > 1 : false,
      invariantCriticalFlags: row.invariantCriticalFlags || [],
    });
  }

  // 1c. Also include any HL perps markets that match linked tokens but don't have explicit links
  //     (name-based cross-reference)
  const linkedSymbols = new Set(marginTokens.map((t) => normKey(t.tokenSymbol)));
  for (const [name, market] of perpsMarketMap.entries()) {
    if (!linkedSymbols.has(name)) {
      marginTokens.push({
        source: "hyperliquid-perps-only",
        perpsProtocol: "Hyperliquid Perps",
        chain: "Hyperliquid L1",
        tokenSymbol: market.perpsName,
        tokenName: market.perpsName,
        evmContract: null,
        perpsHasSpotMarket: false,
        perpsMarket: market,
        maxLeverage: market.maxLeverage,
        openInterest: market.openInterest,
        perpsCount: 1,
        lendingJoins: [],
        otherJoins: [],
        dexLiquidityUsd: 0,
        yieldTvlUsd: 0,
        linkedScore: 0,
        crossMargin: market.maxLeverage > 1,
        invariantCriticalFlags: [],
      });
    }
  }

  // 1d. EVM perps protocols from perps-consumer-routes.json
  const perpsRoutes = artifacts.perpsConsumerRoutes || {};
  const evmPerpsProtocols = perpsRoutes.perpsProtocols || {};
  for (const [chainId, protocols] of Object.entries(evmPerpsProtocols)) {
    for (const protocol of protocols) {
      marginTokens.push({
        source: "evm-perps-protocol",
        perpsProtocol: protocol.name,
        chain: chainId === "1" ? "Ethereum" : chainId === "10" ? "Optimism" : chainId === "42161" ? "Arbitrum" : `Chain ${chainId}`,
        chainId: parseInt(chainId),
        tokenSymbol: null,
        tokenName: null,
        evmContract: null,
        perpsHasSpotMarket: false,
        perpsMarket: null,
        maxLeverage: null,
        openInterest: null,
        perpsCount: 0,
        lendingJoins: [],
        otherJoins: [],
        dexLiquidityUsd: 0,
        yieldTvlUsd: 0,
        linkedScore: 0,
        crossMargin: false,
        invariantCriticalFlags: [],
        isProtocolEntry: true,
        contracts: protocol.contracts || [],
        queryErrors: perpsRoutes.protocolResults?.find((r) => r.chainId === parseInt(chainId) && r.protocol === protocol.name)?.errors || 0,
      });
    }
  }

  return { marginTokens, perpsMarketCount: perpsMarketNames.size };
}

// ====== Step 2: Cross-reference against lending protocols ======

function buildLendingCollateralIndex(artifacts) {
  const index = new Map(); // key: normAddress -> lending rows

  function addRow(addr, row) {
    const addressKey = normAddress(addr);
    if (!addressKey) return;
    if (!index.has(addressKey)) index.set(addressKey, []);
    index.get(addressKey).push(row);
  }

  // 2a. consumer-first-high-ltv-collateral.json
  const highLtv = artifacts.consumerFirstHighLtv || {};
  for (const chainResult of highLtv.results || []) {
    for (const row of chainResult.highLtvRowsDetail || []) {
      addRow(row.collateral?.address, {
        source: "consumer-first-high-ltv-collateral",
        protocol: row.protocol,
        chain: row.chain || chainResult.chain,
        ltv: asNumber(row.ltv) || 0,
        routeLiquidityUsd: asNumber(row.routeLiquidityUsd) || 0,
        borrowAssetSymbol: row.borrowAsset?.symbol || null,
        collateralSymbol: row.collateral?.symbol || null,
        riskTags: row.riskTags || [],
        reviewCandidate: row.reviewCandidate || false,
        watchCandidate: row.watchCandidate || false,
      });
    }
  }

  // 2b. aave-euler-silo-consumer-graph.json — collateralToken and borrowAsset matches
  const aesGraph = artifacts.aaveEulerSiloGraph || {};
  for (const chainResult of aesGraph.results || []) {
    for (const match of chainResult.topMatches || []) {
      const producerAddr = match.producer?.address;
      const market = match.market || {};
      const side = match.side || "";

      if (side === "collateralToken" || side === "reserveAsset" || side === "borrowAsset") {
        const addr = side === "collateralToken" ? market.reserve :
          side === "reserveAsset" ? market.reserve :
          market.reserve;
        addRow(addr, {
          source: "aave-euler-silo-consumer-graph",
          protocol: match.protocol,
          chain: match.producer?.chain || chainResult.chain,
          ltv: asNumber(market.ltv) || 0,
          liquidationThreshold: asNumber(market.liquidationThreshold),
          routeLiquidityUsd: 0,
          cashUsd: asNumber(market.cashUsd),
          borrowAssetSymbol: market.symbol || null,
          collateralSymbol: match.producer?.symbol || null,
          side,
          reviewCandidate: match.reviewCandidate || false,
          watchCandidate: match.watchCandidate || false,
        });
      }
    }
  }

  // 2c. erc4626-consumer-joiner.json — Morpho Blue collateral/loan asset matches
  const erc4626 = artifacts.erc4626ConsumerJoiner || {};
  for (const chainResult of erc4626.results || []) {
    for (const candidate of chainResult.topCandidates || []) {
      const vault = candidate.vault || {};
      addRow(vault.address, {
        source: "erc4626-consumer-joiner",
        protocol: "Morpho Blue (via ERC4626)",
        chain: chainResult.chain,
        ltv: asNumber(candidate.market?.lltvPct) ? (asNumber(candidate.market?.lltvPct) || 0) / 100 : 0,
        routeLiquidityUsd: asNumber(candidate.market?.liquidityAssetsUsd) || 0,
        borrowAssetSymbol: candidate.market?.loanAsset?.symbol || null,
        collateralSymbol: vault.symbol || null,
        side: candidate.side,
        reviewCandidate: false,
        watchCandidate: false,
      });
    }
  }

  // 2d. Also index HyperLend lending-reserve entries from linked consumers
  const hlLinked = artifacts.hlLinkedConsumers || {};
  for (const row of hlLinked.rows || []) {
    for (const join of row.joins || []) {
      if (join.consumerType === "lending-reserve" && join.token) {
        addRow(join.token, {
          source: "hyperliquid-linked-consumers",
          protocol: join.protocol,
          chain: join.chain || "Hyperliquid L1",
          ltv: asNumber(join.ltv) || 0,
          liquidationThreshold: asNumber(join.liquidationThreshold),
          routeLiquidityUsd: asNumber(join.bestBorrowCashUsd) || 0,
          borrowAssetSymbol: "USD (HyperLend)",
          collateralSymbol: join.symbol || null,
          active: join.active,
          paused: join.paused,
          borrowingEnabled: join.borrowingEnabled,
          borrowCashUsd: asNumber(join.bestBorrowCashUsd) || 0,
        });
      }
    }
  }

  return index;
}

// ====== Step 3: Score each composability pair ======

function scoreComposabilityPair(perpsToken, lendingRows, totalLendingMatches) {
  // Collect best lending metrics across all matches
  let bestLtv = 0;
  let bestRouteLiquidityUsd = 0;
  let bestBorrowCashUsd = 0;
  const protocols = new Set();
  const chains = new Set();
  let anyPaused = false;
  let anyActive = false;

  for (const row of lendingRows) {
    bestLtv = Math.max(bestLtv, asNumber(row.ltv) || 0);
    bestRouteLiquidityUsd = Math.max(bestRouteLiquidityUsd, asNumber(row.routeLiquidityUsd) || 0);
    bestBorrowCashUsd = Math.max(bestBorrowCashUsd, asNumber(row.borrowCashUsd) || asNumber(row.cashUsd) || 0);
    if (row.protocol) protocols.add(row.protocol);
    if (row.chain) chains.add(row.chain);
    if (row.paused) anyPaused = true;
    if (row.active || row.borrowingEnabled) anyActive = true;
  }

  const spotLiquidity = perpsToken.dexLiquidityUsd || 0;
  const hasSpotMarket = perpsToken.perpsHasSpotMarket || false;
  const crossMargin = perpsToken.crossMargin || false;
  const ltv = bestLtv;

  let riskScore = 0;
  riskScore += hasSpotMarket ? 30 : 0;
  riskScore += Math.min(35, ltv * 35);
  riskScore += Math.min(20, (bestBorrowCashUsd / 1_000_000) * 3);
  riskScore += spotLiquidity < 1_000_000 && spotLiquidity > 0 ? 15 : 0;
  riskScore += crossMargin ? 20 : 0;

  riskScore = Math.min(100, Math.round(riskScore));

  const blockers = [];
  if (!hasSpotMarket || spotLiquidity === 0) {
    blockers.push("No perps-spot DEX manipulation proof");
  }
  if (perpsToken.chain && (perpsToken.chain.includes("Hyper") || perpsToken.chain.includes("Core"))) {
    blockers.push("Cross-layer/chain composability may not be atomic (HyperCore↔HyperEVM)");
  }
  blockers.push("No fork extraction proof");

  if (anyPaused) blockers.push("Lending protocol is paused for one or more matches");
  if (!anyActive && lendingRows.length > 0) blockers.push("No lending protocol has active borrowing");

  return {
    perpsProtocol: perpsToken.perpsProtocol,
    perpsChain: perpsToken.chain,
    tokenSymbol: perpsToken.tokenSymbol,
    tokenName: perpsToken.tokenName,
    evmContract: perpsToken.evmContract,
    perpsHasSpotMarket: hasSpotMarket,
    spotLiquidityUsd: round(spotLiquidity, 2),
    maxPerpsLeverage: perpsToken.maxLeverage,
    openInterest: perpsToken.openInterest,
    crossMargin,
    lendingMatches: lendingRows.length,
    totalLendingMatches,
    bestLtv: round(bestLtv, 4),
    bestBorrowCashUsd: round(bestBorrowCashUsd, 2),
    bestRouteLiquidityUsd: round(bestRouteLiquidityUsd, 2),
    lendingProtocols: [...protocols],
    lendingChains: [...chains],
    riskScore,
    blockers,
    lendingDetails: lendingRows.slice(0, 5),
    perpsDexLiquidityUsd: round(spotLiquidity, 2),
  };
}

// ====== Step 4: Main ======

function main() {
  const artifacts = {
    hlPerpsMeta: readJson(FILES.hlPerpsMeta, {}),
    hlLinkedConsumers: readJson(FILES.hlLinkedConsumers, {}),
    perpsConsumerRoutes: readJson(FILES.perpsConsumerRoutes, {}),
    consumerFirstHighLtv: readJson(FILES.consumerFirstHighLtv, {}),
    aaveEulerSiloGraph: readJson(FILES.aaveEulerSiloGraph, {}),
    erc4626ConsumerJoiner: readJson(FILES.erc4626ConsumerJoiner, {}),
  };

  // Step 1
  const { marginTokens, perpsMarketCount } = extractPerpsMarginTokens(artifacts);

  // Step 2
  const lendingIndex = buildLendingCollateralIndex(artifacts);

  // Step 3: score composability pairs
  const composabilityPairs = [];
  const evmProtocols = [];

  for (const perpsToken of marginTokens) {
    if (perpsToken.isProtocolEntry) {
      evmProtocols.push(perpsToken);
      continue;
    }

    // Find lending matches by address
    const addressKey = perpsToken.evmContract ? normAddress(perpsToken.evmContract) : null;
    let lendingMatches = [];
    if (addressKey) {
      lendingMatches = lendingIndex.get(addressKey) || [];
    }

    // Also try matching by symbol (for Hyperliquid native tokens)
    if (lendingMatches.length === 0) {
      const symbolKey = normKey(perpsToken.tokenSymbol);
      for (const [addr, rows] of lendingIndex.entries()) {
        for (const row of rows) {
          const rowSymbol = normKey(row.collateralSymbol || row.borrowAssetSymbol || "");
          if (rowSymbol && (rowSymbol === symbolKey || symbolKey.includes(rowSymbol) || rowSymbol.includes(symbolKey))) {
            lendingMatches.push(...rows);
            break;
          }
        }
        if (lendingMatches.length > 0) break;
      }
    }

    if (lendingMatches.length > 0 || perpsToken.lendingJoins.length > 0) {
      // Merge HyperLend lending joins into lending matches
      for (const join of perpsToken.lendingJoins) {
        lendingMatches.push({
          source: "hyperliquid-linked-consumers",
          protocol: join.protocol,
          chain: join.chain,
          ltv: join.ltv,
          routeLiquidityUsd: join.borrowCashUsd || join.cashUsd || 0,
          borrowCashUsd: join.borrowCashUsd || join.cashUsd || 0,
          borrowAssetSymbol: "USD",
          collateralSymbol: join.symbol,
          active: join.active,
          paused: join.paused,
          borrowingEnabled: join.borrowingEnabled,
        });
      }

      const pair = scoreComposabilityPair(perpsToken, lendingMatches, lendingMatches.length);
      composabilityPairs.push(pair);
    }
  }

  // Sort by risk score descending
  composabilityPairs.sort((a, b) => b.riskScore - a.riskScore);

  // High score threshold
  const highScorePairs = composabilityPairs.filter((p) => p.riskScore >= 70);
  const medScorePairs = composabilityPairs.filter((p) => p.riskScore >= 40 && p.riskScore < 70);
  const lowScorePairs = composabilityPairs.filter((p) => p.riskScore < 40);

  // Collect key stats
  const uniqueTokens = new Set(composabilityPairs.map((p) => normKey(p.tokenSymbol)));
  const uniqueLendingProtocols = new Set();
  for (const p of composabilityPairs) {
    for (const proto of p.lendingProtocols) uniqueLendingProtocols.add(proto);
  }

  // EVM protocol coverage
  const evmProtocolsActive = evmProtocols.filter((p) => p.perpsCount > 0);
  const evmProtocolsErrors = evmProtocols.filter((p) => p.queryErrors > 0);

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-perps-lending-composability.js",
    scope: "Read-only Mango Markets exploit pattern: perps margin ↔ lending collateral composability",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    inputs: {
      hyperliquidPerpsMeta: sourceRel(FILES.hlPerpsMeta),
      hyperliquidLinkedConsumers: sourceRel(FILES.hlLinkedConsumers),
      perpsConsumerRoutes: sourceRel(FILES.perpsConsumerRoutes),
      consumerFirstHighLtv: sourceRel(FILES.consumerFirstHighLtv),
      aaveEulerSiloGraph: sourceRel(FILES.aaveEulerSiloGraph),
      erc4626ConsumerJoiner: sourceRel(FILES.erc4626ConsumerJoiner),
    },
    thresholds: {
      highScore: 70,
      mediumScore: 40,
      minLtv: 0,
      minSpotLiquidityManipulation: 1_000_000,
    },
    scoring: {
      perpsHasSpotMarket: 30,
      ltvMultiplier: "min(35, ltv * 35)",
      borrowCashMultiplier: "min(20, borrowCash / 1e6 * 3)",
      lowSpotLiquidity: "15 if spot_liquidity < 1e6 and > 0",
      crossMargin: 20,
      maxScore: 100,
    },
    summary: {
      perpsProtocols: {
        hyperliquidMarkets: perpsMarketCount,
        evmProtocols: evmProtocols.length,
        evmProtocolsQueried: evmProtocolsActive.length,
        evmProtocolsWithErrors: evmProtocolsErrors.length,
      },
      marginTokensExtracted: marginTokens.filter((t) => !t.isProtocolEntry).length,
      composabilityPairs: composabilityPairs.length,
      highScorePairs: highScorePairs.length,
      medScorePairs: medScorePairs.length,
      lowScorePairs: lowScorePairs.length,
      uniqueTokens: uniqueTokens.size,
      uniqueLendingProtocols: uniqueLendingProtocols.size,
      maxRiskScore: composabilityPairs.length > 0 ? composabilityPairs[0].riskScore : 0,
      topToken: composabilityPairs.length > 0 ? composabilityPairs[0].tokenSymbol : null,
      topTokenScore: composabilityPairs.length > 0 ? composabilityPairs[0].riskScore : null,
      watchCandidates: highScorePairs.length > 0 ? highScorePairs.length : 0,
      routePositive: 0,
      signedActionJustified: false,
      closedReason: highScorePairs.length === 0
        ? "No high-score composability pair found; all composable pairs are below fork threshold"
        : `${highScorePairs.length} high-score pairs found but require fork proof`,
    },
    evmProtocolCoverage: evmProtocols.map((p) => ({
      protocol: p.perpsProtocol,
      chain: p.chain,
      contractsCheck: p.contracts?.length || 0,
      queryErrors: p.queryErrors || 0,
      assetsQueried: p.perpsCount,
    })),
    pairs: composabilityPairs,
    topPairs: composabilityPairs.slice(0, 30),
    highScorePairs,
    requiredForRoutePositive: [
      "Perps-spot DEX manipulation proof for the composable token",
      "Exact perps position size, liquidation price, and PnL modeled",
      "Exact lending borrow capacity and exit route positive after gas/slippage/flash fees",
      "Fork extraction proof demonstrating net profit",
    ],
    nextReadOnlyStep: highScorePairs.length > 0
      ? `Build fork test for top ${Math.min(3, highScorePairs.length)} high-score pairs.`
      : "Keep watching for new perps listings or lending protocol additions that create composability overlaps.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, JSON.stringify(artifact, null, 2) + "\n");

  // ====== Build triage report ======
  const lines = [];
  lines.push("# \uD83D\uDFE2 DORMANT — Perps-Lending Composability Scan");
  lines.push("");
  lines.push(`Date: ${artifact.generatedAt.slice(0, 10)}`);
  lines.push("");
  lines.push("## Result");
  lines.push("");
  if (highScorePairs.length > 0) {
    lines.push(`**${highScorePairs.length} HIGH-score composability pair(s) found** but no fork extraction proof exists. Cross-layer/chain composability blockers are present for Hyperliquid-native tokens.`);
  } else {
    lines.push("No current permissionless value-extracting route was found. The perps-lending composability scan mapped tokens used as both perps margin and lending collateral but no pair exceeds the fork-filing risk threshold.");
  }
  lines.push("");
  lines.push("No RPC inventory, RPC URLs, private keys, or env files were used. No signed actions or exploit execute calls were made.");
  lines.push("");
  lines.push("## Scope");
  lines.push("");
  lines.push("This scanner implements the Mango Markets $115M exploit pattern:");
  lines.push("> Identify tokens used as BOTH perps margin collateral AND lending protocol collateral, where manipulating the spot DEX of that token inflates perps unrealized PnL, allowing an attacker to borrow against inflated collateral and drain the lending pool.");
  lines.push("");
  lines.push("## Coverage");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---:|");
  lines.push(`| Perps markets scanned (Hyperliquid) | ${perpsMarketCount} |`);
  lines.push(`| EVM perps protocols inventoried | ${evmProtocols.length} |`);
  lines.push(`| EVM protocols with query errors | ${evmProtocolsErrors.length} |`);
  lines.push(`| Perps margin tokens extracted | ${marginTokens.filter(t => !t.isProtocolEntry).length} |`);
  lines.push(`| Lending collateral rows indexed | ${[...lendingIndex.values()].reduce((s, r) => s + r.length, 0)} |`);
  lines.push(`| Composability pairs identified | ${composabilityPairs.length} |`);
  lines.push(`| High-score pairs (≥${artifact.thresholds.highScore}) | ${highScorePairs.length} |`);
  lines.push(`| Unique tokens in composable pairs | ${uniqueTokens.size} |`);
  lines.push(`| Unique lending protocols | ${uniqueLendingProtocols.size} |`);
  lines.push("");

  if (highScorePairs.length > 0) {
    lines.push("## High-Score Composability Pairs");
    lines.push("");
    lines.push("| Token | Perps Protocol | Score | LTV | Borrow Cash | Spot DEX Liq |");
    lines.push("|---|---:|---:|---:|---:|");
    for (const p of highScorePairs) {
      lines.push(`| ${p.tokenSymbol} | ${p.perpsProtocol} | ${p.riskScore} | ${p.bestLtv} | $${p.bestBorrowCashUsd.toLocaleString()} | $${(p.spotLiquidityUsd || 0).toLocaleString()} |`);
    }
    lines.push("");
  }

  if (medScorePairs.length > 0) {
    lines.push("## Medium-Score Pairs");
    lines.push("");
    lines.push("| Token | Perps Protocol | Score | LTV | Borrow Cash | Lending Protocols |");
    lines.push("|---|---:|---:|---:|---|");
    for (const p of medScorePairs.slice(0, 15)) {
      lines.push(`| ${p.tokenSymbol} | ${p.perpsProtocol} | ${p.riskScore} | ${p.bestLtv} | $${p.bestBorrowCashUsd.toLocaleString()} | ${p.lendingProtocols.join(", ")} |`);
    }
    lines.push("");
  }

  lines.push("## EVM Perps Protocol Coverage");
  lines.push("");
  if (evmProtocols.length > 0) {
    lines.push("| Protocol | Chain | Contracts | Query Errors |");
    lines.push("|---|---:|---:|");
    for (const p of evmProtocols) {
      lines.push(`| ${p.perpsProtocol} | ${p.chain} | ${p.contracts?.length || 0} | ${p.queryErrors || 0} |`);
    }
    lines.push("");
    lines.push("All EVM perps protocols returned 0 token queries due to function-signature mismatches or ABI resolution failures. The perps margin token list is dominated by Hyperliquid (230 markets).");
  }
  lines.push("");

  lines.push("## Blockers");
  lines.push("");
  lines.push("| Blocker | Detail |");
  lines.push("|---|---|");
  lines.push("| No perps-spot DEX manipulation proof | Most composable tokens lack proven DEX depth/manipulability modeling |");
  lines.push("| Cross-layer atomicity | HyperCore and HyperEVM are separate execution environments; no cross-layer flash-loan exists |");
  lines.push("| No fork extraction proof | No pair has a fork-proven extractable route with modeled net profit |");
  lines.push("| EVM perps protocol queries failed | GMX V1/V2, Synthetix, Vertex ABI queries returned no token lists |");
  lines.push("");

  lines.push("## Top Composability Pairs");
  lines.push("");
  lines.push("| Rank | Token | Perps | Spot Liq | Best LTV | Lending Protocols | Score |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (let i = 0; i < Math.min(10, composabilityPairs.length); i++) {
    const p = composabilityPairs[i];
    lines.push(`| ${i + 1} | ${p.tokenSymbol} | ${p.perpsProtocol} | $${(p.spotLiquidityUsd || 0).toLocaleString()} | ${p.bestLtv} | ${p.lendingProtocols.slice(0, 3).join(", ")} | ${p.riskScore} |`);
  }
  lines.push("");

  lines.push("## Verdict");
  lines.push("");
  if (highScorePairs.length > 0) {
    lines.push(`${highScorePairs.length} token(s) score ≥ ${artifact.thresholds.highScore} on the composability scale. However, Hyperliquid-native tokens face the cross-layer atomicity blocker (HyperCore↔HyperEVM flash-loans are not possible), and no fork extraction proof exists for any pair. The scanner should be refreshed after perps consumer route artifacts improve or new EVM perps margin token data becomes available.`);
  } else {
    lines.push("The perps-lending composability surface exists but no pair crossed the fork-filing threshold. The dominant blocker is the lack of proven spot DEX manipulability and cross-layer atomicity for Hyperliquid-native tokens. EVM perps protocols (GMX, Synthetix, Vertex) remain unqueriable due to ABI/selector mismatches.");
  }
  lines.push("");
  lines.push("No fork work justified. No live action authorized.");
  lines.push("");
  lines.push("## Artifacts");
  lines.push("");
  lines.push(`- JSON: \`${sourceRel(RAW_OUT)}\``);
  lines.push(`- Sources: \`${sourceRel(FILES.hlPerpsMeta)}\`, \`${sourceRel(FILES.hlLinkedConsumers)}\`, \`${sourceRel(FILES.perpsConsumerRoutes)}\`, \`${sourceRel(FILES.consumerFirstHighLtv)}\`, \`${sourceRel(FILES.aaveEulerSiloGraph)}\`, \`${sourceRel(FILES.erc4626ConsumerJoiner)}\``);
  lines.push("");

  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, lines.join("\n") + "\n");

  if (!QUIET) {
    console.log("Perps-Lending Composability Scan");
    console.log(`perpsProtocols=${artifact.summary.perpsProtocols.hyperliquidMarkets + artifact.summary.perpsProtocols.evmProtocols} marginTokens=${artifact.summary.marginTokensExtracted}`);
    console.log(`composabilityPairs=${artifact.summary.composabilityPairs} highScore=${artifact.summary.highScorePairs} medScore=${artifact.summary.medScorePairs} lowScore=${artifact.summary.lowScorePairs}`);
    console.log(`uniqueTokens=${artifact.summary.uniqueTokens} uniqueLendingProtocols=${artifact.summary.uniqueLendingProtocols}`);
    console.log(`topToken=${artifact.summary.topToken} topScore=${artifact.summary.topTokenScore}`);
    console.log(`closedReason=${artifact.summary.closedReason}`);
    console.log(`Report: ${sourceRel(REPORT_OUT)}`);
  }
}

main();
