#!/usr/bin/env node
// scan-cross-protocol-composition.js
//
// Artifact-only Phase 1 scanner for cross-protocol 3+ hop composition chains:
// receipt/vault/bridge/PT token -> lending market A collateral -> borrow asset B
// -> lending market C collateral -> borrow asset D -> terminal exit.
//
// This scanner only consumes existing sanitized local artifacts. It does not read
// rpc_endpoints.txt, graphql_endpoints.txt, .env files, key material, or perform
// eth_call/fork/live/signed actions. Exact-economics and fork gates are left
// fail-closed unless already proven in source artifacts.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const QUIET = process.argv.includes("--quiet");

const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "cross-protocol-composition.json");
const OUT_MD = path.join(WORKSPACE, "reports", "cross-protocol-composition-triage.md");

const FILES = {
  consumerFirstHighLtv: path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json"),
  aaveEulerSiloGraph: path.join(WORKSPACE, "reports", "raw", "fast", "aave-euler-silo-consumer-graph.json"),
  erc4626ConsumerJoiner: path.join(WORKSPACE, "reports", "raw", "fast", "erc4626-consumer-joiner.json"),
  pendlePtConsumerGraph: path.join(WORKSPACE, "reports", "raw", "fast", "pendle-pt-consumer-graph.json"),
  pendlePtMultichainConsumerGraph: path.join(WORKSPACE, "reports", "raw", "fast", "pendle-pt-multichain-consumer-graph.json"),
  bridgeLendingCollateralJoin: path.join(WORKSPACE, "reports", "raw", "fast", "bridge-lending-collateral-join.json"),
  bridgeNonlosslessCollateralJoin: path.join(WORKSPACE, "reports", "raw", "fast", "bridge-nonlossless-collateral-join.json"),
  bridgeCollateralExposure: path.join(WORKSPACE, "reports", "raw", "fast", "bridge-collateral-exposure.json"),
};

const THRESHOLDS = {
  minHopLiquidityUsd: 10_000,
  highSignalLiquidityUsd: 100_000,
  topRows: 60,
  maxCandidateRows: 350,
};

const ROOT_RISK_TAGS = new Set([
  "principal-token",
  "receipt-or-yield-bearing",
  "bridge-wrapper",
  "known-local-artifact-token",
  "rwa-or-credit",
  "noncanonical-or-unknown",
  "erc4626-vault",
  "bridge-signal",
  "value-bearing-review",
]);

const EXIT_SYMBOLS = new Set([
  "usdc", "usdt", "dai", "usds", "susds", "lusd", "frax", "frxusd", "pyusd", "rlusd", "usde", "usdtb", "usda",
  "weth", "eth", "weeth", "wsteth", "reth", "cbeth", "ezeth", "wbtc", "cbbtc", "tbtc", "solvbtc", "eurt", "eure",
]);

function loadJson(file, fallback = null) {
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

function safeArray(value) {
  return Array.isArray(value) ? value : [];
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

function chainKey(value) {
  const text = normKey(value).replace(/\s+/g, "");
  const aliases = {
    eth: "ethereum",
    mainnet: "ethereum",
    ethereum: "ethereum",
    arb: "arbitrum",
    arbitrumone: "arbitrum",
    arbitrum: "arbitrum",
    op: "optimism",
    optimisticethereum: "optimism",
    optimism: "optimism",
    bnb: "bsc",
    binance: "bsc",
    binancesmartchain: "bsc",
    bnbchain: "bsc",
    bsc: "bsc",
    polygonpos: "polygon",
    polygon: "polygon",
    base: "base",
    avalanche: "avalanche",
    avax: "avalanche",
    linea: "linea",
    unichain: "unichain",
    sonic: "sonic",
    worldchain: "worldchain",
    "world-chain": "worldchain",
    ink: "ink",
    hyperevm: "hyperevm",
    hyperliquid: "hyperliquid",
  };
  return aliases[text] || text || null;
}

function compatibleChain(a, b) {
  const ak = chainKey(a);
  const bk = chainKey(b);
  if (!ak || !bk || ak === "multi-chain" || bk === "multi-chain") return true;
  return ak === bk;
}

function strictSameChain(a, b) {
  const ak = chainKey(a);
  const bk = chainKey(b);
  const nonConcrete = new Set(["multi-chain", "multichain", "unknown", "any", "null", "undefined"]);
  return Boolean(ak && bk && !nonConcrete.has(ak) && !nonConcrete.has(bk) && ak === bk);
}

function sourceRel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function uniq(values) {
  return [...new Set((values || []).filter((v) => v !== null && v !== undefined && v !== ""))];
}

function splitListValue(value) {
  if (Array.isArray(value)) return value.flatMap(splitListValue);
  return String(value || "")
    .split(/[,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function artifactList(value) {
  return uniq(splitListValue(value).filter((item) => /^(reports|tools|coordination|\.opencode)\//.test(item)));
}

function short(value) {
  const text = String(value || "");
  if (text.length <= 18) return text;
  return `${text.slice(0, 10)}...${text.slice(-6)}`;
}

function tokenRef(input = {}) {
  const address = input.address || input.token || input.reserve || input.asset || null;
  const symbol = input.symbol || input.name || null;
  return {
    address: address || null,
    addressKey: normAddress(address),
    symbol: symbol || null,
    symbolKey: normKey(symbol),
    decimals: asNumber(input.decimals),
  };
}

function tokenLabel(token = {}) {
  return token.symbol || short(token.address || token.addressKey) || "unknown-token";
}

function marketKey(market = {}) {
  return [
    market.source,
    chainKey(market.chain) || market.chain || "unknown-chain",
    normKey(market.protocol) || "unknown-protocol",
    market.marketId || market.collateral?.addressKey || market.collateral?.symbolKey || "unknown-collateral",
    market.borrowAsset?.addressKey || market.borrowAsset?.symbolKey || "unknown-borrow",
  ].join(":");
}

function isRootishMarket(market = {}) {
  if (/pendle|erc4626|bridge/i.test(market.source || "")) return true;
  for (const tag of safeArray(market.riskTags)) {
    if (ROOT_RISK_TAGS.has(normKey(tag))) return true;
  }
  const symbol = normKey(market.collateral?.symbol);
  if (/^pt-|vault|receipt|syrup|stk|rst|lst|lrt|wrapped|bridge|usdai|usdat|usdtb|susd|sfrx|weeth|ezeth|reth|cbeth/.test(symbol)) return true;
  return false;
}

function rootKey(root = {}) {
  if (root.addressKey) return `${chainKey(root.chain) || "any"}:addr:${root.addressKey}`;
  if (root.symbolKey) return `${chainKey(root.chain) || "any"}:sym:${root.symbolKey}`;
  return `${root.source || "root"}:${root.id || Math.random()}`;
}

function createRoot(input = {}) {
  const addressKey = normAddress(input.address);
  const tags = uniq(safeArray(input.tags).concat(safeArray(input.riskTags)).map(normKey));
  return {
    id: input.id || `${input.source || "root"}:${input.chain || "any"}:${addressKey || normKey(input.symbol)}`,
    source: input.source || "unknown",
    sourceArtifact: input.sourceArtifact || null,
    chain: input.chain || null,
    chainKey: chainKey(input.chain),
    address: input.address || null,
    addressKey,
    symbol: input.symbol || null,
    symbolKey: normKey(input.symbol),
    name: input.name || null,
    category: input.category || null,
    tags,
    riskTags: tags,
    currentAnomaly: Boolean(input.currentAnomaly),
    hasProducerAnomaly: Boolean(input.hasProducerAnomaly),
    hasConcreteMismatch: Boolean(input.hasConcreteMismatch),
    materialConcreteMismatch: Boolean(input.materialConcreteMismatch),
    routePositive: Boolean(input.routePositive),
    exactEconomicsRows: asNumber(input.exactEconomicsRows) || 0,
    forkProofRows: asNumber(input.forkProofRows) || 0,
    liquidityUsd: asNumber(input.liquidityUsd ?? input.liquidityUsdHint ?? input.bestLiquidityUsd) || 0,
    blocker: input.blocker || null,
  };
}

function addMergedRoot(map, input) {
  const root = createRoot(input);
  if (!root.addressKey && !root.symbolKey) return;
  const key = rootKey(root);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, root);
    return;
  }
  existing.source = uniq(splitListValue(existing.source).concat(splitListValue(root.source))).join("+");
  existing.sourceArtifact = uniq(artifactList(existing.sourceArtifact).concat(artifactList(root.sourceArtifact))).join(", ");
  existing.category = uniq(splitListValue(existing.category).concat(splitListValue(root.category))).join(", ");
  existing.tags = uniq(existing.tags.concat(root.tags).flatMap(splitListValue));
  existing.riskTags = uniq(existing.riskTags.concat(root.riskTags).flatMap(splitListValue));
  existing.currentAnomaly = existing.currentAnomaly || root.currentAnomaly;
  existing.hasProducerAnomaly = existing.hasProducerAnomaly || root.hasProducerAnomaly;
  existing.hasConcreteMismatch = existing.hasConcreteMismatch || root.hasConcreteMismatch;
  existing.materialConcreteMismatch = existing.materialConcreteMismatch || root.materialConcreteMismatch;
  existing.routePositive = existing.routePositive || root.routePositive;
  existing.exactEconomicsRows += root.exactEconomicsRows || 0;
  existing.forkProofRows += root.forkProofRows || 0;
  existing.liquidityUsd = Math.max(existing.liquidityUsd || 0, root.liquidityUsd || 0);
  existing.blocker = existing.blocker || root.blocker;
}

function addMarket(markets, input = {}) {
  const collateral = tokenRef(input.collateral || {});
  const borrowAsset = tokenRef(input.borrowAsset || {});
  if ((!collateral.addressKey && !collateral.symbolKey) || (!borrowAsset.addressKey && !borrowAsset.symbolKey)) return;
  const market = {
    source: input.source || "unknown",
    sourceArtifact: input.sourceArtifact || null,
    protocol: input.protocol || "unknown",
    chain: input.chain || null,
    chainKey: chainKey(input.chain),
    marketId: input.marketId || null,
    oracle: input.oracle || null,
    collateral,
    borrowAsset,
    ltv: asNumber(input.ltv ?? input.lltv),
    liquidationThreshold: asNumber(input.liquidationThreshold),
    routeLiquidityUsd: asNumber(input.routeLiquidityUsd ?? input.liquidityUsd ?? input.borrowCashUsd ?? input.cashUsd) || 0,
    supplyAssetsUsd: asNumber(input.supplyAssetsUsd),
    borrowAssetsUsd: asNumber(input.borrowAssetsUsd),
    active: input.active,
    paused: input.paused,
    borrowingEnabled: input.borrowingEnabled,
    reviewCandidate: Boolean(input.reviewCandidate),
    watchCandidate: Boolean(input.watchCandidate),
    routePositive: Boolean(input.routePositive),
    exactEconomicsRows: asNumber(input.exactEconomicsRows) || 0,
    forkProofRows: asNumber(input.forkProofRows) || 0,
    riskTags: uniq(safeArray(input.riskTags).map(normKey)),
    blockers: safeArray(input.blockers).concat(input.blocker ? [input.blocker] : []),
  };
  market.id = input.id || marketKey(market);
  markets.push(market);
}

function collectHighLtv(artifact, markets, roots) {
  for (const chainResult of safeArray(artifact.results)) {
    for (const row of safeArray(chainResult.highLtvRowsDetail)) {
      const collateral = row.collateral || row.consumer?.collateralAsset || {};
      const borrowAsset = row.borrowAsset || row.consumer?.loanAsset || {};
      const riskTags = safeArray(row.riskTags).map(normKey);
      addMarket(markets, {
        source: "consumer-first-high-ltv-collateral",
        sourceArtifact: sourceRel(FILES.consumerFirstHighLtv),
        protocol: row.protocol,
        chain: row.chain || chainResult.chain,
        marketId: row.consumer?.marketId,
        oracle: row.consumer?.oracle,
        collateral,
        borrowAsset,
        ltv: row.ltv,
        routeLiquidityUsd: row.routeLiquidityUsd,
        supplyAssetsUsd: row.supplyAssetsUsd,
        borrowAssetsUsd: row.borrowAssetsUsd,
        reviewCandidate: row.reviewCandidate,
        watchCandidate: row.watchCandidate,
        routePositive: row.routePositive,
        riskTags,
        blockers: row.blockers,
      });
      if (riskTags.some((tag) => ROOT_RISK_TAGS.has(tag))) {
        addMergedRoot(roots, {
          id: `high-ltv:${row.chain || chainResult.chain}:${collateral.address || collateral.symbol}`,
          source: "consumer-first-high-ltv-collateral",
          sourceArtifact: sourceRel(FILES.consumerFirstHighLtv),
          chain: row.chain || chainResult.chain,
          address: collateral.address,
          symbol: collateral.symbol,
          name: collateral.symbol,
          category: riskTags.join(", ") || "high-ltv-root-token",
          riskTags,
          routePositive: row.routePositive,
          liquidityUsd: row.routeLiquidityUsd,
          blocker: safeArray(row.blockers)[0],
        });
      }
    }
  }
}

function collectErc4626(artifact, markets, roots) {
  for (const chainResult of safeArray(artifact.results)) {
    for (const candidate of safeArray(chainResult.topCandidates)) {
      const market = candidate.market || {};
      const vault = candidate.vault || {};
      const collateral = market.collateralAsset || { address: vault.address, symbol: vault.symbol, decimals: vault.vaultDecimals };
      const borrowAsset = market.loanAsset || {};
      addMarket(markets, {
        source: "erc4626-consumer-joiner",
        sourceArtifact: sourceRel(FILES.erc4626ConsumerJoiner),
        protocol: candidate.type || "ERC4626 consumer",
        chain: candidate.chain || chainResult.chain,
        marketId: market.marketId,
        oracle: market.oracle?.address,
        collateral,
        borrowAsset,
        ltv: asNumber(market.lltvPct) ? asNumber(market.lltvPct) / 100 : null,
        routeLiquidityUsd: market.liquidityAssetsUsd,
        supplyAssetsUsd: market.supplyAssetsUsd,
        borrowAssetsUsd: market.borrowAssetsUsd,
        routePositive: candidate.routePositive,
        riskTags: ["erc4626-vault", "receipt-or-yield-bearing"],
        blockers: candidate.blockers,
      });
      addMergedRoot(roots, {
        id: `erc4626:${candidate.chain || chainResult.chain}:${vault.address || vault.symbol}`,
        source: "erc4626-consumer-joiner",
        sourceArtifact: sourceRel(FILES.erc4626ConsumerJoiner),
        chain: candidate.chain || chainResult.chain,
        address: vault.address,
        symbol: vault.symbol,
        name: vault.name,
        category: "erc4626-vault",
        riskTags: ["erc4626-vault", "receipt-or-yield-bearing"],
        liquidityUsd: market.liquidityAssetsUsd,
        routePositive: candidate.routePositive,
        blocker: safeArray(candidate.blockers)[0],
      });
    }
  }
}

function collectPendleArtifact(artifact, sourceName, sourceFile, markets, roots) {
  for (const producer of safeArray(artifact.producers)) {
    addMergedRoot(roots, {
      id: `${sourceName}:producer:${producer.chain}:${producer.address || producer.symbol}`,
      source: sourceName,
      sourceArtifact: sourceRel(sourceFile),
      chain: producer.chain,
      address: producer.address || producer.pt,
      symbol: producer.symbol,
      name: producer.marketName,
      category: producer.category || "principal-token",
      riskTags: ["principal-token"],
      currentAnomaly: producer.currentAnomaly,
      liquidityUsd: producer.liquidityUsdHint,
      blocker: producer.blocker,
    });
  }
  const rows = safeArray(artifact.matches).concat(safeArray(artifact.topRows));
  const seen = new Set();
  for (const row of rows) {
    const producer = row.producer || {};
    const market = row.market || {};
    const collateral = market.collateralAsset || { address: producer.address || producer.pt, symbol: producer.symbol, decimals: producer.decimals };
    const borrowAsset = market.loanAsset || {};
    const id = `${sourceName}:${row.protocol}:${row.chain || producer.chain}:${market.marketId || collateral.address || collateral.symbol}:${borrowAsset.address || borrowAsset.symbol}`;
    if (seen.has(id)) continue;
    seen.add(id);
    addMarket(markets, {
      id,
      source: sourceName,
      sourceArtifact: sourceRel(sourceFile),
      protocol: row.protocol,
      chain: row.chain || producer.chain,
      marketId: market.marketId,
      oracle: market.oracle?.address,
      collateral,
      borrowAsset,
      ltv: market.lltv ?? row.ltv,
      routeLiquidityUsd: market.liquidityAssetsUsd ?? row.liquidityUsd,
      supplyAssetsUsd: market.supplyAssetsUsd,
      borrowAssetsUsd: market.borrowAssetsUsd,
      reviewCandidate: row.reviewCandidate,
      watchCandidate: row.watchCandidate,
      routePositive: row.routePositive || market.morphoOracleEconomics?.routePositive,
      exactEconomicsRows: market.morphoOracleEconomics?.quoteOk && market.morphoOracleEconomics?.netEdgeUsd > 0 ? 1 : 0,
      riskTags: ["principal-token"],
      blockers: row.blockers || market.morphoOracleEconomics?.blockers,
    });
    addMergedRoot(roots, {
      id: `${sourceName}:match:${producer.chain || row.chain}:${producer.address || producer.pt || producer.symbol}`,
      source: sourceName,
      sourceArtifact: sourceRel(sourceFile),
      chain: producer.chain || row.chain,
      address: producer.address || producer.pt,
      symbol: producer.symbol,
      name: producer.marketName,
      category: producer.category || "principal-token",
      riskTags: ["principal-token"],
      currentAnomaly: producer.currentAnomaly,
      liquidityUsd: producer.liquidityUsdHint || row.liquidityUsd,
      routePositive: row.routePositive,
      blocker: producer.blocker || safeArray(row.blockers)[0],
    });
  }
}

function collectAaveEulerSiloRoots(artifact, roots) {
  for (const producer of safeArray(artifact.producers)) {
    addMergedRoot(roots, {
      id: producer.id || `aes-producer:${producer.chain}:${producer.address || producer.symbol}`,
      source: "aave-euler-silo-consumer-graph",
      sourceArtifact: sourceRel(FILES.aaveEulerSiloGraph),
      chain: producer.chain,
      address: producer.address,
      symbol: producer.symbol,
      name: producer.name,
      category: producer.category,
      riskTags: producer.tags,
      currentAnomaly: producer.currentAnomaly,
      blocker: producer.blocker,
    });
  }
  for (const chainResult of safeArray(artifact.results)) {
    for (const match of safeArray(chainResult.topMatches)) {
      const producer = match.producer || {};
      addMergedRoot(roots, {
        id: producer.id || `aes-match:${chainResult.chain}:${producer.address || producer.symbol}`,
        source: "aave-euler-silo-consumer-graph",
        sourceArtifact: sourceRel(FILES.aaveEulerSiloGraph),
        chain: producer.chain || chainResult.chain,
        address: producer.address,
        symbol: producer.symbol,
        name: producer.name,
        category: producer.category,
        riskTags: producer.tags,
        currentAnomaly: producer.currentAnomaly,
        routePositive: match.routePositive,
        liquidityUsd: match.market?.cashUsd,
        blocker: producer.blocker || safeArray(match.blockers)[0],
      });
      const market = match.market || {};
    }
  }
}

function collectBridgeRoots(artifacts, roots) {
  const bridgeJoin = artifacts.bridgeLendingCollateralJoin || {};
  for (const row of safeArray(bridgeJoin.rows).concat(safeArray(bridgeJoin.topRows))) {
    addMergedRoot(roots, {
      id: row.id || `bridge-lending:${row.bridgeTokenChain}:${row.bridgeTokenAddress || row.bridgeTokenSymbol}`,
      source: "bridge-lending-collateral-join",
      sourceArtifact: sourceRel(FILES.bridgeLendingCollateralJoin),
      chain: row.bridgeTokenChain || row.consumerChain,
      address: row.bridgeTokenAddress,
      symbol: row.bridgeTokenSymbol,
      name: row.bridgeTokenName,
      category: row.bridgeCategory || "bridge-wrapper",
      riskTags: ["bridge-wrapper", row.bridgeCategory].filter(Boolean),
      liquidityUsd: row.bestLiquidityUsd,
      routePositive: row.routePositive,
      blocker: safeArray(row.blockers)[0] || "Bridge wrapper token accepted by one or more lending consumers; bridge proof/economics unresolved.",
    });
  }

  const bridgeNonlossless = artifacts.bridgeNonlosslessCollateralJoin || {};
  for (const signal of safeArray(bridgeNonlossless.bridgeSignals)) {
    addMergedRoot(roots, {
      id: signal.id || `bridge-signal:${signal.chain}:${signal.address || signal.symbol}`,
      source: "bridge-nonlossless-collateral-join",
      sourceArtifact: sourceRel(FILES.bridgeNonlosslessCollateralJoin),
      chain: signal.chain,
      address: signal.address || signal.token,
      symbol: signal.symbol,
      name: signal.name,
      category: signal.signalKind || "bridge-signal",
      riskTags: ["bridge-signal", signal.signalKind].filter(Boolean),
      hasProducerAnomaly: signal.hasProducerAnomaly,
      hasConcreteMismatch: signal.hasConcreteMismatch,
      liquidityUsd: signal.liquidityUsd,
      blocker: signal.blocker,
    });
  }
  for (const row of safeArray(bridgeNonlossless.topRows)) {
    addMergedRoot(roots, {
      id: row.id || `bridge-nonlossless-row:${row.chain}:${row.token || row.symbol}`,
      source: "bridge-nonlossless-collateral-join",
      sourceArtifact: sourceRel(FILES.bridgeNonlosslessCollateralJoin),
      chain: row.chain,
      address: row.token,
      symbol: row.symbol,
      category: row.signalKind || "bridge-signal",
      riskTags: ["bridge-wrapper", "bridge-signal", row.signalKind].filter(Boolean),
      hasProducerAnomaly: row.hasProducerAnomaly,
      hasConcreteMismatch: row.hasConcreteMismatch,
      materialConcreteMismatch: row.materialConcreteMismatch,
      routePositive: row.routePositive,
      exactEconomicsRows: row.exactEconomicsRows,
      forkProofRows: row.forkProofRows,
      liquidityUsd: row.liquidityUsd,
      blocker: row.blocker,
    });
  }

  const bridgeExposure = artifacts.bridgeCollateralExposure || {};
  for (const exposure of safeArray(bridgeExposure.exposures)) {
    addMergedRoot(roots, {
      id: `bridge-exposure:${exposure.token}`,
      source: "bridge-collateral-exposure",
      sourceArtifact: sourceRel(FILES.bridgeCollateralExposure),
      chain: "Ethereum",
      address: exposure.token,
      symbol: null,
      name: safeArray(exposure.protocols).join("+") || null,
      category: exposure.exposureLevel || "multi-protocol-exposure",
      riskTags: ["bridge-wrapper", "multi-protocol-exposure"],
      liquidityUsd: exposure.blastRadius,
      blocker: "Multi-protocol token exposure is context only; no backing/proof/economics edge is proven.",
    });
  }
}

function collectArtifacts(artifacts) {
  const markets = [];
  const roots = new Map();
  collectHighLtv(artifacts.consumerFirstHighLtv || {}, markets, roots);
  collectErc4626(artifacts.erc4626ConsumerJoiner || {}, markets, roots);
  collectPendleArtifact(artifacts.pendlePtConsumerGraph || {}, "pendle-pt-consumer-graph", FILES.pendlePtConsumerGraph, markets, roots);
  collectPendleArtifact(artifacts.pendlePtMultichainConsumerGraph || {}, "pendle-pt-multichain-consumer-graph", FILES.pendlePtMultichainConsumerGraph, markets, roots);
  collectAaveEulerSiloRoots(artifacts.aaveEulerSiloGraph || {}, roots);
  collectBridgeRoots(artifacts, roots);

  const uniqueMarkets = [];
  const seen = new Set();
  for (const market of markets) {
    const key = marketKey(market);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueMarkets.push(market);
  }

  return { markets: uniqueMarkets, roots: [...roots.values()] };
}

function buildRootIndex(roots) {
  const byAddress = new Map();
  const bySymbolChain = new Map();
  const bySymbol = new Map();
  function add(map, key, root) {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(root);
  }
  for (const root of roots) {
    add(byAddress, root.addressKey, root);
    add(bySymbolChain, `${root.chainKey || "any"}:${root.symbolKey}`, root);
    add(bySymbol, root.symbolKey, root);
  }
  return { byAddress, bySymbolChain, bySymbol };
}

function buildCollateralIndex(markets) {
  const byAddress = new Map();
  const bySymbolChain = new Map();
  const bySymbol = new Map();
  function add(map, key, market) {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(market);
  }
  for (const market of markets) {
    add(byAddress, market.collateral.addressKey, market);
    add(bySymbolChain, `${market.chainKey || "any"}:${market.collateral.symbolKey}`, market);
    add(bySymbol, market.collateral.symbolKey, market);
  }
  return { byAddress, bySymbolChain, bySymbol };
}

function findRootsForMarket(market, rootIndex) {
  const exact = market.collateral.addressKey ? safeArray(rootIndex.byAddress.get(market.collateral.addressKey)) : [];
  const exactCompatible = exact.filter((root) => compatibleChain(root.chain, market.chain));
  if (exactCompatible.length) return { roots: exactCompatible, matchKind: "address-exact" };
  const chainSym = market.collateral.symbolKey ? safeArray(rootIndex.bySymbolChain.get(`${market.chainKey || "any"}:${market.collateral.symbolKey}`)) : [];
  if (chainSym.length) return { roots: chainSym, matchKind: "chain-symbol" };
  const symbol = market.collateral.symbolKey ? safeArray(rootIndex.bySymbol.get(market.collateral.symbolKey)).filter((root) => compatibleChain(root.chain, market.chain)) : [];
  if (symbol.length) return { roots: symbol, matchKind: "symbol-compatible" };
  if (isRootishMarket(market)) {
    return {
      roots: [createRoot({
        id: `inferred:${market.id}`,
        source: market.source,
        sourceArtifact: market.sourceArtifact,
        chain: market.chain,
        address: market.collateral.address,
        symbol: market.collateral.symbol,
        category: safeArray(market.riskTags).join(", ") || "inferred-root-collateral",
        riskTags: market.riskTags,
        routePositive: market.routePositive,
        exactEconomicsRows: market.exactEconomicsRows,
        forkProofRows: market.forkProofRows,
        liquidityUsd: market.routeLiquidityUsd,
        blocker: safeArray(market.blockers)[0],
      })],
      matchKind: "inferred-from-market-risk",
    };
  }
  return { roots: [], matchKind: "none" };
}

function lookupSecondHopMarkets(index, token, chain) {
  const matches = [];
  const seen = new Set();
  function push(rows, kind) {
    for (const row of rows || []) {
      const key = `${kind}:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ market: row, matchKind: kind });
    }
  }
  if (token.addressKey) push(index.byAddress.get(token.addressKey), "borrow-address-as-collateral");
  if (token.symbolKey) push(index.bySymbolChain.get(`${chainKey(chain) || "any"}:${token.symbolKey}`), "borrow-symbol-same-chain-as-collateral");
  return matches;
}

function classifyRootAnomaly(roots, firstMarket) {
  const allRoots = safeArray(roots);
  const provenRows = allRoots.filter((root) => root.currentAnomaly || root.hasProducerAnomaly || root.hasConcreteMismatch || root.materialConcreteMismatch || root.routePositive || root.exactEconomicsRows > 0);
  const riskRows = allRoots.filter((root) => root.riskTags?.length || root.category || root.blocker);
  const marketRisk = isRootishMarket(firstMarket);
  return {
    proven: provenRows.length > 0 || firstMarket.routePositive || firstMarket.exactEconomicsRows > 0,
    riskOnly: provenRows.length === 0 && (riskRows.length > 0 || marketRisk),
    categories: uniq(allRoots.flatMap((root) => [root.category, ...safeArray(root.riskTags)].flatMap(splitListValue)).concat(firstMarket.riskTags)).slice(0, 12),
    blockers: uniq(allRoots.map((root) => root.blocker).concat(firstMarket.blockers)).slice(0, 5),
    exactEconomicsRows: allRoots.reduce((acc, root) => acc + (asNumber(root.exactEconomicsRows) || 0), 0) + (asNumber(firstMarket.exactEconomicsRows) || 0),
    forkProofRows: allRoots.reduce((acc, root) => acc + (asNumber(root.forkProofRows) || 0), 0) + (asNumber(firstMarket.forkProofRows) || 0),
  };
}

function classifyTerminalExit(token, secondMarket) {
  const symbolKey = token.symbolKey;
  const hint = EXIT_SYMBOLS.has(symbolKey) || Boolean(token.addressKey && /usdc|usdt|weth|wbtc|dai|eth|btc|usd/i.test(token.symbol || ""));
  const liquidityHint = asNumber(secondMarket.routeLiquidityUsd) || 0;
  return {
    token: { symbol: token.symbol || null, address: token.address || null },
    hint,
    exactQuote: false,
    liquidityHintUsd: round(liquidityHint, 2),
    reason: hint
      ? "Terminal borrowed asset is a canonical/stable/blue-chip exit hint, but no exact DEX/repay/unwind quote exists in this artifact-only pass."
      : "Terminal borrowed asset has no exact exit quote or canonical exit classification in this artifact-only pass.",
  };
}

function scoreCandidate({ firstMarket, secondMarket, roots, rootMatchKind, secondMatchKind, rootAnomaly, terminalExit }) {
  const crossProtocol = normKey(firstMarket.protocol) !== normKey(secondMarket.protocol);
  const sameChain = compatibleChain(firstMarket.chain, secondMarket.chain);
  const minHopLiquidityUsd = Math.min(firstMarket.routeLiquidityUsd || 0, secondMarket.routeLiquidityUsd || 0);
  const avgLtv = ((firstMarket.ltv || 0) + (secondMarket.ltv || 0)) / 2;
  let score = 24;
  score += crossProtocol ? 18 : 0;
  score += sameChain ? 12 : 0;
  score += rootAnomaly.proven ? 20 : rootAnomaly.riskOnly ? 8 : 0;
  score += terminalExit.hint ? 6 : 0;
  score += Math.min(12, avgLtv * 12);
  score += Math.min(16, Math.log10(Math.max(1, minHopLiquidityUsd)) * 3);
  score += rootMatchKind === "address-exact" ? 4 : rootMatchKind === "inferred-from-market-risk" ? 2 : 0;
  score += secondMatchKind === "borrow-address-as-collateral" ? 4 : 0;
  return Math.round(score);
}

function buildCandidateRows(markets, roots) {
  const rootIndex = buildRootIndex(roots);
  const collateralIndex = buildCollateralIndex(markets);
  const rows = [];
  const seen = new Set();

  for (const firstMarket of markets) {
    if (!isRootishMarket(firstMarket)) continue;
    const { roots: matchedRoots, matchKind: rootMatchKind } = findRootsForMarket(firstMarket, rootIndex);
    if (!matchedRoots.length) continue;
    const secondMatches = lookupSecondHopMarkets(collateralIndex, firstMarket.borrowAsset, firstMarket.chain)
      .filter(({ market }) => market.id !== firstMarket.id);
    for (const { market: secondMarket, matchKind: secondMatchKind } of secondMatches) {
      const crossProtocol = normKey(firstMarket.protocol) !== normKey(secondMarket.protocol);
      if (!crossProtocol) continue;
      const sameChain = strictSameChain(firstMarket.chain, secondMarket.chain);
      const minHopLiquidityUsd = Math.min(firstMarket.routeLiquidityUsd || 0, secondMarket.routeLiquidityUsd || 0);
      const rootAnomaly = classifyRootAnomaly(matchedRoots, firstMarket);
      const terminalExit = classifyTerminalExit(secondMarket.borrowAsset, secondMarket);
      const sourceExactEconomicsRows = (asNumber(firstMarket.exactEconomicsRows) || 0) + (asNumber(secondMarket.exactEconomicsRows) || 0) + rootAnomaly.exactEconomicsRows;
      const sourceForkProofRows = (asNumber(firstMarket.forkProofRows) || 0) + (asNumber(secondMarket.forkProofRows) || 0) + rootAnomaly.forkProofRows;
      const composedExactEconomicsRows = 0;
      const composedForkProofRows = 0;
      const routePositive = Boolean(
        crossProtocol && sameChain && minHopLiquidityUsd >= THRESHOLDS.minHopLiquidityUsd && rootAnomaly.proven && terminalExit.exactQuote && composedExactEconomicsRows > 0 && composedForkProofRows > 0
      );
      const watchCandidate = Boolean(crossProtocol && sameChain && minHopLiquidityUsd >= THRESHOLDS.minHopLiquidityUsd && (rootAnomaly.proven || rootAnomaly.riskOnly));
      const highSignal = Boolean(watchCandidate && minHopLiquidityUsd >= THRESHOLDS.highSignalLiquidityUsd && terminalExit.hint);
      const score = scoreCandidate({ firstMarket, secondMarket, roots: matchedRoots, rootMatchKind, secondMatchKind, rootAnomaly, terminalExit });
      const id = `${firstMarket.id}::${firstMarket.borrowAsset.addressKey || firstMarket.borrowAsset.symbolKey}::${secondMarket.id}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const blockers = [];
      if (!sameChain) blockers.push("Hop sequence crosses chains or has unresolved chain identity; atomicity is not proven.");
      if (!rootAnomaly.proven) blockers.push("Root producer anomaly/overvaluation is not proven; current evidence is risk-tag/context only.");
      if (minHopLiquidityUsd < THRESHOLDS.minHopLiquidityUsd) blockers.push("At least one lending hop is below the minimum liquidity threshold.");
      if (!terminalExit.exactQuote) blockers.push("Terminal borrowed-asset exit is a hint only; no exact DEX/repay/unwind quote exists.");
      if (composedExactEconomicsRows === 0) blockers.push("No exact composed multi-hop economics row with gas/slippage/fees is present.");
      if (composedForkProofRows === 0) blockers.push("No composed local/fork value-delta proof exists.");
      if (!routePositive) blockers.push("Fork/executor/signed-action gates remain fail-closed until routePositive > 0.");

      rows.push({
        id,
        protocol: `${firstMarket.protocol} -> ${secondMarket.protocol}`,
        symbol: firstMarket.collateral.symbol || matchedRoots[0]?.symbol || null,
        pair: `${tokenLabel(firstMarket.collateral)}→${tokenLabel(firstMarket.borrowAsset)}→${tokenLabel(secondMarket.borrowAsset)}`,
        collateralSymbol: firstMarket.collateral.symbol || null,
        borrowSymbol: secondMarket.borrowAsset.symbol || null,
        routeLiquidityUsd: round(minHopLiquidityUsd, 2),
        heuristicScore: score,
        edgeBps: null,
        score,
        chain: sameChain ? (firstMarket.chain || secondMarket.chain) : `${firstMarket.chain || "unknown"} -> ${secondMarket.chain || "unknown"}`,
        sameChain,
        crossProtocol,
        rootToken: {
          symbol: firstMarket.collateral.symbol || matchedRoots[0]?.symbol || null,
          address: firstMarket.collateral.address || matchedRoots[0]?.address || null,
          categories: rootAnomaly.categories.slice(0, 8),
          rootMatchKind,
          sourceArtifacts: uniq(matchedRoots.flatMap((root) => artifactList(root.sourceArtifact)).concat(artifactList(firstMarket.sourceArtifact))),
        },
        hop1: {
          protocol: firstMarket.protocol,
          source: firstMarket.source,
          chain: firstMarket.chain,
          marketId: firstMarket.marketId,
          oracle: firstMarket.oracle,
          collateral: { symbol: firstMarket.collateral.symbol, address: firstMarket.collateral.address },
          borrowAsset: { symbol: firstMarket.borrowAsset.symbol, address: firstMarket.borrowAsset.address },
          ltv: round(firstMarket.ltv, 4),
          liquidityUsd: round(firstMarket.routeLiquidityUsd, 2),
        },
        bridgeAsset: {
          symbol: firstMarket.borrowAsset.symbol,
          address: firstMarket.borrowAsset.address,
          matchKind: secondMatchKind,
        },
        hop2: {
          protocol: secondMarket.protocol,
          source: secondMarket.source,
          chain: secondMarket.chain,
          marketId: secondMarket.marketId,
          oracle: secondMarket.oracle,
          collateral: { symbol: secondMarket.collateral.symbol, address: secondMarket.collateral.address },
          borrowAsset: { symbol: secondMarket.borrowAsset.symbol, address: secondMarket.borrowAsset.address },
          ltv: round(secondMarket.ltv, 4),
          liquidityUsd: round(secondMarket.routeLiquidityUsd, 2),
        },
        terminalExit,
        minHopLiquidityUsd: round(minHopLiquidityUsd, 2),
        ltvProduct: round((firstMarket.ltv || 0) * (secondMarket.ltv || 0), 6),
        rootAnomaly,
        watchCandidate,
        highSignal,
        exactEconomicsRows: composedExactEconomicsRows,
        forkProofRows: composedForkProofRows,
        sourceExactEconomicsRows,
        sourceForkProofRows,
        routePositive,
        executableNow: false,
        signedActionJustified: false,
        blockers,
        sourceArtifacts: uniq([firstMarket.sourceArtifact, secondMarket.sourceArtifact].flatMap(artifactList).concat(matchedRoots.flatMap((root) => artifactList(root.sourceArtifact)))),
      });
    }
  }

  rows.sort((a, b) => (b.routePositive - a.routePositive) || (b.score - a.score) || ((b.minHopLiquidityUsd || 0) - (a.minHopLiquidityUsd || 0)));
  return rows.slice(0, THRESHOLDS.maxCandidateRows);
}

function summarizeMarkets(markets) {
  const byProtocol = {};
  const bySource = {};
  const byChain = {};
  for (const market of markets) {
    byProtocol[market.protocol] = (byProtocol[market.protocol] || 0) + 1;
    bySource[market.source] = (bySource[market.source] || 0) + 1;
    byChain[market.chain || "unknown"] = (byChain[market.chain || "unknown"] || 0) + 1;
  }
  return { byProtocol, bySource, byChain };
}

function writeMarkdown(artifact) {
  const topRows = artifact.topRows || [];
  const lines = [];
  lines.push("# 🟢 DORMANT — Cross-Protocol 3+ Hop Composition Scanner");
  lines.push("");
  lines.push(`Generated: ${artifact.generatedAt}`);
  lines.push(`Scanner: ${artifact.scanner}`);
  lines.push("");
  lines.push("## Scope");
  lines.push("");
  lines.push("Artifact-only Phase 1 scan for chains of the form `receipt/vault/bridge/PT token → lending market A collateral → borrow asset B → lending market C collateral → borrow asset D → exit`. No RPC endpoint inventory, env files, private keys, live calls, fork transactions, broadcasts, or signed actions were used.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  for (const [key, value] of Object.entries(artifact.summary)) {
    if (typeof value === "object") continue;
    lines.push(`| ${key} | ${value} |`);
  }
  lines.push("");
  lines.push(`**Route-positive gate**: \`routePositive=${artifact.summary.routePositive}\`, \`executableNow=${artifact.summary.executableNow}\`, \`signedActionJustified=${artifact.summary.signedActionJustified}\`.`);
  lines.push("");
  lines.push("## Top Candidate Chains");
  lines.push("");
  if (!topRows.length) {
    lines.push("No 3+ hop cross-protocol candidate chains were assembled from current artifacts.");
  } else {
    lines.push("| Rank | Root | Hop 1 | Bridge Asset | Hop 2 | Min Hop Liq | Score | Watch | Blocker |");
    lines.push("| ---: | --- | --- | --- | --- | ---: | ---: | --- | --- |");
    topRows.slice(0, 15).forEach((row, idx) => {
      const root = `${tokenLabel(row.rootToken)}${row.chain ? ` (${row.chain})` : ""}`;
      const hop1 = `${row.hop1.protocol}: ${tokenLabel(row.hop1.collateral)}→${tokenLabel(row.hop1.borrowAsset)}`;
      const hop2 = `${row.hop2.protocol}: ${tokenLabel(row.hop2.collateral)}→${tokenLabel(row.hop2.borrowAsset)}`;
      const blocker = safeArray(row.blockers)[0] || "none";
      lines.push(`| ${idx + 1} | ${root} | ${hop1} | ${tokenLabel(row.bridgeAsset)} | ${hop2} | $${(row.minHopLiquidityUsd || 0).toLocaleString()} | ${row.score} | ${row.watchCandidate ? "YES" : "no"} | ${blocker} |`);
    });
  }
  lines.push("");
  lines.push("## Gate Analysis");
  lines.push("");
  lines.push("All assembled rows are watch/context only. The scanner requires all of the following before escalation: a multi-hop same-chain cross-protocol chain, material hop liquidity, a proven root producer anomaly/overvaluation, exact terminal exit quote, exact positive economics after gas/slippage/fees/caps, and local/fork value-delta proof.");
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  for (const blocker of artifact.blockers) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push("## Required For Route Positive");
  lines.push("");
  for (const req of artifact.requiredForRoutePositive) lines.push(`- ${req}`);
  lines.push("");
  lines.push("## Source Artifacts");
  lines.push("");
  for (const source of Object.values(artifact.inputs)) lines.push(`- \`${source}\``);
  lines.push("");
  ensureDir(OUT_MD);
  fs.writeFileSync(OUT_MD, `${lines.join("\n")}\n`);
}

function main() {
  const artifacts = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, loadJson(file, {})]));
  const { markets, roots } = collectArtifacts(artifacts);
  const candidateRows = buildCandidateRows(markets, roots);
  const topRows = candidateRows.slice(0, THRESHOLDS.topRows);
  const watchCandidates = candidateRows.filter((row) => row.watchCandidate);
  const highSignal = candidateRows.filter((row) => row.highSignal);
  const routePositive = candidateRows.reduce((acc, row) => acc + (row.routePositive ? 1 : 0), 0);
  const exactEconomicsRows = candidateRows.reduce((acc, row) => acc + (asNumber(row.exactEconomicsRows) || 0), 0);
  const forkProofRows = candidateRows.reduce((acc, row) => acc + (asNumber(row.forkProofRows) || 0), 0);
  const marketSummary = summarizeMarkets(markets);

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-cross-protocol-composition.js",
    scope: "Artifact-only scanner for 3+ hop receipt/vault/bridge/PT token -> lending -> lending -> exit composition chains.",
    safety: {
      artifactOnly: true,
      rpcInventoryRead: false,
      graphqlInventoryRead: false,
      rpcUrlsStored: false,
      rawUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      keyMaterialRead: false,
      signedActions: false,
      liveTransactions: false,
      broadcasts: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routePositive > 0,
      executableNow: false,
      signedActionJustified: false,
    },
    inputs: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, sourceRel(file)])),
    thresholds: THRESHOLDS,
    summary: {
      rootProducerTokens: roots.length,
      lendingMarkets: markets.length,
      candidateChains: candidateRows.length,
      threePlusHopChains: candidateRows.length,
      crossProtocolChains: candidateRows.filter((row) => row.crossProtocol).length,
      sameChainChains: candidateRows.filter((row) => row.sameChain).length,
      watchCandidates: watchCandidates.length,
      highSignalChains: highSignal.length,
      rootRiskOnlyChains: candidateRows.filter((row) => row.rootAnomaly?.riskOnly).length,
      provenRootAnomalyChains: candidateRows.filter((row) => row.rootAnomaly?.proven).length,
      terminalExitHintChains: candidateRows.filter((row) => row.terminalExit?.hint).length,
      exactEconomicsRows,
      forkProofRows,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      topRootToken: topRows[0]?.rootToken?.symbol || short(topRows[0]?.rootToken?.address) || null,
      topBridgeAsset: topRows[0]?.bridgeAsset?.symbol || short(topRows[0]?.bridgeAsset?.address) || null,
      topTerminalAsset: topRows[0]?.hop2?.borrowAsset?.symbol || short(topRows[0]?.hop2?.borrowAsset?.address) || null,
      topScore: topRows[0]?.score || 0,
      topMinHopLiquidityUsd: round(topRows[0]?.minHopLiquidityUsd, 2) || 0,
      status: routePositive > 0 ? "cross-protocol-composition-route-positive-needs-fork" : "cross-protocol-composition-artifact-only-no-route-positive",
    },
    marketCoverage: marketSummary,
    rows: candidateRows,
    topRows,
    watchCandidates: watchCandidates.slice(0, 40),
    highSignalRows: highSignal.slice(0, 20),
    blockers: [
      "No candidate has a proven root producer anomaly/overvaluation joined to exact positive multi-hop economics.",
      "Terminal exits are token-class hints only; no exact DEX/repay/unwind quote is present in this artifact-only pass.",
      "No candidate has local/fork value-delta proof.",
      "Cross-protocol composition rows are research leads only until gas/slippage/fees/caps/queues and atomicity are modeled.",
      "Fork/executor/signed-action paths remain blocked while routePositive=0.",
    ],
    requiredForRoutePositive: [
      "same-chain or otherwise atomically executable multi-hop chain across at least two distinct protocols",
      "material hop liquidity/capacity on every lending leg",
      "proven root producer anomaly, accepted-value overvaluation, bridge/accounting mismatch, or permissionless manipulation trigger",
      "terminal borrowed-asset exit route exact-quoted after gas, slippage, fees, caps, and unwind costs",
      "exact positive economics plus local/fork value-delta proof before any executor or signed action",
    ],
    nextReadOnlyStep: highSignal.length > 0
      ? "For the highest-signal watch rows, gather producer-specific anomaly evidence and exact terminal-exit quotes; do not fork until exact-positive economics exist."
      : "Keep composition scanner artifact-only; refresh after collateral/consumer artifacts update or when a root producer anomaly artifact appears.",
  };

  ensureDir(OUT);
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  writeMarkdown(artifact);

  if (!QUIET) {
    console.log(JSON.stringify({ ok: true, output: sourceRel(OUT), report: sourceRel(OUT_MD), summary: artifact.summary }, null, 2));
  }
}

main();
