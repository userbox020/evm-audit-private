#!/usr/bin/env node
// Read-only NFT lending oracle route scanner.
// First pass: BendDAO pooled NFT lending plus NFTfi vault metadata. No signed actions or fork transactions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "nft-lending-oracle-routes.json");
const QUIET = process.argv.includes("--quiet");

const CHAIN_ID = 1;
const TIMEOUT_MS = Number(process.env.NFT_LENDING_TIMEOUT_MS || "15000");
const MIN_LTV = Number(process.env.NFT_LENDING_MIN_LTV || "0.50");
const MIN_BORROW_LIQUIDITY_USD = Number(process.env.NFT_LENDING_MIN_BORROW_LIQUIDITY_USD || "10000");

const BENDDAO = {
  UiPoolDataProvider: "0x5250cCE48E43AB930e45Cc8E71C87Ca4B51244cf",
  LendPoolAddressProvider: "0x24451F47CaF13B24f4b5034e1dF6c0E401ec0e46",
  BNFTRegistry: "0x79d922DD382E42A156bC0A354861cDBC4F09110d",
};

const NFTFI = {
  addressField: "0x09d6f0f5a21f5be4f59e209747e2d07f50bc694c",
  owners: [
    "0xf896527c49b44aAb3Cf22aE356Fa3AF8E331F280",
    "0x8252Df1d8b29057d1Afe3062bf5a64D503152BC8",
    "0xd0a40eB7FD94eE97102BA8e9342243A2b2E22207",
    "0xe52cec0e90115abeb3304baa36bc2655731f7934",
    "0xD0C6e59B50C32530C627107F50Acc71958C4341F",
    "0x16c583748faed1c5a5bcd744b4892ee6b6290094",
    "0x0259119359Bf053ebF42C9807752de6bbb4925f3",
  ],
};

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);

const UI_POOL = new ethers.Interface([
  "function getSimpleReservesData(address provider) view returns (tuple(address underlyingAsset,string name,string symbol,uint256 decimals,uint256 reserveFactor,bool borrowingEnabled,bool isActive,bool isFrozen,uint128 liquidityIndex,uint128 variableBorrowIndex,uint128 liquidityRate,uint128 variableBorrowRate,uint40 lastUpdateTimestamp,address bTokenAddress,address debtTokenAddress,address interestRateAddress,uint256 availableLiquidity,uint256 totalVariableDebt,uint256 priceInEth,uint256 variableRateSlope1,uint256 variableRateSlope2)[])",
  "function getSimpleNftsData(address provider) view returns (tuple(address underlyingAsset,string name,string symbol,uint256 ltv,uint256 liquidationThreshold,uint256 liquidationBonus,uint256 redeemDuration,uint256 auctionDuration,uint256 redeemFine,uint256 redeemThreshold,bool isActive,bool isFrozen,address bNftAddress,uint256 priceInEth,uint256 totalCollateral)[])",
]);

const BNFT_REGISTRY = new ethers.Interface([
  "function getBNFTAssetList() view returns (address[])",
  "function bNftProxys(address) view returns (address)",
]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function lowerAddress(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,_]/g, "");
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

async function resolveRpcUrl(chainId) {
  for (const url of loadRpcUrls()) {
    try {
      const id = Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000)));
      if (id === chainId) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

async function safeProviderCall(provider, to, data) {
  try { return await provider.call({ to, data }); } catch (_) { return null; }
}

function decodeResult(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

function decodeStringResult(raw, fn) {
  if (!raw || raw === "0x") return null;
  try { return String(ERC20.decodeFunctionResult(fn, raw)[0]); } catch (_) { return null; }
}

function decodeUintResult(raw, fn) {
  if (!raw || raw === "0x") return null;
  try { return BigInt(ERC20.decodeFunctionResult(fn, raw)[0]); } catch (_) {
    try { return BigInt(raw); } catch (_) { return null; }
  }
}

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try { return Number(ethers.formatUnits(raw, Number(decimals))); } catch (_) { return null; }
}

async function tokenMeta(provider, address, fallback = {}) {
  const token = normalizeAddress(address);
  if (!token) return { address: null, symbol: fallback.symbol || null, name: fallback.name || null, decimals: fallback.decimals ?? 18 };
  const [symbolRaw, nameRaw, decimalsRaw] = await Promise.all([
    safeProviderCall(provider, token, ERC20.encodeFunctionData("symbol", [])),
    safeProviderCall(provider, token, ERC20.encodeFunctionData("name", [])),
    safeProviderCall(provider, token, ERC20.encodeFunctionData("decimals", [])),
  ]);
  return {
    address: token,
    symbol: decodeStringResult(symbolRaw, "symbol") || fallback.symbol || null,
    name: decodeStringResult(nameRaw, "name") || fallback.name || null,
    decimals: Number(decodeUintResult(decimalsRaw, "decimals") ?? BigInt(fallback.decimals ?? 18)),
  };
}

async function erc20Balance(provider, token, account) {
  const raw = await safeProviderCall(provider, token, ERC20.encodeFunctionData("balanceOf", [account]));
  return decodeUintResult(raw, "balanceOf") || 0n;
}

async function fetchEthUsd() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch("https://coins.llama.fi/prices/current/coingecko:ethereum?searchWidth=6h", { signal: controller.signal });
    const json = await res.json();
    return Number(json?.coins?.["coingecko:ethereum"]?.price || 0) || null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function scanBendDao(provider, ethUsd) {
  const [reservesRaw, nftsRaw, bnftAssetsRaw] = await Promise.all([
    safeProviderCall(provider, BENDDAO.UiPoolDataProvider, UI_POOL.encodeFunctionData("getSimpleReservesData", [BENDDAO.LendPoolAddressProvider])),
    safeProviderCall(provider, BENDDAO.UiPoolDataProvider, UI_POOL.encodeFunctionData("getSimpleNftsData", [BENDDAO.LendPoolAddressProvider])),
    safeProviderCall(provider, BENDDAO.BNFTRegistry, BNFT_REGISTRY.encodeFunctionData("getBNFTAssetList", [])),
  ]);
  const reserves = decodeResult(reservesRaw, UI_POOL, "getSimpleReservesData")?.[0] || [];
  const nfts = decodeResult(nftsRaw, UI_POOL, "getSimpleNftsData")?.[0] || [];
  const bnftAssets = (decodeResult(bnftAssetsRaw, BNFT_REGISTRY, "getBNFTAssetList")?.[0] || []).map(normalizeAddress).filter(Boolean);
  const bnftProxies = {};
  for (const asset of bnftAssets) {
    const raw = await safeProviderCall(provider, BENDDAO.BNFTRegistry, BNFT_REGISTRY.encodeFunctionData("bNftProxys", [asset]));
    bnftProxies[asset.toLowerCase()] = normalizeAddress(decodeResult(raw, BNFT_REGISTRY, "bNftProxys")?.[0]);
  }

  const reserveRows = [];
  let totalAvailableLiquidityEth = 0;
  for (const reserve of reserves) {
    const underlying = normalizeAddress(reserve.underlyingAsset);
    const decimals = Number(reserve.decimals || 18n);
    const available = formatUnitsNumber(reserve.availableLiquidity, decimals) || 0;
    const debt = formatUnitsNumber(reserve.totalVariableDebt, decimals) || 0;
    const priceInEth = Number(reserve.priceInEth || 0n) / 1e18;
    const availableEth = available * priceInEth;
    totalAvailableLiquidityEth += availableEth;
    reserveRows.push({
      protocol: "BendDAO",
      kind: "reserve",
      chainId: CHAIN_ID,
      chain: "Ethereum",
      underlyingAsset: underlying,
      name: reserve.name,
      symbol: reserve.symbol,
      decimals,
      borrowingEnabled: Boolean(reserve.borrowingEnabled),
      isActive: Boolean(reserve.isActive),
      isFrozen: Boolean(reserve.isFrozen),
      bTokenAddress: normalizeAddress(reserve.bTokenAddress),
      debtTokenAddress: normalizeAddress(reserve.debtTokenAddress),
      availableLiquidity: round(available, 6),
      availableLiquidityEth: round(availableEth, 6),
      availableLiquidityUsd: round(availableEth * (ethUsd || 0), 2),
      totalVariableDebt: round(debt, 6),
      priceInEth: round(priceInEth, 8),
      watchCandidate: false,
      routePositive: false,
    });
  }

  const nftRows = [];
  for (const nft of nfts) {
    const collection = normalizeAddress(nft.underlyingAsset);
    const ltv = Number(nft.ltv || 0n) / 1e4;
    const lt = Number(nft.liquidationThreshold || 0n) / 1e4;
    const priceInEth = Number(nft.priceInEth || 0n) / 1e18;
    const totalCollateral = Number(nft.totalCollateral || 0n);
    const floorUsd = priceInEth * (ethUsd || 0);
    const routeBorrowLiquidityUsd = totalAvailableLiquidityEth * (ethUsd || 0);
    const highLtv = ltv >= MIN_LTV;
    const materialBorrowLiquidity = routeBorrowLiquidityUsd >= MIN_BORROW_LIQUIDITY_USD;
    const active = Boolean(nft.isActive) && !Boolean(nft.isFrozen);
    nftRows.push({
      protocol: "BendDAO",
      kind: "nft-collateral",
      chainId: CHAIN_ID,
      chain: "Ethereum",
      collection,
      name: nft.name,
      symbol: nft.symbol,
      bNftAddress: normalizeAddress(nft.bNftAddress) || bnftProxies[collection?.toLowerCase?.()] || null,
      ltv,
      liquidationThreshold: lt,
      liquidationBonus: Number(nft.liquidationBonus || 0n) / 1e4,
      redeemDuration: String(nft.redeemDuration || 0n),
      auctionDuration: String(nft.auctionDuration || 0n),
      isActive: Boolean(nft.isActive),
      isFrozen: Boolean(nft.isFrozen),
      oraclePriceEth: round(priceInEth, 8),
      oraclePriceUsd: round(floorUsd, 2),
      totalCollateral,
      routeBorrowLiquidityUsd: round(routeBorrowLiquidityUsd, 2),
      highLtv,
      materialBorrowLiquidity,
      watchCandidate: highLtv && materialBorrowLiquidity && active,
      routePositive: false,
      blockers: [
        highLtv && materialBorrowLiquidity && active ? "Watch-only: needs exact marketplace acquisition/resale floor spread and borrow route" : null,
        !active ? "Collection inactive or frozen" : null,
        !highLtv ? `NFT LTV below ${MIN_LTV}` : null,
        !materialBorrowLiquidity ? `Borrow liquidity below $${MIN_BORROW_LIQUIDITY_USD}` : null,
        "No exact NFT acquisition, borrow, resale/unwind economics, or fork proof",
      ].filter(Boolean),
    });
  }
  return { reserveRows, nftRows, stats: { reservesScanned: reserveRows.length, nftsScanned: nftRows.length, bnftAssets: bnftAssets.length } };
}

async function scanNftfi(provider) {
  const rows = [];
  for (const owner of NFTFI.owners) {
    const code = await provider.getCode(owner).catch(() => "0x");
    rows.push({
      protocol: "NFTfi",
      kind: "p2p-vault-owner",
      chainId: CHAIN_ID,
      chain: "Ethereum",
      owner: normalizeAddress(owner),
      codeBytes: code && code !== "0x" ? Math.max(0, (code.length - 2) / 2) : 0,
      pooledBorrowLiquidity: false,
      watchCandidate: false,
      routePositive: false,
      blockers: [
        "NFTfi adapter exposes NFT vault owner contracts, not pooled borrow liquidity",
        "Peer-to-peer loan matching is not an atomic flash-compatible borrow pool from this scan",
        "No exact marketplace acquisition/loan/resale route or fork proof",
      ],
    });
  }
  return rows;
}

function summarizeRows(rows) {
  const out = { byProtocol: {}, byKind: {} };
  for (const row of rows || []) {
    out.byProtocol[row.protocol] = (out.byProtocol[row.protocol] || 0) + 1;
    out.byKind[row.kind] = (out.byKind[row.kind] || 0) + 1;
  }
  return out;
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rpc = await resolveRpcUrl(CHAIN_ID);
  if (!rpc) throw new Error("No Ethereum RPC endpoint resolved from local inventory");
  const provider = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
  const [blockNumber, ethUsd] = await Promise.all([provider.getBlockNumber().catch(() => null), fetchEthUsd()]);
  const [bend, nftfiRows] = await Promise.all([scanBendDao(provider, ethUsd), scanNftfi(provider)]);
  const rows = [...bend.nftRows, ...bend.reserveRows, ...nftfiRows];
  const watchRows = rows.filter((row) => row.watchCandidate);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-nft-lending-oracle-routes.js",
    scope: "Read-only NFT lending oracle route scan over BendDAO pooled NFT collateral and NFTfi vault metadata",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    chain: { chainId: CHAIN_ID, name: "Ethereum", blockNumber },
    thresholds: {
      minLtv: MIN_LTV,
      minBorrowLiquidityUsd: MIN_BORROW_LIQUIDITY_USD,
    },
    prices: { ethUsd },
    summary: {
      bendReservesScanned: bend.stats.reservesScanned,
      bendNftsScanned: bend.stats.nftsScanned,
      bendBnftAssets: bend.stats.bnftAssets,
      nftfiVaultOwners: nftfiRows.length,
      rowsScanned: rows.length,
      highLtvRows: bend.nftRows.filter((row) => row.highLtv).length,
      watchCandidates: watchRows.length,
      routePositive: 0,
      signedActionJustified: false,
      breakdown: summarizeRows(rows),
    },
    topRows: rows.slice().sort((a, b) => Number(b.watchCandidate) - Number(a.watchCandidate) || Number(b.routeBorrowLiquidityUsd || 0) - Number(a.routeBorrowLiquidityUsd || 0)).slice(0, 80),
    rows,
    nextRoutePositiveCriteria: [
      "NFT collection is active collateral with material pooled borrow liquidity",
      "oracle floor materially exceeds exact marketplace acquisition and resale/unwind value",
      "loan/borrow path is permissionless and executable for the exact collection/token size",
      "gas/slippage/marketplace-fee adjusted economics are positive",
      "local fork extraction proof measures positive net value",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  console.log(`NFT lending oracle routes: rows=${artifact.summary.rowsScanned} highLtv=${artifact.summary.highLtvRows} watch=${artifact.summary.watchCandidates} routePositive=0`);
  if (!QUIET) console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
