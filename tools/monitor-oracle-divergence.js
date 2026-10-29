#!/usr/bin/env node
"use strict";
// monitor-oracle-divergence.js — read-only, keyless DYNAMIC oracle-divergence and
// constant-price sentinel.
//
// The static counterpart in this workspace watches fixed mis-scales (e.g. the PAXG/USDC
// oracle scale). This monitor watches the DYNAMIC case:
//
//   1) divergence: a live Morpho oracle price() diverges from an independent reference
//      (a canonical Chainlink feed, or a deep Uniswap V2/V3 pool spot discovered keylessly)
//      by more than 2% for stable/stable pairs or 5% otherwise, sustained across two
//      consecutive runs.
//   2) constant-price instant drain: a feedless/constant-price oracle with live borrows
//      fires the moment any supply-side liquidity appears (availableRaw > 0).
//
// Universe: every Morpho market with borrows >= $1k on chains 1/8453/42161/999/4663
// (Morpho API, deduped by oracle, bounded top 100 by borrows) plus the known
// feedless/constant-price oracle set from W6-L1b/W8-L3 evidence
// (238 Base stubs from w9 drain-route-spec + 17 non-MCOv2 custom oracles).
//
// Safety: eth_call plus keyless public HTTP (Morpho GraphQL API). NO signing, NO
// broadcast, NO transactions, NO forks, NO pool/oracle manipulation. RPC endpoint
// values and URLs stay process-only and are never printed, logged, hashed, or persisted.
//
// Exit: 0 = all dormant, 3 = at least one FIRED, 1 = operational error.
// Flags: --once --loop <seconds> --out <path> --max-hours N
//        --loop <seconds> --keep-watching-on-fire --no-deadline
// Without both opt-ins, FIRE exits immediately and loops stop after at most 72 hours.
// --keep-watching-on-fire alone retains the finite deadline; --no-deadline cannot
// be combined with --max-hours. A supervised stop releases the output owner.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { ethers } = require(path.join(ROOT, "tools", "node_modules", "ethers"));
const { resolveRpc, rpcCall } = require(path.join(ROOT, "tools", "shared-rpc.js"));
const { acquireCanaryOutputOwner, assertCanaryOutputOwner, CanaryOutputOwnershipError } =
  require(path.join(ROOT, "tools", "lib", "canary-output-owner.js"));
const { installCanaryReadOnlyStop } = require(path.join(ROOT, "tools", "lib", "canary-readonly-stop.js"));

const SCHEMA = "oracle-divergence-monitor/v1";
const HISTORY_SCHEMA = "oracle-divergence-monitor-history/v1";
const CHAIN_IDS = [1, 8453, 42161, 999, 4663];
const CHAIN_ALIAS = { 1: "ethereum", 8453: "base", 42161: "arbitrum", 999: "hyperevm", 4663: "robinhood" };
const DEFAULT_OUT = path.join(ROOT, "reports", "raw", "fast", "exploit-rearm-canary", "status-divergence.json");

const DRAIN_SPEC = path.join(ROOT, "reports", "raw", "fast", "w9-strike-routes-20260922", "drain-route-spec.json");
const CUSTOM_ORACLE_PROBE = path.join(ROOT, "reports", "raw", "fast", "w8-fresh-surface-round2-20260922", "custom-oracle-probe-w8.json");

const HISTORY_MAX_RUNS = 50;
const MAX_LOOP_HOURS = 72;
const DEFAULT_MAX_LOOP_HOURS = 72;

const API_URL = "https://blue-api.morpho.org/graphql";
const API_PAGE = 100;
const MIN_BORROW_USD = 1000;
const MAX_API_MARKETS = 100;
const MAX_SENTINELS = 512;
const BIND_CHUNK = 50;

const STABLE_BPS = 200;      // 2%
const NON_STABLE_BPS = 500;  // 5%
const SUSTAIN_RUNS = 2;      // consecutive runs over threshold
const CONSTANT_STREAK_RUNS = 5; // consecutive identical price() reads before dynamic constancy is claimed
const CONSTANT_MIN_WINDOW_MS = 3_600_000; // and at least this long since the first identical read
const SCALE_SUSPECT_BPS = 1_000_000; // >100x gap is a scale error, not a price move
const MIN_DEX_DEPTH_USD = 100_000;
const MAX_REFERENCE_SOURCES = 4; // recursion is capped at two quote hops
const SOURCE_CONSTANT_SHA256 = "d8e47e5034747b901007f6d47c5a07b431fb99a8fb2f73af70466575aa6fa5bd";
const CHAINLINK_MAX_AGE_SECONDS = 172_800; // 48 h
const PRICE_DECIMALS = 36;
const MAX_RUN_GAP_MS = 15 * 60_000;
const MAX_HEADER_AGE_SECONDS = 300;

const MORPHO_IF = new ethers.Interface([
  "function market(bytes32) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function idToMarketParams(bytes32) view returns ((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv))",
]);
const IF = new ethers.Interface([
  "function price() view returns (uint256)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function getPair(address,address) view returns (address)",
  "function getPool(address,address,uint24) view returns (address)",
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const STABLE_EXTRA = new Set(["DAI", "GHO", "AUSD", "PYUSD", "CRVUSD", "FRAX", "RLUSD", "USDG", "USDE"]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// Official Morpho deployment registry: Ethereum Morpho Blue; Base Morpho Blue
// independently verified at BaseScan creation block 13,977,148; HyperEVM
// Morpho Blue verified at explorer deployment block 1,988,429. No other
// chain fallback is assumed without independently sourced deployment evidence.
const TRUSTED_MORPHO_BLUE = Object.freeze({
  1: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  8453: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  999: "0x68e37dE8d93d3496ae143F2E900490f6280C57cD",
});

// ---------------- verified reference registry ----------------
// Chainlink feeds verified live (description/decimals/latestRoundData) during W10-L1.
// Keyed by lowercase token address per chain. `feed` is a canonical Chainlink aggregator.
const CHAINLINK_TOKENS = {
  1: [
    { token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", feed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", decimals: 8, name: "ETH/USD" },
    { token: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", feed: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c", decimals: 8, name: "BTC/USD" },
    { token: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", feed: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c", decimals: 8, name: "BTC/USD" },
    { token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", feed: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6", decimals: 8, name: "USDC/USD" },
    { token: "0xdAC17F958D2ee523a2206206994597C13D831ec7", feed: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D", decimals: 8, name: "USDT/USD" },
    { token: "0x6B175474E89094C44Da98b954EedeAC495271d0F", feed: "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9", decimals: 8, name: "DAI/USD" },
  ],
  8453: [
    { token: "0x4200000000000000000000000000000000000006", feed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", decimals: 8, name: "ETH/USD" },
    { token: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", feed: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F", decimals: 8, name: "BTC/USD" },
    { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", feed: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B", decimals: 8, name: "USDC/USD" },
  ],
  42161: [
    { token: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", feed: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", decimals: 8, name: "ETH/USD" },
    { token: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", feed: "0x6ce185860a4963106506C203335A2910413708e9", decimals: 8, name: "BTC/USD" },
    { token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", feed: "0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3", decimals: 8, name: "USDC/USD" },
    { token: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", feed: "0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3", decimals: 8, name: "USDC/USD" },
  ],
};
const CHAINLINK_BY_TOKEN = {};
for (const [cid, rows] of Object.entries(CHAINLINK_TOKENS)) {
  CHAINLINK_BY_TOKEN[Number(cid)] = {};
  for (const row of rows) CHAINLINK_BY_TOKEN[Number(cid)][row.token.toLowerCase()] = { feed: row.feed, decimals: row.decimals, name: row.name };
}

// Keyless Uniswap factory discovery. Factories verified live during W10-L1.
const DEX = {
  1: { v2: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", v3: "0x1F98431c8aD98523631AE4a59f267346ea31F984" },
  8453: { v2: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6", v3: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" },
  42161: { v2: "0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9", v3: "0x1F98431c8aD98523631AE4a59f267346ea31F984" },
};
const QUOTE_TOKENS = {
  1: [
    { token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, name: "USDC" },
    { token: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, name: "USDT" },
    { token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18, name: "WETH" },
  ],
  8453: [
    { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, name: "USDC" },
    { token: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6, name: "USDT" },
    { token: "0x4200000000000000000000000000000000000006", decimals: 18, name: "WETH" },
  ],
  42161: [
    { token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, name: "USDC" },
    { token: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, name: "USDT" },
    { token: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, name: "WETH" },
  ],
};
const V3_FEES = [500, 3000, 10000, 100];

// ---------------- helpers ----------------
function sanitize(value) {
  return String(value || "").replace(/https?:\/\/\S+/g, "<rpc>").slice(0, 300);
}
function b(v) { return typeof v === "bigint" ? v : BigInt(v); }
function decode(iface, fn, raw) {
  if (!raw || raw === "0x") return null;
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}
function isUsdStable(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (!s) return false;
  return s.includes("USD") || STABLE_EXTRA.has(s);
}
function isAddress(value) { return typeof value === "string" && ADDRESS_RE.test(value); }
function isHex32(value) { return typeof value === "string" && HEX32.test(value); }
function pinnedUniverse(loader) {
  // The loader verifies the original source bytes and baseline IDs. Never substitute
  // the live API's membership for a pinned observational identity.
  const source = loader();
  if (!isHex32(`0x${source?.sha256 || ""}`) || source.sourceConstantSha256 !== SOURCE_CONSTANT_SHA256 ||
      !Array.isArray(source.rows) || source.rows.length !== 351)
    throw new Error("pinned-universe-invalid");
  const seen = new Set();
  const rows = source.rows.map((row) => {
    const expected = `div:${row.chainId}:${String(row.oracle).slice(2, 10)}`;
    if (!CHAIN_IDS.includes(row.chainId) || !isAddress(row.oracle) || !isHex32(row.marketId) ||
        row.sentinel !== expected || typeof row.pair !== "string" || !row.pair ||
        typeof row.kind !== "string" || !row.kind || typeof row.provenanceConstant !== "boolean" ||
        seen.has(row.sentinel) ||
        (row.collateralToken != null && !isAddress(row.collateralToken)) ||
        (row.loanToken != null && !isAddress(row.loanToken)))
      throw new Error("pinned-universe-invalid");
    seen.add(row.sentinel);
    return { ...row, pinned: true, coll: null, loan: null, morpho: null };
  });
  return { sha256: source.sha256.toLowerCase(), sourceConstantSha256: source.sourceConstantSha256, rows };
}
function finiteOrNull(value) {
  if (value == null || typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}
async function poolMap(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map((item, j) => fn(item, i + j))));
  }
  return out;
}
async function fetchJson(query, timeoutMs = 30000) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
        signal: ctrl.signal,
      });
      const json = await res.json();
      if (!res.ok || !json || json.errors) throw new Error("api-error");
      return json.data;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("api-error");
}

// ---------------- universe: Morpho API markets ----------------
async function fetchApiMarkets(chainId) {
  const rows = [];
  for (let page = 0; page < 3; page++) {
    const q = `{ markets(first: ${API_PAGE}, skip: ${page * API_PAGE}, orderBy: BorrowAssetsUsd, orderDirection: Desc, ` +
      `where: { chainId_in: [${chainId}], borrowAssetsUsd_gte: ${MIN_BORROW_USD} }) { ` +
      `items { marketId lltv collateralAsset { address symbol decimals } loanAsset { address symbol decimals } ` +
      `oracle { address } morphoBlue { address } state { borrowAssetsUsd supplyAssetsUsd } } } }`;
    const data = await fetchJson(q);
    const items = (data && data.markets && data.markets.items) || [];
    rows.push(...items);
    if (items.length < API_PAGE) break;
  }
  return rows.map((m) => ({
    chainId,
    marketId: m.marketId,
    oracle: m.oracle && m.oracle.address,
    pair: `${m.collateralAsset ? m.collateralAsset.symbol : "?"}/${m.loanAsset ? m.loanAsset.symbol : "?"}`,
    coll: m.collateralAsset || null,
    loan: m.loanAsset || null,
    morpho: m.morphoBlue && m.morphoBlue.address,
    lltv: m.lltv,
    borrowUsd: m.state && Number.isFinite(Number(m.state.borrowAssetsUsd)) ? Number(m.state.borrowAssetsUsd) : null,
    kind: "api-market",
    provenanceConstant: false,
  })).filter((r) => isHex32(r.marketId) && isAddress(r.oracle) && r.coll && r.loan);
}

// Bind known feedless/constant oracle addresses to their markets via the API.
async function bindOracles(chainId, oracleAddresses) {
  const bound = new Map();
  const unique = [...new Set(oracleAddresses.map((a) => a.toLowerCase()))];
  for (let i = 0; i < unique.length; i += BIND_CHUNK) {
    const chunk = unique.slice(i, i + BIND_CHUNK);
    const list = chunk.map((a) => JSON.stringify(a)).join(",");
    const q = `{ markets(first: 200, where: { chainId_in: [${chainId}], oracleAddress_in: [${list}] }) { ` +
      `items { marketId collateralAsset { address symbol decimals } loanAsset { address symbol decimals } ` +
      `oracle { address } morphoBlue { address } state { borrowAssetsUsd supplyAssetsUsd } } } }`;
    let data;
    try { data = await fetchJson(q); } catch (_) { continue; }
    const items = (data && data.markets && data.markets.items) || [];
    for (const m of items) {
      const key = String(m.oracle && m.oracle.address).toLowerCase();
      const borrowUsd = m.state && Number.isFinite(Number(m.state.borrowAssetsUsd)) ? Number(m.state.borrowAssetsUsd) : 0;
      const prev = bound.get(key);
      if (!prev || borrowUsd > (prev.borrowUsd || 0)) {
        bound.set(key, {
          marketId: m.marketId,
          coll: m.collateralAsset || null,
          loan: m.loanAsset || null,
          morpho: m.morphoBlue && m.morphoBlue.address,
          borrowUsd,
        });
      }
    }
  }
  return bound;
}

// ---------------- universe: known feedless/constant set ----------------
function loadConstantOracles() {
  const out = [];
  try {
    const spec = JSON.parse(fs.readFileSync(DRAIN_SPEC, "utf8"));
    for (const group of (spec.groups || [])) {
      if (group.class !== "stub-constant-price-oracle") continue;
      for (const row of (group.rows || [])) {
        if (!isAddress(row.oracle)) continue;
        out.push({
          chainId: Number(group.chainId), oracle: row.oracle, pair: row.pair || null,
          marketId: isHex32(row.marketId) ? row.marketId : null, morpho: null,
          kind: "constant-oracle", provenanceConstant: true,
        });
      }
    }
  } catch (_) { /* evidence absent: fail open to API-only universe */ }
  try {
    const probe = JSON.parse(fs.readFileSync(CUSTOM_ORACLE_PROBE, "utf8"));
    for (const row of (probe.oracles || [])) {
      if (!isAddress(row.oracle)) continue;
      out.push({
        chainId: Number(row.chainId), oracle: row.oracle, pair: row.pair || null,
        marketId: isHex32(row.marketId) ? row.marketId : null, morpho: row.morpho || null,
          // Being a non-MCOv2 custom oracle does not prove its price is constant.
          kind: "custom-oracle", provenanceConstant: false,
      });
    }
  } catch (_) { /* evidence absent */ }
  return out;
}

function assembleUniverse(apiMarkets, constantOracles) {
  const merged = new Map();
  const keyOf = (chainId, oracle) => `${chainId}:${String(oracle).toLowerCase()}`;

  const sortedApi = [...apiMarkets].sort((a, b) => (b.borrowUsd || 0) - (a.borrowUsd || 0));
  let apiKept = 0;
  for (const m of sortedApi) {
    const key = keyOf(m.chainId, m.oracle);
    if (merged.has(key)) continue;
    if (apiKept >= MAX_API_MARKETS) break;
    merged.set(key, m);
    apiKept++;
  }

  for (const c of constantOracles) {
    if (!CHAIN_IDS.includes(c.chainId)) continue;
    const key = keyOf(c.chainId, c.oracle);
    const existing = merged.get(key);
    if (existing) {
      existing.kind = c.kind;
      existing.provenanceConstant = existing.provenanceConstant === true || c.provenanceConstant === true;
      if (!existing.pair && c.pair) existing.pair = c.pair;
      continue;
    }
    merged.set(key, {
      chainId: c.chainId, marketId: c.marketId, oracle: c.oracle, pair: c.pair,
      coll: null, loan: null, morpho: c.morpho, lltv: null, borrowUsd: null,
      kind: c.kind, provenanceConstant: c.provenanceConstant === true, unbound: !c.marketId,
    });
  }
  const rows = [...merged.values()].slice(0, MAX_SENTINELS);
  return rows;
}

// ---------------- reference pricing ----------------
function makeChainCtx(url, blockHex) {
  return {
    url, blockHex,
    feedCache: new Map(),
    refCache: new Map(),
    dexCache: new Map(),
    call(to, data, ms = 20000) {
      return rpcCall(this.url, "eth_call", [{ to, data }, this.blockHex], ms);
    },
  };
}

async function readChainlink(ctx, entry) {
  if (ctx.feedCache.has(entry.feed)) return ctx.feedCache.get(entry.feed);
  let result = null;
  try {
    // decimals is part of the curated registry; only the round data is read live.
    const raw = await ctx.call(entry.feed, IF.encodeFunctionData("latestRoundData", []));
    const d = decode(IF, "latestRoundData", raw);
    if (d) {
      const answer = b(d[1]);
      const updatedAt = Number(d[3]);
      const ageSec = updatedAt > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - updatedAt) : null;
      if (answer > 0n && ageSec != null && ageSec <= CHAINLINK_MAX_AGE_SECONDS) {
        result = { price: Number(answer) / 10 ** entry.decimals, source: `chainlink:${entry.name}`,
          feed: entry.feed, sourceAddresses: [entry.feed.toLowerCase()], ageSec };
      }
    }
  } catch (_) { result = null; }
  ctx.feedCache.set(entry.feed, result);
  return result;
}

function composedSources(address, quoteUsd) {
  const inherited = quoteUsd?.sourceAddresses;
  if (!isAddress(address) || !Array.isArray(inherited) || inherited.length < 1 ||
      inherited.length >= MAX_REFERENCE_SOURCES || !inherited.every((a) =>
        isAddress(a) && a === a.toLowerCase())) return null;
  const sources = [...new Set([address.toLowerCase(), ...inherited])];
  return sources.length <= MAX_REFERENCE_SOURCES ? sources : null;
}

async function v3Spot(ctx, chainId, token, decimals, quote, quoteUsd) {
  const dex = DEX[chainId];
  const tokenLc = token.toLowerCase();
  const quoteLc = quote.token.toLowerCase();
  for (const fee of V3_FEES) {
    let pool = null;
    try {
      const raw = await ctx.call(dex.v3, IF.encodeFunctionData("getPool", [token, quote.token, fee]));
      pool = decode(IF, "getPool", raw)?.[0];
    } catch (_) { pool = null; }
    if (!pool || pool === ZERO_ADDRESS) continue;
    try {
      const [t0Raw, t1Raw, slotRaw, balRaw] = await Promise.all([
        ctx.call(pool, IF.encodeFunctionData("token0", [])),
        ctx.call(pool, IF.encodeFunctionData("token1", [])),
        ctx.call(pool, IF.encodeFunctionData("slot0", [])),
        ctx.call(quote.token, IF.encodeFunctionData("balanceOf", [pool])),
      ]);
      const t0 = decode(IF, "token0", t0Raw)?.[0];
      const t1 = decode(IF, "token1", t1Raw)?.[0];
      const slot = decode(IF, "slot0", slotRaw);
      const quoteBal = decode(IF, "balanceOf", balRaw)?.[0];
      if (!t0 || !t1 || !slot || quoteBal == null) continue;
      const sqrt = Number(b(slot[0]));
      if (!Number.isFinite(sqrt) || sqrt <= 0) continue;
      const ratio = (sqrt / 2 ** 96) ** 2; // raw token1 per raw token0
      let quotePerToken;
      if (t0.toLowerCase() === tokenLc && t1.toLowerCase() === quoteLc) {
        quotePerToken = ratio * 10 ** (decimals - quote.decimals);
      } else if (t0.toLowerCase() === quoteLc && t1.toLowerCase() === tokenLc) {
        if (ratio <= 0) continue;
        quotePerToken = (1 / ratio) * 10 ** (decimals - quote.decimals);
      } else continue;
      if (!Number.isFinite(quotePerToken) || quotePerToken <= 0) continue;
      const depthUsd = Number(quoteBal) / 10 ** quote.decimals * quoteUsd.price;
      if (!Number.isFinite(depthUsd) || depthUsd < MIN_DEX_DEPTH_USD) continue;
       return { price: quotePerToken * quoteUsd.price, source: `uniswap-v3:${pool}`, pool,
         sourceAddresses: composedSources(pool, quoteUsd), depthUsd };
    } catch (_) { continue; }
  }
  return null;
}

async function v2Spot(ctx, chainId, token, decimals, quote, quoteUsd) {
  const dex = DEX[chainId];
  const tokenLc = token.toLowerCase();
  const quoteLc = quote.token.toLowerCase();
  let pair = null;
  try {
    const raw = await ctx.call(dex.v2, IF.encodeFunctionData("getPair", [token, quote.token]));
    pair = decode(IF, "getPair", raw)?.[0];
  } catch (_) { pair = null; }
  if (!pair || pair === ZERO_ADDRESS) return null;
  try {
    const [t0Raw, t1Raw, resRaw] = await Promise.all([
      ctx.call(pair, IF.encodeFunctionData("token0", [])),
      ctx.call(pair, IF.encodeFunctionData("token1", [])),
      ctx.call(pair, IF.encodeFunctionData("getReserves", [])),
    ]);
    const t0 = decode(IF, "token0", t0Raw)?.[0];
    const t1 = decode(IF, "token1", t1Raw)?.[0];
    const reserves = decode(IF, "getReserves", resRaw);
    if (!t0 || !t1 || !reserves) return null;
    const r0 = b(reserves[0]), r1 = b(reserves[1]);
    let reserveToken, reserveQuote;
    if (t0.toLowerCase() === tokenLc && t1.toLowerCase() === quoteLc) { reserveToken = r0; reserveQuote = r1; }
    else if (t0.toLowerCase() === quoteLc && t1.toLowerCase() === tokenLc) { reserveToken = r1; reserveQuote = r0; }
    else return null;
    if (reserveToken <= 0n) return null;
    const tokenHuman = Number(reserveToken) / 10 ** decimals;
    const quoteHuman = Number(reserveQuote) / 10 ** quote.decimals;
    if (!Number.isFinite(tokenHuman) || tokenHuman <= 0) return null;
    const depthUsd = quoteHuman * quoteUsd.price;
    if (!Number.isFinite(depthUsd) || depthUsd < MIN_DEX_DEPTH_USD) return null;
     return { price: (quoteHuman / tokenHuman) * quoteUsd.price, source: `uniswap-v2:${pair}`, pool: pair,
       sourceAddresses: composedSources(pair, quoteUsd), depthUsd };
  } catch (_) { return null; }
}

async function resolveUsd(ctx, chainId, token, decimals, depth = 0) {
  if (!isAddress(token) || !Number.isInteger(decimals) || depth > 2) return null;
  const key = String(token).toLowerCase();
  if (ctx.refCache.has(key)) return ctx.refCache.get(key);
  let result = null;
  const cl = CHAINLINK_BY_TOKEN[chainId] && CHAINLINK_BY_TOKEN[chainId][key];
  if (cl) result = await readChainlink(ctx, cl);
  if (!result && DEX[chainId]) {
    for (const quote of (QUOTE_TOKENS[chainId] || [])) {
      if (quote.token.toLowerCase() === key) continue;
      const quoteUsd = await resolveUsd(ctx, chainId, quote.token, quote.decimals, depth + 1);
      if (!quoteUsd) continue;
      const spot = (await v3Spot(ctx, chainId, token, decimals, quote, quoteUsd))
        || (await v2Spot(ctx, chainId, token, decimals, quote, quoteUsd));
      if (spot) { result = spot; break; }
    }
  }
  ctx.refCache.set(key, result);
  return result;
}

// ---------------- evaluation ----------------
function isConfirmedConstant(spec) {
  return spec.kind === "constant-oracle" && spec.provenanceConstant === true;
}

function continuousRun(history, chainId) {
  const at = history?.lastAt;
  const priorMs = typeof at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at) ? Date.parse(at) : NaN;
  const nowMs = history?.nowMs;
  const previousBlock = history?.previousChains?.[String(chainId)];
  const currentBlock = history?.chainBlocks?.[String(chainId)];
  return Number.isSafeInteger(nowMs) && Number.isFinite(priorMs) && nowMs > priorMs &&
    nowMs - priorMs <= MAX_RUN_GAP_MS && Number.isSafeInteger(previousBlock) && previousBlock >= 0 &&
    Number.isSafeInteger(currentBlock) && currentBlock > previousBlock;
}

function ratioFromPrice(priceWei, collDecimals, loanDecimals) {
  const scaleExp = PRICE_DECIMALS + Number(loanDecimals) - Number(collDecimals);
  const denom = 10 ** scaleExp;
  if (!Number.isFinite(denom) || denom <= 0) return null;
  const ratio = Number(priceWei) / denom;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

async function evaluateSentinel(spec, ctx, history) {
  const key = `${spec.chainId}:${String(spec.oracle).toLowerCase()}`;
  const row = {
    sentinel: spec.pinned ? spec.sentinel : `div:${spec.chainId}:${String(spec.oracle).slice(2, 10)}`,
    chainId: spec.chainId,
    oracle: spec.oracle,
    marketId: spec.marketId || null,
    pair: spec.pair || null,
    kind: spec.kind || "api-market",
    fired: false, ok: true, reason: "", error: null,
    referenceOk: false, referenceSource: null,
    oracleRatio: null, referenceRatio: null, divergenceBps: null,
    thresholdBps: NON_STABLE_BPS, scaleSuspect: false,
    sustained: false, feedless: !spec.pinned && isConfirmedConstant(spec), constantAcrossRuns: false,
    borrowsPositive: false, borrowRaw: null, availableRaw: null,
    actionable: false, consecutiveOver: 0,
    measurements: { marketBound: false, marketStateReadable: false },
  };
  if (spec.pinned) {
    row.observationalOnly = true;
    row.noRouteProof = true;
    row.structuralVerified = false;
    row.structuralCandidate = false;
  }

  const officialMorpho = TRUSTED_MORPHO_BLUE[spec.chainId];
  if (spec.pinned && !officialMorpho) {
    row.ok = false; row.error = "morpho-deployment-unverified";
    row.reason = "pinned market has no verified Morpho Blue deployment";
    return row;
  }
  if (officialMorpho && spec.morpho != null &&
      (!isAddress(spec.morpho) || spec.morpho.toLowerCase() !== officialMorpho.toLowerCase())) {
    row.ok = false; row.error = "morpho-deployment-mismatch";
    row.reason = "supplied Morpho Blue deployment conflicts with the verified chain deployment";
    return row;
  }
  if (!officialMorpho && !isAddress(spec.morpho)) {
    row.ok = false; row.error = "morpho-deployment-unverified";
    row.reason = "Morpho Blue deployment address is required for this chain";
    return row;
  }
  const morpho = officialMorpho || spec.morpho;

  let priceRaw = null;
  try {
    const raw = await ctx.call(spec.oracle, IF.encodeFunctionData("price", []));
    const decoded = decode(IF, "price", raw);
    if (!decoded) { row.ok = false; row.error = "oracle-price-unreadable"; row.reason = "oracle price() unreadable"; return row; }
    priceRaw = b(decoded[0]);
    if (priceRaw <= 0n) { row.ok = false; row.error = "oracle-price-nonpositive"; row.reason = "oracle price() <= 0"; return row; }
  } catch (e) {
    row.ok = false; row.error = sanitize(e.message || e); row.reason = "oracle price() read failed"; return row;
  }
  row.measurements.oraclePrice = priceRaw.toString();

  // Market binding / on-chain market state.
  let coll = spec.coll, loan = spec.loan;
  if (isHex32(spec.marketId)) {
    try {
      const [pRaw, mRaw] = await Promise.all([
        ctx.call(morpho, MORPHO_IF.encodeFunctionData("idToMarketParams", [spec.marketId])),
        ctx.call(morpho, MORPHO_IF.encodeFunctionData("market", [spec.marketId])),
      ]);
      const params = decode(MORPHO_IF, "idToMarketParams", pRaw)?.[0];
      const state = decode(MORPHO_IF, "market", mRaw);
      if (params) {
        const marketOracle = String(params[2]);
        if (marketOracle.toLowerCase() !== String(spec.oracle).toLowerCase()) {
          row.ok = false; row.error = "oracle-mismatch";
          row.reason = "idToMarketParams oracle does not match the spec oracle";
          return row;
        }
        if (![0, 1, 2, 3].every((index) => isAddress(params[index])) ||
            ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
              ["address", "address", "address", "address", "uint256"],
              [params[0], params[1], params[2], params[3], params[4]]
            )).toLowerCase() !== spec.marketId.toLowerCase()) {
          row.ok = false; row.error = "market-id-mismatch";
          row.reason = "idToMarketParams does not bind the requested market";
          return row;
        }
        row.measurements.marketBound = true;
        row.measurements.collateralToken = String(params[1]);
        row.measurements.loanToken = String(params[0]);
        if (spec.pinned && (
          (spec.collateralToken && spec.collateralToken.toLowerCase() !== String(params[1]).toLowerCase()) ||
          (spec.loanToken && spec.loanToken.toLowerCase() !== String(params[0]).toLowerCase()))) {
          row.ok = false; row.error = "historical-token-mismatch";
          row.reason = "live market token differs from historical pinned token";
          return row;
        }
        if (spec.pinned) {
          const tokens = [String(params[1]), String(params[0])];
          let decimals;
          try {
            decimals = await Promise.all(tokens.map(async (token) => {
              const raw = await ctx.call(token, IF.encodeFunctionData("decimals", []));
              const result = decode(IF, "decimals", raw);
              return result == null ? null : Number(result[0]);
            }));
          } catch (_) { decimals = null; }
          if (!decimals || decimals.some((n) => !Number.isInteger(n) || n < 0 || n > 36)) {
            row.ok = false; row.error = "token-decimals-unreadable";
            row.reason = "pinned market token decimals unavailable or unreasonable";
            return row;
          }
          coll = { address: tokens[0], decimals: decimals[0] };
          loan = { address: tokens[1], decimals: decimals[1] };
          row.measurements.collateralDecimals = decimals[0];
          row.measurements.loanDecimals = decimals[1];
        }
      } else {
        row.ok = false; row.error = "market-params-unreadable";
      }
      if (state) {
        const supply = b(state[0]), borrow = b(state[2]);
        row.borrowRaw = borrow.toString();
        row.availableRaw = (supply > borrow ? supply - borrow : 0n).toString();
        row.borrowsPositive = borrow > 0n;
        row.measurements.marketStateReadable = true;
      } else {
        row.ok = false; row.error ||= "market-state-unreadable";
      }
    } catch (e) {
      row.ok = false; row.error ||= "market-read-failed";
      row.measurements.marketReadError = sanitize(e.message || e);
    }
  } else {
    row.ok = false; row.error = "market-id-invalid";
  }

  // An unchanged price is telemetry, not proof of a feedless oracle: legitimate
  // feeds, vault rates and stable prices can remain equal for many hours.
  const prevPrice = history && history.prices ? history.prices[key] : undefined;
  const prevStreak = history && history.priceStreak ? Number(history.priceStreak[key] || 0) : 0;
  const prevFirstSeen = history && history.priceFirstSeen ? Number(history.priceFirstSeen[key] || 0) : 0;
  const nowMs = history && Number.isFinite(history.nowMs) ? history.nowMs : Date.now();
  const sameAsPrev = continuousRun(history, spec.chainId) && prevPrice != null && String(prevPrice) === priceRaw.toString();
  const priceStreak = sameAsPrev ? prevStreak + 1 : 1;
  const firstSeen = sameAsPrev && prevFirstSeen > 0 ? prevFirstSeen : nowMs;
  row.measurements.priceStreak = priceStreak;
  row.measurements.priceFirstSeenMs = firstSeen;
  row.constantAcrossRuns = priceStreak >= CONSTANT_STREAK_RUNS && (nowMs - firstSeen) >= CONSTANT_MIN_WINDOW_MS;

  // Reference ratio.
  let refRatio = null;
  let refSource = null;
  if (coll && loan && Number.isInteger(Number(coll.decimals)) && Number.isInteger(Number(loan.decimals))) {
    const collUsd = await resolveUsd(ctx, spec.chainId, coll.address, Number(coll.decimals));
    const loanUsd = await resolveUsd(ctx, spec.chainId, loan.address, Number(loan.decimals));
     const independent = (ref) => ref && (!spec.pinned ||
       (Array.isArray(ref.sourceAddresses) && ref.sourceAddresses.length > 0 &&
         ref.sourceAddresses.length <= MAX_REFERENCE_SOURCES &&
         ref.sourceAddresses.every((a) => isAddress(a) && a === a.toLowerCase() &&
           a !== spec.oracle.toLowerCase())));
    if (independent(collUsd) && independent(loanUsd) && loanUsd.price > 0) {
      refRatio = collUsd.price / loanUsd.price;
      refSource = `${collUsd.source}|${loanUsd.source}`;
      row.measurements.collateralUsd = Number(collUsd.price.toFixed(8));
      row.measurements.loanUsd = Number(loanUsd.price.toFixed(8));
    } else {
      row.measurements.referenceMissing = !independent(collUsd) ? "collateral-unresolved-or-circular" : "loan-unresolved-or-circular";
    }
  } else {
    row.measurements.referenceMissing = "asset-binding-missing";
  }

   const stablePair = !spec.pinned && isUsdStable(coll && coll.symbol) && isUsdStable(loan && loan.symbol);
  row.thresholdBps = stablePair ? STABLE_BPS : NON_STABLE_BPS;

  if (coll && loan && refRatio != null) {
    const oracleRatio = ratioFromPrice(priceRaw, Number(coll.decimals), Number(loan.decimals));
    if (oracleRatio != null) {
      row.oracleRatio = finiteOrNull(oracleRatio);
      row.referenceRatio = finiteOrNull(refRatio);
      row.referenceSource = refSource;
      row.referenceOk = true;
      const divergenceBps = Math.round(Math.abs(oracleRatio - refRatio) / refRatio * 10_000);
      row.divergenceBps = finiteOrNull(divergenceBps);
      if (row.divergenceBps != null && row.divergenceBps > SCALE_SUSPECT_BPS) {
        row.scaleSuspect = true;
        row.measurements.scaleSuspect = true;
      }
    }
  }

   if (spec.pinned) row.structuralVerified = spec.provenanceConstant === true && row.ok &&
     row.measurements.marketBound && row.measurements.marketStateReadable &&
     Number.isInteger(row.measurements.collateralDecimals) && Number.isInteger(row.measurements.loanDecimals);
   if (spec.pinned && (!row.measurements.marketBound || !row.measurements.marketStateReadable ||
       (!row.referenceOk && !row.structuralVerified))) {
      row.ok = false;
      row.error ||= row.measurements.referenceMissing ? "reference-unavailable" : "market-binding-unavailable";
    }
   const over = row.ok && row.referenceOk && row.divergenceBps != null && row.divergenceBps > row.thresholdBps;
  row.consecutiveOver = over ? (continuousRun(history, spec.chainId)
    ? Number((history && history.consecutiveOver ? history.consecutiveOver[key] : 0) || 0) : 0) + 1 : 0;
  row.sustained = row.consecutiveOver >= SUSTAIN_RUNS;

  const availableRaw = row.availableRaw == null ? null : BigInt(row.availableRaw);
  // Exhausted non-pinned scale errors remain telemetry, not firing alarms.
  const exhaustedScaleSuspect = !spec.pinned && row.scaleSuspect === true && (availableRaw ?? 0n) === 0n;
    const structuralPositive = spec.pinned === true && row.structuralVerified && row.ok && row.borrowsPositive &&
      availableRaw != null && availableRaw > 0n;
    if (spec.pinned) row.structuralCandidate = structuralPositive;
    row.actionable = !spec.pinned && row.ok && row.feedless && row.measurements.marketBound &&
      row.measurements.marketStateReadable && row.borrowsPositive && availableRaw != null && availableRaw > 0n;
    row.fired = row.ok && !exhaustedScaleSuspect && (row.sustained || row.actionable);

    if (row.fired) {
    row.reason = row.actionable
      ? `source-confirmed constant oracle with borrows > 0 and availableRaw ${row.availableRaw} (manual route verification required)`
      : `divergence ${row.divergenceBps}bps > ${row.thresholdBps}bps sustained across ${row.consecutiveOver} runs` +
        (row.scaleSuspect ? " (scale-suspect: >100x gap, likely an oracle scale error)" : "");
  } else if (!row.ok) {
    row.reason = row.reason || "sentinel read failed";
  } else if (exhaustedScaleSuspect) {
    row.reason = "not-fired: scale-suspect oracle in a zero-liquidity market";
    } else if (!row.referenceOk) {
      row.reason = row.structuralVerified
        ? `structural-only/reference-unavailable: ${row.structuralCandidate ? "positive liquidity candidate; observational only" : "no positive liquidity candidate"}`
       : `not-fired: reference unavailable (${row.measurements.referenceMissing || "no independent reference"})`;
  } else if (over) {
    row.reason = `pending: divergence ${row.divergenceBps}bps > ${row.thresholdBps}bps on run ${row.consecutiveOver} of ${SUSTAIN_RUNS}` +
      (row.scaleSuspect ? " (scale-suspect: >100x gap, likely an oracle scale error)" : "");
  } else {
    row.reason = `dormant: divergence ${row.divergenceBps}bps <= ${row.thresholdBps}bps`;
  }
  row.measurements.feedless = row.feedless;
  row.measurements.stablePair = stablePair;
  row.measurements.divergenceBps = row.divergenceBps;
  return row;
}

// ---------------- run ----------------
function readHistory(historyPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    if (parsed && parsed.schema === HISTORY_SCHEMA && Array.isArray(parsed.runs)) return parsed;
  } catch (_) { /* first run */ }
  return { schema: HISTORY_SCHEMA, generatedAt: null, runs: [] };
}

function historyCarry(history) {
  const last = history.runs.length ? history.runs[history.runs.length - 1] : null;
  return {
    prices: (last && last.prices) || {},
    consecutiveOver: (last && last.consecutiveOver) || {},
    priceStreak: (last && last.priceStreak) || {},
    priceFirstSeen: (last && last.priceFirstSeen) || {},
    lastAt: last?.at || null,
    previousChains: last?.chains || {},
  };
}
function pinnedHistoryCarry(history, sha256, sourceConstantSha256) {
  const last = history.runs.length ? history.runs[history.runs.length - 1] : null;
  if (!last || last.pinnedUniverseSha256 !== sha256 || last.sourceConstantSha256 !== sourceConstantSha256)
    return historyCarry({ runs: [] });
  return historyCarry({ runs: [last] });
}

class DivergenceScanStopped extends Error {
  constructor() { super("divergence-scan-stopped"); }
}

function assertDivergenceHistoryPath(outPath) {
  const historyPath = path.join(path.dirname(outPath), "history-divergence.json");
  if (path.resolve(outPath) === path.resolve(historyPath)) throw new CanaryOutputOwnershipError();
  try {
    const stat = fs.lstatSync(historyPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CanaryOutputOwnershipError();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return historyPath;
}

async function qualifyDivergenceChain(cid, deps = {}) {
  const resolver = deps.resolveRpc || resolveRpc;
  const rpc = deps.rpcCall || rpcCall;
  let url = null;
  try { url = await resolver(cid, null, { capability: "read", timeoutMs: 12000 }); } catch (_) { /* unavailable */ }
  if (!url) return { chain: { qualified: false, reason: "endpoint-unavailable" }, ctx: null };
  const bn = await rpc(url, "eth_blockNumber", [], 15000);
  if (typeof bn !== "string" || !/^0x[0-9a-f]+$/i.test(bn))
    return { chain: { qualified: false, reason: "block-number-failed" }, ctx: null };
  let block;
  try { block = Number(BigInt(bn)); } catch (_) { block = null; }
  if (!Number.isSafeInteger(block) || block <= 0)
    return { chain: { qualified: false, reason: "block-number-failed" }, ctx: null };
  const blockHex = "0x" + block.toString(16);
  const header = await rpc(url, "eth_getBlockByNumber", [blockHex, false], 15000);
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000);
  let number = null, timestamp = null;
  try {
    if (typeof header?.number === "string" && /^0x[0-9a-f]+$/i.test(header.number)) number = Number(BigInt(header.number));
    if (typeof header?.timestamp === "string" && /^0x[0-9a-f]+$/i.test(header.timestamp)) timestamp = Number(BigInt(header.timestamp));
  } catch (_) { /* invalid header */ }
  if (number !== block || !isHex32(header?.hash) || !Number.isSafeInteger(timestamp) ||
      !Number.isSafeInteger(nowSec) || timestamp < nowSec - MAX_HEADER_AGE_SECONDS || timestamp > nowSec + 30)
    return { chain: { qualified: false, reason: "header-invalid-or-stale" }, ctx: null };
  return { chain: { qualified: true, block, hash: header.hash.toLowerCase(), timestamp },
    ctx: makeChainCtx(url, blockHex) };
}

async function evaluateChainSentinels(cid, specs, ctx, carry) {
  if (ctx) return poolMap(specs, 6, (spec) => evaluateSentinel(spec, ctx, carry));
  return specs.map((spec) => ({
     sentinel: spec.pinned ? spec.sentinel : `div:${cid}:${String(spec.oracle).slice(2, 10)}`, chainId: cid, oracle: spec.oracle,
    marketId: spec.marketId || null, pair: spec.pair || null, kind: spec.kind || "api-market",
    fired: false, ok: false, reason: "endpoint-unavailable", error: "endpoint-unavailable",
    referenceOk: false, referenceSource: null, oracleRatio: null, referenceRatio: null,
    divergenceBps: null, thresholdBps: NON_STABLE_BPS, sustained: false, scaleSuspect: false,
     feedless: !spec.pinned && isConfirmedConstant(spec), constantAcrossRuns: false,
    borrowsPositive: false, borrowRaw: null, availableRaw: null, actionable: false,
    consecutiveOver: 0, measurements: { pair: spec.pair || null, marketId: spec.marketId || null,
      marketBound: false, marketStateReadable: false },
     ...(spec.pinned ? { observationalOnly: true, noRouteProof: true } : {}),
   }));
}

async function runOnce(outPath, owner, stopRequested = () => false, deps = {}) {
  assertCanaryOutputOwner(owner, outPath);
  const historyPath = assertDivergenceHistoryPath(outPath);
  let ownershipLoss = null;
  const heartbeat = setInterval(() => {
    if (ownershipLoss) return;
    try { owner.check(); } catch (_) { ownershipLoss = new CanaryOutputOwnershipError(); }
  }, 15_000);
  heartbeat.unref();
  const scanCheck = () => {
    if (ownershipLoss) throw ownershipLoss;
    assertCanaryOutputOwner(owner, outPath);
    assertDivergenceHistoryPath(outPath);
    if (stopRequested()) throw new DivergenceScanStopped();
  };
  try {
  const nowIso = new Date(deps.now ? deps.now() : Date.now()).toISOString();
  const runId = nowIso.replace(/[:.]/g, "-");
  const pinned = deps.pinnedUniverse ? pinnedUniverse(deps.loadPinnedDivergenceUniverse ||
    (() => require("./lib/pinned-divergence-universe.js").loadPinnedDivergenceUniverse())) : null;
  scanCheck(); // pin source and identity list before any chain RPC

  // Chain pins.
  const chains = {};
  const ctxByChain = {};
  for (const cid of CHAIN_IDS) {
    let result;
    try {
      result = await (deps.qualifyChain || qualifyDivergenceChain)(cid);
    } catch (error) {
      if (!pinned || error instanceof DivergenceScanStopped || error instanceof CanaryOutputOwnershipError) throw error;
      // Transport failure is not a universe failure. Keep all fixed IDs and
      // publish an unavailable chain without persisting the raw endpoint error.
      result = { chain: { qualified: false, reason: "chain-qualification-failed" }, ctx: null };
    }
    scanCheck();
    const { chain, ctx } = result;
    chains[String(cid)] = chain;
    if (chain?.qualified && ctx) ctxByChain[cid] = ctx;
  }

  // Universe.
   const constantOracles = pinned ? [] : (deps.loadConstantOracles || loadConstantOracles)();
   const apiMarkets = [];
   if (!pinned) for (const cid of CHAIN_IDS) {
     if (!ctxByChain[cid]) continue;
     try { apiMarkets.push(...await (deps.fetchApiMarkets || fetchApiMarkets)(cid)); } catch (_) { /* bounded failure */ }
     scanCheck();
   }
   let universe = pinned ? pinned.rows : assembleUniverse(apiMarkets, constantOracles);

  // Bind unbound constant oracles via the API (keyless, no RPC).
   if (!pinned) for (const cid of CHAIN_IDS) {
    const unbound = universe.filter((r) => r.chainId === cid && (!r.coll || !r.loan));
    if (!unbound.length) continue;
    let bound;
    try { bound = await (deps.bindOracles || bindOracles)(cid, unbound.map((r) => r.oracle)); } catch (_) { bound = new Map(); }
    scanCheck();
    for (const r of unbound) {
      const info = bound.get(String(r.oracle).toLowerCase());
      if (!info) continue;
      r.marketId = r.marketId || info.marketId;
      r.coll = info.coll; r.loan = info.loan;
      r.morpho = r.morpho || info.morpho;
      if (r.borrowUsd == null && Number.isFinite(info.borrowUsd)) r.borrowUsd = info.borrowUsd;
      delete r.unbound;
    }
  }
  universe = universe.slice(0, MAX_SENTINELS);

  scanCheck();
  const history = readHistory(historyPath);
    const compatibleHistory = pinned ? { ...history,
      runs: history.runs.filter((r) => r?.pinnedUniverseSha256 === pinned.sha256 &&
        r?.sourceConstantSha256 === pinned.sourceConstantSha256 &&
        !Object.prototype.hasOwnProperty.call(r, "structuralZero")),
     lastFire: null } :
     { ...history, runs: history.runs.filter((r) => !r?.pinnedUniverseSha256),
       lastFire: null };
   const lastOriginal = history.runs[history.runs.length - 1];
    const previousCompatible = pinned ? lastOriginal?.pinnedUniverseSha256 === pinned.sha256 &&
      lastOriginal?.sourceConstantSha256 === pinned.sourceConstantSha256 :
      lastOriginal && !lastOriginal.pinnedUniverseSha256;
    const carry = { ...(previousCompatible ? (pinned ? pinnedHistoryCarry(compatibleHistory, pinned.sha256,
      pinned.sourceConstantSha256) : historyCarry(compatibleHistory)) : historyCarry({ runs: [] })),
     nowMs: deps.now ? deps.now() : Date.now(),
    chainBlocks: Object.fromEntries(CHAIN_IDS.map((cid) => [String(cid), chains[String(cid)]?.qualified ? chains[String(cid)].block : null])) };

  const byChain = new Map();
  for (const spec of universe) {
    if (!byChain.has(spec.chainId)) byChain.set(spec.chainId, []);
    byChain.get(spec.chainId).push(spec);
  }
  const sentinels = [];
  for (const [cid, specs] of byChain) {
    sentinels.push(...await (deps.evaluateChainSentinels || evaluateChainSentinels)(cid, specs, ctxByChain[cid], carry));
    scanCheck();
  }

  const fired = sentinels.filter((s) => s.fired);
  const lastFire = fired.length ? { runId, at: nowIso, fired: fired.map((s) => s.sentinel) } :
     (() => {
       const previous = [...compatibleHistory.runs].reverse().find((r) => r && r.verdict === "FIRED");
      return previous ? { runId: previous.runId, at: previous.at, fired: previous.fired } : null;
    })();
  const referenceResolved = sentinels.filter((s) => s.referenceOk).length;
  const constantCount = sentinels.filter((s) => s.feedless).length;
  const out = {
    schema: SCHEMA,
    runId, generatedAt: nowIso,
    noSigning: true, noBroadcast: true, noManipulation: true,
    ...(pinned ? { pinnedUniverseSha256: pinned.sha256, sourceConstantSha256: pinned.sourceConstantSha256,
      observationalOnly: true, noRouteProof: true } : {}),
    thresholds: { stableBps: STABLE_BPS, nonStableBps: NON_STABLE_BPS, sustainRuns: SUSTAIN_RUNS, minDexDepthUsd: MIN_DEX_DEPTH_USD },
    chains,
    coverage: {
      universe: sentinels.length,
      apiMarkets: sentinels.filter((s) => s.kind === "api-market").length,
      constantOracles: constantCount,
      referenceResolved,
      referenceResolvedPct: sentinels.length ? Number((referenceResolved / sentinels.length * 100).toFixed(2)) : 0,
    },
    sentinels,
    firedCount: fired.length,
    firedSentinels: fired.map((s) => s.sentinel),
    lastFire, // latched evidence; verdict still reflects this poll's observation
    sustainedCount: sentinels.filter((s) => s.sustained).length,
    verdict: fired.length ? "FIRED" : sentinels.some((s) => !s.ok) ||
      Object.values(chains).some((chain) => !chain.qualified) ? "INCOMPLETE" : "DORMANT",
  };
  scanCheck();
  fs.writeFileSync(outPath, JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");

  // Bounded history with price memory and per-sentinel over-threshold streak.
  const prices = {};
  const consecutiveOver = {};
  const priceStreak = {};
  const priceFirstSeen = {};
  for (const s of sentinels) {
     if (!s.ok || (pinned && (!s.referenceOk || !s.measurements?.marketBound || !s.measurements?.marketStateReadable))) continue;
    const key = `${s.chainId}:${String(s.oracle).toLowerCase()}`;
    const p = s.measurements && s.measurements.oraclePrice;
    if (p != null) prices[key] = p;
    if (s.consecutiveOver > 0) consecutiveOver[key] = s.consecutiveOver;
    const streak = Number(s.measurements && s.measurements.priceStreak);
    if (Number.isFinite(streak) && streak > 0) priceStreak[key] = streak;
    const firstSeen = Number(s.measurements && s.measurements.priceFirstSeenMs);
    if (Number.isFinite(firstSeen) && firstSeen > 0) priceFirstSeen[key] = firstSeen;
  }
  const pinBlocks = {};
  for (const cid of CHAIN_IDS) pinBlocks[String(cid)] = chains[String(cid)] && chains[String(cid)].block != null ? chains[String(cid)].block : null;
  const nextHistory = {
    schema: HISTORY_SCHEMA,
    generatedAt: nowIso,
    lastFire,
    runs: [
       ...compatibleHistory.runs.filter((r) => r && r.runId !== runId),
        { runId, at: nowIso, verdict: out.verdict, fired: out.firedSentinels, firedCount: out.firedCount, chains: pinBlocks, prices, consecutiveOver, priceStreak, priceFirstSeen,
          ...(pinned ? { pinnedUniverseSha256: pinned.sha256, sourceConstantSha256: pinned.sourceConstantSha256 } : {}) },
    ].slice(-HISTORY_MAX_RUNS),
  };
  scanCheck();
  fs.writeFileSync(historyPath, JSON.stringify(nextHistory, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  return out;
  } finally { clearInterval(heartbeat); }
}

async function main(args = process.argv.slice(2), deps = {}) {
  const values = new Map();
  const switches = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
     if (["--once", "--keep-watching-on-fire", "--no-deadline", "--supervised-readonly", "--pinned-universe"].includes(flag)) {
      if (switches.has(flag)) throw new Error("duplicate-flag");
      switches.add(flag);
    } else if (["--out", "--loop", "--max-hours"].includes(flag)) {
      if (values.has(flag) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("invalid-flag-value");
      values.set(flag, args[++i]);
    } else throw new Error("unknown-flag");
  }
  if (switches.has("--once") && values.has("--loop")) throw new Error("once-and-loop-conflict");
  if (switches.has("--supervised-readonly") && !values.has("--loop")) throw new Error("supervised-readonly-requires-loop");
  if (switches.has("--keep-watching-on-fire") && !values.has("--loop")) throw new Error("keep-watching-requires-loop");
  if (switches.has("--no-deadline") && (!values.has("--loop") || !switches.has("--keep-watching-on-fire") || values.has("--max-hours")))
    throw new Error("no-deadline-requires-unbounded-keep-watching-loop");
  if (values.has("--max-hours") && !values.has("--loop")) throw new Error("max-hours-requires-loop");
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : DEFAULT_OUT;
  const requestedInterval = values.has("--loop") ? Number(values.get("--loop")) : null;
  const requestedHours = values.has("--max-hours") ? Number(values.get("--max-hours")) : DEFAULT_MAX_LOOP_HOURS;
  if ((requestedInterval !== null && (!Number.isFinite(requestedInterval) || requestedInterval <= 0)) ||
      !Number.isFinite(requestedHours) || requestedHours <= 0) throw new Error("invalid-loop-duration");
  const interval = requestedInterval === null ? null : Math.max(60, requestedInterval);
  const keepWatching = switches.has("--keep-watching-on-fire");
  const now = deps.now || Date.now;
  const deadline = switches.has("--no-deadline") ? null : now() + Math.min(MAX_LOOP_HOURS, requestedHours) * 3600 * 1000;
  if (path.resolve(outPath) === path.join(path.dirname(outPath), "history-divergence.json"))
    throw new CanaryOutputOwnershipError();
  const owner = acquireCanaryOutputOwner(outPath); // exclusive before any RPC or history read
  deps = { ...deps, pinnedUniverse: switches.has("--pinned-universe") };
  let stopping = false;
  let wake = null;
  const stop = () => { stopping = true; if (wake) wake(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const disposeReadOnlyStop = installCanaryReadOnlyStop(stop, process, switches.has("--supervised-readonly"));
  try {
    let code = 0;
    for (;;) {
      owner.check();
      if (stopping || (interval !== null && deadline !== null && now() >= deadline)) return code;
      try {
        const last = await (deps.runOnce || runOnce)(outPath, owner, () => stopping, deps);
        console.log(JSON.stringify({
          runId: last.runId, verdict: last.verdict, firedCount: last.firedCount,
          fired: last.firedSentinels, coverage: last.coverage,
          chains: Object.fromEntries(Object.entries(last.chains).map(([k, v]) => [k, v.qualified ? v.block : v.reason])),
          sentinels: last.sentinels.map((s) => ({ sentinel: s.sentinel, pair: s.pair, fired: s.fired, ok: s.ok, divergenceBps: s.divergenceBps, referenceOk: s.referenceOk, reason: s.reason })),
        }));
        if (last.firedCount > 0) {
          if (!keepWatching) return 3;
          code = 3; // retain the FIRE exit signal if later polls are dormant
        } else if (code !== 3) code = last.verdict === "INCOMPLETE" ? 1 : 0;
      } catch (e) {
        if (e instanceof DivergenceScanStopped) return code;
        if (e instanceof CanaryOutputOwnershipError) throw e;
        console.error("RUN-ERROR " + sanitize(e.message || e));
        code = 1;
      }
      if (stopping || interval === null || (deadline !== null && now() > deadline)) return code;
      const end = now() + interval * 1000;
      while (!stopping && now() < end) {
        owner.check();
        if (deps.sleep) {
          await deps.sleep(Math.min(15_000, end - now()), stop);
          continue;
        }
        await new Promise((resolve) => {
          const timer = setTimeout(() => { wake = null; resolve(); }, Math.min(15_000, end - now()));
          wake = () => { clearTimeout(timer); wake = null; resolve(); };
          if (stopping) wake();
        });
      }
    }
  } finally {
    disposeReadOnlyStop();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (!owner.release()) throw new CanaryOutputOwnershipError();
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("FAIL startup-failed"); process.exitCode = 1;
  });
}

module.exports = {
  SCHEMA,
  HISTORY_SCHEMA,
  CHAIN_IDS,
  STABLE_BPS,
  NON_STABLE_BPS,
  SUSTAIN_RUNS,
  CHAINLINK_BY_TOKEN,
  DEX,
  isUsdStable,
  ratioFromPrice,
  assembleUniverse,
  loadConstantOracles,
  isConfirmedConstant,
  evaluateSentinel,
  continuousRun,
  historyCarry,
  pinnedUniverse,
  pinnedHistoryCarry,
  qualifyDivergenceChain,
  evaluateChainSentinels,
  runOnce,
  main,
};
