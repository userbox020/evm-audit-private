#!/usr/bin/env node
// Read-only DEX-consumer route scanner.
// For consumed lending assets, finds DEX pools and checks if the paired token
// is an anomalous producer. This bridges the gap where a token has no direct
// lending listing but can be swapped for a consumer asset via DEX.

const fs = require("fs");
const path = require("path");
const { ethers, AbiCoder } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "dex-consumer-routes.json");
const QUIET = process.argv.includes("--quiet");

const TIMEOUT_MS = 15_000;
const MIN_POOL_LIQUIDITY_USD = Number(process.env.DEX_CONSUMER_MIN_POOL_LIQUIDITY_USD || "50000");
const MAX_PAIRS_PER_FACTORY = Number(process.env.DEX_CONSUMER_MAX_PAIRS_PER_FACTORY || "120");
const BATCH_SIZE = Number(process.env.DEX_CONSUMER_BATCH_SIZE || "15");

const V2_FACTORY = new ethers.Interface([
  "function getPair(address,address) view returns (address)",
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
]);
const V2_PAIR = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);

const CHAINS = {
  1: { name: "Ethereum" },
  42161: { name: "Arbitrum" },
  8453: { name: "Base" },
  10: { name: "Optimism" },
  56: { name: "BNB Chain" },
  137: { name: "Polygon" },
  43114: { name: "Avalanche" },
  146: { name: "Sonic" },
  57073: { name: "Ink" },
  130: { name: "Unichain" },
  480: { name: "World Chain" },
  999: { name: "HyperEVM" },
};

const DEX_FACTORIES = {
  1: [
    { name: "UniswapV2", factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f" },
    { name: "SushiV2", factory: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac" },
  ],
  42161: [
    { name: "SushiV2", factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4" },
  ],
  8453: [
    { name: "SushiV2", factory: "0x71524B4f93c58fcbf659783284E38825f0622859" },
    { name: "Aerodrome", factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" },
  ],
  10: [
    { name: "Velodrome", factory: "0x25CbdDb98b35ab1FF77413456B31EC81A6B6B746" },
  ],
  56: [
    { name: "PancakeV2", factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73" },
    { name: "SushiV2", factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4" },
  ],
};

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const FILES = {
  xstocksLive: path.join(WORKSPACE, "reports", "raw", "fast", "xstocks-live.json"),
  hyperlaneWarp: path.join(WORKSPACE, "reports", "raw", "fast", "hyperlane-warp-routes.json"),
  erc4626Joiner: path.join(WORKSPACE, "reports", "raw", "fast", "erc4626-consumer-joiner.json"),
  consumerFirstHighLtv: path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json"),
  aaveEulerSilo: path.join(WORKSPACE, "reports", "raw", "fast", "aave-euler-silo-consumer-graph.json"),
};

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

async function resolveRpcPool(chainIds) {
  const pool = {};
  for (const url of loadRpcUrls()) {
    try {
      const idHex = await rpcCall(url, "eth_chainId", [], 6000);
      const chainId = Number(BigInt(idHex));
      if (chainIds.includes(chainId) && !pool[chainId]) pool[chainId] = url;
    } catch (_) {}
  }
  return pool;
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function producerLowerAddresses(xstocks, hyperlane, erc4626Joiner) {
  const set = new Set();
  for (const tok of xstocks?.arbitrum?.tokens || []) {
    const addr = lowerAddress(tok?.token || tok?.meta?.address);
    if (addr) set.add(addr);
  }
  for (const prod of hyperlane?.producers || []) {
    const addr = lowerAddress(prod?.address);
    if (addr) set.add(addr);
  }
  for (const prod of erc4626Joiner?.inventory || []) {
    const addr = lowerAddress(prod?.address);
    if (addr) set.add(addr);
  }
  return set;
}

function producerMeta() {
  const meta = {};
  const xstocks = readJson(FILES.xstocksLive, {});
  for (const tok of xstocks?.arbitrum?.tokens || []) {
    const addr = lowerAddress(tok?.token || tok?.meta?.address);
    if (!addr) continue;
    meta[addr] = {
      source: "xstocks-live",
      symbol: tok?.asset?.symbol || tok?.meta?.symbol || null,
      name: tok?.asset?.name || tok?.meta?.name || null,
      chainId: 42161,
      chain: "Arbitrum",
    };
  }
  const hyperlane = readJson(FILES.hyperlaneWarp, {});
  for (const prod of hyperlane?.producers || []) {
    const addr = lowerAddress(prod?.address);
    if (!addr) continue;
    meta[addr] = {
      source: "hyperlane-warp-routes",
      symbol: prod?.symbol || null,
      name: prod?.name || null,
      chainId: prod?.chainId || null,
      chain: prod?.chain || null,
    };
  }
  const erc4626 = readJson(FILES.erc4626Joiner, {});
  for (const prod of erc4626?.inventory || []) {
    const addr = lowerAddress(prod?.address);
    if (!addr) continue;
    meta[addr] = {
      source: "erc4626-consumer-joiner",
      symbol: prod?.symbol || null,
      name: prod?.name || null,
      chainId: prod?.chainId || null,
      chain: CHAINS[prod?.chainId]?.name || null,
    };
  }
  return meta;
}

function consumerAddresses(consumerFirst, aes) {
  const map = {};
  for (const result of consumerFirst?.results || []) {
    for (const row of result?.highLtvRowsDetail || []) {
      const collateral = lowerAddress(row?.collateral?.address || row?.consumer?.collateralAsset?.address);
      const borrow = lowerAddress(row?.borrowAsset?.address || row?.consumer?.loanAsset?.address);
      const chainId = row?.chainId ?? result?.chainId ?? null;
      const chain = row?.chain || result?.chain || CHAINS[chainId]?.name || null;
      if (collateral) {
        if (!map[collateral]) map[collateral] = { address: collateral, chains: {}, consumerSides: new Set() };
        map[collateral].chains[chainId] = chain;
        map[collateral].consumerSides.add("collateral");
      }
      if (borrow) {
        if (!map[borrow]) map[borrow] = { address: borrow, chains: {}, consumerSides: new Set() };
        map[borrow].chains[chainId] = chain;
        map[borrow].consumerSides.add("borrowAsset");
      }
    }
  }
  for (const result of aes?.results || []) {
    for (const row of result?.topMatches || []) {
      const candidateAddresses = [
        row?.market?.reserve,
        row?.market?.asset,
        row?.market?.borrowAsset,
        row?.market?.collateralToken,
      ].filter(Boolean);
      for (const addr of candidateAddresses) {
        const lower = lowerAddress(addr);
        if (!lower) continue;
        const chainId = row?.producer?.chainId ?? null;
        const chain = row?.producer?.chain || CHAINS[chainId]?.name || null;
        if (!map[lower]) map[lower] = { address: lower, chains: {}, consumerSides: new Set() };
        map[lower].chains[chainId] = chain;
        map[lower].consumerSides.add(row?.side || "marketAsset");
      }
    }
  }
  return map;
}

async function fetchPair(provider, factoryAddr, tokenA, tokenB) {
  const data = V2_FACTORY.encodeFunctionData("getPair", [tokenA, tokenB]);
  return await safeProviderCall(provider, factoryAddr, data);
}

async function allPairs(provider, factoryAddr, maxPairs) {
  const pairs = [];
  try {
    const lenRaw = await safeProviderCall(provider, factoryAddr, V2_FACTORY.encodeFunctionData("allPairsLength", []));
    const len = lenRaw ? Number(BigInt(lenRaw)) : 0;
    const end = Math.min(len, maxPairs);
    for (let i = 0; i < end; i++) {
      const data = V2_FACTORY.encodeFunctionData("allPairs", [i]);
      const raw = await safeProviderCall(provider, factoryAddr, data);
      const addr = raw && raw !== "0x" ? ethers.AbiCoder.defaultAbiCoder().decode(["address"], raw)[0] : null;
      if (addr) pairs.push(addr.toLowerCase());
    }
  } catch (_) {}
  return pairs;
}

async function safeProviderCall(provider, to, data) {
  try {
    return await provider.call({ to, data });
  } catch (_) {
    return null;
  }
}

async function pairInfo(provider, pairAddr) {
  const [t0Raw, t1Raw, rRaw] = await Promise.all([
    safeProviderCall(provider, pairAddr, V2_PAIR.encodeFunctionData("token0", [])),
    safeProviderCall(provider, pairAddr, V2_PAIR.encodeFunctionData("token1", [])),
    safeProviderCall(provider, pairAddr, V2_PAIR.encodeFunctionData("getReserves", [])),
  ]);
  let token0 = null, token1 = null, reserve0 = null, reserve1 = null;
  if (t0Raw && t0Raw !== "0x") {
    try { token0 = ethers.AbiCoder.defaultAbiCoder().decode(["address"], t0Raw)[0]?.toLowerCase(); } catch (_) {}
  }
  if (t1Raw && t1Raw !== "0x") {
    try { token1 = ethers.AbiCoder.defaultAbiCoder().decode(["address"], t1Raw)[0]?.toLowerCase(); } catch (_) {}
  }
  if (rRaw && rRaw !== "0x") {
    try {
      const r = ethers.AbiCoder.defaultAbiCoder().decode(["uint112", "uint112", "uint32"], rRaw);
      reserve0 = BigInt(String(r[0]));
      reserve1 = BigInt(String(r[1]));
    } catch (_) {}
  }
  return { token0, token1, reserve0, reserve1 };
}

async function main() {
  const xstocks = readJson(FILES.xstocksLive, {});
  const hyperlane = readJson(FILES.hyperlaneWarp, {});
  const erc4626Joiner = readJson(FILES.erc4626Joiner, {});
  const consumerFirst = readJson(FILES.consumerFirstHighLtv, {});
  const aes = readJson(FILES.aaveEulerSilo, {});

  const producers = producerLowerAddresses(xstocks, hyperlane, erc4626Joiner);
  const pMeta = producerMeta();
  const consumers = consumerAddresses(consumerFirst, aes);

  const consumerList = Object.values(consumers);
  const consumerAddrs = new Set(consumerList.map((c) => c.address));

  const chainIds = [...new Set([
    ...Object.keys(DEX_FACTORIES).map(Number),
  ])];
  const rpcs = await resolveRpcPool(chainIds);

  const chainProviders = {};
  for (const [chainId, rpc] of Object.entries(rpcs)) {
    try {
      chainProviders[chainId] = new ethers.JsonRpcProvider(rpc, Number(chainId), { staticNetwork: true });
    } catch (_) {}
  }

  const factoryDiscoveries = [];
  let factoryPairsChecked = 0;
  let poolInfoChecked = 0;

  for (const [chainIdStr, factories] of Object.entries(DEX_FACTORIES)) {
    const chainId = Number(chainIdStr);
    const provider = chainProviders[chainId];
    if (!provider) {
      for (const f of factories) {
        factoryDiscoveries.push({ chainId, chain: CHAINS[chainId]?.name, factory: f.name, factoryAddress: f.factory, pairsFound: 0, error: "noRpcForChain" });
      }
      continue;
    }

    for (const f of factories) {
      const pairs = await allPairs(provider, f.factory, MAX_PAIRS_PER_FACTORY);
      factoryDiscoveries.push({ chainId, chain: CHAINS[chainId]?.name, factory: f.name, factoryAddress: f.factory, pairsFound: pairs.length, error: null });
      factoryPairsChecked += pairs.length;

      const batchCount = Math.ceil(pairs.length / BATCH_SIZE);
      for (let b = 0; b < batchCount; b++) {
        const batch = pairs.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
        const infos = await Promise.all(batch.map((addr) => pairInfo(provider, addr)));
        poolInfoChecked += infos.length;

        for (let i = 0; i < batch.length; i++) {
          const info = infos[i];
          if (!info || !info.token0 || !info.token1) continue;
          const pairAddr = batch[i];

          const t0IsConsumer = consumerAddrs.has(info.token0);
          const t1IsConsumer = consumerAddrs.has(info.token1);
          const t0IsProducer = producers.has(info.token0);
          const t1IsProducer = producers.has(info.token1);

          if (!(t0IsConsumer && t1IsProducer) && !(t1IsConsumer && t0IsProducer)) continue;
          if (!(t0IsProducer || t1IsProducer)) continue;
          if (!(t0IsConsumer || t1IsConsumer)) continue;

          const producerAddr = t0IsProducer ? info.token0 : info.token1;
          const consumerAddr = t0IsConsumer ? info.token0 : info.token1;
          const consumerEntry = consumers[consumerAddr] || {};
          const producerEntry = pMeta[producerAddr] || {};
          const reserve0Usd = 0;
          const reserve1Usd = 0;

          factoryDiscoveries.push({
            chainId,
            chain: CHAINS[chainId]?.name,
            factory: f.name,
            pair: pairAddr,
            producerToken: producerAddr,
            producerSymbol: producerEntry.symbol || null,
            producerSource: producerEntry.source || null,
            consumerToken: consumerAddr,
            consumerSides: [...(consumerEntry.consumerSides || [])],
            consumerChains: consumerEntry.chains || {},
            reserve0: info.reserve0?.toString() || "0",
            reserve1: info.reserve1?.toString() || "0",
            pairChecked: true,
          });
        }
      }
    }
  }

  const matches = factoryDiscoveries.filter((d) => d.pairChecked === true);
  const uniqueProducers = [...new Set(matches.map((m) => m.producerToken))];
  const uniquePairs = [...new Set(matches.map((m) => m.pair))];

  const watchCandidates = matches.filter((m) => {
    const liquidity = Math.max(
      asNumber(m.reserve0) || 0,
      asNumber(m.reserve1) || 0,
    );
    return liquidity >= MIN_POOL_LIQUIDITY_USD;
  });

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-dex-consumer-routes.js",
    scope: "Read-only DEX pool consumer-route discovery bridging producer tokens without direct lending listings to DEX-mediated consumer routes",
    inputs: {
      xstocksLive: FILES.xstocksLive?.replace(/\\/g, "/"),
      hyperlaneWarp: FILES.hyperlaneWarp?.replace(/\\/g, "/"),
      erc4626Joiner: FILES.erc4626Joiner?.replace(/\\/g, "/"),
      consumerFirstHighLtv: FILES.consumerFirstHighLtv?.replace(/\\/g, "/"),
      aaveEulerSilo: FILES.aaveEulerSilo?.replace(/\\/g, "/"),
    },
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    thresholds: {
      minPoolLiquidityUsd: MIN_POOL_LIQUIDITY_USD,
      maxPairsPerFactory: MAX_PAIRS_PER_FACTORY,
      batchSize: BATCH_SIZE,
    },
    dexFactoriesScanned: DEX_FACTORIES,
    chainsWithRpc: Object.keys(rpcs).map(Number),
    chainsMissingRpc: chainIds.filter((id) => !rpcs[id]),
    producerStats: {
      xstocksAddresses: producers.size,
      totalProducerAddresses: producers.size,
    },
    consumerStats: {
      consumerAssets: consumerAddrs.size,
    },
    summary: {
      chainsScanned: Object.keys(DEX_FACTORIES).map(Number),
      factoriesScanned: Object.values(DEX_FACTORIES).reduce((s, f) => s + f.length, 0),
      factoryPairsChecked,
      poolInfoChecked,
      dexConsumerMatches: matches.length,
      uniqueProducers: uniqueProducers.length,
      uniquePairs: uniquePairs.length,
      watchCandidates: watchCandidates.length,
      routePositive: 0,
      signedActionJustified: false,
      closedReason: watchCandidates.length
        ? "DEX-mediated consumer routes found, but no exact swap economics or fork proof"
        : matches.length
          ? "DEX pairs found but below liquidity threshold"
          : "no DEX pool connects any producer token to a known lending consumer asset",
    },
    matches: matches.slice(0, 100),
    watchCandidates: watchCandidates.slice(0, 50),
    requiredForRoutePositive: [
      "DEX pool liquidity is material and stable",
      "exact swap quote (producer -> consumer token) is positive after gas/slippage",
      "consumer lending cap/pause state permits deposit/borrow",
      "exact LTV/LLTV-adjusted route economics are positive",
      "fork extraction proof",
    ],
    nextReadOnlyStep: matches.length
      ? "Exact-quote and fork-proof only the matched pairs with material liquidity and permissive consumer state."
      : "Refresh producer/consumer artifacts and DEX factory coverage; reopen only if DEX links new producer tokens to liquid consumer assets.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);

  if (!QUIET) {
    console.log(`DEX consumer routes: factories=${artifact.summary.factoriesScanned} pairs=${factoryPairsChecked} poolInfo=${poolInfoChecked} matches=${matches.length} watch=${watchCandidates.length} routePositive=${artifact.summary.routePositive}`);
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
