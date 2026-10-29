#!/usr/bin/env node
// classify-hyperevm-dex-pool-interfaces.js - read-only interface probe for HyperEVM DEX pools.
// RPC URLs are resolved in memory only and are never printed or written.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const ROUTE_ARTIFACT = path.join(WORKSPACE, "reports", "raw", "fast", "hyperevm-lst-lrt-oracle-routes.json");
const EXACT_ARTIFACT = path.join(WORKSPACE, "reports", "raw", "fast", "hyperevm-lst-lrt-exact-quotes.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "hyperevm-dex-pool-interfaces.json");
const CHAIN_ID = 999;
const FALLBACK_RPC = ["https://", "rpc.", "hyperliquid.", "xyz/evm"].join("");

const ABI = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
  "function stable() view returns (bool)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function globalState() view returns (uint160 price,int24 tick,uint16 fee,uint16 timepointIndex,uint8 communityFeeToken0,uint8 communityFeeToken1,bool unlocked)",
  "function metadata() view returns (uint256,uint256,uint256,uint256,bool,address,address)",
  "function getAmountOut(uint256 amountIn,address tokenIn) view returns (uint256)",
  "function getAmountOut(uint256 amountIn,address tokenIn,address tokenOut) view returns (uint256)",
]);

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function sanitizeError(error) {
  return String(error?.shortMessage || error?.message || error || "error").replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 180);
}

function lowerAddress(value) {
  try { return ethers.getAddress(value).toLowerCase(); } catch (_) { return null; }
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstValue(result) {
  try {
    if (!result?.ok) return null;
    return Array.from(result.value || [])[0] ?? null;
  } catch (_) {
    return null;
  }
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 10_000) {
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
    return json.result || null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcUrl() {
  const seen = new Set();
  for (const url of [...loadRpcUrls(), FALLBACK_RPC]) {
    if (seen.has(url)) continue;
    seen.add(url);
    const got = await rpcCall(url, "eth_chainId", [], 5000);
    try {
      if (got && Number(BigInt(got)) === CHAIN_ID) return url;
    } catch (_) {
      // ignore
    }
  }
  return null;
}

async function safeCall(provider, target, signature, args = []) {
  const iface = new ethers.Interface([`function ${signature}`]);
  const name = signature.slice(0, signature.indexOf("("));
  try {
    const raw = await provider.call({ to: target, data: iface.encodeFunctionData(name, args) });
    return { ok: true, value: iface.decodeFunctionResult(name, raw) };
  } catch (error) {
    return { ok: false, error: sanitizeError(error) };
  }
}

function pairSources(routeArtifact, exactArtifact) {
  const byPair = new Map();
  function add(pair, extra) {
    if (!pair) return;
    const pairAddress = ethers.getAddress(pair.pairAddress || pair.quote?.pairAddress || pair.address || pair);
    const key = pairAddress.toLowerCase();
    const row = byPair.get(key) || { pairAddress, dexIds: new Set(), urls: new Set(), tokens: new Map(), sourceRows: 0 };
    if (pair.dexId || extra?.dexId || pair.quote?.dexId) row.dexIds.add(pair.dexId || extra?.dexId || pair.quote?.dexId);
    if (pair.url || extra?.url || pair.quote?.url) row.urls.add(pair.url || extra?.url || pair.quote?.url);
    for (const token of [pair.baseToken, pair.quoteToken, extra?.collateral, extra?.loanAsset]) {
      const addr = lowerAddress(token?.address);
      if (addr) row.tokens.set(addr, { address: ethers.getAddress(token.address), symbol: token.symbol || null });
    }
    row.sourceRows += 1;
    byPair.set(key, row);
  }
  for (const target of routeArtifact?.targets || []) for (const pair of target.dexPairs || []) add(pair, {});
  for (const row of exactArtifact?.rows || []) add(row.quote, { dexId: row.quote?.dexId, url: row.quote?.url, collateral: row.collateral, loanAsset: row.loanAsset });
  return [...byPair.values()].map((row) => ({ ...row, dexIds: [...row.dexIds], urls: [...row.urls], tokens: [...row.tokens.values()] }));
}

async function classifyPair(provider, source) {
  const pairAddress = ethers.getAddress(source.pairAddress);
  const code = await provider.getCode(pairAddress);
  const codeBytes = code && code !== "0x" ? (code.length - 2) / 2 : 0;
  const [token0, token1, factory, reserves, stable, fee, tickSpacing, liquidity, slot0, globalState, metadata] = await Promise.all([
    safeCall(provider, pairAddress, "token0() view returns (address)"),
    safeCall(provider, pairAddress, "token1() view returns (address)"),
    safeCall(provider, pairAddress, "factory() view returns (address)"),
    safeCall(provider, pairAddress, "getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)"),
    safeCall(provider, pairAddress, "stable() view returns (bool)"),
    safeCall(provider, pairAddress, "fee() view returns (uint24)"),
    safeCall(provider, pairAddress, "tickSpacing() view returns (int24)"),
    safeCall(provider, pairAddress, "liquidity() view returns (uint128)"),
    safeCall(provider, pairAddress, "slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)"),
    safeCall(provider, pairAddress, "globalState() view returns (uint160 price,int24 tick,uint16 fee,uint16 timepointIndex,uint8 communityFeeToken0,uint8 communityFeeToken1,bool unlocked)"),
    safeCall(provider, pairAddress, "metadata() view returns (uint256,uint256,uint256,uint256,bool,address,address)"),
  ]);
  const token0Value = firstValue(token0);
  const token1Value = firstValue(token1);
  const t0 = token0Value ? ethers.getAddress(token0Value) : null;
  const t1 = token1Value ? ethers.getAddress(token1Value) : null;
  const amountIn = 10n ** 18n;
  const [quoteTwoArg, quoteThreeArg] = t0 ? await Promise.all([
    safeCall(provider, pairAddress, "getAmountOut(uint256 amountIn,address tokenIn) view returns (uint256)", [amountIn, t0]),
    t1 ? safeCall(provider, pairAddress, "getAmountOut(uint256 amountIn,address tokenIn,address tokenOut) view returns (uint256)", [amountIn, t0, t1]) : Promise.resolve({ ok: false, error: "missing token1" }),
  ]) : [{ ok: false, error: "missing token0" }, { ok: false, error: "missing token0" }];

  let family = "unknown";
  if (slot0.ok && liquidity.ok) family = "uniswap-v3-like";
  if (globalState.ok && liquidity.ok) family = "algebra-like";
  if (reserves.ok && stable.ok) family = "solidly-v2-like";
  else if (reserves.ok) family = "constant-product-v2-like";
  if (quoteTwoArg.ok || quoteThreeArg.ok) family = `${family}-onpool-quotable`;

  return {
    ...source,
    codePresent: codeBytes > 0,
    codeBytes,
    detectedFamily: family,
    token0: t0,
    token1: t1,
    factory: firstValue(factory) ? ethers.getAddress(firstValue(factory)) : null,
    interfaces: {
      token0: token0.ok,
      token1: token1.ok,
      factory: factory.ok,
      getReserves: reserves.ok,
      stable: stable.ok,
      fee: firstValue(fee) !== null ? asNumber(firstValue(fee)) : null,
      tickSpacing: firstValue(tickSpacing) !== null ? asNumber(firstValue(tickSpacing)) : null,
      liquidity: liquidity.ok,
      slot0: slot0.ok,
      globalState: globalState.ok,
      metadata: metadata.ok,
      getAmountOut2Arg: quoteTwoArg.ok,
      getAmountOut3Arg: quoteThreeArg.ok,
    },
    sampleQuote: {
      twoArg: firstValue(quoteTwoArg) !== null ? firstValue(quoteTwoArg).toString() : null,
      threeArg: firstValue(quoteThreeArg) !== null ? firstValue(quoteThreeArg).toString() : null,
      twoArgError: quoteTwoArg.ok ? null : quoteTwoArg.error,
      threeArgError: quoteThreeArg.ok ? null : quoteThreeArg.error,
    },
    routePositive: false,
    signedActionJustified: false,
  };
}

async function main() {
  const routeArtifact = readJson(ROUTE_ARTIFACT, {});
  const exactArtifact = readJson(EXACT_ARTIFACT, {});
  const rpcUrl = await resolveRpcUrl();
  if (!rpcUrl) throw new Error("No HyperEVM RPC endpoint resolved from local inventory or public fallback");
  const provider = new ethers.JsonRpcProvider(rpcUrl, { chainId: CHAIN_ID, name: "hyperevm" }, { staticNetwork: true });
  const [blockNumber, block] = await Promise.all([provider.getBlockNumber(), provider.getBlock("latest")]);
  const sources = pairSources(routeArtifact, exactArtifact);
  const rows = [];
  for (const source of sources) rows.push(await classifyPair(provider, source));
  const byFamily = rows.reduce((acc, row) => {
    acc[row.detectedFamily] = (acc[row.detectedFamily] || 0) + 1;
    return acc;
  }, {});
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/classify-hyperevm-dex-pool-interfaces.js",
    scope: "HyperEVM candidate DEX pool interface classification for exact quote integration",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    chain: { id: CHAIN_ID, name: "HyperEVM", blockNumber, timestamp: block?.timestamp || null },
    sourceArtifacts: [path.relative(WORKSPACE, ROUTE_ARTIFACT), path.relative(WORKSPACE, EXACT_ARTIFACT)],
    summary: {
      pairsInput: sources.length,
      codePresent: rows.filter((r) => r.codePresent).length,
      onPoolQuotable: rows.filter((r) => r.interfaces.getAmountOut2Arg || r.interfaces.getAmountOut3Arg).length,
      v3Like: rows.filter((r) => r.detectedFamily.includes("uniswap-v3-like")).length,
      algebraLike: rows.filter((r) => r.detectedFamily.includes("algebra-like")).length,
      v2Like: rows.filter((r) => r.detectedFamily.includes("v2-like")).length,
      byFamily,
      routePositive: 0,
      signedActionJustified: false,
    },
    rows,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
  console.log(`HyperEVM pool interfaces: pairs=${out.summary.pairsInput} v3=${out.summary.v3Like} algebra=${out.summary.algebraLike} v2=${out.summary.v2Like} onPoolQuote=${out.summary.onPoolQuotable}`);
  console.log(`Report: ${path.relative(WORKSPACE, OUT)}`);
}

main().catch((error) => {
  console.error(`classify-hyperevm-dex-pool-interfaces failed: ${sanitizeError(error)}`);
  process.exitCode = 1;
});
