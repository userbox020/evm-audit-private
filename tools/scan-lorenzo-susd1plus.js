#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.join(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "lorenzo-susd1plus-live.json");
const RPC_TIMEOUT_MS = 15_000;
const GRAPHQL_URL = "https://lorenzo-api.lorenzo-protocol.xyz/v1/graphql/otf";
const SKIP_RPC_INVENTORY = process.env.LORENZO_SKIP_RPC_INVENTORY === "1";

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const CHAINS = {
  ethereum: {
    chainId: 1,
    graphTarget: "ethereum",
    fallbacks: ["https://ethereum-rpc.publicnode.com"],
    susd1plus: "0x8F18f2C97d2f5EC0e1d5B91c1D2ce245a9151972",
  },
  bsc: {
    chainId: 56,
    graphTarget: "bnb",
    fallbacks: ["https://bsc-dataseed.binance.org"],
    susd1plus: "0x4F2760B32720F013E900DC92F65480137391199b",
    usd1: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d",
    pancakeV3QuoterV2: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
    dexPools: [
      { name: "PancakeSwap V3 sUSD1+/USD1 0.05%", address: "0x479a86165f288C9CE7bB4238258584B259EB5fc7", fee: 500 },
      { name: "PancakeSwap V3 sUSD1+/USDT 0.05%", address: "0xd2144852d15331F8551fD310F16fD3c070dBC898", fee: 500 },
    ],
  },
};

const CALLS = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
  asset: "0x38d52e0f",
  totalAssets: "0x01e1d114",
  convertToAssets1e18: "0x07a2d13a" + "0".repeat(48) + "0de0b6b3a7640000",
  convertToShares1e18: "0xc6e6f592" + "0".repeat(48) + "0de0b6b3a7640000",
  pricePerShare: "0x99530b06",
  exchangeRate: "0x3ba0b9a9",
  underlying: "0x6f307dc3",
  minDepositAmount: "0x645006ca",
  minWithdrawAmount: "0x457e1a49",
  settlementPeriod: "0x0f1071be",
  transferable: "0x92ff0d31",
  weights: "0xc649f040",
  portfolios: "0x75ce7413",
  currentUnitNav: "0x4924afaf",
  precision: "0x4d294c41",
  yieldType: "0x4b8bfbec",
  usd1PlusVault: "0x99b2d1d4",
  cedefiManager: "0xe9c7970a",
  unsettledWithdrawShares: "0x96ffc0f5",
  nativeToken: "0x31f7d964",
  minterRole: "0xd5391393",
  burnerRole: "0x282c51f3",
  depositRole: "0x353efdcf",
  owner: "0x8da5cb5b",
  paused: "0x5c975abb",
  balanceOf: "0x70a08231",
};

const PARAM_CALLS = {
  acceptUnderlying: "0x38eebcd1",
  periodUnitNav: "0xaea5b21d",
  periodWithdrawShares: "0x48cf1f21",
  roles: "0x99374642",
  signers: "0x736c0d5b",
  blacklisted: "0xdbac26e9",
};

const V3_POOL_CALLS = {
  token0: "0x0dfe1681",
  token1: "0xd21220a7",
  liquidity: "0x1a686502",
  slot0: "0x3850c7bd",
};

const QUOTER_CALLS = {
  quoteExactInputSingleTuple: "0xc6a5026a",
};

const BUY_QUOTE_STABLE_AMOUNTS = [100n, 500n, 1000n, 5000n, 10000n];

function extractRpcUrls() {
  if (SKIP_RPC_INVENTORY) return [];
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveRpc(chainName) {
  const target = CHAINS[chainName];
  const candidates = [...extractRpcUrls(), ...(target.fallbacks || [])];
  const seen = new Set();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const chainId = Number(BigInt(await rpcCall(url, "eth_chainId", [], 5000)));
      if (chainId === target.chainId) return url;
    } catch (_) {
      // Never print or store RPC URLs.
    }
  }
  return null;
}

async function graphQuery(targetChainName) {
  const query = `{ tvlByChain(targetChainName: "${targetChainName}") { targetChainName tokenName tvl readableTvl } }`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data?.tvlByChain || null;
  } catch (e) {
    return { error: e.message || String(e) };
  } finally {
    clearTimeout(timeout);
  }
}

function strip0x(x) {
  return String(x || "").replace(/^0x/i, "");
}

function hexToBigInt(hex) {
  if (!hex || hex === "0x") return null;
  return BigInt(hex);
}

function addressFromWord(word) {
  if (!word || word === "0x" || BigInt(word) === 0n) return null;
  return "0x" + strip0x(word).slice(-40);
}

function decodeString(data) {
  if (!data || data === "0x") return null;
  const hex = strip0x(data);
  try {
    if (hex.length === 64) {
      const bytes = Buffer.from(hex, "hex");
      return bytes.toString("utf8").replace(/\u0000+$/g, "") || null;
    }
    const offset = Number(BigInt("0x" + hex.slice(0, 64))) * 2;
    const len = Number(BigInt("0x" + hex.slice(offset, offset + 64))) * 2;
    return Buffer.from(hex.slice(offset + 64, offset + 64 + len), "hex").toString("utf8") || null;
  } catch (_) {
    return null;
  }
}

function decodeUintArray(data) {
  const hex = strip0x(data);
  if (hex.length < 128) return null;
  try {
    const offset = Number(BigInt("0x" + hex.slice(0, 64))) * 2;
    const len = Number(BigInt("0x" + hex.slice(offset, offset + 64)));
    const values = [];
    for (let i = 0; i < Math.min(len, 16); i++) {
      values.push(BigInt("0x" + hex.slice(offset + 64 + i * 64, offset + 128 + i * 64)).toString());
    }
    return { length: len, values };
  } catch (_) {
    return null;
  }
}

function decodeAddressArray(data) {
  const hex = strip0x(data);
  if (hex.length < 128) return null;
  try {
    const offset = Number(BigInt("0x" + hex.slice(0, 64))) * 2;
    const len = Number(BigInt("0x" + hex.slice(offset, offset + 64)));
    const values = [];
    for (let i = 0; i < Math.min(len, 64); i++) {
      values.push("0x" + hex.slice(offset + 64 + i * 64 + 24, offset + 128 + i * 64).toLowerCase());
    }
    return values;
  } catch (_) {
    return null;
  }
}

function encodeUint256(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function encodeAddress(address) {
  return strip0x(address).toLowerCase().padStart(64, "0");
}

function formatUnits(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const frac = raw % scale;
  const fracText = frac.toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 10);
  return fracText ? `${whole}.${fracText}` : whole.toString();
}

function unitsToNumber(raw, decimals) {
  const text = formatUnits(raw, decimals);
  if (text === null || text === undefined) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function decodeFirstBigInt(data) {
  if (!data || data === "0x") return null;
  const hex = strip0x(data);
  if (hex.length < 64) return null;
  return BigInt("0x" + hex.slice(0, 64));
}

function v3Token1PerToken0(slot0Raw, decimals0, decimals1) {
  const sqrtPriceX96 = decodeFirstBigInt(slot0Raw);
  if (!sqrtPriceX96) return null;
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return ratio * ratio * 10 ** (decimals0 - decimals1);
}

function decodeQuoterV2Result(data) {
  if (!data || data === "0x") return null;
  const hex = strip0x(data);
  if (hex.length < 64) return null;
  const word = (index) => BigInt("0x" + hex.slice(index * 64, index * 64 + 64));
  try {
    return {
      amountOutRaw: word(0).toString(),
      sqrtPriceX96AfterRaw: hex.length >= 128 ? word(1).toString() : null,
      initializedTicksCrossed: hex.length >= 192 ? Number(word(2)) : null,
      gasEstimate: hex.length >= 256 ? word(3).toString() : null,
    };
  } catch (_) {
    return null;
  }
}

function extractPush4Selectors(bytecode) {
  const hex = strip0x(bytecode);
  const selectors = new Set();
  for (let i = 0; i < hex.length - 10; i += 2) {
    if (hex.slice(i, i + 2).toLowerCase() === "63") selectors.add("0x" + hex.slice(i + 2, i + 10).toLowerCase());
  }
  return [...selectors].sort();
}

async function callOptional(rpc, to, data) {
  try {
    const result = await rpcCall(rpc, "eth_call", [{ to, data }, "latest"]);
    return result && result !== "0x" ? result : null;
  } catch (e) {
    return null;
  }
}

async function tokenMeta(rpc, address) {
  const [nameRaw, symbolRaw, decimalsRaw, totalSupplyRaw] = await Promise.all([
    callOptional(rpc, address, CALLS.name),
    callOptional(rpc, address, CALLS.symbol),
    callOptional(rpc, address, CALLS.decimals),
    callOptional(rpc, address, CALLS.totalSupply),
  ]);
  const decimals = decimalsRaw ? Number(hexToBigInt(decimalsRaw)) : null;
  const totalSupply = hexToBigInt(totalSupplyRaw);
  return {
    address,
    name: decodeString(nameRaw),
    symbol: decodeString(symbolRaw),
    decimals,
    totalSupplyRaw: totalSupply?.toString() || null,
    totalSupply: formatUnits(totalSupply, decimals),
  };
}

async function tokenBalance(rpc, token, account, decimals) {
  const raw = await callOptional(rpc, token, CALLS.balanceOf + encodeAddress(account));
  const value = raw ? hexToBigInt(raw) : null;
  return { account, raw: value?.toString() || null, formatted: formatUnits(value, decimals) };
}

async function quoteExactInputSingle(rpc, quoter, tokenIn, tokenOut, amountInRaw, fee) {
  if (!rpc || !quoter || !tokenIn || !tokenOut || !amountInRaw || !fee) return null;
  const data = QUOTER_CALLS.quoteExactInputSingleTuple
    + encodeAddress(tokenIn)
    + encodeAddress(tokenOut)
    + encodeUint256(amountInRaw)
    + encodeUint256(fee)
    + encodeUint256(0n);
  const raw = await callOptional(rpc, quoter, data);
  return decodeQuoterV2Result(raw);
}

async function inspectBuyQuotes(rpc, quoter, pool, token0Address, token1Address, token0, token1, susdAddress, nav) {
  if (!quoter || !token0Address || !token1Address || !token0 || !token1) return [];
  const susdLower = susdAddress.toLowerCase();
  const token0IsSusd = token0Address.toLowerCase() === susdLower;
  const token1IsSusd = token1Address.toLowerCase() === susdLower;
  if (!token0IsSusd && !token1IsSusd) return [];
  const stableAddress = token0IsSusd ? token1Address : token0Address;
  const stable = token0IsSusd ? token1 : token0;
  const susd = token0IsSusd ? token0 : token1;
  const quotes = [];
  for (const stableAmount of BUY_QUOTE_STABLE_AMOUNTS) {
    const amountInRaw = stableAmount * 10n ** BigInt(stable.decimals);
    const quote = await quoteExactInputSingle(rpc, quoter, stableAddress, susdAddress, amountInRaw, pool.fee || 500);
    if (!quote?.amountOutRaw) {
      quotes.push({
        stableIn: stableAmount.toString(),
        stableSymbol: stable.symbol,
        status: "quote-failed",
      });
      continue;
    }
    const amountOutRaw = BigInt(quote.amountOutRaw);
    const amountOut = unitsToNumber(amountOutRaw, susd.decimals);
    const stableIn = unitsToNumber(amountInRaw, stable.decimals);
    const navExitValue = amountOut !== null && nav ? amountOut * nav : null;
    const grossEdgeUsd = navExitValue !== null && stableIn !== null ? navExitValue - stableIn : null;
    const grossEdgeBps = navExitValue !== null && stableIn ? Math.round(((navExitValue / stableIn) - 1) * 10000) : null;
    quotes.push({
      stableInRaw: amountInRaw.toString(),
      stableIn: stableIn?.toString() || stableAmount.toString(),
      stableSymbol: stable.symbol,
      tokenIn: stableAddress,
      tokenOut: susdAddress,
      fee: pool.fee || 500,
      amountOutRaw: quote.amountOutRaw,
      amountOutSusd1Plus: amountOut,
      navExitValue,
      grossEdgeUsd,
      grossEdgeBps,
      gasEstimate: quote.gasEstimate,
      initializedTicksCrossed: quote.initializedTicksCrossed,
      status: "quoted",
    });
  }
  return quotes;
}

async function inspectUnderlying(rpc, tokenAddress, vaultAddress, views) {
  if (!tokenAddress) return null;
  const meta = await tokenMeta(rpc, tokenAddress);
  const accounts = [vaultAddress, views.cedefiManager, ...(Array.isArray(views.portfolios) ? views.portfolios : [])].filter(Boolean);
  const balances = [];
  for (const account of [...new Set(accounts.map((x) => x.toLowerCase()))]) {
    balances.push(await tokenBalance(rpc, tokenAddress, account, meta.decimals));
  }
  return { token: meta, balances };
}

async function inspectDexPools(rpc, pools, susdAddress, currentUnitNavRaw, quoter) {
  const result = [];
  const nav = currentUnitNavRaw ? Number(currentUnitNavRaw) / 1e18 : null;
  for (const pool of pools || []) {
    const [token0Raw, token1Raw, liquidityRaw, slot0Raw] = await Promise.all([
      callOptional(rpc, pool.address, V3_POOL_CALLS.token0),
      callOptional(rpc, pool.address, V3_POOL_CALLS.token1),
      callOptional(rpc, pool.address, V3_POOL_CALLS.liquidity),
      callOptional(rpc, pool.address, V3_POOL_CALLS.slot0),
    ]);
    const token0Address = addressFromWord(token0Raw);
    const token1Address = addressFromWord(token1Raw);
    const [token0, token1] = await Promise.all([
      token0Address ? tokenMeta(rpc, token0Address) : null,
      token1Address ? tokenMeta(rpc, token1Address) : null,
    ]);
    const token1PerToken0 = token0 && token1 ? v3Token1PerToken0(slot0Raw, token0.decimals, token1.decimals) : null;
    const susdLower = susdAddress.toLowerCase();
    let quotePerSusd1Plus = null;
    if (token0Address?.toLowerCase() === susdLower) quotePerSusd1Plus = token1PerToken0;
    if (token1Address?.toLowerCase() === susdLower && token1PerToken0) quotePerSusd1Plus = 1 / token1PerToken0;
    const navDiffBps = quotePerSusd1Plus && nav ? Math.round(((quotePerSusd1Plus / nav) - 1) * 10000) : null;
    const [token0Balance, token1Balance] = await Promise.all([
      token0Address && token0 ? tokenBalance(rpc, token0Address, pool.address, token0.decimals) : null,
      token1Address && token1 ? tokenBalance(rpc, token1Address, pool.address, token1.decimals) : null,
    ]);
    const buyQuotes = await inspectBuyQuotes(rpc, quoter, pool, token0Address, token1Address, token0, token1, susdAddress, nav);
    result.push({
      ...pool,
      token0,
      token1,
      liquidityRaw: liquidityRaw ? hexToBigInt(liquidityRaw)?.toString() || null : null,
      token1PerToken0,
      quotePerSusd1Plus,
      navDiffBps,
      balances: [token0Balance, token1Balance].filter(Boolean),
      buyQuotes,
    });
  }
  return result;
}

function formattedNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function balanceForAccount(underlying, account) {
  if (!underlying?.balances || !account) return null;
  const row = underlying.balances.find((b) => b.account?.toLowerCase() === account.toLowerCase());
  return formattedNumber(row?.formatted);
}

function sumBalancesForAccounts(underlying, accounts) {
  return (accounts || []).reduce((acc, account) => acc + (balanceForAccount(underlying, account) || 0), 0);
}

function bestBy(items, fn) {
  let best = null;
  let bestScore = -Infinity;
  for (const item of items || []) {
    const score = Number(fn(item));
    if (Number.isFinite(score) && score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

function buildInverseRoute(cfg, views, paramViews, underlying, dexPools, flags) {
  const nav = formattedNumber(views.currentUnitNav?.formatted18);
  const vaultCashUsd1 = balanceForAccount(underlying, cfg.susd1plus) || 0;
  const portfolioCashUsd1 = sumBalancesForAccounts(underlying, Array.isArray(views.portfolios) ? views.portfolios : []);
  const cedefiManagerCashUsd1 = balanceForAccount(underlying, views.cedefiManager) || 0;
  const unsettledWithdrawShares = formattedNumber(views.unsettledWithdrawShares?.formatted18) || 0;
  const queuedWithdrawUsd1 = nav ? unsettledWithdrawShares * nav : null;
  const exactBuyQuotes = [];
  for (const pool of dexPools || []) {
    for (const quote of pool.buyQuotes || []) {
      if (quote.status !== "quoted") continue;
      exactBuyQuotes.push({
        pool: pool.name,
        poolAddress: pool.address,
        stableSymbol: quote.stableSymbol,
        stableIn: formattedNumber(quote.stableIn),
        amountOutSusd1Plus: quote.amountOutSusd1Plus,
        navExitValue: quote.navExitValue,
        grossEdgeUsd: quote.grossEdgeUsd,
        grossEdgeBps: quote.grossEdgeBps,
        gasEstimate: quote.gasEstimate,
        initializedTicksCrossed: quote.initializedTicksCrossed,
      });
    }
  }
  exactBuyQuotes.sort((a, b) => (formattedNumber(b.grossEdgeBps) || -Infinity) - (formattedNumber(a.grossEdgeBps) || -Infinity));

  const erc4626ViewsPresent = Boolean(views.asset && views.totalAssets && views.convertToAssets1e18);
  const queueSignalsPresent = Boolean(flags.includes("period-nav-withdraw-queue") || unsettledWithdrawShares > 0 || Object.values(paramViews?.periods || {}).some((p) => formattedNumber(p.withdrawShares?.formatted18) > 0));
  const acceptUnderlying = Object.values(paramViews?.acceptUnderlying || {}).some(Boolean);
  const sameEpochPublicExitProven = erc4626ViewsPresent && acceptUnderlying && !queueSignalsPresent;
  const bestExactBuy = exactBuyQuotes[0] || null;
  const grossPositive = (formattedNumber(bestExactBuy?.grossEdgeUsd) || 0) > 0;
  const routePositive = sameEpochPublicExitProven && grossPositive ? 1 : 0;
  const blockers = [];
  if (!bestExactBuy) blockers.push("No successful Pancake V3 stable->sUSD1+ exact buy quote");
  if (!grossPositive) blockers.push("Exact buy quote is not positive versus NAV at scanned sizes");
  if (!sameEpochPublicExitProven) blockers.push("Same-epoch public NAV exit is not proven; observed surface is a period withdrawal queue, not ERC4626 redeem/withdraw");
  if (queuedWithdrawUsd1 !== null && vaultCashUsd1 < queuedWithdrawUsd1) blockers.push("Direct vault USD1 cash is below queued/unsettled withdrawal demand");
  if (views.paused === true) blockers.push("Vault is paused");
  if (views.transferable === false) blockers.push("sUSD1+ is not transferable");

  return {
    direction: "buy-discounted-susd1plus-then-public-nav-exit",
    routePositive,
    sameEpochPublicExitProven,
    publicNavExitAssumption: sameEpochPublicExitProven ? "proven-by-read-only-views" : "not-proven",
    exactBuyQuoteCount: exactBuyQuotes.length,
    bestExactBuy,
    topExactBuyQuotes: exactBuyQuotes.slice(0, 8),
    exitState: {
      nav,
      erc4626ViewsPresent,
      acceptUnderlying,
      queueSignalsPresent,
      vaultCashUsd1,
      cedefiManagerCashUsd1,
      portfolioCashUsd1,
      unsettledWithdrawShares,
      queuedWithdrawUsd1,
      minWithdrawAmount: formattedNumber(views.minWithdrawAmount?.formattedTokenDecimals),
      settlementPeriod: formattedNumber(views.settlementPeriod?.raw),
    },
    blockers,
    requiredForRoutePositive: [
      "successful exact stable->sUSD1+ buy quote with positive NAV edge after fees/slippage/gas",
      "public same-epoch NAV redeem/withdraw or otherwise atomic exit semantics proven",
      "cash/queue availability sufficient for the exact exit size",
      "fork extraction proof before any signed action",
    ],
  };
}

function summarize(result) {
  const inverseRoutes = (result || []).map((r) => r.inverseRoute).filter(Boolean);
  const bestInverse = bestBy(inverseRoutes.map((r) => r.bestExactBuy).filter(Boolean), (q) => formattedNumber(q.grossEdgeBps) || -Infinity);
  const bestInverseRoute = inverseRoutes.find((r) => r.bestExactBuy && r.bestExactBuy.pool === bestInverse?.pool && r.bestExactBuy.stableSymbol === bestInverse?.stableSymbol)
    || inverseRoutes.find((r) => r.bestExactBuy)
    || inverseRoutes.find((r) => r.blockers?.length);
  return {
    chainsScanned: result.length,
    chainsResolved: result.filter((r) => r.rpcResolved).length,
    routePositive: inverseRoutes.reduce((sum, r) => sum + (formattedNumber(r.routePositive) || 0), 0),
    inverseRoutePositive: inverseRoutes.reduce((sum, r) => sum + (formattedNumber(r.routePositive) || 0), 0),
    exactBuyQuotes: inverseRoutes.reduce((sum, r) => sum + (formattedNumber(r.exactBuyQuoteCount) || 0), 0),
    bestInverseGrossEdgeBps: bestInverse?.grossEdgeBps ?? null,
    bestInverseGrossEdgeUsd: bestInverse?.grossEdgeUsd ?? null,
    bestInversePool: bestInverse?.pool || null,
    sameEpochPublicExitProven: inverseRoutes.some((r) => r.sameEpochPublicExitProven),
    blocker: bestInverseRoute?.blockers?.[0] || null,
  };
}

async function inspectCommonViews(rpc, address, decimals) {
  const result = {};
  for (const [name, selector] of Object.entries(CALLS)) {
    if (["name", "symbol", "decimals", "totalSupply", "balanceOf"].includes(name)) continue;
    const raw = await callOptional(rpc, address, selector);
    if (!raw) continue;
    if (["asset", "owner", "underlying", "nativeToken", "usd1PlusVault", "cedefiManager"].includes(name)) {
      result[name] = addressFromWord(raw);
    } else if (["paused", "transferable"].includes(name)) {
      result[name] = Boolean(hexToBigInt(raw));
    } else if (["minterRole", "burnerRole", "depositRole"].includes(name)) {
      result[name] = raw;
    } else if (name === "portfolios") {
      result[name] = decodeAddressArray(raw) || { raw };
    } else if (name === "weights") {
      result[name] = decodeUintArray(raw) || { raw };
    } else {
      const value = hexToBigInt(raw);
      result[name] = { raw: value?.toString() || null, formatted18: formatUnits(value, 18), formattedTokenDecimals: formatUnits(value, decimals) };
    }
  }
  return result;
}

async function inspectParamViews(rpc, address, views) {
  const result = { acceptUnderlying: {}, periods: {}, accounts: {} };
  const settlement = views.settlementPeriod?.raw ? BigInt(views.settlementPeriod.raw) : null;
  const periods = settlement === null ? [] : [settlement - 2n, settlement - 1n, settlement].filter((x) => x > 0n);
  for (const period of [...new Set(periods.map((x) => x.toString()))]) {
    const periodData = {};
    for (const [name, selector] of [["unitNav", PARAM_CALLS.periodUnitNav], ["withdrawShares", PARAM_CALLS.periodWithdrawShares]]) {
      const raw = await callOptional(rpc, address, selector + encodeUint256(period));
      if (raw) {
        const value = hexToBigInt(raw);
        periodData[name] = { raw: value?.toString() || null, formatted18: formatUnits(value, 18) };
      }
    }
    result.periods[period] = periodData;
  }

  const underlyingCandidates = [views.underlying, views.nativeToken].filter(Boolean);
  for (const token of [...new Set(underlyingCandidates.map((x) => x.toLowerCase()))]) {
    const raw = await callOptional(rpc, address, PARAM_CALLS.acceptUnderlying + encodeAddress(token));
    if (raw) result.acceptUnderlying[token] = Boolean(hexToBigInt(raw));
  }

  const accountCandidates = [views.cedefiManager, views.usd1PlusVault, ...(Array.isArray(views.portfolios) ? views.portfolios : [])].filter(Boolean);
  for (const account of [...new Set(accountCandidates.map((x) => x.toLowerCase()))]) {
    const [rolesRaw, signerRaw, blacklistedRaw] = await Promise.all([
      callOptional(rpc, address, PARAM_CALLS.roles + encodeAddress(account)),
      callOptional(rpc, address, PARAM_CALLS.signers + encodeAddress(account)),
      callOptional(rpc, address, PARAM_CALLS.blacklisted + encodeAddress(account)),
    ]);
    result.accounts[account] = {
      roles: rolesRaw ? hexToBigInt(rolesRaw)?.toString() || null : null,
      signer: signerRaw ? Boolean(hexToBigInt(signerRaw)) : null,
      blacklisted: blacklistedRaw ? Boolean(hexToBigInt(blacklistedRaw)) : null,
    };
  }
  return result;
}

async function contractMeta(rpc, address) {
  const [code, implSlot, adminSlot] = await Promise.all([
    rpcCall(rpc, "eth_getCode", [address, "latest"]),
    rpcCall(rpc, "eth_getStorageAt", [address, IMPL_SLOT, "latest"]).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [address, ADMIN_SLOT, "latest"]).catch(() => null),
  ]);
  return {
    address,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    push4Selectors: extractPush4Selectors(code),
    eip1967Implementation: addressFromWord(implSlot),
    eip1967Admin: addressFromWord(adminSlot),
  };
}

async function scanChain(chainName) {
  const cfg = CHAINS[chainName];
  const rpc = await resolveRpc(chainName);
  const graph = await graphQuery(cfg.graphTarget);
  if (!rpc) return { chain: chainName, chainId: cfg.chainId, rpcResolved: false, graph, error: "missing-rpc" };

  const blockNumber = Number(BigInt(await rpcCall(rpc, "eth_blockNumber", [])));
  const contract = await contractMeta(rpc, cfg.susd1plus);
  const implementation = contract.eip1967Implementation ? await contractMeta(rpc, contract.eip1967Implementation) : null;
  const token = await tokenMeta(rpc, cfg.susd1plus);
  const views = await inspectCommonViews(rpc, cfg.susd1plus, token.decimals);
  const paramViews = await inspectParamViews(rpc, cfg.susd1plus, views);
  const underlying = await inspectUnderlying(rpc, views.underlying, cfg.susd1plus, views);
  const dexPools = await inspectDexPools(rpc, cfg.dexPools, cfg.susd1plus, views.currentUnitNav?.raw, cfg.pancakeV3QuoterV2);

  const extraTokens = [];
  if (cfg.usd1) extraTokens.push(await tokenMeta(rpc, cfg.usd1));

  const flags = [];
  if (!views.asset) flags.push("not-erc4626-asset-view");
  if (!views.totalAssets) flags.push("no-totalAssets-view");
  if (!views.convertToAssets1e18) flags.push("no-convertToAssets-view");
  if (contract.eip1967Implementation) flags.push("proxy-token");
  const selectors = new Set([...(contract.push4Selectors || []), ...(implementation?.push4Selectors || [])]);
  if (selectors.has("0xf2b9fdb8")) flags.push("public-supply-immediate-mint");
  if (selectors.has("0x47e7ef24") && selectors.has("0x02387a7b")) flags.push("period-nav-withdraw-queue");
  let graphSupplyRatioBps = null;
  let graphNavVsOnchainNavBps = null;
  if (graph?.tvl && token.totalSupplyRaw) {
    const graphRaw = BigInt(graph.tvl);
    const supplyRaw = BigInt(token.totalSupplyRaw);
    const diff = supplyRaw > graphRaw ? supplyRaw - graphRaw : graphRaw - supplyRaw;
    const diffBps = supplyRaw === 0n ? null : Number((diff * 10000n) / supplyRaw);
    graphSupplyRatioBps = supplyRaw === 0n ? null : Number((graphRaw * 10000n) / supplyRaw);
    if (diffBps !== null && diffBps > 500) flags.push("graph-tvl-vs-supply-diff-over-5pct");
    if (graphSupplyRatioBps !== null && graphSupplyRatioBps > 10050) flags.push("graph-share-value-above-1pct");
    const currentUnitNav = views.currentUnitNav?.raw ? BigInt(views.currentUnitNav.raw) : null;
    if (currentUnitNav && currentUnitNav > 0n && supplyRaw > 0n) {
      const graphNav = (graphRaw * 10n ** 18n) / supplyRaw;
      graphNavVsOnchainNavBps = Number((graphNav * 10000n) / currentUnitNav);
      if (graphNavVsOnchainNavBps > 10100) flags.push("graph-nav-above-onchain-nav-over-1pct");
      if (graphNavVsOnchainNavBps < 9900) flags.push("graph-nav-below-onchain-nav-over-1pct");
    }
  }

  const inverseRoute = buildInverseRoute(cfg, views, paramViews, underlying, dexPools, flags);

  return {
    chain: chainName,
    chainId: cfg.chainId,
    rpcResolved: true,
    blockNumber,
    graph,
    graphSupplyRatioBps,
    graphNavVsOnchainNavBps,
    contract,
    implementation,
    token,
    views,
    paramViews,
    underlying,
    dexPools,
    extraTokens,
    inverseRoute,
    flags,
  };
}

async function main() {
  const result = [];
  for (const chainName of Object.keys(CHAINS)) {
    console.log(`Scanning ${chainName}...`);
    result.push(await scanChain(chainName));
  }
  const summary = summarize(result);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-lorenzo-susd1plus.js",
    safety: {
      rpcInventorySkipped: SKIP_RPC_INVENTORY,
      rpcInventoryRead: !SKIP_RPC_INVENTORY,
      publicFallbackRpcAllowed: true,
      rpcUrlsStored: false,
      signedActions: false,
    },
    sources: [
      "https://api.llama.fi/protocol/lorenzo-susd1+",
      "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/lorenzo-susd1plus/index.js",
      GRAPHQL_URL,
    ],
    summary,
    result,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`wrote ${OUT}`);
  console.log(result.map((r) => `${r.chain}: ${r.rpcResolved ? "ok" : "missing-rpc"} flags=${(r.flags || []).join(",")}`).join("\n"));
}

main().catch((e) => {
  console.error(e.stack || e.message || String(e));
  process.exitCode = 1;
});
