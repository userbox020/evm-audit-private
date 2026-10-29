#!/usr/bin/env node
// scan-bridge-lending-collateral-join.js — read-only bridge wrapper token -> lending collateral/asset consumer join.
// Consumes existing sanitized artifacts only. It does not read RPC inventory, env files, or keys,
// and does not send transactions or build executors.
//
// Novelty-groundbreaking bug class #9: "bridge wrapper used as collateral"

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "bridge-lending-collateral-join.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "bridge-lending-collateral-join-triage.md");
const QUIET = process.argv.includes("--quiet");

const FILES = {
  hyperlaneWarpRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "hyperlane-warp-routes.json"),
  layerzeroOftDvnConsumerJoins: path.join(WORKSPACE, "reports", "raw", "fast", "layerzero-oft-dvn-consumer-joins.json"),
  usdt0OftRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "usdt0-oft-routes.json"),
  bridgeNonlosslessCollateralJoin: path.join(WORKSPACE, "reports", "raw", "fast", "bridge-nonlossless-collateral-join.json"),
  bridgeCollateralExposure: path.join(WORKSPACE, "reports", "raw", "fast", "bridge-collateral-exposure.json"),
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

function short(value) {
  const text = String(value || "");
  if (text.length <= 16) return text;
  return `${text.slice(0, 10)}...${text.slice(-6)}`;
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
    bsc: "bsc",
    polygonpos: "polygon",
    polygon: "polygon",
    bera: "berachain",
    berachain: "berachain",
    base: "base",
    avalanche: "avalanche",
    linea: "linea",
    unichain: "unichain",
    sonic: "sonic",
    worldchain: "worldchain",
    ink: "ink",
    hyperliquid: "hyperliquid",
    mode: "mode",
  };
  return aliases[text] || text || null;
}

function compatibleChain(a, b) {
  const ak = chainKey(a);
  const bk = chainKey(b);
  if (!ak || !bk || ak === "multi-chain" || bk === "multi-chain") return true;
  return ak === bk;
}

function sourceRel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function bridgeToken({ id, bridge, chain, address, symbol, name, category, sourceArtifact }) {
  const addr = normAddress(address);
  return {
    id,
    bridge: bridge || "Unknown Bridge",
    chain: chain || null,
    chainKey: chainKey(chain),
    address: address || null,
    addressKey: addr,
    symbol: symbol || null,
    symbolKey: normKey(symbol),
    name: name || null,
    category: category || "wrapper",
    sourceArtifact,
  };
}

function collectBridgeTokens(artifacts) {
  const tokens = [];

  const hyperlane = artifacts.hyperlaneWarpRoutes || {};
  for (const route of hyperlane.topRoutes || []) {
    for (const token of route.topTokens || []) {
      const addresses = [
        { role: "wrapped", addr: token.addressOrDenom },
        { role: "collateral-lockbox", addr: token.collateralAddressOrDenom },
      ];
      for (const { role, addr } of addresses) {
        const addressKey = normAddress(addr);
        if (!addressKey) continue;
        const cat = role === "collateral-lockbox" ? "collateral-lockbox" 
          : /rebase/i.test(token.riskClass || "") ? "rebase-wrapper" 
          : /value-bearing/i.test(token.riskClass || "") ? "value-bearing-wrapper"
          : "wrapper";
        tokens.push(bridgeToken({
          id: `hyperlane:${route.routeId}:${token.chainName}:${role}:${addressKey}`,
          bridge: "Hyperlane Warp",
          chain: token.chainName,
          address: addr,
          symbol: token.symbol || route.symbol,
          name: token.name || null,
          category: cat,
          sourceArtifact: sourceRel(FILES.hyperlaneWarpRoutes),
        }));
      }
    }
  }

  const layerzero = artifacts.layerzeroOftDvnConsumerJoins || {};
  for (const producer of layerzero.oftProducers || []) {
    const addressKey = normAddress(producer.address);
    if (!addressKey) continue;
    tokens.push(bridgeToken({
      id: `layerzero:${producer.id || addressKey}`,
      bridge: "LayerZero/OFT",
      chain: producer.chain,
      address: producer.address,
      symbol: producer.symbol,
      name: producer.name || null,
      category: producer.category || "oft-token",
      sourceArtifact: sourceRel(FILES.layerzeroOftDvnConsumerJoins),
    }));
  }

  const usdt0 = artifacts.usdt0OftRoutes || {};
  for (const scan of usdt0.scans || []) {
    for (const addrField of [scan.token, scan.escrowToken, scan.oapp]) {
      const addr = addrField?.address;
      const addressKey = normAddress(addr);
      if (!addressKey) continue;
      tokens.push(bridgeToken({
        id: `usdt0:${scan.docs?.chainId || scan.docs?.name || addressKey}:${addressKey}`,
        bridge: "USDT0/OFT",
        chain: scan.docs?.name || null,
        address: addr,
        symbol: addrField?.symbol || scan.docs?.name,
        name: addrField?.name || null,
        category: addrField === scan.token ? "oft-source-token" : "oft-escrow-token",
        sourceArtifact: sourceRel(FILES.usdt0OftRoutes),
      }));
    }
  }

  const bridgeJoin = artifacts.bridgeNonlosslessCollateralJoin || {};
  for (const signal of bridgeJoin.bridgeSignals || []) {
    const addressKey = signal.addressKey || normAddress(signal.address);
    if (!addressKey) continue;
    tokens.push(bridgeToken({
      id: `bridge-nonlossless:${signal.id || addressKey}`,
      bridge: signal.bridge || "Bridge",
      chain: signal.chain,
      address: signal.address || addressKey,
      symbol: signal.symbol,
      name: signal.name || null,
      category: signal.signalKind || "bridge-signal",
      sourceArtifact: sourceRel(FILES.bridgeNonlosslessCollateralJoin),
    }));
  }

  const bridgeExposure = artifacts.bridgeCollateralExposure || {};
  for (const exposure of bridgeExposure.exposures || []) {
    const addressKey = normAddress(exposure.token);
    if (!addressKey) continue;
    tokens.push(bridgeToken({
      id: `bridge-exposure:${addressKey}`,
      bridge: "Bridge (collateral exposure)",
      chain: "Ethereum",
      address: exposure.token,
      symbol: null,
      name: (exposure.protocols || []).join("+") || null,
      category: "collateral-exposure",
      sourceArtifact: sourceRel(FILES.bridgeCollateralExposure),
    }));
  }

  const seen = new Set();
  return tokens.filter((t) => {
    const key = `${t.bridge}:${t.chainKey}:${t.addressKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectLendingConsumers(artifacts) {
  const consumers = [];

  const highLtv = artifacts.consumerFirstHighLtv || {};
  for (const chainResult of highLtv.results || []) {
    for (const row of chainResult.highLtvRowsDetail || []) {
      const collateralAddr = row.collateral?.address;
      const borrowAddr = row.borrowAsset?.address;
      if (collateralAddr) {
        consumers.push({
          source: "consumer-first-high-ltv-collateral",
          protocol: row.protocol,
          chain: row.chain || chainResult.chain,
          role: "collateral",
          address: collateralAddr,
          addressKey: normAddress(collateralAddr),
          ltv: asNumber(row.ltv),
          routeLiquidityUsd: asNumber(row.routeLiquidityUsd),
          raw: row,
        });
      }
      if (borrowAddr && borrowAddr !== collateralAddr) {
        consumers.push({
          source: "consumer-first-high-ltv-collateral",
          protocol: row.protocol,
          chain: row.chain || chainResult.chain,
          role: "borrowAsset",
          address: borrowAddr,
          addressKey: normAddress(borrowAddr),
          ltv: asNumber(row.ltv),
          routeLiquidityUsd: asNumber(row.routeLiquidityUsd),
          raw: row,
        });
      }
    }
  }

  const aaveGraph = artifacts.aaveEulerSiloGraph || {};
  for (const chainResult of aaveGraph.results || []) {
    for (const match of chainResult.topMatches || []) {
      const producerAddr = match.producer?.address;
      const marketReserve = match.market?.reserve;
      const addresses = [];
      if (producerAddr) addresses.push({ role: match.side || "producer", addr: producerAddr });
      if (marketReserve && marketReserve !== producerAddr) addresses.push({ role: "reserve", addr: marketReserve });
      for (const { role, addr } of addresses) {
        const addressKey = normAddress(addr);
        if (!addressKey) continue;
        consumers.push({
          source: "aave-euler-silo-consumer-graph",
          protocol: match.protocol || match.market?.protocol,
          chain: chainResult.chain,
          role,
          address: addr,
          addressKey,
          ltv: asNumber(match.market?.ltv),
          routeLiquidityUsd: asNumber(match.market?.cashUsd),
          raw: match,
        });
      }
    }
  }

  const erc4626 = artifacts.erc4626ConsumerJoiner || {};
  for (const chainResult of erc4626.results || []) {
    for (const candidate of chainResult.topCandidates || []) {
      const vaultAddr = candidate.vault?.address;
      if (vaultAddr) {
        consumers.push({
          source: "erc4626-consumer-joiner",
          protocol: candidate.type || "ERC4626 consumer",
          chain: chainResult.chain,
          role: candidate.side || "vault",
          address: vaultAddr,
          addressKey: normAddress(vaultAddr),
          ltv: asNumber(candidate.market?.lltvPct) ? asNumber(candidate.market?.lltvPct) / 100 : null,
          routeLiquidityUsd: asNumber(candidate.market?.liquidityAssetsUsd),
          raw: candidate,
        });
      }
      const marketCollateral = candidate.market?.collateralAsset?.address;
      if (marketCollateral && normAddress(marketCollateral) !== normAddress(vaultAddr)) {
        consumers.push({
          source: "erc4626-consumer-joiner",
          protocol: candidate.type || "ERC4626 consumer",
          chain: chainResult.chain,
          role: "collateralAsset",
          address: marketCollateral,
          addressKey: normAddress(marketCollateral),
          ltv: asNumber(candidate.market?.lltvPct) ? asNumber(candidate.market?.lltvPct) / 100 : null,
          routeLiquidityUsd: asNumber(candidate.market?.liquidityAssetsUsd),
          raw: candidate,
        });
      }
    }
  }

  return consumers.filter((c) => c.addressKey);
}

function joinBridgeToLending(bridgeTokens, lendingConsumers) {
  const byAddress = new Map();
  for (const consumer of lendingConsumers) {
    if (!byAddress.has(consumer.addressKey)) byAddress.set(consumer.addressKey, []);
    byAddress.get(consumer.addressKey).push(consumer);
  }

  const rows = [];
  for (const token of bridgeTokens) {
    const matches = (byAddress.get(token.addressKey) || [])
      .filter((c) => compatibleChain(token.chain, c.chain));

    if (!matches.length) continue;

    const collateralMatches = matches.filter((c) => c.role === "collateral" || c.role === "collateralAsset" || c.role === "collateralToken");
    const borrowMatches = matches.filter((c) => c.role === "borrowAsset" || c.role === "reserve" || c.role === "reserveAsset" || c.role === "loanAsset");

    const bestConsumer = matches.reduce((best, cur) => {
      const curLiquidity = cur.routeLiquidityUsd || 0;
      const bestLiquidity = best?.routeLiquidityUsd || 0;
      return curLiquidity > bestLiquidity ? cur : best;
    }, null);

    const hasCollateralMatch = collateralMatches.length > 0;
    const hasBorrowMatch = borrowMatches.length > 0;
    const bestLtv = Math.max(0, ...matches.map((c) => c.ltv || 0));
    const bestLiquidityUsd = Math.max(0, ...matches.map((c) => c.routeLiquidityUsd || 0));

    const priorityScore = Math.round(
      (hasCollateralMatch ? 50 : 0) +
      (hasBorrowMatch ? 30 : 0) +
      Math.min(30, bestLtv * 30) +
      Math.min(25, (bestLiquidityUsd / 1e6) * 4)
    );

    const watchCandidate = hasCollateralMatch && bestLtv >= 0.70 && bestLiquidityUsd >= 10000;

    rows.push({
      id: `${token.id}::${bestConsumer?.protocol || "unknown"}:${bestConsumer?.chain || token.chain}`,
      bridge: token.bridge,
      bridgeTokenChain: token.chain,
      bridgeTokenSymbol: token.symbol,
      bridgeTokenName: token.name,
      bridgeTokenAddress: token.address,
      bridgeTokenKey: token.addressKey,
      bridgeCategory: token.category,
      consumerProtocol: bestConsumer?.protocol || null,
      consumerChain: bestConsumer?.chain || null,
      consumerRole: bestConsumer?.role || null,
      consumerSource: bestConsumer?.source || null,
      priorityScore,
      hasCollateralMatch,
      hasBorrowMatch,
      collateralMatchCount: collateralMatches.length,
      borrowMatchCount: borrowMatches.length,
      totalMatchCount: matches.length,
      bestLtv: round(bestLtv, 4),
      bestLiquidityUsd: round(bestLiquidityUsd, 2),
      watchCandidate,
      allMatches: matches.map((c) => ({
        protocol: c.protocol,
        chain: c.chain,
        role: c.role,
        address: c.address,
        ltv: round(c.ltv, 4),
        routeLiquidityUsd: round(c.routeLiquidityUsd, 2),
      })),
      sourceArtifacts: [...new Set([
        token.sourceArtifact,
        sourceRel(FILES.consumerFirstHighLtv),
        sourceRel(FILES.aaveEulerSiloGraph),
        sourceRel(FILES.erc4626ConsumerJoiner),
      ].filter(Boolean))],
    });
  }

  rows.sort((a, b) => b.priorityScore - a.priorityScore);
  return rows;
}

function renderReport(artifact) {
  const topRows = artifact.topRows.slice(0, 12);
  const table = [
    "| Bridge Token | Bridge | Consumer Protocol | Role | LTV | Liquidity | Score | Watch |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...topRows.map((row) =>
      `| ${row.bridgeTokenSymbol || short(row.bridgeTokenAddress)} (${row.bridgeTokenChain || ""}) | ${row.bridge || ""} | ${row.consumerProtocol || ""} (${row.consumerChain || ""}) | ${row.consumerRole || ""} | ${row.bestLtv != null ? row.bestLtv : ""} | ${row.bestLiquidityUsd != null ? `$${row.bestLiquidityUsd}` : ""} | ${row.priorityScore} | ${row.watchCandidate ? "YES" : "no"} |`
    ),
  ].join("\n");

  return [
    "# \uD83D\uDFE2 DORMANT - Bridge Lending Collateral Join",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Collected ${artifact.summary.bridgeTokens} bridge wrapper token addresses from Hyperlane, LayerZero/OFT, USDT0, bridge non-lossless join, and bridge collateral exposure artifacts. Joined against ${artifact.summary.lendingConsumers} lending consumer entries from high-LTV collateral scan, Aave/Euler/Silo consumer graph, and ERC4626 consumer joiner. Found ${artifact.summary.joinedRows} matched pairs, ${artifact.summary.watchCandidates} watch candidates.`,
    "",
    `**Route-positive gate**: \`routePositive=${artifact.summary.routePositive}\`, \`executableNow=${artifact.summary.executableNow}\`, \`signedActionJustified=${artifact.summary.signedActionJustified}\`.`,
    "",
    "All rows are research leads only. A bridge wrapper token accepted as lending collateral is a necessary but not sufficient condition for an exploitable route. The bridge security model, on-chain balance-delta proof, exact borrow/exit economics, and fork extraction proof remain outstanding blockers.",
    "",
    "## Top Joined Rows",
    "",
    table,
    "",
    "## Route-Positive Gate",
    "",
    "Do not fork until a row has: deployed bridge wrapper token accepted as collateral, bridge-side security model weakness or balance-delta mismatch, permissionless borrow/redeem/liquidation path, exact positive economics after gas/slippage/fees, and fork/local extraction proof.",
    "",
    "## Blockers",
    "",
    ...(artifact.blockers || []).map((b) => `- ${b}`),
    "",
    "## Artifacts",
    "",
    `- JSON: \`${sourceRel(RAW_OUT)}\``,
    `- Scanner: \`tools/scan-bridge-lending-collateral-join.js\``,
    `- Inputs: \`reports/raw/fast/hyperlane-warp-routes.json\`, \`reports/raw/fast/layerzero-oft-dvn-consumer-joins.json\`, \`reports/raw/fast/usdt0-oft-routes.json\`, \`reports/raw/fast/bridge-nonlossless-collateral-join.json\`, \`reports/raw/fast/bridge-collateral-exposure.json\`, \`reports/raw/fast/consumer-first-high-ltv-collateral.json\`, \`reports/raw/fast/aave-euler-silo-consumer-graph.json\`, \`reports/raw/fast/erc4626-consumer-joiner.json\``,
    "",
  ].join("\n");
}

function main() {
  const artifacts = Object.fromEntries(
    Object.entries(FILES).map(([key, file]) => [key, readJson(file, {})])
  );

  const bridgeTokens = collectBridgeTokens(artifacts);
  const lendingConsumers = collectLendingConsumers(artifacts);
  const joinedRows = joinBridgeToLending(bridgeTokens, lendingConsumers);
  const watchCandidates = joinedRows.filter((r) => r.watchCandidate);

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-bridge-lending-collateral-join.js",
    scope: "Read-only bridge wrapper token to lending collateral/asset consumer join (novelty bug class #9)",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    inputs: Object.fromEntries(
      Object.entries(FILES).map(([key, file]) => [key, sourceRel(file)])
    ),
    summary: {
      bridgeTokens: bridgeTokens.length,
      bridgeTokensBySource: {
        hyperlane: bridgeTokens.filter((t) => t.bridge === "Hyperlane Warp").length,
        layerzero: bridgeTokens.filter((t) => t.bridge === "LayerZero/OFT").length,
        usdt0: bridgeTokens.filter((t) => t.bridge === "USDT0/OFT").length,
        bridgeJoin: bridgeTokens.filter((t) => t.bridge !== "Hyperlane Warp" && t.bridge !== "LayerZero/OFT" && t.bridge !== "USDT0/OFT" && t.bridge !== "Bridge (collateral exposure)").length,
        bridgeExposure: bridgeTokens.filter((t) => t.bridge === "Bridge (collateral exposure)").length,
      },
      lendingConsumers: lendingConsumers.length,
      lendingConsumersBySource: {
        consumerFirstHighLtv: lendingConsumers.filter((c) => c.source === "consumer-first-high-ltv-collateral").length,
        aaveEulerSiloGraph: lendingConsumers.filter((c) => c.source === "aave-euler-silo-consumer-graph").length,
        erc4626Joiner: lendingConsumers.filter((c) => c.source === "erc4626-consumer-joiner").length,
      },
      joinedRows: joinedRows.length,
      watchCandidates: watchCandidates.length,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      topBridgeToken: joinedRows[0]?.bridgeTokenSymbol || null,
      topBridge: joinedRows[0]?.bridge || null,
      topConsumer: joinedRows[0]?.consumerProtocol || null,
      topScore: joinedRows[0]?.priorityScore || 0,
      topLiquidityUsd: round(joinedRows[0]?.bestLiquidityUsd, 2),
    },
    topRows: joinedRows.slice(0, 60),
    rows: joinedRows,
    watchCandidates: watchCandidates.slice(0, 30),
    blockers: [
      "Bridge wrapper token — route depends on bridge security model",
      "No bridge manipulation proof",
      "No lending accepted-value edge",
      "No fork extraction proof",
    ],
    requiredForRoutePositive: [
      "bridge wrapper token is accepted as collateral by a material lending consumer",
      "bridge security model weakness or balance-delta mismatch is proven",
      "consumer state permits permissionless borrow, redeem, or liquidation",
      "exact acquisition and exit economics are positive after gas/slippage/fees",
      "fork/local proof demonstrates extractable net profit",
    ],
    nextRoutePositiveCriteria: "Prove bridge security weakness or balance-delta mismatch for top watch candidate rows, then model exact borrow/exit economics before fork.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, JSON.stringify(artifact, null, 2) + "\n");
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));

  if (!QUIET) {
    console.log("Bridge lending collateral join scan");
    console.log(`bridgeTokens=${artifact.summary.bridgeTokens} lendingConsumers=${artifact.summary.lendingConsumers} joined=${artifact.summary.joinedRows} watchCandidates=${artifact.summary.watchCandidates}`);
    console.log(`routePositive=${artifact.summary.routePositive} executableNow=${artifact.summary.executableNow} signedActionJustified=${artifact.summary.signedActionJustified}`);
    console.log(`Report: ${sourceRel(REPORT_OUT)}`);
  }
}

main();

// SWEEP_CANDIDATE: { key: "bridgeLendingCollateralJoin", id: "bridge-lending-collateral-join-sweep", protocol: "Bridge+Lending", chain: "multi-chain artifact", surface: "Bridge wrapper token as lending collateral consumer join", baseScore: 38, watchFields: ["watchCandidates"], researchFields: ["bridgeTokens", "lendingMatches"], closedStatus: "bridge-lending-join-no-route-positive", watchStatus: "bridge-lending-join-watch-needs-bridge-proof-and-economics", sourceArtifacts: ["reports/raw/fast/bridge-lending-collateral-join.json"], blockers: ["Bridge wrapper token — route depends on bridge security model", "No bridge manipulation proof", "No lending accepted-value edge", "No fork extraction proof"], requiredForRoutePositive: ["bridge wrapper token accepted as collateral by material lending consumer", "bridge security model weakness or balance-delta mismatch proven", "consumer state permits permissionless value extraction", "exact acquisition and exit economics positive after gas/slippage/fees", "fork/local extraction proof"], nextReadOnlyStep: "Prove bridge security weakness or balance-delta mismatch for top watch candidate rows; only then model exact borrow/exit economics and fork." }
