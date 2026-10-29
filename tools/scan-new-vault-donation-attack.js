#!/usr/bin/env node
// Read-only new/low-TVL ERC4626 donation-inflation route scanner.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const VAULT_INVENTORY = path.join(WORKSPACE, "reports", "monitor", "vault-inventory.json");
const E15_ROUTES = path.join(WORKSPACE, "reports", "raw", "fast", "e15-vault-donation-routes.json");
const ERC4626_JOINER = path.join(WORKSPACE, "reports", "raw", "fast", "erc4626-consumer-joiner.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "new-vault-donation-attack.json");

const LOOKBACK_BLOCKS = Number(process.env.NEW_VAULT_DONATION_LOOKBACK_BLOCKS || "100000");
const MAX_INVENTORY_PER_CHAIN = Number(process.env.NEW_VAULT_DONATION_MAX_INVENTORY_PER_CHAIN || "80");
const MAX_CANDIDATES_PER_CHAIN = Number(process.env.NEW_VAULT_DONATION_MAX_CANDIDATES_PER_CHAIN || "140");
const LOW_TVL_USD = Number(process.env.NEW_VAULT_DONATION_LOW_TVL_USD || "10000");
const TINY_TVL_USD = Number(process.env.NEW_VAULT_DONATION_TINY_TVL_USD || "1000");
const MIN_LIQUIDITY_USD = Number(process.env.NEW_VAULT_DONATION_MIN_LIQUIDITY_USD || "1000");
const GAS_USD = Number(process.env.NEW_VAULT_DONATION_GAS_USD || "3");
const MIN_PROFIT_USD = Number(process.env.NEW_VAULT_DONATION_MIN_PROFIT_USD || "25");

const FACTORIES = {
  1: {
    name: "Ethereum",
    address: "0xA1D94F746dEfa1928926b84fB2596c06926C0405",
    deployTopic: "0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e",
    vaultTopicIndex: 3,
  },
  8453: {
    name: "Base",
    address: "0x4501125508079A99ebBebCE205DeC9593C2b5857",
    deployTopic: "0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e",
    vaultTopicIndex: 3,
  },
};

const MORPHO = {
  1: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  8453: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
};

const CREATE_MARKET_TOPIC = "0x8a41cabf57f8c9e58b85a041c8b6e82af3eb44c2a21833c0f03a639b5bcb1c49";
const ETH_USD_FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const STABLES = new Set([
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
  "0xdc035d45d973e3ec169d2276ddab16f1e407384f", // USDS
  "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f", // GHO
  "0x8292bb45bf1ee4d140127049757c2e0ff06317ed", // RLUSD
  "0x833589fcd6edb6e08f4c7c32d4f71b54bdA02913".toLowerCase(), // Base USDC
]);

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const MORPHO_IFACE = new ethers.Interface([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
]);
const CHAINLINK = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 12_000) {
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
  const pool = {};
  for (const url of loadRpcUrls()) {
    try {
      const idHex = await rpcCall(url, "eth_chainId", [], 6000);
      const chainId = Number(BigInt(idHex));
      if (chainIds.includes(chainId) && !pool[chainId]) pool[chainId] = url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return pool;
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function lowerAddress(value) {
  const addr = normalizeAddress(value);
  return addr ? addr.toLowerCase() : null;
}

function sameAddress(a, b) {
  const aa = lowerAddress(a);
  const bb = lowerAddress(b);
  return Boolean(aa && bb && aa === bb);
}

function round(value, decimals = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function human(raw, decimals) {
  try { return Number(ethers.formatUnits(BigInt(raw || 0), Number(decimals ?? 18))); } catch (_) { return null; }
}

function decodeAddressTopic(word) {
  if (!word || String(word).length < 66) return null;
  return normalizeAddress(`0x${String(word).slice(-40)}`);
}

async function safeCall(provider, to, data) {
  try { return await provider.call({ to, data }); } catch (_) { return null; }
}

function decodeResult(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

async function tokenMeta(provider, token) {
  const addr = normalizeAddress(token);
  if (!addr) return null;
  const [symRaw, nameRaw, decRaw] = await Promise.all([
    safeCall(provider, addr, ERC20.encodeFunctionData("symbol", [])),
    safeCall(provider, addr, ERC20.encodeFunctionData("name", [])),
    safeCall(provider, addr, ERC20.encodeFunctionData("decimals", [])),
  ]);
  const symbol = decodeResult(symRaw, ERC20, "symbol")?.[0] || null;
  const name = decodeResult(nameRaw, ERC20, "name")?.[0] || null;
  const decimals = Number(decodeResult(decRaw, ERC20, "decimals")?.[0] ?? 18);
  return { address: addr, symbol, name, decimals };
}

async function ethUsd(provider) {
  const [roundRaw, decRaw] = await Promise.all([
    safeCall(provider, ETH_USD_FEED, CHAINLINK.encodeFunctionData("latestRoundData", [])),
    safeCall(provider, ETH_USD_FEED, CHAINLINK.encodeFunctionData("decimals", [])),
  ]);
  try {
    const dec = decRaw ? Number(CHAINLINK.decodeFunctionResult("decimals", decRaw)[0]) : 8;
    const [, answer] = CHAINLINK.decodeFunctionResult("latestRoundData", roundRaw);
    return Number(answer) / 10 ** dec;
  } catch (_) {
    return null;
  }
}

function priceFor(meta, ethPrice) {
  const addr = lowerAddress(meta?.address);
  if (!addr) return null;
  if (STABLES.has(addr)) return 1;
  if (addr === WETH.toLowerCase() || addr === BASE_WETH.toLowerCase()) return ethPrice || null;
  const sym = String(meta?.symbol || "").toUpperCase();
  if (/^(USDC|USDT|DAI|USDS|GHO|RLUSD|CRVUSD|USD0|USDE)$/.test(sym)) return 1;
  return null;
}

function addCandidate(map, row) {
  const chainId = Number(row.chainId);
  const address = normalizeAddress(row.address || row.vault);
  if (!chainId || !address) return;
  const key = `${chainId}:${address.toLowerCase()}`;
  const prev = map.get(key) || { chainId, address, sources: [], deployBlock: null, sourceDetails: [] };
  prev.sources.push(row.source);
  if (row.deployBlock && (!prev.deployBlock || Number(row.deployBlock) > prev.deployBlock)) prev.deployBlock = Number(row.deployBlock);
  if (row.detail) prev.sourceDetails.push(row.detail);
  map.set(key, prev);
}

function collectArtifactCandidates() {
  const candidates = new Map();
  const inventory = readJson(VAULT_INVENTORY, {});
  for (const [chainIdText, chain] of Object.entries(inventory.chains || {})) {
    const chainId = Number(chainIdText);
    const vaults = (chain.vaults || [])
      .filter((v) => v.address && (v.flag || asNumber(v.totalAssets) < LOW_TVL_USD))
      .sort((a, b) => (Number(b.deployBlock) || 0) - (Number(a.deployBlock) || 0))
      .slice(0, MAX_INVENTORY_PER_CHAIN);
    for (const vault of vaults) {
      addCandidate(candidates, { chainId, address: vault.address, deployBlock: vault.deployBlock, source: "vault-inventory-low-tvl", detail: { flag: vault.flag || null, inventoryTotalAssets: vault.totalAssets ?? null } });
    }
  }

  const e15 = readJson(E15_ROUTES, {});
  for (const row of e15.rows || []) {
    addCandidate(candidates, {
      chainId: row.chainId || row.alert?.chainId || 1,
      address: row.vault?.address || row.alert?.vault,
      deployBlock: row.alert?.deployBlock,
      source: "e15-high-alert",
      detail: { symbol: row.vault?.symbol || null, maxDeposit: row.vault?.maxDeposit ?? null, blockers: row.blockers || [] },
    });
  }

  const joiner = readJson(ERC4626_JOINER, {});
  for (const result of joiner.results || []) {
    for (const candidate of result.topCandidates || []) {
      addCandidate(candidates, {
        chainId: candidate.chainId || result.chainId,
        address: candidate.vault?.address,
        deployBlock: candidate.vault?.deployBlock,
        source: "erc4626-consumer-joiner",
        detail: { type: candidate.type, reason: candidate.reason, market: candidate.market || null, blockers: candidate.blockers || [] },
      });
    }
  }
  return candidates;
}

async function scanRecentFactoryVaults(provider, chainId, candidates) {
  const cfg = FACTORIES[chainId];
  if (!cfg) return [];
  const latest = await provider.getBlockNumber();
  const fromStart = Math.max(1, latest - LOOKBACK_BLOCKS);
  const found = [];
  for (let fromBlock = fromStart; fromBlock <= latest; fromBlock += 10000) {
    const toBlock = Math.min(latest, fromBlock + 9999);
    const logs = await provider.getLogs({ address: cfg.address, topics: [cfg.deployTopic], fromBlock, toBlock }).catch(() => []);
    for (const log of logs) {
      const vault = decodeAddressTopic(log.topics?.[cfg.vaultTopicIndex]);
      if (!vault) continue;
      found.push({ address: vault, deployBlock: Number(log.blockNumber), txHash: log.transactionHash });
      addCandidate(candidates, { chainId, address: vault, deployBlock: Number(log.blockNumber), source: "recent-factory-deploy", detail: { txHash: log.transactionHash } });
    }
  }
  return found;
}

async function readVault(provider, chainId, candidate, ethPrice) {
  const address = normalizeAddress(candidate.address);
  const [assetRaw, totalAssetsRaw, totalSupplyRaw, shareDecRaw, symRaw, nameRaw, maxDepositRaw] = await Promise.all([
    safeCall(provider, address, ERC4626.encodeFunctionData("asset", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("totalAssets", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("totalSupply", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("decimals", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("symbol", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("name", [])),
    safeCall(provider, address, ERC4626.encodeFunctionData("maxDeposit", [ethers.ZeroAddress])),
  ]);
  const asset = decodeResult(assetRaw, ERC4626, "asset")?.[0] || null;
  const assetMeta = asset ? await tokenMeta(provider, asset) : null;
  const shareDecimals = Number(decodeResult(shareDecRaw, ERC4626, "decimals")?.[0] ?? 18);
  const symbol = decodeResult(symRaw, ERC4626, "symbol")?.[0] || null;
  const name = decodeResult(nameRaw, ERC4626, "name")?.[0] || null;
  const totalAssetsValue = decodeResult(totalAssetsRaw, ERC4626, "totalAssets")?.[0] ?? null;
  const totalSupplyValue = decodeResult(totalSupplyRaw, ERC4626, "totalSupply")?.[0] ?? null;
  const maxDepositValue = decodeResult(maxDepositRaw, ERC4626, "maxDeposit")?.[0] ?? null;
  const totalAssets = assetMeta && totalAssetsValue !== null ? human(totalAssetsValue, assetMeta.decimals) : null;
  const totalSupply = totalSupplyValue !== null ? human(totalSupplyValue, shareDecimals) : null;
  const maxDeposit = assetMeta && maxDepositValue !== null ? human(maxDepositValue, assetMeta.decimals) : null;
  const oneShare = 10n ** BigInt(Math.min(shareDecimals, 36));
  const oneShareAssetsRaw = await safeCall(provider, address, ERC4626.encodeFunctionData("convertToAssets", [oneShare]));
  const oneShareAssetsValue = decodeResult(oneShareAssetsRaw, ERC4626, "convertToAssets")?.[0] ?? null;
  const oneShareAssets = assetMeta && oneShareAssetsValue !== null ? human(oneShareAssetsValue, assetMeta.decimals) : null;
  const assetPriceUsd = priceFor(assetMeta, ethPrice);
  const totalAssetsUsd = totalAssets !== null && assetPriceUsd !== null ? totalAssets * assetPriceUsd : null;
  return {
    chainId,
    chain: FACTORIES[chainId]?.name || String(chainId),
    address,
    deployBlock: candidate.deployBlock || null,
    sources: [...new Set(candidate.sources || [])],
    symbol,
    name,
    asset: assetMeta,
    shareDecimals,
    totalAssetsRaw: totalAssetsValue !== null ? totalAssetsValue.toString() : null,
    totalSupplyRaw: totalSupplyValue !== null ? totalSupplyValue.toString() : null,
    totalAssets: round(totalAssets, 12),
    totalSupply: round(totalSupply, 12),
    oneShareAssets: round(oneShareAssets, 12),
    assetPriceUsd: round(assetPriceUsd, 6),
    totalAssetsUsd: round(totalAssetsUsd, 6),
    maxDeposit: round(maxDeposit, 6),
    sourceDetails: candidate.sourceDetails || [],
  };
}

function decodeCreateMarket(log) {
  const data = String(log.data || "0x").slice(2);
  if (data.length < 320) return null;
  try {
    return {
      marketId: log.topics?.[1] || null,
      txHash: log.transactionHash,
      blockNumber: Number(log.blockNumber),
      loanToken: ethers.getAddress(`0x${data.slice(24, 64)}`),
      collateralToken: ethers.getAddress(`0x${data.slice(88, 128)}`),
      oracle: ethers.getAddress(`0x${data.slice(152, 192)}`),
      irm: ethers.getAddress(`0x${data.slice(216, 256)}`),
      lltvRaw: BigInt(`0x${data.slice(256, 320)}`).toString(),
    };
  } catch (_) {
    return null;
  }
}

async function readMorphoMarket(provider, marketId, loanToken, ethPrice) {
  const meta = await tokenMeta(provider, loanToken);
  const priceUsd = priceFor(meta, ethPrice);
  let market = null;
  try {
    const raw = await provider.call({ to: MORPHO[Number(provider._network?.chainId || 0)] || MORPHO[1], data: MORPHO_IFACE.encodeFunctionData("market", [marketId]) });
    const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = MORPHO_IFACE.decodeFunctionResult("market", raw);
    const supply = meta ? human(totalSupplyAssets, meta.decimals) : null;
    const borrow = meta ? human(totalBorrowAssets, meta.decimals) : null;
    const liquidity = supply !== null && borrow !== null ? Math.max(0, supply - borrow) : null;
    market = {
      totalSupplyAssets: totalSupplyAssets.toString(),
      totalSupplyShares: totalSupplyShares.toString(),
      totalBorrowAssets: totalBorrowAssets.toString(),
      totalBorrowShares: totalBorrowShares.toString(),
      lastUpdate: lastUpdate.toString(),
      fee: fee.toString(),
      supplyAssets: round(supply, 6),
      borrowAssets: round(borrow, 6),
      liquidityAssets: round(liquidity, 6),
      liquidityUsd: liquidity !== null && priceUsd !== null ? round(liquidity * priceUsd, 6) : null,
    };
  } catch (_) {}
  return { loanAsset: meta, loanAssetPriceUsd: round(priceUsd, 6), market };
}

async function scanRecentMorphoMarkets(provider, chainId, vaultRows, ethPrice) {
  const morpho = MORPHO[chainId];
  if (!morpho) return new Map();
  const latest = await provider.getBlockNumber();
  const fromStart = Math.max(1, latest - LOOKBACK_BLOCKS);
  const wanted = new Set(vaultRows.map((row) => row.address.toLowerCase()));
  const matches = new Map();
  for (let fromBlock = fromStart; fromBlock <= latest; fromBlock += 10000) {
    const toBlock = Math.min(latest, fromBlock + 9999);
    const logs = await provider.getLogs({ address: morpho, topics: [CREATE_MARKET_TOPIC], fromBlock, toBlock }).catch(() => []);
    for (const log of logs) {
      const decoded = decodeCreateMarket(log);
      if (!decoded) continue;
      const side = wanted.has(decoded.collateralToken.toLowerCase())
        ? "collateralAsset"
        : wanted.has(decoded.loanToken.toLowerCase())
          ? "loanAsset"
          : null;
      if (!side) continue;
      const vault = side === "collateralAsset" ? decoded.collateralToken : decoded.loanToken;
      const live = await readMorphoMarket(provider, decoded.marketId, decoded.loanToken, ethPrice);
      const row = {
        type: "morpho-blue-recent-market",
        side,
        reason: `vault is Morpho ${side}`,
        marketId: decoded.marketId,
        loanToken: decoded.loanToken,
        collateralToken: decoded.collateralToken,
        oracle: decoded.oracle,
        irm: decoded.irm,
        lltvRaw: decoded.lltvRaw,
        lltvPct: round(Number(BigInt(decoded.lltvRaw)) / 1e16, 4),
        blockNumber: decoded.blockNumber,
        txHash: decoded.txHash,
        loanAsset: live.loanAsset,
        loanAssetPriceUsd: live.loanAssetPriceUsd,
        market: live.market,
      };
      const key = vault.toLowerCase();
      matches.set(key, [...(matches.get(key) || []), row]);
    }
  }
  return matches;
}

function consumerMatchesFromArtifacts(vaultRow) {
  const out = [];
  for (const detail of vaultRow.sourceDetails || []) {
    const market = detail.market;
    if (!market) continue;
    out.push({
      type: detail.type || "artifact-consumer",
      side: detail.reason?.includes("loan") ? "loanAsset" : "collateralAsset",
      reason: detail.reason || "consumer artifact match",
      marketId: market.marketId || null,
      loanAsset: market.loanAsset || null,
      collateralAsset: market.collateralAsset || null,
      oracle: market.oracle?.address || market.oracle || null,
      lltvPct: asNumber(market.lltvPct),
      market: {
        liquidityUsd: asNumber(market.liquidityAssetsUsd),
        supplyAssetsUsd: asNumber(market.supplyAssetsUsd),
        borrowAssetsUsd: asNumber(market.borrowAssetsUsd),
        utilization: asNumber(market.utilization),
      },
      blockers: detail.blockers || [],
    });
  }
  return out;
}

function donationScenarios(vault, consumers) {
  const totalAssetsUsd = asNumber(vault.totalAssetsUsd);
  if (totalAssetsUsd === null) return [];
  const relevant = consumers.filter((c) => c.side === "collateralAsset");
  const scenarios = [];
  for (const consumer of relevant.length ? relevant : [{ lltvPct: null, market: {} }]) {
    const lltv = (asNumber(consumer.lltvPct) || 0) / 100;
    for (const seedUsd of [1, 10, 25, 100]) {
      for (const donationUsd of [10, 25, 100, 1000]) {
        const ownership = totalAssetsUsd <= 0 ? 1 : seedUsd / (totalAssetsUsd + seedUsd);
        const collateralValueUsd = seedUsd + donationUsd * ownership;
        const borrowableUsd = lltv > 0 ? collateralValueUsd * lltv : 0;
        const liquidityUsd = asNumber(consumer.market?.liquidityUsd);
        const cappedBorrowableUsd = liquidityUsd !== null ? Math.min(borrowableUsd, liquidityUsd) : borrowableUsd;
        const costUsd = seedUsd + donationUsd;
        const netUsd = cappedBorrowableUsd - costUsd - GAS_USD;
        scenarios.push({
          consumerType: consumer.type || null,
          marketId: consumer.marketId || null,
          seedUsd,
          donationUsd,
          ownershipPct: round(ownership * 100, 6),
          rateInflationBps: round(totalAssetsUsd <= 0 ? null : donationUsd / (totalAssetsUsd + seedUsd) * 10000, 4),
          collateralValueUsd: round(collateralValueUsd, 6),
          lltvPct: round(lltv * 100, 4),
          borrowableUsd: round(cappedBorrowableUsd, 6),
          costUsd: round(costUsd, 6),
          gasUsd: GAS_USD,
          netUsd: round(netUsd, 6),
        });
      }
    }
  }
  return scenarios.sort((a, b) => (b.netUsd || -Infinity) - (a.netUsd || -Infinity)).slice(0, 8);
}

function classifyRow(vault, consumers, scenarios) {
  const totalAssetsUsd = asNumber(vault.totalAssetsUsd);
  const maxDeposit = asNumber(vault.maxDeposit);
  const consumerLinked = consumers.length > 0;
  const collateralConsumer = consumers.some((c) => c.side === "collateralAsset");
  const liquidityUsd = Math.max(0, ...consumers.map((c) => asNumber(c.market?.liquidityUsd) || 0));
  const bestNetUsd = scenarios[0]?.netUsd ?? null;
  const depositOpen = maxDeposit === null ? null : maxDeposit > 0;
  const lowTvl = totalAssetsUsd !== null && totalAssetsUsd <= LOW_TVL_USD;
  const tinyTvl = totalAssetsUsd !== null && totalAssetsUsd <= TINY_TVL_USD;
  const preforkDonationPositive = bestNetUsd !== null && bestNetUsd > MIN_PROFIT_USD && collateralConsumer && liquidityUsd >= MIN_LIQUIDITY_USD;
  const watchCandidate = Boolean(
    consumerLinked
    && collateralConsumer
    && lowTvl
    && liquidityUsd >= MIN_LIQUIDITY_USD
  );
  const blockers = [];
  if (!consumerLinked) blockers.push("No lending/oracle consumer linked to vault shares in scanned artifacts or recent Morpho markets");
  if (consumerLinked && !collateralConsumer) blockers.push("Vault is not currently a collateral-side consumer in scanned markets");
  if (totalAssetsUsd === null) blockers.push("Vault TVL cannot be priced in USD with current local price map");
  if (!lowTvl) blockers.push("Vault is not currently low-TVL enough for cheap donation ownership");
  if (depositOpen === false) blockers.push("maxDeposit is zero, so fresh public share acquisition is currently closed");
  if (liquidityUsd < MIN_LIQUIDITY_USD) blockers.push("Borrow-side liquidity below low-capital route threshold");
  if (bestNetUsd !== null && bestNetUsd <= MIN_PROFIT_USD) blockers.push("Modeled fair ERC4626 donation economics remain negative after LLTV, cost, and gas");
  blockers.push("Requires local fork proof before routePositive because pure donation models can miss ERC4626/oracle implementation details");
  return { lowTvl, tinyTvl, depositOpen, consumerLinked, collateralConsumer, liquidityUsd: round(liquidityUsd, 6), bestNetUsd, preforkDonationPositive, watchCandidate, routePositive: false, blockers };
}

async function main() {
  const candidateMap = collectArtifactCandidates();
  const rpcs = await resolveRpcPool([1, 8453]);
  const providers = Object.fromEntries(Object.entries(rpcs).map(([chainId, rpc]) => [Number(chainId), new ethers.JsonRpcProvider(rpc, Number(chainId), { staticNetwork: true })]));
  const recentFactoryVaults = {};

  for (const [chainIdText, provider] of Object.entries(providers)) {
    const chainId = Number(chainIdText);
    recentFactoryVaults[chainId] = await scanRecentFactoryVaults(provider, chainId, candidateMap);
  }

  const rows = [];
  const chains = {};
  for (const [chainIdText, cfg] of Object.entries(FACTORIES)) {
    const chainId = Number(chainIdText);
    const provider = providers[chainId];
    const chainCandidates = [...candidateMap.values()]
      .filter((row) => row.chainId === chainId)
      .sort((a, b) => {
        const aw = a.sources.includes("erc4626-consumer-joiner") ? 4 : a.sources.includes("e15-high-alert") ? 3 : a.sources.includes("recent-factory-deploy") ? 2 : 1;
        const bw = b.sources.includes("erc4626-consumer-joiner") ? 4 : b.sources.includes("e15-high-alert") ? 3 : b.sources.includes("recent-factory-deploy") ? 2 : 1;
        return (bw - aw) || ((b.deployBlock || 0) - (a.deployBlock || 0));
      })
      .slice(0, MAX_CANDIDATES_PER_CHAIN);
    chains[chainId] = { chain: cfg.name, rpcResolved: Boolean(provider), candidatesInput: chainCandidates.length, recentFactoryVaults: recentFactoryVaults[chainId]?.length || 0 };
    if (!provider) continue;
    const ethPrice = chainId === 1 ? await ethUsd(provider) : null;
    const liveVaults = [];
    for (const candidate of chainCandidates) {
      try {
        const live = await readVault(provider, chainId, candidate, ethPrice);
        if (live.asset?.address) liveVaults.push(live);
      } catch (_) {}
    }
    const recentMorpho = await scanRecentMorphoMarkets(provider, chainId, liveVaults, ethPrice);
    for (const vault of liveVaults) {
      const artifactConsumers = consumerMatchesFromArtifacts(vault);
      const liveConsumers = recentMorpho.get(vault.address.toLowerCase()) || [];
      const consumers = [...artifactConsumers, ...liveConsumers];
      const scenarios = donationScenarios(vault, consumers);
      const classification = classifyRow(vault, consumers, scenarios);
      rows.push({
        chainId,
        chain: cfg.name,
        vault,
        consumers,
        scenarios,
        ...classification,
      });
    }
    chains[chainId].liveRows = liveVaults.length;
  }

  rows.sort((a, b) => {
    const aw = (a.watchCandidate ? 100 : 0) + (a.consumerLinked ? 20 : 0) + (a.tinyTvl ? 10 : 0) + Math.max(0, asNumber(a.bestNetUsd) || -999999) / 1000;
    const bw = (b.watchCandidate ? 100 : 0) + (b.consumerLinked ? 20 : 0) + (b.tinyTvl ? 10 : 0) + Math.max(0, asNumber(b.bestNetUsd) || -999999) / 1000;
    return bw - aw;
  });

  const summary = {
    candidateVaults: candidateMap.size,
    liveRows: rows.length,
    recentFactoryVaults: Object.values(recentFactoryVaults).reduce((sum, arr) => sum + arr.length, 0),
    consumerLinkedRows: rows.filter((r) => r.consumerLinked).length,
    collateralConsumerRows: rows.filter((r) => r.collateralConsumer).length,
    lowTvlRows: rows.filter((r) => r.lowTvl).length,
    tinyTvlRows: rows.filter((r) => r.tinyTvl).length,
    lowTvlConsumerRows: rows.filter((r) => r.lowTvl && r.consumerLinked).length,
    depositOpenRows: rows.filter((r) => r.depositOpen === true).length,
    watchCandidates: rows.filter((r) => r.watchCandidate).length,
    preforkDonationPositive: rows.filter((r) => r.preforkDonationPositive).length,
    routePositive: 0,
    signedActionJustified: false,
    bestModeledNetUsd: round(Math.max(...rows.map((r) => asNumber(r.bestNetUsd) ?? -Infinity)), 6),
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-new-vault-donation-attack.js",
    scope: "Read-only new/low-TVL ERC4626 donation-inflation route scanner",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    thresholds: {
      lookbackBlocks: LOOKBACK_BLOCKS,
      maxInventoryPerChain: MAX_INVENTORY_PER_CHAIN,
      maxCandidatesPerChain: MAX_CANDIDATES_PER_CHAIN,
      lowTvlUsd: LOW_TVL_USD,
      tinyTvlUsd: TINY_TVL_USD,
      minLiquidityUsd: MIN_LIQUIDITY_USD,
      gasUsd: GAS_USD,
      minProfitUsd: MIN_PROFIT_USD,
    },
    sourceArtifacts: {
      vaultInventory: "reports/monitor/vault-inventory.json",
      e15Routes: "reports/raw/fast/e15-vault-donation-routes.json",
      erc4626Joiner: "reports/raw/fast/erc4626-consumer-joiner.json",
    },
    chains,
    summary,
    topRows: rows.slice(0, 25),
    rows,
    requiredForRoutePositive: [
      "low/new ERC4626 vault has public share acquisition or another exact acquisition route",
      "vault share token is accepted as collateral by a liquid lending consumer",
      "accepted borrow value exceeds seed + donation + fees + gas after LLTV haircut",
      "local fork proof demonstrates extractable net profit",
    ],
    nextReadOnlyStep: summary.watchCandidates > 0
      ? "Fork-test only the top consumer-linked low-TVL row if exact acquisition and borrow/exit economics can be made positive."
      : "Keep monitoring new vault deployments and rerun when a low-TVL vault gains a liquid lending consumer or maxDeposit reopens.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  console.log(`New-vault donation attack scan: rows=${summary.liveRows} consumers=${summary.consumerLinkedRows} lowTvlConsumers=${summary.lowTvlConsumerRows} watch=${summary.watchCandidates} routePositive=0`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT)}`);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exitCode = 1;
});
