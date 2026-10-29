#!/usr/bin/env node
// Read-only RWA/stable consumer joiner for Falcon USDf/sUSDf and local
// Centrifuge context. RPC URLs are resolved in memory only and never printed.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "rwa-stable-consumer-routes.json");

const FILES = {
  curveStablecoinLive: path.join(WORKSPACE, "reports", "raw", "fast", "curve-stablecoin-live.json"),
  curveStablecoinCandidates: path.join(WORKSPACE, "reports", "raw", "fast", "curve-stablecoin-candidates.json"),
  skyLendingLive: path.join(WORKSPACE, "reports", "raw", "fast", "sky-lending-live.json"),
  targetDiscovery: path.join(WORKSPACE, "reports", "raw", "fast", "defillama-eigenphi-target-discovery.json"),
  siloAddresses: path.join(WORKSPACE, "targets", "silo-contracts-v2", "common", "addresses", "mainnet.json"),
  siloDeployments: path.join(WORKSPACE, "targets", "silo-contracts-v2", "silo-core", "deploy", "silo", "_siloDeployments.json"),
  siloInputs: path.join(WORKSPACE, "targets", "silo-contracts-v2", "silo-core", "deploy", "input", "mainnet"),
};

const ETHEREUM = {
  chainId: 1,
  chain: "Ethereum",
  coinSlug: "ethereum",
  aavePool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
};

const THRESHOLDS = {
  routeLiquidityUsd: Number(process.env.RWA_ROUTE_LIQUIDITY_USD || "10000"),
  maxMorphoMarkets: Number(process.env.RWA_MAX_MORPHO_MARKETS || "100"),
  producerDivergenceBps: Number(process.env.RWA_PRODUCER_DIVERGENCE_BPS || "100"),
};

const FALCON = {
  USDf: "0xFa2B947eEc368f42195f24F36d2aF29f7c24CeC2",
  sUSDf: "0xc8CF6D7991f15525488b2A83Df53468D682Ba4B0",
  usdfUsdFeed: "0xb177857a1799aA5F7fEb5799Fdf12CbE8fdF78B1",
  susdfUsdfFeed: "0xe471bc940AA9831a0AeA21E6F40C1A1236EB4BB3",
};

const SILO_MARKETS = [
  "Silo_USDf_USDC",
  "Silo_sUSDf_USDC",
  "Silo_PT_USDf_29Jan26_USDC_id_171",
  "Silo_PT_sUSDf_29Jan26_USDC",
  "Silo_PR-sUSDf_USDC_25_sep_25",
  "Silo_PT_eUSDe_14_AUG_25_USDF",
];

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
]);
const CHAINLINK = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const AAVE_POOL = new ethers.Interface([
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
]);
const SILO_CONFIG = new ethers.Interface([
  "function getSilos() view returns (address,address)",
  "function getConfig(address silo) view returns ((uint256,uint256,address,address,address,address,address,address,address,address,uint256,uint256,uint256,uint256,uint256,address,bool))",
]);
const SILO = new ethers.Interface([
  "function getLiquidity() view returns (uint256)",
  "function getSiloStorage() view returns (uint192,uint64,uint256,uint256,uint256)",
]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (_) {
    return "";
  }
}

function normalizeAddress(value) {
  try {
    return ethers.getAddress(value);
  } catch (_) {
    return null;
  }
}

function lower(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 15_000) {
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
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveEthereumRpc() {
  for (const url of loadRpcUrls()) {
    try {
      const chainIdHex = await rpcCall(url, "eth_chainId", [], 6000);
      if (Number(BigInt(chainIdHex)) === 1) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

async function safeCall(provider, to, data) {
  try {
    return await provider.call({ to, data });
  } catch (_) {
    return null;
  }
}

function decodeResult(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try {
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

function decodeString(raw, fn) {
  const decoded = decodeResult(raw, ERC20, fn) || decodeResult(raw, CHAINLINK, fn);
  if (decoded?.[0] !== undefined) return String(decoded[0]);
  return null;
}

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try {
    return Number(ethers.formatUnits(raw, Number(decimals)));
  } catch (_) {
    return null;
  }
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20_000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPrices(addresses) {
  const keys = [...new Set(addresses.map(lower).filter(Boolean).map((address) => `${ETHEREUM.coinSlug}:${address}`))];
  const prices = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    for (const [key, row] of Object.entries(json.coins || {})) prices.set(key.split(":").pop().toLowerCase(), Number(row.price || 0));
  }
  return prices;
}

async function tokenMeta(provider, address, prices) {
  const token = normalizeAddress(address);
  if (!token) return null;
  const [code, symbolRaw, nameRaw, decimalsRaw, supplyRaw, assetRaw, totalAssetsRaw, convertRaw] = await Promise.all([
    provider.getCode(token).catch(() => "0x"),
    safeCall(provider, token, ERC20.encodeFunctionData("symbol", [])),
    safeCall(provider, token, ERC20.encodeFunctionData("name", [])),
    safeCall(provider, token, ERC20.encodeFunctionData("decimals", [])),
    safeCall(provider, token, ERC20.encodeFunctionData("totalSupply", [])),
    safeCall(provider, token, ERC4626.encodeFunctionData("asset", [])),
    safeCall(provider, token, ERC4626.encodeFunctionData("totalAssets", [])),
    safeCall(provider, token, ERC4626.encodeFunctionData("convertToAssets", [10n ** 18n])),
  ]);
  const decimals = Number(decodeResult(decimalsRaw, ERC20, "decimals")?.[0] ?? 18n);
  const totalSupplyRaw = decodeResult(supplyRaw, ERC20, "totalSupply")?.[0] ?? null;
  const totalAssets = decodeResult(totalAssetsRaw, ERC4626, "totalAssets")?.[0] ?? null;
  const convertOneShareToAssets = decodeResult(convertRaw, ERC4626, "convertToAssets")?.[0] ?? null;
  return {
    address: token,
    codePresent: Boolean(code && code !== "0x"),
    symbol: decodeString(symbolRaw, "symbol"),
    name: decodeString(nameRaw, "name"),
    decimals,
    totalSupplyRaw: totalSupplyRaw?.toString() || null,
    totalSupply: totalSupplyRaw === null ? null : ethers.formatUnits(totalSupplyRaw, decimals),
    priceUsd: prices.get(token.toLowerCase()) || null,
    erc4626: {
      asset: normalizeAddress(decodeResult(assetRaw, ERC4626, "asset")?.[0]) || null,
      totalAssetsRaw: totalAssets?.toString() || null,
      totalAssets: totalAssets === null ? null : ethers.formatUnits(totalAssets, decimals),
      convertOneShareToAssetsRaw: convertOneShareToAssets?.toString() || null,
      convertOneShareToAssets: convertOneShareToAssets === null ? null : ethers.formatUnits(convertOneShareToAssets, decimals),
    },
  };
}

async function feedState(provider, address, blockTimestamp) {
  const feed = normalizeAddress(address);
  if (!feed) return null;
  const [code, decimalsRaw, descriptionRaw, roundRaw] = await Promise.all([
    provider.getCode(feed).catch(() => "0x"),
    safeCall(provider, feed, CHAINLINK.encodeFunctionData("decimals", [])),
    safeCall(provider, feed, CHAINLINK.encodeFunctionData("description", [])),
    safeCall(provider, feed, CHAINLINK.encodeFunctionData("latestRoundData", [])),
  ]);
  const decimals = Number(decodeResult(decimalsRaw, CHAINLINK, "decimals")?.[0] ?? 8n);
  const latest = decodeResult(roundRaw, CHAINLINK, "latestRoundData");
  const answer = latest?.[1] ?? null;
  const updatedAt = latest?.[3] ? Number(latest[3]) : null;
  return {
    address: feed,
    codePresent: Boolean(code && code !== "0x"),
    description: decodeString(descriptionRaw, "description"),
    decimals,
    answerRaw: answer?.toString() || null,
    answer: answer === null ? null : Number(ethers.formatUnits(answer, decimals)),
    updatedAt,
    ageSeconds: updatedAt ? Math.max(0, blockTimestamp - updatedAt) : null,
  };
}

function buildProducers(addressBook) {
  const tokenKeys = ["USDf", "sUSDf", "PT-USDf-29JAN2026", "PT-sUSDf-29JAN2026", "PT-sUSDf-25SEP2025"];
  return tokenKeys.map((symbol) => ({
    id: `falcon:${symbol}`,
    protocol: symbol.startsWith("PT-") ? "Pendle/Falcon" : "Falcon Finance",
    chain: ETHEREUM.chain,
    chainId: ETHEREUM.chainId,
    address: normalizeAddress(addressBook[symbol] || FALCON[symbol]),
    symbol,
    category: symbol.startsWith("PT-") ? "principal-token-rwa-stable" : (symbol === "sUSDf" ? "yield-bearing-rwa-stable" : "rwa-stable"),
    currentAnomaly: false,
    blocker: "Falcon mapping indicates KYC/manual/cooldown-gated mint-redeem and no current depeg/NAV anomaly in local artifacts",
  })).filter((p) => p.address);
}

function classifyConsumer(row, producerAnomaly = false) {
  const liquidity = Number(row.facts?.oppositeLiquidityUsd ?? row.facts?.availableToBorrowUsd ?? row.facts?.liquidityUsd ?? 0);
  const ltv = Number(row.facts?.ltv ?? row.facts?.maxLtv ?? row.facts?.lltv ?? 0);
  const reviewCandidate = liquidity >= THRESHOLDS.routeLiquidityUsd && ltv > 0;
  const watchCandidate = Boolean(producerAnomaly && reviewCandidate);
  return {
    ...row,
    reviewCandidate,
    watchCandidate,
    routePositive: false,
    blockers: [
      "no current Falcon/Centrifuge producer anomaly mapped",
      liquidity < THRESHOLDS.routeLiquidityUsd ? "route-side liquidity below threshold or unpriced" : null,
      ltv <= 0 ? "collateral LTV disabled or unconfirmed" : null,
      ...(row.blockers || []),
    ].filter(Boolean),
  };
}

function bpsDiff(reference, observed) {
  const ref = Number(reference || 0);
  const obs = Number(observed || 0);
  if (!Number.isFinite(ref) || !Number.isFinite(obs) || ref <= 0 || obs <= 0) return null;
  return ((obs / ref) - 1) * 10_000;
}

function parseAaveConfig(data) {
  const raw = BigInt(data || 0n);
  const mask16 = 0xffffn;
  const mask36 = (1n << 36n) - 1n;
  return {
    ltv: Number(raw & mask16) / 10_000,
    liquidationThreshold: Number((raw >> 16n) & mask16) / 10_000,
    active: Boolean((raw >> 56n) & 1n),
    borrowingEnabled: Boolean((raw >> 58n) & 1n),
    paused: Boolean((raw >> 60n) & 1n),
    borrowCapWholeTokens: ((raw >> 80n) & mask36).toString(),
    supplyCapWholeTokens: ((raw >> 116n) & mask36).toString(),
  };
}

async function scanAave(provider, producers, prices) {
  const rows = [];
  const producerMap = new Map(producers.map((p) => [p.address.toLowerCase(), p]));
  const reservesRaw = await safeCall(provider, ETHEREUM.aavePool, AAVE_POOL.encodeFunctionData("getReservesList", []));
  const reserves = (decodeResult(reservesRaw, AAVE_POOL, "getReservesList")?.[0] || []).map(normalizeAddress).filter(Boolean);
  for (const reserve of reserves) {
    const producer = producerMap.get(reserve.toLowerCase());
    if (!producer) continue;
    const dataRaw = await safeCall(provider, ETHEREUM.aavePool, AAVE_POOL.encodeFunctionData("getReserveData", [reserve]));
    const cfgWord = dataRaw && dataRaw !== "0x" ? `0x${dataRaw.slice(2, 66)}` : "0x0";
    const cfg = parseAaveConfig(BigInt(cfgWord));
    const aToken = dataRaw && dataRaw.length >= 2 + 64 * 9 ? normalizeAddress(`0x${dataRaw.slice(2 + 64 * 8 + 24, 2 + 64 * 9)}`) : null;
    const decimals = (await tokenMeta(provider, reserve, prices))?.decimals || 18;
    const cashRaw = aToken ? decodeResult(await safeCall(provider, reserve, ERC20.encodeFunctionData("balanceOf", [aToken])), ERC20, "balanceOf")?.[0] || 0n : 0n;
    const cash = formatUnitsNumber(cashRaw, decimals);
    rows.push(classifyConsumer({
      id: `aave-v3-${producer.symbol.toLowerCase()}`,
      protocol: "Aave V3",
      chain: ETHEREUM.chain,
      chainId: ETHEREUM.chainId,
      producer: producer.id,
      token: reserve,
      consumerType: "aave-reserve",
      facts: {
        pool: ETHEREUM.aavePool,
        symbol: producer.symbol,
        cash,
        liquidityUsd: (prices.get(reserve.toLowerCase()) || 0) * Number(cash || 0),
        ...cfg,
      },
      blockers: ["Aave direct reserve match only; no producer-side anomaly"],
    }));
  }
  return rows;
}

function parseSiloInput(name) {
  const file = path.join(FILES.siloInputs, `${name.replace(/_id_171$/, "")}.json`);
  return readJson(file, null);
}

function parseSiloConfig(decoded) {
  const row = decoded?.[0];
  if (!row) return null;
  return {
    silo: normalizeAddress(row[2]),
    token: normalizeAddress(row[3]),
    protectedShareToken: normalizeAddress(row[4]),
    collateralShareToken: normalizeAddress(row[5]),
    debtShareToken: normalizeAddress(row[6]),
    solvencyOracle: normalizeAddress(row[7]),
    maxLtvOracle: normalizeAddress(row[8]),
    maxLtv: Number(row[10] || 0n) / 1e18,
    lt: Number(row[11] || 0n) / 1e18,
  };
}

async function scanSilo(provider, producers, prices, addressBook, siloDeployments) {
  const rows = [];
  const producerMap = new Map(producers.map((p) => [p.address.toLowerCase(), p]));
  const mainnetDeployments = siloDeployments?.mainnet || {};
  for (const name of SILO_MARKETS) {
    const configAddress = normalizeAddress(mainnetDeployments[name]);
    const input = parseSiloInput(name);
    if (!configAddress || !input) {
      rows.push({ id: `silo-${name}`, protocol: "Silo V3", chain: ETHEREUM.chain, chainId: ETHEREUM.chainId, consumerType: "silo-v3-market-reference", facts: { name, configAddress, inputFound: Boolean(input) }, reviewCandidate: false, watchCandidate: false, routePositive: false, blockers: ["local Silo deployment reference incomplete"] });
      continue;
    }
    const silosRaw = await safeCall(provider, configAddress, SILO_CONFIG.encodeFunctionData("getSilos", []));
    const silosDecoded = decodeResult(silosRaw, SILO_CONFIG, "getSilos");
    const silos = [normalizeAddress(silosDecoded?.[0]), normalizeAddress(silosDecoded?.[1])].filter(Boolean);
    if (silos.length !== 2) {
      rows.push({ id: `silo-${name}`, protocol: "Silo V3", chain: ETHEREUM.chain, chainId: ETHEREUM.chainId, consumerType: "silo-v3-market-reference", facts: { name, configAddress }, reviewCandidate: false, watchCandidate: false, routePositive: false, blockers: ["Silo config live getSilos() not readable"] });
      continue;
    }
    const sides = [];
    for (const silo of silos) {
      const [configRaw, liquidityRaw, storageRaw] = await Promise.all([
        safeCall(provider, configAddress, SILO_CONFIG.encodeFunctionData("getConfig", [silo])),
        safeCall(provider, silo, SILO.encodeFunctionData("getLiquidity", [])),
        safeCall(provider, silo, SILO.encodeFunctionData("getSiloStorage", [])),
      ]);
      const cfg = parseSiloConfig(decodeResult(configRaw, SILO_CONFIG, "getConfig"));
      if (!cfg) continue;
      const meta = await tokenMeta(provider, cfg.token, prices);
      const liquidity = decodeResult(liquidityRaw, SILO, "getLiquidity")?.[0] || 0n;
      const storage = decodeResult(storageRaw, SILO, "getSiloStorage");
      sides.push({
        ...cfg,
        symbol: meta?.symbol,
        decimals: meta?.decimals || 18,
        priceUsd: prices.get(cfg.token.toLowerCase()) || null,
        liquidityRaw: liquidity.toString(),
        liquidity: formatUnitsNumber(liquidity, meta?.decimals || 18),
        collateralAssetsRaw: (storage?.[3] || 0n).toString(),
        debtAssetsRaw: (storage?.[4] || 0n).toString(),
      });
    }
    if (sides.length !== 2) continue;
    for (let i = 0; i < sides.length; i++) {
      const side = sides[i];
      const opposite = sides[i === 0 ? 1 : 0];
      const producer = producerMap.get(side.token.toLowerCase());
      if (!producer) continue;
      const liquidityUsd = side.priceUsd === null ? null : Number(side.liquidity || 0) * Number(side.priceUsd || 0);
      const oppositeLiquidityUsd = opposite.priceUsd === null ? null : Number(opposite.liquidity || 0) * Number(opposite.priceUsd || 0);
      rows.push(classifyConsumer({
        id: `silo-${name}-${producer.symbol}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        protocol: "Silo V3",
        chain: ETHEREUM.chain,
        chainId: ETHEREUM.chainId,
        producer: producer.id,
        token: side.token,
        consumerType: "silo-v3-market",
        facts: {
          name,
          config: configAddress,
          token0: input.token0,
          token1: input.token1,
          producerSymbol: producer.symbol,
          pairedSymbol: opposite.symbol,
          pairedToken: opposite.token,
          solvencyOracle: side.solvencyOracle,
          maxLtvOracle: side.maxLtvOracle,
          maxLtv: side.maxLtv,
          ltv: side.maxLtv,
          liquidationThreshold: side.lt,
          liquidity: side.liquidity,
          liquidityUsd,
          oppositeLiquidity: opposite.liquidity,
          oppositeLiquidityUsd,
          collateralAssetsRaw: side.collateralAssetsRaw,
          debtAssetsRaw: side.debtAssetsRaw,
          configuredOracle: input.token0 === producer.symbol ? input.solvencyOracle0 : input.solvencyOracle1,
          quoteTokenKnown: Boolean(addressBook[input.token0] && addressBook[input.token1]),
        },
        blockers: ["Silo route is review-only until Falcon/NAV/depeg anomaly is current"],
      }));
    }
  }
  return rows;
}

function findCurveSUSDFMarket(curve) {
  const rows = [];
  const stack = [curve];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    if (String(item.shortName || item.name || item.api?.name || "").includes("sUSDf collateral")) rows.push(item);
    for (const child of Object.values(item)) if (child && typeof child === "object") stack.push(child);
  }
  return rows[0] || null;
}

function scanCurve(curve, producers) {
  const market = findCurveSUSDFMarket(curve);
  if (!market) return [];
  const susdf = producers.find((p) => p.symbol === "sUSDf");
  const api = market.api || {};
  return [classifyConsumer({
    id: "curve-crvusd-susdf-collateral",
    protocol: "Curve crvUSD",
    chain: ETHEREUM.chain,
    chainId: ETHEREUM.chainId,
    producer: susdf?.id || "falcon:sUSDf",
    token: api.collateral?.address || market.collateral?.address || FALCON.sUSDf,
    consumerType: "crvusd-lending-market",
    facts: {
      controller: api.controller || market.controller,
      vault: api.vault || market.vault,
      amm: api.amm || market.amm,
      collateralSymbol: api.collateral?.symbol || "sUSDf",
      borrowedSymbol: api.borrowed?.symbol || "crvUSD",
      totalSuppliedUsd: api.totalSupplied?.usdTotal ?? null,
      borrowedAmountUsd: api.borrowedAmount?.usdTotal ?? null,
      availableToBorrowUsd: api.availableToBorrow?.usdTotal ?? null,
      ltv: market.controllerState?.loanDiscount?.value ? 1 - Number(market.controllerState.loanDiscount.value) / 1e18 : null,
      liquidationDiscount: market.controllerState?.liquidationDiscount?.value || null,
      nLoans: market.controllerState?.nLoans?.value || null,
      priceOracleLimited: market.ammState?.priceOracleLimited?.value || null,
      oracle: market.ammState?.oracle?.address || null,
    },
    blockers: ["Curve market currently has zero supplied, zero debt, and zero available borrow in local artifact"],
  })];
}

async function fetchMorphoMarkets(producers) {
  const addresses = producers.map((p) => p.address.toLowerCase());
  const query = `query($chainIds:[Int!]!, $assets:[String!]!, $first:Int!) {
    collateral: markets(first:$first, orderBy:SupplyAssetsUsd, orderDirection:Desc, where:{chainId_in:$chainIds, collateralAssetAddress_in:$assets}) {
      items { marketId loanAsset { symbol address decimals } collateralAsset { symbol address decimals } oracle { address } lltv state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization } }
    }
    loan: markets(first:$first, orderBy:SupplyAssetsUsd, orderDirection:Desc, where:{chainId_in:$chainIds, loanAssetAddress_in:$assets}) {
      items { marketId loanAsset { symbol address decimals } collateralAsset { symbol address decimals } oracle { address } lltv state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization } }
    }
  }`;
  const json = await fetchJson("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { chainIds: [1], assets: addresses, first: THRESHOLDS.maxMorphoMarkets } }),
    timeoutMs: 30_000,
  }).catch(() => null);
  if (!json || json.errors) return [];
  return [
    ...(json.data?.collateral?.items || []).map((m) => ({ side: "collateral", market: m })),
    ...(json.data?.loan?.items || []).map((m) => ({ side: "loan", market: m })),
  ];
}

async function scanMorpho(producers) {
  const byAddress = new Map(producers.map((p) => [p.address.toLowerCase(), p]));
  const rows = [];
  for (const { side, market } of await fetchMorphoMarkets(producers)) {
    const producerAddress = side === "collateral" ? market.collateralAsset?.address : market.loanAsset?.address;
    const producer = byAddress.get(String(producerAddress || "").toLowerCase());
    if (!producer) continue;
    rows.push(classifyConsumer({
      id: `morpho-${side}-${producer.symbol}-${market.marketId}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 90),
      protocol: "Morpho Blue",
      chain: ETHEREUM.chain,
      chainId: ETHEREUM.chainId,
      producer: producer.id,
      token: producer.address,
      consumerType: `morpho-${side}-asset`,
      facts: {
        marketId: market.marketId,
        side,
        loanSymbol: market.loanAsset?.symbol || null,
        collateralSymbol: market.collateralAsset?.symbol || null,
        oracle: market.oracle?.address || null,
        lltv: market.lltv === null || market.lltv === undefined ? null : Number(market.lltv) / 1e18,
        ltv: side === "collateral" && market.lltv !== null && market.lltv !== undefined ? Number(market.lltv) / 1e18 : 0,
        supplyAssetsUsd: market.state?.supplyAssetsUsd ?? null,
        borrowAssetsUsd: market.state?.borrowAssetsUsd ?? null,
        liquidityUsd: market.state?.liquidityAssetsUsd ?? null,
      },
      blockers: [side === "loan" ? "producer is loan asset, not collateral-extractive" : "Morpho route needs producer anomaly plus live exit economics"],
    }));
  }
  return rows;
}

function scanSkyCentrifugeContext(sky) {
  const rows = [];
  const stack = [sky];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    const name = String(item.name || item.ilkName || "");
    if (/Centrifuge/i.test(name) || /RWA00[245]-A/i.test(name)) {
      rows.push({
        name: item.name || item.ilkName || null,
        ilkName: item.ilkName || null,
        symbol: item.symbol || null,
        debt: item.debt || item.normalizedDebt || null,
        line: item.line || null,
      });
    }
    for (const child of Object.values(item)) if (child && typeof child === "object") stack.push(child);
  }
  return rows.slice(0, 20);
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rpc = await resolveEthereumRpc();
  const addressBook = readJson(FILES.siloAddresses, {});
  const siloDeployments = readJson(FILES.siloDeployments, {});
  const producers = buildProducers(addressBook);
  const prices = await fetchPrices([...producers.map((p) => p.address), addressBook.USDC, addressBook.crvUSD].filter(Boolean));
  const provider = rpc ? new ethers.JsonRpcProvider(rpc) : null;

  let producerMetas = [];
  let producerSignals = { falconFeeds: [], currentProducerAnomaly: false, blockers: ["Ethereum RPC unavailable; live token/feed probes skipped"] };
  let consumers = [];
  if (provider) {
    const block = await provider.getBlock("latest");
    producerMetas = await Promise.all(producers.map((p) => tokenMeta(provider, p.address, prices).then((meta) => ({ ...p, meta }))));
    const feeds = await Promise.all([
      feedState(provider, FALCON.usdfUsdFeed, Number(block.timestamp)),
      feedState(provider, FALCON.susdfUsdfFeed, Number(block.timestamp)),
    ]);
    const usdfMeta = producerMetas.find((p) => p.symbol === "USDf")?.meta;
    const susdfMeta = producerMetas.find((p) => p.symbol === "sUSDf")?.meta;
    const feedUsdfUsd = feeds[0]?.answer || null;
    const feedSusdfUsd = feeds[0]?.answer && feeds[1]?.answer ? feeds[0].answer * feeds[1].answer : null;
    const usdfVsLiveBps = bpsDiff(usdfMeta?.priceUsd, feedUsdfUsd);
    const susdfVsLiveBps = bpsDiff(susdfMeta?.priceUsd, feedSusdfUsd);
    const staleButFlat = [usdfVsLiveBps, susdfVsLiveBps].some((v) => v !== null) && [usdfVsLiveBps, susdfVsLiveBps].every((v) => v === null || Math.abs(v) < THRESHOLDS.producerDivergenceBps);
    const currentProducerAnomaly = [usdfVsLiveBps, susdfVsLiveBps].some((v) => v !== null && Math.abs(v) >= THRESHOLDS.producerDivergenceBps);
    producerSignals = {
      falconFeeds: feeds,
      liveReference: {
        usdfPriceUsd: usdfMeta?.priceUsd || null,
        susdfPriceUsd: susdfMeta?.priceUsd || null,
        feedUsdfUsd,
        feedSusdfUsd,
        usdfVsLiveBps,
        susdfVsLiveBps,
        staleButFlat,
      },
      currentProducerAnomaly,
      blockers: [
        currentProducerAnomaly ? null : "no live Falcon depeg/NAV anomaly mapped",
        staleButFlat ? "Falcon feeds are stale relative to short windows but flat versus live public reference" : null,
        "mint/redeem is KYC/manual/cooldown-gated in local mapping",
        "feed freshness alone is not an extractive route",
      ].filter(Boolean),
    };
    consumers = [
      ...await scanAave(provider, producers, prices),
      ...await scanSilo(provider, producers, prices, addressBook, siloDeployments),
      ...scanCurve(readJson(FILES.curveStablecoinLive, null), producers),
      ...await scanMorpho(producers),
    ];
  } else {
    consumers = [
      ...scanCurve(readJson(FILES.curveStablecoinLive, null), producers),
    ];
  }

  const reviewCandidates = consumers.filter((c) => c.reviewCandidate);
  const watchCandidates = consumers.filter((c) => c.watchCandidate);
  const routePositive = consumers.filter((c) => c.routePositive);
  const skyCentrifugeRows = scanSkyCentrifugeContext(readJson(FILES.skyLendingLive, null));
  const targetDiscovery = readJson(FILES.targetDiscovery, null);
  const discoveryRows = [
    ...(targetDiscovery?.candidates || []),
    ...(targetDiscovery?.topCandidates || []),
    ...(targetDiscovery?.defillama?.selectedTargets || []),
    ...(targetDiscovery?.defillama?.rankedPublicCandidates || []),
  ];
  const centrifugeDiscovery = discoveryRows.find((row) => /centrifuge/i.test(row.name || row.slug || "")) || null;

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-rwa-stable-consumer-routes.js",
    scope: "Read-only Falcon/Centrifuge stable and RWA receipt consumer join",
    safety: {
      rpcInventoryRead: Boolean(rpc),
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive.length > 0,
      signedActionJustified: false,
    },
    thresholds: THRESHOLDS,
    inputs: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, path.relative(WORKSPACE, file).replace(/\\/g, "/")])),
    producerSignals,
    producerSummary: {
      producersMapped: producers.length,
      falconTokens: producers.map((p) => p.symbol),
      exactCentrifugeReceiptTokensMapped: 0,
      centrifugeDiscovery,
      centrifugeSkyContextRows: skyCentrifugeRows.length,
    },
    summary: {
      consumersMapped: consumers.length,
      reviewCandidates: reviewCandidates.length,
      watchCandidates: watchCandidates.length,
      routePositive: routePositive.length,
      signedActionJustified: false,
      topReview: reviewCandidates.slice(0, 8).map((c) => c.id),
    },
    producers: producerMetas.length ? producerMetas : producers,
    consumers,
    centrifugeContext: {
      status: "context-only-no-exact-receipt-token-consumer",
      skyRows: skyCentrifugeRows,
      blocker: "Centrifuge v3.1 vault/NAV deployment surface is mapped at protocol level, but no exact external receipt-token lending/oracle consumer with live liquidity is present in local artifacts.",
    },
    nextRoutePositiveCriteria: [
      "Falcon USDf/sUSDf or Centrifuge receipt token has a current depeg, NAV, stale-feed, or share-rate anomaly",
      "the anomalous producer is accepted as collateral or oracle input with positive LTV",
      "opposite borrow/exit liquidity is live and large enough for gas/slippage",
      "mint/redeem or DEX exit is permissionless for the exact route",
      "fork simulation extracts positive value from the exact joined route",
    ],
  };

  fs.writeFileSync(OUT, JSON.stringify(out, jsonReplacer, 2) + "\n");
  console.log(`RWA/stable consumer join: consumers=${out.summary.consumersMapped} review=${out.summary.reviewCandidates} watch=${out.summary.watchCandidates} routePositive=${out.summary.routePositive}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
