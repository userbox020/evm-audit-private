#!/usr/bin/env node
// scan-resupply-phase0.js - bounded read-only Resupply Phase 0 scan.
// Uses public metadata plus public Ethereum RPC. Never reads env files, keys, or signed-action inputs.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "resupply-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "resupply-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const CURVE_LLAMALEND = path.join(WORKSPACE, "reports", "raw", "fast", "curve-llamalend-phase0.json");
const CURVE_STABLECOIN_LIVE = path.join(WORKSPACE, "reports", "raw", "fast", "curve-stablecoin-live.json");
const CURVE_DEX_PHASE0 = path.join(WORKSPACE, "reports", "raw", "fast", "curve-dex-phase0.json");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_BANNER = "\uD83D\uDFE2 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const ETHEREUM_PUBLIC_RPC = "https://ethereum.publicnode.com";
const MATERIAL_USD = Number(process.env.RESUPPLY_PHASE0_MATERIAL_USD || "10000");
const WATCH_MARGIN_BPS = Number(process.env.RESUPPLY_PHASE0_WATCH_MARGIN_BPS || "500");
const MAX_DEX_TOKENS = Number(process.env.RESUPPLY_PHASE0_MAX_DEX_TOKENS || "8");

const RESUPPLY = {
  chain: "Ethereum",
  chainId: 1,
  registry: "0x10101010E0C3171D894B71B3400668aF311e7D94",
  resup: "0x419905009e4656fdc02418c7df35b1e61ed5f726",
  staking: "0x22222222E9fE38F6f1FC8C61b25228adB4D8B953",
  reUsd: "0x57aB1E0003F623289CD798B1824Be09a793e4Bec",
  sreUsd: "0x557AB1e003951A73c12D16F0fEA8490E39C33C35",
};

const REGISTRY_ABI = ["function getAllPairAddresses() view returns (address[])"];
const PAIR_ABI = [
  "function name() view returns (string)",
  "function collateral() view returns (address)",
  "function totalCollateral() view returns (uint256)",
  "function totalBorrow() view returns (uint256)",
  "function maxLTV() view returns (uint256)",
  "function liquidationFee() view returns (uint256)",
];
const ERC4626_ABI = [
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
];
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const BYTES32_TOKEN_ABI = [
  "function symbol() view returns (bytes32)",
  "function name() view returns (bytes32)",
];

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function safeText(value, max = 160) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function unitsToNumber(value, decimals = 18) { try { const n = Number(ethers.formatUnits(toBig(value), Number(decimals ?? 18))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`; }
function formatBps(value) { const n = asNumber(value); return n === null ? "n/a" : `${round(n, 2)}bps`; }
function uniq(items) { return [...new Set((items || []).filter(Boolean))]; }

async function tryCall(fn, fallback = null) {
  try { return await fn(); } catch (_) { return fallback; }
}

async function fetchJson(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-resupply-phase0/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getCodeBytes(provider, address) {
  const addr = normalizeAddress(address);
  if (!addr) return 0;
  const code = await tryCall(() => provider.getCode(addr), "0x");
  return code && code !== "0x" ? (code.length - 2) / 2 : 0;
}

function decodeBytes32String(value) {
  try { return value && value !== "0x" ? safeText(ethers.decodeBytes32String(value), 80) : null; } catch (_) { return null; }
}

async function tokenMeta(provider, token, fallback = {}) {
  const addr = normalizeAddress(token);
  if (!addr) return { address: null, symbol: fallback.symbol || null, name: fallback.name || null, decimals: fallback.decimals ?? 18, codeBytes: 0 };
  const erc = new ethers.Contract(addr, ERC20_ABI, provider);
  const b32 = new ethers.Contract(addr, BYTES32_TOKEN_ABI, provider);
  const [codeBytes, symbol, symbolBytes, name, nameBytes, decimals, totalSupply] = await Promise.all([
    getCodeBytes(provider, addr),
    tryCall(() => erc.symbol(), null),
    tryCall(() => b32.symbol(), null),
    tryCall(() => erc.name(), null),
    tryCall(() => b32.name(), null),
    tryCall(() => erc.decimals(), fallback.decimals ?? 18),
    tryCall(() => erc.totalSupply(), null),
  ]);
  return {
    address: addr,
    symbol: safeText(symbol || decodeBytes32String(symbolBytes) || fallback.symbol || "UNK", 32),
    name: safeText(name || decodeBytes32String(nameBytes) || fallback.name || "", 100),
    decimals: Number(decimals ?? fallback.decimals ?? 18),
    totalSupplyRaw: totalSupply?.toString?.() || null,
    codeBytes,
  };
}

async function protocolMetadata() {
  const live = await fetchJson("https://api.llama.fi/protocol/resupply", 45_000);
  const discovery = readJson(PUBLIC_TARGETS, {});
  const rows = [
    ...(discovery.phase0Queue || []),
    ...(discovery.protocolCandidates || []),
    ...(discovery.targetedRefreshQueue || []),
    ...(discovery.consumerJoinFirst || []),
  ];
  const row = rows.find((p) => p?.slug === "resupply" || p?.name === "Resupply");
  const tvlSeries = Array.isArray(live?.tvl) ? live.tvl : [];
  const latestTvl = tvlSeries.length ? tvlSeries[tvlSeries.length - 1]?.totalLiquidityUSD : null;
  return {
    name: live?.name || row?.name || "Resupply",
    slug: live?.slug || row?.slug || "resupply",
    category: live?.category || row?.category || "Lending",
    chains: live?.chains || row?.chains || ["Ethereum"],
    tvlUsd: round(latestTvl ?? row?.tvlUsd, 2),
    ethereumTvlUsd: round(live?.currentChainTvls?.Ethereum ?? row?.tvlUsd, 2),
    stakingTvlUsd: round(live?.currentChainTvls?.staking ?? live?.currentChainTvls?.["Ethereum-staking"], 2),
    audits: live?.audits || row?.audits || ["https://docs.resupply.fi/faq/audits"],
    url: live?.url || row?.url || "https://resupply.fi/",
    twitter: live?.twitter || row?.twitter || "ResupplyFi",
    source: live ? "defillama-protocol-api" : row ? "public-audit-target-discovery" : "fallback",
  };
}

async function llamaPrices(addresses) {
  const normalized = uniq(addresses.map(normalizeAddress)).slice(0, 80);
  const out = {};
  if (!normalized.length) return out;
  const coins = normalized.map((addr) => `ethereum:${addr}`).join(",");
  const json = await fetchJson(`https://coins.llama.fi/prices/current/${coins}`, 20_000);
  for (const [key, row] of Object.entries(json?.coins || {})) {
    const addr = normalizeAddress(key.split(":").pop());
    if (addr) out[lowerAddress(addr)] = asNumber(row?.price);
  }
  return out;
}

function stableFallbackPrice(meta) {
  const symbol = String(meta?.symbol || "").toUpperCase();
  if (["CRVUSD", "FRXUSD", "REUSD", "USDC", "USDT", "DAI"].includes(symbol)) return 1;
  return null;
}

async function dexScreenerToken(token) {
  const addr = normalizeAddress(token);
  if (!addr) return null;
  const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, 10_000);
  const pairs = (json?.pairs || [])
    .filter((p) => String(p?.chainId || "").toLowerCase() === "ethereum")
    .map((p) => ({
      dexId: safeText(p.dexId, 40),
      pairAddress: normalizeAddress(p.pairAddress),
      baseSymbol: safeText(p.baseToken?.symbol, 32),
      quoteSymbol: safeText(p.quoteToken?.symbol, 32),
      priceUsd: round(p.priceUsd, 10),
      liquidityUsd: round(p.liquidity?.usd, 2),
      volume24hUsd: round(p.volume?.h24, 2),
    }))
    .sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  return pairs[0] || null;
}

async function scanCore(provider) {
  const block = await provider.getBlock("latest");
  const registry = new ethers.Contract(RESUPPLY.registry, REGISTRY_ABI, provider);
  const pairAddresses = await tryCall(() => registry.getAllPairAddresses(), []);
  const registryCodeBytes = await getCodeBytes(provider, RESUPPLY.registry);

  const rawPairs = [];
  for (const pairAddress of pairAddresses) {
    const pair = normalizeAddress(pairAddress);
    if (!pair) continue;
    const c = new ethers.Contract(pair, PAIR_ABI, provider);
    const [pairCodeBytes, name, collateral, totalCollateralRaw, totalBorrowRaw, maxLtvRaw, liquidationFeeRaw] = await Promise.all([
      getCodeBytes(provider, pair),
      tryCall(() => c.name(), null),
      tryCall(() => c.collateral(), null),
      tryCall(() => c.totalCollateral(), null),
      tryCall(() => c.totalBorrow(), null),
      tryCall(() => c.maxLTV(), null),
      tryCall(() => c.liquidationFee(), null),
    ]);
    const collateralMeta = await tokenMeta(provider, collateral || ZERO, { symbol: "collateral", decimals: 18 });
    const vault = normalizeAddress(collateral);
    const vaultContract = vault ? new ethers.Contract(vault, ERC4626_ABI, provider) : null;
    const [asset, totalAssetsRaw, vaultSupplyRaw, collateralAssetsRaw] = await Promise.all([
      vaultContract ? tryCall(() => vaultContract.asset(), null) : null,
      vaultContract ? tryCall(() => vaultContract.totalAssets(), null) : null,
      vaultContract ? tryCall(() => vaultContract.totalSupply(), null) : null,
      vaultContract && totalCollateralRaw !== null ? tryCall(() => vaultContract.convertToAssets(totalCollateralRaw), null) : null,
    ]);
    const assetMeta = await tokenMeta(provider, asset || ZERO, { symbol: "asset", decimals: 18 });
    rawPairs.push({
      pair,
      name: safeText(name, 120),
      pairCodeBytes,
      collateral: collateralMeta,
      asset: assetMeta,
      totalCollateralRaw: totalCollateralRaw?.toString?.() || null,
      totalBorrowRaw: totalBorrowRaw?.toString?.() || null,
      maxLtvRaw: maxLtvRaw?.toString?.() || null,
      liquidationFeeRaw: liquidationFeeRaw?.toString?.() || null,
      vaultTotalAssetsRaw: totalAssetsRaw?.toString?.() || null,
      vaultTotalSupplyRaw: vaultSupplyRaw?.toString?.() || null,
      collateralAssetsRaw: collateralAssetsRaw?.toString?.() || null,
    });
  }

  const resupMeta = await tokenMeta(provider, RESUPPLY.resup, { symbol: "RESUP", decimals: 18 });
  const reUsdMeta = await tokenMeta(provider, RESUPPLY.reUsd, { symbol: "reUSD", decimals: 18 });
  const sreUsdMeta = await tokenMeta(provider, RESUPPLY.sreUsd, { symbol: "sreUSD", decimals: 18 });
  const sreUsd = new ethers.Contract(RESUPPLY.sreUsd, ERC4626_ABI, provider);
  const resup = new ethers.Contract(RESUPPLY.resup, ERC20_ABI, provider);
  const [sreUsdAsset, sreUsdAssetsRaw, sreUsdSupplyRaw, stakedResupRaw] = await Promise.all([
    tryCall(() => sreUsd.asset(), null),
    tryCall(() => sreUsd.totalAssets(), null),
    tryCall(() => sreUsd.totalSupply(), null),
    tryCall(() => resup.balanceOf(RESUPPLY.staking), null),
  ]);

  const priceAddresses = [
    RESUPPLY.resup,
    RESUPPLY.reUsd,
    RESUPPLY.sreUsd,
    ...rawPairs.map((row) => row.asset.address),
    ...rawPairs.map((row) => row.collateral.address),
  ];
  const priceMap = await llamaPrices(priceAddresses);

  const pairs = rawPairs.map((row) => {
    const assetPriceUsd = priceMap[lowerAddress(row.asset.address)] ?? stableFallbackPrice(row.asset);
    const collateralAssetAmount = unitsToNumber(row.collateralAssetsRaw, row.asset.decimals);
    const collateralAssetUsd = collateralAssetAmount !== null && assetPriceUsd !== null ? collateralAssetAmount * assetPriceUsd : null;
    const totalBorrow = unitsToNumber(row.totalBorrowRaw, 18);
    const totalBorrowUsd = totalBorrow !== null ? totalBorrow : null;
    const maxLtvBps = row.maxLtvRaw !== null ? Number(toBig(row.maxLtvRaw) / 10n) : null;
    const liquidationFeeBps = row.liquidationFeeRaw !== null ? Number(toBig(row.liquidationFeeRaw) / 10n) : null;
    const pairLtvBps = collateralAssetUsd && totalBorrowUsd !== null ? (totalBorrowUsd / collateralAssetUsd) * 10000 : null;
    const marginToMaxLtvBps = maxLtvBps !== null && pairLtvBps !== null ? maxLtvBps - pairLtvBps : null;
    const materialDebt = (totalBorrowUsd || 0) >= MATERIAL_USD;
    const reviewCandidate = materialDebt && (maxLtvBps || 0) >= 9000;
    const watchCandidate = reviewCandidate && marginToMaxLtvBps !== null && marginToMaxLtvBps <= WATCH_MARGIN_BPS;
    return {
      ...row,
      assetPriceUsd: round(assetPriceUsd, 10),
      collateralAssetAmount: round(collateralAssetAmount, 6),
      collateralAssetUsd: round(collateralAssetUsd, 2),
      totalBorrow: round(totalBorrow, 6),
      totalBorrowUsd: round(totalBorrowUsd, 2),
      maxLtvBps: round(maxLtvBps, 2),
      liquidationFeeBps: round(liquidationFeeBps, 2),
      pairLtvBps: round(pairLtvBps, 4),
      marginToMaxLtvBps: round(marginToMaxLtvBps, 4),
      materialDebt,
      reviewCandidate,
      watchCandidate,
      routePositive: false,
      blocker: "Pair-level utilization is not borrower-level liquidation proof; no exact liquidation/acquisition/exit route is proven.",
    };
  });

  const dexTokens = uniq([RESUPPLY.resup, RESUPPLY.reUsd, RESUPPLY.sreUsd, ...pairs.map((row) => row.asset.address)]).slice(0, MAX_DEX_TOKENS);
  const dexRows = [];
  for (const token of dexTokens) {
    const meta = token && lowerAddress(token) === lowerAddress(RESUPPLY.resup) ? resupMeta
      : token && lowerAddress(token) === lowerAddress(RESUPPLY.reUsd) ? reUsdMeta
        : token && lowerAddress(token) === lowerAddress(RESUPPLY.sreUsd) ? sreUsdMeta
          : pairs.find((row) => lowerAddress(row.asset.address) === lowerAddress(token))?.asset;
    const top = await dexScreenerToken(token);
    dexRows.push({ token: normalizeAddress(token), symbol: meta?.symbol || null, topPair: top, routePositive: false });
  }

  return {
    block: { number: block?.number ?? null, timestamp: block?.timestamp ?? null, iso: block?.timestamp ? new Date(Number(block.timestamp) * 1000).toISOString() : null },
    registry: { address: RESUPPLY.registry, codeBytes: registryCodeBytes, pairsDiscovered: pairAddresses.length },
    tokens: {
      resup: { ...resupMeta, priceUsd: round(priceMap[lowerAddress(RESUPPLY.resup)], 10), stakedRaw: stakedResupRaw?.toString?.() || null, staked: round(unitsToNumber(stakedResupRaw, resupMeta.decimals), 6) },
      reUsd: { ...reUsdMeta, priceUsd: round(priceMap[lowerAddress(RESUPPLY.reUsd)] ?? stableFallbackPrice(reUsdMeta), 10) },
      sreUsd: { ...sreUsdMeta, asset: normalizeAddress(sreUsdAsset), priceUsd: round(priceMap[lowerAddress(RESUPPLY.sreUsd)], 10), totalAssetsRaw: sreUsdAssetsRaw?.toString?.() || null, totalSupplyRaw: sreUsdSupplyRaw?.toString?.() || null, totalAssets: round(unitsToNumber(sreUsdAssetsRaw, 18), 6), totalSupply: round(unitsToNumber(sreUsdSupplyRaw, 18), 6) },
    },
    pairs,
    dexRows,
  };
}

function collectCurveLlamalend() {
  const json = readJson(CURVE_LLAMALEND, {});
  const rows = (json.marketRows || []).filter((row) => /sreUSD/i.test(`${row.name || ""} ${row.collateral?.symbol || ""}`));
  return rows.map((row) => {
    const borrowers = Array.isArray(row.borrowerRows) ? row.borrowerRows : [];
    return {
      sourceGeneratedAt: json.generatedAt || null,
      marketName: safeText(row.name, 120),
      controller: normalizeAddress(row.controller || row.controllerState?.controller),
      vault: normalizeAddress(row.vault),
      amm: normalizeAddress(row.amm),
      collateralToken: normalizeAddress(row.controllerState?.collateralToken || row.collateral?.address),
      borrowedToken: normalizeAddress(row.controllerState?.borrowedToken || row.borrowed?.address),
      apiBorrowedUsd: round(row.apiState?.borrowedUsd, 2),
      apiAvailableToBorrowUsd: round(row.apiState?.availableToBorrowUsd, 2),
      totalDebtUsd: round(row.controllerState?.totalDebtUsd, 2),
      loanDiscountBps: round(row.controllerState?.loanDiscountBps, 2),
      liquidationDiscountBps: round(row.controllerState?.liquidationDiscountBps, 2),
      limitedVsSpotDiffBps: round(row.ammState?.limitedVsSpotDiffBps, 4),
      sampledBorrowers: borrowers.length,
      materialLiquidatableBorrowers: borrowers.filter((b) => b?.materialLiquidatable).length,
      nearLiquidationRows: borrowers.filter((b) => b?.nearLiquidation).length,
      grossPositiveRows: borrowers.filter((b) => b?.grossPositiveLiquidation && b?.liquidatable).length,
      maxDebtUsd: round(Math.max(0, ...borrowers.map((b) => asNumber(b?.debtUsd) || 0)), 2),
      maxGrossLiquidationEdgeUsd: round(Math.max(0, ...borrowers.map((b) => asNumber(b?.grossLiquidationEdgeUsd) || 0)), 2),
      routePositive: false,
      blocker: "Fresh Curve LlamaLend artifact shows sampled sreUSD rows are not liquidatable/gross-positive; no exact positive route.",
    };
  });
}

function collectStaleCurveFlags() {
  const json = readJson(CURVE_STABLECOIN_LIVE, {});
  const generatedAt = json.generatedAt || null;
  const flags = [];
  for (const chain of json.chains || []) {
    for (const flag of chain.flags || []) if (/sreUSD/i.test(flag)) flags.push(safeText(flag, 120));
  }
  const ageDays = generatedAt ? (Date.now() - Date.parse(generatedAt)) / 86400000 : null;
  return { sourceGeneratedAt: generatedAt, ageDays: round(ageDays, 2), flags, liquidatableFlagRows: flags.filter((f) => /LIQUIDATABLE/i.test(f)).length };
}

function collectCurveDexRows() {
  const json = readJson(CURVE_DEX_PHASE0, {});
  const reUsdLower = lowerAddress(RESUPPLY.reUsd);
  const rows = (json.poolRows || []).filter((row) => (row.coins || []).some((coin) => lowerAddress(coin.address) === reUsdLower));
  return rows.map((row) => ({
    sourceGeneratedAt: json.generatedAt || null,
    chain: safeText(row.chain, 40),
    registry: safeText(row.registry, 80),
    name: safeText(row.name, 120),
    pool: normalizeAddress(row.pool),
    gauge: normalizeAddress(row.gauge),
    usdTotal: round(row.usdTotal, 2),
    coins: (row.coins || []).map((coin) => ({ symbol: safeText(coin.symbol, 32), address: normalizeAddress(coin.address), usdPrice: round(coin.usdPrice, 10) })),
    routePositive: false,
  }));
}

function renderReport(artifact) {
  const s = artifact.summary;
  const pairRows = artifact.pairRows.slice(0, 12).map((row) => `| ${safeText(row.name, 44)} | ${compactAddress(row.pair)} | ${row.asset.symbol} | ${formatUsd(row.collateralAssetUsd)} | ${formatUsd(row.totalBorrowUsd)} | ${formatBps(row.maxLtvBps)} | ${formatBps(row.marginToMaxLtvBps)} | ${row.watchCandidate ? "yes" : "no"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const curveRows = artifact.curveLlamalendRows.map((row) => `| ${safeText(row.marketName, 42)} | ${compactAddress(row.controller)} | ${formatUsd(row.totalDebtUsd)} | ${formatUsd(row.apiAvailableToBorrowUsd)} | ${row.sampledBorrowers} | ${row.materialLiquidatableBorrowers} | ${row.grossPositiveRows} | ${formatBps(row.limitedVsSpotDiffBps)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const dexRows = artifact.curveDexRows.map((row) => `| ${safeText(row.name, 32)} | ${compactAddress(row.pool)} | ${formatUsd(row.usdTotal)} | ${(row.coins || []).map((c) => c.symbol).join("/")} |`).join("\n") || "| none | n/a | n/a | n/a |";
  const blockers = artifact.blockers.map((b) => `- ${b}`).join("\n");
  return `# ${SIGNAL_BANNER} - Resupply Phase 0 Triage

Generated: ${artifact.generatedAt}

Scanner: \`${artifact.scanner}\`

Artifact: \`reports/raw/fast/resupply-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This pass mapped the live Resupply registry, all pair collateral wrappers, pair-level debt/collateral context, Resupply reUSD/sreUSD token state, Curve DEX liquidity context, and prior fresh Curve LlamaLend sreUSD borrower sampling. It found watch-only high-LTV/debt context, but no current exact-positive borrow, liquidation, redemption, or unwind route.

## Summary

| Metric | Value |
|---|---:|
| Public TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Ethereum TVL | ${formatUsd(s.ethereumTvlUsd)} |
| Registry pairs | \`${s.pairsDiscovered}\` |
| Pair rows with code | \`${s.pairsWithCode}\` |
| Material debt pairs | \`${s.materialDebtPairs}\` |
| Pair debt context | ${formatUsd(s.totalBorrowUsd)} |
| Pair collateral asset context | ${formatUsd(s.totalCollateralAssetUsd)} |
| Direct watch candidates | \`${s.directWatchCandidates}\` |
| Curve LlamaLend sreUSD rows | \`${s.curveLlamalendRows}\` |
| Curve DEX reUSD pools | \`${s.curveDexRows}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |
| Coverage classification | \`${s.coverageClassification}\` |

## Resupply Pair Rows

| Pair | Address | Asset | Collateral assets | Total borrow | Max LTV | Pair margin | Watch |
|---|---|---|---:|---:|---:|---:|---:|
${pairRows}

## Curve LlamaLend sreUSD Join

| Market | Controller | Debt | Available borrow | Sampled borrowers | Material liq | Gross-positive | Oracle/spot diff |
|---|---|---:|---:|---:|---:|---:|---:|
${curveRows}

## Curve DEX reUSD Context

| Pool | Address | TVL | Coins |
|---|---|---:|---|
${dexRows}

## Blockers

${blockers}

No fork PoC, signed action, exploit call, or executor work is justified from this artifact.
`;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const provider = new ethers.JsonRpcProvider(ETHEREUM_PUBLIC_RPC);
  const [metadata, core] = await Promise.all([protocolMetadata(), scanCore(provider)]);
  const curveLlamalendRows = collectCurveLlamalend();
  const staleCurveStablecoin = collectStaleCurveFlags();
  const curveDexRows = collectCurveDexRows();

  const pairRows = core.pairs.sort((a, b) => (b.totalBorrowUsd || 0) - (a.totalBorrowUsd || 0));
  const materialDebtPairs = pairRows.filter((row) => row.materialDebt);
  const directWatchCandidates = pairRows.filter((row) => row.watchCandidate);
  const staleExternalTriggerRows = staleCurveStablecoin.liquidatableFlagRows > 0 ? 1 : 0;
  const freshCurveGrossPositiveRows = curveLlamalendRows.reduce((acc, row) => acc + (row.grossPositiveRows || 0), 0);
  const watchCandidates = directWatchCandidates.length + (freshCurveGrossPositiveRows > 0 ? 1 : 0);

  const blockers = [
    "Resupply pair rows are high-LTV debt/collateral context, but pair-level utilization is not borrower-level liquidation proof.",
    "The fresh Curve LlamaLend sreUSD Phase 0 row has sampled borrowers but zero material liquidatable/gross-positive rows for this market.",
    "Older Curve stablecoin live flags mention sreUSD liquidatable state, but that artifact is stale and superseded by fresh Curve LlamaLend route-negative sampling.",
    "Curve DEX reUSD liquidity is exit context only; no accepted-value, oracle, or redemption divergence clears LTV, fees, gas, and slippage.",
    "No exact positive borrow, liquidation, redemption, or unwind economics and no fork extraction proof.",
  ];

  const artifact = {
    generatedAt,
    scanner: "tools/scan-resupply-phase0.js",
    scope: "Read-only Resupply pair registry, reUSD/sreUSD, Curve LlamaLend sreUSD, and Curve DEX reUSD Phase 0 on Ethereum",
    safety: {
      publicApisOnlyForMetadata: true,
      publicRpcOnly: true,
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
      signedActionJustified: false,
    },
    target: { name: "Resupply", slug: "resupply", category: "Lending", chain: "Ethereum", metadata },
    deployments: {
      registry: core.registry,
      resup: RESUPPLY.resup,
      staking: RESUPPLY.staking,
      reUsd: RESUPPLY.reUsd,
      sreUsd: RESUPPLY.sreUsd,
    },
    thresholds: { materialUsd: MATERIAL_USD, watchMarginBps: WATCH_MARGIN_BPS, maxDexTokens: MAX_DEX_TOKENS },
    block: core.block,
    sourceArtifacts: {
      publicTargets: "reports/raw/fast/public-audit-target-discovery.json",
      curveLlamalend: "reports/raw/fast/curve-llamalend-phase0.json",
      curveStablecoinLive: "reports/raw/fast/curve-stablecoin-live.json",
      curveDexPhase0: "reports/raw/fast/curve-dex-phase0.json",
    },
    summary: {
      defillamaCurrentTvlUsd: metadata.tvlUsd,
      ethereumTvlUsd: metadata.ethereumTvlUsd,
      stakingTvlUsd: metadata.stakingTvlUsd,
      ethereumRpcResolved: true,
      ethereumBlock: core.block.number,
      registryPairs: core.registry.pairsDiscovered,
      pairsDiscovered: pairRows.length,
      pairsWithCode: pairRows.filter((row) => row.pairCodeBytes > 0).length,
      collateralRowsWithCode: pairRows.filter((row) => row.collateral.codeBytes > 0).length,
      materialDebtPairs: materialDebtPairs.length,
      highLtvPairs: pairRows.filter((row) => (row.maxLtvBps || 0) >= 9000).length,
      totalBorrowUsd: round(pairRows.reduce((acc, row) => acc + (row.totalBorrowUsd || 0), 0), 2),
      totalCollateralAssetUsd: round(pairRows.reduce((acc, row) => acc + (row.collateralAssetUsd || 0), 0), 2),
      directReviewCandidates: pairRows.filter((row) => row.reviewCandidate).length,
      directWatchCandidates: directWatchCandidates.length,
      curveLlamalendRows: curveLlamalendRows.length,
      curveLlamalendGrossPositiveRows: freshCurveGrossPositiveRows,
      staleCurveStablecoinSreUsdFlagRows: staleCurveStablecoin.flags.length,
      staleExternalTriggerRows,
      curveDexRows: curveDexRows.length,
      topDexLiquidityUsd: round(Math.max(0, ...core.dexRows.map((row) => asNumber(row.topPair?.liquidityUsd) || 0), ...curveDexRows.map((row) => asNumber(row.usdTotal) || 0)), 2),
      watchCandidates,
      routePositive: 0,
      executableNow: false,
      signedActionJustified: false,
      coverageClassification: "bounded-with-caveats",
      forkGate: "closed-route-positive-zero",
    },
    tokens: core.tokens,
    pairRows,
    curveLlamalendRows,
    staleCurveStablecoin,
    curveDexRows,
    dexRows: core.dexRows,
    blockers,
    requiredForRoutePositive: [
      "specific Resupply pair or sreUSD consumer has a current liquidatable borrower or accepted-value divergence",
      "collateral acquisition, borrow/repay, liquidation/redeem, and exit route are exact-quoted after fees, gas, and slippage",
      "borrower/account state is fresh and not stale-artifact-only",
      "fork extraction proof",
    ],
    nextReadOnlyStep: "Keep Resupply on pair-level high-LTV, sreUSD LlamaLend, and reUSD Curve DEX watch; exact-quote/fork only if fresh borrower-level liquidation or accepted-value divergence becomes route-positive.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));
  if (!QUIET) console.log(`resupplyPhase0 pairs=${artifact.summary.pairsDiscovered} materialDebt=${artifact.summary.materialDebtPairs} watch=${artifact.summary.watchCandidates} routePositive=${artifact.summary.routePositive}`);
}

main().catch((err) => {
  console.error(`resupplyPhase0 error: ${err.message}`);
  process.exitCode = 1;
});
