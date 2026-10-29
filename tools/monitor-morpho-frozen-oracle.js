#!/usr/bin/env node
"use strict";
// monitor-morpho-frozen-oracle.js
//
// Bounded, read-only status monitor for Morpho Blue markets whose Chainlink
// collateral feed is frozen (stale beyond a documented threshold) while the
// oracle still accepts the stale non-negative answer. It alerts when loan-side
// available liquidity becomes positive at a borrow-and-default-positive edge.
//
// Safety: read-only eth_call plus one keyless documented public reference API.
// No signing, no transactions, no forks, no oracle/pool manipulation, and no
// external state mutation. RPC endpoint values stay process-only: they are
// never printed, logged, hashed, persisted, or placed on a child argv.

const fs = require("fs");
const path = require("path");
const { envelope, predicate, allPredicates, check, ratioDecimal, runIdFor } = require("./monitor-evidence");
const {
  resolveRpc,
  rpcCallStrict,
  RpcTransportError,
  PUBLIC_FALLBACKS,
} = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const DEFAULT_OUT = path.join(
  WORKSPACE,
  "reports",
  "raw",
  "fast",
  "morpho-frozen-oracle-status.json",
);

const MORPHO_BLUE = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";

// Function selectors (no local keccak dependency; anchors match deployed ABI).
const SELECTORS = Object.freeze({
  market: "0x5c60e39a", // market(bytes32)
  price: "0xa035b1fe", // IOracle.price()
  latestRoundData: "0xfeaf968c", // AggregatorV3Interface.latestRoundData()
});

const PRICE_SCALE = 10n ** 36n;
const RATIO_DP = 18n;

// Documented freshness threshold. 24h covers the standard Chainlink crypto
// heartbeat; any tracked feed older than this is treated as frozen here.
const DEFAULT_STALENESS_SECONDS = 86400;

// A single smallest unit of loan asset (or less) is a rounding residue, not
// withdrawable/borrowable liquidity, so it cannot gate an actionable alert.
// The raw `availableLiquidity > 0` condition is still exposed separately.
const DEFAULT_MIN_ACTIONABLE_LIQUIDITY_ASSETS = 1;

const DEFAULT_LIMITS = Object.freeze({
  maxMarkets: 16,
  maxRpcRequestsPerRun: 160,
  maxReferenceRequestsPerRun: 8,
  concurrency: 2,
  rpcTimeoutMs: 8000,
  referenceTimeoutMs: 8000,
});

// Documented public keyless reference source. Only the short name is ever
// recorded; the host stays in-process and is never logged or persisted.
const REFERENCE_SOURCE = "defillama-coins";
const REFERENCE_HOST = "coins.llama.fi";
const CHAIN_NAMES = Object.freeze({ 1: "ethereum", 8453: "base" });
const CHAIN_SLUGS = Object.freeze({ 1: "ethereum", 8453: "base" });

// Default tracked set: the frozen-feed markets named by the sweep artifact
// reports/raw/fast/morpho-stale-sweep-20260915 (USR / wstUSR / RLP / PAXG and
// the other stale-feed markets it records), plus their Base counterparts.
const DEFAULT_MARKETS = Object.freeze([
  {
    chainId: 1,
    collateral: "USR",
    loan: "USDC",
    marketId: "0x8e7cc042d739a365c43d0a52d5f24160fa7ae9b7e7c9a479bd02a56041d4cf77",
    oracle: "0x8875ceb24e656fca062759bdcf870f59a2b0187b",
    collateralAddress: "0x66a1e37c9b0eaddca17d3662d6c05f4decf3e110",
    loanAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    collateralDecimals: 18,
    loanDecimals: 6,
    lltv: "915000000000000000",
    loanUsdStable: true,
    feeds: [{ address: "0xf9c7c25fe58aaa494ee7ff1f6cf0b70d7c7ce88c", decimals: 8 }],
  },
  {
    chainId: 1,
    collateral: "wstUSR",
    loan: "USDC",
    marketId: "0xd9e34b1eed46d123ac1b69b224de1881dbc88798bc7b70f504920f62f58f28cc",
    oracle: "0xda850a72080024e17c1590fbf6ea7a826db90760",
    collateralAddress: "0x1202f5c7b4b9e47a1a484e8b270be34dbbc75055",
    loanAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    collateralDecimals: 18,
    loanDecimals: 6,
    lltv: "915000000000000000",
    loanUsdStable: true,
    feeds: [{ address: "0xf9c7c25fe58aaa494ee7ff1f6cf0b70d7c7ce88c", decimals: 8 }],
  },
  {
    chainId: 1,
    collateral: "RLP",
    loan: "USDC",
    marketId: "0xe1b65304edd8ceaea9b629df4c3c926a37d1216e27900505c04f14b2ed279f33",
    oracle: "0x19018450a02bc5c1994ead517498311f64b2626a",
    collateralAddress: "0x4956b52ae2ff65d74ca2d61207523288e4528f96",
    loanAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    collateralDecimals: 18,
    loanDecimals: 6,
    lltv: "860000000000000000",
    loanUsdStable: true,
    feeds: [{ address: "0xadb2c15fde49d1a4294740acb650de94184e66b2", decimals: 8 }],
  },
  {
    chainId: 1,
    collateral: "RLP",
    loan: "AUSD",
    marketId: "0x4b86442549b52826e0fc11770ec5154450cb3c5c14dc751a761d81dcfbe7a7b2",
    oracle: "0x19018450a02bc5c1994ead517498311f64b2626a",
    collateralAddress: "0x4956b52ae2ff65d74ca2d61207523288e4528f96",
    loanAddress: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
    collateralDecimals: 18,
    loanDecimals: 6,
    lltv: "860000000000000000",
    loanUsdStable: true,
    feeds: [{ address: "0xadb2c15fde49d1a4294740acb650de94184e66b2", decimals: 8 }],
  },
  {
    chainId: 1,
    collateral: "PT-RLP-9APR2026",
    loan: "USDC",
    marketId: "0x1cfdc0154ae6b9f1887a8250f2582d55606e1a2008e65108fb83dd50a928593e",
    oracle: "0x89c3dd5e0c78136efe412e57cc05a7835ef9f501",
    collateralAddress: "0x29fd7180e5cced14ad148c7997e6b6857a8be86e",
    loanAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    collateralDecimals: 6,
    loanDecimals: 6,
    lltv: "860000000000000000",
    loanUsdStable: true,
    feeds: [{ address: "0x3688129491b6fa07949f2a77e486fe0b50577efa", decimals: 18 }],
  },
  {
    chainId: 1,
    collateral: "PAXG",
    loan: "USDC",
    marketId: "0x8eaf7b29f02ba8d8c1d7aeb587403dcb16e2e943e4e2f5f94b0963c2386406c9",
    oracle: "0xdd1778f71a4a1c6a0efebd8ae9f8848634ce1101",
    collateralAddress: "0x45804880de22913dafe09f4980848ece6ecbaf78",
    loanAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    collateralDecimals: 18,
    loanDecimals: 6,
    lltv: "915000000000000000",
    loanUsdStable: true,
    feeds: [{ address: "0x7c4561bb0f2d6947beda10f667191f6026e7ac0c", decimals: 8 }],
  },
  {
    chainId: 1,
    collateral: "CTOKEN1",
    loan: "USDC",
    marketId: "0x7f37bf3c7b9c08416f87f8a29a4c3142c0c08903316dd39ae473cc7b1dd4f9e3",
    oracle: "0x08a9d6b4f11beca41f78c8097bab2abd2fc5710c",
    collateralAddress: "0x387d46494f6dc5c6b26abc20ae40623ac041dd92",
    loanAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    collateralDecimals: 18,
    loanDecimals: 6,
    lltv: "860000000000000000",
    loanUsdStable: true,
    feeds: [{ address: "0xaf8cab0acf598f86863b0f1a64c0716a5f50638f", decimals: 18 }],
  },
  {
    chainId: 1,
    collateral: "CTOKEN2",
    loan: "USDC",
    marketId: "0xdbcb3abc60f6e1a2c6a4acfc7225950c80c1bc192ae366e3dd55c86581fbf039",
    oracle: "0xc308970a7b72818e1b3fdbab61dc345e1f3247e0",
    collateralAddress: "0xe89fed9a81cb8b19338f70367181a1a4db5d06ae",
    loanAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    collateralDecimals: 18,
    loanDecimals: 6,
    lltv: "860000000000000000",
    loanUsdStable: true,
    feeds: [{ address: "0x4107f79c779f334f8eed1b59eead0c77d2097cd2", decimals: 18 }],
  },
  {
    chainId: 1,
    collateral: "CTOKEN3",
    loan: "USDC",
    marketId: "0x5c706a82e9ec6e40dd5e81b00b09099cef09bd501a56085ad9c17f7965fc5897",
    oracle: "0x2d2d50726d8f791fdf029994f662a6ec374d0119",
    collateralAddress: "0xd00e55a0e5a3fabb220c6175d8947313fc7f2f33",
    loanAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    collateralDecimals: 18,
    loanDecimals: 6,
    lltv: "860000000000000000",
    loanUsdStable: true,
    feeds: [{ address: "0x0d50bc0991ed0109ba7359ea9057e28a90f35cb0", decimals: 18 }],
  },
  {
    chainId: 8453,
    collateral: "USR",
    loan: "USDC",
    marketId: "0xff0f2bd52ca786a4f8149f96622885e880222d8bed12bbbf5950296be8d03f89",
    oracle: "0xa40e4a5c4ff8ec8ae05648a4f34e02ced8ae9efb",
    collateralAddress: "0x35e5db674d8e93a03d814fa0ada70731efe8a4b9",
    loanAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    collateralDecimals: 18,
    loanDecimals: 6,
    lltv: "915000000000000000",
    loanUsdStable: true,
    feeds: [{ address: "0xcd76c50c3210c5aaa9c39d53a4f95bfd8b1a3a19", decimals: 8 }],
  },
  {
    chainId: 8453,
    collateral: "mGLO",
    loan: "USDC",
    marketId: "0x29ae7ac08be3a58e11151fed74701fb8e6ffd8e76b1870cf17ad70f332752d0b",
    oracle: "0x182e072f2c9c58c6f19f144c97986f7496c6a109",
    collateralAddress: "0xfcc9cc1209651ed8867332d6f664cf82743a2584",
    loanAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    collateralDecimals: 18,
    loanDecimals: 6,
    lltv: "915000000000000000",
    loanUsdStable: true,
    feeds: [{ address: "0x3732f1e48499922426f9ddad37d79c98b1fbf29e", decimals: 8 }],
  },
  {
    chainId: 8453,
    collateral: "RLP",
    loan: "USDC",
    marketId: "0x1478d70d1fde3fd5b8eb5766e82b03aa56a1df72a54fc8cd33aad666b0bd5008",
    oracle: "0x3b55c5fcd8f9a5c108ae1c50a29732d101f26730",
    collateralAddress: "0xc31389794ffac23331e0d9f611b7953f90aa5fdc",
    loanAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    collateralDecimals: 18,
    loanDecimals: 6,
    lltv: "860000000000000000",
    loanUsdStable: true,
    feeds: [{ address: "0x9924a529d15067518bf5182202bfad71e4b64a74", decimals: 8 }],
  },
  {
    chainId: 8453,
    collateral: "PT-apxUSD-18JUN2026",
    loan: "USDC",
    marketId: "0x5c01254d8549521b43f922e175a270f0ef2e00d5c5f3f343bcd5f8451dcf93fe",
    oracle: "0x15d6cf4ae76e3f9bb7efcd540092588969df9d1f",
    collateralAddress: "0x25cb814c094b3ee4b19bfcab4c190c53d7890635",
    loanAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    collateralDecimals: 18,
    loanDecimals: 6,
    lltv: "915000000000000000",
    loanUsdStable: true,
    feeds: [
      { address: "0x3525789b8f0d87cb3dc9072f4405bb514262a112", decimals: 18 },
      { address: "0x6b3788fd6604bbf03c5378d24e57bb334baad4af", decimals: 8 },
    ],
  },
  {
    chainId: 8453,
    collateral: "PT-USR-25SEP2025",
    loan: "USDC",
    marketId: "0x669b68ae003954dde5b2be025fa373bfc6b6134fc3180ea746c31e892243ae81",
    oracle: "0x6aded60f115bd6244ff4be46f84149ba758d9085",
    collateralAddress: "0xa6f0a4d18b6f6ddd408936e81b7b3a8befa18e77",
    loanAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    collateralDecimals: 18,
    loanDecimals: 6,
    lltv: "915000000000000000",
    loanUsdStable: true,
    feeds: [
      { address: "0x553b07e07ebb880e4f55ac36b2d9db0ab987a64d", decimals: 18 },
      { address: "0xcd76c50c3210c5aaa9c39d53a4f95bfd8b1a3a19", decimals: 8 },
    ],
  },
]);

/* ------------------------------------------------------------------ *
 * Bounded integer helpers
 * ------------------------------------------------------------------ */

function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function normalizeLimits(input = {}) {
  return {
    maxMarkets: boundedInteger(input.maxMarkets, DEFAULT_LIMITS.maxMarkets, 16),
    maxRpcRequestsPerRun: boundedInteger(
      input.maxRpcRequestsPerRun,
      DEFAULT_LIMITS.maxRpcRequestsPerRun,
      4096,
    ),
    maxReferenceRequestsPerRun: boundedInteger(
      input.maxReferenceRequestsPerRun,
      DEFAULT_LIMITS.maxReferenceRequestsPerRun,
      64,
    ),
    concurrency: boundedInteger(input.concurrency, DEFAULT_LIMITS.concurrency, 8),
    rpcTimeoutMs: boundedInteger(input.rpcTimeoutMs, DEFAULT_LIMITS.rpcTimeoutMs, 30000),
    referenceTimeoutMs: boundedInteger(
      input.referenceTimeoutMs,
      DEFAULT_LIMITS.referenceTimeoutMs,
      30000,
    ),
  };
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const MARKET_ID_RE = /^0x[0-9a-f]{64}$/;

function normalizeMarkets(markets, limits) {
  if (!Array.isArray(markets)) return [];
  const seen = new Set();
  const out = [];
  for (const market of markets) {
    if (!market || typeof market !== "object") continue;
    if (!Number.isSafeInteger(market.chainId) || market.chainId <= 0 || !ADDRESS_RE.test(market.oracle || "")) continue;
    if (!MARKET_ID_RE.test(market.marketId || "")) continue;
    if (!ADDRESS_RE.test(market.collateralAddress || "")) continue;
    if (!ADDRESS_RE.test(market.loanAddress || "")) continue;
    if (!Number.isSafeInteger(market.collateralDecimals) || market.collateralDecimals < 0 || market.collateralDecimals > 36) continue;
    if (!Number.isSafeInteger(market.loanDecimals) || market.loanDecimals < 0 || market.loanDecimals > 36) continue;
    if (!/^\d+$/.test(String(market.lltv || ""))) continue;
    const feeds = Array.isArray(market.feeds)
      ? market.feeds.filter((f) => f && ADDRESS_RE.test(f.address || ""))
      : [];
    if (feeds.length === 0) continue;
    const key = `${market.chainId}:${market.marketId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      chainId: market.chainId,
      chain: CHAIN_NAMES[market.chainId] || `chain-${market.chainId}`,
      collateral: String(market.collateral || "unknown").slice(0, 64),
      loan: String(market.loan || "unknown").slice(0, 64),
      marketId: market.marketId,
      oracle: market.oracle,
      collateralAddress: market.collateralAddress,
      loanAddress: market.loanAddress,
      collateralDecimals: market.collateralDecimals,
      loanDecimals: market.loanDecimals,
      lltv: String(market.lltv),
      loanUsdStable: market.loanUsdStable === true,
      feeds: feeds.map((f) => ({
        address: f.address,
        decimals: Number.isSafeInteger(f.decimals) && f.decimals >= 0 ? f.decimals : 8,
      })),
    });
  }
  // Deterministic ordering independent of input order.
  out.sort(
    (a, b) => a.chainId - b.chainId || (a.marketId < b.marketId ? -1 : a.marketId > b.marketId ? 1 : 0),
  );
  return out.slice(0, limits.maxMarkets);
}

/* ------------------------------------------------------------------ *
 * ABI word decoding
 * ------------------------------------------------------------------ */

function decodeWords(result) {
  if (typeof result !== "string" || !/^0x[0-9a-f]*$/i.test(result)) throw new Error("invalid-result");
  const body = result.slice(2);
  if (body.length === 0 || body.length % 64 !== 0) throw new Error("invalid-result");
  const words = [];
  for (let i = 0; i < body.length; i += 64) words.push(BigInt("0x" + body.slice(i, i + 64)));
  return words;
}

function decodeMarket(result) {
  const words = decodeWords(result);
  if (words.length < 4) throw new Error("invalid-market");
  return {
    totalSupplyAssets: words[0],
    totalBorrowAssets: words[2],
  };
}

function decodeUint(result) {
  const words = decodeWords(result);
  if (words.length < 1) throw new Error("invalid-uint");
  return words[0];
}

function decodeRoundData(result) {
  const words = decodeWords(result);
  if (words.length < 5) throw new Error("invalid-round");
  return {
    roundId: words[0],
    answer: BigInt.asIntN(256, words[1]),
    startedAt: words[2],
    updatedAt: words[3],
    answeredInRound: words[4],
  };
}

/* ------------------------------------------------------------------ *
 * Process-only transport
 * ------------------------------------------------------------------ */

// The resolved RPC URLs live only inside this closure. Nothing is returned,
// logged, or persisted except fixed error codes and hex results. Each call
// tries the resolver-preferred endpoint once and then the shared keyless
// public fallback once, so a flaky resolved endpoint cannot blank the monitor
// while the request cap still bounds the total number of attempts.
function createRpcTransport(options = {}) {
  const limits = normalizeLimits(options.limits);
  const resolve = typeof options.resolve === "function" ? options.resolve : resolveRpc;
  const call = typeof options.call === "function" ? options.call : rpcCallStrict;
  const candidates = new Map();
  let requests = 0;

  async function endpointsFor(chainId) {
    if (candidates.has(chainId)) return candidates.get(chainId);
    const list = [];
    let resolved = null;
    try {
      resolved = await resolve(chainId, null, {
        capability: "read",
        timeoutMs: limits.rpcTimeoutMs,
        concurrency: 4,
        maxCandidates: 32,
      });
    } catch (_) {
      resolved = null;
    }
    if (typeof resolved === "string" && resolved.length > 0) list.push(resolved);
    const fallback = PUBLIC_FALLBACKS[chainId];
    if (typeof fallback === "string" && fallback.length > 0 && !list.includes(fallback)) {
      list.push(fallback);
    }
    candidates.set(chainId, list);
    return list;
  }

  return {
    get requests() {
      return requests;
    },
    async callEth(chainId, to, data) {
      const list = await endpointsFor(chainId);
      if (list.length === 0) return { ok: false, error: "chain-unresolved" };
      let lastError = "revert";
      for (const url of list) {
        if (requests >= limits.maxRpcRequestsPerRun) return { ok: false, error: "request-cap" };
        requests += 1;
        try {
          const result = await call(url, "eth_call", [{ to, data }, "latest"], limits.rpcTimeoutMs);
          if (typeof result === "string" && /^0x[0-9a-f]*$/i.test(result)) {
            return { ok: true, result };
          }
          lastError = "revert";
        } catch (error) {
          lastError = "transport";
        }
      }
      return { ok: false, error: lastError };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Reference price (documented public keyless source)
 * ------------------------------------------------------------------ */

function refKey(chainId, address) {
  return `${chainId}:${String(address).toLowerCase()}`;
}

function createDefillamaReference(options = {}) {
  const limits = normalizeLimits(options.limits);
  const fetchImpl = typeof options.fetch === "function" ? options.fetch : globalThis.fetch;
  const cache = new Map();
  let requests = 0;

  return {
    get requests() {
      return requests;
    },
    async resolveMany(items) {
      const results = new Map();
      if (!Array.isArray(items) || typeof fetchImpl !== "function") return results;
      const grouped = new Map(); // chainId -> Set(address)
      for (const item of items) {
        if (!item || !CHAIN_SLUGS[item.chainId]) continue;
        if (typeof item.address !== "string" || !ADDRESS_RE.test(item.address.toLowerCase())) continue;
        if (!grouped.has(item.chainId)) grouped.set(item.chainId, new Set());
        grouped.get(item.chainId).add(item.address.toLowerCase());
      }
      for (const [chainId, addresses] of grouped) {
        const entries = [...addresses].map((address) => ({
          key: refKey(chainId, address),
          apiId: `${CHAIN_SLUGS[chainId]}:${address}`,
        }));
        const missing = entries.filter((entry) => !cache.has(entry.key));
        if (missing.length > 0) {
          if (requests >= limits.maxReferenceRequestsPerRun) {
            for (const entry of missing) cache.set(entry.key, { ok: false, error: "reference-cap" });
          } else {
            requests += 1;
            try {
              const apiIds = missing.map((entry) => entry.apiId);
              const requestUrl = `https://${REFERENCE_HOST}/prices/current/${apiIds.join(",")}`;
              const response = await fetchImpl(requestUrl, {
                method: "GET",
                signal: AbortSignal.timeout(limits.referenceTimeoutMs),
              });
              const body = await response.json();
              const coins = body && typeof body === "object" ? body.coins || {} : {};
              for (const entry of missing) {
                const row = coins[entry.apiId];
                const price = row ? Number(row.price) : NaN;
                if (Number.isFinite(price) && price > 0) {
                  cache.set(entry.key, {
                    ok: true,
                    price,
                    source: REFERENCE_SOURCE,
                    asOf: Number.isFinite(Number(row.timestamp)) ? Number(row.timestamp) : null,
                  });
                } else {
                  cache.set(entry.key, { ok: false, error: "reference-unavailable" });
                }
              }
            } catch (_) {
              for (const entry of missing) {
                cache.set(entry.key, { ok: false, error: "reference-unavailable" });
              }
            }
          }
        }
        for (const entry of entries) {
          if (cache.has(entry.key)) results.set(entry.key, cache.get(entry.key));
        }
      }
      return results;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Observation
 * ------------------------------------------------------------------ */

async function observeMarket(transport, market) {
  const errors = [];
  const observation = { market: null, price: null, feeds: [] };

  const marketResult = await transport.callEth(
    market.chainId,
    MORPHO_BLUE,
    SELECTORS.market + market.marketId.slice(2),
  );
  if (marketResult.ok) {
    try {
      observation.market = decodeMarket(marketResult.result);
    } catch (_) {
      errors.push("market-decode");
    }
  } else {
    errors.push(`market-${marketResult.error}`);
  }

  const priceResult = await transport.callEth(market.chainId, market.oracle, SELECTORS.price);
  if (priceResult.ok) {
    try {
      observation.price = { ok: true, raw: decodeUint(priceResult.result) };
    } catch (_) {
      observation.price = { ok: false, error: "invalid" };
      errors.push("price-invalid");
    }
  } else {
    observation.price = { ok: false, error: priceResult.error };
    errors.push(`price-${priceResult.error}`);
  }

  for (const feed of market.feeds) {
    const roundResult = await transport.callEth(
      market.chainId,
      feed.address,
      SELECTORS.latestRoundData,
    );
    if (roundResult.ok) {
      try {
        observation.feeds.push({
          address: feed.address,
          decimals: feed.decimals,
          ok: true,
          round: decodeRoundData(roundResult.result),
        });
      } catch (_) {
        observation.feeds.push({ address: feed.address, decimals: feed.decimals, ok: false, error: "invalid" });
        errors.push("feed-invalid");
      }
    } else {
      observation.feeds.push({
        address: feed.address,
        decimals: feed.decimals,
        ok: false,
        error: roundResult.error,
      });
      errors.push(`feed-${roundResult.error}`);
    }
  }

  return { observation, errors };
}

/* ------------------------------------------------------------------ *
 * Trigger evaluation (pure)
 * ------------------------------------------------------------------ */

function fixedRatio(numerator, denominator, decimals = RATIO_DP) {
  if (denominator <= 0n) return null;
  const scale = 10n ** decimals;
  const scaled = (numerator * scale) / denominator;
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(Number(decimals), "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
}

// availableLiquidity > 0 AND frozen feed AND reference/oracleRatio < LLTV AND
// a reference price is available. Reported edge = LLTV - reference/oracle.
function evaluateMarket(market, observation, context) {
  const { nowSeconds, stalenessSeconds, reference } = context;
  const minActionable = BigInt(
    Number.isSafeInteger(context.minimumActionableLiquidityAssets) &&
      context.minimumActionableLiquidityAssets >= 0
      ? context.minimumActionableLiquidityAssets
      : DEFAULT_MIN_ACTIONABLE_LIQUIDITY_ASSETS,
  );
  const errors = [];
  const lltv = BigInt(market.lltv);

  let totalSupplyAssets = null;
  let totalBorrowAssets = null;
  let availableLiquidity = null;
  if (observation.market) {
    totalSupplyAssets = observation.market.totalSupplyAssets;
    totalBorrowAssets = observation.market.totalBorrowAssets;
    availableLiquidity = totalSupplyAssets - totalBorrowAssets;
  }

  const feeds = observation.feeds.map((feed) => {
    if (!feed.ok) {
      return { address: feed.address, decimals: feed.decimals, available: false, error: feed.error };
    }
    const updatedAt = feed.round.updatedAt;
    const ageSeconds =
      updatedAt > BigInt(nowSeconds) ? -1 : Number(BigInt(nowSeconds) - updatedAt);
    const stale = ageSeconds >= 0 && ageSeconds > stalenessSeconds;
    return {
      address: feed.address,
      decimals: feed.decimals,
      available: true,
      roundId: feed.round.roundId.toString(),
      answer: feed.round.answer.toString(),
      startedAt: feed.round.startedAt.toString(),
      updatedAt: updatedAt.toString(),
      answeredInRound: feed.round.answeredInRound.toString(),
      ageSeconds,
      stale,
    };
  });

  const feedFrozen = feeds.some((f) => f.available && f.stale);
  const feedsAvailable = feeds.some((f) => f.available);

  const priceReverted =
    observation.price !== null && observation.price.ok === false && observation.price.error === "revert";
  const priceAvailable = observation.price !== null && observation.price.ok === true;
  const liveBorrow = totalBorrowAssets !== null ? totalBorrowAssets > 0n : null;
  const oracleRevertWithLiveBorrow = priceReverted && liveBorrow === true;

  let oracleImpliedRatio = null;
  let edgePositive = null;
  let edge = null;
  let edgeRatio = null;
  const referenceAvailable = !!(reference && reference.ok && Number.isFinite(reference.ratio) && reference.ratio > 0);

  if (priceAvailable) {
    const oracleRatioNum = observation.price.raw * 10n ** BigInt(market.collateralDecimals);
    const oracleRatioDen = PRICE_SCALE * 10n ** BigInt(market.loanDecimals);
    oracleImpliedRatio = fixedRatio(oracleRatioNum, oracleRatioDen);
    if (referenceAvailable) {
      const referenceScaled = BigInt(Math.round(reference.ratio * 1e18));
      const lhs = lltv * oracleRatioNum;
      const rhs = referenceScaled * oracleRatioDen;
      edgePositive = lhs > rhs;
      edge = Number(lhs - rhs) / Number(1e18) / Number(oracleRatioNum);
      edgeRatio = ratioDecimal(lhs - rhs, 10n ** 18n * oracleRatioNum);
    }
  }

  const conditions = {
    priceReverted,
    oracleRevertWithLiveBorrow,
    liquidityPositive: availableLiquidity !== null ? availableLiquidity > 0n : null,
    actionableLiquidityPositive:
      availableLiquidity !== null ? availableLiquidity > minActionable : null,
    feedFrozen,
    feedsAvailable,
    referenceAvailable,
    edgePositive,
    indeterminate: false,
  };

  let status;
  if (oracleRevertWithLiveBorrow) {
    status = "ORACLE_REVERT";
  } else if (availableLiquidity === null) {
    status = "WATCH";
    conditions.indeterminate = true;
    errors.push("state-unavailable");
  } else if (!feedsAvailable) {
    status = "WATCH";
    conditions.indeterminate = true;
    errors.push("feed-unavailable");
  } else if (!feedFrozen) {
    status = "CLEAR";
  } else if (!conditions.actionableLiquidityPositive) {
    // Zero or dust liquidity is the current blocker.
    status = "WATCH";
  } else if (!referenceAvailable) {
    status = "REFERENCE_UNAVAILABLE";
  } else if (edgePositive === true && priceAvailable) {
    status = "TRIGGERED";
  } else {
    status = "WATCH";
  }

  return {
    chainId: market.chainId,
    chain: market.chain,
    market: `${market.collateral}/${market.loan}`,
    marketId: market.marketId,
    oracle: market.oracle,
    lltv: market.lltv,
    collateral: market.collateral,
    loan: market.loan,
    collateralDecimals: market.collateralDecimals,
    loanDecimals: market.loanDecimals,
    marketState:
      availableLiquidity === null
        ? null
        : {
            totalSupplyAssets: totalSupplyAssets.toString(),
            totalBorrowAssets: totalBorrowAssets.toString(),
            availableLiquidity: availableLiquidity.toString(),
            liveBorrow,
          },
    feeds,
    oraclePrice: {
      available: priceAvailable,
      raw: priceAvailable ? observation.price.raw.toString() : null,
      priceReverted,
      error: priceAvailable ? null : observation.price ? observation.price.error : "unavailable",
    },
    reference: referenceAvailable
      ? {
          available: true,
          source: reference.source,
          collateralUsd: reference.collateralUsd,
          loanUsd: reference.loanUsd,
          ratio: reference.ratio,
          asOf: reference.asOf ?? null,
        }
      : {
          available: false,
          source: REFERENCE_SOURCE,
          error: reference && reference.error ? reference.error : "reference-unavailable",
        },
    trigger: {
      predicate:
        "availableLiquidity > minimumActionableLiquidityAssets AND feedFrozen(age > stalenessThreshold) AND reference/oracle < LLTV AND referenceAvailable",
      stalenessThresholdSeconds: stalenessSeconds,
      minimumActionableLiquidityAssets: Number(minActionable),
      liquidityPositive: conditions.liquidityPositive,
      actionableLiquidityPositive: conditions.actionableLiquidityPositive,
      feedFrozen,
      referenceAvailable,
      oracleImpliedRatio,
      edgePositive,
      edge,
      edgeRatio,
    },
    conditions,
    status,
    errors,
  };
}

function frozenMarketEvidence(record, nowSeconds) {
  const gaps = ["UNPINNED_READS", "ADAPTER_VALIDITY_UNVERIFIED", "REFERENCE_POLICY_UNSET", "ECONOMICS_NOT_EVALUATED"];
  const readableFeeds = record.feeds.filter((f) => f.available);
  const timedFeeds = readableFeeds.filter((f) => Number.isSafeInteger(f.ageSeconds) && f.ageSeconds >= 0 && BigInt(f.updatedAt) > 0n);
  const feed = [...timedFeeds].sort((a, b) => b.ageSeconds - a.ageSeconds)[0] || record.feeds[0];
  if (!record.marketState) gaps.push("MARKET_UNREADABLE");
  if (readableFeeds.length !== record.feeds.length || !readableFeeds.length) gaps.push("FEED_READ_FAILED");
  if (timedFeeds.length !== readableFeeds.length) gaps.push("LATEST_TIME_INVALID");
  const available = record.reference.available;
  const asOf = available && Number.isSafeInteger(record.reference.asOf) && record.reference.asOf > 0
    && record.reference.asOf <= nowSeconds ? record.reference.asOf : null;
  if (!available) gaps.push("REFERENCE_UNAVAILABLE");
  else if (asOf === null) gaps.push("REFERENCE_TIME_UNKNOWN");
  const ageSeconds = asOf === null ? null : nowSeconds - asOf;
  const age = feed && timedFeeds.includes(feed) ? feed.ageSeconds : null;
  // This describes the legacy warning/dust/edge predicate, NOT adapter validity
  // or economic eligibility. Adapter round zero is deliberately not rejected.
  const frozen = record.conditions.feedFrozen ? "TRUE"
    : readableFeeds.length && timedFeeds.length === record.feeds.length ? "FALSE" : "UNKNOWN";
  const dust = predicate(record.conditions.actionableLiquidityPositive);
  const edge = predicate(record.conditions.edgePositive);
  const rawLiquidity = record.marketState?.availableLiquidity ?? null;
  return { chainId: record.chainId, marketId: record.marketId, venue: MORPHO_BLUE, oracle: record.oracle,
    feed: feed?.address ?? null, pair: /^[A-Za-z0-9 ()._/-]{1,48}$/.test(record.market) ? record.market : "unknown",
    scope: "MARKET", predicate: allPredicates([frozen, dust, edge]), quality: record.marketState ? "PARTIAL" : "UNAVAILABLE", gaps,
    pin: { blockNumber: null, blockHash: null, blockTimestamp: null, binding: "UNPINNED", witness: "UNKNOWN" },
    checks: [
      check("LATEST_ROUND_VALID", "UNKNOWN"),
      check("FROZEN_FEED", frozen, record.conditions.feedFrozen ? "1" : readableFeeds.length ? "0" : null, "=", "1", "BOOLEAN"),
      check("FEED_AGE", age === null ? "UNKNOWN" : predicate(age > record.trigger.stalenessThresholdSeconds), age === null ? null : String(age), ">", String(record.trigger.stalenessThresholdSeconds), "SECONDS"),
      check("DUST_LIQUIDITY", dust, rawLiquidity, ">", String(record.trigger.minimumActionableLiquidityAssets), "RAW"),
      check("GROSS_EDGE", edge, record.trigger.edgeRatio, ">", "0", "RATIO"),
      check("REFERENCE_AGE", "UNKNOWN", ageSeconds === null ? null : String(ageSeconds), null, null, "SECONDS"),
      check("ORACLE_PRICE", record.oraclePrice.available ? predicate(BigInt(record.oraclePrice.raw) > 0n) : "UNKNOWN", record.oraclePrice.raw, ">", "0", "RAW"),
      check("LIVE_BORROW", predicate(record.marketState?.liveBorrow), record.marketState?.totalBorrowAssets ?? null, ">", "0", "RAW"),
    ],
    amounts: [
      { kind: "AVAILABLE_LIQUIDITY", raw: rawLiquidity !== null && BigInt(rawLiquidity) >= 0n ? rawLiquidity : null,
        decimals: record.loanDecimals, symbol: /^[A-Za-z0-9]{1,16}$/.test(record.loan) ? record.loan : null },
      { kind: "DEBT", raw: record.marketState?.totalBorrowAssets ?? null, decimals: record.loanDecimals,
        symbol: /^[A-Za-z0-9]{1,16}$/.test(record.loan) ? record.loan : null },
    ],
    reference: { asOf, ageSeconds, maxAgeSeconds: null, freshness: "UNKNOWN" } };
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

function resolveReferenceForMarket(market, refMap) {
  const collateral = refMap.get(refKey(market.chainId, market.collateralAddress));
  if (!collateral || !collateral.ok || !(Number(collateral.price) > 0)) {
    return { ok: false, error: "reference-unavailable" };
  }
  let loanUsd = 1;
  let asOf = collateral.asOf ?? null;
  if (!market.loanUsdStable) {
    const loan = refMap.get(refKey(market.chainId, market.loanAddress));
    if (!loan || !loan.ok || !(Number(loan.price) > 0)) {
      return { ok: false, error: "loan-reference-unavailable" };
    }
    loanUsd = Number(loan.price);
    asOf = Number.isSafeInteger(asOf) && Number.isSafeInteger(loan.asOf) ? Math.min(asOf, loan.asOf) : null;
  }
  const ratio = Number(collateral.price) / loanUsd;
  if (!Number.isFinite(ratio) || ratio <= 0) return { ok: false, error: "reference-unavailable" };
  return {
    ok: true,
    source: collateral.source || REFERENCE_SOURCE,
    collateralUsd: Number(collateral.price),
    loanUsd,
    ratio,
    asOf,
  };
}

async function runMonitor(options = {}) {
  const limits = normalizeLimits(options.limits);
  const markets = normalizeMarkets(options.markets || DEFAULT_MARKETS, limits);
  const transport = options.transport || createRpcTransport({ limits });
  const referenceProvider = options.referenceProvider || createDefillamaReference({ limits });
  const nowSeconds =
    Number.isSafeInteger(options.nowSeconds) && options.nowSeconds > 0
      ? options.nowSeconds
      : Math.floor(Date.now() / 1000);
  const stalenessSeconds = boundedInteger(
    options.stalenessSeconds,
    DEFAULT_STALENESS_SECONDS,
    365 * 24 * 3600,
  );
  const minimumActionableLiquidityAssets =
    Number.isSafeInteger(options.minimumActionableLiquidityAssets) &&
    options.minimumActionableLiquidityAssets >= 0
      ? options.minimumActionableLiquidityAssets
      : DEFAULT_MIN_ACTIONABLE_LIQUIDITY_ASSETS;

  // Reference lookups are grouped per chain by the provider.
  let refMap = new Map();
  if (referenceProvider && typeof referenceProvider.resolveMany === "function") {
    const items = [];
    for (const market of markets) {
      items.push({ chainId: market.chainId, address: market.collateralAddress });
      if (!market.loanUsdStable) items.push({ chainId: market.chainId, address: market.loanAddress });
    }
    try {
      refMap = await referenceProvider.resolveMany(items);
      if (!(refMap instanceof Map)) refMap = new Map();
    } catch (_) {
      refMap = new Map();
    }
  }

  const results = [];
  for (let start = 0; start < markets.length; start += limits.concurrency) {
    const batch = markets.slice(start, start + limits.concurrency);
    const observed = await Promise.all(
      batch.map((market) =>
        observeMarket(transport, market).catch(() => ({
          observation: { market: null, price: null, feeds: [] },
          errors: ["observe-failed"],
        })),
      ),
    );
    for (let i = 0; i < batch.length; i += 1) {
      const market = batch[i];
      const reference = resolveReferenceForMarket(market, refMap);
      const record = evaluateMarket(market, observed[i].observation, {
        nowSeconds,
        stalenessSeconds,
        minimumActionableLiquidityAssets,
        reference,
      });
      for (const code of observed[i].errors) {
        if (!record.errors.includes(code)) record.errors.push(code);
      }
      results.push(record);
    }
  }

  const summary = { TRIGGERED: 0, WATCH: 0, CLEAR: 0, REFERENCE_UNAVAILABLE: 0, ORACLE_REVERT: 0 };
  for (const record of results) {
    if (Object.prototype.hasOwnProperty.call(summary, record.status)) summary[record.status] += 1;
  }

  const capturedAt = new Date(nowSeconds * 1000).toISOString();
  const artifact = {
    schema: "morpho-frozen-oracle-status/read-only/v1",
    capturedAt,
    runId: runIdFor(capturedAt),
    monitorEvidence: envelope("morpho-frozen-oracle", capturedAt, results.map((record) => frozenMarketEvidence(record, nowSeconds))),
    mode: "once",
    source: "local source tests, public read-only state, and one keyless public reference API",
    safety: {
      readOnly: true,
      externalStateMutations: false,
      oracleOrPoolManipulation: false,
      signing: false,
      transactions: false,
      forks: false,
      endpointValuesStored: false,
      endpointMaterialInChildArgv: false,
    },
    stalenessThresholdSeconds: stalenessSeconds,
    minimumActionableLiquidityAssets,
    limits: {
      maxMarkets: limits.maxMarkets,
      maxRpcRequestsPerRun: limits.maxRpcRequestsPerRun,
      maxReferenceRequestsPerRun: limits.maxReferenceRequestsPerRun,
      concurrency: limits.concurrency,
      rpcTimeoutMs: limits.rpcTimeoutMs,
      referenceTimeoutMs: limits.referenceTimeoutMs,
    },
    requestCounts: {
      rpcCalls: typeof transport.requests === "number" ? transport.requests : null,
      referenceCalls:
        referenceProvider && typeof referenceProvider.requests === "number"
          ? referenceProvider.requests
          : null,
      trackedMarkets: markets.length,
    },
    summary,
    markets: results,
  };

  return artifact;
}

/* ------------------------------------------------------------------ *
 * Artifact sanitization
 * ------------------------------------------------------------------ */

const URL_RE = /https?:\/\//i;
const FORBIDDEN_KEY_RE = /^(url|uri|host|hostname|endpoint|rpc|rpcUrl|headers?|authorization|credential|credentials|secret|apikey|apiKey|api_key|token)$/i;

function findEndpointMaterial(node, trail = []) {
  const found = [];
  if (typeof node === "string") {
    if (URL_RE.test(node)) found.push(trail.join(".") || "$");
    return found;
  }
  if (Array.isArray(node)) {
    node.forEach((value, index) => found.push(...findEndpointMaterial(value, trail.concat(String(index)))));
    return found;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (FORBIDDEN_KEY_RE.test(key)) found.push(trail.concat(key).join("."));
      found.push(...findEndpointMaterial(value, trail.concat(key)));
    }
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { once: false, watch: false, intervalSeconds: 300, out: DEFAULT_OUT, help: false };
  for (const token of argv) {
    if (token === "--once") args.once = true;
    else if (token === "--watch") args.watch = true;
    else if (token.startsWith("--watch=")) {
      args.watch = true;
      args.intervalSeconds = Math.max(
        60,
        boundedInteger(token.slice("--watch=".length), 300, 3600),
      );
    } else if (token.startsWith("--interval=")) {
      args.intervalSeconds = Math.max(
        60,
        boundedInteger(token.slice("--interval=".length), 300, 3600),
      );
    } else if (token.startsWith("--out=")) {
      const value = token.slice("--out=".length);
      if (value.length > 0) args.out = value;
    } else if (token === "--help" || token === "-h") args.help = true;
  }
  return args;
}

const USAGE = [
  "Usage: node tools/monitor-morpho-frozen-oracle.js [--once] [--watch[=seconds]] [--out=<path>]",
  "",
  "Read-only monitor. Alerts when a frozen Morpho Blue oracle feed has positive",
  "loan-side liquidity at a borrow-and-default-positive edge. No signing, no",
  "transactions, no forks, no oracle or pool manipulation.",
].join("\n");

function writeArtifact(artifact, outPath) {
  const leaks = findEndpointMaterial(artifact);
  if (leaks.length > 0) throw new Error("artifact-sanitization-failed");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

function printSummary(artifact) {
  const { summary, markets } = artifact;
  for (const record of markets) {
    const age = record.feeds
      .filter((f) => f.available)
      .map((f) => f.ageSeconds)
      .join(",");
    const liquidity = record.marketState ? record.marketState.availableLiquidity : "unavailable";
    const reference = record.reference.available ? "available" : "unavailable";
    process.stdout.write(
      `${record.status}\t${record.chain}\t${record.market}\t${record.marketId}\tliq=${liquidity}\tfeedAge=${age}\tedge=${record.trigger.edge}\treference=${reference}\n`,
    );
  }
  process.stdout.write(
    `summary TRIGGERED=${summary.TRIGGERED} WATCH=${summary.WATCH} CLEAR=${summary.CLEAR} REFERENCE_UNAVAILABLE=${summary.REFERENCE_UNAVAILABLE} ORACLE_REVERT=${summary.ORACLE_REVERT}\n`,
  );
}

// Producer-owned coverage binders: rebuild the Morpho O/F trigger-coverage binders
// from this artifact after every write, so the covered O rows cannot expire inside
// their 900 s freshness window. Non-fatal: a binder build failure never blocks the
// Kept fresh on every call: this monitor is long-running, so the builder and
// universe can change under it — bypass the require cache per publish instead
// of requiring a service restart.
function publishCoverageBinders(artifact) {
  try {
    const builderPath = require.resolve("./build-trigger-coverage-morpho-binders.js");
    delete require.cache[builderPath];
    const binders = require(builderPath);
    return binders.buildBinders({ workspace: WORKSPACE, artifact, apply: true });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    // Surface failures instead of silently freezing the coverage binders.
    process.stderr.write(`morpho-binder-publish error: ${message}\n`);
    try {
      fs.appendFileSync(
        path.join(WORKSPACE, "reports", "monitor", "morpho-binder-publish-errors.log"),
        `${new Date().toISOString()} ${message}\n`,
        "utf8"
      );
    } catch (_) {
      // logging must never throw
    }
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const runOnce = async () => {
    const artifact = await runMonitor({ mode: args.once ? "once" : args.watch ? "watch" : "once" });
    printSummary(artifact);
    writeArtifact(artifact, args.out);
    if (path.resolve(args.out) === path.resolve(DEFAULT_OUT)) publishCoverageBinders(artifact);
    return artifact;
  };

  if (!args.watch) {
    await runOnce();
    return;
  }

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (running) {
    await runOnce();
    if (!running) break;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, args.intervalSeconds * 1000);
      const interrupt = () => {
        clearTimeout(timer);
        running = false;
        resolve();
      };
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
    });
  }
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write("monitor-morpho-frozen-oracle-failed\n");
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_MARKETS,
  DEFAULT_LIMITS,
  DEFAULT_MIN_ACTIONABLE_LIQUIDITY_ASSETS,
  DEFAULT_STALENESS_SECONDS,
  MORPHO_BLUE,
  SELECTORS,
  createDefillamaReference,
  createRpcTransport,
  decodeMarket,
  decodeRoundData,
  decodeUint,
  evaluateMarket,
  findEndpointMaterial,
  fixedRatio,
  normalizeLimits,
  normalizeMarkets,
  observeMarket,
  parseArgs,
  publishCoverageBinders,
  refKey,
  runMonitor,
  writeArtifact,
};
