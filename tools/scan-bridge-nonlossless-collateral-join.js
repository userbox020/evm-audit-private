#!/usr/bin/env node
// scan-bridge-nonlossless-collateral-join.js - read-only bridge accounting residual -> lending consumer join.
// Consumes existing sanitized artifacts only. It does not read RPC inventory, env files, or keys,
// and does not send transactions or build executors.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "bridge-nonlossless-collateral-join.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "bridge-nonlossless-collateral-join-triage.md");
const QUIET = process.argv.includes("--quiet");

const FILES = {
  bridgeNonlossless: path.join(WORKSPACE, "reports", "raw", "fast", "bridge-nonlossless-routes.json"),
  bridgeCollateralExposure: path.join(WORKSPACE, "reports", "raw", "fast", "bridge-collateral-exposure.json"),
  hyperlaneWarpRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "hyperlane-warp-routes.json"),
  wormholeToken2022: path.join(WORKSPACE, "reports", "raw", "fast", "wormhole-token2022-fee-wrappers.json"),
  usdt0ConsumerRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "usdt0-consumer-routes.json"),
  solanaReceiptGraph: path.join(WORKSPACE, "reports", "raw", "fast", "solana-receipt-token-consumer-graph.json"),
  aaveEulerSiloGraph: path.join(WORKSPACE, "reports", "raw", "fast", "aave-euler-silo-consumer-graph.json"),
  lrtOracleDriftRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "lrt-oracle-drift-routes.json"),
  xstocksConsumerRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "xstocks-consumer-routes.json"),
};

const MIN_MATERIAL_USD = Number(process.env.BRIDGE_NONLOSSLESS_JOIN_MIN_USD || "10000");

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
  };
  return aliases[text] || text || null;
}

function compatibleChain(a, b) {
  const ak = chainKey(a);
  const bk = chainKey(b);
  if (!ak || !bk || ak === "multi-chain" || bk === "multi-chain") return true;
  return ak === bk;
}

function pushIndex(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function collectArraysByKey(obj, key, out = []) {
  if (!obj || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (const item of obj) collectArraysByKey(item, key, out);
    return out;
  }
  for (const [k, value] of Object.entries(obj)) {
    if (k === key && Array.isArray(value)) out.push(value);
    else if (value && typeof value === "object") collectArraysByKey(value, key, out);
  }
  return out;
}

function sourceRel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function bridgeSignal({ id, bridge, chain, routeId, symbol, name, address, mint, signalKind, signalStrength, hasProducerAnomaly, hasConcreteMismatch, blocker, sourceArtifacts }) {
  const addressKey = normAddress(address);
  const mintKey = mint ? String(mint) : null;
  return {
    id,
    bridge,
    chain: chain || null,
    routeId: routeId || null,
    symbol: symbol || null,
    name: name || null,
    address: address || null,
    addressKey,
    mint: mint || null,
    mintKey,
    symbolKey: normKey(symbol),
    signalKind,
    signalStrength: signalStrength || 0,
    hasProducerAnomaly: Boolean(hasProducerAnomaly),
    hasConcreteMismatch: Boolean(hasConcreteMismatch),
    blocker,
    sourceArtifacts: sourceArtifacts || [],
  };
}

function collectBridgeSignals(artifacts) {
  const signals = [];
  const bridgeNonlossless = artifacts.bridgeNonlossless || {};
  const wormhole = artifacts.wormholeToken2022 || {};
  const hyperlane = artifacts.hyperlaneWarpRoutes || {};

  for (const mint of wormhole.feeMints || []) {
    const activeFeeBps = asNumber(mint.activeFeeBps) || 0;
    signals.push(bridgeSignal({
      id: `wormhole-token2022:${mint.mint}`,
      bridge: "Wormhole Portal",
      chain: "Solana",
      symbol: mint.symbol || mint.mint,
      name: "Token-2022 transfer-fee custody mint",
      mint: mint.mint,
      signalKind: "token2022-transfer-fee-custody",
      signalStrength: activeFeeBps >= 100 ? 72 : 60,
      hasProducerAnomaly: activeFeeBps > 0,
      hasConcreteMismatch: (asNumber(wormhole.summary?.nonzeroWrappers) || 0) > 0,
      blocker: (asNumber(wormhole.summary?.nonzeroWrappers) || 0) > 0
        ? "Active transfer-fee mint has a wrapper; exact bridge balance-delta proof still required."
        : "Active transfer-fee custody mint has no known priority EVM wrapper or material destination route in current artifact.",
      sourceArtifacts: [sourceRel(FILES.wormholeToken2022), sourceRel(FILES.bridgeNonlossless)],
    }));
  }

  for (const route of hyperlane.topRoutes || []) {
    for (const token of route.topTokens || []) {
      const riskClass = token.riskClass || "";
      if (!/(value-bearing|rebase|non-lossless|fee|share)/i.test(riskClass) && !/(value-bearing|rebase|vault|share|staked|restaked)/i.test(`${token.symbol || ""} ${token.name || ""}`)) continue;
      const legs = [
        { role: "wrapped-or-synthetic-leg", address: normAddress(token.addressOrDenom) },
        { role: "collateral-lockbox-leg", address: normAddress(token.collateralAddressOrDenom) },
      ].filter((leg, index, all) => leg.address && all.findIndex((other) => other.address === leg.address) === index);
      for (const leg of legs) {
        signals.push(bridgeSignal({
          id: `hyperlane:${route.routeId}:${token.chainName}:${leg.role}:${leg.address}`,
          bridge: "Hyperlane Warp",
          chain: token.chainName,
          routeId: route.routeId,
          symbol: token.symbol || route.symbol,
          name: token.name || null,
          address: leg.address,
          signalKind: `${riskClass || "value-bearing-review"}:${leg.role}`,
          signalStrength: /rebase/i.test(riskClass) ? 70 : leg.role === "collateral-lockbox-leg" ? 52 : 58,
          hasProducerAnomaly: /rebase/i.test(riskClass),
          hasConcreteMismatch: false,
          blocker: route.blocker || "Value-bearing bridge route needs transfer-delta or share/rate mismatch proof.",
          sourceArtifacts: [sourceRel(FILES.hyperlaneWarpRoutes), sourceRel(FILES.bridgeNonlossless)],
        }));
      }
    }
  }

  for (const candidate of bridgeNonlossless.candidates || []) {
    const managers = candidate.evidence?.managers || [];
    for (const manager of managers) {
      if (!manager.tokenAddress && !manager.symbol) continue;
      signals.push(bridgeSignal({
        id: `${candidate.id}:${manager.chain || "unknown"}:${manager.tokenAddress || manager.symbol}`,
        bridge: candidate.bridge,
        chain: manager.chain || null,
        routeId: candidate.id,
        symbol: manager.symbol || null,
        name: manager.implementationTypeLabel || null,
        address: manager.tokenAddress || null,
        signalKind: manager.nonLosslessHint ? "nonlossless-token-manager-hint" : "token-manager-review",
        signalStrength: manager.nonLosslessHint ? 64 : 32,
        hasProducerAnomaly: Boolean(manager.nonLosslessHint),
        hasConcreteMismatch: false,
        blocker: (candidate.blockers || [])[0] || "Token-manager row needs balance-delta proof and consumer route.",
        sourceArtifacts: [sourceRel(FILES.bridgeNonlossless)],
      }));
    }
  }

  const seen = new Set();
  return signals.filter((signal) => {
    const key = `${signal.bridge}:${signal.chain}:${signal.routeId}:${signal.addressKey || signal.mintKey || signal.symbolKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function consumerRow(row) {
  const liquidityUsd = asNumber(row.liquidityUsd ?? row.routeLiquidityUsd ?? row.cashUsd ?? row.totalBorrowUsd ?? row.totalDepositUsd ?? row.borrowLiquidityUsd ?? row.facts?.cashUsd ?? row.market?.cashUsd ?? row.market?.otherReserveCashUsd);
  const marketValue = row.marketId || row.market?.marketId || row.market?.pool || row.market?.reserve || row.market || row.id || null;
  const marketId = typeof marketValue === "object" && marketValue !== null
    ? marketValue.marketId || marketValue.pool || marketValue.reserve || marketValue.address || JSON.stringify(marketValue).slice(0, 120)
    : marketValue;
  const ltv = row.ltv ?? row.market?.ltv ?? row.facts?.ltv ?? row.lltv ?? (row.maxLtvBps ? row.maxLtvBps / 10000 : undefined);
  const liquidationThreshold = row.liquidationThreshold ?? row.market?.liquidationThreshold ?? row.facts?.liquidationThreshold ?? (row.maxLiquidationThresholdBps ? row.maxLiquidationThresholdBps / 10000 : undefined);
  return {
    source: row.source || null,
    protocol: row.protocol || row.market?.protocol || row.consumer?.protocol || null,
    chain: row.chain || row.producer?.chain || row.market?.chain || row.consumer?.chain || null,
    side: row.side || row.role || row.consumerType || null,
    token: row.token || row.address || row.producer?.address || row.market?.reserve || row.collateral?.address || row.mint || null,
    tokenKey: normAddress(row.token || row.address || row.producer?.address || row.market?.reserve || row.collateral?.address),
    mint: row.mint || null,
    mintKey: row.mint || null,
    symbol: row.symbol || row.producer?.symbol || row.market?.symbol || row.collateral?.symbol || row.facts?.symbol || null,
    symbolKey: normKey(row.symbol || row.producer?.symbol || row.market?.symbol || row.collateral?.symbol || row.facts?.symbol),
    marketId,
    ltv: asNumber(ltv),
    liquidationThreshold: asNumber(liquidationThreshold),
    borrowingEnabled: row.borrowingEnabled ?? row.market?.borrowingEnabled ?? row.facts?.borrowingEnabled ?? null,
    paused: row.paused ?? row.market?.paused ?? row.facts?.paused ?? null,
    liquidityUsd,
    raw: row,
  };
}

function collectConsumerRows(artifacts) {
  const rows = [];

  for (const matches of collectArraysByKey(artifacts.aaveEulerSiloGraph, "topMatches")) {
    for (const match of matches) {
      rows.push(consumerRow({ ...match, source: "aave-euler-silo-consumer-graph" }));
    }
  }

  for (const row of artifacts.lrtOracleDriftRoutes?.topRows || []) {
    rows.push(consumerRow({
      ...row,
      source: "lrt-oracle-drift-routes",
      token: row.collateral?.address,
      symbol: row.collateral?.symbol,
      protocol: row.protocol,
      chain: "Ethereum",
      side: "collateral",
      liquidityUsd: row.routeLiquidityUsd,
      ltv: row.lltv,
    }));
  }

  for (const row of artifacts.usdt0ConsumerRoutes?.consumers || []) {
    rows.push(consumerRow({
      ...row,
      source: "usdt0-consumer-routes",
      token: row.token,
      symbol: row.facts?.symbol || row.id,
      protocol: row.protocol,
      chain: row.chain,
      side: row.consumerType,
      liquidityUsd: row.facts?.cashUsd ?? row.facts?.availableLiquidity ?? row.facts?.totalDebt,
      ltv: row.facts?.ltv ? row.facts.ltv / 100 : null,
    }));
  }

  for (const row of artifacts.solanaReceiptGraph?.topRows || []) {
    rows.push(consumerRow({
      ...row,
      source: "solana-receipt-token-consumer-graph",
      mint: row.mint,
      symbol: row.symbol,
      protocol: (row.protocols || []).join("+") || null,
      chain: "Solana",
      side: "collateral/margin",
      liquidityUsd: row.totalBorrowUsd ?? row.totalDepositUsd,
      ltv: row.maxLtvBps ? row.maxLtvBps / 10000 : null,
      liquidationThreshold: row.maxLiquidationThresholdBps ? row.maxLiquidationThresholdBps / 10000 : null,
    }));
  }

  for (const row of artifacts.xstocksConsumerRoutes?.topProducts || []) {
    if (asNumber(row.consumerMatches) <= 0) continue;
    rows.push(consumerRow({
      ...row,
      source: "xstocks-consumer-routes",
      token: row.arbitrumToken,
      mint: row.solanaMint,
      symbol: row.symbol,
      protocol: "xStocks consumer join",
      chain: "Arbitrum/Solana",
      side: "consumer-linked-anomaly",
      liquidityUsd: row.signals?.solanaCirculating || row.signals?.arbitrumCirculating,
    }));
  }

  for (const exposure of artifacts.bridgeCollateralExposure?.exposures || []) {
    rows.push(consumerRow({
      ...exposure,
      source: "bridge-collateral-exposure",
      token: exposure.token,
      protocol: (exposure.protocols || []).join("+") || null,
      chain: "Ethereum",
      side: exposure.exposureLevel,
      liquidityUsd: null,
    }));
  }

  return rows.filter((row) => row.tokenKey || row.mintKey || row.symbolKey);
}

function joinSignals(signals, consumers) {
  const byAddress = new Map();
  const byMint = new Map();
  const bySymbol = new Map();
  for (const consumer of consumers) {
    pushIndex(byAddress, consumer.tokenKey, consumer);
    pushIndex(byMint, consumer.mintKey, consumer);
    pushIndex(bySymbol, consumer.symbolKey, consumer);
  }

  const rows = [];
  for (const signal of signals) {
    const exact = [
      ...(byAddress.get(signal.addressKey) || []),
      ...(byMint.get(signal.mintKey) || []),
    ].filter((consumer) => compatibleChain(signal.chain, consumer.chain));
    const fallback = [];
    const matches = [...exact, ...fallback].filter((consumer, index, all) => {
      const key = `${consumer.source}:${consumer.protocol}:${consumer.chain}:${consumer.marketId}:${consumer.tokenKey || consumer.mintKey || consumer.symbolKey}`;
      return all.findIndex((other) => `${other.source}:${other.protocol}:${other.chain}:${other.marketId}:${other.tokenKey || other.mintKey || other.symbolKey}` === key) === index;
    });
    for (const consumer of matches) {
      const liquidityUsd = asNumber(consumer.liquidityUsd) || 0;
      const material = liquidityUsd >= MIN_MATERIAL_USD;
      const exactEconomics = false;
      const forkProof = false;
      const materialConcreteMismatch = signal.hasConcreteMismatch && material;
      const routePositive = materialConcreteMismatch && exactEconomics && forkProof;
      const joinKind = exact.length ? "exact-token-match" : "symbol-fallback-match";
      rows.push({
        id: `${signal.id}::${consumer.source}:${consumer.marketId || consumer.protocol || consumer.symbol}`,
        bridge: signal.bridge,
        chain: consumer.chain || signal.chain,
        routeId: signal.routeId,
        symbol: signal.symbol || consumer.symbol,
        token: signal.address || signal.mint || consumer.token,
        signalKind: signal.signalKind,
        signalStrength: signal.signalStrength,
        hasProducerAnomaly: signal.hasProducerAnomaly,
        hasConcreteMismatch: signal.hasConcreteMismatch,
        consumerProtocol: consumer.protocol,
        consumerSide: consumer.side,
        consumerSource: consumer.source,
        consumerMarket: consumer.marketId,
        liquidityUsd: round(liquidityUsd, 2),
        ltv: round(consumer.ltv, 4),
        liquidationThreshold: round(consumer.liquidationThreshold, 4),
        borrowingEnabled: consumer.borrowingEnabled,
        paused: consumer.paused,
        materialConsumer: material,
        materialConcreteMismatch,
        joinKind,
        exactEconomicsRows: 0,
        forkProofRows: 0,
        routePositive,
        blocker: routePositive
          ? "Route-positive candidate requires fork/local proof before any signed action."
          : !signal.hasConcreteMismatch
            ? signal.blocker || "Consumer join exists, but bridge-side balance-delta mismatch is not proven."
            : !material
              ? "Bridge-side signal exists, but joined consumer liquidity is below the material threshold."
              : "Bridge-side signal and material consumer join exist, but exact borrow/exit economics are not modeled or positive.",
        sourceArtifacts: [...new Set([...(signal.sourceArtifacts || []), sourceRel(FILES[consumer.source] || "")].filter(Boolean))],
      });
    }
  }

  rows.sort((a, b) => {
    const scoreA = (a.materialConsumer ? 30 : 0) + (a.hasConcreteMismatch ? 35 : 0) + (a.signalStrength || 0) + Math.min(25, Math.log10((a.liquidityUsd || 0) + 1) * 5);
    const scoreB = (b.materialConsumer ? 30 : 0) + (b.hasConcreteMismatch ? 35 : 0) + (b.signalStrength || 0) + Math.min(25, Math.log10((b.liquidityUsd || 0) + 1) * 5);
    return scoreB - scoreA;
  });
  return rows;
}

function renderReport(artifact) {
  const topRows = artifact.topRows.slice(0, 12);
  const table = [
    "| Bridge | Signal | Consumer | Liquidity | Status | Blocker |",
    "| --- | --- | --- | --- | --- | --- |",
    ...topRows.map((row) => `| ${row.bridge || ""} | ${row.symbol || short(row.token)} / ${row.signalKind || ""} | ${row.consumerProtocol || ""} ${row.chain ? `(${row.chain})` : ""} | ${row.liquidityUsd === null ? "unknown" : `$${row.liquidityUsd}` } | ${row.routePositive ? "route-positive" : row.hasConcreteMismatch ? "needs-economics" : "needs-delta-proof"} | ${row.blocker || ""} |`),
  ].join("\n");
  return [
    "# 🟢 DORMANT - Bridge Non-Lossless Collateral Join",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Joined ${artifact.summary.bridgeSignalRows} bridge non-lossless/value-bearing signals to ${artifact.summary.consumerRows} reusable consumer rows. Found ${artifact.summary.joinedRows} joined rows and ${artifact.summary.materialJoinedRows} material joined rows, but these remain research leads unless a concrete bridge balance-delta mismatch joins to a material consumer with exact economics and fork proof. Route-relevant gates remain closed: \`concreteMismatchJoinedRows=${artifact.summary.concreteMismatchJoinedRows}\`, \`materialConsumerMismatchRows=${artifact.summary.materialConsumerMismatchRows}\`, \`exactEconomicsRows=${artifact.summary.exactEconomicsRows}\`, \`forkProofRows=${artifact.summary.forkProofRows}\`, \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`.`,
    "",
    "Current blockers are bridge-side balance-delta proof, exact borrow/exit economics, and fork/local proof. Existing material join rows are research leads, not executable routes.",
    "",
    "## Top Joined Rows",
    "",
    table,
    "",
    "## Route-Positive Gate",
    "",
    "Do not fork until a row has a deployed non-lossless bridge accounting mismatch, a material lending/DEX consumer, exact acquisition/borrow/exit economics, positive net value after gas/slippage/fees, and fork/local proof.",
    "",
    "## Artifacts",
    "",
    `- JSON: \`${sourceRel(RAW_OUT)}\``,
    "- Scanner: `tools/scan-bridge-nonlossless-collateral-join.js`",
    "- Inputs: `reports/raw/fast/bridge-nonlossless-routes.json`, `reports/raw/fast/hyperlane-warp-routes.json`, `reports/raw/fast/wormhole-token2022-fee-wrappers.json`, consumer graph artifacts",
    "",
  ].join("\n");
}

function main() {
  const artifacts = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, readJson(file, {}) || {}]));
  const bridgeSignals = collectBridgeSignals(artifacts);
  const consumerRows = collectConsumerRows(artifacts);
  const joinedRows = joinSignals(bridgeSignals, consumerRows);
  const materialRows = joinedRows.filter((row) => row.materialConsumer);
  const concreteRows = joinedRows.filter((row) => row.hasConcreteMismatch);
  const materialConsumerMismatchRows = joinedRows.filter((row) => row.materialConcreteMismatch).length;
  const exactEconomicsRows = 0;
  const forkProofRows = 0;
  const routePositiveRows = joinedRows.filter((row) => row.routePositive);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-bridge-nonlossless-collateral-join.js",
    scope: "Read-only bridge non-lossless/value-bearing accounting signals joined to lending/DEX consumers",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routePositiveRows.length > 0,
      executableNow: false,
      signedActionJustified: false,
    },
    thresholds: {
      minMaterialUsd: MIN_MATERIAL_USD,
    },
    inputs: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, sourceRel(file)])),
    summary: {
      bridgeSignalRows: bridgeSignals.length,
      bridgeSignalsWithProducerAnomaly: bridgeSignals.filter((row) => row.hasProducerAnomaly).length,
      bridgeSignalsWithConcreteMismatch: bridgeSignals.filter((row) => row.hasConcreteMismatch).length,
      consumerRows: consumerRows.length,
      joinedRows: joinedRows.length,
      materialJoinedRows: materialRows.length,
      concreteMismatchJoinedRows: concreteRows.length,
      materialConsumerMismatchRows,
      exactEconomicsRows,
      forkProofRows,
      watchCandidates: materialRows.length,
      routePositive: routePositiveRows.length,
      executableNow: 0,
      signedActionJustified: false,
      topBridge: joinedRows[0]?.bridge || null,
      topSymbol: joinedRows[0]?.symbol || null,
      topConsumer: joinedRows[0]?.consumerProtocol || null,
      topLiquidityUsd: round(joinedRows[0]?.liquidityUsd, 2),
      blocker: "No joined row has both a proven bridge balance-delta mismatch and exact positive borrow/exit economics.",
    },
    bridgeSignals: bridgeSignals.slice(0, 80),
    topRows: joinedRows.slice(0, 50),
    routePositiveRows,
    blockers: [
      "Bridge-side non-lossless/value-bearing rows are mostly classifier residuals, not balance-delta proofs.",
      "Joined consumers do not include exact acquisition, borrow, liquidation, or exit quotes.",
      "No fork/local proof demonstrates net positive extraction.",
    ],
    requiredForRoutePositive: [
      "deployed bridge path credits nominal amount above actual received/burned/locked balance",
      "bridged or wrapped token is accepted by a material lending/DEX consumer",
      "consumer state permits permissionless borrow, liquidation, redeem, or unwind",
      "exact acquisition and exit economics are positive after gas/slippage/fees",
      "fork/local proof demonstrates extractable net profit",
    ],
    nextReadOnlyStep: "For the top material Hyperlane/Wormhole joined rows, prove or rule out actual balance-delta mismatch before adding exact quote/fork work.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, JSON.stringify(artifact, null, 2) + "\n");
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));

  if (!QUIET) {
    console.log("Bridge non-lossless collateral join scan");
    console.log(`signals=${artifact.summary.bridgeSignalRows} consumers=${artifact.summary.consumerRows} joined=${artifact.summary.joinedRows} material=${artifact.summary.materialJoinedRows}`);
    console.log(`routePositive=${artifact.summary.routePositive} executableNow=${artifact.summary.executableNow} signedActionJustified=${artifact.summary.signedActionJustified}`);
    console.log(`Report: ${sourceRel(REPORT_OUT)}`);
  }
}

main();
