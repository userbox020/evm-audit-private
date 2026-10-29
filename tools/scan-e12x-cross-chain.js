#!/usr/bin/env node
// Read-only E12x cross-chain expansion mapper.
// RPC URLs are read locally and never printed or written.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "e12x-cross-chain-map.json");
const TIMEOUT_MS = 12_000;

const DEFAULT_MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const DEFAULT_UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const LEGACY_SWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const COMMON_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const CREATE_MARKET_TOPIC = "0x8a41cabf57f8c9e58b85a041c8b6e82af3eb44c2a21833c0f03a639b5bcb1c49";
const LOOKBACK_BLOCKS = 14_400;
const FEES = [100, 500, 3000, 10000];

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);
const CHAINLINK = new ethers.Interface([
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);
const FACTORY = new ethers.Interface(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"]);
const MORPHO_IFACE = new ethers.Interface([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
]);
const ORACLE = new ethers.Interface(["function price() view returns (uint256)"]);
const ABI = ethers.AbiCoder.defaultAbiCoder();

const CHAINS = [
  {
    chainId: 8453,
    name: "Base",
    morpho: DEFAULT_MORPHO,
    uniswapV3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    executionStatus: "watch-only; Base fork proof passed, but no deployed Base E12x executor, bytecode verifier target, or artifact gate; autoExecutable=false",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    stable: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ethUsdFeed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    ethUsdFeeds: [
      "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
      "0x71041dddad3595F270CEd9680a7d483EEFCc5C03",
    ],
    routers: [
      { name: "Uniswap V3 SwapRouter02", address: "0x2626664c2603336E57B271c5C0b26F421741e481" },
      { name: "Uniswap V3 SwapRouter", address: LEGACY_SWAP_ROUTER },
    ],
    quoters: [
      { name: "Uniswap V3 QuoterV2", address: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" },
      { name: "Common QuoterV2", address: COMMON_QUOTER_V2 },
    ],
    collaterals: [
      { symbol: "wstETH", address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", rateFeed: "0xB88BAc61a4Ca37C43a3725912B1f472c9A5bc061" },
      { symbol: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" },
    ],
  },
  {
    chainId: 42161,
    name: "Arbitrum",
    morpho: "0x6c247b1F6182318877311737BaC0844bAa518F5e",
    uniswapV3Factory: DEFAULT_UNISWAP_V3_FACTORY,
    executionStatus: "watch-only; Morpho deployment remapped from public Morpho data, but no Arbitrum fork proof, deployed executor, or artifact gate; autoExecutable=false",
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    stable: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    ethUsdFeed: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
    routers: [{ name: "Uniswap V3 SwapRouter", address: LEGACY_SWAP_ROUTER }],
    quoters: [{ name: "Uniswap V3 QuoterV2", address: COMMON_QUOTER_V2 }],
    collaterals: [
      { symbol: "wstETH", address: "0x5979D7b546E38E414F7E9822514be443A4800529" },
      { symbol: "cbETH", address: "0x1DEBd73E752bEaF79865Fd6446b0c970EaE7732f" },
      { symbol: "rETH", address: "0xEC70Dcb4A1EFa46b8F2D97C310C9C4790ba5ffA8" },
    ],
  },
  {
    chainId: 10,
    name: "Optimism",
    morpho: DEFAULT_MORPHO,
    uniswapV3Factory: DEFAULT_UNISWAP_V3_FACTORY,
    executionStatus: "blocked/watch-only; no Morpho deployment found in public Morpho data for this E12x variant; autoExecutable=false",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    stable: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    ethUsdFeed: "0x13e3Ee699D1909E989722E753853AE30b17e08c5",
    routers: [{ name: "Uniswap V3 SwapRouter", address: LEGACY_SWAP_ROUTER }],
    quoters: [{ name: "Uniswap V3 QuoterV2", address: COMMON_QUOTER_V2 }],
    collaterals: [
      { symbol: "wstETH", address: "0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb" },
      { symbol: "rETH", address: "0x9bcef72be871e61ed4fbbc7630889bee758eb81d" },
    ],
  },
  {
    chainId: 137,
    name: "Polygon",
    morpho: DEFAULT_MORPHO,
    uniswapV3Factory: DEFAULT_UNISWAP_V3_FACTORY,
    executionStatus: "blocked/watch-only; no Morpho deployment found in public Morpho data for this E12x variant; autoExecutable=false",
    wrappedNative: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    stable: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    ethUsdFeed: "0xF9680D99D6C9589e2a93a78A04A279e509205945",
    routers: [{ name: "Uniswap V3 SwapRouter", address: LEGACY_SWAP_ROUTER }],
    quoters: [{ name: "Uniswap V3 QuoterV2", address: COMMON_QUOTER_V2 }],
    collaterals: [
      { symbol: "wstETH", address: "0x03b54a6e9a984069379fae1a4fc4dbae93b3bccd" },
    ],
  },
];

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function loadRpcUrls() {
  const text = fs.readFileSync(RPC_FILE, "utf8");
  return [...text.matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const json = await res.json();
    return json.result ?? null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcPool(chainIds) {
  const urls = loadRpcUrls();
  const pool = {};
  for (const url of urls) {
    const idHex = await rpcCall(url, "eth_chainId", [], 6000);
    if (!idHex) continue;
    const chainId = parseInt(idHex, 16);
    if (chainIds.includes(chainId) && !pool[chainId]) pool[chainId] = url;
  }
  return pool;
}

async function hasCode(provider, address) {
  try {
    const code = await provider.getCode(String(address).toLowerCase());
    return !!code && code !== "0x";
  } catch (_) {
    return false;
  }
}

async function safeCall(provider, to, data) {
  try { return await provider.call({ to: String(to).toLowerCase(), data }); }
  catch (_) { return null; }
}

async function readToken(provider, address, holders = []) {
  const tokenAddress = String(address).toLowerCase();
  const out = { address: tokenAddress, codePresent: await hasCode(provider, tokenAddress), balances: {} };
  if (!out.codePresent) return out;
  const [symbolRaw, nameRaw, decimalsRaw] = await Promise.all([
    safeCall(provider, tokenAddress, ERC20.encodeFunctionData("symbol", [])),
    safeCall(provider, tokenAddress, ERC20.encodeFunctionData("name", [])),
    safeCall(provider, tokenAddress, ERC20.encodeFunctionData("decimals", [])),
  ]);
  try { if (symbolRaw) out.symbol = ERC20.decodeFunctionResult("symbol", symbolRaw)[0]; } catch (_) {}
  try { if (nameRaw) out.name = ERC20.decodeFunctionResult("name", nameRaw)[0]; } catch (_) {}
  try { if (decimalsRaw) out.decimals = Number(ERC20.decodeFunctionResult("decimals", decimalsRaw)[0]); } catch (_) {}
  for (const holder of holders) {
    const raw = await safeCall(provider, tokenAddress, ERC20.encodeFunctionData("balanceOf", [String(holder.address).toLowerCase()]));
    if (!raw) continue;
    try {
      const bal = ERC20.decodeFunctionResult("balanceOf", raw)[0];
      out.balances[holder.label] = bal.toString();
    } catch (_) {}
  }
  return out;
}

async function readFeed(provider, feed, blockTs) {
  const feedAddress = String(feed).toLowerCase();
  const out = { address: feedAddress, codePresent: await hasCode(provider, feedAddress) };
  if (!out.codePresent) return out;
  const [roundRaw, decimalsRaw] = await Promise.all([
    safeCall(provider, feedAddress, CHAINLINK.encodeFunctionData("latestRoundData", [])),
    safeCall(provider, feedAddress, CHAINLINK.encodeFunctionData("decimals", [])),
  ]);
  try { if (decimalsRaw) out.decimals = Number(CHAINLINK.decodeFunctionResult("decimals", decimalsRaw)[0]); } catch (_) {}
  try {
    if (roundRaw) {
      const [, answer, , updatedAt] = CHAINLINK.decodeFunctionResult("latestRoundData", roundRaw);
      out.answer = answer.toString();
      out.updatedAt = Number(updatedAt);
      out.ageSeconds = blockTs ? Math.max(0, blockTs - Number(updatedAt)) : null;
      out.price = out.decimals !== undefined ? Number(answer) / 10 ** out.decimals : null;
    }
  } catch (_) {}
  return out;
}

function decodeCreateMarket(log) {
  const data = String(log.data || "0x").slice(2);
  if (data.length < 320) return null;
  const lltvRaw = BigInt("0x" + data.slice(256, 320));
  return {
    txHash: log.transactionHash,
    blockNumber: parseInt(log.blockNumber, 16),
    id: log.topics?.[1] ? "0x" + log.topics[1].slice(26) : null,
    loanToken: "0x" + data.slice(24, 64),
    collateralToken: "0x" + data.slice(88, 128),
    oracle: "0x" + data.slice(152, 192),
    irm: "0x" + data.slice(216, 256),
    lltvRaw: lltvRaw.toString(),
    lltvPct: Number(lltvRaw) / 1e16,
  };
}

function marketId(marketParams) {
  return ethers.keccak256(ABI.encode(
    ["address", "address", "address", "address", "uint256"],
    [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, BigInt(marketParams.lltvRaw)]
  ));
}

async function readMorphoMarket(provider, morphoAddress, event) {
  const out = { id: marketId(event) };
  const [marketRaw, oracleRaw] = await Promise.all([
    safeCall(provider, morphoAddress, MORPHO_IFACE.encodeFunctionData("market", [out.id])),
    safeCall(provider, event.oracle, ORACLE.encodeFunctionData("price", [])),
  ]);
  try {
    if (marketRaw) {
      const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = MORPHO_IFACE.decodeFunctionResult("market", marketRaw);
      out.market = { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee };
    }
  } catch (_) {}
  try { if (oracleRaw) out.oraclePrice = ORACLE.decodeFunctionResult("price", oracleRaw)[0].toString(); } catch (_) {}
  return out;
}

async function getPools(provider, factoryAddress, tokenA, tokenB) {
  const out = [];
  if (!(await hasCode(provider, factoryAddress))) return out;
  for (const fee of FEES) {
    const raw = await safeCall(provider, factoryAddress, FACTORY.encodeFunctionData("getPool", [String(tokenA).toLowerCase(), String(tokenB).toLowerCase(), fee]));
    if (!raw) continue;
    try {
      const [pool] = FACTORY.decodeFunctionResult("getPool", raw);
      if (pool && pool !== ethers.ZeroAddress) out.push({ fee, pool, codePresent: await hasCode(provider, pool) });
    } catch (_) {}
  }
  return out;
}

async function scanChain(cfg, rpc) {
  const provider = new ethers.JsonRpcProvider(rpc);
  const block = await provider.getBlock("latest");
  const morpho = cfg.morpho || DEFAULT_MORPHO;
  const uniswapV3Factory = cfg.uniswapV3Factory || DEFAULT_UNISWAP_V3_FACTORY;
  const holders = [{ label: "balancerVault", address: BALANCER_VAULT }];
  const infra = {
    morpho: { address: morpho, codePresent: await hasCode(provider, morpho) },
    balancerVault: { address: BALANCER_VAULT, codePresent: await hasCode(provider, BALANCER_VAULT) },
    uniswapV3Factory: { address: uniswapV3Factory, codePresent: await hasCode(provider, uniswapV3Factory) },
    routers: [],
    quoters: [],
  };
  for (const router of cfg.routers) infra.routers.push({ ...router, codePresent: await hasCode(provider, router.address) });
  for (const quoter of cfg.quoters) infra.quoters.push({ ...quoter, codePresent: await hasCode(provider, quoter.address) });

  const assets = {
    wrappedNative: await readToken(provider, cfg.wrappedNative, holders),
    stable: await readToken(provider, cfg.stable, holders),
    collaterals: [],
  };
  for (const c of cfg.collaterals) {
    const token = await readToken(provider, c.address, holders);
    const rateFeed = c.rateFeed ? await readFeed(provider, c.rateFeed, block?.timestamp) : null;
    const pools = await getPools(provider, uniswapV3Factory, cfg.stable, c.address);
    assets.collaterals.push({ ...c, token, rateFeed, stableToCollateralPools: pools });
  }

  const ethUsdCandidates = [];
  for (const feed of (cfg.ethUsdFeeds || [cfg.ethUsdFeed])) {
    ethUsdCandidates.push(await readFeed(provider, feed, block?.timestamp));
  }
  const feeds = {
    ethUsd: ethUsdCandidates.find((f) => f.codePresent && f.price > 0) || ethUsdCandidates[0] || null,
    ethUsdCandidates,
  };
  const fromBlock = Math.max(Number(block.number) - LOOKBACK_BLOCKS, 0);
  const logs = await rpcCall(rpc, "eth_getLogs", [{
    address: morpho.toLowerCase(),
    topics: [CREATE_MARKET_TOPIC],
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock: "0x" + Number(block.number).toString(16),
  }]) || [];
  if (!Array.isArray(logs)) {
    return { chainId: cfg.chainId, name: cfg.name, blockNumber: block?.number, error: "getLogs failed", infra, assets, feeds, recentMorphoMarkets: [] };
  }
  const recentMorphoMarkets = [];
  for (const log of logs.slice(-50)) {
    const decoded = decodeCreateMarket(log);
    if (!decoded) continue;
    const [loanToken, collateralToken, morphoState] = await Promise.all([
      readToken(provider, decoded.loanToken),
      readToken(provider, decoded.collateralToken),
      readMorphoMarket(provider, morpho, decoded),
    ]);
    const configuredCollateral = cfg.collaterals.find((c) => c.address.toLowerCase() === decoded.collateralToken.toLowerCase()) || null;
    recentMorphoMarkets.push({ ...decoded, configuredCollateral: configuredCollateral?.symbol || null, loanToken, collateralToken, morphoState });
  }

  return {
    chainId: cfg.chainId,
    name: cfg.name,
    blockNumber: block?.number,
    blockTimestamp: block?.timestamp,
    lookbackBlocks: LOOKBACK_BLOCKS,
    infra,
    feeds,
    assets,
    recentMorphoMarketCount: logs.length,
    recentMorphoMarkets,
    executionStatus: cfg.executionStatus || "watch-only; no deployed E12x executor, no fork proof, autoExecutable=false",
  };
}

async function main() {
  const chainIds = CHAINS.map((c) => c.chainId);
  const pool = await resolveRpcPool(chainIds);
  const chains = [];
  for (const cfg of CHAINS) {
    if (!pool[cfg.chainId]) {
      chains.push({ chainId: cfg.chainId, name: cfg.name, error: "missing RPC", executionStatus: "watch-only" });
      continue;
    }
    chains.push(await scanChain(cfg, pool[cfg.chainId]));
  }

  const summary = {
    targetChainCount: chainIds.length,
    chainsWithRpc: chains.filter((c) => !c.error).length,
    chainsWithMorphoCode: chains.filter((c) => c.infra?.morpho?.codePresent).length,
    chainsWithFullInfra: chains.filter((c) => c.infra && [c.infra.morpho, c.infra.balancerVault, c.infra.uniswapV3Factory].every((x) => x?.codePresent)).length,
    recentMorphoMarketCount: chains.reduce((sum, c) => sum + Number(c.recentMorphoMarketCount || 0), 0),
    routePositive: 0,
    signedActionJustified: false,
  };

  const output = {
    generatedAt: new Date().toISOString(),
    scope: "E12x cross-chain read-only expansion mapping",
    targetChains: chainIds,
    safety: "No signed calls. Non-Ethereum E12x remains watch-only until per-chain fork proof, deployment, bytecode verification, and chain/address-specific artifact gates exist.",
    summary,
    chains,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, jsonReplacer, 2));

  console.log("E12x cross-chain read-only map");
  for (const c of chains) {
    const infraOk = c.infra ? [c.infra.morpho, c.infra.balancerVault, c.infra.uniswapV3Factory].filter((x) => x?.codePresent).length : 0;
    const markets = c.recentMorphoMarketCount ?? 0;
    console.log(`${c.name || c.chainId}: infra=${infraOk}/3 recentMorphoMarkets=${markets} status=${c.executionStatus || c.error || "watch-only"}`);
  }
  console.log(`Report: ${path.relative(WORKSPACE, OUT_FILE)}`);
}

main().catch((e) => {
  console.error(`scan failed: ${e.shortMessage || e.message}`);
  process.exit(1);
});
