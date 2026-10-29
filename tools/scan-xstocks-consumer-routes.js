#!/usr/bin/env node
// Read-only xStocks consumer-route joiner.
// This scanner only consumes local artifacts and never reads or stores RPC URLs.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "xstocks-consumer-routes.json");
const QUIET = process.argv.includes("--quiet");

const FILES = {
  xstocksLive: path.join(WORKSPACE, "reports", "raw", "fast", "xstocks-live.json"),
  consumerFirstHighLtv: path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json"),
  aaveEulerSiloConsumerGraph: path.join(WORKSPACE, "reports", "raw", "fast", "aave-euler-silo-consumer-graph.json"),
};

const MIN_CONSUMER_LIQUIDITY_USD = Number(process.env.XSTOCKS_MIN_CONSUMER_LIQUIDITY_USD || "10000");
const MULTIPLIER_MISMATCH_BPS = Number(process.env.XSTOCKS_MULTIPLIER_MISMATCH_BPS || "1");

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
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
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

function lowerAddress(value) {
  const text = String(value || "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text.toLowerCase() : null;
}

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function multiplierFromRaw(value) {
  const n = asNumber(value);
  return n === null ? null : n / 1e18;
}

function publicMultiplierRows(artifact, symbol) {
  const rows = Array.isArray(artifact?.multipliers) ? artifact.multipliers : [];
  return rows.filter((row) => String(row.symbol || "").toLowerCase() === String(symbol || "").toLowerCase());
}

function publicMultiplier(artifact, symbol, network) {
  return publicMultiplierRows(artifact, symbol).find((row) => String(row.network || "").toLowerCase() === String(network || "").toLowerCase()) || null;
}

function effectiveSolanaMultiplier(solanaToken, nowSec) {
  const scaled = solanaToken?.mintInfo?.token2022ExtensionDetails?.ScaledUiAmountConfig || {};
  const current = asNumber(scaled.multiplier);
  const next = asNumber(scaled.newMultiplier);
  const nextAt = asNumber(scaled.newMultiplierEffectiveTimestamp);
  if (next !== null && next > 0 && nextAt !== null && nextAt <= nowSec) return next;
  return current;
}

function pendingPublicMultiplier(row, nowSec) {
  const current = asNumber(row?.currentMultiplier);
  const next = asNumber(row?.newMultiplier);
  const activation = asNumber(row?.activationDateTime);
  return next !== null && next > 0 && current !== null && Math.abs(next - current) > 1e-12 && activation !== null && activation > nowSec;
}

function proofReserveFor(artifact, symbol) {
  const rows = Array.isArray(artifact?.proofReserves) ? artifact.proofReserves : [];
  return rows.find((row) => String(row.symbol || "").toLowerCase() === String(symbol || "").toLowerCase()) || null;
}

function tokenSymbol(row) {
  return row?.asset?.symbol || row?.meta?.symbol || row?.token2022TokenMetadata?.parsed?.symbol || row?.mintInfo?.token2022TokenMetadata?.parsed?.symbol || row?.symbol || null;
}

function buildProducts(xstocks) {
  const products = new Map();
  const byArbitrumAddress = new Map();
  const nowSec = Math.floor(new Date(xstocks?.generatedAt || Date.now()).getTime() / 1000);

  for (const row of xstocks?.adapter?.tokens || []) {
    const arb = lowerAddress(row?.p?.["arbitrum-one"]);
    const sol = row?.p?.solana || null;
    const name = row?.name || null;
    const key = arb || String(sol || name || "").toLowerCase();
    if (!key) continue;
    products.set(key, {
      id: key,
      name,
      symbol: null,
      adapter: {
        arbitrumToken: row?.p?.["arbitrum-one"] || null,
        solanaMint: sol,
        onBothAdapterChains: Boolean(row?.p?.["arbitrum-one"] && sol),
      },
      consumerMatches: [],
    });
  }

  for (const row of xstocks?.arbitrum?.tokens || []) {
    const addr = lowerAddress(row?.token || row?.meta?.address);
    if (!addr) continue;
    const product = products.get(addr) || { id: addr, adapter: {}, consumerMatches: [] };
    const symbol = tokenSymbol(row);
    product.name = row?.asset?.name || row?.meta?.name || product.name || null;
    product.symbol = symbol || product.symbol;
    product.underlyingSymbol = row?.asset?.underlyingSymbol || product.underlyingSymbol || null;
    product.arbitrum = {
      address: row.token || row?.meta?.address || null,
      symbol,
      name: row?.meta?.name || row?.asset?.name || null,
      decimals: asNumber(row?.meta?.decimals),
      totalSupply: asNumber(row?.meta?.totalSupply),
      systemBalance: asNumber(row?.systemBalance),
      circulating: asNumber(row?.circulating),
      paused: row?.management?.isPaused ?? row?.paused ?? null,
      delegateMode: row?.management?.delegateMode ?? null,
      feePerPeriod: row?.management?.feePerPeriod ?? null,
      owner: row?.owner || null,
      minter: row?.management?.minter || null,
      burner: row?.management?.burner || null,
      pauser: row?.management?.pauser || null,
      multiplierUpdater: row?.management?.multiplierUpdater || null,
      currentMultiplier: multiplierFromRaw(row?.management?.currentMultiplier) ?? publicMultiplier(xstocks, symbol, "Arbitrum")?.currentMultiplier ?? null,
      newMultiplier: multiplierFromRaw(row?.management?.newMultiplier) ?? null,
      newMultiplierActivationTime: asNumber(row?.management?.newMultiplierActivationTime),
      permissionlessProbeSuccesses: Object.entries(row?.permissionlessProbes || {})
        .filter(([key, value]) => key !== "from" && value?.success === true)
        .map(([key]) => key),
      positiveRoles: Array.isArray(row?.positiveRoles) ? row.positiveRoles : [],
      implementation: row?.proxy?.implementation || null,
      implementationCodeHash: row?.proxy?.implementationCodeHash || null,
      proxyAdmin: row?.proxy?.admin || null,
    };
    products.set(addr, product);
    byArbitrumAddress.set(addr, product);
  }

  const bySymbol = new Map([...products.values()].filter((p) => p.symbol).map((p) => [String(p.symbol).toLowerCase(), p]));
  for (const row of xstocks?.solana?.tokens || []) {
    const symbol = tokenSymbol(row);
    const product = bySymbol.get(String(symbol || "").toLowerCase());
    if (!product) continue;
    const details = row?.mintInfo?.token2022ExtensionDetails || {};
    product.solana = {
      mint: row?.mint || null,
      symbol,
      decimals: asNumber(row?.mintInfo?.decimals),
      supply: asNumber(row?.mintInfo?.supply),
      systemBalance: asNumber(row?.systemBalance),
      circulating: asNumber(row?.circulating),
      mintAuthority: row?.mintInfo?.mintAuthority || null,
      freezeAuthority: row?.mintInfo?.freezeAuthority || null,
      permanentDelegate: details?.PermanentDelegate?.delegate || null,
      defaultAccountState: details?.DefaultAccountState?.name || null,
      pausableAuthority: details?.Pausable?.authority || null,
      paused: details?.Pausable?.paused ?? null,
      transferHookAuthority: details?.TransferHook?.authority || null,
      transferHookProgramId: details?.TransferHook?.programId || null,
      scaledUiAuthority: details?.ScaledUiAmountConfig?.authority || null,
      scaledUiMultiplier: asNumber(details?.ScaledUiAmountConfig?.multiplier),
      scaledUiNewMultiplier: asNumber(details?.ScaledUiAmountConfig?.newMultiplier),
      scaledUiNewMultiplierEffectiveTimestamp: asNumber(details?.ScaledUiAmountConfig?.newMultiplierEffectiveTimestamp),
      effectiveMultiplier: effectiveSolanaMultiplier(row, nowSec),
      token2022Extensions: (row?.mintInfo?.token2022Extensions || []).map((ext) => ext.name),
    };
  }

  for (const product of products.values()) {
    const symbol = product.symbol;
    const arbPub = publicMultiplier(xstocks, symbol, "Arbitrum");
    const solPub = publicMultiplier(xstocks, symbol, "Solana");
    const proof = proofReserveFor(xstocks, symbol);
    const sharesHeld = asNumber(proof?.sharesHeld);
    const circulatingSupply = asNumber(proof?.circulatingSupply);
    const proofShortfall = sharesHeld !== null && circulatingSupply !== null && sharesHeld < circulatingSupply ? circulatingSupply - sharesHeld : 0;
    const arbMult = product.arbitrum?.currentMultiplier ?? arbPub?.currentMultiplier ?? null;
    const solMult = product.solana?.effectiveMultiplier ?? solPub?.currentMultiplier ?? null;
    const multiplierMismatchBps = arbMult !== null && solMult !== null && Math.max(Math.abs(arbMult), Math.abs(solMult)) > 0
      ? Math.abs(arbMult - solMult) / Math.max(Math.abs(arbMult), Math.abs(solMult)) * 10_000
      : null;

    const riskFlags = [];
    if (product.arbitrum?.permissionlessProbeSuccesses?.length) riskFlags.push("permissionless-probe-success");
    if (product.arbitrum?.positiveRoles?.length) riskFlags.push("unexpected-positive-role-row");
    if (product.arbitrum?.paused === true) riskFlags.push("arbitrum-paused");
    if (product.arbitrum?.delegateMode === true) riskFlags.push("arbitrum-delegate-mode-enabled");
    if (product.solana?.paused === true) riskFlags.push("solana-paused");
    if (product.solana?.transferHookProgramId) riskFlags.push("solana-transfer-hook-active");
    if (product.solana?.defaultAccountState && product.solana.defaultAccountState !== "initialized") riskFlags.push("solana-default-account-not-initialized");
    if (pendingPublicMultiplier(arbPub, nowSec) || pendingPublicMultiplier(solPub, nowSec)) riskFlags.push("public-pending-multiplier");
    if (multiplierMismatchBps !== null && multiplierMismatchBps > MULTIPLIER_MISMATCH_BPS) riskFlags.push("cross-chain-multiplier-mismatch");
    if (proofShortfall > 0) riskFlags.push("proof-of-reserves-shortfall");
    if (proof && (sharesHeld === null || circulatingSupply === null)) riskFlags.push("proof-of-reserves-data-gap");

    product.signals = {
      arbCurrentMultiplier: round(arbMult, 12),
      solanaEffectiveMultiplier: round(solMult, 12),
      multiplierMismatchBps: round(multiplierMismatchBps, 6),
      proofSharesHeld: sharesHeld,
      proofCirculatingSupply: circulatingSupply,
      proofShortfall: round(proofShortfall, 12),
      publicPendingMultiplier: pendingPublicMultiplier(arbPub, nowSec) || pendingPublicMultiplier(solPub, nowSec),
      arbitrumCirculating: product.arbitrum?.circulating ?? null,
      solanaCirculating: product.solana?.circulating ?? null,
    };
    product.authoritySignals = {
      arbitrumOwner: product.arbitrum?.owner || null,
      arbitrumMinter: product.arbitrum?.minter || null,
      arbitrumBurner: product.arbitrum?.burner || null,
      arbitrumPauser: product.arbitrum?.pauser || null,
      arbitrumMultiplierUpdater: product.arbitrum?.multiplierUpdater || null,
      solanaMintAuthority: product.solana?.mintAuthority || null,
      solanaFreezeAuthority: product.solana?.freezeAuthority || null,
      solanaPermanentDelegate: product.solana?.permanentDelegate || null,
      solanaPausableAuthority: product.solana?.pausableAuthority || null,
      solanaScaledUiAuthority: product.solana?.scaledUiAuthority || null,
      solanaTransferHookAuthority: product.solana?.transferHookAuthority || null,
    };
    product.riskFlags = riskFlags;
  }

  return { products: [...products.values()], byArbitrumAddress };
}

function consumerLiquidityUsd(match) {
  return Math.max(
    asNumber(match.routeLiquidityUsd) || 0,
    asNumber(match.borrowAssetsUsd) || 0,
    asNumber(match.marketCashUsd) || 0,
    asNumber(match.otherReserveCashUsd) || 0
  );
}

function addMatch(product, match) {
  const liquidityUsd = consumerLiquidityUsd(match);
  product.consumerMatches.push({
    ...match,
    materialLiquidityUsd: round(liquidityUsd, 2),
    materialConsumer: liquidityUsd >= MIN_CONSUMER_LIQUIDITY_USD,
  });
}

function collectConsumerFirstMatches(artifact, byAddress) {
  const matches = [];
  let rowsScanned = 0;
  for (const result of artifact?.results || []) {
    for (const row of result?.highLtvRowsDetail || []) {
      rowsScanned += 1;
      const candidates = [
        ["collateral", row?.collateral?.address || row?.consumer?.collateralAsset?.address],
        ["borrowAsset", row?.borrowAsset?.address || row?.consumer?.loanAsset?.address],
      ];
      for (const [side, address] of candidates) {
        const product = byAddress.get(lowerAddress(address));
        if (!product) continue;
        const match = {
          source: "consumer-first-high-ltv-collateral",
          sourceArtifact: rel(FILES.consumerFirstHighLtv),
          protocol: row?.protocol || null,
          chainId: row?.chainId ?? result?.chainId ?? null,
          chain: row?.chain || result?.chain || null,
          side,
          consumer: row?.consumer || null,
          ltv: asNumber(row?.ltv),
          routeLiquidityUsd: asNumber(row?.routeLiquidityUsd),
          supplyAssetsUsd: asNumber(row?.supplyAssetsUsd),
          borrowAssetsUsd: asNumber(row?.borrowAssetsUsd),
          utilization: asNumber(row?.utilization),
          riskTags: row?.riskTags || [],
          highLtv: Boolean(row?.highLtv),
          reviewCandidate: Boolean(row?.reviewCandidate),
          sourceRoutePositive: Boolean(row?.routePositive),
        };
        addMatch(product, match);
        matches.push({ product, match });
      }
    }
  }
  return { rowsScanned, matches };
}

function collectAesMatches(artifact, byAddress) {
  const matches = [];
  let rowsScanned = 0;
  for (const result of artifact?.results || []) {
    for (const row of result?.topMatches || []) {
      rowsScanned += 1;
      const candidates = [
        ["producer", row?.producer?.address],
        ["reserveAsset", row?.market?.reserve],
        ["asset", row?.market?.asset],
        ["borrowAsset", row?.market?.borrowAsset],
        ["collateralToken", row?.market?.collateralToken],
      ];
      const seen = new Set();
      for (const [side, address] of candidates) {
        const lower = lowerAddress(address);
        if (!lower || seen.has(`${side}:${lower}`)) continue;
        seen.add(`${side}:${lower}`);
        const product = byAddress.get(lower);
        if (!product) continue;
        const match = {
          source: "aave-euler-silo-consumer-graph",
          sourceArtifact: rel(FILES.aaveEulerSiloConsumerGraph),
          protocol: row?.protocol || result?.chain || null,
          chainId: row?.producer?.chainId ?? null,
          chain: row?.producer?.chain || null,
          side: row?.side || side,
          market: row?.market || null,
          ltv: asNumber(row?.market?.ltv),
          routeLiquidityUsd: null,
          marketCashUsd: asNumber(row?.market?.cashUsd),
          otherReserveCashUsd: asNumber(row?.market?.otherReserveCashUsd),
          reviewCandidate: Boolean(row?.reviewCandidate),
          sourceRoutePositive: Boolean(row?.routePositive),
        };
        addMatch(product, match);
        matches.push({ product, match });
      }
    }
  }
  return { rowsScanned, matches };
}

function productOutput(product) {
  const consumerLinkedAnomalies = product.consumerMatches.filter((match) => match.materialConsumer && product.riskFlags.length > 0);
  const sourceRoutePositive = product.consumerMatches.some((match) => match.sourceRoutePositive === true);
  return {
    symbol: product.symbol,
    name: product.name,
    underlyingSymbol: product.underlyingSymbol || null,
    arbitrumToken: product.arbitrum?.address || product.adapter?.arbitrumToken || null,
    solanaMint: product.solana?.mint || product.adapter?.solanaMint || null,
    onBothAdapterChains: Boolean(product.adapter?.onBothAdapterChains),
    arbitrumCirculating: round(product.arbitrum?.circulating, 12),
    solanaCirculating: round(product.solana?.circulating, 12),
    riskFlags: product.riskFlags,
    signals: product.signals,
    authoritySignals: product.authoritySignals,
    consumerMatches: product.consumerMatches.length,
    materialConsumerMatches: product.consumerMatches.filter((match) => match.materialConsumer).length,
    consumerLinkedAnomalies: consumerLinkedAnomalies.length,
    watchCandidate: consumerLinkedAnomalies.length > 0,
    routePositive: false,
    blockers: sourceRoutePositive
      ? ["Source consumer row was route-positive, but this scanner has no xStocks exact acquisition/exit quote or fork proof"]
      : product.consumerMatches.length
        ? ["Consumer-linked row has no current xStocks-side anomaly", "No exact acquisition/exit economics", "No fork-positive extraction proof"]
        : ["No known lending consumer row for this Arbitrum xStock", "xStocks authority and multiplier signals are not extractive without a consumer route"],
    matches: product.consumerMatches.slice(0, 20),
  };
}

function main() {
  const xstocks = readJson(FILES.xstocksLive, {});
  const consumerFirst = readJson(FILES.consumerFirstHighLtv, {});
  const aes = readJson(FILES.aaveEulerSiloConsumerGraph, {});
  const { products, byArbitrumAddress } = buildProducts(xstocks);

  const consumerFirstMatches = collectConsumerFirstMatches(consumerFirst, byArbitrumAddress);
  const aesMatches = collectAesMatches(aes, byArbitrumAddress);
  const productRows = products.map(productOutput);
  const matched = productRows.filter((row) => row.consumerMatches > 0);
  const anomalyRows = productRows.filter((row) => row.riskFlags.length > 0);
  const watchRows = productRows.filter((row) => row.watchCandidate);
  const routePositiveRows = productRows.filter((row) => row.routePositive);
  const topProducts = productRows
    .slice()
    .sort((a, b) => (b.consumerLinkedAnomalies - a.consumerLinkedAnomalies)
      || (b.consumerMatches - a.consumerMatches)
      || (b.riskFlags.length - a.riskFlags.length)
      || ((b.solanaCirculating || 0) - (a.solanaCirculating || 0))
      || ((b.arbitrumCirculating || 0) - (a.arbitrumCirculating || 0)))
    .slice(0, 25);

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-xstocks-consumer-routes.js",
    scope: "Read-only join of xStocks Arbitrum wrappers and Solana Token-2022 signals to existing lending-consumer artifacts",
    inputs: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, rel(file)])),
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositiveRows.length > 0,
      signedActionJustified: false,
    },
    thresholds: {
      minConsumerLiquidityUsd: MIN_CONSUMER_LIQUIDITY_USD,
      multiplierMismatchBps: MULTIPLIER_MISMATCH_BPS,
    },
    xstocksSummary: {
      generatedAt: xstocks?.generatedAt || null,
      defillamaArbitrumTvlUsd: xstocks?.defillama?.currentChainTvls?.Arbitrum ?? null,
      defillamaSolanaTvlUsd: xstocks?.defillama?.currentChainTvls?.Solana ?? null,
      adapterTokens: xstocks?.adapter?.tokenCount ?? null,
      adapterBothChains: xstocks?.adapter?.bothCount ?? null,
      arbitrumTokens: xstocks?.arbitrum?.summary?.count ?? null,
      solanaMints: xstocks?.solana?.summary?.count ?? null,
      arbitrumPaused: xstocks?.arbitrum?.summary?.paused ?? null,
      arbitrumPositiveRoleRows: xstocks?.arbitrum?.summary?.positiveRoleRows ?? null,
      solanaWithMintAuthority: xstocks?.solana?.summary?.withMintAuthority ?? null,
      solanaWithFreezeAuthority: xstocks?.solana?.summary?.withFreezeAuthority ?? null,
    },
    consumerArtifacts: {
      consumerFirstHighLtv: {
        generatedAt: consumerFirst?.generatedAt || null,
        rowsScanned: consumerFirstMatches.rowsScanned,
        matches: consumerFirstMatches.matches.length,
      },
      aaveEulerSiloConsumerGraph: {
        generatedAt: aes?.generatedAt || null,
        rowsScanned: aesMatches.rowsScanned,
        matches: aesMatches.matches.length,
      },
    },
    summary: {
      productsMapped: products.length,
      arbitrumAddressesMapped: byArbitrumAddress.size,
      consumerRowsScanned: consumerFirstMatches.rowsScanned + aesMatches.rowsScanned,
      consumerMatches: consumerFirstMatches.matches.length + aesMatches.matches.length,
      matchedTokens: matched.length,
      anomalyRows: anomalyRows.length,
      consumerLinkedAnomalies: productRows.reduce((sum, row) => sum + row.consumerLinkedAnomalies, 0),
      watchCandidates: watchRows.length,
      routePositive: routePositiveRows.length,
      signedActionJustified: false,
      closedReason: watchRows.length
        ? "consumer-linked anomalies need exact economics and fork proof"
        : matched.length
          ? "consumer matches have no current xStocks-side anomaly"
          : "no xStocks wrapper is present in current reusable lending-consumer artifacts",
    },
    topProducts,
    matchedProducts: matched,
    anomalyProducts: anomalyRows.slice(0, 50),
    requiredForRoutePositive: [
      "Arbitrum xStock wrapper maps to a live lending/perps/oracle consumer with material liquidity",
      "xStocks-side supply, multiplier, pause, hook, reserve, or authority signal is current and permissionless-impacting",
      "exact acquisition/exit or borrow/liquidation economics are positive after fees, gas, and slippage",
      "local fork extraction proof shows positive net profit",
    ],
    nextReadOnlyStep: routePositiveRows.length > 0
      ? "Stop broad scanning and fork-proof only the route-positive xStocks row."
      : "Refresh xstocks-live and consumer artifacts; reopen only if a wrapper is consumed or an exact consumer-linked anomaly appears.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  if (!QUIET) {
    console.log(`xStocks consumer routes wrote ${rel(OUT)}; consumerMatches=${artifact.summary.consumerMatches}; watchCandidates=${artifact.summary.watchCandidates}; routePositive=${artifact.summary.routePositive}`);
  }
}

main();
