#!/usr/bin/env node
// Read-only OpenEden TBILL Phase 0 scanner.
// RPC URLs are resolved in memory only via shared-rpc and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "openeden-tbill-phase0.json");
const RWA_GRAPH = path.join(WORKSPACE, "reports", "raw", "fast", "openeden-tbill-rwa-nav-consumer-graph-quick.json");

const TOKENS = [
  { chainId: 1, chain: "Ethereum", coinGeckoNetwork: "eth", dexscreenerChain: "ethereum", address: "0xdd50C053C096CB04A3e3362E2b622529EC5f2e8a" },
  { chainId: 42161, chain: "Arbitrum", coinGeckoNetwork: "arbitrum", dexscreenerChain: "arbitrum", address: "0xF84D28A8D28292842dD73D1c5F99476A80b6666A" },
  { chainId: 56, chain: "BNB Chain", coinGeckoNetwork: "bsc", dexscreenerChain: "bsc", address: "0x5b4681F0d7A01B817675F25892D3Ad73572FD1D9" },
];

const ERC20 = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
  "function paused() view returns (bool)",
  "function isPaused() view returns (bool)",
  "function blacklist(address) view returns (bool)",
  "function blacklisted(address) view returns (bool)",
  "function isBlacklisted(address) view returns (bool)",
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function maxDeposit(address owner) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function decode(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

async function call(provider, address, fn, args = []) {
  try {
    const data = ERC20.encodeFunctionData(fn, args);
    const raw = await provider.call({ to: address, data });
    return decode(raw, ERC20, fn);
  } catch (_) {
    return null;
  }
}

function fmt(raw, decimals) {
  if (raw === null || raw === undefined) return null;
  try { return ethers.formatUnits(raw, decimals); } catch (_) { return null; }
}

function asBool(decoded) {
  if (!decoded) return null;
  return Boolean(decoded[0]);
}

function asAddress(decoded) {
  if (!decoded) return null;
  const value = decoded[0];
  return typeof value === "string" && ethers.isAddress(value) ? ethers.getAddress(value) : null;
}

async function geckoPools(network, address) {
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools`;
    const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "evm-audit-openeden/1.0" } });
    if (!res.ok) return { ok: false, status: res.status, pools: [] };
    const json = await res.json();
    return {
      ok: true,
      status: res.status,
      pools: (json.data || []).map((pool) => ({
        address: pool.attributes?.address || null,
        name: pool.attributes?.name || null,
        liquidityUsd: Number(pool.attributes?.reserve_in_usd || 0),
        volume24hUsd: Number(pool.attributes?.volume_usd?.h24 || 0),
      })).sort((a, b) => b.liquidityUsd - a.liquidityUsd).slice(0, 5),
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err), pools: [] };
  }
}

async function dexScreenerPairs(chain, address) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { headers: { "user-agent": "evm-audit-openeden/1.0" } });
    if (!res.ok) return { ok: false, status: res.status, pairs: [] };
    const json = await res.json();
    return {
      ok: true,
      status: res.status,
      pairs: (json.pairs || [])
        .filter((pair) => String(pair.chainId || "").toLowerCase().includes(chain))
        .map((pair) => ({
          chainId: pair.chainId || null,
          dexId: pair.dexId || null,
          pairAddress: pair.pairAddress || null,
          base: pair.baseToken?.symbol || null,
          quote: pair.quoteToken?.symbol || null,
          priceUsd: pair.priceUsd || null,
          liquidityUsd: Number(pair.liquidity?.usd || 0),
          volume24hUsd: Number(pair.volume?.h24 || 0),
        })).sort((a, b) => b.liquidityUsd - a.liquidityUsd).slice(0, 5),
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err), pairs: [] };
  }
}

async function tokenRow(token) {
  const graph = readJson(RWA_GRAPH, null);
  const priceByAddress = new Map();
  for (const result of graph?.results || []) {
    for (const producer of result.topProducers || []) {
      if (producer.addressLower && producer.tokenPriceUsd) priceByAddress.set(producer.addressLower, producer.tokenPriceUsd);
    }
  }
  const rpc = await resolveRpc(token.chainId);
  const provider = rpc ? new ethers.JsonRpcProvider(rpc, token.chainId, { staticNetwork: true }) : null;
  if (!provider) {
    return { ...token, rpcResolved: false, codePresent: null, blocker: "RPC unavailable; live token checks skipped" };
  }
  const [blockNumber, code, implRaw, adminRaw] = await Promise.all([
    provider.getBlockNumber().catch(() => null),
    provider.getCode(token.address).catch(() => "0x"),
    provider.getStorage(token.address, EIP1967_IMPL).catch(() => null),
    provider.getStorage(token.address, EIP1967_ADMIN).catch(() => null),
  ]);
  const [symbol, name, decimalsResult, supply, owner, getOwner, paused, isPaused, asset, totalAssets, oneShareAssets, maxDepositZero, maxRedeemSelf, transferDryRun] = await Promise.all([
    call(provider, token.address, "symbol"),
    call(provider, token.address, "name"),
    call(provider, token.address, "decimals"),
    call(provider, token.address, "totalSupply"),
    call(provider, token.address, "owner"),
    call(provider, token.address, "getOwner"),
    call(provider, token.address, "paused"),
    call(provider, token.address, "isPaused"),
    call(provider, token.address, "asset"),
    call(provider, token.address, "totalAssets"),
    call(provider, token.address, "convertToAssets", [10n ** 6n]),
    call(provider, token.address, "maxDeposit", [ethers.ZeroAddress]),
    call(provider, token.address, "maxRedeem", [token.address]),
    provider.call({ to: token.address, data: ERC20.encodeFunctionData("transfer", [ethers.ZeroAddress, 1]) }).then(() => ({ ok: true })).catch((err) => ({ ok: false, error: err.shortMessage || err.message || String(err) })),
  ]);
  const decimals = Number(decimalsResult?.[0] ?? 18n);
  const supplyRaw = supply?.[0] ?? null;
  const totalAssetsRaw = totalAssets?.[0] ?? null;
  const tokenPriceUsd = priceByAddress.get(token.address.toLowerCase()) || null;
  const customNavPerShare = supplyRaw && totalAssetsRaw !== null && supplyRaw > 0n
    ? Number(ethers.formatUnits((totalAssetsRaw * (10n ** BigInt(decimals))) / supplyRaw, decimals))
    : null;
  const customNavVsPublicPriceBps = tokenPriceUsd && customNavPerShare !== null
    ? ((customNavPerShare - tokenPriceUsd) / tokenPriceUsd) * 10000
    : null;
  const impl = implRaw && implRaw !== "0x" && !/^0x0+$/.test(implRaw) ? ethers.getAddress(`0x${implRaw.slice(-40)}`) : null;
  const admin = adminRaw && adminRaw !== "0x" && !/^0x0+$/.test(adminRaw) ? ethers.getAddress(`0x${adminRaw.slice(-40)}`) : null;
  const gecko = await geckoPools(token.coinGeckoNetwork, token.address);
  const dex = await dexScreenerPairs(token.dexscreenerChain, token.address);
  const dexPools = [...(gecko.pools || []), ...(dex.pairs || [])];
  const topDexLiquidityUsd = dexPools.reduce((max, pool) => Math.max(max, Number(pool.liquidityUsd || 0)), 0);
  return {
    ...token,
    rpcResolved: true,
    blockNumber,
    codePresent: Boolean(code && code !== "0x"),
    proxy: { eip1967Implementation: impl, eip1967Admin: admin },
    symbol: symbol?.[0] || null,
    name: name?.[0] || null,
    decimals,
    totalSupplyRaw: supply?.[0]?.toString() || null,
    totalSupply: supply ? fmt(supply[0], decimals) : null,
    tokenPriceUsd,
    owner: asAddress(owner) || asAddress(getOwner),
    paused: asBool(paused) ?? asBool(isPaused),
    erc4626Like: Boolean(asset && asset[0] && asset[0] !== ethers.ZeroAddress),
    asset: asAddress(asset),
    totalAssetsRaw: totalAssets?.[0]?.toString() || null,
    totalAssets: totalAssets ? fmt(totalAssets[0], decimals) : null,
    customNavPerShare,
    customNavVsPublicPriceBps,
    oneShareToAssetsRaw: oneShareAssets?.[0]?.toString() || null,
    maxDepositZeroRaw: maxDepositZero?.[0]?.toString() || null,
    maxRedeemTokenRaw: maxRedeemSelf?.[0]?.toString() || null,
    transferOneDryRun: transferDryRun,
    geckoTerminal: gecko,
    dexScreener: dex,
    topDexLiquidityUsd,
    routePositive: false,
  };
}

async function defillamaMetadata() {
  const res = await fetch("https://api.llama.fi/protocol/openeden-tbill", { headers: { "user-agent": "evm-audit-openeden/1.0" } });
  if (!res.ok) return { ok: false, status: res.status };
  const json = await res.json();
  const currentTvlUsd = Array.isArray(json.tvl) && json.tvl.length ? json.tvl[json.tvl.length - 1].totalLiquidityUSD : json.tvl;
  return {
    ok: true,
    name: json.name,
    slug: json.slug,
    category: json.category,
    currentTvlUsd,
    chains: json.chains || [],
    audits: json.audits || null,
  };
}

async function main() {
  const tokenRows = [];
  for (const token of TOKENS) tokenRows.push(await tokenRow(token));
  const graph = readJson(RWA_GRAPH, null);
  const metadata = await defillamaMetadata();
  const routePositive = false;
  const blockers = [
    "No OpenEden TBILL consumer matches in the focused current RWA/NAV graph",
    "Older Euler eTBILL rows have zero cash, zero borrows, zero supply, and zero LTV",
    "TBILL is not ERC4626-like in observed calls, so no public on-chain NAV/redeem path was resolved",
    "Public GeckoTerminal and Dexscreener checks found no executable TBILL DEX liquidity",
    "RWA redemption is permissioned/restricted until a public atomic exit is proven",
  ];
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-openeden-tbill-phase0.js",
    scope: "OpenEden TBILL target-specific Phase 0 route-first review",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive,
      executableNow: false,
      signedActionJustified: false,
      forkJustified: false,
    },
    metadata,
    tokenRows,
    consumerGraph: graph ? {
      artifact: path.relative(WORKSPACE, RWA_GRAPH).replace(/\\/g, "/"),
      generatedAt: graph.generatedAt,
      producersInput: graph.summary?.producersInput || 0,
      producersCodePresent: graph.summary?.producersCodePresent || 0,
      matches: graph.summary?.matches || 0,
      reviewCandidates: graph.summary?.reviewCandidates || 0,
      watchCandidates: graph.summary?.watchCandidates || 0,
      routePositive: graph.summary?.routePositive || 0,
    } : null,
    legacyConsumerContext: [
      {
        source: "reports/raw/fast/euler-v2-phase0.json",
        rows: ["eTBILL-1", "eTBILL-2"],
        currentBlocker: "asset is borrow-side context only: cash=0, totalAssets=0, totalBorrows=0, maxDeposit=0, maxMint=0, maxLtvBorrowBps=0",
        routePositive: false,
      },
    ],
    summary: {
      chainsScanned: tokenRows.filter((row) => row.rpcResolved).length,
      tokenRows: tokenRows.length,
      codePresentRows: tokenRows.filter((row) => row.codePresent).length,
      erc4626LikeRows: tokenRows.filter((row) => row.erc4626Like).length,
      rowsWithDexLiquidity: tokenRows.filter((row) => row.topDexLiquidityUsd > 0).length,
      topDexLiquidityUsd: tokenRows.reduce((max, row) => Math.max(max, Number(row.topDexLiquidityUsd || 0)), 0),
      currentConsumerMatches: graph?.summary?.matches || 0,
      currentWatchCandidates: graph?.summary?.watchCandidates || 0,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: false,
      primaryBlocker: blockers[0],
    },
    blockers,
    nextRoutePositiveCriteria: [
      "TBILL accepted as collateral/oracle input with positive LTV/LLTV and material borrow cash",
      "Permissionless or DEX acquisition/exit liquidity for the exact TBILL token and size",
      "Accepted value exceeds acquisition and unwind value after LTV, slippage, fees, caps, queues, and gas",
      "Fork/static-call proof only after read-only exact economics become positive",
    ],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`OpenEden TBILL Phase 0: rows=${tokenRows.length} matches=${artifact.summary.currentConsumerMatches} dexRows=${artifact.summary.rowsWithDexLiquidity} routePositive=0`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
